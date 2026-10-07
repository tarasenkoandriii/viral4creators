/**
 * Раунд исследователя обучалки на воркере (Ш3-хвост (3)) без браузера:
 * протокол (строгие параметры и результат), стоп-лист клика, маска ПД
 * подписей, бюджет элементов, cookie только хостов замка; учётка,
 * запечатанная ПРИ ЗАПИСИ под ключ воркера (Ш3-хвост (7)), и прежний ключ
 * при ротации.
 */
import type { Browser } from 'playwright-core';
import { ApiError, type WorkerApi } from '../../src/api-client';
import type { JobBrowser } from '../../src/browser/context';
import type { JobCredentials, JobExecutor } from '../../src/jobs/types';
import {
  clickVerdict,
  fitElements,
  harvestJar,
  lockCookies,
  maskPd,
  toExploreElement,
} from '../../src/jobs/tutorial-explore';
import { ConfigError, loadConfig } from '../../src/config';
import { createLogger } from '../../src/logger';
import { Runner } from '../../src/runner';
import {
  ProtocolError,
  WORKER_LIMITS,
  exploreFillAad,
  exploreReplyAad,
  exploreSessionAad,
  parseJobParams,
  parseJobResult,
  type ClaimedJob,
  type TutorialExploreParams,
} from '../../src/shared/browser-job-protocol';
import {
  generateWorkerSealKeys,
  openSealed,
  sealAad,
  sealForWorker,
} from '../../src/shared/worker-seal';

const keys = generateWorkerSealKeys();
const reply = generateWorkerSealKeys();
const NONCE = 'n'.repeat(24);

const PARTS = {
  nonce: NONCE,
  replyKey: reply.publicKey,
  allowedHosts: ['shop.test'],
};
const sealVal = (v: string, i: number) =>
  sealForWorker(keys.publicKey, Buffer.from(v), exploreFillAad(PARTS, i));

const params = (extra: Partial<TutorialExploreParams> = {}) => ({
  url: 'https://shop.test/cart?step=2',
  allowedHosts: ['shop.test'],
  allowedOrigin: 'https://shop.test',
  viewport: 'mobile',
  clicks: ['button[aria-label="Далі"]'],
  fills: [],
  replay: null,
  login: null,
  session: sealForWorker(
    keys.publicKey,
    Buffer.from('[]'),
    exploreSessionAad(PARTS),
  ),
  replyKey: reply.publicKey,
  nonce: NONCE,
  videoFrame: true,
  ...extra,
});

const result = (extra: Record<string, unknown> = {}) => ({
  currentUrl: 'https://shop.test/cart?step=3#top',
  elements: [{ selector: '#next', tag: 'button', visibleText: 'Далі' }],
  looksLikeLogin: false,
  screenshot: 0,
  videoFrame: 1,
  reply: null,
  sensitiveFill: false,
  autoLogin: null,
  ...extra,
});

