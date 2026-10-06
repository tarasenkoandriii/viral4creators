/**
 * e2e воркера Ш3 на НАСТОЯЩЕМ Chromium (Playwright) и настоящем
 * фильтрующем прокси: стенд «сайта заказчика» (https на 127.0.0.1),
 * «интернет» (вышестоящий CONNECT) и фейковый sites-backend с той же
 * подписью и тем же разбором результата.
 *
 *  1. «Снимок»: элементы с рамками, маска ПД, скриншот-артефакт, карта Ш4;
 *     чистый контекст — cookie первого задания второму не достаются;
 *  2. приватный IP (имя → 10.x) — отказ `egress_blocked`, стенд не тронут;
 *  3. редирект на 169.254.169.254 — отказ, наружу запрос не ушёл;
 *     подресурсы на служебные адреса — заблокированы, задание завершено;
 *  4. обход «Админки» за логином по фейковой аренде (конверт под ключ
 *     воркера): вход Enter-ом, ссылки своего хоста, «Меню» раскрыто,
 *     «Видалити» — отказ (стенд не получил ни одного запроса удаления),
 *     ссылки «вийти» и «/delete» не открыты, пароль — ни в журнале, ни в
 *     результате, учётка запрошена один раз, ячейки таблиц не в тексте;
 *  5. сверка дескрипторов (Т-3): число совпадений CSS, без кликов;
 *  6. кадры: 3 кадра сверху вниз, JPEG;
 *  7. остановка посреди задания — `shutdown`.
 *
 * Браузер: BROWSER_WORKER_CHROMIUM_PATH, иначе /opt/pw-browsers/chromium,
 * иначе браузер Playwright (PLAYWRIGHT_BROWSERS_PATH). Нет браузера —
 * пропуск (в CI=true — провал: e2e обязан идти).
 */
import { existsSync } from 'fs';
import { createApiClient } from '../../src/api-client';
import { BrowserPool } from '../../src/browser/pool';
import { createLogger, liveSecretCount } from '../../src/logger';
import { Runner } from '../../src/runner';
import { generateWorkerSealKeys } from '../../src/shared/worker-seal';
import { FakeSites } from '../helpers/fake-sites';
import { FakeInternet, PUBLIC_TEST_IP, Stand } from '../helpers/stand';

const SECRET = 'w'.repeat(48);
const SHOP = 'shop.sh3.test';
const ADMIN = 'admin.sh3.test';
const EVIL = 'evil.sh3.test';
const SELF = 'self.sh3.test';
/** «Публичный адрес самого сервера» — в BROWSER_WORKER_EGRESS_DENY. */
const SELF_IP = '93.184.216.35';

function chromiumPath(): string | null {
  const env = process.env.BROWSER_WORKER_CHROMIUM_PATH;
  if (env && existsSync(env)) return env;
  if (existsSync('/opt/pw-browsers/chromium'))
    return '/opt/pw-browsers/chromium';
  return null;
}

const HAVE_BROWSER =
  chromiumPath() !== null || !!process.env.PLAYWRIGHT_BROWSERS_PATH;
const d = HAVE_BROWSER ? describe : describe.skip;
if (!HAVE_BROWSER && process.env.CI === 'true') {
  throw new Error('CI=true, но Chromium для e2e воркера не найден');
}

const PASSWORD = ['Pw', 'Sh3', 'marker', '9f2c'].join('-');

const SHOP_HOME = `<!doctype html><html><head><title>Магазин Ш3</title></head><body>
<header><nav><a href="/catalog">Каталог</a><a href="/delivery">Доставка</a></nav></header>
<main><h1>Головна</h1>
<p>Пишіть нам: ivan.petrenko@example.com</p>
<button data-assist-id="buy" id="buy-btn">Купити</button>
<button>Зв'язатися: +380 50 123 45 67</button>
<input type="password" name="pw" placeholder="Пароль">
<form><input name="email" placeholder="Ваш e-mail"><button type="submit">Надіслати заявку</button></form>
<div class="reviews"><button>Відгук користувача</button></div>
<img src="http://169.254.169.254/latest/meta-data/x.png">
<script>fetch('http://10.0.0.1/admin').catch(()=>{});document.cookie='seen=1; path=/';</script>
<div style="height:3000px"></div></main></body></html>`;

