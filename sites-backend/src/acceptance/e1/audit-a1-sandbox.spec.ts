/**
 * Аудит Э1 (A1), публичная песочница — деньги платформы на НАСТОЯЩЕМ
 * Postgres (публичная песочница — под логин-ролью assist_public):
 *  1. Огромные страницы чужого сайта не превращаются в миллионы токенов
 *     эмбеддинга за один опрос (потолок текста песочницы).
 *  2. Шаг, на котором функцию убивали (попытки кончились без итога), —
 *     failed без нового резерва денег и без нового эмбеддинга.
 * Сеть не нужна: страницы песочницы пишет тест (обход — K1).
 */
import { createHash, randomBytes } from 'crypto';
import { Logger } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AssistPublicDb } from '../../prisma/assist-public-db.service';
import { SitesDb } from '../../prisma/sites-db.service';
import { AnswerEngine } from '../../modules/assist-knowledge-core/answer/answer-engine';
import type { SiteKnowledgeService } from '../../modules/assist-site-knowledge/site-knowledge.service';
import {
  SANDBOX_MAX_ATTEMPTS,
  SANDBOX_MAX_PAGE_TOKENS,
  SANDBOX_MAX_TOKENS,
  SandboxService,
} from '../../modules/assist-sandbox/sandbox.service';
import {
  FakeText,
  describeDb,
  fakeEmbedTransport,
  ownerPrisma,
  publicPrisma,
  uniq,
} from '../../modules/assist-sandbox/testing/k3-stack.testing';
import { GeminiEmbedder } from '../../modules/site-ai/embedder';
import { AiUsageRecorder } from '../../modules/site-ai/usage-recorder';

describeDb('Аудит Э1 (A1): деньги публичной песочницы', () => {
  let prisma: PrismaService;
  let publicDb: AssistPublicDb;
  let svc: SandboxService;
  let embedCalls: string[][];
  const ids: string[] = [];

  beforeAll(async () => {
    Logger.overrideLogger(false);
    prisma = ownerPrisma();
    publicDb = await publicPrisma(prisma);
  });

  afterAll(async () => {
    await prisma.assistSandbox.deleteMany({ where: { id: { in: ids } } });
    await publicDb.$disconnect();
    await prisma.$disconnect();
  });

  beforeEach(() => {
    embedCalls = [];
    const text = new FakeText();
    svc = new SandboxService(
      prisma,
      publicDb,
      new SitesDb(prisma),
      null as never, // обход в этих тестах не идёт
      null as never,
      null as never,
      new GeminiEmbedder(fakeEmbedTransport(embedCalls)),
      new AnswerEngine(text),
      text,
      new AiUsageRecorder(),
      null as unknown as SiteKnowledgeService,
    );
    svc.env = {
      ASSIST_SANDBOX_PUBLIC_ENABLED: 'true',
      ASSIST_SECRETS_KEY: 'a1-test-secret',
      ASSIST_SANDBOX_PUBLIC_DAILY_CAP_USD: '1000',
    };
  });

  /** Песочница в статусе indexing с готовыми страницами. */
  async function sandboxWithPages(
    pages: Array<{ path: string; paragraphs: string[] }>,
    extra: { attempts?: number } = {},
  ): Promise<{ id: string; key: string }> {
    const id = randomBytes(16).toString('base64url');
    const key = randomBytes(24).toString('base64url');
    const host = `${uniq('a1sb')}.example.com`;
    ids.push(id);
    await prisma.assistSandbox.create({
      data: {
        id,
        kind: 'public',
        browserKeyHash: createHash('sha256').update(key).digest('hex'),
        url: `https://${host}/`,
        host,
        registrableDomain: 'example.com',
        status: 'indexing',
        progress: {},
        pagesRead: pages.length,
        pagesLimit: 8,
        questionsLimit: 10,
        attempts: extra.attempts ?? 0,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    for (const p of pages) {
      const blocks = [
        { t: 'h', level: 1, text: p.path, path: [] },
        ...p.paragraphs.map((text) => ({ t: 'p', text, path: [p.path] })),
      ];
      await prisma.assistSandboxPage.create({
        data: {
          sandboxId: id,
          url: `https://${host}${p.path}`,
          title: p.path,
          lang: 'en',
          text: p.paragraphs.join('\n'),
          blocks,
          contentHash: createHash('sha256').update(p.path).digest('hex'),
        },
      });
    }
    return { id, key };
  }

  function bigParagraphs(seed: string, n: number): string[] {
    return Array.from({ length: n }, (_, i) =>
      Array.from({ length: 120 }, (_, j) => `${seed}w${i}x${j}`).join(' '),
    );
  }

  it('огромные страницы: эмбеддинг — не больше потолка песочницы', async () => {
    // 8 страниц по ~200 абзацев (десятки тысяч токенов каждая).
    const pages = Array.from({ length: 8 }, (_, i) => ({
      path: `/big${i}`,
      paragraphs: bigParagraphs(`p${i}`, 200),
    }));
    const sb = await sandboxWithPages(pages);
    const v = await svc.getPublic(sb.id, sb.key);
    expect(v.status).toBe('ready');
    const texts = embedCalls.flat();
    const tokens = texts.reduce((s, t) => s + Math.ceil(t.length / 4), 0);
    // Оценка фейка (символы/4) грубее оценки чанкера — с запасом ×2.
    expect(tokens).toBeLessThanOrEqual(SANDBOX_MAX_TOKENS * 2);
    const chunks = await prisma.assistSandboxChunk.findMany({
      where: { sandboxId: sb.id },
      select: { tokens: true, url: true },
    });
    const total = chunks.reduce((s, c) => s + c.tokens, 0);
    expect(total).toBeLessThanOrEqual(SANDBOX_MAX_TOKENS);
    const perPage = new Map<string, number>();
    for (const c of chunks)
      perPage.set(c.url, (perPage.get(c.url) ?? 0) + c.tokens);
    for (const n of perPage.values())
      expect(n).toBeLessThanOrEqual(SANDBOX_MAX_PAGE_TOKENS);
    // Каждая страница что-то дала — потолок не съеден первой.
    expect(perPage.size).toBeGreaterThanOrEqual(5);
  });

  it('попытки кончились без итога (функцию убивали) — failed, без резерва и эмбеддинга', async () => {
    const sb = await sandboxWithPages(
      [{ path: '/a', paragraphs: ['Доставка по Киеву стоит 150 грн.'] }],
      { attempts: SANDBOX_MAX_ATTEMPTS },
    );
    const before = await prisma.assistSandbox.findUniqueOrThrow({
      where: { id: sb.id },
    });
    const v = await svc.getPublic(sb.id, sb.key);
    expect(v.status).toBe('failed');
    expect(embedCalls).toEqual([]);
    const after = await prisma.assistSandbox.findUniqueOrThrow({
      where: { id: sb.id },
    });
    expect(after.costMicroUsd).toBe(before.costMicroUsd);
  });
});
