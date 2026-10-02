/**
 * Э3 (W): передача человеку — сторона виджета по HTTP (ТЗ §3.7; контракт
 * Э3 §5 «W → H», §6). Стык с H — подделка из testing/widget-stack
 * (записывает вход): здесь проверяется, что W допускает и режет — токен,
 * частота ДО вызова H (5/ч), только свой диалог, сценарий передачи — из
 * опубликованного вида, identify — до формы WidgetIdentity, отмена — только
 * своя, `state` несёт передачу всегда (и при совпавшем since), событие
 * стрима `handoff` и JSON-путь чата, `openedBy` нового диалога.
 * Настоящая H под ролью — widget-integration.spec.ts.
 */
import { Logger } from '@nestjs/common';
import * as request from 'supertest';
import { WIDGET_VISITOR_TOKEN_HEADER } from '../../brand';
import { HANDOFF_DEFAULTS } from '../../config/assist-defaults';
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
      text: { ru: 'Подсказать про доставку?' },
      onAccept: { kind: 'open' },
    },
  ],
  limits: {
    perVisit: 1,
    excludedPaths: ['/checkout*'],
    notOnFirstScreenMobile: true,
  },
  scenarios: [
    {
      key: 'call-me',
      enabled: true,
      title: { ru: 'Связаться' },
      steps: [],
      final: { kind: 'handoff' },
      showInGreeting: true,
    },
  ],
};

