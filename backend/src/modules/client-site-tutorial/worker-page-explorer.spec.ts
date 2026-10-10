/**
 * Раунд исследователя на браузерном воркере (Ш3-хвост (3)) без сети:
 * фейковый клиент sites-backend и фейковый кабинет сайтов (режим A/B).
 *
 *  - режим A (подтверждён): ввод руками и переигровка — в функции; любой
 *    отказ ДО исполнения — откат в функцию;
 *  - режим B / режим неизвестен (аудит захода 7, К-2 «на открытие»): ввод
 *    и переигровка — на воркере, значения — конвертами; откат — только
 *    «воркер выключен / не взял задание»; прочее — ошибка человеку;
 *  - ответ: полный адрес и сессия — из конверта; замок генератора.
 */
import {
  BadRequestException,
  ConflictException,
  GatewayTimeoutException,
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { generateKeyPairSync } from 'crypto';
import {
  SitesNotConfiguredError,
  SitesRejectedError,
  SitesUnavailableError,
} from '../sites-internal/sites-internal.client';
import type {
  ExploreRequestBody,
  ExploreStatus,
  SitesTutorialWorkerClient,
} from '../sites-internal/sites-tutorial-frames.client';
import type { ExploreRoundRequest, ReplayRequest } from './page-explorer';
import { LoginFieldsNotFoundError } from './registry-login';
import {
  CLICK_REFUSED,
  WORKER_UNAVAILABLE,
  WorkerFallbackError,
  WorkerPageExplorer,
  exploreSubject,
} from './worker-page-explorer';
import {
  exploreFillAad,
  exploreLockHosts,
  exploreReplyAad,
  exploreSessionAad,
  openWithPrivateForTests,
  sealTo,
} from './worker-session-seal';

const ORIGIN = 'https://shop.example.com';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]);

const worker = generateKeyPairSync('x25519');
const W = {
  x: (worker.publicKey.export({ format: 'jwk' }) as { x: string }).x,
  d: (worker.privateKey.export({ format: 'jwk' }) as { d: string }).d,
};

/** AAD-части тела — так же, как их считает sites-backend. */
function partsOf(body: ExploreRequestBody) {
  const gotos = (body.replay ?? []).flatMap((s) =>
    s.kind === 'goto' ? [s.url] : [],
  );
  return {
    nonce: body.nonce,
    replyKey: body.replyKey,
    allowedHosts: exploreLockHosts([body.url, body.allowedOrigin, ...gotos]),
  };
}

const openW = (sealed: string, aad: string) =>
  openWithPrivateForTests(W.d, W.x, sealed, aad).toString();

type Step =
  | Partial<ExploreStatus>
  | ((body: ExploreRequestBody) => Partial<ExploreStatus>);

class FakeClient {
  bodies: ExploreRequestBody[] = [];
  cancels: Array<{ running: boolean }> = [];
  statuses: Step[] = [];
  cancelAnswer = 'cancelled';
  requestError: Error | null = null;
  keyError: Error | null = null;
  fetched: string[] = [];
  async exploreSealKey() {
    if (this.keyError) throw this.keyError;
    return { publicKey: W.x };
  }
  async exploreRequest(body: ExploreRequestBody) {
    if (this.requestError) throw this.requestError;
    this.bodies.push(body);
    return { jobId: 'job1', status: 'queued', mode: 'B' as const };
  }
  async exploreStatus(): Promise<ExploreStatus> {
    const step =
      this.statuses.length > 1 ? this.statuses.shift()! : this.statuses[0];
    const s = typeof step === 'function' ? step(this.bodies[0]) : step;
    return {
      jobId: 'job1',
      status: 'queued',
      errorCode: null,
      startedAt: null,
      result: null,
      artifacts: [],
      expiresAt: new Date().toISOString(),
      ...s,
    } as ExploreStatus;
  }
  async exploreCancel(_s: string, _j: string, _t?: string, running = false) {
    this.cancels.push({ running });
    return { jobId: 'job1', status: running ? 'running' : this.cancelAnswer };
  }
  async fetchArtifact(url: string) {
    this.fetched.push(url);
    return url.endsWith('/1')
      ? { buffer: PNG, contentType: 'image/png' as const }
      : { buffer: JPEG, contentType: 'image/jpeg' as const };
  }
}

