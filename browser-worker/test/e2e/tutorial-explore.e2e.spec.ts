/**
 * e2e раунда исследователя обучалки на воркере (Ш3-хвост (3)) — НАСТОЯЩИЙ
 * Chromium и настоящий фильтрующий прокси, стенд «сайта заказчика» и
 * фейковый sites-backend (тот же разбор параметров и результата):
 *
 *  1. сессия черновика конвертом → cookie на стенде; клик «Далі» → новый
 *     экран; предпросмотр JPEG + съёмочный PNG ×2; новая сессия — конвертом
 *     под одноразовый ключ генератора (чужих cookie нет), маска ПД подписей;
 *  2. «Оплатити» — `click_refused`, стенд запроса оплаты не получил;
 *  3. ссылка на чужой хост — `offhost_redirect`;
 *  4. вход учёткой реестра: поля найдены сами, пароль — только в поле
 *     пароля, ни в журнале, ни в результате;
 *  5. кадры `png2x`: PNG вдвое шире окна.
 */
import { existsSync } from 'fs';
import { createApiClient } from '../../src/api-client';
import { BrowserPool } from '../../src/browser/pool';
import { createLogger, liveSecretCount } from '../../src/logger';
import { Runner } from '../../src/runner';
import {
  exploreFillAad,
  exploreReplyAad,
  exploreSessionAad,
} from '../../src/shared/browser-job-protocol';
import {
  generateWorkerSealKeys,
  openSealed,
  sealForWorker,
} from '../../src/shared/worker-seal';
import { FakeSites } from '../helpers/fake-sites';
import { FakeInternet, PUBLIC_TEST_IP, Stand } from '../helpers/stand';

const SECRET = 'x'.repeat(48);
const SHOP = 'shop.texp.test';
const EVIL = 'evil.texp.test';
const PASSWORD = ['Pw', 'Texp', 'marker', '7a1d'].join('-');

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

const CART = `<!doctype html><html><head><title>Кошик</title></head><body>
<h1>Кошик</h1><button id="who" type="button"></button>
<label>Телефон менеджера +380 67 765 43 21 <input name="q"></label>
<button id="next" onclick="location.href='/cart/step2?email=ivan%40example.com'">Далі</button>
<button id="pay" onclick="fetch('/pay',{method:'POST'})">Оплатити замовлення</button>
<button id="payicon" aria-label="Оплатить заказ" onclick="fetch('/pay',{method:'POST'})"><svg id="ico" width="20" height="20"><rect width="20" height="20"/></svg></button>
<label id="lbl" for="buy">Іконка</label><input id="buy" type="button" value="Оплатити" onclick="fetch('/pay',{method:'POST'})">
<a id="out" href="https://${EVIL}/">Партнер</a>
<script>document.getElementById('who').textContent = document.cookie.includes('sid=ok') ? 'Профіль клієнта' : 'Гість';</script>
</body></html>`;

const STEP2 = `<!doctype html><html><head><title>Крок 2</title></head><body>
<h1>Доставка</h1><select name="city" onchange="document.getElementById('chosen').textContent='Обрано '+this.value"><option value="kyiv">Київ</option><option value="lviv">Львів</option></select>
<button id="chosen">Підтвердити</button></body></html>`;

const LOGIN = `<!doctype html><html><head><title>Вхід</title></head><body>
<form method="post" action="/login"><label>Логін <input name="login" type="text" autocomplete="username"></label>
<label>Пароль <input name="password" type="password" autocomplete="current-password"></label>
<button type="submit">Увійти</button></form></body></html>`;

/** Ширина PNG из заголовка IHDR. */
const pngWidth = (b: Buffer) => b.readUInt32BE(16);