describeDb('Э3 (W): передача человеку — сторона виджета', () => {
  let stack: WidgetStack;
  const srv = () => stack.app.getHttpServer();

  beforeAll(async () => {
    if (!process.env.W2_DEBUG) Logger.overrideLogger(false);
    stack = await startWidgetStack();
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
  async function conversation(token: string, openedBy?: string) {
    const r = await post('/widget/v1/chat', token, {
      conversationId: null,
      clientRequestId: newRequestId(),
      question: 'Позовите человека',
      page: { url: null, title: null },
      context: null,
      uiLang: 'ru',
      ...(openedBy !== undefined ? { openedBy } : {}),
    })
      .set('Accept', 'application/json')
      .expect(200);
    return r.body.data.conversationId as string;
  }

  it('POST handoff: свой диалог → H.request (reason visitor, identify урезан); ответ — форма human', async () => {
    const f = await widgetFixture(stack, [{ host: domain() }], {
      engagement: ENGAGEMENT,
    });
    const token = await visitor(f);
    const cid = await conversation(token);
    const r = await post('/widget/v1/handoff', token, {
      conversationId: cid,
      uiLang: 'ru',
      pageUrl: 'https://x.example/a?email=a@b.c#z',
      identity: {
        name: 'Іван',
        email: 'ivan@example.com',
        externalId: 'cust-1',
        userHash: 'a'.repeat(64),
        phone: '+380671234567',
      },
    }).expect(200);
    expect(r.body.data).toMatchObject({
      mode: 'human',
      existing: false,
      etaMinutes: 4,
      handoff: { state: 'waiting' },
    });
    const req = stack.handoff.requests.at(-1)!;
    expect(req).toMatchObject({
      conversationId: cid,
      reason: 'visitor',
      escalation: null,
      uiLang: 'ru',
      pageUrl: 'https://x.example/a',
    });
    expect(req.site.siteId).toBe(f.siteId);
    expect(req.identity).toEqual({
      name: 'Іван',
      email: 'ivan@example.com',
      externalId: 'cust-1',
      userHash: 'a'.repeat(64),
    });
    // Повторное нажатие — та же передача (H), не новая.
    const again = await post('/widget/v1/handoff', token, {
      conversationId: cid,
    }).expect(200);
    expect(again.body.data).toMatchObject({ mode: 'human', existing: true });
  });

  it('чужой диалог не передаётся (conversationId → null → форма заявки); старое тело Э2 `{}` — тоже форма', async () => {
    const f = await widgetFixture(stack, [{ host: domain() }]);
    const a = await visitor(f);
    const b = await visitor(f);
    const cid = await conversation(a);
    const r = await post('/widget/v1/handoff', b, {
      conversationId: cid,
    }).expect(200);
    expect(r.body.data).toEqual({ mode: 'lead', reason: 'no_conversation' });
    expect(stack.handoff.requests.at(-1)!.conversationId).toBeNull();
    const e2 = await post('/widget/v1/handoff', b, {}).expect(200);
    expect(e2.body.data.mode).toBe('lead');
  });

  it('сценарий передачи — reason scenario, только ключ ОПУБЛИКОВАННОГО сценария', async () => {
    const f = await widgetFixture(stack, [{ host: domain() }], {
      engagement: ENGAGEMENT,
    });
    const token = await visitor(f);
    const cid = await conversation(token);
    await post('/widget/v1/handoff', token, {
      conversationId: cid,
      scenarioKey: 'call-me',
    }).expect(200);
    expect(stack.handoff.requests.at(-1)!.reason).toBe('scenario');
    const c2 = await conversation(token);
    await post('/widget/v1/handoff', token, {
      conversationId: c2,
      scenarioKey: 'unknown-one',
    }).expect(200);
    expect(stack.handoff.requests.at(-1)!.reason).toBe('visitor');
    await post('/widget/v1/handoff', token, {
      conversationId: c2,
      scenarioKey: 'Bad Key!',
    }).expect(400);
  });

  it(`частота ДО вызова H: ${HANDOFF_DEFAULTS.requestsPerVisitorPerHour}/ч на посетителя, дальше 429 и H не зовётся`, async () => {
    const f = await widgetFixture(stack, [{ host: domain() }]);
    const token = await visitor(f);
    const before = stack.handoff.requests.length;
    for (let i = 0; i < HANDOFF_DEFAULTS.requestsPerVisitorPerHour; i++) {
      await post('/widget/v1/handoff', token, {}).expect(200);
    }
    const r = await post('/widget/v1/handoff', token, {}).expect(429);
    expect(r.body.error.code).toBe('RATE_LIMITED');
    expect(stack.handoff.requests.length - before).toBe(
      HANDOFF_DEFAULTS.requestsPerVisitorPerHour,
    );
  });

  it('без токена / Origin страницы — отказ (как у чата)', async () => {
    const f = await widgetFixture(stack, [{ host: domain() }]);
    const token = await visitor(f);
    await request(srv())
      .post('/widget/v1/handoff')
      .set('Origin', W_ORIGIN)
      .send({})
      .expect(401);
    const r = await request(srv())
      .post('/widget/v1/handoff')
      .set('Origin', f.hosts[0].origin)
      .set(WIDGET_VISITOR_TOKEN_HEADER, token)
      .send({});
    expect(r.status).toBe(403);
  });

  it('state несёт передачу (и при совпавшем since); cancel — только свой диалог', async () => {
    const f = await widgetFixture(stack, [{ host: domain() }]);
    const a = await visitor(f);
    const b = await visitor(f);
    const cid = await conversation(a);
    const s0 = await request(srv())
      .get('/widget/v1/state')
      .set(WIDGET_VISITOR_TOKEN_HEADER, a)
      .expect(200);
    expect(s0.body.data.conversation.handoff).toBeNull();
    await post('/widget/v1/handoff', a, { conversationId: cid }).expect(200);
    const v = s0.body.data.conversation.stateVersion as number;
    const s1 = await request(srv())
      .get(`/widget/v1/state?since=${v}`)
      .set(WIDGET_VISITOR_TOKEN_HEADER, a)
      .expect(200);
    expect(s1.body.data.conversation.messages).toEqual([]);
    expect(s1.body.data.conversation.handoff).toMatchObject({
      state: 'waiting',
    });
    // Чужой посетитель не отменяет и не узнаёт о диалоге.
    await post('/widget/v1/handoff/cancel', b, { conversationId: cid }).expect(
      404,
    );
    expect(stack.handoff.cancels.some((c) => c.conversationId === cid)).toBe(
      false,
    );
    await post('/widget/v1/handoff/cancel', a, { conversationId: cid }).expect(
      200,
    );
    expect(stack.handoff.cancels.at(-1)).toMatchObject({
      siteId: f.siteId,
      conversationId: cid,
    });
    const s2 = await request(srv())
      .get('/widget/v1/state')
      .set(WIDGET_VISITOR_TOKEN_HEADER, a)
      .expect(200);
    expect(s2.body.data.conversation.handoff.state).toBe('cancelled');
    await post('/widget/v1/handoff/cancel', a, {
      conversationId: 'x y',
    }).expect(400);
  });

  it('openedBy: user / ключ опубликованного вида — в конвейер; чужой ключ и мусор — null', async () => {
    const f = await widgetFixture(stack, [{ host: domain() }], {
      engagement: ENGAGEMENT,
    });
    const token = await visitor(f);
    const cases: Array<[string | undefined, string | undefined]> = [
      ['proactive:delivery', 'proactive:delivery'],
      ['scenario:call-me', 'scenario:call-me'],
      ['user', 'user'],
      ['proactive:nope', undefined],
      ['scenario:delivery', undefined],
      ['admin', undefined],
      [undefined, undefined],
    ];
    for (const [sent, expected] of cases) {
      await conversation(token, sent);
      expect(stack.chat.inputs.at(-1)!.openedBy).toBe(expected);
    }
  });

  it('событие стрима handoff проходит в SSE; JSON-путь отдаёт handoff без ответа модели', async () => {
    const f = await widgetFixture(stack, [{ host: domain() }]);
    const token = await visitor(f);
    const cid = await conversation(token);
    const orig = stack.chat.ask.bind(stack.chat);
    stack.chat.ask = async function* () {
      yield { type: 'handoff', state: 'active', relayed: true };
      yield { type: 'done', usage: { in: 0, out: 0, cached: 0 } };
    };
    try {
      const sse = await post('/widget/v1/chat', token, {
        conversationId: cid,
        clientRequestId: newRequestId(),
        question: 'Когда доставка?',
        page: { url: null, title: null },
        context: null,
        uiLang: 'ru',
      })
        .set('Accept', 'text/event-stream')
        .buffer(true)
        .parse((res, cb) => {
          let t = '';
          res.on('data', (c: Buffer) => (t += c.toString()));
          res.on('end', () => cb(null, t));
        })
        .expect(200);
      expect(sse.body as string).toContain('event: handoff');
      expect(sse.body as string).toContain('"relayed":true');
      const json = await post('/widget/v1/chat', token, {
        conversationId: cid,
        clientRequestId: newRequestId(),
        question: 'Когда доставка?',
        page: { url: null, title: null },
        context: null,
        uiLang: 'ru',
      })
        .set('Accept', 'application/json')
        .expect(200);
      expect(json.body.data).toEqual({
        conversationId: cid,
        messageId: '',
        text: '',
        sources: [],
        actions: [],
        refused: false,
        streaming: false,
        handoff: { state: 'active', relayed: true },
      });
    } finally {
      stack.chat.ask = orig;
    }
  });
});