class TestExplorer extends WorkerPageExplorer {
  clock = 0;
  protected now() {
    return this.clock;
  }
  protected sleep(ms: number) {
    this.clock += ms;
    return Promise.resolve();
  }
}

/** Кабинет сайтов: режим A/B, или «не ответил». */
function make(mode: 'A' | 'B' | 'down' = 'B') {
  const client = new FakeClient();
  const modes = {
    hostStatus: jest.fn(() =>
      mode === 'down'
        ? Promise.reject(new Error('down'))
        : Promise.resolve({ mode } as never),
    ),
  };
  const ex = new TestExplorer(
    client as unknown as SitesTutorialWorkerClient,
    {
      queueWaitMs: 5_000,
      budgetMs: 60_000,
      replayBudgetMs: 120_000,
      pollMs: 1_000,
    },
    modes,
  );
  return { client, ex, modes };
}

const COOKIE = {
  name: 'sid',
  value: 'secret-session-value',
  domain: 'shop.example.com',
  path: '/',
  secure: true,
  httpOnly: true,
  expires: -1,
};

const REQ: ExploreRoundRequest = {
  url: `${ORIGIN}/cart`,
  cookies: [COOKIE],
  actions: [{ kind: 'click', selector: '#pay' }],
  allowedOrigin: ORIGIN,
  requester: { telegramId: '42' },
};

/** Сданный результат: ответ — конвертом под ключ ответа из тела. */
const done =
  (
    over: Record<string, unknown> = {},
    url = `${ORIGIN}/checkout?email=a%40b.c`,
  ) =>
  (body: ExploreRequestBody): Partial<ExploreStatus> => ({
    status: 'done',
    startedAt: '2026-10-07T00:00:00Z',
    artifacts: [
      {
        idx: 0,
        url: 'https://blob.test/0',
        contentType: 'image/jpeg',
        linkExpiresAt: '',
      },
      {
        idx: 1,
        url: 'https://blob.test/1',
        contentType: 'image/png',
        linkExpiresAt: '',
      },
    ],
    result: {
      currentUrl: `${ORIGIN}/checkout`,
      elements: [
        { selector: '#pay', tag: 'button', visibleText: 'Оплатить' },
        {
          selector: '#next',
          tag: 'button',
          visibleText: 'Далее',
          candidates: [{ kind: 'id', selector: '#next' }],
        },
      ],
      looksLikeLogin: false,
      screenshot: 0,
      videoFrame: 1,
      reply: sealTo(
        body.replyKey,
        Buffer.from(
          JSON.stringify({
            url,
            cookies: [{ ...COOKIE, value: 'new-session' }],
          }),
        ),
        exploreReplyAad(partsOf(body)),
      ),
      sensitiveFill: false,
      autoLogin: null,
      ...over,
    },
  });