const LOGIN = `<!doctype html><html><head><title>Вхід</title></head><body>
<form method="post" action="/login"><label>Логін <input name="login" type="text"></label>
<label>Пароль <input name="password" type="password"></label><button type="submit">Увійти</button></form></body></html>`;

const DASHBOARD = `<!doctype html><html><head><title>Адмінка</title></head><body>
<nav><a href="/admin/orders">Замовлення</a><a href="/admin/settings">Налаштування</a>
<a href="/logout">Вийти</a><a href="/admin/orders/5/delete">Прибрати замовлення 5</a>
<a href="https://other.example/">Зовнішній</a></nav>
<button aria-expanded="false" onclick="document.getElementById('more').hidden=false;this.setAttribute('aria-expanded','true')">Меню</button>
<div id="more" hidden><a href="/admin/reports">Звіти</a></div>
<button aria-expanded="false" onclick="fetch('/hit/delete',{method:'POST'})">Видалити</button>
<a href="/admin/orders/7/delete" aria-expanded="false">Ще</a>
<a href="/logout" role="tab" aria-selected="false">Профіль</a>
<a href="#" aria-expanded="false" onclick="this.setAttribute('aria-expanded','true')">Довідка</a>
<h1>Панель керування</h1>
<table><thead><tr><th>Клієнт</th><th>Сума</th></tr></thead>
<tbody><tr><td>Іван Петренко</td><td>1200 грн</td></tr></tbody></table>
</body></html>`;

