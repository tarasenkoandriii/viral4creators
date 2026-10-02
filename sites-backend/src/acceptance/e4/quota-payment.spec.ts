/**
 * Приёмка Э4 (план, Приложение А «Этап 4») на реальном Postgres, конвейер
 * ответа — под ролью assist_public, провайдеры оплаты — моки:
 *  п.2 — при исчерпании лимита виджет показывает форму заявки и НЕ зовёт
 *        модель (видно по site_ai_usage), конфиг виджета — lead_only;
 *  п.3 — оплата на стенде повышает тариф без перезагрузки виджета: тот же
 *        посетитель в том же окне, следующий вопрос — ответ модели (тариф
 *        читается без кэша); повтор колбэка не продлевает дважды.
 * (п.1 — правила счёта диалога — юнит-тесты assist-billing/units.spec.ts.)
 */
import { WidgetPublicConfigService } from '../../modules/assist-widget/widget-config.service';
import type { HandoffIntake } from '../../modules/assist-site-handoff/public/handoff-intake.service';
import type { GoalIntake } from '../../modules/assist-analytics/public/goal-intake.service';
import { describeDb } from '../../modules/assist-sandbox/testing/k3-stack.testing';
import { ChatStack } from '../../modules/assist-site-chat/testing/chat-stack.testing';
import { readState } from '../../modules/assist-billing/public/entitlements';
import {
  seedUsage,
  usageOf,
} from '../../modules/assist-billing/testing/billing-fixtures.testing';
import {
  billingServices,
  wfpCallback,
  type BillingServices,
} from '../../modules/assist-billing/testing/billing-stack.testing';
import {
  OWNER_PRODUCT_ROLES,
  type AccountMembership,
} from '../../modules/site-core/account/roles';

jest.setTimeout(180_000);