describe('режим A (подтверждённый сайт): как раньше', () => {
  it('ввод руками, вход без учётки реестра, переигровка — в функции, воркер не тронут', async () => {
    const { client, ex } = make('A');
    await expect(
      ex.runRound({
        ...REQ,
        actions: [{ kind: 'fill', selector: '#pw', value: 'p' }],
      }),
    ).rejects.toBeInstanceOf(WorkerFallbackError);
    await expect(
      ex.runRound({
        ...REQ,
        actions: [],
        autoLogin: { username: 'u', password: 'secret-pass' },
      }),
    ).rejects.toBeInstanceOf(WorkerFallbackError);
    const replay: ReplayRequest = {
      steps: [{ kind: 'goto', route: `${ORIGIN}/` }],
      secrets: {},
      allowedOrigin: ORIGIN,
      requester: { telegramId: '42' },
    };
    await expect(ex.replay(replay)).rejects.toBeInstanceOf(WorkerFallbackError);
    expect(client.bodies).toEqual([]);
  });

  it('любой отказ при постановке (выключен, лимит) и стоп-лист — откат в функцию', async () => {
    for (const e of [
      new SitesRejectedError(409, 'BROWSER_WORKER_DISABLED', 'x'),
      new SitesRejectedError(429, 'BROWSER_JOB_BUSY', 'x'),
    ]) {
      const { client, ex } = make('A');
      client.requestError = e;
      await expect(ex.runRound(REQ)).rejects.toBeInstanceOf(
        WorkerFallbackError,
      );
    }
    const c = make('A');
    c.client.statuses = [
      { status: 'failed', errorCode: 'click_refused', startedAt: 't' },
    ];
    await expect(c.ex.runRound(REQ)).rejects.toBeInstanceOf(
      WorkerFallbackError,
    );
  });

  it('пароль реестра — не в теле; учётка названа', async () => {
    const { client, ex } = make('A');
    client.statuses = [
      done({
        autoLogin: {
          usernameSelector: '#u',
          passwordSelector: '#p',
          submitSelector: '#go',
        },
        sensitiveFill: true,
      }),
    ];
    await ex.runRound({
      ...REQ,
      actions: [],
      autoLogin: {
        username: 'manager',
        password: 'registry-secret-pass',
        registry: { telegramId: '123456', testAccountId: 'ta1' },
      },
    });
    const body = client.bodies[0];
    expect(JSON.stringify(body)).not.toContain('registry-secret-pass');
    expect(body.registry).toEqual({
      telegramId: '123456',
      testAccountId: 'ta1',
      needUsername: true,
      pick: null,
    });
  });
});

