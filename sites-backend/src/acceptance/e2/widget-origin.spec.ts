/**
 * Приёмка Э2 п.3 (серверная часть) и 5а (frame-ancestors) — W2, по HTTP на
 * настоящем Postgres под ролью assist_public:
 *  - неподтверждённый хост, поддомен подтверждённого apex, чужой домен,
 *    хост не включён в опубликованном виде → ORIGIN_DENIED;
 *  - отзыв подтверждения → 72 ч работает (и в живой сессии), затем
 *    ORIGIN_DENIED — с ПОДМЕНОЙ ЧАСОВ (подделывается только Date);
 *  - `GET /w/v1/frame` — CSP `frame-ancestors` ровно с допущенными origin,
 *    неизвестный pk — тот же HTML с `'none'` (не оракул).
 */
import { Logger } from '@nestjs/common';
import * as request from 'supertest';
import {
  WIDGET_PK_LIVE_PREFIX,
  WIDGET_VISITOR_TOKEN_HEADER,
} from '../../brand';
import { describeDb } from '../../modules/assist-sandbox/testing/k3-stack.testing';
import { frameHtml } from '../../modules/assist-widget/frame-html';
import {
  DAY,
  HOUR,
  TMA_ORIGIN,
  W_ORIGIN,
  domain,
  startWidgetStack,
  widgetFixture,
  type WidgetStack,
} from '../../modules/assist-widget/testing/widget-stack.testing';

// Поднятие стенда и HTTP-серии под нагрузкой CI дольше 5 с по умолчанию.
jest.setTimeout(30_000);

/** Подменяем ТОЛЬКО Date: таймеры, pg и supertest живут по настоящему времени. */
function setClock(at: Date): void {
  jest.useFakeTimers({
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
    now: at,
  });
}

function frameAncestorsOf(csp: string | undefined): string[] {
  const m = /frame-ancestors ([^;]+)/.exec(csp ?? '');
  return m ? m[1].trim().split(/\s+/) : [];
}