d('browser-worker e2e (настоящий Chromium)', () => {
  const stand = new Stand();
  const internet = new FakeInternet(stand);
  const sites = new FakeSites(SECRET);
  const lines: string[] = [];
  let pool: BrowserPool;
  let runner: Runner;
  const keys = generateWorkerSealKeys();
  let sessions = 0;
  const echoed: string[] = [];
  const sessionCookies: string[] = [];

  beforeAll(async () => {
    await stand.start();
    await internet.start();
    await sites.start();
    sites.sealPublicKey = keys.publicKey;
    stand
      .page(SHOP, '/', SHOP_HOME)
      .page(
        SHOP,
        '/catalog',
        '<!doctype html><title>Каталог</title><h1>Каталог</h1><a data-assist-id="buy" href="/p/1">Товар</a>',
      )
      .page(
        SHOP,
        '/second',
        '<!doctype html><title>Другий</title><script>fetch("/echo-cookie")</script><h1>Друга</h1>',
      )
      .on(SHOP, '/echo-cookie', (q, res) => {
        echoed.push(String(q.headers.cookie ?? ''));
        res.writeHead(200);
        res.end(String(q.headers.cookie ?? ''));
      })
      .on(SHOP, '/redir', (_q, res) => {
        res.writeHead(302, {
          location: 'http://169.254.169.254/latest/meta-data/',
        });
        res.end();
      })
      .on(SHOP, '/set', (_q, res) => {
        res.writeHead(200, {
          'set-cookie': 'tenant=A; Path=/; Secure',
          'content-type': 'text/html',
        });
        res.end(
          '<!doctype html><title>set</title><h1>Cookie</h1><button>Ок</button>',
        );
      })
      .page(ADMIN, '/login', LOGIN)
      .on(ADMIN, '/login', (q, res, body) => {
        if (q.method === 'POST') {
          const p = new URLSearchParams(body);
          if (p.get('login') === 'manager' && p.get('password') === PASSWORD) {
            sessions += 1;
            res.writeHead(302, {
              location: '/admin',
              'set-cookie': 'sid=ok; Path=/; Secure; HttpOnly',
            });
          } else {
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end(LOGIN);
            return;
          }
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(LOGIN);
      });
    const authed =
      (html: string) =>
      (
        q: import('http').IncomingMessage,
        res: import('http').ServerResponse,
      ) => {
        sessionCookies.push(String(q.headers.cookie ?? ''));
        if (!String(q.headers.cookie ?? '').includes('sid=ok')) {
          res.writeHead(302, { location: '/login' });
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
      };
    stand
      .on(ADMIN, '/admin', authed(DASHBOARD))
      .on(
        ADMIN,
        '/admin/orders',
        authed(
          '<!doctype html><title>Замовлення</title><h1>Замовлення</h1><table><tr><th>№</th></tr><tr><td>Олена Коваль</td></tr></table>',
        ),
      )
      .on(
        ADMIN,
        '/admin/settings',
        authed(
          '<!doctype html><title>Налаштування</title><h1>Налаштування магазину</h1><label>Назва <input name="shop"></label>',
        ),
      )
      .on(
        ADMIN,
        '/admin/reports',
        authed('<!doctype html><title>Звіти</title><h1>Звіти</h1>'),
      );

    const dns = new Map<string, string[]>([
      [SHOP, [PUBLIC_TEST_IP]],
      [ADMIN, [PUBLIC_TEST_IP]],
      [EVIL, ['10.0.0.7']],
      [SELF, [SELF_IP]],
    ]);
    const logger = createLogger('debug', (l) => lines.push(l));
    pool = new BrowserPool({
      executablePath: chromiumPath(),
      sandbox: false,
      rotateJobs: 3,
      rotateMs: 60 * 60_000,
      logger,
    });
    runner = new Runner({
      api: createApiClient({
        baseUrl: sites.url,
        secret: SECRET,
        workerId: 'bw-e2e',
      }),
      pool,
      logger,
      kinds: [
        'ui-snapshot',
        'admin-crawl',
        'descriptor-resolve',
        'frames-capture',
      ],
      concurrency: 2,
      pollMs: 200,
      idlePollMaxMs: 400,
      shutdownGraceMs: 2_000,
      heartbeatMs: 1_000,
      sealPrivateKey: keys.privateKey,
      egress: {
        denyCidrs: [`${SELF_IP}/32`],
        allowedPorts: [80, 443],
        upstream: { protocol: 'http:', host: '127.0.0.1', port: internet.port },
        lookup: (h) => Promise.resolve(dns.get(h.toLowerCase()) ?? []),
        ignoreHttpsErrors: true,
      },
    });
    runner.start();
  });

  afterAll(async () => {
    await runner?.shutdown();
    await pool?.close();
    await sites.stop();
    await internet.stop();
    await stand.stop();
  });

  const snap = (url: string, extra: Record<string, unknown> = {}) => ({
    url,
    allowedHosts: [SHOP],
    viewport: 'mobile',
    screenshot: true,
    mapElements: true,
    ...extra,
  });

  it('«Снимок»: элементы с рамками, маска ПД, скриншот, карта Ш4; служебные подресурсы — блок', async () => {
    const j = await sites.waitDone(
      sites.add('ui-snapshot', snap(`https://${SHOP}/`)),
    );
    expect(j.error).toBeNull();
    const r = j.result as {
      snapshot: {
        elements: Array<{
          text: string;
          assistId: string | null;
          box: unknown;
          inputType: string | null;
        }>;
      };
      mapElements: Array<{ selector: string | null; assistId: string | null }>;
      screenshot: number;
      blockedRequests: number;
    };
    const texts = r.snapshot.elements.map((e) => e.text);
    expect(texts).toContain('Купити');
    expect(
      r.snapshot.elements.find((e) => e.assistId === 'buy')?.box,
    ).toMatchObject({ w: expect.any(Number) });
    // Маска ПД, поле пароля и отзывы — не в снимке.
    expect(JSON.stringify(r)).not.toMatch(/123 45 67|ivan\.petrenko/);
    expect(texts.join('|')).toContain('[тел.]');
    expect(r.snapshot.elements.some((e) => e.inputType === 'password')).toBe(
      false,
    );
    expect(texts).not.toContain('Відгук користувача');
    expect(r.mapElements.find((e) => e.assistId === 'buy')?.selector).toBe(
      '#buy-btn',
    );
    // Скриншот — JPEG.
    const shot = j.artifacts.get(r.screenshot)!;
    expect(shot.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(
      true,
    );
    // Подресурс на 169.254 и fetch на 10.x — заблокированы, наружу не ушли.
    expect(r.blockedRequests).toBeGreaterThanOrEqual(2);
    expect(internet.dials.some((x) => /^(169\.254|10\.)/.test(x))).toBe(false);
  });

  it('чистый контекст: cookie первого задания второму не достаются', async () => {
    const first = await sites.waitDone(
      sites.add('ui-snapshot', snap(`https://${SHOP}/set`)),
    );
    expect(first.error).toBeNull();
    await sites.waitDone(
      sites.add('ui-snapshot', snap(`https://${SHOP}/second`)),
    );
    // Второе задание дошло до стенда без cookie первого.
    expect(echoed.length).toBe(1);
    expect(echoed[0]).not.toContain('tenant=A');
  });

  it('страница не достаёт localhost: ни sites-backend, ни прокси воркера', async () => {
    const before = sites.calls.length;
    const getsBefore = sites.gets;
    stand.page(
      SHOP,
      '/loopback',
      `<!doctype html><title>lo</title><h1>lo</h1><img src="http://127.0.0.1:${sites.port}/internal/worker/v1/jobs/claim"><script>fetch('http://localhost:${sites.port}/x').catch(()=>{})</script>`,
    );
    const j = await sites.waitDone(
      sites.add('ui-snapshot', snap(`https://${SHOP}/loopback`)),
    );
    expect(j.error).toBeNull();
    expect(
      (j.result as { blockedRequests: number }).blockedRequests,
    ).toBeGreaterThanOrEqual(2);
    // До фейкового sites-backend дошли только подписанные запросы воркера.
    expect(sites.gets).toBe(getsBefore);
    expect(sites.calls.length).toBeGreaterThan(before);
  });

  it('приватный IP (имя → 10.x) — отказ egress_blocked, до стенда не дошло', async () => {
    const j = await sites.waitDone(
      sites.add('ui-snapshot', {
        ...snap(`https://${EVIL}/`),
        allowedHosts: [EVIL],
      }),
    );
    expect(j.status).toBe('failed');
    expect(j.error).toBe('egress_blocked');
    expect(stand.hit(EVIL)).toBe(false);
    expect(internet.dials.some((x) => x.startsWith('10.'))).toBe(false);
  });

  it('адрес самого сервера (BROWSER_WORKER_EGRESS_DENY) — отказ, наружу не ушло', async () => {
    const j = await sites.waitDone(
      sites.add('ui-snapshot', {
        ...snap(`https://${SELF}/`),
        allowedHosts: [SELF],
      }),
    );
    expect(j.error).toBe('egress_blocked');
    expect(internet.dials.some((x) => x.startsWith(SELF_IP))).toBe(false);
  });

  it('редирект на 169.254.169.254 — отказ, запрос наружу не ушёл', async () => {
    const j = await sites.waitDone(
      sites.add('ui-snapshot', snap(`https://${SHOP}/redir`)),
    );
    expect(j.status).toBe('failed');
    expect(['egress_blocked', 'offhost_redirect']).toContain(j.error);
    expect(internet.dials.some((x) => x.startsWith('169.254'))).toBe(false);
  });

  it('обход «Админки» за логином по аренде: вход, ссылки своего хоста, «Видалити» — отказ, пароль не утёк', async () => {
    sites.credentials = {
      username: 'manager',
      password: PASSWORD,
      sessionCookies: null,
    };
    const j = await sites.waitDone(
      sites.add('admin-crawl', {
        startUrl: `https://${ADMIN}/admin`,
        allowedHosts: [ADMIN],
        viewport: 'desktop',
        maxPages: 10,
        maxDepth: 2,
        loginMethod: 'password',
      }),
    );
    expect(j.error).toBeNull();
    // Раскрывашка-ссылка (aria-expanded/вкладка с href) — тот же стоп-лист,
    // что у ссылок: GET «/delete» и «/logout» кликом не открываются (аудит Ш3).
    expect(stand.hit('/admin/orders/7/delete')).toBe(false);
    expect(stand.hit('/logout')).toBe(false);
    const r = j.result as {
      loggedIn: boolean;
      pages: Array<{ url: string; text: string }>;
      refusedClicks: number;
      skippedLinks: number;
    };
    expect(r.loggedIn).toBe(true);
    expect(sessions).toBe(1);
    const urls = r.pages.map((p) => new URL(p.url).pathname);
    expect(urls).toEqual(
      expect.arrayContaining([
        '/admin',
        '/admin/orders',
        '/admin/settings',
        '/admin/reports',
      ]),
    );
    expect(urls.some((u) => /delete|logout/.test(u))).toBe(false);
    // Стоп-лист: «Видалити» не нажат, удаление и выход не запрошены.
    expect(r.refusedClicks).toBeGreaterThanOrEqual(1);
    expect(stand.hit('/hit/delete')).toBe(false);
    expect(stand.hit('/admin/orders/5/delete')).toBe(false);
    expect(stand.hit('/logout')).toBe(false);
    expect(stand.hit('other.example')).toBe(false);
    // Только знания об интерфейсе: шапки таблиц есть, ячейки — нет.
    const all = r.pages.map((p) => p.text).join('\n');
    expect(all).toContain('колонка: Клієнт');
    expect(all).not.toMatch(/Іван Петренко|Олена Коваль|1200 грн/);
    // Учётка — один раз; пароль — ни в журнале, ни в результате.
    expect(sites.calls.filter((c) => c.endsWith('/credentials')).length).toBe(
      1,
    );
    expect(JSON.stringify(j.result)).not.toContain(PASSWORD);
    expect(lines.join('\n')).not.toContain(PASSWORD);
  });

  it('вход готовой сессией (cookie Ш2): только cookie домена хоста, секреты затёрты', async () => {
    sessionCookies.length = 0;
    sites.credentials = {
      username: 'manager',
      password: '',
      sessionCookies: JSON.stringify([
        { name: 'sid', value: 'ok', domain: ADMIN, path: '/', secure: true },
        { name: 'sso', value: 'leak', domain: '.other.example', path: '/' },
      ]),
    };
    const j = await sites.waitDone(
      sites.add('admin-crawl', {
        startUrl: `https://${ADMIN}/admin`,
        allowedHosts: [ADMIN],
        viewport: 'desktop',
        maxPages: 1,
        maxDepth: 0,
        loginMethod: 'session',
      }),
    );
    expect(j.error).toBeNull();
    expect((j.result as { pages: unknown[] }).pages).toHaveLength(1);
    expect(sessionCookies.some((c) => c.includes('sid=ok'))).toBe(true);
    expect(sessionCookies.join(';')).not.toContain('leak');
    // Ни пароля, ни cookie учётки в памяти воркера после задания.
    expect(liveSecretCount()).toBe(0);
  });

  it('Т-3: сверка дескрипторов — только счёт совпадений, без кликов', async () => {
    const before = stand.hits.length;
    const j = await sites.waitDone(
      sites.add('descriptor-resolve', {
        pages: [`https://${SHOP}/`, `https://${SHOP}/catalog`],
        allowedHosts: [SHOP],
        viewport: 'desktop',
        targets: [
          { key: 'buy', selectors: ['[data-assist-id="buy"]'] },
          { key: 'ghost', selectors: ['#missing'] },
          { key: 'text-only', selectors: [] },
        ],
      }),
    );
    const r = j.result as {
      pages: Array<{ ok: boolean; counts: Record<string, number[]> }>;
    };
    expect(r.pages.map((p) => p.ok)).toEqual([true, true]);
    expect(r.pages[0].counts.buy).toEqual([1]);
    expect(r.pages[0].counts.ghost).toEqual([0]);
    expect(r.pages[1].counts.buy).toEqual([1]);
    // Без кликов: никаких POST и переходов по ссылкам стенда.
    expect(stand.hits.slice(before).some((h) => h.startsWith('POST'))).toBe(
      false,
    );
    expect(stand.hits.slice(before).some((h) => h.includes('/p/1'))).toBe(
      false,
    );
  });

  it('кадры: 3 JPEG сверху вниз', async () => {
    const j = await sites.waitDone(
      sites.add('frames-capture', {
        url: `https://${SHOP}/`,
        allowedHosts: [SHOP],
        viewport: 'mobile',
        frames: 3,
      }),
    );
    const r = j.result as {
      frames: Array<{ artifact: number; scrollY: number }>;
    };
    expect(r.frames.length).toBe(3);
    expect(r.frames[1].scrollY).toBeGreaterThan(r.frames[0].scrollY);
    for (const f of r.frames) {
      expect(
        j.artifacts
          .get(f.artifact)!
          .subarray(0, 2)
          .equals(Buffer.from([0xff, 0xd8])),
      ).toBe(true);
    }
  });

  it('heartbeat «отменить» обрывает идущее задание', async () => {
    stand.on(SHOP, '/slow', () => undefined); // ответа нет никогда
    const j = sites.add('ui-snapshot', snap(`https://${SHOP}/slow`));
    await new Promise((r) => setTimeout(r, 1500));
    j.cancel = true;
    await sites.waitDone(j, 20_000);
    expect(j.status).toBe('failed');
    expect(j.error).toBe('cancelled');
  });
});
