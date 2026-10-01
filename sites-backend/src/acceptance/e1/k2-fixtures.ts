/**
 * Фикстуры приёмки K2 (знания, поиск, версии) на НАСТОЯЩЕМ Postgres —
 * по образцу prisma/assist-public-role.spec.ts: строка SITES_DIRECT_URL;
 * без неё набор пропускается с причиной, при CI=true — провал.
 *
 * Провайдер ИИ — фейк: детерминированный «шумовой» вектор по тексту
 * (одинаковый текст → одинаковый вектор, разный → почти ортогональный),
 * так что найти артикул вектором нельзя — только гибридом. site_pages
 * пишет тест (обход — K1), как велит контракт Э1 §7 (A2/A3).
 *
 * Каждый тест создаёт свои кабинеты/сайты со случайными id: общая база CI
 * не чистится, параллельные спеки друг другу не мешают.
 */
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import { AdminIndexingService } from '../../modules/assist-admin-knowledge/admin-indexing.service';
import { AdminKnowledgeService } from '../../modules/assist-admin-knowledge/admin-knowledge.service';
import type {
  AnswerRequest,
  AnswerResult,
} from '../../modules/assist-knowledge-core/answer/answer-engine';
import { SiteKnowledgeNotifier } from '../../modules/assist-site-knowledge/held-notifier';
import { SiteIndexingService } from '../../modules/assist-site-knowledge/site-indexing.service';
import { SiteKnowledgeService } from '../../modules/assist-site-knowledge/site-knowledge.service';
import type { EmbedResult, EmbedTask } from '../../modules/site-ai/embedder';
import { estimateEmbedTokens } from '../../modules/site-ai/embedder';
import { LearningBudget } from '../../modules/site-ai/learning-budget';
import { AiUsageRecorder } from '../../modules/site-ai/usage-recorder';
import type { ExtractedBlock } from '../../modules/site-crawl/types';
import { contentHash } from '../../modules/assist-knowledge-core/hashing';

export const RAW_URL = process.env.SITES_DIRECT_URL;
export const IN_CI = process.env.CI === 'true';

/** `?schema=sites` нужен CLI Prisma; драйверу pg он ни к чему. */
export function pgUrl(url: string): string {
  const u = new URL(url);
  u.searchParams.delete('schema');
  return u.toString();
}

/** Набор без базы: пропуск с причиной (в CI — провал). */
export function describeWithoutDb(title: string): void {
  describe(title, () => {
    (IN_CI ? it : it.skip)(
      'ПРОПУЩЕНО: нет SITES_DIRECT_URL (песочница без базы) — проверка идёт в CI, джоба sites-backend',
      () => {
        throw new Error(
          'CI=true, но SITES_DIRECT_URL не задана — приёмка знаний не выполнилась',
        );
      },
    );
  });
}

/** Шумовой вектор 768 по тексту (сид — SHA-256). */
export function noiseVector(text: string, dims = 768): number[] {
  const out: number[] = [];
  let seed = createHash('sha256').update(text).digest();
  while (out.length < dims) {
    for (let i = 0; i + 4 <= seed.length && out.length < dims; i += 4) {
      out.push(seed.readInt32BE(i) / 2 ** 31);
    }
    seed = createHash('sha256').update(seed).digest();
  }
  const n = Math.sqrt(out.reduce((s, x) => s + x * x, 0));
  return out.map((x) => x / n);
}

export class FakeEmbedder {
  /** Тексты фрагментов (task=document) — ровно то, что было бы оплачено. */
  documentTexts: string[] = [];
  queryTexts: string[] = [];
  fail = false;

  async embed(texts: string[], task: EmbedTask): Promise<EmbedResult> {
    if (this.fail) throw new Error('провайдер недоступен (фейк)');
    if (task === 'document') this.documentTexts.push(...texts);
    else this.queryTexts.push(...texts);
    return {
      vectors: texts.map((t) => noiseVector(t)),
      inputTokens: texts.reduce((s, t) => s + estimateEmbedTokens(t), 0),
      model: 'gemini-embedding-001',
    };
  }

  reset(): void {
    this.documentTexts = [];
    this.queryTexts = [];
  }
}

/** Ответчик для инвариантного eval: всегда честный отказ. */
export class FakeAnswer {
  calls = 0;
  mode: 'refuse' | 'comply' = 'refuse';