describe('tutorial-explore: протокол', () => {
  it('параметры: кириллица в селекторе — да; движки Playwright, ввод значений, лишний ключ — нет', () => {
    const p = parseJobParams('tutorial-explore', params());
    expect((p as TutorialExploreParams).clicks).toEqual([
      'button[aria-label="Далі"]',
    ]);
    for (const bad of ['xpath=//a', 'text=Купити', '//a', '']) {
      expect(() =>
        parseJobParams('tutorial-explore', params({ clicks: [bad] })),
      ).toThrow(/clicks/);
    }
    expect(() =>
      parseJobParams('tutorial-explore', params({ clicks: ['#a', '#b'] })),
    ).toThrow(/clicks/);
    expect(() =>
      parseJobParams('tutorial-explore', { ...params(), fill: 'x' }),
    ).toThrow(ProtocolError);
    expect(() =>
      parseJobParams('tutorial-explore', { ...params(), password: 'x' }),
    ).toThrow(ProtocolError);
  });

  it('сессия — только конвертом; origin — из замка; вход учёткой без кликов', () => {
    expect(() =>
      parseJobParams(
        'tutorial-explore',
        params({ session: '[{"name":"sid"}]' as string }),
      ),
    ).toThrow(/session/);
    expect(() =>
      parseJobParams(
        'tutorial-explore',
        params({ allowedOrigin: 'https://evil.test' }),
      ),
    ).toThrow(/allowedOrigin/);
    expect(() =>
      parseJobParams(
        'tutorial-explore',
        params({ allowedOrigin: 'https://shop.test/path' }),
      ),
    ).toThrow(/allowedOrigin/);
    expect(() =>
      parseJobParams(
        'tutorial-explore',
        params({ login: { needUsername: true, pick: null } }),
      ),
    ).toThrow(/clicks/);
    expect(() =>
      parseJobParams('tutorial-explore', {
        ...params({ clicks: [] }),
        login: { needUsername: true, pick: null },
      }),
    ).not.toThrow();
    expect(() =>
      parseJobParams(
        'tutorial-explore',
        params({
          allowedHosts: [
            'shop.test',
            'a.shop.test',
            'b.shop.test',
            'c.shop.test',
            'd.shop.test',
          ],
        }),
      ),
    ).toThrow(/allowedHosts/);
  });

  it('результат: адрес вне замка, кадр без запроса, поля входа без входа — отказ; в открытом адресе нет query (ПД) и #', () => {
    const p = parseJobParams('tutorial-explore', params());
    const ok = parseJobResult('tutorial-explore', p, result()) as {
      currentUrl: string;
    };
    expect(ok.currentUrl).toBe('https://shop.test/cart');
    expect(() =>
      parseJobResult(
        'tutorial-explore',
        p,
        result({ currentUrl: 'https://evil.test/' }),
      ),
    ).toThrow(/currentUrl/);
    const noVideo = parseJobParams(
      'tutorial-explore',
      params({ videoFrame: false }),
    );
    expect(() => parseJobResult('tutorial-explore', noVideo, result())).toThrow(
      /videoFrame/,
    );
    expect(() =>
      parseJobResult(
        'tutorial-explore',
        p,
        result({
          autoLogin: {
            usernameSelector: null,
            passwordSelector: '#pw',
            submitSelector: '#go',
          },
        }),
      ),
    ).toThrow(/autoLogin/);
    expect(() =>
      parseJobResult(
        'tutorial-explore',
        p,
        result({ elements: [{ selector: '#a', tag: 'div' }] }),
      ),
    ).toThrow(/tag/);
    expect(() =>
      parseJobResult(
        'tutorial-explore',
        p,
        result({
          elements: [{ selector: '#a', tag: 'a', danger: 'Оплата' }],
        }),
      ),
    ).toThrow(/danger/);
  });

  it('ввод и переигровка: значения — только конвертами; ≤ 10 полей; переигровка — с нуля и с первого перехода', () => {
    const ok = parseJobParams(
      'tutorial-explore',
      params({ fills: [{ selector: '#pw', value: sealVal('секрет', 0) }] }),
    ) as TutorialExploreParams;
    expect(ok.fills).toHaveLength(1);
    expect(() =>
      parseJobParams(
        'tutorial-explore',
        params({ fills: [{ selector: '#pw', value: 'секрет' }] }),
      ),
    ).toThrow(/fills\.0\.value/);
    expect(() =>
      parseJobParams(
        'tutorial-explore',
        params({
          fills: Array.from({ length: 11 }, (_, i) => ({
            selector: `#f${i}`,
            value: sealVal('x', i),
          })),
        }),
      ),
    ).toThrow(/fills/);
    const replay = [
      { kind: 'goto' as const, url: 'https://shop.test/cart?step=2' },
      {
        kind: 'fill' as const,
        selector: '#pw',
        value: sealVal('p', 1),
        passwordOnly: true,
      },
      { kind: 'click' as const, selector: '#go' },
    ];
    expect(() =>
      parseJobParams(
        'tutorial-explore',
        params({ clicks: [], session: null, replay }),
      ),
    ).not.toThrow();
    // С сессией или кликами раунда — нельзя; первый шаг — не переход — нельзя.
    expect(() =>
      parseJobParams('tutorial-explore', params({ clicks: [], replay })),
    ).toThrow(/replay/);
    expect(() =>
      parseJobParams(
        'tutorial-explore',
        params({ clicks: [], session: null, replay: replay.slice(1) }),
      ),
    ).toThrow(/replay\.0/);
    expect(() =>
      parseJobParams(
        'tutorial-explore',
        params({
          clicks: [],
          session: null,
          replay: [
            replay[0],
            { kind: 'goto', url: 'https://evil.test/' } as never,
          ],
        }),
      ),
    ).toThrow(/url/);
  });

  it('frames-capture: `image` необязателен; неизвестный формат — отказ', () => {
    const base = {
      url: 'https://shop.test/',
      allowedHosts: ['shop.test'],
      viewport: 'mobile',
      frames: 1,
    };
    expect(parseJobParams('frames-capture', base)).toEqual(base);
    expect(
      parseJobParams('frames-capture', { ...base, image: 'png2x' }),
    ).toEqual({ ...base, image: 'png2x' });
    expect(() =>
      parseJobParams('frames-capture', { ...base, image: 'gif' }),
    ).toThrow(/image/);
  });
});

