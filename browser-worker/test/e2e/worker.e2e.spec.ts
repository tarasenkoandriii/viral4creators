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
 *  7. остановка посреди задания — `shutdown`;
 *  8. потолок байтов (Ш3-хвост (9)): тяжёлый подресурс оборван, задание
 *     живо; огромный документ и суммарный трафик — `traffic_limit`;
 *  9. ПД «Админки» вне таблиц (Ш3-хвост (17)): карточки заказа/покупателя
 *     (Хорошоп-подобная и WooCommerce-разметка) — только структура, вторая
 *     карточка того же вида не открыта.
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
const MB = 1024 * 1024;

/** Тело `n` байт кусками (без Content-Length, если `chunked`). */
function sendBytes(
  res: import('http').ServerResponse,
  n: number,
  type: string,
  chunked = false,
  head = '',
): void {
  res.writeHead(200, {
    'content-type': type,
    ...(chunked ? {} : { 'content-length': String(head.length + n) }),
  });
  if (head) res.write(head);
  let left = n;
  const push = () => {
    while (left > 0 && !res.destroyed) {
      const k = Math.min(left, 64 * 1024);
      left -= k;
      if (!res.write(Buffer.alloc(k, 0x20))) {
        res.once('drain', push);
        return;
      }
    }
    if (!res.destroyed) res.end();
  };
  push();
}

// ── «Админка» с ПД вне таблиц (Ш3-хвост (17)) ─────────────────────────────
const HS_DASHBOARD = `<!doctype html><html><head><title>Головна | Хорошоп</title></head><body>
<aside class="sidebar"><nav><a href="/adminka/orders/">Замовлення</a><a href="/adminka/catalog/">Каталог</a></nav></aside>
<header><div class="user-menu" role="navigation"><a href="/adminka/profile/">Привіт, Тарас Шевчук</a></div></header>
<main><h1>Панель керування</h1>
<section class="widget"><h2>Нові замовлення</h2><ul>
<li><a href="/adminka/orders/1024/">Замовлення №1024 — Іван Петренко</a></li>
<li><a href="/adminka/orders/1025/">Замовлення №1025 — Олена Коваль</a></li></ul></section>
<section class="widget"><h3>Останній коментар від Марія Коваленко</h3></section>
<p><a href="/wp-admin/post.php?post=1024&action=edit">Woo-замовлення</a></p>
</main></body></html>`;

const HS_ORDER = `<!doctype html><html><head><title>Замовлення №1024 — Іван Петренко | Хорошоп</title></head><body>
<aside class="sidebar"><nav><a href="/adminka/orders/">Замовлення</a><a href="/adminka/catalog/">Каталог</a></nav></aside>
<header><nav class="breadcrumbs"><a href="/adminka/">Головна</a><a href="/adminka/orders/">Замовлення</a><a href="/adminka/orders/1024/">№1024 Іван Петренко</a></nav>
<div class="user-menu"><button type="button">Менеджер: Тарас Шевчук</button></div></header>
<main><h1>Замовлення №1024 — Іван Петренко</h1>
<section class="order-status"><h2>Статус замовлення</h2><label>Статус <select><option>Новий</option></select></label><button type="button">Зберегти</button></section>
<section class="customer"><h2>Покупець</h2><h3>Іван Петренко</h3>
<dl><dt>Телефон</dt><dd>+380 67 765 43 21</dd><dt>E-mail</dt><dd>ivan.petrenko@example.com</dd><dt>Коментар</dt><dd>Передзвоніть після 18:00</dd></dl>
<a href="/adminka/clients/77/">Картка покупця</a></section>
<section class="delivery"><h2>Доставка</h2><h3>Нова Пошта: Київ, відділення №12</h3>
<label>Отримувач <input value="Петренко Іван Олександрович"></label><label>ТТН <input placeholder="Номер ТТН"></label></section>
<section><h2>Товари</h2><table><thead><tr><th>Назва</th><th>Кількість</th><th>Ціна</th></tr></thead>
<tbody><tr><td><a href="/adminka/catalog/55/">Срібна монета</a></td><td>1</td><td>1200</td></tr></tbody></table></section>
<p><a href="/adminka/orders/1023/">Попереднє замовлення</a></p>
</main></body></html>`;

const HS_CLIENT = `<!doctype html><html><head><title>Іван Петренко — покупець | Хорошоп</title></head><body>
<aside class="sidebar"><nav><a href="/adminka/orders/">Замовлення</a></nav></aside>
<main><h1>Іван Петренко</h1><h2>Контакти</h2><label>Телефон <input type="tel" value="+380677654321"></label>
<h2>Замовлення покупця</h2><table><thead><tr><th>№</th><th>Сума</th></tr></thead><tbody><tr><td>1024</td><td>1200</td></tr></tbody></table>
<button type="button">Написати Іван Петренко</button></main></body></html>`;

