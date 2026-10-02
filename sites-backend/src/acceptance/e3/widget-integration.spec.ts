/**
 * Э3 (W): маршруты виджета с НАСТОЯЩИМИ стыками H/A/L под логин-ролью
 * `assist_public` (startWidgetStack({ real })) — то, что подделки не
 * поймают: права роли на новые таблицы Э3 (колоночные GRANT), форма строк,
 * которые пишут владельцы стыков, по вызову W. Бизнес-правила стыков —
 * спеки владельцев (H handoff*, A goals/attribution, L forget/learning).
 */
import { Logger } from '@nestjs/common';
import * as request from 'supertest';
import { WIDGET_VISITOR_TOKEN_HEADER } from '../../brand';
import {
  describeDb,
  randomV6Prefix,
} from '../../modules/assist-sandbox/testing/k3-stack.testing';
import {
  W_ORIGIN,
  domain,
  newRequestId,
  startWidgetStack,
  widgetFixture,
  type WidgetFixture,
  type WidgetStack,
} from '../../modules/assist-widget/testing/widget-stack.testing';

const ENGAGEMENT = {
  schema: 1,
  triggers: [
    {
      key: 'delivery',
      enabled: true,
      condition: { kind: 'time_on_page', seconds: 15 },
      pathMasks: [],
      text: { ru: 'Подсказать?' },
      onAccept: { kind: 'open' },
    },
  ],
  limits: { perVisit: 1, excludedPaths: [], notOnFirstScreenMobile: true },
  scenarios: [],
};

