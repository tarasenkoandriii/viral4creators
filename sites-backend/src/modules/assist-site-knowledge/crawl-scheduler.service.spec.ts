/**
 * Расписание обхода помощника на реальном Postgres: наступивший переобход,
 * ручной режим, сайт без подтверждённого хоста, «горячие» страницы раз в
 * сутки, исключения уходят в запрос обхода, requestNow → 409 без хоста.
 * SiteCrawlService — настоящий (без тика: сеть здесь не нужна).
 */

import type { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import { SiteCrawlService } from '../site-crawl/crawl.service';
import { setPlan } from '../assist-billing/testing/billing-fixtures.testing';
import {
  createSite,
  describeDb,
  dropAccounts,
  testPrisma,
} from '../site-crawl/testing/crawl-db.testing';
import {
  AssistCrawlScheduler,
  recrawlIntervalMs,
} from './crawl-scheduler.service';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

describeDb('AssistCrawlScheduler (реальный Postgres)', () => {
  let prisma: PrismaService;
  let scheduler: AssistCrawlScheduler;
  let crawl: SiteCrawlService;
  const accounts: string[] = [];
  // Реальное «сейчас»: подтверждение хоста фикстуры действует 90 дней от него.
  const now = new Date();

  beforeAll(() => {
    prisma = testPrisma();
    const db = new SitesDb(prisma);
    crawl = new SiteCrawlService(
      db,
      null as never,
      null as never,
      null as never,
    );
    scheduler = new AssistCrawlScheduler(db, crawl);
  });
  afterAll(async () => {
    await dropAccounts(prisma, accounts);
    await prisma.$disconnect();
  });

  async function assistSite(
    host: { host: string; status?: 'verified' | 'pending' },
    data: Record<string, unknown>,
  ) {
    const fx = await createSite(prisma, [host]);
    accounts.push(fx.accountId);
    await prisma.assistSite.create({
      data: {
        accountId: fx.accountId,
        siteId: fx.siteId,
        enabled: true,
        ...data,
      },
    });
    return fx;
  }

  const runsOf = (siteId: string) =>
    prisma.siteCrawlRun.findMany({
      where: { siteId },
      orderBy: { createdAt: 'asc' },
    });

  it('наступивший weekly/daily — full-прогон, nextCrawlAt сдвинут, lastCrawlRunId записан; manual и будущий — нет', async () => {
    const due = await assistSite(
      { host: 'k1s-due.polygon.example' },
      { recrawlEvery: 'daily', nextCrawlAt: new Date(now.getTime() - 1) },
    );
    const fresh = await assistSite(
      { host: 'k1s-new.polygon.example' },
      { recrawlEvery: 'weekly', nextCrawlAt: null },
    );
    const manual = await assistSite(
      { host: 'k1s-man.polygon.example' },
      { recrawlEvery: 'manual', nextCrawlAt: null },
    );
    const later = await assistSite(
      { host: 'k1s-later.polygon.example' },
      { recrawlEvery: 'weekly', nextCrawlAt: new Date(now.getTime() + HOUR) },
    );
    const off = await assistSite(
      { host: 'k1s-off.polygon.example' },
      { recrawlEvery: 'weekly', nextCrawlAt: null, enabled: false },
    );

    // Э4: лимит страниц — «страниц в знаниях» тарифа кабинета (§7.1):
    // у `due` — Business (2000), у `fresh` — пробный (50).
    await setPlan(prisma, due.accountId, 'business');

    const r = await scheduler.scheduleDue(now);
    expect(r.runsRequested).toBeGreaterThanOrEqual(2);

    const [dueRun] = await runsOf(due.siteId);
    expect(dueRun).toMatchObject({
      product: 'assist',
      trigger: 'schedule',
      mode: 'full',
      maxPages: 2000,
    });
    const [freshRun] = await runsOf(fresh.siteId);
    expect(freshRun).toMatchObject({ maxPages: 50 });
    const dueSettings = await prisma.assistSite.findFirst({
      where: { siteId: due.siteId },
    });
    expect(dueSettings!.nextCrawlAt!.getTime()).toBe(now.getTime() + DAY);
    expect(dueSettings!.lastCrawlRunId).toBe(dueRun.id);
    const freshSettings = await prisma.assistSite.findFirst({
      where: { siteId: fresh.siteId },
    });
    expect(freshSettings!.nextCrawlAt!.getTime()).toBe(now.getTime() + 7 * DAY);
    expect(await runsOf(fresh.siteId)).toHaveLength(1);
    for (const s of [manual, later, off])
      expect(await runsOf(s.siteId)).toHaveLength(0);

    // Повторный вызов в ту же минуту — ничего нового (nextCrawlAt в будущем).
    await scheduler.scheduleDue(now);
    expect(await runsOf(due.siteId)).toHaveLength(1);
  });

  it('нет подтверждённого хоста — обход не запрашивается, проверка снова через час', async () => {
    const fx = await assistSite(
      { host: 'k1s-pend.polygon.example', status: 'pending' },
      { recrawlEvery: 'weekly' },
    );
    await scheduler.scheduleDue(now);
    expect(await runsOf(fx.siteId)).toHaveLength(0);
    const s = await prisma.assistSite.findFirst({
      where: { siteId: fx.siteId },
    });
    expect(s!.nextCrawlAt!.getTime()).toBe(now.getTime() + HOUR);
  });

  it('горячие страницы — раз в сутки на любом режиме, mode hot, только URL списка', async () => {
    const fx = await assistSite(
      { host: 'k1s-hot.polygon.example' },
      {
        recrawlEvery: 'manual',
        hotPages: [
          'https://k1s-hot.polygon.example/delivery',
          'https://k1s-hot.polygon.example/pay',
        ],
        hotCheckedAt: new Date(now.getTime() - DAY - 1),
      },
    );
    const r = await scheduler.scheduleDue(now);
    expect(r.hotRunsRequested).toBeGreaterThanOrEqual(1);
    const [run] = await runsOf(fx.siteId);
    expect(run).toMatchObject({ mode: 'hot', trigger: 'hot', maxPages: 2 });
    expect((run.options as { urls: string[] }).urls).toEqual([
      'https://k1s-hot.polygon.example/delivery',
      'https://k1s-hot.polygon.example/pay',
    ]);
    const s = await prisma.assistSite.findFirst({
      where: { siteId: fx.siteId },
    });
    expect(s!.hotCheckedAt!.getTime()).toBe(now.getTime());
    await prisma.siteCrawlRun.updateMany({
      where: { siteId: fx.siteId },
      data: { status: 'done' },
    });
    await scheduler.scheduleDue(new Date(now.getTime() + HOUR));
    expect(await runsOf(fx.siteId)).toHaveLength(1);
  });

  it('requestNow: исключения url/urlPrefix уходят в прогон; без verified-хоста — 409 HOST_NOT_VERIFIED', async () => {
    const fx = await assistSite(
      { host: 'k1s-now.polygon.example' },
      { recrawlEvery: 'weekly' },
    );
    await prisma.assistSiteExclusion.createMany({
      data: [
        {
          accountId: fx.accountId,
          siteId: fx.siteId,
          kind: 'url',
          value: 'https://k1s-now.polygon.example/a',
          createdByTelegramId: 1n,
        },
        {
          accountId: fx.accountId,
          siteId: fx.siteId,
          kind: 'urlPrefix',
          value: 'https://k1s-now.polygon.example/b/',
          createdByTelegramId: 1n,
        },
        {
          accountId: fx.accountId,
          siteId: fx.siteId,
          kind: 'chunkHash',
          value: 'abc',
          createdByTelegramId: 1n,
        },
      ],
    });
    const r = await scheduler.requestNow({
      accountId: fx.accountId,
      siteId: fx.siteId,
      trigger: 'manual',
      byTelegramId: 77n,
    });
    expect(r.deduplicated).toBe(false);
    const run = await prisma.siteCrawlRun.findUnique({
      where: { id: r.runId },
    });
    expect(run).toMatchObject({
      trigger: 'manual',
      mode: 'full',
      requestedByTelegramId: 77n,
    });
    expect(run!.options).toEqual({
      excludeUrls: ['https://k1s-now.polygon.example/a'],
      excludePrefixes: ['https://k1s-now.polygon.example/b/'],
    });
    expect(
      (
        await scheduler.requestNow({
          accountId: fx.accountId,
          siteId: fx.siteId,
          trigger: 'manual',
        })
      ).deduplicated,
    ).toBe(true);

    const pend = await assistSite(
      { host: 'k1s-nohost.polygon.example', status: 'pending' },
      {},
    );
    await expect(
      scheduler.requestNow({
        accountId: pend.accountId,
        siteId: pend.siteId,
        trigger: 'initial',
      }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'HOST_NOT_VERIFIED' },
    });
  });

  it('recrawlIntervalMs', () => {
    expect(recrawlIntervalMs('daily')).toBe(DAY);
    expect(recrawlIntervalMs('weekly')).toBe(7 * DAY);
    expect(recrawlIntervalMs('manual')).toBeNull();
  });
});
