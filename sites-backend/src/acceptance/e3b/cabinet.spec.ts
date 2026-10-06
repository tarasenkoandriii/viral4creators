/**
 * Приёмка Э3-бис — кабинет и деньги (ТЗ §5-тер.3–6, §5-тер.16, §5-тер.17):
 *  - сводка: покрытие, корзины, распределения с весом выборки, бюджет;
 *  - лента размеченных диалогов с фильтрами и объяснением score;
 *    «неверно размечено» — поверх модели, перечни проверяются;
 *  - бюджет аналитики: параллельные резервы не превышают долю сайта;
 *    доля — поровну между сайтами кабинета (Р-58);
 *  - вебхук заказа с `assistRef` → «с участием» диалога визита.
 */
import type { ChatSite } from '../../modules/assist-site-chat/testing/chat-stack.testing';
import { describeDb } from '../../modules/assist-sandbox/testing/k3-stack.testing';
import { analyticsPeriod } from '../../modules/assist-analytics/ai/analytics-budget';
import {
  issueRef,
  visitHashOf,
} from '../../modules/assist-analytics/public/ai-intake.service';
import { signGoalWebhook } from '../../modules/assist-analytics/webhook-signature';
import {
  addDays,
  dayInTz,
  siteTz,
} from '../../modules/assist-analytics/site-time';
import {
  AiStack,
  labelJson,
  visitKey,
} from '../../modules/assist-analytics/testing/ai-stack.testing';

jest.setTimeout(120_000);

