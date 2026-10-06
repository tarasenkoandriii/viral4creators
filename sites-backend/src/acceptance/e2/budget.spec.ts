/**
 * Приёмка Э2 п.5 — атомарный бюджет и квота (реальный Postgres, под ролью
 * assist_public; ТЗ §4.5 и три уточнения аудита 01.10):
 *  - 100 параллельных `ask` при бюджете сайта на 10 ответов → оплачено ≤ 10
 *    (резерв — условный UPDATE строки дня, «+1 на гонку» нет);
 *  - перерасход ограничен «факт − оценка» одного ответа;
 *  - брошенный резерв (функцию убили) истекает по TTL и снимается sweep
 *    ровно один раз (два параллельных sweep); до крона — резервом того же сайта;
 *  - два параллельных «последних» диалога периода — открывается один;
 *  - потолок платформы → platform_budget + форма заявки; крон — по CRON_SECRET.
 */
import { WIDGET_DEFAULTS } from '../../config/assist-defaults';
import { readState } from '../../modules/assist-billing/public/entitlements';
import {
  seedUsage,
  usageOf,
} from '../../modules/assist-billing/testing/billing-fixtures.testing';
import { describeDb } from '../../modules/assist-sandbox/testing/k3-stack.testing';
import { utcDay } from '../../modules/assist-site-chat/budget';
import { AssistBudgetSweepController } from '../../modules/assist-site-chat/system/budget-sweep.controller';
import {
  ChatStack,
  collect,
} from '../../modules/assist-site-chat/testing/chat-stack.testing';
import { estimateCost } from '../../shared/ai-pricing';

jest.setTimeout(180_000);

