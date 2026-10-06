/**
 * SiteCrawlService на реальном Postgres и локальном https-стенде:
 * дедупликация запросов, lease (два тика не обходят одну страницу),
 * gone/failed (5xx не стирает знания), исключения (§4-тер.12, B4 — часть
 * K1), «горячие» страницы условным запросом, только verified-хосты.
 */

import type { PrismaService } from '../../prisma/prisma.service';
import { SiteCrawlService } from './crawl.service';
import {
  createSite,
  describeDb,
  dropAccounts,
  dropRobots,
  testPrisma,
} from './testing/crawl-db.testing';
import { crawlStack, tickUntilIdle } from './testing/crawl-stack.testing';
import { LocalSites } from './testing/local-sites.testing';

const H = 'k1svc.polygon.example';
/** Сайт больше одного батча (pagesPerTick = 20). */
const BIG = 'k1big.polygon.example';
/** Сайт с медленной страницей (lease строки очереди). */
const SLOW = 'k1slow.polygon.example';
/**
 * Кэш robots (`site_crawl_robots`) — общий по origin и переживает прогон:
 * неудачная загрузка robots кэшируется на ~30 мин (ROBOTS_ERROR_TTL_MS), и
 * следующие прогоны на той же базе не обходили BIG/SLOW («больше одного
 * батча», «lease строки очереди» — 0 страниц). Свои origin чистим до и после.
 */
const ROBOTS_ORIGINS = [H, BIG, SLOW].map((h) => `https://${h}`);