describeDb('Приёмка Э3-бис: кабинет аналитики и бюджет', () => {
  const st = new AiStack();
  const saved = {
    ref: process.env.ASSIST_ANALYTICS_REF_SECRET,
    key: process.env.ASSIST_SECRETS_KEY,
  };
  beforeAll(async () => {
    process.env.ASSIST_ANALYTICS_REF_SECRET = 'e3b-ref-secret-0123456789';
    await st.init();
    process.env.ASSIST_SECRETS_KEY = st.chat.env.ASSIST_SECRETS_KEY;
  });
  afterAll(async () => {
    await st.close();
    for (const [k, v] of [
      ['ASSIST_ANALYTICS_REF_SECRET', saved.ref],
      ['ASSIST_SECRETS_KEY', saved.key],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  async function biz(): Promise<ChatSite> {
    const s = await st.site();
    await st.plan(s, 'business');
    await st.analytics(s, { linked: true });
    return s;
  }
  /**
   * Период «последние 4 дня» — в сутках САЙТА (сервис режет `from`/`to` по
   * поясу сайта, §5-тер.10), «сегодня» — в момент теста, а не при загрузке
   * модуля. По UTC было нельзя: с 21:00/22:00 UTC в Киеве уже завтра, и
   * диалог «2 ч назад» (createdAt фикстуры) с 23:00 UTC летом оказывался
   * после конца `to` — сводка пустая. Диалог «2 ч назад» может попасть во
   * вчера по Киеву (после полуночи) — `from` на 3 дня раньше его покрывает.
   */
  async function lastDays(s: ChatSite): Promise<{ from: string; to: string }> {
    const a = await st.owner.assistSite.findFirst({
      where: { siteId: s.siteId },
      select: { timezone: true },
    });
    const today = dayInTz(new Date(), siteTz(a?.timezone));
    return { from: addDays(today, -3), to: today };
  }

  it('сводка и лента: покрытие, корзины, фильтры, объяснение; исправление разметки поверх модели', async () => {
    const s = await biz();
    const q = await lastDays(s);
    const a = await st.conversation(s);
    const b = await st.conversation(s);
    st.text.queue.push(
      labelJson({
        stage: 'decide',
        buyingSignals: ['asked_price', 'asked_how_to_order', 'asked_payment'],
        llmLikelihood: 95,
      }),
      labelJson({
        intent: 'complaint',
        stage: 'support',
        buyingSignals: [],
        llmLikelihood: 5,
        outcome: 'unresolved',
        failureReason: 'trust_doubt',
      }),
    );
    await st.labeler.tick({
      deadline: Date.now() + 30_000,
      max: 10,
      scope: st.scope(s),
    });
    const m = await st.member(s, 'manager');
    const sum = await st.cabinet.summary(m, s.siteId, q);
    expect(sum.coverage).toMatchObject({
      closed: 2,
      labeled: 2,
      failed: 0,
      pending: 0,
    });
    expect(sum.plan).toMatchObject({
      aiAnalytics: true,
      experiments: true,
      linkedWindowDays: 7,
    });
    expect(sum.model.ok).toBe(true);
    expect(sum.budget.capMicroUsd).toBe(1_000_000);
    expect(sum.intents.map((x) => x.key).sort()).toEqual([
      'complaint',
      'delivery',
    ]);
    expect(sum.failureReasons).toEqual([{ key: 'trust_doubt', n: 1 }]);
    const all = await st.cabinet.dialogs(m, s.siteId, q);
    expect(all.items).toHaveLength(2);
    expect(all.items.every((i) => i.features.length > 0)).toBe(true);
    const complaints = await st.cabinet.dialogs(m, s.siteId, {
      ...q,
      intent: 'complaint',
    });
    expect(complaints.items.map((i) => i.conversationId)).toEqual([b.id]);
    await expect(
      st.cabinet.dialogs(m, s.siteId, { ...q, intent: 'casino' }),
    ).rejects.toMatchObject({ status: 400 });
    // «Неверно размечено»: intent → price; повторная разметка не затирает.
    await st.cabinet.overrideLabel(m, s.siteId, a.id, {
      intent: 'price',
      leadBucket: 'cold',
    });
    await expect(
      st.cabinet.overrideLabel(m, s.siteId, a.id, { intent: 'casino' }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      st.cabinet.overrideLabel(m, s.siteId, a.id, { score: 100 }),
    ).rejects.toMatchObject({ status: 400 });
    const fixed = await st.cabinet.dialogs(m, s.siteId, {
      ...q,
      intent: 'price',
    });
    expect(fixed.items).toHaveLength(1);
    expect(fixed.items[0]).toMatchObject({
      intent: 'price',
      leadBucket: 'cold',
      humanOverride: { intent: 'price', leadBucket: 'cold' },
    });
    const sum2 = await st.cabinet.summary(m, s.siteId, q);
    expect(sum2.overridden).toBe(1);
    // Чужой кабинет не видит сайт.
    const other = await biz();
    const om = await st.member(other, 'owner');
    await expect(st.cabinet.summary(om, s.siteId, q)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      st.cabinet.overrideLabel(om, s.siteId, a.id, { intent: 'price' }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('бюджет: доля — поровну между сайтами кабинета; параллельные резервы не превышают долю', async () => {
    const s = await biz();
    // Второй сайт того же кабинета с помощником.
    const site2 = await st.owner.site.create({
      data: { accountId: s.accountId, name: 'Второй' },
    });
    await st.owner.assistSite.create({
      data: { accountId: s.accountId, siteId: site2.id, enabled: true },
    });
    const now = new Date();
    const cap = await st.budget.siteCap(s.accountId, s.siteId, now);
    expect(cap).toBe(500_000);
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        st.budget.reserve(s.accountId, s.siteId, 100_000, cap, now),
      ),
    );
    expect(results.filter((r) => r.result === 'ok')).toHaveLength(5);
    const row = await st.owner.assistAnalyticsSpend.findUnique({
      where: {
        siteId_period: { siteId: s.siteId, period: analyticsPeriod(now) },
      },
    });
    expect(Number(row!.spentMicroUsd)).toBe(500_000);
    // Поправка на факт: не ниже нуля.
    const ok = results.find((r) => r.reservation)!.reservation!;
    await st.budget.settle(ok, 0);
    const after = await st.owner.assistAnalyticsSpend.findUnique({
      where: {
        siteId_period: { siteId: s.siteId, period: analyticsPeriod(now) },
      },
    });
    expect(Number(after!.spentMicroUsd)).toBe(400_000);
  });

  it('вебхук заказа с assistRef посетителя с согласием → «с участием» диалога визита', async () => {
    const s = await biz();
    await st.goal(s, {
      key: 'purchase',
      detectors: [{ kind: 's2s', config: {} }],
    });
    const conv = await st.conversation(s);
    const v = visitKey();
    const vh = visitHashOf(s.siteId, `salt-${s.siteId}`, v);
    await st.owner.assistSiteConversation.update({
      where: { id: conv.id },
      data: { visitHash: vh },
    });
    const owner = await st.member(s, 'owner');
    const { secret } = await st.integrations.issue(
      owner,
      s.siteId,
      'goal_webhook',
    );
    const send = async (orderId: string, assistRef: string | null) => {
      const body = JSON.stringify({
        goalKey: 'purchase',
        orderId,
        status: 'completed',
        occurredAt: new Date().toISOString(),
        value: 1299,
        currency: 'UAH',
        ...(assistRef ? { assistRef } : {}),
      });
      return st.webhook.receive({
        siteId: s.siteId,
        rawBody: body,
        signature: signGoalWebhook(secret, body, Math.floor(Date.now() / 1000)),
        idempotencyKey: orderId,
      });
    };
    const ref = issueRef(s.siteId, vh, new Date())!;
    // orderId — постоянные: сайт у теста свой (уникальность — siteId, goalId,
    // orderId). Случайные `A-<8 hex>` из одних цифр (≈2,3 % на id) validOrderId
    // принимал за телефон → 422 GOAL_ORDER_ID_INVALID.
    await send('A-1042', ref);
    await send('B-1043', ref.replace(/.{4}$/, 'AAAA'));
    const evs = await st.owner.assistSiteGoalEvent.findMany({
      where: { siteId: s.siteId },
      orderBy: { orderId: 'asc' },
    });
    expect(evs[0]).toMatchObject({
      trust: 'verified',
      attribution: 'assisted',
      conversationId: conv.id,
      visitHash: vh,
    });
    // Подделанный ref — событие принято, но без связи.
    expect(evs[1]).toMatchObject({
      trust: 'verified',
      conversationId: null,
      visitHash: null,
    });
  });
});