describeDb('Приёмка Э4 — мягкий стоп и оплата без перезагрузки виджета', () => {
  const st = new ChatStack();
  let b: BillingServices;
  let widget: WidgetPublicConfigService;

  beforeAll(async () => {
    await st.init();
    b = billingServices(st.owner);
    widget = new WidgetPublicConfigService(
      st.publicDb,
      {} as HandoffIntake,
      {} as GoalIntake,
    );
  });
  afterAll(async () => {
    await st.close();
  });
  beforeEach(() => {
    st.model.mode = 'honest';
    st.model.delayMs = 0;
    st.model.calls.length = 0;
  });

  const owner = (s: {
    accountId: string;
    ownerTelegramId: bigint | number;
  }): AccountMembership => ({
    accountId: s.accountId,
    memberId: 'm',
    telegramId: BigInt(s.ownerTelegramId),
    role: 'owner',
    productRoles: OWNER_PRODUCT_ROLES,
  });

  async function usageRows(siteId: string): Promise<number> {
    return st.owner.siteAiUsage.count({ where: { siteId } });
  }

  it('п.2: лимит единиц выбран → форма заявки, модель не зовётся (нет строк site_ai_usage), конфиг — lead_only', async () => {
    const s = await st.stand('saas');
    const ok = await st.ask(s, 'Сколько стоит тариф Старт?');
    expect(ok.error).toBeNull();
    expect(st.model.calls).toHaveLength(1);
    expect(await widget.spentOut(s)).toBe(false);
    await seedUsage(st.owner, s.accountId, { units: 50 }); // пробный — 50
    expect(await widget.spentOut(s)).toBe(true);
    st.model.calls.length = 0;
    const before = await usageRows(s.siteId);
    const denied = await st.ask(s, 'Какой лимит запросов у API?');
    expect(denied.error).toMatchObject({ code: 'site_quota' });
    expect(denied.actions).toEqual([expect.objectContaining({ kind: 'lead' })]);
    expect(st.model.calls).toHaveLength(0);
    // Ни ответа модели, ни эмбеддинга вопроса, ни перевода — мягкий стоп
    // до любой платной работы: ни одной новой строки учёта ИИ.
    expect(await usageRows(s.siteId)).toBe(before);
    const m = await st.owner.assistSiteMessage.findUniqueOrThrow({
      where: { id: denied.meta!.messageId },
    });
    expect(m).toMatchObject({ streamState: 'refused', costMicroUsd: 0 });
    const u = await st.owner.assistAccountUsage.findFirstOrThrow({
      where: { accountId: s.accountId },
    });
    expect(u.exhaustedAt).not.toBeNull();
  });

  it('п.2: тариф истёк — мягкий стоп без модели и без денег на ответ', async () => {
    const s = await st.stand('shop');
    await st.owner.assistSubscription.create({
      data: {
        accountId: s.accountId,
        planId: 'start',
        method: 'manual',
        anchorAt: new Date(Date.now() - 40 * 86_400_000),
        paidThrough: new Date(Date.now() - 10 * 86_400_000),
      },
    });
    expect(
      (await readState(st.publicDb, s.accountId, new Date())).planId,
    ).toBeNull();
    const before = await usageRows(s.siteId);
    const r = await st.ask(s, 'Скільки коштує доставка Новою поштою?');
    expect(r.error).toMatchObject({ code: 'site_quota' });
    expect(st.model.calls).toHaveLength(0);
    expect(await usageRows(s.siteId)).toBe(before);
    expect(await widget.spentOut(s)).toBe(true);
  });

  it('п.3: оплата WayForPay на стенде → тот же посетитель сразу получает ответ модели; повтор колбэка не продлевает дважды', async () => {
    const s = await st.stand('services');
    const visitor = st.visitor();
    await seedUsage(st.owner, s.accountId, { units: 50 });
    const stopped = await st.ask(s, 'Скільки коштує діагностика ноутбука?', {
      visitor,
    });
    expect(stopped.error).toMatchObject({ code: 'site_quota' });

    const m = owner(s);
    await b.billing.acceptLegal(m, { accept: ['terms', 'dpa'] });
    const checkout = await b.billing.checkout(m, {
      kind: 'subscription',
      planId: 'start',
      method: 'wayforpay',
    });
    expect(checkout.wayforpay?.fields.amount).toBe('789');
    const pay = await st.owner.assistPayment.findUniqueOrThrow({
      where: { id: checkout.paymentId },
    });
    expect(pay).toMatchObject({
      status: 'pending',
      amountMinor: 78900,
      currency: 'UAH',
    });

    const ack = await b.payments.handleWayForPay(
      wfpCallback(checkout.paymentId, 78900, { recToken: 'rec-e4-secret' }),
    );
    expect(ack).toMatchObject({
      orderReference: checkout.paymentId,
      status: 'accept',
    });
    const sub1 = await st.owner.assistSubscription.findUniqueOrThrow({
      where: { accountId: s.accountId },
    });
    expect(sub1).toMatchObject({
      planId: 'start',
      method: 'wayforpay',
      status: 'active',
    });
    expect(sub1.recTokenEnc).toBeTruthy();
    expect(sub1.recTokenEnc).not.toContain('rec-e4-secret');
    const stored = await st.owner.assistPayment.findUniqueOrThrow({
      where: { id: checkout.paymentId },
    });
    expect(stored.status).toBe('succeeded');
    expect(JSON.stringify(stored.rawPayload)).not.toMatch(
      /rec-e4-secret|cardPan|authCode/,
    );

    // Без перезагрузки виджета: тот же посетитель, следующий вопрос.
    expect(await widget.spentOut(s)).toBe(false);
    st.model.calls.length = 0;
    const answered = await st.ask(s, 'Яка гарантія на запчастини?', {
      visitor,
    });
    expect(answered.error).toBeNull();
    expect(st.model.calls).toHaveLength(1);
    expect(await usageOf(st.owner, s.accountId)).toMatchObject({ units: 1 });

    // Повтор колбэка (WayForPay ретраит) — тот же paidThrough.
    await b.payments.handleWayForPay(wfpCallback(checkout.paymentId, 78900));
    await Promise.all([
      b.payments.handleWayForPay(wfpCallback(checkout.paymentId, 78900)),
      b.payments.handleWayForPay(wfpCallback(checkout.paymentId, 78900)),
    ]);
    const sub2 = await st.owner.assistSubscription.findUniqueOrThrow({
      where: { accountId: s.accountId },
    });
    expect(sub2.paidThrough).toEqual(sub1.paidThrough);
  });
});
