/**
 * Э6 (§4.12): обход пишет карту интерфейса страниц в `site_ui_maps`
 * (источник `crawl`) — реальный Postgres и локальный https-стенд. Смена
 * вёрстки — новая карта и счётчик промахов «карта устарела» с нуля;
 * страница без элементов — карта обхода снята.
 */
import type { PrismaService } from '../../prisma/prisma.service';
import { uiElementId } from '../site-core/ui-map/ui-map';
import {
  createSite,
  describeDb,
  dropAccounts,
  dropRobots,
  testPrisma,
} from './testing/crawl-db.testing';
import { crawlStack, tickUntilIdle } from './testing/crawl-stack.testing';
import { LocalSites } from './testing/local-sites.testing';

// Пять прогонов обхода подряд — под нагрузкой полного прогона дольше 5 с.
jest.setTimeout(60_000);

const H = 'e6map.polygon.example';

describeDb('обход → карта интерфейса (реальный Postgres)', () => {
  const net = new LocalSites();
  let prisma: PrismaService;
  const accounts: string[] = [];
  let layout: 'v1' | 'v2' | 'empty' = 'v1';

  const page = (body: string) =>
    net.html(
      `<html lang="uk"><body><main><h1>Тарифи</h1><p>Текст сторінки тарифів.</p>${body}</main></body></html>`,
    );

  beforeAll(async () => {
    await net.start();
    prisma = testPrisma();
    net.site(H, {
      '/robots.txt': { status: 404 },
      '/sitemap.xml': { status: 404 },
      '/': () =>
        page(
          layout === 'v1'
            ? `<button id="buy">Купити</button><a href="/pricing">Ціни</a><a href="https://other.example/x">Чужа</a>`
            : layout === 'v2'
              ? `<button id="order-now">Замовити</button><a href="/pricing">Ціни</a>`
              : '',
        ),
      '/pricing': () => page('<p>без кнопок</p>'),
    });
  });
  afterAll(async () => {
    await dropAccounts(prisma, accounts);
    await dropRobots(prisma, [`https://${H}`]);
    await prisma.$disconnect();
    await net.stop();
  });

  it('карта страницы — селекторы как у обучалки; смена вёрстки сбрасывает «карта устарела»; без элементов — снята', async () => {
    const fx = await createSite(prisma, [{ host: H }]);
    accounts.push(fx.accountId);
    const { crawl } = crawlStack(prisma, net, accounts);
    const run = () =>
      crawl.requestRun({
        accountId: fx.accountId,
        siteId: fx.siteId,
        product: 'assist',
        trigger: 'manual',
        mode: 'full',
        maxPages: 10,
      });
    const maps = () =>
      prisma.siteUiMap.findMany({
        where: { siteId: fx.siteId },
        orderBy: { path: 'asc' },
      });

    await run();
    await tickUntilIdle(crawl);
    let m = await maps();
    // `/pricing` без интерактивных элементов — карты нет.
    expect(m.map((x) => [x.host, x.path, x.source])).toEqual([
      [H, '/', 'crawl'],
    ]);
    expect(m[0].elements).toEqual([
      {
        id: uiElementId('#buy'),
        selector: '#buy',
        tag: 'button',
        label: 'Купити',
      },
      {
        id: uiElementId('main:nth-of-type(1) > a:nth-of-type(1)'),
        selector: 'main:nth-of-type(1) > a:nth-of-type(1)',
        tag: 'a',
        label: 'Ціни',
      },
    ]);
    expect(m[0].hostId).toBe(fx.hosts[H]);
    await prisma.siteUiMap.update({
      where: { id: m[0].id },
      data: { staleSignals: 3, lastStaleAt: new Date() },
    });

    // Тот же набор — счётчик промахов сохраняется.
    await run();
    await tickUntilIdle(crawl);
    m = await maps();
    expect(m[0].staleSignals).toBe(3);

    layout = 'v2';
    await run();
    await tickUntilIdle(crawl);
    m = await maps();
    expect((m[0].elements as Array<{ selector: string }>)[0].selector).toBe(
      '#order-now',
    );
    expect(m[0].staleSignals).toBe(0);
    expect(m[0].lastStaleAt).toBeNull();

    layout = 'empty';
    await run();
    await tickUntilIdle(crawl);
    expect(await maps()).toEqual([]);
  });
});
