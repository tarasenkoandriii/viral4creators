/**
 * Э4: деньги на реальном Postgres (провайдеры — моки): Stars через бот
 * Помощника (pre_checkout_query / successful_payment, автопродление,
 * повтор доставки), WayForPay (подпись, мерчант, сумма, 3DS-статусы,
 * отказ, параллельные доставки), докупка в текущий период, смена тарифа.
 */
import {
  describeDb,
  ownerPrisma,
} from '../../modules/assist-sandbox/testing/k3-stack.testing';
import type { PrismaService } from '../../prisma/prisma.service';
import { readState } from '../../modules/assist-billing/public/entitlements';
import {
  createAccount,
  setPlan,
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

jest.setTimeout(120_000);

const DAY = 86_400_000;

describeDb('Э4: оплата Stars и WayForPay (моки провайдеров)', () => {
  let owner: PrismaService;
  let b: BillingServices;

  beforeAll(() => {
    owner = ownerPrisma();
    b = billingServices(owner);
  });
  afterAll(async () => {
    await owner.$disconnect();
  });

  const as = (accountId: string, tg: bigint): AccountMembership => ({
    accountId,
    memberId: 'm',
    telegramId: tg,
    role: 'owner',
    productRoles: OWNER_PRODUCT_ROLES,
  });

  async function legal(m: AccountMembership) {
    await b.billing.acceptLegal(m, { accept: ['terms', 'dpa'] });
  }

  const sub = (accountId: string) =>
    owner.assistSubscription.findUnique({ where: { accountId } });

  it('чекаут без принятых Условий и DPA — 409 LEGAL_REQUIRED; сумма считается на сервере', async () => {
    const a = await createAccount(owner);
    const m = as(a.accountId, a.ownerTelegramId);
    await expect(
      b.billing.checkout(m, {
        kind: 'subscription',
        planId: 'pro',
        method: 'stars',
      }),
    ).rejects.toMatchObject({ response: { code: 'LEGAL_REQUIRED' } });
    await legal(m);
    const r = await b.billing.checkout(m, {
      kind: 'subscription',
      planId: 'pro',
      method: 'stars',
    });
    expect(r.starsInvoiceUrl).toMatch(/^https:\/\/t\.me\//);
    const inv = b.providers.invoices.at(-1)!;
    expect(inv).toMatchObject({ payload: r.paymentId, amount: 11473 });
    // Pro дороже потолка подписки Stars (10 000) — разовая оплата 30 дней.
    expect(inv.subscription).toBe(false);
    const start = await b.billing.checkout(m, {
      kind: 'subscription',
      planId: 'start',
      method: 'stars',
    });
    expect(b.providers.invoices.at(-1)).toMatchObject({
      payload: start.paymentId,
      amount: 1463,
      subscription: true,
    });
    expect(Buffer.byteLength(start.paymentId)).toBeLessThanOrEqual(128);
  });

  it('Stars: pre_checkout сверяет счёт (сумма, валюта, срок, статус); successful_payment → тариф; повтор — без второго продления', async () => {
    const a = await createAccount(owner);
    const m = as(a.accountId, a.ownerTelegramId);
    await legal(m);
    const r = await b.billing.checkout(m, {
      kind: 'subscription',
      planId: 'start',
      method: 'stars',
    });
    const pre = (over: Record<string, unknown>) =>
      b.payments.handleTelegramUpdate({
        update_id: 1,
        pre_checkout_query: {
          id: `pcq-${Math.random()}`,
          from: { id: Number(a.ownerTelegramId) },
          currency: 'XTR',
          total_amount: 1463,
          invoice_payload: r.paymentId,
          ...over,
        },
      });
    expect(await pre({})).toBe(true);
    expect(b.providers.preCheckouts.at(-1)).toMatchObject({ ok: true });
    await pre({ total_amount: 1 });
    expect(b.providers.preCheckouts.at(-1)).toMatchObject({ ok: false });
    await pre({ currency: 'USD' });
    expect(b.providers.preCheckouts.at(-1)?.ok).toBe(false);
    await pre({ invoice_payload: 'ap_nonexistent' });
    expect(b.providers.preCheckouts.at(-1)?.ok).toBe(false);

    const paid = {
      update_id: 2,
      message: {
        from: { id: Number(a.ownerTelegramId) },
        successful_payment: {
          currency: 'XTR',
          total_amount: 1463,
          invoice_payload: r.paymentId,
          telegram_payment_charge_id: `ch-${a.accountId}-1`,
          is_recurring: false,
        },
      },
    };
    await b.payments.handleTelegramUpdate(paid);
    const s1 = await sub(a.accountId);
    expect(s1).toMatchObject({
      planId: 'start',
      method: 'stars',
      starsChargeId: `ch-${a.accountId}-1`,
      starsPayerTelegramId: a.ownerTelegramId,
    });
    // Повтор доставки (параллельно) — одна строка, тот же paidThrough.
    await Promise.all([
      b.payments.handleTelegramUpdate(paid),
      b.payments.handleTelegramUpdate(paid),
    ]);
    expect((await sub(a.accountId))!.paidThrough).toEqual(s1!.paidThrough);
    expect(
      await owner.assistPayment.count({
        where: { accountId: a.accountId, status: 'succeeded' },
      }),
    ).toBe(1);
    // Оплаченный счёт — pre_checkout отказ (ссылку не оплатить дважды).
    await pre({});
    expect(b.providers.preCheckouts.at(-1)).toMatchObject({ ok: false });
    // Владелец получил сообщение об оплате в бот.
    expect(b.sent.some((x) => x.chat_id === a.ownerTelegramId.toString())).toBe(
      true,
    );
  });

  it('Stars: автопродление (is_recurring, тот же payload) — новая строка renewal, +30 дней ровно один раз', async () => {
    const a = await createAccount(owner);
    const m = as(a.accountId, a.ownerTelegramId);
    await legal(m);
    const r = await b.billing.checkout(m, {
      kind: 'subscription',
      planId: 'business',
      method: 'stars',
    });
    const charge = (id: string, recurring: boolean) => ({
      message: {
        from: { id: Number(a.ownerTelegramId) },
        successful_payment: {
          currency: 'XTR',
          total_amount: 4543,
          invoice_payload: r.paymentId,
          telegram_payment_charge_id: id,
          is_recurring: recurring,
        },
      },
    });
    await b.payments.handleTelegramUpdate(charge(`ch-${a.accountId}-a`, false));
    const s1 = (await sub(a.accountId))!;
    await b.payments.handleTelegramUpdate(charge(`ch-${a.accountId}-b`, true));
    await b.payments.handleTelegramUpdate(charge(`ch-${a.accountId}-b`, true));
    const s2 = (await sub(a.accountId))!;
    expect(s2.paidThrough.getTime() - s1.paidThrough.getTime()).toBe(30 * DAY);
    expect(s2.anchorAt).toEqual(s1.anchorAt);
    // Отмена Stars — по charge ПЕРВОГО платежа подписки.
    expect(s2.starsChargeId).toBe(`ch-${a.accountId}-a`);
    const rows = await owner.assistPayment.findMany({
      where: { accountId: a.accountId, status: 'succeeded' },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((x) => [x.kind, x.parentId === null])).toEqual([
      ['subscription', true],
      ['renewal', false],
    ]);
  });

  it('смена тарифа Stars → новая подписка; прежняя отменяется в Telegram (М-1.1); тариф сразу с новым периодом', async () => {
    const a = await createAccount(owner);
    const m = as(a.accountId, a.ownerTelegramId);
    await legal(m);
    const pay = async (
      planId: 'start' | 'business',
      ch: string,
      amount: number,
    ) => {
      const r = await b.billing.checkout(m, {
        kind: 'subscription',
        planId,
        method: 'stars',
      });
      await b.payments.handleTelegramUpdate({
        message: {
          from: { id: Number(a.ownerTelegramId) },
          successful_payment: {
            currency: 'XTR',
            total_amount: amount,
            invoice_payload: r.paymentId,
            telegram_payment_charge_id: ch,
          },
        },
      });
    };
    await pay('start', `ch-${a.accountId}-s`, 1463);
    await seedUsage(owner, a.accountId, { units: 390 });
    await pay('business', `ch-${a.accountId}-b`, 4543);
    expect(b.providers.starsCancels).toContainEqual({
      chargeId: `ch-${a.accountId}-s`,
      canceled: true,
    });
    const st = await readState(owner, a.accountId, new Date());
    expect(st.planId).toBe('business');
    expect(await usageOf(owner, a.accountId)).toBeNull(); // новый период — счётчик с нуля
  });

  it('переход со Stars на карту: подписка Stars отменяется в Telegram, тариф продлевается картой', async () => {
    const a = await createAccount(owner);
    const m = as(a.accountId, a.ownerTelegramId);
    await legal(m);
    const r = await b.billing.checkout(m, {
      kind: 'subscription',
      planId: 'start',
      method: 'stars',
    });
    await b.payments.handleTelegramUpdate({
      message: {
        from: { id: Number(a.ownerTelegramId) },
        successful_payment: {
          currency: 'XTR',
          total_amount: 1463,
          invoice_payload: r.paymentId,
          telegram_payment_charge_id: `ch-${a.accountId}-w`,
        },
      },
    });
    const card = await b.billing.checkout(m, {
      kind: 'subscription',
      planId: 'start',
      method: 'wayforpay',
    });
    await b.payments.handleWayForPay(
      wfpCallback(card.paymentId, 78900, { recToken: 'rec-switch' }),
    );
    expect(b.providers.starsCancels).toContainEqual({
      chargeId: `ch-${a.accountId}-w`,
      canceled: true,
    });
    const s = (await sub(a.accountId))!;
    expect(s).toMatchObject({ method: 'wayforpay', starsChargeId: null });
    expect(s.recTokenEnc).toBeTruthy();
    // Telegram всё же продлил старую подписку Stars: время отдаём, способ
    // и recToken карты не теряем.
    await b.payments.handleTelegramUpdate({
      message: {
        from: { id: Number(a.ownerTelegramId) },
        successful_payment: {
          currency: 'XTR',
          total_amount: 1463,
          invoice_payload: r.paymentId,
          telegram_payment_charge_id: `ch-${a.accountId}-w2`,
          is_recurring: true,
        },
      },
    });
    const s2 = (await sub(a.accountId))!;
    expect(s2.paidThrough.getTime() - s.paidThrough.getTime()).toBe(30 * DAY);
    expect(s2).toMatchObject({
      method: 'wayforpay',
      recTokenEnc: s.recTokenEnc,
    });
  });

  it('отменённое продление + запоздалое автопродление Stars: время отдаём, отмена остаётся и повторяется в Telegram', async () => {
    const a = await createAccount(owner);
    const m = as(a.accountId, a.ownerTelegramId);
    await legal(m);
    const r = await b.billing.checkout(m, {
      kind: 'subscription',
      planId: 'start',
      method: 'stars',
    });
    const pay = (ch: string, recurring: boolean) =>
      b.payments.handleTelegramUpdate({
        message: {
          from: { id: Number(a.ownerTelegramId) },
          successful_payment: {
            currency: 'XTR',
            total_amount: 1463,
            invoice_payload: r.paymentId,
            telegram_payment_charge_id: ch,
            is_recurring: recurring,
          },
        },
      });
    await pay(`ch-${a.accountId}-k1`, false);
    await b.billing.setCancel(m, true);
    const before = b.providers.starsCancels.length;
    await pay(`ch-${a.accountId}-k2`, true);
    const s = (await sub(a.accountId))!;
    expect(s.cancelAtPeriodEnd).toBe(true);
    expect(b.providers.starsCancels.slice(before)).toContainEqual({
      chargeId: `ch-${a.accountId}-k1`,
      canceled: true,
    });
  });

  it('WayForPay: чужая подпись, чужой мерчант, другая сумма — не применяются; 3DS — pending; Declined — failed', async () => {
    const a = await createAccount(owner);
    const m = as(a.accountId, a.ownerTelegramId);
    await legal(m);
    const r = await b.billing.checkout(m, {
      kind: 'subscription',
      planId: 'start',
      method: 'wayforpay',
    });
    const row = () =>
      owner.assistPayment.findUniqueOrThrow({ where: { id: r.paymentId } });
    const bad = wfpCallback(r.paymentId, 78900, {}, 'wrong-secret');
    expect(await b.payments.handleWayForPay(bad)).toMatchObject({
      status: 'accept',
    });
    expect((await row()).status).toBe('pending');
    await b.payments.handleWayForPay(
      wfpCallback(r.paymentId, 78900, { merchantAccount: 'someone_else' }),
    );
    expect((await row()).status).toBe('pending');
    await b.payments.handleWayForPay(
      wfpCallback(r.paymentId, 78900, {
        transactionStatus: 'WaitingAuthComplete',
      }),
    );
    expect((await row()).status).toBe('pending');
    await b.payments.handleWayForPay(wfpCallback(r.paymentId, 100));
    expect((await row()).status).toBe('failed');
    expect(await sub(a.accountId)).toBeNull();

    const r2 = await b.billing.checkout(m, {
      kind: 'subscription',
      planId: 'start',
      method: 'wayforpay',
    });
    await b.payments.handleWayForPay(
      wfpCallback(r2.paymentId, 78900, {
        transactionStatus: 'Declined',
        reasonCode: 1101,
      }),
    );
    expect(
      (
        await owner.assistPayment.findUniqueOrThrow({
          where: { id: r2.paymentId },
        })
      ).status,
    ).toBe('failed');
    // Поздний Approved по отказанному счёту не применяется (только pending/expired).
    await b.payments.handleWayForPay(wfpCallback(r2.paymentId, 78900));
    expect(await sub(a.accountId)).toBeNull();
  });

  it('докупка: только на платном тарифе; +100×N единиц в ТЕКУЩИЙ период; лимит растёт сразу', async () => {
    const a = await createAccount(owner);
    const m = as(a.accountId, a.ownerTelegramId);
    await legal(m);
    await expect(
      b.billing.checkout(m, { kind: 'topup', packs: 1, method: 'wayforpay' }),
    ).rejects.toMatchObject({ response: { code: 'TOPUP_UNAVAILABLE' } });
    await setPlan(owner, a.accountId, 'business');
    await seedUsage(owner, a.accountId, { units: 1200 });
    const r = await b.billing.checkout(m, {
      kind: 'topup',
      packs: 2,
      method: 'wayforpay',
    });
    const pay = await owner.assistPayment.findUniqueOrThrow({
      where: { id: r.paymentId },
    });
    expect(pay).toMatchObject({
      amountMinor: 45700,
      units: 200,
      kind: 'topup',
    });
    await b.payments.handleWayForPay(wfpCallback(r.paymentId, 45700));
    await b.payments.handleWayForPay(wfpCallback(r.paymentId, 45700));
    expect(await usageOf(owner, a.accountId)).toMatchObject({
      units: 1200,
      extraUnits: 200,
    });
    const ov = await b.billing.overview(m);
    expect(ov.usage).toMatchObject({
      limit: 1400,
      planUnits: 1200,
      extraUnits: 200,
    });
  });

  it('отмена продления: Stars — editUserStarSubscription в Telegram; без льготы после конца', async () => {
    const a = await createAccount(owner);
    const m = as(a.accountId, a.ownerTelegramId);
    await legal(m);
    const r = await b.billing.checkout(m, {
      kind: 'subscription',
      planId: 'start',
      method: 'stars',
    });
    await b.payments.handleTelegramUpdate({
      message: {
        from: { id: Number(a.ownerTelegramId) },
        successful_payment: {
          currency: 'XTR',
          total_amount: 1463,
          invoice_payload: r.paymentId,
          telegram_payment_charge_id: `ch-${a.accountId}-c`,
        },
      },
    });
    const ov = await b.billing.setCancel(m, true);
    expect(ov.plan).toMatchObject({ cancelAtPeriodEnd: true, renews: false });
    expect(b.providers.starsCancels).toContainEqual({
      chargeId: `ch-${a.accountId}-c`,
      canceled: true,
    });
    const s = (await sub(a.accountId))!;
    expect(
      (
        await readState(
          owner,
          a.accountId,
          new Date(s.paidThrough.getTime() + 1000),
        )
      ).planId,
    ).toBeNull();
  });
  // Аудит Э4: Pro (11 473 XTR) дороже потолка подписки Stars — счёт без
  // subscription_period, Telegram его не продлит. Строка подписки не должна
  // выглядеть продлеваемой: ни льготы после конца, ни «возобновить».
  it('разовая оплата Stars (Pro сверх потолка подписки): не продлевается — без льготы, без charge для отмены, «возобновить» — 409', async () => {
    const a = await createAccount(owner);
    const m = as(a.accountId, a.ownerTelegramId);
    await legal(m);
    const r = await b.billing.checkout(m, {
      kind: 'subscription',
      planId: 'pro',
      method: 'stars',
    });
    expect(b.providers.invoices.at(-1)?.subscription).toBe(false);
    await b.payments.handleTelegramUpdate({
      message: {
        from: { id: Number(a.ownerTelegramId) },
        successful_payment: {
          currency: 'XTR',
          total_amount: 11473,
          invoice_payload: r.paymentId,
          telegram_payment_charge_id: `ch-${a.accountId}-once`,
        },
      },
    });
    const s = (await sub(a.accountId))!;
    expect(s).toMatchObject({
      planId: 'pro',
      method: 'stars',
      cancelAtPeriodEnd: true,
      starsChargeId: null,
    });
    const ov = await b.billing.overview(m);
    expect(ov.plan).toMatchObject({ renews: false });
    // Сразу после конца оплаченного — тарифа нет (льготы нет).
    expect(
      (
        await readState(
          owner,
          a.accountId,
          new Date(s.paidThrough.getTime() + 1000),
        )
      ).planId,
    ).toBeNull();
    const cancelsBefore = b.providers.starsCancels.length;
    await expect(b.billing.setCancel(m, false)).rejects.toMatchObject({
      response: { code: 'BILLING_INVALID' },
    });
    expect(b.providers.starsCancels.length).toBe(cancelsBefore);
    expect((await sub(a.accountId))!.cancelAtPeriodEnd).toBe(true);
  });

  it('подписка Stars с признаком от Telegram (is_first_recurring) — продлеваемая, даже если сумма выше текущего потолка', async () => {
    const a = await createAccount(owner);
    const m = as(a.accountId, a.ownerTelegramId);
    await legal(m);
    const r = await b.billing.checkout(m, {
      kind: 'subscription',
      planId: 'pro',
      method: 'stars',
    });
    await b.payments.handleTelegramUpdate({
      message: {
        from: { id: Number(a.ownerTelegramId) },
        successful_payment: {
          currency: 'XTR',
          total_amount: 11473,
          invoice_payload: r.paymentId,
          telegram_payment_charge_id: `ch-${a.accountId}-sub`,
          is_first_recurring: true,
          subscription_expiration_date:
            Math.floor(Date.now() / 1000) + 30 * 86400,
        },
      },
    });
    expect(await sub(a.accountId)).toMatchObject({
      cancelAtPeriodEnd: false,
      starsChargeId: `ch-${a.accountId}-sub`,
    });
  });
});