describe('совместимость конверта с генератором (backend/worker-session-seal.ts)', () => {
  it('конверт, запечатанный кодом генератора, открывает ключ воркера', () => {
    // Эталон: `sealTo` генератора под открытый ключ X (тестовая пара).
    const d = 'eMWacWm-O5mnEwu_L6GlI05QcelPsmA4Wtx0-nW1mWU';
    const sealed =
      'v1.5Gr0oflgfYyrTGe6ybtcAhQzEC_D4yJgJbuZvqsUQnQ.dlqIM0nJHEXZimSg.hyr5cvqrvLbJwIti2uMWn0O244O4zZkiN8KYmx5oMM2iO9ErCre-NkMTutImWJn0_tJElK9oEw';
    expect(
      openSealed(
        d,
        sealed,
        exploreSessionAad({
          nonce: 'vector-nonce-000000000000',
          replyKey: 'IIRNQT9jMm2A_UoS02HkgEvzvlldcaOr1lKG2L-XDUY',
          allowedHosts: ['shop.test', 'a.shop.test'],
        }),
      ).toString(),
    ).toBe('[{"name":"sid","value":"from-backend"}]');
  });
});

describe('tutorial-explore: стоп-лист, маска, бюджет, cookie', () => {
  const hosts = ['shop.test'];

  it('клик: оплата/удаление/оформление — отказ; «Далі», отправка формы — да; цели нет — missing', () => {
    expect(clickVerdict(null, hosts)).toBe('missing');
    expect(
      clickVerdict(
        { text: 'Оплатити замовлення', hidden: '', href: null },
        hosts,
      ),
    ).toBe('refused');
    expect(
      clickVerdict({ text: '', hidden: 'Видалити', href: null }, hosts),
    ).toBe('refused');
    expect(
      clickVerdict(
        {
          text: 'Ще',
          hidden: '',
          href: 'https://shop.test/orders/5/delete',
        },
        hosts,
      ),
    ).toBe('refused');
    expect(clickVerdict({ text: 'Далі', hidden: '', href: null }, hosts)).toBe(
      'ok',
    );
    expect(
      clickVerdict({ text: 'Надіслати заявку', hidden: '', href: null }, hosts),
    ).toBe('ok');
  });

  it('маска ПД — в подписях и текстах кнопок; селектор и значение опции — как есть', () => {
    expect(maskPd('Пишіть: ivan@example.com, +380 50 123 45 67')).toBe(
      'Пишіть: [e-mail], [тел.]',
    );
    const e = toExploreElement({
      selector: '#u-ivan',
      tag: 'select',
      label: 'Менеджер ivan@example.com',
      options: [
        { value: '380501234567', label: '+380 50 123 45 67' },
        { value: 'x'.repeat(500), label: 'довге' },
      ],
      danger: 'Оплата',
    });
    expect(e).toEqual({
      selector: '#u-ivan',
      tag: 'select',
      label: 'Менеджер [e-mail]',
      options: [{ value: '380501234567', label: '[тел.]' }],
    });
  });

  it('Ш4(5)-хвост: кандидаты карты — как есть; с ПД в селекторе или подписи — отброшены (не маскируются); мусор — вон', () => {
    const e = toExploreElement({
      selector: '#email',
      tag: 'input',
      candidates: [
        { kind: 'id', selector: '#email' },
        {
          kind: 'aria',
          selector: 'input[aria-label="Пишіть ivan@example.com"]',
          name: 'Пишіть ivan@example.com',
        },
        { kind: 'attr', selector: 'input[name="380501234567"]' },
        { kind: 'aria', selector: 'input[aria-label="Пошта"]', name: 'Пошта' },
        { kind: 'attr', selector: 'xpath=//input' },
        { kind: 'css' as never, selector: 'div > input' },
      ],
    });
    expect(e?.candidates).toEqual([
      { kind: 'id', selector: '#email' },
      { kind: 'aria', selector: 'input[aria-label="Пошта"]', name: 'Пошта' },
    ]);
    const p = parseJobParams('tutorial-explore', params());
    const withC = (c: unknown) =>
      result({ elements: [{ selector: '#a', tag: 'a', candidates: c }] });
    expect(() =>
      parseJobResult(
        'tutorial-explore',
        p,
        withC([{ kind: 'css', selector: '#a' }]),
      ),
    ).toThrow(/candidates\.0\.kind/);
    expect(() =>
      parseJobResult(
        'tutorial-explore',
        p,
        withC([{ kind: 'aria', selector: '#a' }]),
      ),
    ).toThrow(/candidates\.0/);
    expect(() =>
      parseJobResult(
        'tutorial-explore',
        p,
        withC(
          Array.from({ length: 5 }, () => ({ kind: 'id', selector: '#a' })),
        ),
      ),
    ).toThrow(/candidates/);
  });

  it('бюджет результата: сначала опции, потом хвост элементов', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      selector: `#e${i}`,
      tag: 'select' as const,
      options: Array.from({ length: 100 }, (_, k) => ({
        value: `v${k}`,
        label: `Опція ${k}`,
      })),
    }));
    const fit = fitElements(many, 100 * 1024);
    expect(Buffer.byteLength(JSON.stringify(fit))).toBeLessThanOrEqual(
      100 * 1024,
    );
    expect(fit[0].options).toHaveLength(20);
    expect(fit.length).toBeLessThan(200);
    expect(fit[0].selector).toBe('#e0');
  });

  it('cookie: только хосты замка и их родители; jar генератора — без чужих', () => {
    const raw = JSON.stringify([
      { name: 'sid', value: '1', domain: '.shop.test', path: '/' },
      { name: 'tr', value: '2', domain: '.tracker.test', path: '/' },
      { name: 'loc', value: '3', domain: 'shop.test', path: '/', secure: true },
    ]);
    const c = lockCookies(raw, ['shop.test', 'shop.test']);
    expect(c.map((x) => x.name).sort()).toEqual(['loc', 'sid']);
    const jar = JSON.parse(
      harvestJar(
        [
          ...c,
          {
            name: 'tr',
            value: '2',
            domain: '.tracker.test',
            path: '/',
            expires: -1,
            httpOnly: false,
            secure: false,
            sameSite: 'Lax',
          },
        ],
        ['shop.test'],
      ),
    ) as Array<{ name: string }>;
    expect(jar.map((x) => x.name).sort()).toEqual(['loc', 'sid']);
  });

  it('конверт ответа открывается только одноразовым ключом генератора и своим nonce', () => {
    const sealed = sealForWorker(
      reply.publicKey,
      Buffer.from('[{"name":"sid"}]'),
      exploreReplyAad(PARTS),
    );
    expect(
      openSealed(reply.privateKey, sealed, exploreReplyAad(PARTS)).toString(),
    ).toBe('[{"name":"sid"}]');
    expect(() =>
      openSealed(
        reply.privateKey,
        sealed,
        exploreReplyAad({ ...PARTS, nonce: 'm'.repeat(24) }),
      ),
    ).toThrow();
    expect(() =>
      openSealed(keys.privateKey, sealed, exploreReplyAad(PARTS)),
    ).toThrow();
    // Аудит захода 7: AAD привязан и к ключу ответа, и к замку — конверт
    // сессии, переставленный в задание с другим ключом или хостом, не
    // откроется.
    const sess = sealForWorker(
      keys.publicKey,
      Buffer.from('[]'),
      exploreSessionAad(PARTS),
    );
    for (const other of [
      { ...PARTS, replyKey: keys.publicKey },
      { ...PARTS, allowedHosts: ['evil.test'] },
    ]) {
      expect(() =>
        openSealed(keys.privateKey, sess, exploreSessionAad(other)),
      ).toThrow();
    }
    expect(WORKER_LIMITS.sessionSealedChars).toBeLessThan(
      WORKER_LIMITS.resultBytes,
    );
  });
});