/** WooCommerce: редактирование заказа (сокращённая настоящая разметка). */
const WOO_ORDER = `<!doctype html><html><head><title>Edit order ‹ Срібна крамниця — WordPress</title></head><body class="wp-admin">
<div id="wpadminbar" role="navigation" aria-label="Toolbar"><ul><li><a href="/wp-admin/profile.php">Howdy, Олена Мельник</a></li></ul></div>
<div id="adminmenumain" role="navigation" aria-label="Main menu"><ul id="adminmenu"><li><a href="/wp-admin/edit.php?post_type=shop_order">Orders</a></li></ul></div>
<div class="wrap"><h1 class="wp-heading-inline">Edit order</h1>
<form name="post" method="post" id="post"><div id="order_data" class="panel woocommerce-order-data">
<h2 class="woocommerce-order-data__heading">Order #1024 details</h2>
<p class="woocommerce-order-data__meta order_number">Payment via Cash on delivery. Customer IP: 93.184.216.1</p>
<div class="order_data_column"><h3>General</h3>
<p class="form-field"><label for="order_date">Date created:</label><input type="text" id="order_date" name="order_date" value="2026-10-05"></p>
<p class="form-field"><label for="order_status">Status:</label><select id="order_status" name="order_status"><option>Processing</option></select></p>
<p class="form-field"><label for="customer_user">Customer:</label><select id="customer_user" name="customer_user"><option value="5" selected>Олена Мельник (#5 – olena.melnyk@example.com)</option></select></p></div>
<div class="order_data_column"><h3>Billing <a href="#" class="edit_address">Edit</a></h3>
<div class="address"><p><strong>Address:</strong>Олена Мельник<br>вул. Хрещатик, 22<br>Київ 01001</p></div></div>
<div class="order_data_column"><h3>Shipping <a href="#" class="edit_address">Edit</a></h3><div class="address"><p>Олена Мельник<br>Нова Пошта №12</p></div></div></div>
<div id="woocommerce-order-items"><h2>Items</h2><table class="woocommerce_order_items"><thead><tr><th>Item</th><th>Cost</th><th>Qty</th><th>Total</th></tr></thead>
<tbody><tr><td>Срібна монета «Архангел Михаїл»</td><td>1 200 грн</td><td>1</td><td>1 200 грн</td></tr></tbody></table>
<button type="button" class="button refund-items">Refund</button></div>
<div id="woocommerce-order-notes"><h2>Order notes</h2><ul class="order_notes"><li class="note"><div class="note_content"><p>Олена Мельник підтвердила по телефону.</p></div></li></ul>
<label for="add_order_note">Add note</label><textarea id="add_order_note"></textarea><button type="button" class="button add_note">Add</button></div>
<button class="button save_order" type="submit">Update</button></form></div></body></html>`;

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
        traffic: { responseBytes: 2 * MB, jobBytes: 8 * MB },
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

  it('Ш3-хвост (17): карточки заказа и покупателя — структура без имён; вторая карточка того же вида не открыта', async () => {
    const authedHere =
      (html: string) =>
      (
        q: import('http').IncomingMessage,
        res: import('http').ServerResponse,
      ) => {
        if (!String(q.headers.cookie ?? '').includes('sid=ok')) {
          res.writeHead(302, { location: '/login' });
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
      };
    stand
      .on(ADMIN, '/adminka/', authedHere(HS_DASHBOARD))
      .on(ADMIN, '/adminka/orders/1024/', authedHere(HS_ORDER))
      .on(ADMIN, '/adminka/orders/1025/', authedHere(HS_ORDER))
      .on(ADMIN, '/adminka/orders/1023/', authedHere(HS_ORDER))
      .on(ADMIN, '/adminka/clients/77/', authedHere(HS_CLIENT))
      .on(ADMIN, '/wp-admin/post.php', authedHere(WOO_ORDER));
    sites.credentials = {
      username: 'manager',
      password: '',
      sessionCookies: JSON.stringify([
        { name: 'sid', value: 'ok', domain: ADMIN, path: '/', secure: true },
      ]),
    };
    const j = await sites.waitDone(
      sites.add('admin-crawl', {
        startUrl: `https://${ADMIN}/adminka/`,
        allowedHosts: [ADMIN],
        viewport: 'desktop',
        maxPages: 12,
        maxDepth: 2,
        loginMethod: 'session',
      }),
    );
    expect(j.error).toBeNull();
    const r = j.result as {
      pages: Array<{ url: string; title: string; text: string }>;
      skippedLinks: number;
    };
    const byPath = new Map(r.pages.map((p) => [new URL(p.url).pathname, p]));
    // Одна карточка заказа: 1024 открыта, 1025 и 1023 — нет.
    expect(stand.hit('/adminka/orders/1024/')).toBe(true);
    expect(stand.hit('/adminka/orders/1025/')).toBe(false);
    expect(stand.hit('/adminka/orders/1023/')).toBe(false);
    // Карточка покупателя — другой вид, открыта; товар из таблицы — нет.
    expect(stand.hit('/adminka/clients/77/')).toBe(true);
    expect(stand.hit('/adminka/catalog/55/')).toBe(false);
    expect(r.skippedLinks).toBeGreaterThanOrEqual(2);
    // Ни одного имени, телефона, e-mail, номера заказа — ни в тексте, ни в заголовках.
    const all = r.pages.map((p) => `${p.title}\n${p.text}`).join('\n');
    expect(all).not.toMatch(
      /Іван|Петренко|Олена|Мельник|Коваль|Марія|Тарас|Шевчук|Київ|ivan\.petrenko|olena|765 43|1024|1200/,
    );
    // Структура карточки — на месте.
    const order = byPath.get('/adminka/orders/1024/')!;
    expect(order.title).toBe("Замовлення №[№] — [ім'я] | Хорошоп");
    for (const line of [
      "# Замовлення №[№] — [ім'я]",
      '# Статус замовлення',
      '# Покупець',
      '# Доставка',
      '# Товари',
      'колонка: Кількість',
      'поле: Отримувач',
      'поле: Номер ТТН',
      'кнопка: Зберегти',
      "кнопка: Менеджер: [ім'я]",
    ])
      expect(order.text).toContain(line);
    const client = byPath.get('/adminka/clients/77/')!;
    for (const line of ["# [ім'я]", '# Контакти', 'колонка: Сума'])
      expect(client.text).toContain(line);
    // WooCommerce: карточка по post.php, приветствие в панели — маска.
    const woo = byPath.get('/wp-admin/post.php')!;
    for (const line of [
      '# Edit order',
      '# Order #[№] details',
      '# Billing Edit',
      '# Order notes',
      'поле: Customer:',
      'кнопка: Refund',
      "меню: Howdy, [ім'я]",
    ])
      expect(woo.text).toContain(line);
    // Обычная страница: структура цела, «Имя Фамилия» и приветствие — маска.
    const dash = byPath.get('/adminka/')!;
    for (const line of [
      '# Панель керування',
      '# Нові замовлення',
      "# Останній коментар від [ім'я]",
      "меню: Привіт, [ім'я]",
    ])
      expect(dash.text).toContain(line);
    expect(liveSecretCount()).toBe(0);
  });

  it('Ш3-хвост (9): тяжёлый подресурс оборван потолком ответа — задание живо', async () => {
    stand
      .page(
        SHOP,
        '/heavy-img',
        '<!doctype html><title>Важка</title><h1>Важка</h1><button>Купити</button><img src="/big.bin">',
      )
      .on(SHOP, '/big.bin', (_q, res) => sendBytes(res, 5 * MB, 'image/png'));
    const before = lines.length;
    const j = await sites.waitDone(
      sites.add('ui-snapshot', snap(`https://${SHOP}/heavy-img`)),
    );
    expect(j.error).toBeNull();
    expect(stand.hit('/big.bin')).toBe(true);
    const rec = lines
      .slice(before)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((x) => x.msg === 'потолок трафика');
    expect(rec).toMatchObject({ cut: 'response' });
    expect(rec!.count).toBeGreaterThanOrEqual(1);
    // Оборван на потолке ответа, а не дочитан до 5 МБ.
    expect(rec!.bytes as number).toBeLessThan(4 * MB);
  });

  it('Ш3-хвост (9): огромный документ без длины — traffic_limit', async () => {
    stand.on(SHOP, '/huge-doc', (_q, res) =>
      sendBytes(
        res,
        6 * MB,
        'text/html; charset=utf-8',
        true,
        '<!doctype html><title>Огромна</title><h1>Огромна</h1><pre>',
      ),
    );
    const j = await sites.waitDone(
      sites.add('ui-snapshot', snap(`https://${SHOP}/huge-doc`)),
    );
    expect(j.status).toBe('failed');
    expect(j.error).toBe('traffic_limit');
  });

  it('Ш3-хвост (9): суммарный трафик задания больше потолка — traffic_limit', async () => {
    // 8 ответов по 1,5 МБ — каждый под потолком ответа (2 МБ), вместе
    // 12 МБ — выше потолка задания (8 МБ). Страница дочитывает тела сама.
    stand
      .page(
        SHOP,
        '/many',
        `<!doctype html><title>Багато</title><h1>Багато</h1><script>
for (let i = 0; i < 8; i++) fetch('/part.bin?n=' + i).then((r) => r.arrayBuffer()).catch(() => {});
</script>`,
      )
      .on(SHOP, '/part.bin', (_q, res) =>
        sendBytes(res, 1.5 * MB, 'application/octet-stream'),
      );
    const j = await sites.waitDone(
      sites.add('ui-snapshot', snap(`https://${SHOP}/many`)),
    );
    expect(j.status).toBe('failed');
    expect(j.error).toBe('traffic_limit');
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
