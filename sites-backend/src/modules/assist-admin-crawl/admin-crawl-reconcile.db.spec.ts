/**
 * Сверка обходов «Админки» с очередью воркера (аудит Ш3 P2) на НАСТОЯЩЕМ
 * Postgres: запись `queued`/`running`, чьё задание уже кончилось (или
 * пропало), доводится до итога задания; живое задание и «сдано, обработчик
 * пишет» — не трогаются; свежие записи — тоже (окно
 * `ADMIN_CRAWL_RECONCILE_AFTER_MS`). Плюс выключенный воркер: уборка очереди
 * закрывает идущее задание `worker_disabled`, а запись обхода — `failed` с
 * понятной заметкой (обработчик отказа).
 */
import { randomUUID } from 'crypto';
import type { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import { BrowserJobsService } from '../browser-jobs/browser-jobs.service';
import { BrowserJobHandlers } from '../browser-jobs/job-handlers';
import { FakeArtifactStorage } from '../browser-jobs/testing/fake-artifact-storage.testing';
import {
  browserJobRow,
  describeDb,
  insertBrowserJob,
  ownerPrisma,
  serializeQueueTests,
} from '../browser-jobs/testing/jobs-db.testing';
import type { SiteCredentialsService } from '../site-credentials/site-credentials.service';
import {
  ADMIN_CRAWL_RECONCILE_AFTER_MS,
  AdminCrawlService,
} from './admin-crawl.service';

jest.setTimeout(120_000);

describeDb('сверка обходов «Админки» с очередью воркера (аудит Ш3)', () => {
  serializeQueueTests();
  let prisma: PrismaService;
  let jobs: BrowserJobsService;
  let crawl: AdminCrawlService;
  const env: NodeJS.ProcessEnv = { BROWSER_WORKER_ENABLED: 'true' };
  let s: { accountId: string; siteId: string; hostId: string; host: string };

  beforeAll(async () => {
    prisma = ownerPrisma();
    const db = new SitesDb(prisma);
    const handlers = new BrowserJobHandlers();
    jobs = new BrowserJobsService(db, new FakeArtifactStorage(), handlers);
    jobs.env = env;
    crawl = new AdminCrawlService(
      db,
      {} as SiteCredentialsService,
      jobs,
      handlers,
    );
    crawl.onModuleInit();
    const tag = randomUUID().slice(0, 8);
    const account = await prisma.siteAccount.create({
      data: { verifyToken: `ac-${randomUUID()}` },
    });
    const site = await prisma.site.create({
      data: { accountId: account.id, name: `ac ${tag}` },
    });
    const host = `admin-${tag}.ac.example.com`;
    const h = await prisma.siteHost.create({
      data: {
        accountId: account.id,
        siteId: site.id,
        host,
        status: 'verified',
        method: 'dns',
        verifiedAt: new Date(Date.now() - 60_000),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    s = { accountId: account.id, siteId: site.id, hostId: h.id, host };
  });

  afterAll(async () => {
    if (s) await prisma.siteAccount.deleteMany({ where: { id: s.accountId } });
    await prisma.$disconnect();
  });

  const OLD = () =>
    new Date(Date.now() - ADMIN_CRAWL_RECONCILE_AFTER_MS - 60_000);

  async function crawlRow(status: string, updatedAt = OLD()): Promise<string> {
    const row = await prisma.assistAdminCrawlJob.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        hostId: s.hostId,
        testAccountId: 'ta-1',
        requestedByTelegramId: BigInt(1),
        status,
      },
    });
    // `updatedAt` ставит Prisma — «давность» записи задаём сырым запросом.
    await prisma.$executeRaw`UPDATE sites.assist_admin_crawl_jobs SET "updatedAt" = ${updatedAt} WHERE id = ${row.id}`;
    return row.id;
  }

  async function browserJob(
    refId: string,
    over: Record<string, unknown>,
  ): Promise<string> {
    return insertBrowserJob(prisma, {
      accountId: s.accountId,
      siteId: s.siteId,
      hostId: s.hostId,
      kind: 'admin-crawl',
      origin: 'assist-admin-crawl',
      refId,
      params: {
        startUrl: `https://${s.host}/`,
        allowedHosts: [s.host],
        viewport: 'desktop',
        maxPages: 20,
        maxDepth: 2,
        loginMethod: 'password',
      },
      expiresAt: new Date(Date.now() + 86_400_000),
      ...over,
    });
  }

  const crawlStatus = async (id: string) =>
    prisma.assistAdminCrawlJob.findUniqueOrThrow({ where: { id } });

  it('задание кончилось/пропало — запись доводится; живое, «обработчик пишет» и свежее — нет', async () => {
    const failedRef = await crawlRow('running');
    await browserJob(failedRef, {
      status: 'failed',
      errorCode: 'login_failed',
    });
    const cancelledRef = await crawlRow('queued');
    await browserJob(cancelledRef, {
      status: 'cancelled',
      errorCode: 'cancelled',
    });
    const doneRef = await crawlRow('running');
    await browserJob(doneRef, {
      status: 'done',
      result: { loggedIn: true, pages: 4 },
    });
    const goneRef = await crawlRow('queued');
    const liveRef = await crawlRow('running');
    await browserJob(liveRef, { status: 'running' });
    const pendingRef = await crawlRow('running');
    await browserJob(pendingRef, { status: 'done', result: { pending: true } });
    const freshRef = await crawlRow('queued', new Date());

    expect(await crawl.reconcile(new Date())).toBe(4);
    expect(await crawlStatus(failedRef)).toMatchObject({
      status: 'failed',
      note: expect.stringMatching(/вход не удался/),
    });
    expect((await crawlStatus(cancelledRef)).status).toBe('cancelled');
    expect(await crawlStatus(doneRef)).toMatchObject({
      status: 'done',
      note: 'страниц: 4',
    });
    expect(await crawlStatus(goneRef)).toMatchObject({
      status: 'failed',
      note: expect.stringMatching(/не найдено/),
    });
    expect((await crawlStatus(liveRef)).status).toBe('running');
    expect((await crawlStatus(pendingRef)).status).toBe('running');
    expect((await crawlStatus(freshRef)).status).toBe('queued');
  });

  it('воркер выключен: уборка закрывает идущее задание, обход — failed «воркер выключен»', async () => {
    const ref = await crawlRow('running', new Date());
    const id = await browserJob(ref, {
      status: 'running',
      attempts: 1,
      leaseUntil: new Date(Date.now() - 1000),
    });
    env.BROWSER_WORKER_ENABLED = 'false';
    try {
      await jobs.reap(new Date(), { accountIds: [s.accountId] });
    } finally {
      env.BROWSER_WORKER_ENABLED = 'true';
    }
    expect(await browserJobRow(prisma, id)).toMatchObject({
      status: 'failed',
      errorCode: 'worker_disabled',
    });
    expect(await crawlStatus(ref)).toMatchObject({
      status: 'failed',
      note: expect.stringMatching(/воркер выключен/),
    });
  });
});
