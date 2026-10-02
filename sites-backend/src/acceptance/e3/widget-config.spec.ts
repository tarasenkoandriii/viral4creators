/**
 * Э3 (W): публичный конфиг (engagement/handoff/goals), identify с лидом,
 * 👎 → очередь обучения, forget (хвост L ДО удаления + отвязка лидов) — по
 * HTTP на настоящем Postgres под ролью виджета. Стыки H/A/L — подделки
 * (testing/widget-stack), разбор вовлечения — настоящий (T).
 */
import { Logger } from '@nestjs/common';
import * as request from 'supertest';
import { WIDGET_VISITOR_TOKEN_HEADER } from '../../brand';
import {
  describeDb,
  randomV6Prefix,
} from '../../modules/assist-sandbox/testing/k3-stack.testing';
import { parseEngagementConfig } from '../../modules/assist-site-setup/engagement-config';
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
      pathMasks: ['/catalog*'],
      text: { ru: 'Подсказать про доставку?' },
      onAccept: {
        kind: 'prefill',
        question: { ru: 'Сколько стоит доставка?' },
      },
    },
    {
      key: 'hidden',
      enabled: false,
      condition: { kind: 'exit_intent' },
      pathMasks: [],
      text: { ru: 'Выключенный' },
      onAccept: { kind: 'open' },
    },
  ],
  limits: {
    perVisit: 2,
    excludedPaths: ['/checkout*'],
    notOnFirstScreenMobile: true,
  },
  scenarios: [
    {
      key: 'pick-tour',
      enabled: true,
      title: { ru: 'Подобрать тур' },
      steps: [
        {
          key: 'where',
          question: { ru: 'Куда?' },
          answer: {
            type: 'choice',
            options: [{ key: 'sea', label: { ru: 'Море' } }],
          },
        },
      ],
      final: { kind: 'lead' },
      showInGreeting: true,
    },
  ],
};

