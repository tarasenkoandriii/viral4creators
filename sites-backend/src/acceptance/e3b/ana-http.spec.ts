/**
 * Приёмка Э3-бис по HTTP (настоящие гварды, CORS, конверт; ТЗ §5-тер.14,
 * §5-тер.16 п.13, §5-тер.13 «кто что видит»):
 *  - `POST /widget/v1/pv`: Origin = допущенный хост pk + ключ визита → 204;
 *    неизвестное поле итога → 400; чужой/выключенный хост → 403; без ключа
 *    визита (нет согласия) → 400; sendBeacon text/plain — принимается;
 *  - `POST /widget/v1/exp`, `/ref`: только связанный режим;
 *  - `GET /widget/v1/config`: поле `analytics` — только при связанном режиме;
 *  - кабинет Э3-бис: оператор помощника — 403 на каждом маршруте; менеджер
 *    — читает, но не запускает эксперимент (403); владелец — запускает.
 */
import * as request from 'supertest';
import {
  describeDb,
  randomV6Prefix,
} from '../../modules/assist-sandbox/testing/k3-stack.testing';
import {
  domain,
  startWidgetStack,
  widgetFixture,
  type WidgetFixture,
  type WidgetStack,
} from '../../modules/assist-widget/testing/widget-stack.testing';
import { visitKey } from '../../modules/assist-analytics/testing/ai-stack.testing';
import {
  PV_PER_IP_PER_MINUTE,
  WidgetAnalyticsService,
} from '../../modules/assist-widget/widget-analytics.service';
import {
  TEST_ASSIST_TOKEN,
  signInitData,
} from '../../modules/telegram-auth/test-init-data';

jest.setTimeout(120_000);

