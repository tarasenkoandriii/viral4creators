/**
 * Приёмка Э3 (A) — цели (ТЗ §5-тер.16 п.1, п.6 серверная часть; цели Э2,
 * перенесённые в Э3): встроенная заявка, URL «спасибо» и `V4CAssist('goal')`
 * — по одному событию; двойной orderId — одно; `ivan@example.com` — 422;
 * фильтры (предпросмотр, IP офиса, исключённые пути, suspicious); выбор цели
 * на сайте — токен одноразовый, 30 мин, только verified-хост; stale через 7
 * дней; CRUD целей (≤ 30, ключ занят, «Заявка» не удаляется); identify —
 * шифром, «проверен/заявлено» в доставке лида. Публичный путь — под ролью
 * assist_public. В логах — ни orderId, ни сумм, ни полей identify.
 */
import { createHash } from 'crypto';
import { WIDGET_GOAL_PICKER_PARAM } from '../../brand';
import { analyticsCodeOf } from '../../modules/assist-analytics/analytics-errors';
import {
  decryptIdentity,
  identityKey,
} from '../../modules/assist-analytics/public/identity-crypto';
import type { GoalHit } from '../../modules/assist-analytics/public/goal-intake.service';
import { userHashOf } from '../../modules/assist-analytics/integrations.service';
import {
  AnalyticsStack,
  LogCapture,
} from '../../modules/assist-analytics/testing/analytics-stack.testing';
import { describeDb } from '../../modules/assist-sandbox/testing/k3-stack.testing';
import type { ChatSite } from '../../modules/assist-site-chat/testing/chat-stack.testing';

jest.setTimeout(90_000);

const DAY = 24 * 60 * 60 * 1000;