describe('режим B / неизвестен (аудит захода 7): откат — только «воркер выключен»', () => {
  it('ввод руками — на воркере: значения (и пароль) — конвертами по полям, сессия — конвертом', async () => {
    const { client, ex } = make('B');
    client.statuses = [done({ sensitiveFill: true })];
    const r = await ex.runRound({
      ...REQ,
      actions: [
        { kind: 'fill', selector: '#email', value: 'buyer@example.com' },
        { kind: 'fill', selector: '#pw', value: 'manual-secret-pass' },
        { kind: 'click', selector: '#go' },
      ],
    });
    const body = client.bodies[0];
    const text = JSON.stringify(body);
    for (const secret of [
      'manual-secret-pass',
      'buyer@example.com',
      'secret-session-value',
    ]) {
      expect(text).not.toContain(secret);
    }
    const parts = partsOf(body);
    expect(body.fills.map((f) => f.selector)).toEqual(['#email', '#pw']);
    expect(openW(body.fills[1].value, exploreFillAad(parts, 1))).toBe(
      'manual-secret-pass',
    );
    // Конверт поля не открывается под чужим номером.
    expect(() =>
      openW(body.fills[1].value, exploreFillAad(parts, 0)),
    ).toThrow();
    expect(
      JSON.parse(openW(body.session!, exploreSessionAad(parts)))[0].value,
    ).toBe('secret-session-value');
    expect(body.clicks).toEqual(['#go']);
    expect(r.sensitiveFill).toBe(true);
  });

  it('кабинет сайтов не ответил или нет telegramId — строгий путь', async () => {
    for (const [mode, req] of [
      ['down', REQ],
      ['A', { ...REQ, requester: undefined }],
    ] as const) {
      const { client, ex } = make(mode);
      client.statuses = [
        { status: 'failed', errorCode: 'click_refused', startedAt: 't' },
      ];
      await expect(ex.runRound(req)).rejects.toBeInstanceOf(ConflictException);
    }
  });

  it('отказы при постановке: выключен/не настроен — функция; лимит — 429; разбор — 400; недоступен — 503', async () => {
    const cases: Array<[Error, unknown, number | null]> = [
      [
        new SitesRejectedError(409, 'BROWSER_WORKER_DISABLED', 'x'),
        WorkerFallbackError,
        null,
      ],
      [new SitesNotConfiguredError(), WorkerFallbackError, null],
      [
        new SitesRejectedError(429, 'BROWSER_JOB_BUSY', 'x'),
        HttpException,
        429,
      ],
      [
        new SitesRejectedError(400, 'INTERNAL_BAD_BODY', 'x'),
        BadRequestException,
        400,
      ],
      [new SitesUnavailableError('down'), ServiceUnavailableException, 503],
    ];
    for (const [err, cls, status] of cases) {
      const { client, ex } = make('B');
      client.requestError = err;
      const got = await ex.runRound(REQ).catch((e: unknown) => e);
      expect(got).toBeInstanceOf(cls as never);
      expect(got instanceof HttpException ? got.getStatus() : null).toBe(
        status,
      );
    }
    const k = make('B');
    k.client.keyError = new SitesUnavailableError('down');
    const e = (await k.ex
      .runRound(REQ)
      .catch((x: unknown) => x)) as HttpException;
    expect(e.getStatus()).toBe(503);
    expect((e.getResponse() as { code: string }).code).toBe(WORKER_UNAVAILABLE);
  });

  it('отказы воркера: стоп-лист — 409 человеку (не функция); не брал/выключен — функция', async () => {
    const cases: Array<[string, string | null, unknown]> = [
      ['click_refused', 't', ConflictException],
      ['credentials_unavailable', 't', ServiceUnavailableException],
      ['worker_disabled', null, WorkerFallbackError],
      ['cancelled', null, WorkerFallbackError],
      ['worker_disabled', 't', ServiceUnavailableException],
      ['offhost_redirect', 't', BadRequestException],
      ['target_missing', 't', BadRequestException],
      ['login_form_missing', 't', LoginFieldsNotFoundError],
      ['login_fields_unsupported', 't', BadRequestException],
      ['nav_timeout', 't', GatewayTimeoutException],
      ['internal', 't', ServiceUnavailableException],
    ];
    for (const [code, startedAt, cls] of cases) {
      const { client, ex } = make('B');
      client.statuses = [{ status: 'failed', errorCode: code, startedAt }];
      const got = await ex.runRound(REQ).catch((e: unknown) => e);
      expect([code, got]).toEqual([code, expect.any(cls as never)]);
    }
    const { client, ex } = make('B');
    client.statuses = [
      { status: 'failed', errorCode: 'click_refused', startedAt: 't' },
    ];
    const got = (await ex
      .runRound(REQ)
      .catch((e: unknown) => e)) as HttpException;
    expect((got.getResponse() as { code: string }).code).toBe(CLICK_REFUSED);
  });

  it('сессия больше потолка очереди — 400, а не функция', async () => {
    const { ex } = make('B');
    const huge = Array.from({ length: 400 }, (_, i) => ({
      ...COOKIE,
      name: `c${i}`,
      value: 'v'.repeat(400),
    }));
    await expect(ex.runRound({ ...REQ, cookies: huge })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('переигровка — на воркере: значения из секретов — конвертами, пароль — «только в поле пароля»', async () => {
    const { client, ex } = make('B');
    client.statuses = [done({ sensitiveFill: true })];
    const req: ReplayRequest = {
      steps: [
        { kind: 'goto', route: `${ORIGIN}/login` },
        { kind: 'fill', selector: '#email', value: 'typed@example.com' },
        { kind: 'fill', selector: '#pw', value: '' },
        { kind: 'click', selector: '#go' },
        { kind: 'goto', route: 'https://accounts.example.com/next' },
      ],
      secrets: { '#pw': 'replay-secret-pass' },
      passwordOnly: ['#pw'],
      allowedOrigin: ORIGIN,
    };
    await ex.replay(req);
    const body = client.bodies[0];
    expect(JSON.stringify(body)).not.toMatch(
      /replay-secret-pass|typed@example/,
    );
    expect(body.url).toBe(`${ORIGIN}/login`);
    expect(body.clicks).toEqual([]);
    expect(body.session).toBeNull();
    const parts = partsOf(body);
    expect(parts.allowedHosts.sort()).toEqual([
      'accounts.example.com',
      'shop.example.com',
    ]);
    const pw = body.replay![2] as { value: string; passwordOnly: boolean };
    expect(pw.passwordOnly).toBe(true);
    expect(openW(pw.value, exploreFillAad(parts, 2))).toBe(
      'replay-secret-pass',
    );
    expect((body.replay![1] as { passwordOnly: boolean }).passwordOnly).toBe(
      false,
    );
    // Потерянный секрет — внятный отказ, как в функции.
    const b = make('B');
    await expect(b.ex.replay({ ...req, secrets: {} })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('ответ и ожидание', () => {
  it('итог: полный адрес из конверта, кадры, новая сессия, предупреждения, кандидаты', async () => {
    const { client, ex } = make('A');
    client.statuses = [{ status: 'running', startedAt: 't' }, done()];
    const r = await ex.runRound(REQ);
    expect(r.exploration.currentUrl).toBe(`${ORIGIN}/checkout?email=a%40b.c`);
    expect(r.exploration.screenshotDataUrl).toBe(
      `data:image/jpeg;base64,${JPEG.toString('base64')}`,
    );
    expect(r.exploration.videoFrameDataUrl).toBe(
      `data:image/png;base64,${PNG.toString('base64')}`,
    );
    expect(r.cookies.map((c) => c.value)).toEqual(['new-session']);
    expect(r.exploration.elements[0].danger).toBeDefined();
    expect(r.exploration.elements[1].candidates).toEqual([
      { kind: 'id', selector: '#next' },
    ]);
    expect(r.exploration.dangerWarning).toBeDefined();
    expect(r.exploration.redirectWarning).toBeDefined();
  });

  it('адрес в конверте — другой экран, чем видел sites-backend: берётся открытый', async () => {
    const { client, ex } = make('A');
    client.statuses = [done({}, `${ORIGIN}/elsewhere?x=1`)];
    const r = await ex.runRound(REQ);
    expect(r.exploration.currentUrl).toBe(`${ORIGIN}/checkout`);
  });

  it('адрес итога вне сайта черновика — 400 (замок генератора)', async () => {
    const { client, ex } = make('A');
    client.statuses = [
      done(
        { currentUrl: 'https://evil.example.org/' },
        'https://evil.example.org/',
      ),
    ];
    await expect(ex.runRound(REQ)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('воркер не взял раунд вовремя — отмена ожидающего и функция; взял — ждём итога', async () => {
    const a = make('B');
    a.client.statuses = [{ status: 'queued' }];
    await expect(a.ex.runRound(REQ)).rejects.toBeInstanceOf(
      WorkerFallbackError,
    );
    expect(a.client.cancels).toEqual([{ running: false }]);
    const b = make('B');
    b.client.cancelAnswer = 'running';
    b.client.statuses = [
      ...Array.from({ length: 7 }, () => ({ status: 'queued' as const })),
      { status: 'running', startedAt: 't' },
      done(),
    ];
    const r = await b.ex.runRound(REQ);
    expect(r.exploration.currentUrl).toContain('/checkout');
    expect(b.client.cancels).toEqual([{ running: false }]);
  });

  it('взятый раунд дольше бюджета — отмена идущего и 504', async () => {
    const { client, ex } = make('B');
    client.statuses = [{ status: 'running', startedAt: 't' }];
    await expect(ex.runRound(REQ)).rejects.toBeInstanceOf(
      GatewayTimeoutException,
    );
    expect(client.cancels).toEqual([{ running: true }]);
  });

  it('ключ человека: telegramId или отпечаток сайта', () => {
    expect(
      exploreSubject({
        requester: { telegramId: '42' },
        allowedOrigin: ORIGIN,
      }),
    ).toBe('tg-42');
    expect(
      exploreSubject({
        requester: { telegramId: 'x;drop' },
        allowedOrigin: ORIGIN,
      }),
    ).toMatch(/^o-[0-9a-f]{24}$/);
  });
});