describeDb('SiteCrawlService (реальный Postgres)', () => {
  const net = new LocalSites();
  let prisma: PrismaService;
  let crawl: SiteCrawlService;
  const accounts: string[] = [];
  let mode: 'normal' | 'broken' = 'normal';

  const page = (title: string, links: string[] = []) =>
    net.html(
      `<html lang="uk"><body><main><h1>${title}</h1><p>Текст сторінки ${title}.</p>${links
        .map((l) => `<a href="${l}">${l}</a>`)
        .join('')}</main></body></html>`,
    );

  beforeAll(async () => {
    await net.start();
    prisma = testPrisma();
    await dropRobots(prisma, ROBOTS_ORIGINS);
    crawl = crawlStack(prisma, net, accounts).crawl;
    net.site(H, {
      '/robots.txt': { status: 404 },
      '/sitemap.xml': { status: 404 },
      '/': () =>
        page('Головна', [
          '/a',
          '/b',
          '/c',
          '/d',
          '/e',
          '/f',
          '/promo/1',
          '/promo/2',
          '/promo',
          '/x/only',
        ]),
      '/a': () =>
        mode === 'normal' ? page('A') : { status: 503, body: 'down' },
      '/b': () =>
        mode === 'normal' ? page('B') : { status: 404, body: 'nope' },
      '/c': () => page('C'),
      '/d': () => page('D'),
      '/e': () => page('E'),
      '/f': () => page('F'),
      '/promo/1': () => page('Promo 1'),
      '/promo/2': () => page('Promo 2'),
      '/promo': () => page('Promo'),
      '/x/only': () => page('X only'),
    });
    const many = Array.from({ length: 30 }, (_, i) => `/n/${i}`);
    net.site(BIG, {
      '/robots.txt': { status: 404 },
      '/sitemap.xml': { status: 404 },
      '/': () => page('Великий', many),
      ...Object.fromEntries(many.map((p) => [p, () => page(`N ${p}`)])),
    });
    net.site(SLOW, {
      '/robots.txt': { status: 404 },
      '/sitemap.xml': { status: 404 },
      '/': () => page('Повільний', ['/slow']),
      '/slow': () => ({ ...page('Slow'), delayMs: 600 }),
    });
  });

  afterAll(async () => {
    await dropAccounts(prisma, accounts);
    await dropRobots(prisma, ROBOTS_ORIGINS);
    await prisma.$disconnect();
    await net.stop();
  });

  beforeEach(() => {
    mode = 'normal';
    net.hits.length = 0;
  });

  async function site(hosts = [{ host: H }]) {
    const fx = await createSite(prisma, hosts);
    accounts.push(fx.accountId);
    return fx;
  }

  const full = (fx: { accountId: string; siteId: string }) => ({
    accountId: fx.accountId,
    siteId: fx.siteId,
    product: 'assist' as const,
    trigger: 'manual' as const,
    mode: 'full' as const,
    maxPages: 50,
  });

  it('requestRun: дубль активного прогона не создаётся, в т.ч. при гонке; full покрывает hot', async () => {
    const fx = await site();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => crawl.requestRun(full(fx))),
    );
    expect(new Set(results.map((r) => r.runId)).size).toBe(1);
    expect(results.filter((r) => !r.deduplicated)).toHaveLength(1);
    const hot = await crawl.requestRun({
      ...full(fx),
      mode: 'hot',
      trigger: 'hot',
      urls: [`https://${H}/a`],
    });
    expect(hot).toEqual({ runId: results[0].runId, deduplicated: true });
    expect(
      await prisma.siteCrawlRun.count({ where: { siteId: fx.siteId } }),
    ).toBe(1);
    // Прогон не нужен остальным тестам.
    await prisma.siteCrawlRun.update({
      where: { id: hot.runId },
      data: { status: 'cancelled' },
    });
  });

  it('requestRun: чужой сайт (другой кабинет) — не найден', async () => {
    const a = await site();
    const b = await site();
    await expect(
      crawl.requestRun({ ...full(a), siteId: b.siteId }),
    ).rejects.toThrow('Сайт не найден');
    expect(
      await prisma.siteCrawlRun.count({ where: { siteId: b.siteId } }),
    ).toBe(0);
  });

  it('lease: два параллельных тика не обходят одну страницу дважды; done — после всех страниц', async () => {
    const fx = await site();
    const { runId } = await crawl.requestRun(full(fx));
    const other = crawlStack(prisma, net, accounts).crawl;
    await Promise.all([crawl.tick(60_000), other.tick(60_000)]);
    await tickUntilIdle(crawl);
    const perUrl = new Map<string, number>();
    for (const h of net.hits.filter(
      (x) => !x.endsWith('.txt') && !x.endsWith('.xml'),
    )) {
      perUrl.set(h, (perUrl.get(h) ?? 0) + 1);
    }
    expect([...perUrl.values()].every((n) => n === 1)).toBe(true);
    expect(perUrl.size).toBe(11);
    const run = (await crawl.getRun(fx.accountId, runId))!;
    expect(run.status).toBe('done');
    expect(run.pagesChanged).toBe(11);
    expect(run.pagesSeen).toBe(11);
    expect(
      await prisma.sitePage.count({
        where: { siteId: fx.siteId, status: 'ok' },
      }),
    ).toBe(11);
    expect(
      await prisma.siteCrawlQueueItem.count({
        where: { runId, status: 'pending' },
      }),
    ).toBe(0);
  });

  it('404 на ранее ok — gone; 503 — повторы, затем failed с СОХРАНЁННЫМ текстом', async () => {
    const fx = await site();
    await crawl.requestRun(full(fx));
    await tickUntilIdle(crawl);
    const before = await prisma.sitePage.findFirst({
      where: { siteId: fx.siteId, url: `https://${H}/a` },
    });
    expect(before!.status).toBe('ok');

    mode = 'broken';
    net.hits.length = 0;
    const { runId } = await crawl.requestRun(full(fx));
    await tickUntilIdle(crawl);
    const run = (await crawl.getRun(fx.accountId, runId))!;
    expect(run.status).toBe('done');
    expect(run.pagesGone).toBe(1);
    expect(run.pagesFailed).toBe(1);
    const a = await prisma.sitePage.findFirst({
      where: { siteId: fx.siteId, url: `https://${H}/a` },
    });
    const b = await prisma.sitePage.findFirst({
      where: { siteId: fx.siteId, url: `https://${H}/b` },
    });
    expect(a).toMatchObject({
      status: 'failed',
      skipReason: 'http_5xx',
      httpStatus: 503,
      failCount: 1,
    });
    expect(a!.text).toBe(before!.text);
    expect(a!.contentHash).toBe(before!.contentHash);
    expect(a!.changedAt!.getTime()).toBe(before!.changedAt!.getTime());
    expect(b).toMatchObject({ status: 'gone', httpStatus: 404 });
    expect(b!.goneAt).not.toBeNull();
    // 3 попытки на 503 (CRAWL_DEFAULTS.maxAttempts).
    expect(net.hits.filter((h) => h === `${H}/a`)).toHaveLength(3);

    // Сайт ожил: failed с тем же текстом — не «изменение», gone — снова в строю.
    mode = 'normal';
    const back = await crawl.requestRun(full(fx));
    await tickUntilIdle(crawl);
    const run3 = (await crawl.getRun(fx.accountId, back.runId))!;
    const a3 = await prisma.sitePage.findFirst({
      where: { siteId: fx.siteId, url: `https://${H}/a` },
    });
    const b3 = await prisma.sitePage.findFirst({
      where: { siteId: fx.siteId, url: `https://${H}/b` },
    });
    expect(a3!.status).toBe('ok');
    expect(a3!.changedAt!.getTime()).toBe(before!.changedAt!.getTime());
    expect(b3!.status).toBe('ok');
    expect(b3!.goneAt).toBeNull();
    expect(run3.pagesChanged).toBe(1);
  });

  it('исключения: префикс и точный URL не запрашиваются вовсе (B4, §4-тер.12)', async () => {
    const fx = await site();
    const { runId } = await crawl.requestRun({
      ...full(fx),
      excludePrefixes: [`https://${H}/promo/`],
      excludeUrls: [`https://${H}/x/only`],
    });
    await tickUntilIdle(crawl);
    expect(net.hits).not.toContain(`${H}/promo/1`);
    expect(net.hits).not.toContain(`${H}/promo/2`);
    expect(net.hits).not.toContain(`${H}/x/only`);
    // Префикс с «/» на конце не задевает сам `/promo`.
    expect(net.hits).toContain(`${H}/promo`);
    const run = (await crawl.getRun(fx.accountId, runId))!;
    expect(run.skippedByReason).toEqual({ excluded: 3 });
  });

  it('hot: только перечисленные URL и условным запросом (ETag нет — по хешу, без смены)', async () => {
    const fx = await site();
    await crawl.requestRun(full(fx));
    await tickUntilIdle(crawl);
    net.hits.length = 0;
    const { runId } = await crawl.requestRun({
      ...full(fx),
      mode: 'hot',
      trigger: 'hot',
      urls: [`https://${H}/c`, `https://${H}/d?utm_source=tg`],
    });
    await tickUntilIdle(crawl);
    expect(net.hits.filter((h) => !h.endsWith('.txt')).sort()).toEqual([
      `${H}/c`,
      `${H}/d`,
    ]);
    const run = (await crawl.getRun(fx.accountId, runId))!;
    expect(run).toMatchObject({
      status: 'done',
      mode: 'hot',
      pagesChanged: 0,
      pagesUnchanged: 2,
    });
  });

  it('только verified: сайт без подтверждённого хоста — прогон failed, ни одного запроса', async () => {
    const fx = await site([
      { host: 'k1pend.polygon.example', status: 'pending' } as never,
    ]);
    const { runId } = await crawl.requestRun(full(fx));
    await tickUntilIdle(crawl);
    const run = (await crawl.getRun(fx.accountId, runId))!;
    expect(run.status).toBe('failed');
    expect(run.error).toBe('Нет подтверждённых хостов сайта');
    expect(run.skippedByReason).toEqual({ unverified_host: 1 });
    expect(net.hits).toEqual([]);
  });

  it('истёкшее подтверждение = не подтверждён (assist-crawl без льготы)', async () => {
    const fx = await site([{ host: H, status: 'expired' } as never]);
    const { runId } = await crawl.requestRun(full(fx));
    await tickUntilIdle(crawl);
    expect((await crawl.getRun(fx.accountId, runId))!.status).toBe('failed');
    expect(net.hits).toEqual([]);
  });

  it('бюджет тика кончился — budgetExhausted, прогон продолжает следующий тик', async () => {
    const fx = await site();
    const { runId } = await crawl.requestRun(full(fx));
    const r = await crawl.tick(1);
    expect(r.budgetExhausted).toBe(true);
    expect((await crawl.getRun(fx.accountId, runId))!.status).toBe('queued');
    await tickUntilIdle(crawl);
    expect((await crawl.getRun(fx.accountId, runId))!.status).toBe('done');
  });

  it('больше одного батча: done только после ВСЕХ страниц очереди', async () => {
    const fx = await site([{ host: BIG }]);
    const { runId } = await crawl.requestRun(full(fx));
    await tickUntilIdle(crawl);
    const run = (await crawl.getRun(fx.accountId, runId))!;
    expect(run.status).toBe('done');
    expect(run.pagesChanged).toBe(31);
    expect(
      await prisma.sitePage.count({
        where: { siteId: fx.siteId, status: 'ok' },
      }),
    ).toBe(31);
  });

  it('lease строки очереди: страница «в работе» не берётся вторым тиком, даже если lease прогона истёк', async () => {
    const fx = await site([{ host: SLOW }]);
    const { runId } = await crawl.requestRun(full(fx));
    const first = crawl.tick(60_000);
    // Ждём, пока первый тик возьмёт /slow и начнёт её качать.
    for (let i = 0; i < 100 && !net.hits.includes(`${SLOW}/slow`); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(net.hits).toContain(`${SLOW}/slow`);
    // Lease прогона «истёк» (упавший инстанс) — второй тик забирает прогон.
    await prisma.siteCrawlRun.update({
      where: { id: runId },
      data: { lockedUntil: new Date(Date.now() - 1000) },
    });
    const other = crawlStack(prisma, net, accounts).crawl;
    await other.tick(60_000);
    await first;
    await tickUntilIdle(crawl);
    expect(net.hits.filter((h) => h === `${SLOW}/slow`)).toHaveLength(1);
    expect((await crawl.getRun(fx.accountId, runId))!.status).toBe('done');
  });

  it('retention очереди: строки завершённого старого прогона удаляются, активного и свежего — нет', async () => {
    const fx = await site();
    const mk = async (status: string, finishedAt: Date | null) => {
      const run = await prisma.siteCrawlRun.create({
        data: {
          accountId: fx.accountId,
          siteId: fx.siteId,
          product: 'assist',
          trigger: 'manual',
          status,
          maxPages: 5,
          finishedAt,
        },
      });
      await prisma.siteCrawlQueueItem.create({
        data: {
          accountId: fx.accountId,
          runId: run.id,
          siteId: fx.siteId,
          hostId: fx.hosts[H],
          url: `https://${H}/r-${run.id}`,
          status: 'done',
        },
      });
      return run.id;
    };
    const old = new Date(Date.now() - 10 * 86_400_000);
    const oldDone = await mk('done', old);
    const oldFailed = await mk('failed', old);
    const fresh = await mk('done', new Date());
    // Активный со старым finishedAt (перезапущенный) — всё равно не трогается.
    const active = await mk('running', old);
    const cutoff = new Date(Date.now() - 7 * 86_400_000);
    expect(await crawl.purgeFinishedQueue(cutoff)).toBeGreaterThanOrEqual(2);
    const left = async (runId: string) =>
      prisma.siteCrawlQueueItem.count({ where: { runId } });
    expect(await left(oldDone)).toBe(0);
    expect(await left(oldFailed)).toBe(0);
    expect(await left(fresh)).toBe(1);
    expect(await left(active)).toBe(1);
    // Сам прогон (со сводкой stats) остаётся.
    expect(await prisma.siteCrawlRun.count({ where: { id: oldDone } })).toBe(1);
    await prisma.siteCrawlRun.update({
      where: { id: active },
      data: { status: 'cancelled' },
    });
  });

  it('latestRun/getRun — только свой кабинет', async () => {
    const fx = await site();
    const other = await site();
    const { runId } = await crawl.requestRun(full(fx));
    await prisma.siteCrawlRun.update({
      where: { id: runId },
      data: { status: 'cancelled' },
    });
    expect(await crawl.getRun(other.accountId, runId)).toBeNull();
    expect((await crawl.latestRun(fx.accountId, fx.siteId, 'assist'))!.id).toBe(
      runId,
    );
    expect(await crawl.latestRun(fx.accountId, fx.siteId, 'qa')).toBeNull();
  });
});
