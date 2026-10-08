/**
 * Заход 10, пакет Д — обход на реальном Postgres и локальном https-стенде:
 *
 *  - `excludeHosts` (Р-З10-10): исключённый хост не получает НИ ОДНОГО
 *    запроса (ни robots, ни sitemap, ни страниц), ссылки на него —
 *    `skipped/excluded`; хост «Админки» у прогона `assist` исключается
 *    сам (Р-З9-24), у `qa` — нет;
 *  - рендер SPA (Ш3 (20), Р-З10-20) через порт браузерного воркера:
 *    оболочка SPA ждёт рендера, итог разбирает тот же `extractPage`
 *    (страница `ok`, ссылки отрисованного меню идут в обход, пачки ≤ 4
 *    страниц одного хоста), прежний текст страницы до итога не трогается,
 *    `done` — после итогов; отказ (лимит, выключен), сбой и «не дождались» —
 *    прежний `skipped/spa`; без порта и у `qa` — как раньше.
 */
import type { PrismaService } from '../../prisma/prisma.service';
import { markAdminHosts } from '../site-core/testing/admin-hosts.testing';
import {
  RENDER_FRESH_MS,
  RENDER_STALE_MS,
  RENDER_WAIT_MS,
  SiteCrawlService,
} from './crawl.service';
import {
  createSite,
  describeDb,
  dropAccounts,
  dropRobots,
  testPrisma,
} from './testing/crawl-db.testing';
import { crawlStack, tickUntilIdle } from './testing/crawl-stack.testing';
import { LocalSites } from './testing/local-sites.testing';
import type {
  SpaRenderPoll,
  SpaRenderPort,
  SpaRenderRequest,
  SpaRenderTicket,
} from './types';

const MAIN = 'z10d-main.polygon.example';
const EXT = 'z10d-ext.polygon.example';
const ADM = 'z10d-adm.polygon.example';
const SPA = 'z10d-spa.polygon.example';
const ORIGINS = [MAIN, EXT, ADM, SPA].map((h) => `https://${h}`);

const SHELL = `<!doctype html><html><head><title>SPA</title>
<script src="/static/app.js" defer></script></head>
<body><div id="root"></div></body></html>`;

/** Что «нарисовал» браузер: тот же HTML, что даёт воркер (`page/render.ts`). */
function rendered(path: string): string {
  const body =
    path === '/about'
      ? '<h1>Про нас</h1><p>Працюємо з 2010 року, офіс у Києві, вул. Хрещатик, 1. Відповідаємо щодня з 9 до 21.</p>'
      : '<h1>Доставка SPA</h1><h2>Новою поштою</h2><p>Доставляємо за 1–2 дні по всій Україні, безкоштовно від 1000 грн. Оплата карткою або післяплатою.</p><div class="reviews"><p>Чудово!</p></div>';
  return `<!doctype html><html lang="uk"><head><title>SPA ${path}</title></head><body><main>${body}</main></body></html>`;
}

class FakeRenderPort implements SpaRenderPort {
  mode: 'done' | 'waiting' | 'failed' | 'limit' | 'busy' | 'broken' = 'done';
  readonly requests: SpaRenderRequest[] = [];
  readonly cancelled: string[] = [];
  readonly released: string[] = [];
  /** Воркер взял задание (идёт) — для «ожидания». */
  claimed = true;
  /** Свежий heartbeat очереди. */
  alive = true;
  private readonly jobs = new Map<string, string[]>();

  async request(r: SpaRenderRequest): Promise<SpaRenderTicket> {
    if (this.mode === 'limit') return { refused: 'limit' };
    if (this.mode === 'busy') return { retry: true };
    this.requests.push(r);
    const id = `rj${this.requests.length}-${Math.random().toString(36).slice(2, 8)}`;
    this.jobs.set(id, r.urls);
    return { jobId: id };
  }

  async poll(_a: string, id: string): Promise<SpaRenderPoll> {
    if (this.mode === 'waiting')
      return { status: 'waiting', claimed: this.claimed };
    if (this.mode === 'failed') return { status: 'failed' };
    const urls = this.jobs.get(id) ?? [];
    return {
      status: 'done',
      pages: urls.map((url, i) => {
        const path = new URL(url).pathname;
        if (this.mode === 'broken')
          return { i, ok: false, html: null, links: [] };
        return {
          i,
          ok: true,
          html: rendered(path),
          links:
            path === '/'
              ? [`https://${SPA}/about`, `https://${EXT}/x`]
              : [`https://${SPA}/`],
        };
      }),
    };
  }