// ── учётка, запечатанная при записи (Ш3-хвост (7)) ────────────────────────

class CredApi implements WorkerApi {
  failed: Array<[string, string]> = [];
  completed: string[] = [];
  queue: ClaimedJob[] = [];
  constructor(private readonly body: (j: ClaimedJob) => string) {}
  async claim(_k: unknown, max: number) {
    return { enabled: true, jobs: this.queue.splice(0, max) };
  }
  async heartbeat() {
    return { cancel: false };
  }
  async complete(id: string) {
    this.completed.push(id);
  }
  async fail(id: string, _t: string, code: string) {
    this.failed.push([id, code]);
    return { retry: false };
  }
  async credentials(id: string) {
    const j = { id, attempt: 1 } as ClaimedJob;
    if (!this.body) throw new ApiError(403, 'X');
    return { sealed: this.body(j), attempt: 1 };
  }
  async artifact() {
    return undefined;
  }
}

const crawlJob: ClaimedJob = {
  id: 'crawl1',
  kind: 'admin-crawl',
  attempt: 1,
  leaseToken: 't'.repeat(43),
  leaseUntil: new Date().toISOString(),
  wallMs: 5_000,
  params: {
    startUrl: 'https://admin.shop.test/',
    allowedHosts: ['admin.shop.test'],
    viewport: 'desktop',
    maxPages: 1,
    maxDepth: 0,
    loginMethod: 'password',
  },
  needsCredentials: true,
};