describeDb('Приёмка Э3-бис: маршруты по HTTP', () => {
  let stack: WidgetStack;
  let f: WidgetFixture;
  const srv = () => stack.app.getHttpServer();
  const ip = () => `${randomV6Prefix()}::9`;
  let tgNext = 7_900_000_000 + Math.floor(Math.random() * 1_000_000) * 10;

  beforeAll(async () => {
    stack = await startWidgetStack();
    f = await widgetFixture(stack, [
      { host: domain() },
      { host: domain(), enabled: false },
    ]);
    const now = Date.now();
    await stack.prisma.assistSubscription.create({
      data: {
        accountId: f.accountId,
        planId: 'business',
        status: 'active',
        method: 'manual',
        anchorAt: new Date(now - 86_400_000),
        paidThrough: new Date(now + 30 * 86_400_000),
      },
    });
    await stack.prisma.assistSite.update({
      where: { siteId: f.siteId },
      data: {
        analytics: { linked: true, behavior: true, linkedWindowDays: 7 },
      },
    });
  });
  afterAll(async () => {
    await stack?.close();
  });

  const pvBody = (over: Record<string, unknown> = {}) => ({
    pk: f.pk,
    pv: `pv${Date.now()}${Math.random().toString(36).slice(2, 8)}`,
    v: visitKey(),
    p: '/catalog/42',
    d: 'm',
    sc: 75,
    ac: 8000,
    to: 15000,
    ck: 2,
    ...over,
  });
  const post = (
    path: string,
    origin: string | null,
    body: unknown,
    text = false,
  ) => {
    const r = request(srv()).post(path).set('X-Forwarded-For', ip());
    if (origin) r.set('Origin', origin);
    return text
      ? r
          .set('Content-Type', 'text/plain;charset=UTF-8')
          .send(JSON.stringify(body))
      : r.send(body as object);
  };

  it('pv: допущенный хост + ключ визита → 204 (и text/plain); неизвестное поле → 400; нет ключа → 400', async () => {
    await post('/widget/v1/pv', f.hosts[0].origin, pvBody()).expect(204);
    await post('/widget/v1/pv', f.hosts[0].origin, pvBody(), true).expect(204);
    const rows = await stack.prisma.assistSitePageView.findMany({
      where: { siteId: f.siteId },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].path).toBe('/catalog/:id');
    await post(
      '/widget/v1/pv',
      f.hosts[0].origin,
      pvBody({ value: 'secret' }),
    ).expect(400);
    await post(
      '/widget/v1/pv',
      f.hosts[0].origin,
      pvBody({ keys: 'abc' }),
    ).expect(400);
    const { v: _v, ...noVisit } = pvBody();
    await post('/widget/v1/pv', f.hosts[0].origin, noVisit).expect(400);
  });

  it('аудит: итоги просмотра с одного адреса сверх лимита в минуту не принимаются (квоту чужого сайта не выбрать)', async () => {
    const svc = stack.app.get(WidgetAnalyticsService);
    const now = new Date();
    const addr = ip();
    const count = () =>
      stack.prisma.assistSitePageView.count({ where: { siteId: f.siteId } });
    const before = await count();
    const send = (at: Date, ipAddr = addr) =>
      svc.pageView(
        {
          body: pvBody(),
          origin: f.hosts[0].origin,
          ip: ipAddr,
          contentLength: undefined,
          userAgent: 'test',
        },
        at,
      );
    for (let i = 0; i < PV_PER_IP_PER_MINUTE + 5; i++) await send(now);
    expect((await count()) - before).toBe(PV_PER_IP_PER_MINUTE);
    // Другой адрес и следующая минута — принимаются.
    await send(now, ip());
    await send(new Date(now.getTime() + 60_000));
    expect((await count()) - before).toBe(PV_PER_IP_PER_MINUTE + 2);
  });

  it('pv/exp/ref: чужой сайт и выключенный хост → 403 ORIGIN_DENIED', async () => {
    for (const o of ['https://evil.example.com', f.hosts[1].origin]) {
      const r = await post('/widget/v1/pv', o, pvBody()).expect(403);
      expect(r.body.error.code).toBe('ORIGIN_DENIED');
      await post('/widget/v1/exp', o, {
        pk: f.pk,
        x: 'e1',
        v: visitKey(),
      }).expect(403);
      await post('/widget/v1/ref', o, { pk: f.pk, v: visitKey() }).expect(403);
    }
  });

  it('ref и exp: связанный режим включён — ref выдаётся; без него — null; лишнее поле — 400', async () => {
    const r = await post('/widget/v1/ref', f.hosts[0].origin, {
      pk: f.pk,
      v: visitKey(),
    }).expect(200);
    expect(r.body.data.ref).toMatch(/^r1\./);
    await post('/widget/v1/exp', f.hosts[0].origin, {
      pk: f.pk,
      x: 'none',
      v: visitKey(),
    }).expect(204);
    await post('/widget/v1/exp', f.hosts[0].origin, {
      pk: f.pk,
      x: 'none',
      v: visitKey(),
      arm: 'b',
    }).expect(400);
    await stack.prisma.assistSite.update({
      where: { siteId: f.siteId },
      data: { analytics: { linked: false } },
    });
    const off = await post('/widget/v1/ref', f.hosts[0].origin, {
      pk: f.pk,
      v: visitKey(),
    }).expect(200);
    expect(off.body.data.ref).toBeNull();
    const cfg = await request(srv())
      .get(`/widget/v1/config?pk=${f.pk}`)
      .expect(200);
    expect(cfg.body.data.analytics).toBeUndefined();
    await stack.prisma.assistSite.update({
      where: { siteId: f.siteId },
      data: {
        analytics: { linked: true, behavior: true, linkedWindowDays: 7 },
      },
    });
    const on = await request(srv())
      .get(`/widget/v1/config?pk=${f.pk}`)
      .expect(200);
    expect(on.body.data.analytics).toEqual({
      consent: { gcm: false },
      behavior: true,
      experiment: null,
    });
  });

  it('кабинет: оператор — 403 везде; менеджер читает, но не запускает эксперимент; владелец — запускает (мощность)', async () => {
    const add = async (role: 'manager' | 'operator') => {
      const tg = BigInt(tgNext++);
      await stack.prisma.siteAccountMember.create({
        data: {
          accountId: f.accountId,
          telegramId: tg,
          role,
          productRoles: { qa: 'none', assist: role, assistAdmin: 'none' },
        },
      });
      return tg;
    };
    const manager = await add('manager');
    const operator = await add('operator');
    const as = (tg: bigint) => ({
      'X-Telegram-App': 'assist',
      'X-Telegram-Init-Data': signInitData({
        botToken: TEST_ASSIST_TOKEN,
        userId: Number(tg),
      }),
    });
    const id = f.siteId;
    const q = 'from=2026-09-01&to=2026-09-07';
    const routes: Array<['get' | 'post' | 'patch', string, object?]> = [
      ['get', `/assist/sites/${id}/ai/summary?${q}`],
      ['get', `/assist/sites/${id}/ai/dialogs?${q}`],
      [
        'patch',
        `/assist/sites/${id}/conversations/c1/label`,
        { intent: 'price' },
      ],
      ['get', `/assist/sites/${id}/stats/insights`],
      ['patch', `/assist/sites/${id}/insights/i1`, { status: 'done' }],
      ['get', `/assist/sites/${id}/stats/behavior?${q}`],
      ['get', `/assist/sites/${id}/experiments`],
      [
        'post',
        `/assist/sites/${id}/experiments/preview`,
        { kind: 'holdout', goalKey: 'order' },
      ],
      [
        'post',
        `/assist/sites/${id}/experiments`,
        { kind: 'holdout', goalKey: 'order' },
      ],
      ['post', `/assist/sites/${id}/experiments/e1/stop`],
    ];
    for (const [m, url, body] of routes) {
      const r = request(srv())[m](url).set(as(operator));
      await (body ? r.send(body) : r).expect(403);
    }
    await request(srv())
      .get(`/assist/sites/${id}/ai/summary?${q}`)
      .set(as(manager))
      .expect(200);
    await request(srv())
      .get(`/assist/sites/${id}/stats/behavior?${q}`)
      .set(as(manager))
      .expect(200);
    const mgr = await request(srv())
      .post(`/assist/sites/${id}/experiments`)
      .set(as(manager))
      .send({ kind: 'holdout', goalKey: 'order' })
      .expect(403);
    expect(mgr.body.error.code).toBe('EXPERIMENT_OWNER_ONLY');
    // Владелец: нет цели «order» — 400 (до мощности дело не доходит).
    const own = await request(srv())
      .post(`/assist/sites/${id}/experiments`)
      .set(as(f.owner))
      .send({ kind: 'holdout', goalKey: 'order' })
      .expect(400);
    expect(own.body.error.code).toBe('EXPERIMENT_GOAL');
    // Режим согласия меняет только владелец.
    const bad = await request(srv())
      .patch(`/assist/sites/${id}/analytics-settings`)
      .set(as(manager))
      .send({ config: { linked: false } })
      .expect(403);
    expect(bad.body.error.code).toBe('ANALYTICS_OWNER_ONLY');
  });
});