describeDb('Приёмка Э2 п.5 — бюджет и квота (budget)', () => {
  const st = new ChatStack();
  beforeAll(async () => {
    await st.init();
  });
  afterAll(async () => {
    await st.close();
  });
  beforeEach(() => {
    st.model.mode = 'honest';
    st.model.delayMs = 0;
    st.model.usage = { promptTokenCount: 1200, candidatesTokenCount: 40 };
    st.budget.env = st.env;
    st.chat.env = st.env;
  });

  it('100 параллельных вопросов при бюджете на 10 ответов → оплачено ровно 10, остальные site_quota без модели; spent ≤ потолка', async () => {
    const s = await st.stand('saas');
    const question = 'Сколько стоит тариф Старт? Вопрос номер 0';
    const est = st.chat.estimateFor({
      siteName: 'CRM-сервис «Сделка»',
      persona: null,
      siteSummary: null,
      history: [],
      question,
      answerLang: 'ru',
    });
    // Худший случай для потолка: факт ответа ≈ оценке (95%).
    const out = WIDGET_DEFAULTS.maxOutputTokens;
    const outCost = estimateCost('gemini-3.6-flash', {
      outputTokens: out,
    }).costMicroUsd;
    const inTokens = Math.floor((0.95 * est - outCost) / 0.75);
    st.model.usage = { promptTokenCount: inTokens, candidatesTokenCount: out };
    const cap = 10 * est + Math.floor(est / 4);
    await st.owner.assistSite.update({
      where: { siteId: s.siteId },
      data: { dailyCapMicroUsd: cap },
    });
    st.model.delayMs = 3;
    st.model.calls.length = 0;
    st.model.maxActive = 0;
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        st.ask(s, question.replace(/\d+$/, String(i))),
      ),
    );
    await st.chat.idle();
    const paid = results.filter((r) => r.done && r.sources.length > 0);
    const denied = results.filter((r) => r.error?.code === 'site_quota');
    expect(st.model.calls.length).toBe(10);
    expect(paid).toHaveLength(10);
    expect(denied).toHaveLength(90);
    expect(denied.every((r) => r.actions.some((a) => a.kind === 'lead'))).toBe(
      true,
    );
    const row = await st.budgetRow('site', s.siteId, utcDay(new Date()));
    expect(row!.reserved).toBe(0);
    expect(row!.spent).toBeLessThanOrEqual(cap);
    const models = await st.owner.assistSiteMessage.count({
      where: { siteId: s.siteId, answerPath: 'model' },
    });
    expect(models).toBe(10);
    const res = await st.owner.assistBudgetReservation.count({
      where: { siteId: s.siteId },
    });
    expect(res).toBe(0);
  });

  it('перерасход ≤ «факт − оценка» одного ответа; следующий резерв — отказ', async () => {
    const s = await st.site();
    const est = 5_000;
    const r = await st.budget.reserve(st.publicDb, {
      siteId: s.siteId,
      siteCapMicroUsd: est,
      estMicroUsd: est,
    });
    expect(r.ok).toBe(true);
    const second = await st.budget.reserve(st.publicDb, {
      siteId: s.siteId,
      siteCapMicroUsd: est,
      estMicroUsd: est,
    });
    expect(second).toEqual({ ok: false, denied: 'site_budget' });
    if (!r.ok) throw new Error('резерв');
    await st.budget.settle(st.publicDb, r.reservation, est + 700);
    const row = await st.budgetRow('site', s.siteId, r.reservation.day);
    expect(row).toEqual({ spent: est + 700, reserved: 0 });
    expect(row!.spent - est).toBeLessThanOrEqual(700);
    const third = await st.budget.reserve(st.publicDb, {
      siteId: s.siteId,
      siteCapMicroUsd: est,
      estMicroUsd: 1,
    });
    expect(third).toEqual({ ok: false, denied: 'site_budget' });
  });

  it('брошенный резерв: до TTL держит место, после — sweep снимает ровно один раз (два параллельных), позднее списание — только факт', async () => {
    const s = await st.site();
    const t0 = new Date('2030-03-01T10:00:00.000Z');
    const est = 4_000;
    const r = await st.budget.reserve(st.publicDb, {
      siteId: s.siteId,
      siteCapMicroUsd: 10 * est,
      estMicroUsd: est,
      now: t0,
    });
    if (!r.ok) throw new Error('резерв');
    expect(r.reservation.expiresAt.getTime() - t0.getTime()).toBe(
      WIDGET_DEFAULTS.reservationTtlMs,
    );
    // Второй резерв — живой на момент крона: вычитание «дважды» стало бы видно
    // (GREATEST(0, …) не спрятал бы его за нулём).
    const est2 = 1_500;
    const r2 = await st.budget.reserve(st.publicDb, {
      siteId: s.siteId,
      siteCapMicroUsd: 10 * est,
      estMicroUsd: est2,
      now: new Date(t0.getTime() + WIDGET_DEFAULTS.reservationTtlMs / 2),
    });
    expect(r2.ok).toBe(true);
    const day = r.reservation.day;
    const platformBefore = (await st.budgetRow('platform', 'all', day))!
      .reserved;
    // До истечения — не снимается.
    expect(
      await st.budget.sweep(
        st.owner,
        new Date(t0.getTime() + WIDGET_DEFAULTS.reservationTtlMs - 1),
        s.siteId,
      ),
    ).toBe(0);
    expect((await st.budgetRow('site', s.siteId, day))!.reserved).toBe(
      est + est2,
    );
    const after = new Date(t0.getTime() + WIDGET_DEFAULTS.reservationTtlMs + 1);
    // Только резервы СВОЕГО сайта: sweep без siteId «в 2030 году» снял бы
    // живые резервы всех файлов, идущих параллельно на той же базе (так
    // падал e5/voice.spec «потолок голоса атомарный»). Общий крон без
    // siteId проверяет тест «крон assist-budget-sweep» ниже — по настоящим
    // часам, где снимаются только действительно просроченные резервы.
    const [a, b] = await Promise.all([
      st.budget.sweep(st.owner, after, s.siteId),
      st.budget.sweep(st.owner, after, s.siteId),
    ]);
    expect(a + b).toBeGreaterThanOrEqual(1);
    const mine = await st.owner.assistBudgetReservation.count({
      where: { id: r.reservation.id },
    });
    expect(mine).toBe(0);
    expect((await st.budgetRow('site', s.siteId, day))!.reserved).toBe(est2);
    expect((await st.budgetRow('platform', 'all', day))!.reserved).toBe(
      platformBefore - est,
    );
    // Ещё один sweep — ничего не вычитает второй раз.
    await st.budget.sweep(st.owner, after, s.siteId);
    expect((await st.budgetRow('site', s.siteId, day))!.reserved).toBe(est2);
    // Функция «ожила» и списывает факт — резерв уже снят, только spent.
    await st.budget.settle(st.publicDb, r.reservation, 1_234);
    expect(await st.budgetRow('site', s.siteId, day)).toEqual({
      spent: 1_234,
      reserved: est2,
    });
  });

  it('просроченный резерв перестаёт держать место ещё до крона (снимается резервом того же сайта)', async () => {
    const s = await st.site();
    const t0 = new Date('2030-03-02T10:00:00.000Z');
    const est = 3_000;
    const first = await st.budget.reserve(st.publicDb, {
      siteId: s.siteId,
      siteCapMicroUsd: est,
      estMicroUsd: est,
      now: t0,
    });
    expect(first.ok).toBe(true);
    const blocked = await st.budget.reserve(st.publicDb, {
      siteId: s.siteId,
      siteCapMicroUsd: est,
      estMicroUsd: est,
      now: new Date(t0.getTime() + 1_000),
    });
    expect(blocked.ok).toBe(false);
    const later = await st.budget.reserve(st.publicDb, {
      siteId: s.siteId,
      siteCapMicroUsd: est,
      estMicroUsd: est,
      now: new Date(t0.getTime() + WIDGET_DEFAULTS.reservationTtlMs + 5),
    });
    expect(later.ok).toBe(true);
    expect((await st.budgetRow('site', s.siteId, '2030-03-02'))!.reserved).toBe(
      est,
    );
  });

  it('два параллельных «последних» диалога периода — открывается один (и 50 параллельных claim при остатке 1 — один true)', async () => {
    // Э4: лимит — единицы периода ПОДПИСКИ кабинета (пробный — 50).
    const s = await st.stand('services');
    await seedUsage(st.owner, s.accountId, { units: 49 });
    st.model.delayMs = 5;
    st.model.calls.length = 0;
    const [a, b] = await Promise.all([
      collect(st.chat.ask(st.input(s, 'Скільки коштує діагностика ноутбука?'))),
      collect(st.chat.ask(st.input(s, 'Яка гарантія на запчастини?'))),
    ]);
    const opened = [a, b].filter((r) => r.done);
    const refused = [a, b].filter((r) => r.error?.code === 'site_quota');
    expect(opened).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(st.model.calls).toHaveLength(1);
    expect((await usageOf(st.owner, s.accountId))!.units).toBe(50);
    const s2 = await st.site();
    const state = await seedUsage(st.owner, s2.accountId, { units: 49 });
    const claims = await Promise.all(
      Array.from({ length: 50 }, () =>
        st.quota.claim(st.publicDb, {
          accountId: s2.accountId,
          state,
          units: 1,
          dialogs: 1,
        }),
      ),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect((await usageOf(st.owner, s2.accountId))!.units).toBe(50);
    expect(
      (await readState(st.publicDb, s2.accountId, new Date())).planId,
    ).toBe('trial');
  });

  it('диалог: 31-й ответ модели занимает вторую единицу квоты (×2, §7.1)', async () => {
    const s = await st.stand('saas');
    const visitor = st.visitor();
    const first = await st.ask(s, 'Сколько стоит тариф Старт?', { visitor });
    const conv = first.meta!.conversationId;
    await st.owner.assistSiteConversation.update({
      where: { id: conv },
      data: { answers: 29 },
    });
    await st.ask(s, 'Сколько длится пробный период?', {
      visitor,
      conversationId: conv,
    });
    const before = await usageOf(st.owner, s.accountId);
    expect(before).toMatchObject({ units: 1, dialogs: 1 });
    await st.ask(s, 'Какой лимит запросов у API?', {
      visitor,
      conversationId: conv,
    });
    const after = await usageOf(st.owner, s.accountId);
    expect(after).toMatchObject({ units: 2, dialogs: 1 });
  });

  it('потолок платформы исчерпан → platform_budget + форма заявки, модель не зовётся', async () => {
    const s = await st.stand('shop');
    st.budget.env = { ...st.env, ASSIST_WIDGET_PLATFORM_DAILY_CAP_USD: '0' };
    st.model.calls.length = 0;
    const r = await st.ask(s, 'Скільки коштує доставка Новою поштою?');
    expect(r.error).toMatchObject({ code: 'platform_budget' });
    expect(r.actions).toEqual([expect.objectContaining({ kind: 'lead' })]);
    expect(st.model.calls).toHaveLength(0);
    const m = await st.owner.assistSiteMessage.findUniqueOrThrow({
      where: { id: r.meta!.messageId },
    });
    expect(m.streamState).toBe('refused');
  });

  it('крон assist-budget-sweep: без секрета — 401; с секретом — снимает просроченные резервы', async () => {
    const prev = process.env.CRON_SECRET;
    process.env.CRON_SECRET = 'w3-cron-secret';
    try {
      const s = await st.site();
      const r = await st.budget.reserve(st.publicDb, {
        siteId: s.siteId,
        siteCapMicroUsd: 100_000,
        estMicroUsd: 2_000,
        now: new Date(Date.now() - WIDGET_DEFAULTS.reservationTtlMs - 60_000),
      });
      expect(r.ok).toBe(true);
      const ctl = new AssistBudgetSweepController(
        st.owner,
        st.budget,
        st.delivery,
      );
      await expect(ctl.run(undefined)).rejects.toThrow();
      const out = await ctl.run('Bearer w3-cron-secret');
      expect(out.ran).toBe(true);
      expect(out.reservationsReleased).toBeGreaterThanOrEqual(1);
      expect(
        await st.owner.assistBudgetReservation.count({
          where: { siteId: s.siteId },
        }),
      ).toBe(0);
    } finally {
      process.env.CRON_SECRET = prev;
    }
  });
});