describeDb('Э3 (W): маршруты виджета с настоящими H/A/L под ролью', () => {
  let stack: WidgetStack;
  const srv = () => stack.app.getHttpServer();

  beforeAll(async () => {
    if (!process.env.W2_DEBUG) Logger.overrideLogger(false);
    stack = await startWidgetStack({
      real: ['handoff', 'goals', 'events', 'signals', 'forget'],
    });
  });
  afterAll(async () => stack?.close());

  async function visitor(f: WidgetFixture): Promise<string> {
    const r = await request(srv())
      .post('/widget/v1/session')
      .set('Origin', W_ORIGIN)
      .set('X-Forwarded-For', `${randomV6Prefix()}::1`)
      .send({ pk: f.pk, parentOrigin: f.hosts[0].origin })
      .expect(200);
    return r.body.data.visitorToken as string;
  }
  const post = (path: string, token: string, body: unknown = {}) =>
    request(srv())
      .post(path)
      .set('Origin', W_ORIGIN)
      .set(WIDGET_VISITOR_TOKEN_HEADER, token)
      .send(body as object);
  async function ask(token: string) {
    const r = await post('/widget/v1/chat', token, {
      conversationId: null,
      clientRequestId: newRequestId(),
      question: 'Сколько стоит доставка?',
      page: { url: null, title: null },
      context: null,
      uiLang: 'ru',
    })
      .set('Accept', 'application/json')
      .expect(200);
    return {
      cid: r.body.data.conversationId as string,
      mid: r.body.data.messageId as string,
    };
  }

  it('event: EventCounts пишет суточные счётчики под ролью (UPSERT), чужой ключ не пишется', async () => {
    const f = await widgetFixture(stack, [{ host: domain() }], {
      engagement: ENGAGEMENT,
    });
    for (let i = 0; i < 2; i++) {
      await request(srv())
        .post('/widget/v1/event')
        .set('Origin', f.hosts[0].origin)
        .set('Content-Type', 'text/plain')
        .send(
          JSON.stringify({
            pk: f.pk,
            events: [
              { kind: 'widget_view', key: null },
              { kind: 'proactive_shown', key: 'delivery' },
              { kind: 'proactive_shown', key: 'made-up' },
            ],
          }),
        )
        .expect(204);
    }
    const rows = await stack.prisma.assistSiteEventCount.findMany({
      where: { siteId: f.siteId },
    });
    const sum = (kind: string, key = '') =>
      rows
        .filter((r) => r.kind === kind && r.key === key)
        .reduce((a, r) => a + r.count, 0);
    expect(sum('widget_view')).toBe(2);
    expect(sum('proactive_shown', 'delivery')).toBe(2);
    expect(sum('proactive_shown', 'made-up')).toBe(0);
  });

  it('goal: загрузчик → unassisted; iframe с диалогом → assisted; клик по действию ≤ 30 мин → direct; двойной orderId — одно', async () => {
    const f = await widgetFixture(stack, [{ host: domain() }]);
    await stack.prisma.assistSiteGoal.create({
      data: {
        accountId: f.accountId,
        siteId: f.siteId,
        key: 'purchase',
        template: 'purchase',
        name: 'Покупка',
        detectors: [
          { kind: 'js', config: {} },
          { kind: 'click', config: { auto: 'tel' } },
        ],
        valueMode: 'event',
      },
    });
    const goal = (
      origin: string,
      body: Record<string, unknown>,
      token?: string,
    ) => {
      const r = request(srv()).post('/widget/v1/goal').set('Origin', origin);
      if (token) r.set(WIDGET_VISITOR_TOKEN_HEADER, token);
      return r.send(body);
    };
    await goal(f.hosts[0].origin, {
      pk: f.pk,
      goalKey: 'purchase',
      detector: 'js',
      docId: 'doc_loader0001',
      path: '/thanks',
      orderId: 'A-1',
    }).expect(204);
    await goal(f.hosts[0].origin, {
      pk: f.pk,
      goalKey: 'purchase',
      detector: 'js',
      docId: 'doc_loader0002',
      path: '/thanks',
      orderId: 'A-1',
    }).expect(204);
    const token = await visitor(f);
    const { cid } = await ask(token);
    await goal(
      W_ORIGIN,
      {
        goalKey: 'purchase',
        detector: 'click',
        docId: 'doc_iframe0001',
        path: '/p',
        conversationId: cid,
        assist: { proactive: null, scenario: null, link: false },
      },
      token,
    ).expect(204);
    await goal(
      W_ORIGIN,
      {
        goalKey: 'purchase',
        detector: 'js',
        docId: 'doc_iframe0002',
        path: '/p',
        orderId: 'B-2',
        conversationId: cid,
        lastAssistClickAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        assist: { proactive: null, scenario: null, link: true },
      },
      token,
    ).expect(204);
    await goal(f.hosts[0].origin, {
      pk: f.pk,
      goalKey: 'purchase',
      detector: 'js',
      docId: 'doc_loader0003',
      path: '/thanks',
      orderId: 'ivan@example.com',
    }).expect(422);
    // Стык W→A: формат W пройден (одни цифры), но это телефон — решает
    // НАСТОЯЩИЙ GoalIntake (validOrderId) → тот же 422 GOAL_ORDER_ID_INVALID
    // на обоих входах (загрузчик и iframe), события нет.
    const phone = await goal(f.hosts[0].origin, {
      pk: f.pk,
      goalKey: 'purchase',
      detector: 'js',
      docId: 'doc_loader0004',
      path: '/thanks',
      orderId: '380501234567',
    }).expect(422);
    expect(phone.body.error.code).toBe('GOAL_ORDER_ID_INVALID');
    const phoneIframe = await goal(
      W_ORIGIN,
      {
        goalKey: 'purchase',
        detector: 'js',
        docId: 'doc_iframe0003',
        path: '/p',
        orderId: '380501234567',
        conversationId: cid,
        assist: { proactive: null, scenario: null, link: false },
      },
      token,
    ).expect(422);
    expect(phoneIframe.body.error.code).toBe('GOAL_ORDER_ID_INVALID');
    const ev = await stack.prisma.assistSiteGoalEvent.findMany({
      where: { siteId: f.siteId },
      orderBy: { receivedAt: 'asc' },
      select: {
        source: true,
        attribution: true,
        orderId: true,
        conversationId: true,
      },
    });
    expect(ev).toEqual([
      {
        source: 'loader',
        attribution: 'unassisted',
        orderId: 'A-1',
        conversationId: null,
      },
      {
        source: 'iframe',
        attribution: 'assisted',
        orderId: null,
        conversationId: cid,
      },
      {
        source: 'iframe',
        attribution: 'direct',
        orderId: 'B-2',
        conversationId: cid,
      },
    ]);
  });

  it('state и cancel: передача из базы видна посетителю; waiting → cancelled', async () => {
    const f = await widgetFixture(stack, [{ host: domain() }]);
    const token = await visitor(f);
    const { cid } = await ask(token);
    const h = await stack.prisma.assistSiteHandoff.create({
      data: {
        accountId: f.accountId,
        siteId: f.siteId,
        conversationId: cid,
        reason: 'visitor',
        timeoutAt: new Date(Date.now() + 5 * 60_000),
      },
    });
    await stack.prisma.assistSiteConversation.update({
      where: { id: cid },
      data: { handoffState: 'waiting' },
    });
    const s = await request(srv())
      .get('/widget/v1/state')
      .set(WIDGET_VISITOR_TOKEN_HEADER, token)
      .expect(200);
    expect(s.body.data.conversation.handoff).toMatchObject({
      id: h.id,
      state: 'waiting',
    });
    await post('/widget/v1/handoff/cancel', token, {
      conversationId: cid,
    }).expect(200);
    const row = await stack.prisma.assistSiteHandoff.findUniqueOrThrow({
      where: { id: h.id },
    });
    expect(row.state).toBe('cancelled');
  });

  it('👎 → строка очереди обучения под ролью; forget → задание хвоста и отвязка лидов, очередь из диалога — каскадом', async () => {
    const f = await widgetFixture(stack, [{ host: domain() }]);
    const token = await visitor(f);
    const { cid, mid } = await ask(token);
    await post('/widget/v1/feedback', token, {
      messageId: mid,
      rating: -1,
    }).expect(200);
    const items = await stack.prisma.assistSiteLearningItem.findMany({
      where: { siteId: f.siteId },
      select: {
        kind: true,
        signal: true,
        messageId: true,
        conversationId: true,
      },
    });
    expect(items).toEqual([
      {
        kind: 'wrong',
        signal: 'thumbs_down',
        messageId: mid,
        conversationId: cid,
      },
    ]);
    const conv = await stack.prisma.assistSiteConversation.findUniqueOrThrow({
      where: { id: cid },
      select: { visitorId: true },
    });
    await stack.prisma.assistSiteLead.create({
      data: {
        accountId: f.accountId,
        siteId: f.siteId,
        conversationId: cid,
        visitorId: conv.visitorId,
        fieldsEnc: 'enc',
        fieldNames: ['phone'],
        consentText: 'Согласен',
        consentAt: new Date(),
      },
    });
    await post('/widget/v1/forget', token).expect(200);
    const jobs = await stack.prisma.assistSiteForgetJob.findMany({
      where: { siteId: f.siteId },
    });
    expect(jobs.map((j) => j.conversationIds)).toEqual([[cid]]);
    expect(
      await stack.prisma.assistSiteLearningItem.count({
        where: { siteId: f.siteId },
      }),
    ).toBe(0);
    const leads = await stack.prisma.assistSiteLead.findMany({
      where: { siteId: f.siteId },
      select: { visitorId: true, conversationId: true },
    });
    expect(leads).toEqual([{ visitorId: null, conversationId: null }]);
  });
});