async function runWith(
  body: (j: ClaimedJob) => string,
  sealPrivateKey: string,
  sealPreviousPrivateKey: string | null,
): Promise<{ api: CredApi; got: { user: string | null; pw: string | null } }> {
  const api = new CredApi(body);
  api.queue = [crawlJob];
  const got = { user: null as string | null, pw: null as string | null };
  const exec: JobExecutor = async (ctx) => {
    const c: JobCredentials = await ctx.credentials();
    got.user = c.username;
    got.pw = c.password ? await c.password.reveal(async (p) => p) : null;
    c.wipe();
    return { loggedIn: true, pages: [], refusedClicks: 0, skippedLinks: 0 };
  };
  const runner = new Runner({
    api,
    pool: { acquire: async () => ({}) as Browser, release: () => undefined },
    logger: createLogger('error', () => undefined),
    kinds: ['admin-crawl'],
    concurrency: 1,
    pollMs: 10,
    idlePollMaxMs: 20,
    shutdownGraceMs: 200,
    heartbeatMs: 50,
    sealPrivateKey,
    sealPreviousPrivateKey,
    egress: { denyCidrs: [], allowedPorts: [443], upstream: null },
    executors: { 'admin-crawl': exec },
    openJobBrowser: async () =>
      ({
        close: async () => undefined,
        blocked: () => 0,
        traffic: () => ({
          bytesIn: 0,
          bytesOut: 0,
          connections: 0,
          refused: 0,
          cutResponses: 0,
          cutJob: false,
        }),
      }) as unknown as JobBrowser,
  });
  runner.start();
  for (let i = 0; i < 200 && !api.completed.length && !api.failed.length; i++)
    await new Promise((r) => setTimeout(r, 10));
  await runner.shutdown();
  return { api, got };
}