describeDb('Э3 (W): конфиг, identify, 👎 и forget по HTTP', () => {
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
  async function ask(token: string): Promise<{ cid: string; mid: string }> {
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
    return { cid: r.body.data.conversationId, mid: r.body.data.messageId };
  }

  it('config: engagement — только публичная часть (выключенный триггер не уходит, из config убрано); handoff и goals — от H/A', async () => {
    expect(parseEngagementConfig(ENGAGEMENT).ok).toBe(true);
    const f = await widgetFixture(stack, [{ host: domain() }], {
      engagement: ENGAGEMENT,
    });
    stack.goals.goals = [
      {
        key: 'call',
        detectors: [{ kind: 'click', config: { auto: 'tel' } }],
        valueMode: 'none',
      },
    ];
    const r = await request(srv())
      .get(`/widget/v1/config?pk=${f.pk}`)
      .expect(200);
    const d = r.body.data;
    expect(d.config.engagement).toBeUndefined();
    expect(d.engagement.triggers.map((t: { key: string }) => t.key)).toEqual([
      'delivery',
    ]);
    expect(d.engagement.scenarios.map((s: { key: string }) => s.key)).toEqual([
      'pick-tour',
    ]);
    expect(d.engagement.limits.perVisit).toBe(2);
    expect(d.handoff).toEqual({
      enabled: true,
      etaMinutes: 4,
      etaText: { ru: '~4 минуты' },
    });
    expect(d.goals).toEqual(stack.goals.goals);
  });

  it('config: суточный потолок сайта/платформы или месячная квота диалогов выбраны → status lead_only (загрузчик гасит сигналы); иначе active', async () => {
    const f = await widgetFixture(stack, [{ host: domain() }], {
      engagement: ENGAGEMENT,
    });
    const status = async () =>
      (await request(srv()).get(`/widget/v1/config?pk=${f.pk}`).expect(200))
        .body.data.status as string;
    expect(await status()).toBe('active');
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const period = now.toISOString().slice(0, 7);
    // Деньги сайта: потолок 5000 мкUSD, потрачено 4990 — минимальный ответ не влезет.
    await stack.prisma.assistSite.update({
      where: { siteId: f.siteId },
      data: { dailyCapMicroUsd: 5_000 },
    });
    await stack.prisma.$executeRawUnsafe(
      `INSERT INTO "sites"."assist_budget_days" ("scope","key","day","spentMicroUsd","reservedMicroUsd","updatedAt")
       VALUES ('site', $1, $2, 4990, 0, now())`,
      f.siteId,
      day,
    );
    expect(await status()).toBe('lead_only');
    // Потолок подняли — снова active (оценка ответа влезает).
    await stack.prisma.assistSite.update({
      where: { siteId: f.siteId },
      data: { dailyCapMicroUsd: 50_000_000 },
    });
    expect(await status()).toBe('active');
    // Платформа: потолок 0 (env) — сигналы гаснут у всех.
    const saved = process.env.ASSIST_WIDGET_PLATFORM_DAILY_CAP_USD;
    process.env.ASSIST_WIDGET_PLATFORM_DAILY_CAP_USD = '0';
    try {
      expect(await status()).toBe('lead_only');
    } finally {
      if (saved === undefined)
        delete process.env.ASSIST_WIDGET_PLATFORM_DAILY_CAP_USD;
      else process.env.ASSIST_WIDGET_PLATFORM_DAILY_CAP_USD = saved;
    }
    expect(await status()).toBe('active');
    // Месячная квота диалогов выбрана.
    await stack.prisma.$executeRawUnsafe(
      `INSERT INTO "sites"."assist_site_period_usage" ("siteId","period","dialogs","quota","updatedAt")
       VALUES ($1, $2, 3, 3, now())`,
      f.siteId,
      period,
    );
    expect(await status()).toBe('lead_only');
  });

  it('config: передача выключена → enabled false; сбой H/A — поле отсутствует, конфиг 200 (не 500 на всех посетителей)', async () => {
    const f = await widgetFixture(stack, [{ host: domain() }]);
    stack.handoff.availabilityValue = {
      available: false,
      reason: 'disabled',
      etaMinutes: null,
      etaText: {},
    };
    let r = await request(srv())
      .get(`/widget/v1/config?pk=${f.pk}`)
      .expect(200);
    expect(r.body.data.handoff.enabled).toBe(false);
    expect(r.body.data.engagement).toBeUndefined();
    stack.handoff.availabilityValue = {
      available: false,
      reason: 'off_hours',
      etaMinutes: 7,
      etaText: {},
    };
    r = await request(srv()).get(`/widget/v1/config?pk=${f.pk}`).expect(200);
    expect(r.body.data.handoff).toEqual({
      enabled: true,
      etaMinutes: 7,
      etaText: {},
    });
    const origA = stack.handoff.availability;
    const origG = stack.goals.publicGoals;
    stack.handoff.availability = () => Promise.reject(new Error('boom'));
    stack.goals.publicGoals = () => Promise.reject(new Error('boom'));
    try {
      r = await request(srv()).get(`/widget/v1/config?pk=${f.pk}`).expect(200);
      expect(r.body.data.handoff).toBeUndefined();
      expect(r.body.data.goals).toBeUndefined();
      expect(r.body.data.status).toBe('active');
    } finally {
      stack.handoff.availability = origA;
      stack.goals.publicGoals = origG;
      stack.handoff.availabilityValue = {
        available: true,
        reason: null,
        etaMinutes: 4,
        etaText: { ru: '~4 минуты' },
      };
    }
  });

  it('лид + identify: в A уходит урезанная identity (К-3); без identify — null', async () => {
    const f = await widgetFixture(stack, [{ host: domain() }]);
    const token = await visitor(f);
    await post('/widget/v1/lead', token, {
      conversationId: null,
      fields: { phone: '+380671234567' },
      consent: true,
      uiLang: 'ru',
      pageUrl: null,
      identity: {
        name: 'Олена',
        email: 'olena@example.com',
        externalId: 'c-9',
        userHash: 'f'.repeat(64),
        cart: ['x'],
      },
    }).expect(200);
    expect(stack.leads.inputs.at(-1)!.identity).toEqual({
      name: 'Олена',
      email: 'olena@example.com',
      externalId: 'c-9',
      userHash: 'f'.repeat(64),
    });
    await post('/widget/v1/lead', token, {
      conversationId: null,
      fields: { phone: '+380671234567' },
      consent: true,
      uiLang: 'ru',
      pageUrl: null,
    }).expect(200);
    expect(stack.leads.inputs.at(-1)!.identity).toBeNull();
  });

  it('👎 на ответ модели → сигнал wrong/thumbs_down с маскированным вопросом; 👍 — нет; ошибка сигнала не роняет оценку', async () => {
    const f = await widgetFixture(stack, [{ host: domain() }]);
    const token = await visitor(f);
    const { cid, mid } = await ask(token);
    // Вопрос в базе — как его записал бы конвейер (маска, но страхуемся ещё раз).
    await stack.prisma.assistSiteMessage.updateMany({
      where: { conversationId: cid, role: 'visitor' },
      data: { text: 'Мой номер +380 67 123 45 67, сколько доставка?' },
    });
    const n = stack.signals.signals.length;
    await post('/widget/v1/feedback', token, {
      messageId: mid,
      rating: 1,
    }).expect(200);
    expect(stack.signals.signals.length).toBe(n);
    await post('/widget/v1/feedback', token, {
      messageId: mid,
      rating: -1,
    }).expect(200);
    const s = stack.signals.signals.at(-1)!;
    expect(s).toMatchObject({
      accountId: f.accountId,
      siteId: f.siteId,
      kind: 'wrong',
      signal: 'thumbs_down',
      conversationId: cid,
      messageId: mid,
      suspicious: false,
      embedding: null,
    });
    expect(s.questionMasked).not.toMatch(/123\s?45\s?67/);
    expect(s.questionMasked).toContain('сколько доставка?');
    // Отказ/шаблон — unhappy.
    await stack.prisma.assistSiteMessage.update({
      where: { id: mid },
      data: { answerPath: 'refusal' },
    });
    await post('/widget/v1/feedback', token, {
      messageId: mid,
      rating: -1,
    }).expect(200);
    expect(stack.signals.signals.at(-1)!.kind).toBe('unhappy');
    const orig = stack.signals.record;
    stack.signals.record = () => Promise.reject(new Error('db down'));
    try {
      await post('/widget/v1/feedback', token, {
        messageId: mid,
        rating: -1,
      }).expect(200);
    } finally {
      stack.signals.record = orig;
    }
  });

  it('forget: хвост L ставится ДО удаления (id диалогов ещё в базе); лиды остаются без visitorId (под ролью); указатели удалены', async () => {
    const f = await widgetFixture(stack, [{ host: domain() }]);
    const token = await visitor(f);
    const other = await visitor(f);
    const a = await ask(token);
    const b = await ask(token);
    const c = await ask(other);
    const own = await stack.prisma.assistSiteConversation.findUniqueOrThrow({
      where: { id: a.cid },
      select: { visitorId: true },
    });
    const otherVisitor = (
      await stack.prisma.assistSiteConversation.findUniqueOrThrow({
        where: { id: c.cid },
        select: { visitorId: true },
      })
    ).visitorId;
    const lead = (visitorId: string, conversationId: string | null) =>
      stack.prisma.assistSiteLead.create({
        data: {
          accountId: f.accountId,
          siteId: f.siteId,
          conversationId,
          visitorId,
          fieldsEnc: 'enc',
          fieldNames: ['phone'],
          consentText: 'Согласен',
          consentAt: new Date(),
        },
      });
    const mine = await lead(own.visitorId, a.cid);
    const mine2 = await lead(own.visitorId, null);
    const theirs = await lead(otherVisitor, c.cid);
    const r = await post('/widget/v1/forget', token).expect(200);
    expect(r.body.data.conversationsDeleted).toBe(2);
    const job = stack.forget.jobs.at(-1)!;
    expect(job.siteId).toBe(f.siteId);
    expect([...job.conversationIds].sort()).toEqual([a.cid, b.cid].sort());
    expect(job.liveAtEnqueue).toBe(2);
    const leads = await stack.prisma.assistSiteLead.findMany({
      where: { id: { in: [mine.id, mine2.id, theirs.id] } },
      select: { id: true, visitorId: true, conversationId: true },
    });
    const by = new Map(leads.map((l) => [l.id, l]));
    expect(by.get(mine.id)).toMatchObject({
      visitorId: null,
      conversationId: null,
    });
    expect(by.get(mine2.id)!.visitorId).toBeNull();
    expect(by.get(theirs.id)).toMatchObject({
      visitorId: otherVisitor,
      conversationId: c.cid,
    });
    expect(
      await stack.prisma.assistSiteVisitorResume.count({
        where: { siteId: f.siteId, visitorId: own.visitorId },
      }),
    ).toBe(0);
    // Повтор — 0 и без нового задания.
    const jobs = stack.forget.jobs.length;
    const again = await post('/widget/v1/forget', token).expect(200);
    expect(again.body.data.conversationsDeleted).toBe(0);
    expect(stack.forget.jobs.length).toBe(jobs);
  });

  it('forget: сбой постановки хвоста — диалоги НЕ удаляются (иначе дословные варианты остались бы навсегда)', async () => {
    const f = await widgetFixture(stack, [{ host: domain() }]);
    const token = await visitor(f);
    const a = await ask(token);
    const orig = stack.forget.enqueue;
    stack.forget.enqueue = () => Promise.reject(new Error('insert failed'));
    try {
      await post('/widget/v1/forget', token).expect(500);
    } finally {
      stack.forget.enqueue = orig;
    }
    expect(
      await stack.prisma.assistSiteConversation.count({ where: { id: a.cid } }),
    ).toBe(1);
  });
});