d('tutorial-explore e2e (настоящий Chromium)', () => {
  const stand = new Stand();
  const internet = new FakeInternet(stand);
  const sites = new FakeSites(SECRET);
  const lines: string[] = [];
  const keys = generateWorkerSealKeys();
  let pool: BrowserPool;
  let runner: Runner;
  let payHits = 0;

  beforeAll(async () => {
    await stand.start();
    await internet.start();
    await sites.start();
    sites.sealPublicKey = keys.publicKey;
    sites.credentials = {
      username: 'manager',
      password: PASSWORD,
      sessionCookies: null,
    };
    stand
      .page(SHOP, '/cart', CART)
      .on(SHOP, '/cart/step2', (_q, res) => {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'set-cookie': 'step=2; Path=/; Secure',
        });
        res.end(STEP2);
      })
      .on(SHOP, '/pay', (_q, res) => {
        payHits += 1;
        res.writeHead(204);
        res.end();
      })
      .on(SHOP, '/login', (q, res, body) => {
        if (q.method === 'POST') {
          const p = new URLSearchParams(body);
          if (p.get('login') === 'manager' && p.get('password') === PASSWORD) {
            res.writeHead(302, {
              location: '/account',
              'set-cookie': 'sid=ok; Path=/; Secure; HttpOnly',
            });
            res.end();
            return;
          }
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(LOGIN);
      })
      .page(
        SHOP,
        '/account',
        '<!doctype html><title>Кабінет</title><h1>Кабінет</h1><a href="/orders">Замовлення</a>',
      )
      .page(
        SHOP,
        '/long',
        `<!doctype html><title>Довга</title><h1>Верх</h1><div style="height:3000px;background:linear-gradient(#fff,#36c)"></div>`,
      );
    const dns = new Map<string, string[]>([
      [SHOP, [PUBLIC_TEST_IP]],
      [EVIL, [PUBLIC_TEST_IP]],
    ]);
    const logger = createLogger('debug', (l) => lines.push(l));
    pool = new BrowserPool({
      executablePath: chromiumPath(),
      sandbox: false,
      rotateJobs: 10,
      rotateMs: 60 * 60_000,
      logger,
    });
    runner = new Runner({
      api: createApiClient({
        baseUrl: sites.url,
        secret: SECRET,
        workerId: 'bw-texp',
      }),
      pool,
      logger,
      kinds: ['tutorial-explore', 'frames-capture'],
      concurrency: 1,
      pollMs: 200,
      idlePollMaxMs: 400,
      shutdownGraceMs: 2_000,
      heartbeatMs: 1_000,
      sealPrivateKey: keys.privateKey,
      egress: {
        denyCidrs: [],
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

  const reply = generateWorkerSealKeys();
  const explore = (extra: Record<string, unknown> = {}) => {
    const nonce = `nonce${Math.random().toString(36).slice(2)}`.padEnd(24, 'x');
    return {
      url: `https://${SHOP}/cart`,
      allowedHosts: [SHOP],
      allowedOrigin: `https://${SHOP}`,
      viewport: 'mobile',
      clicks: [],
      fills: [],
      replay: null,
      login: null,
      session: sealForWorker(
        keys.publicKey,
        Buffer.from(
          JSON.stringify([
            { name: 'sid', value: 'ok', domain: SHOP, path: '/', secure: true },
            { name: 'trk', value: '1', domain: '.tracker.test', path: '/' },
          ]),
        ),
        exploreSessionAad({
          nonce,
          replyKey: reply.publicKey,
          allowedHosts: [SHOP],
        }),
      ),
      replyKey: reply.publicKey,
      nonce,
      videoFrame: true,
      ...extra,
    };
  };

  const aad = (p: {
    nonce: string;
    replyKey: string;
    allowedHosts: string[];
  }) => ({
    nonce: p.nonce,
    replyKey: p.replyKey,
    allowedHosts: p.allowedHosts,
  });
  const sealFill = (p: Parameters<typeof aad>[0], v: string, i: number) =>
    sealForWorker(keys.publicKey, Buffer.from(v), exploreFillAad(aad(p), i));

  it('сессия → клик «Далі» → новый экран, кадры, новая сессия конвертом', async () => {
    const params = explore({ clicks: ['#next'] });
    const j = await sites.waitDone(sites.add('tutorial-explore', params));
    expect(j.error).toBeNull();
    const r = j.result as {
      currentUrl: string;
      elements: Array<{ selector: string; options?: unknown[] }>;
      videoFrame: number | null;
      reply: string;
      looksLikeLogin: boolean;
    };
    // Аудит захода 7: query с ПД — только в конверте ответа.
    expect(r.currentUrl).toBe(`https://${SHOP}/cart/step2`);
    expect(JSON.stringify(j.result)).not.toContain('ivan');
    expect(
      r.elements.find((e) => e.selector.includes('city'))?.options,
    ).toEqual([
      { value: 'kyiv', label: 'Київ' },
      { value: 'lviv', label: 'Львів' },
    ]);
    // Ш4(5)-хвост: кандидаты карты интерфейса доходят с воркера.
    expect(
      (
        r.elements.find((e) => e.selector.includes('city')) as unknown as {
          candidates?: unknown;
        }
      ).candidates,
    ).toEqual([{ kind: 'attr', selector: 'select[name="city"]' }]);
    // Предпросмотр — JPEG, съёмочный кадр — PNG ×2 (390 → 780).
    expect(j.artifacts.get(0)!.subarray(0, 3)).toEqual(
      Buffer.from([0xff, 0xd8, 0xff]),
    );
    expect(r.videoFrame).toBe(1);
    expect(pngWidth(j.artifacts.get(1)!)).toBe(780);
    const answer = JSON.parse(
      openSealed(
        reply.privateKey,
        r.reply,
        exploreReplyAad(aad(params)),
      ).toString(),
    ) as { url: string; cookies: Array<{ name: string; value: string }> };
    expect(answer.url).toBe(
      `https://${SHOP}/cart/step2?email=ivan%40example.com`,
    );
    const jar = answer.cookies;
    expect(jar.map((c) => `${c.name}=${c.value}`).sort()).toEqual([
      'sid=ok',
      'step=2',
    ]);
    // Сессия — не открытым текстом ни в результате, ни в журнале.
    expect(JSON.stringify(j.result)).not.toContain('sid');
    expect(lines.join('\n')).not.toMatch(/sid=ok|step=2/);
  });

  it('сессия дошла до страницы; подписи — с маской ПД', async () => {
    const j = await sites.waitDone(sites.add('tutorial-explore', explore()));
    expect(j.error).toBeNull();
    const text = JSON.stringify(j.result);
    // Кука сессии из конверта — в контексте страницы до её скриптов.
    expect(text).toContain('Профіль клієнта');
    expect(text).toContain('[тел.]');
    expect(text).not.toContain('765 43 21');
    // Ссылка на чужой хост в элементы не попала (как в функции).
    expect(text).not.toContain(EVIL);
  });

  it('«Оплатити» — click_refused ДО клика: стенд оплаты не получил', async () => {
    const j = await sites.waitDone(
      sites.add('tutorial-explore', explore({ clicks: ['#pay'] })),
    );
    expect(j.error).toBe('click_refused');
    expect(payHits).toBe(0);
  });

  it('цели нет — target_missing; увод на чужой хост — offhost_redirect', async () => {
    const miss = await sites.waitDone(
      sites.add('tutorial-explore', explore({ clicks: ['#nope'] })),
    );
    expect(miss.error).toBe('target_missing');
    const out = await sites.waitDone(
      sites.add('tutorial-explore', explore({ clicks: ['#out'] })),
    );
    expect(out.error).toBe('offhost_redirect');
    expect(stand.hit(EVIL)).toBe(false);
  });

  it('вход учёткой реестра: поля найдены сами, пароль нигде не остался', async () => {
    const j = sites.add(
      'tutorial-explore',
      explore({
        url: `https://${SHOP}/login`,
        session: null,
        login: { needUsername: true, pick: null },
      }),
      { needsCredentials: true },
    );
    await sites.waitDone(j);
    expect(j.error).toBeNull();
    const r = j.result as {
      currentUrl: string;
      sensitiveFill: boolean;
      autoLogin: { passwordSelector: string; submitSelector: string };
    };
    expect(r.currentUrl).toBe(`https://${SHOP}/account`);
    expect(r.sensitiveFill).toBe(true);
    expect(r.autoLogin.passwordSelector).toContain('password');
    expect(j.credentialsIssued).toBe(1);
    expect(JSON.stringify(j.result)).not.toContain(PASSWORD);
    expect(lines.join('\n')).not.toContain(PASSWORD);
    expect(liveSecretCount()).toBe(0);
  });

  it('аудит захода 7: иконка в «Оплатить заказ» и <label for> на «Оплатити» — click_refused, оплаты нет', async () => {
    for (const sel of ['#ico', '#lbl']) {
      const j = await sites.waitDone(
        sites.add('tutorial-explore', explore({ clicks: [sel] })),
      );
      expect(j.error).toBe('click_refused');
    }
    expect(payHits).toBe(0);
  });

  it('ввод (режим B): значения конвертами — логин, пароль и вход; пароля нет ни в журнале, ни в результате', async () => {
    const base = explore({ url: `https://${SHOP}/login`, session: null });
    const params = {
      ...base,
      fills: [
        {
          selector: 'input[name="login"]',
          value: sealFill(base, 'manager', 0),
        },
        {
          selector: 'input[name="password"]',
          value: sealFill(base, PASSWORD, 1),
        },
      ],
      clicks: ['button[type="submit"]'],
    };
    const j = await sites.waitDone(sites.add('tutorial-explore', params));
    expect(j.error).toBeNull();
    const r = j.result as { currentUrl: string; sensitiveFill: boolean };
    expect(r.currentUrl).toBe(`https://${SHOP}/account`);
    expect(r.sensitiveFill).toBe(true);
    expect(JSON.stringify(j.params)).not.toContain(PASSWORD);
    expect(JSON.stringify(j.result)).not.toContain(PASSWORD);
    expect(lines.join('\n')).not.toContain(PASSWORD);
    // Конверт значения не открывается под чужим полем (AAD — номер поля).
    const swapped = {
      ...base,
      fills: [
        { selector: 'input[name="login"]', value: sealFill(base, 'x', 5) },
      ],
    };
    const bad = await sites.waitDone(sites.add('tutorial-explore', swapped));
    expect(bad.error).toBe('credentials_unavailable');
  });

  it('ввод в <select> — выбор варианта по значению', async () => {
    const base = explore({ url: `https://${SHOP}/cart/step2`, session: null });
    const j = await sites.waitDone(
      sites.add('tutorial-explore', {
        ...base,
        fills: [
          { selector: 'select[name="city"]', value: sealFill(base, 'lviv', 0) },
        ],
      }),
    );
    expect(j.error).toBeNull();
    expect(JSON.stringify(j.result)).toContain('Обрано lviv');
  });

  it('переигровка (/undo): шаги с нуля, пароль — только в поле пароля', async () => {
    const base = explore({ url: `https://${SHOP}/login`, session: null });
    const steps = (pwSelector: string) => [
      { kind: 'goto', url: `https://${SHOP}/login` },
      {
        kind: 'fill',
        selector: 'input[name="login"]',
        value: sealFill(base, 'manager', 1),
        passwordOnly: false,
      },
      {
        kind: 'fill',
        selector: pwSelector,
        value: sealFill(base, PASSWORD, 2),
        passwordOnly: true,
      },
      { kind: 'click', selector: 'button[type="submit"]' },
    ];
    const ok = await sites.waitDone(
      sites.add('tutorial-explore', {
        ...base,
        replay: steps('input[name="password"]'),
      }),
    );
    expect(ok.error).toBeNull();
    expect((ok.result as { currentUrl: string }).currentUrl).toBe(
      `https://${SHOP}/account`,
    );
    // «Поле пароля» оказалось текстовым — пароль не вводится.
    const no = await sites.waitDone(
      sites.add('tutorial-explore', {
        ...base,
        replay: steps('input[name="login"]'),
      }),
    );
    expect(no.error).toBe('login_form_missing');
  });

  it('кадры png2x: PNG вдвое шире окна', async () => {
    const j = await sites.waitDone(
      sites.add('frames-capture', {
        url: `https://${SHOP}/long`,
        allowedHosts: [SHOP],
        viewport: 'mobile',
        frames: 2,
        image: 'png2x',
      }),
    );
    expect(j.error).toBeNull();
    expect(j.artifacts.size).toBe(2);
    expect(pngWidth(j.artifacts.get(0)!)).toBe(780);
  });
});