describe('учётка «Админки», запечатанная при записи (Ш3-хвост (7))', () => {
  const AAD = 'cred:A:acc:site:ta:password';
  const outer =
    (pub: string, innerPub: string, aad = AAD) =>
    (j: ClaimedJob) =>
      sealForWorker(
        pub,
        Buffer.from(
          JSON.stringify({
            username: 'manager',
            password: null,
            loginFields: null,
            sessionCookies: null,
            stored: [
              {
                purpose: 'password',
                aad,
                sealed: sealForWorker(
                  innerPub,
                  Buffer.from('Pw-at-rest-7'),
                  AAD,
                ),
              },
            ],
          }),
        ),
        sealAad(j.id, j.attempt),
      );

  it('внутренний конверт открывается ключом воркера — пароль доходит до исполнителя', async () => {
    const { api, got } = await runWith(
      outer(keys.publicKey, keys.publicKey),
      keys.privateKey,
      null,
    );
    expect(api.completed).toEqual(['crawl1']);
    expect(got).toEqual({ user: 'manager', pw: 'Pw-at-rest-7' });
  });

  it('ротация: записано под старый ключ — открывает прежний ключ; без него — credentials_unavailable', async () => {
    const fresh = generateWorkerSealKeys();
    const ok = await runWith(
      outer(fresh.publicKey, keys.publicKey),
      fresh.privateKey,
      keys.privateKey,
    );
    expect(ok.got.pw).toBe('Pw-at-rest-7');
    const no = await runWith(
      outer(fresh.publicKey, keys.publicKey),
      fresh.privateKey,
      null,
    );
    expect(no.api.failed).toEqual([['crawl1', 'credentials_unavailable']]);
  });

  it('конверт, переставленный в чужую учётку (другой AAD), не открывается', async () => {
    const { api } = await runWith(
      outer(keys.publicKey, keys.publicKey, 'cred:A:acc:site:OTHER:password'),
      keys.privateKey,
      null,
    );
    expect(api.failed).toEqual([['crawl1', 'credentials_unavailable']]);
  });
});

describe('config: раунд обучалки и прежний ключ (ротация)', () => {
  const base = {
    SITES_BACKEND_URL: 'https://sites.example',
    SITES_WORKER_HMAC_SECRET: 's'.repeat(40),
    BROWSER_WORKER_SANDBOX: 'off',
  } as NodeJS.ProcessEnv;

  it('без ключа конверта раунд обучалки не берётся (сессия — конвертом)', () => {
    expect(loadConfig(base).kinds).not.toContain('tutorial-explore');
    const c = loadConfig({
      ...base,
      BROWSER_WORKER_SEAL_PRIVATE_KEY: keys.privateKey,
    });
    expect(c.kinds).toContain('tutorial-explore');
    expect(c.sealPreviousPrivateKey).toBeNull();
  });

  it('прежний ключ: только вместе с текущим и не равный ему', () => {
    const old = generateWorkerSealKeys();
    expect(
      loadConfig({
        ...base,
        BROWSER_WORKER_SEAL_PRIVATE_KEY: keys.privateKey,
        BROWSER_WORKER_SEAL_PRIVATE_KEY_PREVIOUS: old.privateKey,
      }).sealPreviousPrivateKey,
    ).toBe(old.privateKey);
    expect(() =>
      loadConfig({
        ...base,
        BROWSER_WORKER_SEAL_PRIVATE_KEY_PREVIOUS: old.privateKey,
      }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({
        ...base,
        BROWSER_WORKER_SEAL_PRIVATE_KEY: keys.privateKey,
        BROWSER_WORKER_SEAL_PRIVATE_KEY_PREVIOUS: keys.privateKey,
      }),
    ).toThrow(ConfigError);
  });
});