  async cancel(_a: string, id: string): Promise<void> {
    this.cancelled.push(id);
  }

  async release(_a: string, id: string): Promise<void> {
    this.released.push(id);
  }

  async workerAlive(): Promise<boolean> {
    return this.alive;
  }
}

describeDb('обход: excludeHosts и рендер SPA (заход 10)', () => {
  const net = new LocalSites();
  let prisma: PrismaService;
  let crawl: SiteCrawlService;
  const accounts: string[] = [];

  const page = (title: string, links: string[] = []) =>
    net.html(
      `<html lang="uk"><body><main><h1>${title}</h1><p>Текст сторінки ${title} — достатньо довгий опис.</p>${links
        .map((l) => `<a href="${l}">${l}</a>`)
        .join('')}</main></body></html>`,
    );

  beforeAll(async () => {
    await net.start();
    prisma = testPrisma();
    await dropRobots(prisma, ORIGINS);
    crawl = crawlStack(prisma, net, accounts).crawl;
    net.site(MAIN, {
      '/robots.txt': { status: 404 },
      '/sitemap.xml': { status: 404 },
      '/': () =>
        page('Головна', ['/a', `https://${EXT}/p`, `https://${ADM}/admin/`]),
      '/a': () => page('A'),
    });
    for (const h of [EXT, ADM]) {
      net.site(h, {
        '/robots.txt': { status: 404 },
        '/sitemap.xml': { status: 404 },
        '/': () => page(`Головна ${h}`, ['/p']),
        '/p': () => page(`P ${h}`),
        '/admin/': () => page(`Адмінка ${h}`),
      });
    }
    net.site(SPA, {
      '/robots.txt': { status: 404 },
      '/sitemap.xml': { status: 404 },
      '/': () => net.html(SHELL),
      '/about': () => net.html(SHELL),
    });
  });

  afterAll(async () => {
    await dropAccounts(prisma, accounts);
    await dropRobots(prisma, ORIGINS);
    await prisma.$disconnect();
    await net.stop();
  });

  beforeEach(() => {
    net.hits.length = 0;
    crawl.spaRender = null;
  });

  async function site(hosts: string[]) {
    const fx = await createSite(
      prisma,
      hosts.map((host) => ({ host })),
    );
    accounts.push(fx.accountId);
    return fx;
  }

  const full = (
    fx: { accountId: string; siteId: string },
    extra: Record<string, unknown> = {},
  ) => ({
    accountId: fx.accountId,
    siteId: fx.siteId,
    product: 'assist' as const,
    trigger: 'manual' as const,
    mode: 'full' as const,
    maxPages: 50,
    ...extra,
  });

  const hitsOf = (host: string) => net.hits.filter((h) => h.startsWith(host));

  // ── excludeHosts ─────────────────────────────────────────────────────

  it('excludeHosts: исключённый хост — ни robots, ни sitemap, ни страниц; ссылки на него — skipped/excluded', async () => {
    const fx = await site([MAIN, EXT]);
    const { runId } = await crawl.requestRun(
      full(fx, { excludeHosts: [`${EXT.toUpperCase()}.`] }),
    );
    await tickUntilIdle(crawl);
    const run = (await crawl.getRun(fx.accountId, runId))!;
    expect(run.status).toBe('done');
    expect(hitsOf(EXT)).toEqual([]);
    expect(hitsOf(MAIN).length).toBeGreaterThan(0);
    const extRow = await prisma.siteCrawlQueueItem.findFirst({
      where: { runId, url: `https://${EXT}/p` },
    });
    expect(extRow).toMatchObject({ status: 'skipped', lastError: 'excluded' });
    const stats = (
      await prisma.siteCrawlRun.findUniqueOrThrow({ where: { id: runId } })
    ).stats as { excludedHosts?: string[]; unverifiedHosts?: string[] };
    expect(stats.excludedHosts).toEqual([EXT]);
    expect(stats.unverifiedHosts ?? []).not.toContain(EXT);
    expect(
      await prisma.sitePage.count({
        where: { siteId: fx.siteId, url: { startsWith: `https://${EXT}` } },
      }),
    ).toBe(0);
  });

  it('хост «Админки» у прогона assist исключается сам (Р-З9-24): к нему ни одного запроса; у qa — обходится', async () => {
    const fx = await site([MAIN, ADM]);
    await markAdminHosts(prisma, fx, [fx.hosts[ADM]]);
    expect(
      (
        await prisma.siteHost.findUniqueOrThrow({
          where: { id: fx.hosts[ADM] },
        })
      ).assistRole,
    ).toBe('admin');
    const { runId } = await crawl.requestRun(full(fx));
    await tickUntilIdle(crawl);
    expect((await crawl.getRun(fx.accountId, runId))!.status).toBe('done');
    // Ни robots, ни sitemap, ни главной, ни ссылки со страницы «Сайта».
    expect(hitsOf(ADM)).toEqual([]);
    expect(
      await prisma.siteCrawlQueueItem.findFirst({
        where: { runId, url: `https://${ADM}/admin/` },
      }),
    ).toMatchObject({ status: 'skipped', lastError: 'excluded' });
    // QA — общий обход, роль хоста помощника его не касается.
    net.hits.length = 0;
    const qa = await crawl.requestRun(full(fx, { product: 'qa' }));
    await tickUntilIdle(crawl);
    expect((await crawl.getRun(fx.accountId, qa.runId))!.status).toBe('done');
    expect(hitsOf(ADM).length).toBeGreaterThan(0);
  });

  it('исключение — по строке хоста (https:443), не по имени: admin-роль у http://того же имени не выключает https', async () => {
    const fx = await site([MAIN]);
    const httpRow = await prisma.siteHost.create({
      data: {
        accountId: fx.accountId,
        siteId: fx.siteId,
        host: MAIN,
        scheme: 'http',
        port: 80,
        status: 'verified',
        method: 'dns',
        verifiedAt: new Date(Date.now() - 1000),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await markAdminHosts(prisma, fx, [httpRow.id]);
    const { runId } = await crawl.requestRun(full(fx));
    await tickUntilIdle(crawl);
    const run = (await crawl.getRun(fx.accountId, runId))!;
    expect(run.status).toBe('done');
    expect(run.pagesChanged).toBeGreaterThan(0);
    expect(hitsOf(MAIN).length).toBeGreaterThan(0);
  });

  // ── рендер SPA ───────────────────────────────────────────────────────

  async function spaRun(port: FakeRenderPort | null, product = 'assist') {
    const fx = await site([SPA, EXT]);
    crawl.spaRender = port;
    const { runId } = await crawl.requestRun(
      full(fx, { product, excludeHosts: [EXT] }),
    );
    await tickUntilIdle(crawl);
    const run = (await crawl.getRun(fx.accountId, runId))!;
    const pages = await prisma.sitePage.findMany({
      where: { siteId: fx.siteId },
      orderBy: { url: 'asc' },
    });
    return { fx, runId, run, pages };
  }

  it('SPA: оболочка → рендер воркером → тот же извлекатель; меню SPA ведёт обход дальше; done — после итогов', async () => {
    const port = new FakeRenderPort();
    const { runId, run, pages } = await spaRun(port);
    expect(run.status).toBe('done');
    const home = pages.find((p) => p.url === `https://${SPA}/`)!;
    expect(home).toMatchObject({ status: 'ok', skipReason: null });
    expect(home.text).toContain('Доставляємо за 1–2 дні');
    expect(home.lang).toBe('uk');
    // Блоки — как у обычного обхода: путь заголовков и UGC.
    const blocks = home.blocks as Array<{
      t: string;
      text: string;
      path: string[];
      ugc?: boolean;
    }>;
    expect(blocks.find((b) => b.text.startsWith('Доставляємо'))!.path).toEqual([
      'Доставка SPA',
      'Новою поштою',
    ]);
    expect(blocks.find((b) => b.text === 'Чудово!')!.ugc).toBe(true);
    // Ссылка отрисованного меню → вторая страница, тоже отрисована.
    const about = pages.find((p) => p.url === `https://${SPA}/about`)!;
    expect(about).toMatchObject({ status: 'ok' });
    expect(about.text).toContain('Працюємо з 2010 року');
    // Чужая ссылка из меню (исключённый хост) — не тронута.
    expect(hitsOf(EXT)).toEqual([]);
    // Пачки — по хосту, ≤ 4 страниц; адреса — только хоста SPA.
    expect(port.requests.length).toBe(2);
    for (const r of port.requests) {
      expect(r.host).toBe(SPA);
      expect(r.urls.length).toBeLessThanOrEqual(4);
      expect(r.runId).toBe(runId);
    }
    const stats = (
      await prisma.siteCrawlRun.findUniqueOrThrow({ where: { id: runId } })
    ).stats as { render: { requested: number; rendered: number; jobs: [] } };
    expect(stats.render).toMatchObject({
      requested: 2,
      rendered: 2,
      jobs: [],
    });
    expect(run.pagesChanged).toBe(2);
    expect(run.skippedByReason.spa ?? 0).toBe(0);
    // HTML разобран — результат задания в очереди стёрт (аудит P3 (6)).
    expect(port.released.sort()).toEqual(
      port.requests.map((_, i) => expect.stringMatching(`^rj${i + 1}-`)),
    );
  });

  /** Страницы сайта «отрисованы давно» (старше RENDER_FRESH_MS). */
  const age = (siteId: string) =>
    prisma.sitePage.updateMany({
      where: { siteId },
      data: { fetchedAt: new Date(Date.now() - RENDER_FRESH_MS - 60_000) },
    });

  it('SPA: недавно отрисованная страница не рендерится снова (лимит воркера — на новые)', async () => {
    const port = new FakeRenderPort();
    const { fx } = await spaRun(port);
    const before = port.requests.length;
    const { runId } = await crawl.requestRun(full(fx));
    await tickUntilIdle(crawl);
    expect((await crawl.getRun(fx.accountId, runId))!.status).toBe('done');
    expect(port.requests.length).toBe(before);
    const home = await prisma.sitePage.findFirstOrThrow({
      where: { siteId: fx.siteId, url: `https://${SPA}/` },
    });
    expect(home).toMatchObject({ status: 'ok' });
    // Старше срока — рендерится снова.
    await age(fx.siteId);
    await crawl.requestRun(full(fx));
    await tickUntilIdle(crawl);
    expect(port.requests.length).toBeGreaterThan(before);
  });

  it('SPA: пока рендер не готов — прогон не done, прежний текст цел; не дождались — отмена, страница failed С ПРЕЖНИМ текстом (аудит P2-1)', async () => {
    const port = new FakeRenderPort();
    const { fx, pages } = await spaRun(port);
    expect(pages.find((p) => p.url === `https://${SPA}/`)!.status).toBe('ok');
    await age(fx.siteId);
    port.mode = 'waiting';
    const { runId } = await crawl.requestRun(full(fx));
    await tickUntilIdle(crawl, 5).catch(() => undefined);
    // Ждёт воркера: не done, страница — с прежним текстом.
    expect((await crawl.getRun(fx.accountId, runId))!.status).toBe('running');
    const kept = await prisma.sitePage.findFirstOrThrow({
      where: { siteId: fx.siteId, url: `https://${SPA}/` },
    });
    expect(kept).toMatchObject({ status: 'ok' });
    expect(kept.text).toContain('Доставляємо');
    // Срок ожидания вышел — задание отменено, страница как раньше: spa.
    const row = await prisma.siteCrawlRun.findUniqueOrThrow({
      where: { id: runId },
    });
    const stats = row.stats as { render: { jobs: Array<{ at: string }> } };
    for (const j of stats.render.jobs)
      j.at = new Date(Date.now() - RENDER_WAIT_MS - 60_000).toISOString();
    await prisma.siteCrawlRun.update({
      where: { id: runId },
      data: { stats: stats as object },
    });
    await tickUntilIdle(crawl);
    expect((await crawl.getRun(fx.accountId, runId))!.status).toBe('done');
    expect(port.cancelled.length).toBeGreaterThan(0);
    const after = await prisma.sitePage.findFirstOrThrow({
      where: { siteId: fx.siteId, url: `https://${SPA}/` },
    });
    // Сбой рендера знания не стирает: как 5xx — failed с прежним текстом.
    expect(after).toMatchObject({ status: 'failed', skipReason: 'spa' });
    expect(after.text).toContain('Доставляємо');
    expect(after.contentHash).toBe(kept.contentHash);
  });

  it('SPA: задание никто не взял, а воркер молчит дольше RENDER_STALE_MS — не ждём 2 ч', async () => {
    const port = new FakeRenderPort();
    port.mode = 'waiting';
    port.claimed = false;
    const fx = await site([SPA]);
    crawl.spaRender = port;
    const { runId } = await crawl.requestRun(full(fx));
    await tickUntilIdle(crawl, 3).catch(() => undefined);
    // Свежее задание — ждём, даже без heartbeat.
    port.alive = false;
    await tickUntilIdle(crawl, 2).catch(() => undefined);
    expect((await crawl.getRun(fx.accountId, runId))!.status).toBe('running');
    const row = await prisma.siteCrawlRun.findUniqueOrThrow({
      where: { id: runId },
    });
    const stats = row.stats as { render: { jobs: Array<{ at: string }> } };
    for (const j of stats.render.jobs)
      j.at = new Date(Date.now() - RENDER_STALE_MS - 60_000).toISOString();
    await prisma.siteCrawlRun.update({
      where: { id: runId },
      data: { stats: stats as object },
    });
    // Воркер жив (heartbeat есть) — ждём дальше.
    port.alive = true;
    await tickUntilIdle(crawl, 2).catch(() => undefined);
    expect((await crawl.getRun(fx.accountId, runId))!.status).toBe('running');
    port.alive = false;
    await tickUntilIdle(crawl);
    expect((await crawl.getRun(fx.accountId, runId))!.status).toBe('done');
    expect(port.cancelled.length).toBeGreaterThan(0);
    expect(
      await prisma.sitePage.findFirstOrThrow({
        where: { siteId: fx.siteId, url: `https://${SPA}/` },
      }),
    ).toMatchObject({ status: 'skipped', skipReason: 'spa', text: null });
  });

  it.each([
    ['limit', 'суточный лимит (отказ постановки)'],
    ['failed', 'задание не выполнено'],
    ['broken', 'страница не отрисовалась'],
  ] as const)(
    'SPA: %s (%s) — прежний skipped/spa, прогон done',
    async (mode, _why) => {
      const port = new FakeRenderPort();
      port.mode = mode;
      const { run, pages } = await spaRun(port);
      expect(run.status).toBe('done');
      const home = pages.find((p) => p.url === `https://${SPA}/`)!;
      expect(home).toMatchObject({ status: 'skipped', skipReason: 'spa' });
      expect(run.skippedByReason.spa).toBeGreaterThanOrEqual(1);
    },
  );

  it('SPA: очередь сайта занята — ждём (не done), дольше RENDER_WAIT_MS — прежний skipped/spa', async () => {
    const port = new FakeRenderPort();
    port.mode = 'busy';
    const fx = await site([SPA]);
    crawl.spaRender = port;
    const { runId } = await crawl.requestRun(full(fx));
    await tickUntilIdle(crawl, 3).catch(() => undefined);
    expect((await crawl.getRun(fx.accountId, runId))!.status).toBe('running');
    const row = await prisma.siteCrawlRun.findUniqueOrThrow({
      where: { id: runId },
    });
    const stats = row.stats as { render: { busySince?: string } };
    expect(stats.render.busySince).toBeDefined();
    stats.render.busySince = new Date(
      Date.now() - RENDER_WAIT_MS - 60_000,
    ).toISOString();
    await prisma.siteCrawlRun.update({
      where: { id: runId },
      data: { stats: stats as object },
    });
    await tickUntilIdle(crawl);
    const run = (await crawl.getRun(fx.accountId, runId))!;
    expect(run.status).toBe('done');
    expect(run.skippedByReason.spa).toBeGreaterThanOrEqual(1);
    expect(port.requests).toHaveLength(0);
  });

  it('SPA: без порта воркера и у прогона qa — как раньше (skipped/spa, рендер не просится)', async () => {
    const none = await spaRun(null);
    expect(none.run.status).toBe('done');
    expect(none.pages.find((p) => p.url === `https://${SPA}/`)).toMatchObject({
      status: 'skipped',
      skipReason: 'spa',
    });
    const port = new FakeRenderPort();
    const qa = await spaRun(port, 'qa');
    expect(qa.run.status).toBe('done');
    expect(port.requests).toHaveLength(0);
    expect(qa.pages.find((p) => p.url === `https://${SPA}/`)).toMatchObject({
      status: 'skipped',
      skipReason: 'spa',
    });
  });
});
