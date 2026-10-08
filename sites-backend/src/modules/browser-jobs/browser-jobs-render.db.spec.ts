/**
 * Заход 10, пакет Д (миграция S2 `…_browser_jobs_knowledge_render`) на
 * НАСТОЯЩЕМ Postgres:
 *  - триггер: `knowledge-render` — только своим источником и наоборот,
 *    замок — один хост, без учётки; `voice-autotest` — только сверка
 *    дескрипторов (`descriptor-resolve`), без учётки;
 *  - постановка рендера: замок — хост задания, хост «Сайта» L1
 *    `assist-crawl`; суточный лимит источника (≤ 50 страниц/сайт/сутки);
 *  - сдача «Снимка» с раскрывашками: скриншоты состояний — загруженные
 *    артефакты (ссылка на незагруженный — отказ).
 */
import { randomUUID } from 'crypto';
import type { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import { ORIGIN_RULES } from './browser-job-rules';
import { BrowserJobsService } from './browser-jobs.service';
import { BrowserJobHandlers } from './job-handlers';
import { FakeArtifactStorage } from './testing/fake-artifact-storage.testing';
import {
  describeDb,
  leaseJobForTest,
  ownerPrisma,
  serializeQueueTests,
} from './testing/jobs-db.testing';

jest.setTimeout(120_000);

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString(
  'base64',
);

describeDb('очередь воркера: рендер SPA и Т-3 (заход 10, S2)', () => {
  serializeQueueTests();
  let prisma: PrismaService;
  let svc: BrowserJobsService;
  let handlers: BrowserJobHandlers;
  const failed: Array<[string, string]> = [];
  const accounts: string[] = [];

  interface Site {
    accountId: string;
    siteId: string;
    hostId: string;
    host: string;
  }

  async function site(): Promise<Site> {
    const tag = randomUUID().slice(0, 8);
    const host = `r-${tag}.bjr.example.com`;
    const account = await prisma.siteAccount.create({
      data: { verifyToken: `bjr-${randomUUID()}` },
    });
    accounts.push(account.id);
    const s = await prisma.site.create({
      data: { accountId: account.id, name: `bjr ${tag}` },
    });
    const h = await prisma.siteHost.create({
      data: {
        accountId: account.id,
        siteId: s.id,
        host,
        status: 'verified',
        method: 'dns',
        verifiedAt: new Date(Date.now() - 60_000),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    return { accountId: account.id, siteId: s.id, hostId: h.id, host };
  }

  const renderParams = (s: Site, hosts = [s.host]) => ({
    urls: [`https://${s.host}/`, `https://${s.host}/about`],
    allowedHosts: hosts,
    viewport: 'desktop',
  });

  const row = (s: Site, over: Record<string, unknown>) =>
    prisma.siteBrowserJob.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        hostId: s.hostId,
        kind: 'knowledge-render',
        origin: 'knowledge-render',
        params: renderParams(s),
        expiresAt: new Date(Date.now() + 3600_000),
        ...over,
      } as never,
    });

  beforeAll(() => {
    prisma = ownerPrisma();
    handlers = new BrowserJobHandlers();
    svc = new BrowserJobsService(
      new SitesDb(prisma),
      new FakeArtifactStorage(),
      handlers,
    );
    svc.env = { BROWSER_WORKER_ENABLED: 'true' };
  });

  afterAll(async () => {
    if (accounts.length)
      await prisma.siteAccount.deleteMany({ where: { id: { in: accounts } } });
    await prisma.$disconnect();
  });

  it('триггер: knowledge-render — только парой вид/источник, один хост, без учётки; voice-autotest — только сверка', async () => {
    const s = await site();
    await expect(row(s, {})).resolves.toMatchObject({
      kind: 'knowledge-render',
    });
    await expect(row(s, { origin: 'voice-map-snapshot' })).rejects.toThrow(
      /не для вида/,
    );
    await expect(row(s, { kind: 'ui-snapshot' })).rejects.toThrow(
      /не для вида/,
    );
    await expect(
      row(s, { params: renderParams(s, [s.host, 'x.bjr.example.com']) }),
    ).rejects.toThrow(/одного хоста/);
    await expect(
      row(s, { params: { urls: [], viewport: 'desktop' } }),
    ).rejects.toThrow(/одного хоста/);
    await expect(row(s, { testAccountId: 'acc-1' })).rejects.toThrow(
      /без учётки/,
    );
    await expect(
      row(s, { params: { ...renderParams(s), cookies: 'sid=1' } }),
    ).rejects.toThrow(/секреты/);
    const check = {
      kind: 'descriptor-resolve',
      origin: 'voice-autotest',
      params: {
        pages: [`https://${s.host}/`],
        allowedHosts: [s.host],
        viewport: 'desktop',
        targets: [],
      },
    };
    await expect(row(s, check)).resolves.toMatchObject({
      origin: 'voice-autotest',
    });
    await expect(row(s, { ...check, kind: 'ui-snapshot' })).rejects.toThrow(
      /не для вида/,
    );
    await expect(row(s, { ...check, testAccountId: 'acc-2' })).rejects.toThrow(
      /не для вида/,
    );
    await expect(row(s, { origin: 'no-such-origin' })).rejects.toThrow(
      /неизвестный источник/,
    );
  });

  it('постановка рендера: замок — хост задания; суточный лимит источника (≤ 50 страниц)', async () => {
    const s = await site();
    const job = await svc.enqueue(s.accountId, {
      siteId: s.siteId,
      hostId: s.hostId,
      origin: 'knowledge-render',
      params: renderParams(s) as never,
      refId: 'run-1',
      requestedBy: 'crawl:run-1',
    });
    expect(job).toMatchObject({ kind: 'knowledge-render', status: 'queued' });
    await expect(
      svc.enqueue(s.accountId, {
        siteId: s.siteId,
        hostId: s.hostId,
        origin: 'knowledge-render',
        params: {
          ...renderParams(s),
          urls: ['https://other.bjr.example.com/'],
          allowedHosts: ['other.bjr.example.com'],
        } as never,
        requestedBy: 'crawl:run-1',
      }),
    ).rejects.toThrow(/замок задания/);
    // Сутки исчерпаны (сданные задания тоже считаются).
    await prisma.siteBrowserJob.updateMany({
      where: { siteId: s.siteId },
      data: { status: 'done' },
    });
    const left = ORIGIN_RULES['knowledge-render'].dailyPerSite - 1;
    for (let i = 0; i < left; i++)
      await row(s, { status: 'done', createdAt: new Date() });
    await expect(
      svc.enqueue(s.accountId, {
        siteId: s.siteId,
        hostId: s.hostId,
        origin: 'knowledge-render',
        params: renderParams(s) as never,
        requestedBy: 'crawl:run-2',
      }),
    ).rejects.toMatchObject({
      response: { code: 'BROWSER_JOB_DAILY_LIMIT' },
    });
  });

  it('сдача «Снимка» с раскрывашками: скриншот состояния — только загруженный артефакт', async () => {
    const s = await site();
    const job = await prisma.siteBrowserJob.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        hostId: s.hostId,
        kind: 'ui-snapshot',
        origin: 'voice-map-snapshot',
        params: {
          url: `https://${s.host}/`,
          allowedHosts: [s.host],
          viewport: 'mobile',
          screenshot: true,
          mapElements: false,
          toggles: 5,
        },
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    const token = await leaseJobForTest(prisma, job.id);
    const art = (idx: number) => ({
      idx,
      contentType: 'image/jpeg',
      data: JPEG,
      width: 390,
      height: 844,
    });
    await svc.putArtifact(job.id, token, art(0));
    const result = {
      finalUrl: `https://${s.host}/`,
      snapshot: { url: `https://${s.host}/`, title: 'Т', elements: [] },
      mapElements: [],
      screenshot: 0,
      viewport: { width: 390, height: 844 },
      blockedRequests: 0,
      states: [{ label: 'Меню', elements: [], screenshot: 1 }],
    };
    await expect(svc.complete(job.id, token, result)).rejects.toMatchObject({
      response: { code: 'WORKER_BAD_RESULT' },
    });
    await svc.putArtifact(job.id, token, art(1));
    await expect(svc.complete(job.id, token, result)).resolves.toEqual({
      ok: true,
    });
    const done = await prisma.siteBrowserJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    expect(done.status).toBe('done');
    expect((done.result as { states: unknown[] }).states).toHaveLength(1);
  });

  const snapJob = async (s: Site) => {
    const job = await prisma.siteBrowserJob.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        hostId: s.hostId,
        kind: 'ui-snapshot',
        origin: 'voice-map-snapshot',
        params: {
          url: `https://${s.host}/`,
          allowedHosts: [s.host],
          viewport: 'mobile',
          screenshot: false,
          mapElements: false,
        },
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    return { id: job.id, token: await leaseJobForTest(prisma, job.id) };
  };
  const snapResult = (s: Site, title: string) => ({
    finalUrl: `https://${s.host}/`,
    snapshot: { url: `https://${s.host}/`, title, elements: [] },
    mapElements: [],
    screenshot: null,
    viewport: { width: 390, height: 844 },
    blockedRequests: 0,
  });

  it('аудит P2-2 (проба Postgres): одиночный суррогат в результате — принят как U+FFFD, а не «сдано, пишется» навсегда', async () => {
    const s = await site();
    const { id, token } = await snapJob(s);
    await expect(
      svc.complete(id, token, snapResult(s, 'Магазин \uD83D')),
    ).resolves.toEqual({ ok: true });
    const row = await prisma.siteBrowserJob.findUniqueOrThrow({
      where: { id },
    });
    expect(row.status).toBe('done');
    expect((row.result as { snapshot: { title: string } }).snapshot.title).toBe(
      'Магазин \uFFFD',
    );
  });

  it('аудит P2-2: финальная запись упала (jsonb не принял) — failed: internal с уведомлением продукта, не pending', async () => {
    failed.length = 0;
    handlers.register('voice-map-snapshot', {
      // Продукт вернул то, что jsonb не примет (NUL).
      onDone: async () => ({ note: 'a\u0000b' }),
      onFailed: async (j, code) => {
        failed.push([j.id, code]);
      },
    });
    try {
      const s = await site();
      const { id, token } = await snapJob(s);
      await expect(
        svc.complete(id, token, snapResult(s, 'Магазин')),
      ).resolves.toEqual({ ok: true });
      const row = await prisma.siteBrowserJob.findUniqueOrThrow({
        where: { id },
      });
      expect(row).toMatchObject({ status: 'failed', errorCode: 'internal' });
      expect(row.result).toBeNull();
      expect(failed).toEqual([[id, 'internal']]);
    } finally {
      handlers.register('voice-map-snapshot', {});
    }
  });

  it('dropResult: разобранный результат рендера стирается; чужой источник и идущее задание — нет', async () => {
    const s = await site();
    const done = await row(s, {
      status: 'done',
      result: { pages: [] },
      resultBytes: 12,
    });
    const running = await row(s, { status: 'running', result: { x: 1 } });
    await svc.dropResult(s.accountId, done.id, {
      origin: 'voice-map-snapshot',
    });
    expect(
      (
        await prisma.siteBrowserJob.findUniqueOrThrow({
          where: { id: done.id },
        })
      ).result,
    ).toEqual({ pages: [] });
    await svc.dropResult(s.accountId, done.id, { origin: 'knowledge-render' });
    await svc.dropResult(s.accountId, running.id, {
      origin: 'knowledge-render',
    });
    const [d, r] = await Promise.all(
      [done.id, running.id].map((id) =>
        prisma.siteBrowserJob.findUniqueOrThrow({ where: { id } }),
      ),
    );
    expect(d).toMatchObject({ result: null, resultBytes: null });
    expect(r.result).toEqual({ x: 1 });
  });
});
