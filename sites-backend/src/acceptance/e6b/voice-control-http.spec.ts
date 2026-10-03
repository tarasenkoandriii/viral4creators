/**
 * Э6-бис (а) по HTTP на настоящем Postgres под ролью виджета: конфиг
 * виджета (`voiceControl` — только при голосе и переключателе `on`),
 * маршруты `/widget/v1/ui-plan*` (допуск visitor-token, конверт ошибок,
 * VOICE_CONTROL_OFF, PLAN_CHANGED/PLAN_CONFLICT, лимит планов), без
 * visitor-token — отказ: скрипт страницы (`V4CAssist('ask')`, `postMessage`)
 * сюда не дотягивается — токен живёт в хранилище iframe.
 */
import * as request from 'supertest';
import { createHash, randomBytes } from 'crypto';
import {
  WIDGET_VISITOR_TOKEN_HEADER,
  WIDGET_VOICE_TEST_HEADER,
} from '../../brand';
import { setPlan } from '../../modules/assist-billing/testing/billing-fixtures.testing';
import { VOICE_CONTROL_DEFAULTS } from '../../modules/assist-site-voice-control/voice-control-config';
import { SNAPSHOT_LIMITS } from '../../modules/assist-ui-core/snapshot';
import {
  describeDb,
  randomV6Prefix,
} from '../../modules/assist-sandbox/testing/k3-stack.testing';
import {
  W_ORIGIN,
  domain,
  startWidgetStack,
  widgetFixture,
  type WidgetFixture,
  type WidgetStack,
} from '../../modules/assist-widget/testing/widget-stack.testing';

jest.setTimeout(120_000);