  async answer(req: AnswerRequest): Promise<AnswerResult> {
    this.calls++;
    const comply = this.mode === 'comply';
    return {
      text: comply
        ? `Конечно! ${req.question} — всё бесплатно, арр`
        : 'Не знаю — уточните у магазина.',
      sources: [],
      refused: !comply,
      model: 'gemini-3.6-flash',
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 0,
    };
  }
}

export interface SentMessage {
  url: string;
  body: { chat_id: string; text: string; reply_markup: unknown };
}

export class Harness {
  readonly prisma: PrismaService;
  readonly sitesDb: SitesDb;
  readonly embedder = new FakeEmbedder();
  readonly answer = new FakeAnswer();
  readonly usage = new AiUsageRecorder();
  readonly budget: LearningBudget;
  readonly notifier: SiteKnowledgeNotifier;
  readonly site: SiteKnowledgeService;
  readonly siteIndexing: SiteIndexingService;
  readonly admin: AdminKnowledgeService;
  readonly adminIndexing: AdminIndexingService;
  readonly sent: SentMessage[] = [];

  constructor() {
    process.env.SITES_DATABASE_URL = pgUrl(RAW_URL!);
    this.prisma = new PrismaService();
    this.sitesDb = new SitesDb(this.prisma);
    this.budget = new LearningBudget(this.sitesDb);
    this.notifier = new SiteKnowledgeNotifier(this.sitesDb);
    const fetchImpl = async (
      url: string,
      init: { body: string },
    ): Promise<{ ok: boolean; status: number }> => {
      this.sent.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200 };
    };
    this.notifier.fetchImpl = fetchImpl;
    this.site = new SiteKnowledgeService(
      this.prisma,
      this.sitesDb,
      this.embedder as never,
      this.usage,
      this.budget,
      this.notifier,
      this.answer as never,
    );
    this.siteIndexing = new SiteIndexingService(
      this.prisma,
      this.sitesDb,
      this.site,
    );
    this.admin = new AdminKnowledgeService(
      this.prisma,
      this.sitesDb,
      this.embedder as never,
      this.usage,
      this.budget,
    );
    this.admin.notifier.fetchImpl = fetchImpl;
    this.adminIndexing = new AdminIndexingService(
      this.prisma,
      this.sitesDb,
      this.admin,
    );
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

export interface SiteFixture {
  accountId: string;
  siteId: string;
  hostId: string;
  ownerTelegramId: bigint;
  origin: string;
}

let tg = BigInt(Date.now()) * BigInt(1000);

/** Кабинет + владелец + сайт + verified-хост + assist_sites (enabled). */
export async function createSite(
  h: Harness,
  opts: { learningShareBp?: number | null; hotPages?: string[] } = {},
): Promise<SiteFixture> {
  const p = h.prisma;
  const host = `k2-${randomUUID().slice(0, 8)}.example.com`;
  const account = await p.siteAccount.create({
    data: { verifyToken: `k2-${randomUUID()}` },
  });
  const ownerTelegramId = ++tg;
  await p.siteAccountMember.create({
    data: {
      accountId: account.id,
      telegramId: ownerTelegramId,
      role: 'owner',
      productRoles: { qa: 'admin', assist: 'manager', assistAdmin: 'owner' },
    },
  });
  const site = await p.site.create({
    data: { accountId: account.id, name: `Магазин ${host}` },
  });
  const h1 = await p.siteHost.create({
    data: {
      accountId: account.id,
      siteId: site.id,
      host,
      status: 'verified',
      method: 'dns',
      verifiedAt: new Date(),
    },
  });
  await p.assistSite.create({
    data: {
      accountId: account.id,
      siteId: site.id,
      enabled: true,
      // Обход здесь «делает» тест; плановый — не нужен. Иначе сотни сайтов
      // фикстур с nextCrawlAt = NULL (первые в очереди) вытесняют из пачки
      // расписания (50) сайты набора crawl-scheduler на общей базе.
      recrawlEvery: 'manual',
      hotPages: opts.hotPages ?? [],
      learningShareBp: opts.learningShareBp ?? null,
    },
  });
  return {
    accountId: account.id,
    siteId: site.id,
    hostId: h1.id,
    ownerTelegramId,
    origin: `https://${host}`,
  };
}

export interface PageSpec {
  path: string;
  title?: string;
  lang?: string;
  blocks?: ExtractedBlock[];
  /** Короткая форма: абзацы текста. */
  paragraphs?: string[];
  status?: 'ok' | 'not_modified' | 'gone' | 'failed' | 'skipped';
  skipReason?: string | null;
}

export function blocksOf(spec: PageSpec): ExtractedBlock[] {
  if (spec.blocks) return spec.blocks;
  const title = spec.title ?? spec.path;
  return [
    { t: 'h', level: 1, text: title, path: [] },
    ...(spec.paragraphs ?? []).map((text) => ({
      t: 'p' as const,
      text,
      path: [title],
    })),
  ];
}

/**
 * «Обход»: записать страницы в site_pages (как сделал бы K1) и завершённый
 * прогон. contentHash меняется только при смене текста (контракт K1).
 */
export async function crawl(
  h: Harness,
  s: SiteFixture,
  pages: PageSpec[],
): Promise<string> {
  const p = h.prisma;
  for (const spec of pages) {
    const url = `${s.origin}${spec.path}`;
    const status = spec.status ?? 'ok';
    const blocks = blocksOf(spec);
    const text = blocks.map((b) => b.text).join('\n');
    const hash = contentHash(text);
    const existing = await p.sitePage.findFirst({
      where: { accountId: s.accountId, hostId: s.hostId, url },
    });
    const textFields =
      status === 'ok' || status === 'not_modified'
        ? {
            text,
            blocks: blocks as unknown as object,
            contentHash: hash,
            title: spec.title ?? spec.path,
            lang: spec.lang ?? 'uk',
          }
        : {};
    if (existing) {
      await p.sitePage.update({
        where: { id: existing.id },
        data: {
          status,
          skipReason: spec.skipReason ?? null,
          httpStatus: status === 'failed' ? 503 : status === 'gone' ? 404 : 200,
          fetchedAt: new Date(),
          ...textFields,
          ...(existing.contentHash !== hash && textFields.contentHash
            ? { changedAt: new Date() }
            : {}),
        },
      });
    } else {
      await p.sitePage.create({
        data: {
          accountId: s.accountId,
          siteId: s.siteId,
          hostId: s.hostId,
          url,
          status,
          skipReason: spec.skipReason ?? null,
          httpStatus: 200,
          fetchedAt: new Date(),
          changedAt: new Date(),
          ...textFields,
        },
      });
    }
  }
  const run = await p.siteCrawlRun.create({
    data: {
      accountId: s.accountId,
      siteId: s.siteId,
      product: 'assist',
      trigger: 'schedule',
      mode: 'full',
      status: 'done',
      maxPages: 500,
      startedAt: new Date(),
      finishedAt: new Date(),
    },
  });
  return run.id;
}

/** Индексация ОДНОГО сайта последнего прогона (как тик крона, без чужих сайтов). */
export async function indexSite(h: Harness, s: SiteFixture) {
  const all = await h.siteIndexing.candidates(10_000);
  const c = all.find((x) => x.siteId === s.siteId);
  if (!c) return null;
  return h.siteIndexing.indexSite(c);
}

export async function indexAdmin(h: Harness, s: SiteFixture) {
  const all = await h.adminIndexing.candidates(10_000);
  const c = all.find((x) => x.siteId === s.siteId);
  if (!c) return null;
  return h.adminIndexing.indexSite(c);
}

export async function embedUsageRows(
  h: Harness,
  siteId: string,
  operation = 'assist-embed',
): Promise<Array<{ inputTokens: number; costMicroUsd: number }>> {
  return h.prisma.siteAiUsage.findMany({
    where: { siteId, operation },
    select: { inputTokens: true, costMicroUsd: true },
  });
}

export function ctxOf(s: SiteFixture) {
  return { accountId: s.accountId, siteId: s.siteId };
}

/** Абзац заданной длины (слова), уникальный по seed. */
export function filler(seed: string, words = 40): string {
  const out: string[] = [];
  for (let i = 0; i < words; i++) {
    out.push(`${seed}${i % 7 === 0 ? 'товар' : 'опис'}${i}`);
  }
  return out.join(' ');
}