describeDb('Э2 п.3 и 5а: гвард origin виджета и frame-ancestors (W2)', () => {
  let stack: WidgetStack;
  const srv = () => stack.app.getHttpServer();

  beforeAll(async () => {
    if (!process.env.W2_DEBUG) Logger.overrideLogger(false);
    stack = await startWidgetStack();
  });
  afterAll(async () => {
    jest.useRealTimers();
    await stack?.close();
  });
  afterEach(() => jest.useRealTimers());

  function session(pk: string, parentOrigin: string, origin = W_ORIGIN) {
    const r = request(srv()).post('/widget/v1/session');
    if (origin) r.set('Origin', origin);
    return r.send({ pk, parentOrigin });
  }
  function state(token: string) {
    return request(srv())
      .get('/widget/v1/state')
      .set('Origin', W_ORIGIN)
      .set(WIDGET_VISITOR_TOKEN_HEADER, token);
  }

  it('подтверждённый и включённый хост — сессия выдаётся, токен работает', async () => {
    const d = domain();
    const f = await widgetFixture(stack, [{ host: d }]);
    const r = await session(f.pk, `https://${d}`).expect(200);
    expect(r.body.data.visitorToken).toEqual(expect.any(String));
    expect(r.body.data.preview).toBe(false);
    await state(r.body.data.visitorToken).expect(200);
  });

  it('неподтверждённый хост, поддомен подтверждённого apex, чужой домен — ORIGIN_DENIED', async () => {
    const apex = domain();
    const pending = domain();
    const f = await widgetFixture(stack, [
      { host: apex },
      { host: pending, status: 'pending' },
    ]);
    for (const parent of [
      `https://${pending}`,
      `https://shop.${apex}`,
      `https://www.${apex}`,
      `https://${domain('evil')}`,
    ]) {
      const r = await session(f.pk, parent).expect(403);
      expect(r.body.error.code).toBe('ORIGIN_DENIED');
    }
  });

  it('origin родителя — только ТОЧНОЕ совпадение (схема, порт, без пути и слэша)', async () => {
    const d = domain();
    const f = await widgetFixture(stack, [{ host: d }]);
    for (const parent of [
      `http://${d}`,
      `https://${d}:8443`,
      `https://${d}/`,
      `https://${d}/catalog`,
      `https://${d.toUpperCase()}`,
      'null',
      '',
    ]) {
      const r = await session(f.pk, parent).expect(403);
      expect(r.body.error.code).toBe('ORIGIN_DENIED');
    }
  });

  it('хост подтверждён, но не включён в ОПУБЛИКОВАННОМ виде — ORIGIN_DENIED', async () => {
    const on = domain();
    const off = domain();
    const f = await widgetFixture(stack, [
      { host: on },
      { host: off, enabled: false },
    ]);
    await session(f.pk, `https://${on}`).expect(200);
    const r = await session(f.pk, `https://${off}`).expect(403);
    expect(r.body.error.code).toBe('ORIGIN_DENIED');
  });

  it('Origin запроса — только origin виджета; иной или без него — ORIGIN_DENIED', async () => {
    const d = domain();
    const f = await widgetFixture(stack, [{ host: d }]);
    for (const origin of [`https://${d}`, 'https://evil.example.com', '']) {
      const r = await session(f.pk, `https://${d}`, origin).expect(403);
      expect(r.body.error.code).toBe('ORIGIN_DENIED');
    }
    // И для маршрутов по токену: токен, украденный скриптом страницы, с
    // origin страницы не работает.
    const ok = await session(f.pk, `https://${d}`).expect(200);
    const r = await request(srv())
      .get('/widget/v1/state')
      .set('Origin', `https://${d}`)
      .set(WIDGET_VISITOR_TOKEN_HEADER, ok.body.data.visitorToken)
      .expect(403);
    expect(r.body.error.code).toBe('ORIGIN_DENIED');
  });

  it('test-ключ — только localhost/127.0.0.1; live-ключ на localhost — нет', async () => {
    const d = domain();
    const f = await widgetFixture(stack, [{ host: d }]);
    await session(f.testPk, 'http://localhost:5173').expect(200);
    await session(f.testPk, 'https://127.0.0.1:8443').expect(200);
    expect(
      (await session(f.testPk, `https://${d}`).expect(403)).body.error.code,
    ).toBe('ORIGIN_DENIED');
    expect(
      (await session(f.pk, 'http://localhost:5173').expect(403)).body.error
        .code,
    ).toBe('ORIGIN_DENIED');
  });

  it('неизвестный pk — WIDGET_UNKNOWN_KEY; не опубликован — WIDGET_DISABLED', async () => {
    const d = domain();
    const f = await widgetFixture(stack, [{ host: d }], { publish: false });
    expect(
      (
        await session(
          `${WIDGET_PK_LIVE_PREFIX}${'A'.repeat(24)}`,
          `https://${d}`,
        ).expect(404)
      ).body.error.code,
    ).toBe('WIDGET_UNKNOWN_KEY');
    expect(
      (await session(f.pk, `https://${d}`).expect(403)).body.error.code,
    ).toBe('WIDGET_DISABLED');
  });

  it('отзыв подтверждения: 72 ч работает (в т.ч. живая сессия), затем ORIGIN_DENIED — подмена часов', async () => {
    const d = domain();
    const f = await widgetFixture(stack, [{ host: d }]);
    const t0 = new Date();
    const parent = `https://${d}`;
    const before = await session(f.pk, parent).expect(200);
    await stack.prisma.siteHost.update({
      where: { id: f.hosts[0].id },
      data: { status: 'revoked', revokedAt: t0 },
    });

    // Сразу после отзыва — льгота: старая сессия и новая работают.
    await state(before.body.data.visitorToken).expect(200);
    setClock(new Date(t0.getTime() + 71 * HOUR));
    const late = await session(f.pk, parent).expect(200);
    await state(late.body.data.visitorToken).expect(200);
    expect(
      frameAncestorsOf(
        (await request(srv()).get(`/w/v1/frame?pk=${f.pk}`).expect(200))
          .headers['content-security-policy'],
      ),
    ).toEqual([parent]);

    // 72 ч + 1 мин: живой токен (выдан в льготе, ещё не истёк) — отказ.
    setClock(new Date(t0.getTime() + 72 * HOUR + 60_000));
    const r = await state(late.body.data.visitorToken).expect(403);
    expect(r.body.error.code).toBe('ORIGIN_DENIED');
    expect((await session(f.pk, parent).expect(403)).body.error.code).toBe(
      'ORIGIN_DENIED',
    );
    expect(
      frameAncestorsOf(
        (await request(srv()).get(`/w/v1/frame?pk=${f.pk}`).expect(200))
          .headers['content-security-policy'],
      ),
    ).toEqual(["'none'"]);
  });

  it('истёкшее подтверждение (expiresAt) — та же льгота 72 ч от срока', async () => {
    const d = domain();
    const t0 = new Date();
    const f = await widgetFixture(stack, [
      { host: d, status: 'verified', expiresAt: new Date(t0.getTime() - HOUR) },
    ]);
    await session(f.pk, `https://${d}`).expect(200);
    setClock(new Date(t0.getTime() + 72 * HOUR));
    expect(
      (await session(f.pk, `https://${d}`).expect(403)).body.error.code,
    ).toBe('ORIGIN_DENIED');
  });

  it('отзыв ДРУГИМ кабинетом (блокировка повторного подтверждения) — без льготы, сразу', async () => {
    const d = domain();
    const f = await widgetFixture(stack, [{ host: d }]);
    const ok = await session(f.pk, `https://${d}`).expect(200);
    await stack.prisma.siteHost.update({
      where: { id: f.hosts[0].id },
      data: {
        status: 'revoked',
        revokedAt: new Date(),
        reverifyBlockedAt: new Date(),
      },
    });
    expect(
      (await state(ok.body.data.visitorToken).expect(403)).body.error.code,
    ).toBe('ORIGIN_DENIED');
  });

  it("5а: frame-ancestors — только включённые допущенные хосты; неизвестный pk — тот же HTML и 'none'", async () => {
    const on = domain();
    const off = domain();
    const pending = domain();
    const f = await widgetFixture(stack, [
      { host: on },
      { host: off, enabled: false },
      { host: pending, status: 'pending' },
    ]);
    const r = await request(srv()).get(`/w/v1/frame?pk=${f.pk}`).expect(200);
    expect(r.headers['content-type']).toMatch(/^text\/html/);
    expect(r.headers['x-frame-options']).toBeUndefined();
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['cache-control']).toBe('public, max-age=0, s-maxage=300');
    const csp = r.headers['content-security-policy'];
    expect(frameAncestorsOf(csp)).toEqual([`https://${on}`]);
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("require-trusted-types-for 'script'");
    expect(r.text).toBe(frameHtml());

    const unknown = await request(srv())
      .get(`/w/v1/frame?pk=${WIDGET_PK_LIVE_PREFIX}${'Z'.repeat(24)}`)
      .expect(200);
    expect(
      frameAncestorsOf(unknown.headers['content-security-policy']),
    ).toEqual(["'none'"]);
    expect(unknown.text).toBe(r.text);
    const garbage = await request(srv())
      .get('/w/v1/frame?pk=%3Bscript-src%20*')
      .expect(200);
    expect(
      frameAncestorsOf(garbage.headers['content-security-policy']),
    ).toEqual(["'none'"]);

    // Предпросмотр (pv=1): любой допущенный хост сайта + предки конфигуратора TMA.
    const pv = await request(srv())
      .get(`/w/v1/frame?pk=${f.pk}&pv=1`)
      .expect(200);
    expect(
      frameAncestorsOf(pv.headers['content-security-policy']).sort(),
    ).toEqual([`https://${on}`, `https://${off}`, TMA_ORIGIN].sort());

    // test-ключ — только localhost/127.0.0.1 любого порта.
    const t = await request(srv())
      .get(`/w/v1/frame?pk=${f.testPk}`)
      .expect(200);
    expect(frameAncestorsOf(t.headers['content-security-policy'])).toEqual([
      'http://localhost:*',
      'https://localhost:*',
      'http://127.0.0.1:*',
      'https://127.0.0.1:*',
    ]);
  });

  it('конфиг виджета: hosts — только включённые допущенные origin, без решения о допуске', async () => {
    const on = domain();
    const off = domain();
    const f = await widgetFixture(stack, [
      { host: on },
      { host: off, enabled: false },
    ]);
    const r = await request(srv())
      .get(`/widget/v1/config?pk=${f.pk}`)
      .set('Origin', `https://${domain('any')}`)
      .expect(200);
    expect(r.headers['access-control-allow-origin']).toBe('*');
    expect(r.headers['cache-control']).toBe(
      'public, max-age=300, s-maxage=300',
    );
    const c = r.body.data;
    expect(c.status).toBe('active');
    expect(c.widgetVersion).toBe(1);
    expect(c.hosts).toEqual([
      { origin: `https://${on}`, pathMasks: [], hideOn: ['/checkout*'] },
    ]);
    expect(c.config.hosts).toBeUndefined();
    expect(c.lead.fields.length).toBeGreaterThan(0);
    expect(c.poweredByUrl).toEqual(expect.any(String));
    // Рубильник владельца — форма заявки вместо чата (не «выключено»).
    await stack.prisma.assistSite.update({
      where: { siteId: f.siteId },
      data: { chatPaused: true },
    });
    const paused = await request(srv())
      .get(`/widget/v1/config?pk=${f.pk}`)
      .expect(200);
    expect(paused.body.data.status).toBe('lead_only');
    expect(
      (await request(srv()).get('/widget/v1/config?pk=nope').expect(404)).body
        .error.code,
    ).toBe('WIDGET_UNKNOWN_KEY');
  });

  it('сутки спустя токен истекает — SESSION_EXPIRED; битый/чужой подписью — SESSION_REQUIRED', async () => {
    const d = domain();
    const f = await widgetFixture(stack, [{ host: d }]);
    const s = await session(f.pk, `https://${d}`).expect(200);
    const token: string = s.body.data.visitorToken;
    expect((await state(token + 'x').expect(401)).body.error.code).toBe(
      'SESSION_REQUIRED',
    );
    expect(
      (
        await request(srv())
          .get('/widget/v1/state')
          .set('Origin', W_ORIGIN)
          .expect(401)
      ).body.error.code,
    ).toBe('SESSION_REQUIRED');
    setClock(new Date(Date.now() + DAY + 60_000));
    expect((await state(token).expect(401)).body.error.code).toBe(
      'SESSION_EXPIRED',
    );
  });
});