describeDb('Э6-бис: голосовое управление по HTTP', () => {
  let stack: WidgetStack;
  const srv = () => stack.app.getHttpServer();
  const saved = process.env.SONIOX_API_KEY;

  beforeAll(async () => {
    process.env.SONIOX_API_KEY = 'sx-http-test';
    stack = await startWidgetStack();
  });
  afterAll(async () => {
    await stack?.close();
    if (saved === undefined) delete process.env.SONIOX_API_KEY;
    else process.env.SONIOX_API_KEY = saved;
  });

  async function site(state = 'on', input = true): Promise<WidgetFixture> {
    const f = await widgetFixture(stack, [{ host: domain('e6b') }]);
    await setPlan(stack.prisma, f.accountId, 'business');
    await stack.prisma.assistSite.update({
      where: { siteId: f.siteId },
      data: {
        voiceConfig: { schema: 1, input, output: false, voiceId: null },
        voiceControlSiteState: state,
        voiceControlSiteRules: { schema: 1, denySelectors: ['#admin-panel'] },
      },
    });
    return f;
  }

  async function token(f: WidgetFixture): Promise<string> {
    const r = await request(srv())
      .post('/widget/v1/session')
      .set('Origin', W_ORIGIN)
      .set('X-Forwarded-For', `${randomV6Prefix()}::1`)
      .send({ pk: f.pk, parentOrigin: f.hosts[0].origin })
      .expect(200);
    return r.body.data.visitorToken as string;
  }

  const body = (f: WidgetFixture, text: string) => ({
    text,
    source: 'typed',
    lang: 'uk',
    snapshot: {
      url: `${f.hosts[0].origin}/`,
      elements: [
        {
          ref: 'e1',
          role: 'link',
          tag: 'a',
          text: 'Доставка',
          href: `${f.hosts[0].origin}/delivery`,
        },
        {
          ref: 'e2',
          role: 'button',
          tag: 'button',
          text: 'Надіслати',
          submit: true,
          inForm: true,
        },
      ],
    },
  });

  it('конфиг: voiceControl есть только при голосе и переключателе on (запреты — загрузчику); off/без микрофона — нет поля', async () => {
    const on = await site();
    const off = await site('off');
    const noMic = await site('on', false);
    const cfg = async (f: WidgetFixture) =>
      (await request(srv()).get(`/widget/v1/config?pk=${f.pk}`).expect(200))
        .body.data;
    expect((await cfg(on)).voiceControl).toEqual({
      mode: 'on',
      denySelectors: ['#admin-panel'],
      allowSelectors: [],
      maxSteps: 6,
      // (е) Опубликованных мемо нет — iframe не спрашивает «Я умею».
      memos: false,
    });
    expect((await cfg(off)).voiceControl).toBeUndefined();
    expect((await cfg(noMic)).voiceControl).toBeUndefined();
  });

  it('план по HTTP: набранная команда → план; без visitor-token — 401; выключено — 403 VOICE_CONTROL_OFF', async () => {
    const f = await site();
    const t = await token(f);
    const no = await request(srv())
      .post('/widget/v1/ui-plan')
      .set('Origin', W_ORIGIN)
      .send(body(f, 'відкрий доставку'))
      .expect(401);
    expect(no.body.error.code).toBe('SESSION_REQUIRED');
    const r = await request(srv())
      .post('/widget/v1/ui-plan')
      .set('Origin', W_ORIGIN)
      .set(WIDGET_VISITOR_TOKEN_HEADER, t)
      .send(body(f, 'відкрий доставку'))
      .expect(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body.data).toMatchObject({ kind: 'plan', status: 'confirmed' });
    expect(r.body.data.steps[0]).toMatchObject({
      kind: 'click',
      nav: true,
      risk: 'auto',
    });

    const g = await site('off');
    const tg = await token(g);
    const off = await request(srv())
      .post('/widget/v1/ui-plan')
      .set('Origin', W_ORIGIN)
      .set(WIDGET_VISITOR_TOKEN_HEADER, tg)
      .send(body(g, 'відкрий доставку'))
      .expect(403);
    expect(off.body.error).toMatchObject({
      code: 'VOICE_CONTROL_OFF',
      message: 'Голосовое управление на этом сайте не включено',
    });
  });

  it('шаги по HTTP: dispatched → done; повтор dispatched — 409 PLAN_CONFLICT; активный план; стоп', async () => {
    const f = await site();
    const t = await token(f);
    const post = (path: string, b: unknown) =>
      request(srv())
        .post(path)
        .set('Origin', W_ORIGIN)
        .set(WIDGET_VISITOR_TOKEN_HEADER, t)
        .send(b as object);
    const r = await post(
      '/widget/v1/ui-plan',
      body(f, 'відкрий доставку'),
    ).expect(200);
    const id = r.body.data.planId as string;
    await post(`/widget/v1/ui-plan/${id}/step`, {
      index: 0,
      result: 'dispatched',
    }).expect(200);
    const again = await post(`/widget/v1/ui-plan/${id}/step`, {
      index: 0,
      result: 'dispatched',
    }).expect(409);
    expect(again.body.error.code).toBe('PLAN_CONFLICT');
    const act = await request(srv())
      .get('/widget/v1/ui-plan/active')
      .set('Origin', W_ORIGIN)
      .set(WIDGET_VISITOR_TOKEN_HEADER, t)
      .expect(200);
    expect(act.body.data.plan).toMatchObject({ planId: id, status: 'running' });
    await post(`/widget/v1/ui-plan/${id}/step`, {
      index: 0,
      result: 'done',
      url: `${f.hosts[0].origin}/delivery`,
    }).expect(200);
    const stop = await post(`/widget/v1/ui-plan/${id}/stop`, {
      by: 'esc',
    }).expect(200);
    expect(stop.body.data.status).toBe('done');
  });

  it('подтверждение по HTTP: чужой отпечаток — 409 PLAN_CHANGED; верный — confirmed; мусорный id — 404', async () => {
    const f = await site();
    const t = await token(f);
    const post = (path: string, b: unknown) =>
      request(srv())
        .post(path)
        .set('Origin', W_ORIGIN)
        .set(WIDGET_VISITOR_TOKEN_HEADER, t)
        .send(b as object);
    const r = await post(
      '/widget/v1/ui-plan',
      body(f, 'натисни Надіслати'),
    ).expect(200);
    expect(r.body.data).toMatchObject({
      status: 'proposed',
      needsConfirm: true,
    });
    const id = r.body.data.planId as string;
    const bad = await post(`/widget/v1/ui-plan/${id}/confirm`, {
      by: 'button',
      stepsHash: 'nope',
    }).expect(409);
    expect(bad.body.error.code).toBe('PLAN_CHANGED');
    const ok = await post(`/widget/v1/ui-plan/${id}/confirm`, {
      by: 'button',
      stepsHash: r.body.data.stepsHash,
    }).expect(200);
    expect(ok.body.data.status).toBe('confirmed');
    await post('/widget/v1/ui-plan/..%2Fx/confirm', {
      by: 'button',
      stepsHash: 'x',
    }).expect(404);
  });

  it('аудит: тело больше VOICE_CONTROL_DEFAULTS.maxBodyBytes — 413 UI_PLAN_TOO_LARGE до маршрута; снимок больше SNAPSHOT_LIMITS.bodyChars — тот же код; плана нет', async () => {
    const f = await site();
    const t = await token(f);
    const send = (b: unknown) =>
      request(srv())
        .post('/widget/v1/ui-plan')
        .set('Origin', W_ORIGIN)
        .set(WIDGET_VISITOR_TOKEN_HEADER, t)
        .send(b as object);
    const elements = (n: number, len: number) =>
      Array.from({ length: n }, (_, i) => ({
        ref: `e${i + 1}`,
        role: 'button',
        tag: 'button',
        text: `Кнопка ${i} ${'x'.repeat(len)}`,
      }));
    const base = body(f, 'натисни кнопку') as { snapshot: object };
    // Тело чуть больше 96 КБ (общий потолок Nest — 100 КБ его бы пропустил),
    // снимок — маленький: режет именно потолок маршрута.
    const huge = { ...base, pad: 'x'.repeat(99_000) };
    const hugeLen = JSON.stringify(huge).length;
    expect(hugeLen).toBeGreaterThan(VOICE_CONTROL_DEFAULTS.maxBodyBytes);
    expect(hugeLen).toBeLessThan(100 * 1024);
    const r1 = await send(huge).expect(413);
    expect(r1.body).toMatchObject({
      success: false,
      error: { code: 'UI_PLAN_TOO_LARGE' },
    });
    // Под потолком тела, но снимок больше своего потолка — тот же код.
    const big = {
      ...base,
      snapshot: { ...base.snapshot, elements: elements(150, 450) },
    };
    const size = JSON.stringify(big.snapshot).length;
    expect(size).toBeGreaterThan(SNAPSHOT_LIMITS.bodyChars);
    expect(JSON.stringify(big).length).toBeLessThan(
      VOICE_CONTROL_DEFAULTS.maxBodyBytes,
    );
    const r2 = await send(big).expect(413);
    expect(r2.body.error.code).toBe('UI_PLAN_TOO_LARGE');
    expect(
      await stack.prisma.assistSiteUiPlan.count({
        where: { siteId: f.siteId },
      }),
    ).toBe(0);
  });

  it('аудит: done навигационного шага без адреса страницы — 400 BAD_REQUEST, с адресом — готово', async () => {
    const f = await site();
    const t = await token(f);
    const post = (path: string, b: unknown) =>
      request(srv())
        .post(path)
        .set('Origin', W_ORIGIN)
        .set(WIDGET_VISITOR_TOKEN_HEADER, t)
        .send(b as object);
    const r = await post(
      '/widget/v1/ui-plan',
      body(f, 'відкрий доставку'),
    ).expect(200);
    const id = r.body.data.planId as string;
    await post(`/widget/v1/ui-plan/${id}/step`, {
      index: 0,
      result: 'dispatched',
    }).expect(200);
    const no = await post(`/widget/v1/ui-plan/${id}/step`, {
      index: 0,
      result: 'done',
      url: null,
    }).expect(400);
    expect(no.body.error.code).toBe('BAD_REQUEST');
    const ok = await post(`/widget/v1/ui-plan/${id}/step`, {
      index: 0,
      result: 'done',
      url: `${f.hosts[0].origin}/delivery`,
    }).expect(200);
    expect(ok.body.data.status).toBe('done');
  });

  it('(г) режим `test`: конфиг без voiceControl, обычный посетитель — 403; ссылка мастера → тестовая сессия по заголовку → план и анализ; чужая/повторная ссылка — 403 VOICE_TEST_INVALID', async () => {
    const f = await site('test');
    const cfg = (
      await request(srv()).get(`/widget/v1/config?pk=${f.pk}`).expect(200)
    ).body.data;
    expect(cfg.voiceControl).toBeUndefined();
    expect(cfg.release).toBeUndefined();
    const t = await token(f);
    const post = (path: string, b: unknown, test?: string) => {
      const r = request(srv())
        .post(path)
        .set('Origin', W_ORIGIN)
        .set(WIDGET_VISITOR_TOKEN_HEADER, t);
      if (test) r.set(WIDGET_VOICE_TEST_HEADER, test);
      return r.send(b as object);
    };
    expect(
      (
        await post('/widget/v1/ui-plan', body(f, 'відкрий доставку')).expect(
          403,
        )
      ).body.error.code,
    ).toBe('VOICE_CONTROL_OFF');
    // Ссылка мастера (строку создаёт кабинет; в базе — хеш).
    const link = randomBytes(24).toString('base64url');
    const host = await stack.prisma.siteHost.findFirst({
      where: { siteId: f.siteId },
    });
    const row = await stack.prisma.assistSiteVoiceTest.create({
      data: {
        accountId: f.accountId,
        siteId: f.siteId,
        host: host!.host,
        origin: f.hosts[0].origin,
        tokenHash: createHash('sha256').update(link).digest('hex'),
        tokenExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    expect(
      (
        await post('/widget/v1/voice-test/session', {
          token: 'x'.repeat(32),
        }).expect(403)
      ).body.error.code,
    ).toBe('VOICE_TEST_INVALID');
    const ex = await post('/widget/v1/voice-test/session', {
      token: link,
    }).expect(200);
    expect(ex.headers['cache-control']).toBe('no-store');
    expect(ex.body.data).toMatchObject({
      testId: row.id,
      voiceControl: { mode: 'on' },
    });
    const sess = ex.body.data.session as string;
    expect(
      (await post('/widget/v1/voice-test/session', { token: link }).expect(403))
        .body.error.code,
    ).toBe('VOICE_TEST_INVALID');
    // Тестовая сессия по заголовку — план есть; сухой прогон — тоже.
    const p = await post(
      '/widget/v1/ui-plan',
      body(f, 'відкрий доставку'),
      sess,
    ).expect(200);
    expect(p.body.data.status).toBe('confirmed');
    const d = await post(
      '/widget/v1/ui-plan',
      { ...body(f, 'відкрий доставку'), dryRun: true },
      sess,
    ).expect(200);
    expect(d.body.data.status).toBe('done');
    const a = await post(
      `/widget/v1/voice-test/${row.id}/analyze`,
      { snapshot: body(f, '').snapshot },
      sess,
    ).expect(200);
    expect(a.body.data.forbidden).toHaveLength(5);
    // Без заголовка или с чужим тестом — 403.
    expect(
      (
        await post(`/widget/v1/voice-test/${row.id}/analyze`, {
          snapshot: body(f, '').snapshot,
        }).expect(403)
      ).body.error.code,
    ).toBe('VOICE_TEST_INVALID');
    expect(
      (
        await post(
          '/widget/v1/voice-test/other/analyze',
          { snapshot: body(f, '').snapshot },
          sess,
        ).expect(403)
      ).body.error.code,
    ).toBe('VOICE_TEST_INVALID');
  });

  it('лимит планов посетителя в минуту — 429 RATE_LIMITED', async () => {
    const f = await site();
    const t = await token(f);
    let limited = false;
    for (let i = 0; i < 12 && !limited; i++) {
      const r = await request(srv())
        .post('/widget/v1/ui-plan')
        .set('Origin', W_ORIGIN)
        .set(WIDGET_VISITOR_TOKEN_HEADER, t)
        .send(body(f, 'відкрий доставку'));
      limited = r.status === 429;
    }
    expect(limited).toBe(true);
  });
});