describeDb('Приёмка Э3 (A): цели — §5-тер.16 п.1, п.6', () => {
  const st = new AnalyticsStack();
  const logs = new LogCapture();
  beforeAll(async () => {
    logs.install();
    await st.init();
  });
  afterAll(async () => {
    await st.close();
    jest.restoreAllMocks();
  });

  let doc = 0;
  function hit(over: Partial<GoalHit> = {}): GoalHit {
    return {
      goalKey: 'purchase',
      detector: 'url',
      docId: `doc-${process.pid}-${Date.now()}-${doc++}`,
      path: '/checkout/success',
      orderId: null,
      value: null,
      currency: null,
      occurredAt: new Date(),
      ...over,
    };
  }

  async function events(s: ChatSite) {
    return st.owner.assistSiteGoalEvent.findMany({
      where: { siteId: s.siteId },
      orderBy: { receivedAt: 'asc' },
    });
  }

  async function withForm(s: ChatSite) {
    await st.owner.assistSite.update({
      where: { siteId: s.siteId },
      data: {
        leadsConfig: {
          schema: 1,
          fields: [
            { field: 'name', required: false },
            { field: 'phone', required: true },
          ],
          consentText: { uk: 'Згода на обробку (ред. 1)' },
          channels: ['telegram'],
        },
      },
    });
  }

  it('п.1: заявка Помощника, URL «спасибо» и JS API goal — ровно по одному событию', async () => {
    const s = await st.site();
    const m = await st.member(s);
    // Первый вход в «Цели» сеет умолчания: «Заявка» (builtin), tel, мессенджеры.
    const list = await st.goals.list(m, s.siteId);
    expect(list.map((g) => g.key)).toEqual(['lead', 'call', 'messenger']);
    await st.goals.create(m, s.siteId, {
      key: 'purchase',
      template: 'purchase',
      name: 'Покупка',
      detectors: [
        { kind: 'url', config: { pathMask: '/checkout/success*' } },
        { kind: 'js', config: {} },
        { kind: 's2s', config: {} },
      ],
      valueMode: 'event',
      currency: 'UAH',
    });
    await withForm(s);
    const visitor = st.chat.visitor();
    await st.leads.submit({
      site: s.ctx(),
      visitor,
      conversationId: null,
      fields: { phone: '+380 67 765 43 21' },
      consent: true,
      uiLang: 'uk',
      pageUrl: s.url('/contacts?utm=x'),
    });
    const url = hit();
    expect(
      await st.intake.fromLoader({
        site: s.ctx(),
        hit: url,
        rawIp: '198.51.100.1',
      }),
    ).toBe('recorded');
    // Тот же документ — тот же URL ещё раз (F5 SPA-маршрута) — дубль.
    expect(
      await st.intake.fromLoader({
        site: s.ctx(),
        hit: { ...url },
        rawIp: null,
      }),
    ).toBe('duplicate');
    const js = hit({
      detector: 'js',
      orderId: 'A-1042',
      value: 1299,
      currency: 'UAH',
    });
    expect(
      await st.intake.fromLoader({ site: s.ctx(), hit: js, rawIp: null }),
    ).toBe('recorded');
    // Двойной вызов с тем же orderId (другой документ!) — одно событие.
    expect(
      await st.intake.fromLoader({
        site: s.ctx(),
        hit: { ...js, docId: `${js.docId}-2` },
        rawIp: null,
      }),
    ).toBe('duplicate');
    const ev = await events(s);
    expect(ev.map((e) => [e.source, e.trust, e.attribution]).sort()).toEqual(
      [
        ['builtin', 'builtin', 'direct'],
        ['loader', 'page', 'unassisted'],
        ['loader', 'page', 'unassisted'],
      ].sort(),
    );
    const lead = ev.find((e) => e.source === 'builtin')!;
    expect(lead.path).toBe('/contacts');
    const order = ev.find((e) => e.orderId === 'A-1042')!;
    expect(Number(order.value)).toBe(1299);
    expect(order.clientEventId).toBeNull();
    // В логах — ни orderId, ни сумм, ни телефона.
    expect(logs.text()).not.toMatch(/A-1042|1299|765 43 21/);
  });

  it('п.1: orderId = ivan@example.com — GOAL_ORDER_ID_INVALID (422 у W), событие не пишется', async () => {
    const s = await st.site();
    await st.goal(s, {
      key: 'purchase',
      detectors: [{ kind: 'js', config: {} }],
    });
    for (const orderId of [
      'ivan@example.com',
      '+380671234567',
      '380671234567',
    ]) {
      expect(
        await st.intake.fromLoader({
          site: s.ctx(),
          hit: hit({ detector: 'js', orderId }),
          rawIp: null,
        }),
      ).toBe('GOAL_ORDER_ID_INVALID');
    }
    // Даже для неизвестной цели — 422 (контакт в orderId — ошибка интеграции).
    expect(
      await st.intake.fromLoader({
        site: s.ctx(),
        hit: hit({
          goalKey: 'nope',
          detector: 'js',
          orderId: 'ivan@example.com',
        }),
        rawIp: null,
      }),
    ).toBe('GOAL_ORDER_ID_INVALID');
    expect(await events(s)).toEqual([]);
  });

  it('фильтры: предпросмотр, IP офиса (сырой IP), исключённый путь, пауза, чужой вид детектора, suspicious', async () => {
    const s = await st.site();
    await st.goal(s, {
      key: 'purchase',
      detectors: [
        { kind: 'url', config: { pathMask: '/thanks*', fromPathMask: null } },
      ],
    });
    await st.goal(s, {
      key: 'paused',
      status: 'paused',
      detectors: [
        { kind: 'url', config: { pathMask: '/x', fromPathMask: null } },
      ],
    });
    await st.owner.assistSite.update({
      where: { siteId: s.siteId },
      data: {
        analytics: {
          schema: 1,
          minutesPerQuestion: 3,
          officeCidrs: ['203.0.113.0/24', '2001:db8:1::/48'],
          excludedPaths: ['/internal/*'],
        },
      },
    });
    const ctx = s.ctx();
    expect(
      await st.intake.fromLoader({
        site: { ...ctx, preview: true },
        hit: hit(),
        rawIp: null,
      }),
    ).toBe('ignored');
    expect(
      await st.intake.fromLoader({
        site: ctx,
        hit: hit(),
        rawIp: '203.0.113.9',
      }),
    ).toBe('ignored');
    expect(
      await st.intake.fromLoader({
        site: ctx,
        hit: hit(),
        rawIp: '::ffff:203.0.113.10',
      }),
    ).toBe('ignored');
    expect(
      await st.intake.fromLoader({
        site: ctx,
        hit: hit(),
        rawIp: '2001:db8:1:2::5',
      }),
    ).toBe('ignored');
    expect(
      await st.intake.fromLoader({
        site: ctx,
        hit: hit({ path: '/internal/report' }),
        rawIp: null,
      }),
    ).toBe('ignored');
    expect(
      await st.intake.fromLoader({
        site: ctx,
        hit: hit({ goalKey: 'paused' }),
        rawIp: null,
      }),
    ).toBe('GOAL_UNKNOWN');
    expect(
      await st.intake.fromLoader({
        site: ctx,
        hit: hit({ goalKey: 'nope' }),
        rawIp: null,
      }),
    ).toBe('GOAL_UNKNOWN');
    // У цели нет детектора js — V4CAssist('goal', 'purchase') не принимается.
    expect(
      await st.intake.fromLoader({
        site: ctx,
        hit: hit({ detector: 'js' }),
        rawIp: null,
      }),
    ).toBe('GOAL_UNKNOWN');
    const bot = await st.conversation(s, { suspicious: true });
    expect(
      await st.intake.fromIframe({
        site: ctx,
        visitor: st.chat.visitor({ visitorId: bot.visitorId }),
        conversationId: bot.id,
        lastAssistClickAt: null,
        assist: { proactive: null, scenario: null, link: false },
        hit: hit(),
        rawIp: null,
      }),
    ).toBe('ignored');
    expect(await events(s)).toEqual([]);
    // Тот же путь с query — пишется путь без query (§6.6).
    expect(
      await st.intake.fromLoader({
        site: ctx,
        hit: hit({ path: 'https://x.example/thanks?email=a@b.c#t' }),
        rawIp: '198.51.100.1',
      }),
    ).toBe('recorded');
    expect((await events(s)).map((e) => e.path)).toEqual(['/thanks']);
  });

  it('publicGoals: загрузчику — только активные/stale цели и только детекторы загрузчика', async () => {
    const s = await st.site();
    const m = await st.member(s);
    await st.goals.list(m, s.siteId);
    await st.goal(s, {
      key: 'buy',
      detectors: [
        { kind: 's2s', config: {} },
        { kind: 'url', config: { pathMask: '/ok', fromPathMask: '/cart*' } },
      ],
      valueMode: 'event',
    });
    await st.goal(s, {
      key: 'off',
      status: 'paused',
      detectors: [{ kind: 'js', config: {} }],
    });
    const pub = await st.intake.publicGoals(s.siteId);
    expect(pub).toEqual([
      {
        key: 'buy',
        detectors: [
          { kind: 'url', config: { pathMask: '/ok', fromPathMask: '/cart*' } },
        ],
        valueMode: 'event',
      },
      {
        key: 'call',
        detectors: [{ kind: 'click', config: { auto: 'tel' } }],
        valueMode: 'none',
      },
      {
        key: 'messenger',
        detectors: [{ kind: 'click', config: { auto: 'messenger' } }],
        valueMode: 'none',
      },
    ]);
  });

  it('CRUD целей: GOAL_INVALID, GOAL_KEY_TAKEN, GOAL_LIMIT (30), «Заявка» не удаляется и не теряет builtin, чужой сайт — 404', async () => {
    const s = await st.site();
    const m = await st.member(s);
    const goals = await st.goals.list(m, s.siteId);
    const lead = goals.find((g) => g.key === 'lead')!;
    const code = async (p: Promise<unknown>) => {
      try {
        await p;
        return null;
      } catch (e) {
        return analyticsCodeOf(e);
      }
    };
    expect(await code(st.goals.create(m, s.siteId, { key: 'x' }))).toBe(
      'GOAL_INVALID',
    );
    const mk = (key: string) => ({
      key,
      template: 'custom',
      name: key,
      detectors: [{ kind: 'js', config: {} }],
    });
    expect(await code(st.goals.create(m, s.siteId, mk('call')))).toBe(
      'GOAL_KEY_TAKEN',
    );
    expect(await code(st.goals.remove(m, s.siteId, lead.id))).toBe(
      'GOAL_INVALID',
    );
    expect(
      await code(
        st.goals.patch(m, s.siteId, lead.id, {
          detectors: [{ kind: 'js', config: {} }],
        }),
      ),
    ).toBe('GOAL_INVALID');
    const paused = await st.goals.patch(m, s.siteId, lead.id, {
      status: 'paused',
    });
    expect(paused.status).toBe('paused');
    for (let i = 0; i < 27; i++)
      await st.goals.create(m, s.siteId, mk(`g${i}`));
    expect(await code(st.goals.create(m, s.siteId, mk('g99')))).toBe(
      'GOAL_LIMIT',
    );
    const other = await st.site();
    const om = await st.member(other);
    expect(await code(st.goals.list(om, s.siteId))).toBe('NOT_FOUND');
    expect(
      await code(st.goals.patch(om, s.siteId, lead.id, { name: 'x' })),
    ).toBe('NOT_FOUND');
    const g0 = (await st.goals.list(m, s.siteId)).find((g) => g.key === 'g0')!;
    await st.goals.remove(m, s.siteId, g0.id);
    expect((await st.goals.list(m, s.siteId)).length).toBe(29);
  });

  it('п.6 (сервер): ссылка выбора — только verified https-хост, 30 мин, токен в базе — хешем; результат → picked; поле ввода — не принимается', async () => {
    const s = await st.site();
    const m = await st.member(s);
    const code = async (p: Promise<unknown>) => {
      try {
        await p;
        return null;
      } catch (e) {
        return analyticsCodeOf(e);
      }
    };
    const pending = await st.owner.siteHost.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        host: `pending-${Date.now()}.example.com`,
        status: 'pending',
      },
    });
    expect(
      await code(
        st.goals.pickerToken(m, s.siteId, { hostId: pending.id, path: null }),
      ),
    ).toBe('HOST_NOT_VERIFIED');
    const host = await st.owner.siteHost.findFirstOrThrow({
      where: { siteId: s.siteId, status: 'verified' },
    });
    await st.owner.siteHost.update({
      where: { id: host.id },
      data: { expiresAt: new Date(Date.now() + 90 * DAY) },
    });
    const now = new Date();
    st.goals.now = () => now;
    const t = await st.goals.pickerToken(m, s.siteId, {
      hostId: host.id,
      path: '/product/kettle',
    });
    const u = new URL(t.url);
    expect(u.origin).toBe(s.origin);
    expect(u.pathname).toBe('/product/kettle');
    const token = u.searchParams.get(WIDGET_GOAL_PICKER_PARAM)!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(new Date(t.expiresAt).getTime() - now.getTime()).toBe(
      30 * 60 * 1000,
    );
    const row = await st.owner.assistSitePreviewToken.findUniqueOrThrow({
      where: { id: t.tokenId },
    });
    expect(row.purpose).toBe('goal');
    expect(row.tokenHash).toBe(
      createHash('sha256').update(token).digest('hex'),
    );
    expect(
      JSON.stringify(row, (_k, v: unknown) =>
        typeof v === 'bigint' ? v.toString() : v,
      ),
    ).not.toContain(token);
    expect((await st.goals.pickerStatus(m, s.siteId, t.tokenId)).status).toBe(
      'waiting',
    );
    // Загрузчик (W) пишет результат ролью виджета — колоночный UPDATE(result).
    await st.chat.publicDb.assistSitePreviewToken.updateMany({
      where: { id: t.tokenId },
      data: {
        result: {
          descriptor: {
            assistGoal: null,
            assistId: null,
            role: 'textbox',
            text: 'Телефон',
            tag: 'input',
          },
          path: '/product/kettle',
          label: 'Телефон',
          kind: 'click',
        },
      },
    });
    // Поле ввода из загрузчика не превращается в цель.
    expect((await st.goals.pickerStatus(m, s.siteId, t.tokenId)).status).toBe(
      'waiting',
    );
    await st.chat.publicDb.assistSitePreviewToken.updateMany({
      where: { id: t.tokenId },
      data: {
        result: {
          descriptor: {
            assistGoal: null,
            assistId: null,
            role: 'button',
            text: 'Оформити замовлення',
            tag: 'BUTTON',
          },
          path: '/product/kettle',
          label: 'Оформити замовлення',
          kind: 'click',
        },
      },
    });
    const picked = await st.goals.pickerStatus(m, s.siteId, t.tokenId);
    expect(picked.status).toBe('picked');
    expect(picked.result?.descriptor.tag).toBe('button');
    const t2 = await st.goals.pickerToken(m, s.siteId, {
      hostId: host.id,
      path: null,
    });
    st.goals.now = () => new Date(now.getTime() + 31 * 60 * 1000);
    expect((await st.goals.pickerStatus(m, s.siteId, t2.tokenId)).status).toBe(
      'expired',
    );
    st.goals.now = () => new Date();
  });

  it('п.6: цель с детектором страницы не срабатывала 7 дней — stale (scope своих сайтов); новое срабатывание — снова active', async () => {
    const s = await st.site();
    const gid = await st.goal(s, {
      key: 'buy',
      detectors: [
        {
          kind: 'click',
          config: {
            descriptor: {
              text: 'Купити',
              assistGoal: null,
              assistId: null,
              role: 'button',
              tag: 'button',
            },
            pathMask: null,
          },
        },
      ],
    });
    const lead = await st.goal(s, {
      key: 'lead',
      template: 'lead',
      detectors: [{ kind: 'builtin', config: { event: 'lead' } }],
    });
    const fired = new Date(Date.now() - 2 * DAY);
    await st.owner.assistSiteGoal.updateMany({
      where: { id: { in: [gid, lead] } },
      data: { lastFiredAt: fired },
    });
    const scope = { siteIds: [s.siteId] };
    await st.rollup.daily(new Date(Date.now() + 3 * DAY), scope);
    expect(
      (await st.owner.assistSiteGoal.findUniqueOrThrow({ where: { id: gid } }))
        .status,
    ).toBe('active');
    const r = await st.rollup.daily(new Date(Date.now() + 6 * DAY), scope);
    expect(r.staleGoals).toBe(1);
    expect(
      (await st.owner.assistSiteGoal.findUniqueOrThrow({ where: { id: gid } }))
        .status,
    ).toBe('stale');
    // builtin «Заявка» от вёрстки не зависит — не stale.
    expect(
      (await st.owner.assistSiteGoal.findUniqueOrThrow({ where: { id: lead } }))
        .status,
    ).toBe('active');
    // stale по-прежнему принимается; свёртка возвращает цель в active.
    expect(
      await st.intake.fromLoader({
        site: s.ctx(),
        hit: hit({ goalKey: 'buy', detector: 'click' }),
        rawIp: null,
      }),
    ).toBe('recorded');
    await st.rollup.run(new Date(), scope);
    expect(
      (await st.owner.assistSiteGoal.findUniqueOrThrow({ where: { id: gid } }))
        .status,
    ).toBe('active');
  });

  it('свёртка сеет «Заявку» сайту с опубликованным видом, даже если «Цели» не открывали', async () => {
    const s = await st.site();
    await st.rollup.run(new Date(), { siteIds: [s.siteId] });
    const keys = (
      await st.owner.assistSiteGoal.findMany({ where: { siteId: s.siteId } })
    ).map((g) => g.key);
    expect(keys.sort()).toEqual(['call', 'lead', 'messenger']);
    await st.rollup.run(new Date(), { siteIds: [s.siteId] });
    expect(
      await st.owner.assistSiteGoal.count({ where: { siteId: s.siteId } }),
    ).toBe(3);
  });

  it('identify с лидом: шифром в identityEnc; доставка — «проверен» при верном userHash, «заявлено» без секрета/с чужим', async () => {
    const s = await st.site();
    const m = await st.member(s);
    await withForm(s);
    const secret = (await st.integrations.issue(m, s.siteId, 'identity'))
      .secret;
    const submit = (userHash: string | null) =>
      st.leads.submit({
        site: s.ctx(),
        visitor: st.chat.visitor(),
        conversationId: null,
        fields: { phone: '+380 50 111 22 33' },
        consent: true,
        uiLang: 'uk',
        pageUrl: null,
        identity: {
          name: 'Олена',
          email: 'olena@example.com',
          externalId: 'customer-42',
          userHash,
        },
      });
    st.chat.sent.length = 0;
    const ok = await submit(userHashOf(secret, 'customer-42'));
    const bad = await submit(userHashOf('idsec_other', 'customer-42'));
    const okRow = await st.owner.assistSiteLead.findUniqueOrThrow({
      where: { id: ok.leadId },
    });
    const badRow = await st.owner.assistSiteLead.findUniqueOrThrow({
      where: { id: bad.leadId },
    });
    expect(okRow.identityEnc).not.toContain('olena');
    expect(
      decryptIdentity(okRow.identityEnc!, ok.leadId, identityKey(st.chat.env)!)
        ?.externalId,
    ).toBe('customer-42');
    expect(
      decryptIdentity(
        okRow.identityEnc!,
        bad.leadId,
        identityKey(st.chat.env)!,
      ),
    ).toBeNull();
    expect(okRow.identityVerified).toBe(true);
    expect(badRow.identityVerified).toBe(false);
    const texts = st.chat.sent.map((x) => x.body.text);
    expect(
      texts.some(
        (t) => t.includes('customer-42') && t.includes('проверен (подпись'),
      ),
    ).toBe(true);
    expect(texts.some((t) => t.includes('заявлено сайтом, не проверено'))).toBe(
      true,
    );
    // Без секрета идентичности — только «заявлено».
    await st.integrations.revoke(m, s.siteId, 'identity');
    const none = await submit(userHashOf(secret, 'customer-42'));
    expect(
      (
        await st.owner.assistSiteLead.findUniqueOrThrow({
          where: { id: none.leadId },
        })
      ).identityVerified,
    ).toBe(false);
    // Без identify — identityVerified остаётся null.
    const plain = await st.leads.submit({
      site: s.ctx(),
      visitor: st.chat.visitor(),
      conversationId: null,
      fields: { phone: '+380 50 111 22 44' },
      consent: true,
      uiLang: 'uk',
      pageUrl: null,
    });
    expect(
      (
        await st.owner.assistSiteLead.findUniqueOrThrow({
          where: { id: plain.leadId },
        })
      ).identityVerified,
    ).toBeNull();
    expect(logs.text()).not.toMatch(/olena|customer-42|idsec_/);
  });

  it('удаление событий по orderId — только владелец; без orderId в логе', async () => {
    const s = await st.site();
    const owner = await st.member(s);
    const manager = await st.member(s, 'manager');
    await st.goal(s, {
      key: 'purchase',
      detectors: [{ kind: 'js', config: {} }],
    });
    await st.intake.fromLoader({
      site: s.ctx(),
      hit: hit({ detector: 'js', orderId: 'DEL-77' }),
      rawIp: null,
    });
    await expect(
      st.goals.deleteEventsByOrder(manager, s.siteId, 'DEL-77'),
    ).rejects.toThrow();
    expect(
      await st.goals.deleteEventsByOrder(owner, s.siteId, 'DEL-77'),
    ).toEqual({ deleted: 1 });
    expect(await events(s)).toEqual([]);
    expect(logs.text()).not.toContain('DEL-77');
  });
});
