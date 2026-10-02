/**
 * Э4: крон assist-billing-tick на реальном Postgres (провайдер — мок,
 * `scope` — только свои кабинеты): пробный, продление WayForPay по
 * recToken (claim-before-charge, повтор тика не списывает дважды), отказ
 * банка и истечение после льготы, автодокупка с потолком денег,
 * предупреждения 80/100% ровно один раз, просрочка счетов.
 */
import {
  describeDb,
  ownerPrisma,
} from '../../modules/assist-sandbox/testing/k3-stack.testing';
import type { PrismaService } from '../../prisma/prisma.service';
import { encryptToken } from '../../shared/token-crypto';
import { paymentTokenKey } from '../../modules/assist-billing/billing-env';
import {
  claimUnits,
  readState,
} from '../../modules/assist-billing/public/entitlements';
import { GRACE_MS } from '../../modules/assist-billing/subscription-state';
import { CHARGE_STATUS_UNKNOWN } from '../../modules/assist-billing/providers';
import {
  createAccount,
  seedUsage,
  setPlan,
  usageOf,
} from '../../modules/assist-billing/testing/billing-fixtures.testing';
import {
  billingEnv,
  billingServices,
  type BillingServices,
} from '../../modules/assist-billing/testing/billing-stack.testing';

jest.setTimeout(120_000);

const DAY = 86_400_000;

describeDb('Э4: крон assist-billing-tick', () => {
  let owner: PrismaService;
  let b: BillingServices;
  const recTokenEnc = () =>
    encryptToken('rec-token-e4', paymentTokenKey(billingEnv()) as string);

  beforeAll(() => {
    owner = ownerPrisma();
    b = billingServices(owner);
  });
  afterAll(async () => {
    await owner.$disconnect();
  });
  beforeEach(() => {
    b.tick.now = () => new Date();
    b.payments.now = () => new Date();
    b.providers.chargeResult = () => ({
      ok: true,
      transactionStatus: 'Approved',
      reasonCode: 1100,
      recToken: null,
      rawPayload: { transactionStatus: 'Approved' },
    });
  });

  it('пробный материализуется от первого сайта; повтор — без второй строки', async () => {
    const created = new Date(Date.now() - 3 * DAY);
    const a = await createAccount(owner, { createdAt: created });
    const scope = { accountIds: [a.accountId] };
    expect(await b.tick.materializeTrials(scope)).toBe(1);
    expect(await b.tick.materializeTrials(scope)).toBe(0);
    const s = await owner.assistSubscription.findUniqueOrThrow({
      where: { accountId: a.accountId },
    });
    expect(s).toMatchObject({ planId: 'trial', method: 'trial' });
    expect(s.anchorAt).toEqual(created);
    expect(s.paidThrough.getTime() - created.getTime()).toBe(14 * DAY);
  });

  it('продление WayForPay: одно списание на период даже при двух тиках подряд и параллельно', async () => {
    const a = await createAccount(owner);
    const scope = { accountIds: [a.accountId] };
    const from = new Date(Date.now() - 30 * DAY - 3_600_000);
    await setPlan(owner, a.accountId, 'start', {
      method: 'wayforpay',
      from,
      recTokenEnc: recTokenEnc(),
    });
    const before = b.providers.charges.length;
    await Promise.all([b.tick.run(scope), b.tick.run(scope)]);
    await b.tick.run(scope);
    const mine = b.providers.charges.slice(before);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      amountMinor: 78900,
      recToken: 'rec-token-e4',
    });
    const s = await owner.assistSubscription.findUniqueOrThrow({
      where: { accountId: a.accountId },
    });
    expect(s.paidThrough.getTime() - from.getTime()).toBe(60 * DAY);
    expect(s.anchorAt).toEqual(from);
    expect(s.renewClaimedAt).toBeNull();
    const st = await readState(owner, a.accountId, new Date());
    expect(st).toMatchObject({ planId: 'start', status: 'active' });
    expect(st.periodStart!.getTime()).toBe(from.getTime() + 30 * DAY);
  });

  it('отказ банка: попытка через сутки, уведомление; после льготы — expired и мягкий стоп', async () => {
    const a = await createAccount(owner);
    const scope = { accountIds: [a.accountId] };
    const from = new Date(Date.now() - 30 * DAY - 3_600_000);
    await setPlan(owner, a.accountId, 'business', {
      method: 'wayforpay',
      from,
      recTokenEnc: recTokenEnc(),
    });
    b.providers.chargeResult = () => ({
      ok: false,
      transactionStatus: 'Declined',
      reasonCode: 1101,
      recToken: null,
      rawPayload: {},
    });
    const sentBefore = b.sent.length;
    const r1 = await b.tick.run(scope);
    expect(r1.renewFailed).toBe(1);
    const r2 = await b.tick.run(scope); // та же сутки — не повторяем
    expect(r2.renewFailed).toBe(0);
    const s = await owner.assistSubscription.findUniqueOrThrow({
      where: { accountId: a.accountId },
    });
    expect(s).toMatchObject({ status: 'active', renewAttempts: 1 });
    expect(b.sent.length - sentBefore).toBe(1);
    // Льгота: тариф действует (старый период), затем — expired.
    expect((await readState(owner, a.accountId, new Date())).status).toBe(
      'grace',
    );
    b.tick.now = () => new Date(s.paidThrough.getTime() + GRACE_MS + 1000);
    const r3 = await b.tick.run(scope);
    expect(r3.expired).toBe(1);
    expect(
      (
        await owner.assistSubscription.findUniqueOrThrow({
          where: { accountId: a.accountId },
        })
      ).status,
    ).toBe('expired');
    expect((await readState(owner, a.accountId, new Date())).planId).toBeNull();
  });

  it('автодокупка: авто-пакет занят → списан и стал докупкой; потолок денег закрывает следующий; отказ — выключение', async () => {
    const a = await createAccount(owner);
    const scope = { accountIds: [a.accountId] };
    await setPlan(owner, a.accountId, 'start', {
      method: 'wayforpay',
      recTokenEnc: recTokenEnc(),
      autoTopUp: true,
      autoTopUpCapMicroUsd: 12_000_000, // два пакета Start по $6
    });
    const state = await readState(owner, a.accountId, new Date());
    await seedUsage(owner, a.accountId, { units: 400 });
    // Лимит 400 выбран, но авто-пакет открыт: виджет продолжает отвечать.
    expect(
      await claimUnits(owner, {
        accountId: a.accountId,
        state,
        units: 1,
        dialogs: 1,
      }),
    ).toBe(true);
    const before = b.providers.charges.length;
    await b.tick.run(scope);
    await b.tick.run(scope);
    expect(b.providers.charges.length - before).toBe(1);
    expect(await usageOf(owner, a.accountId)).toMatchObject({
      units: 401,
      extraUnits: 100,
    });
    // Второй пакет — до потолка $12.
    await seedUsage(owner, a.accountId, { units: 501, extraUnits: 100 });
    await b.tick.run(scope);
    const u = await owner.assistAccountUsage.findFirstOrThrow({
      where: { accountId: a.accountId },
    });
    expect(u.extraUnits).toBe(200);
    expect(Number(u.autoSpentMicroUsd)).toBe(12_000_000);
    // Потолок выбран: сверх 600 авто-пакета нет.
    await seedUsage(owner, a.accountId, { units: 600, extraUnits: 200 });
    await owner.assistAccountUsage.updateMany({
      where: { accountId: a.accountId },
      data: { autoSpentMicroUsd: BigInt(12_000_000) },
    });
    expect(
      await claimUnits(owner, {
        accountId: a.accountId,
        state,
        units: 1,
        dialogs: 1,
      }),
    ).toBe(false);

    // Отказ банка на автодокупке — выключить, уведомить.
    const b2 = await createAccount(owner);
    await setPlan(owner, b2.accountId, 'start', {
      method: 'wayforpay',
      recTokenEnc: recTokenEnc(),
      autoTopUp: true,
      autoTopUpCapMicroUsd: 50_000_000,
    });
    await seedUsage(owner, b2.accountId, { units: 450 });
    b.providers.chargeResult = () => ({
      ok: false,
      transactionStatus: 'Declined',
      reasonCode: 1101,
      recToken: null,
      rawPayload: {},
    });
    await b.tick.run({ accountIds: [b2.accountId] });
    expect(
      (
        await owner.assistSubscription.findUniqueOrThrow({
          where: { accountId: b2.accountId },
        })
      ).autoTopUp,
    ).toBe(false);
  });

  // Аудит Э4: ответ WayForPay без transactionStatus (Duplicate Order ID,
  // 5xx шлюза) — исход неизвестен, а не отказ: платёж не failed (поздний
  // Approved применится), автодокупка выключена, повторов CHARGE нет.
  it('автодокупка: исход списания неизвестен — платёж pending, автодокупка выключена, без повторных списаний', async () => {
    const a = await createAccount(owner);
    await setPlan(owner, a.accountId, 'start', {
      method: 'wayforpay',
      recTokenEnc: recTokenEnc(),
      autoTopUp: true,
      autoTopUpCapMicroUsd: 50_000_000,
    });
    await seedUsage(owner, a.accountId, { units: 450 });
    b.providers.chargeResult = () => ({
      ok: false,
      transactionStatus: CHARGE_STATUS_UNKNOWN,
      reasonCode: 1112,
      recToken: null,
      rawPayload: { reason: 'Duplicate Order ID', reasonCode: 1112 },
    });
    const before = b.providers.charges.length;
    await b.tick.run({ accountIds: [a.accountId] });
    await b.tick.run({ accountIds: [a.accountId] });
    expect(b.providers.charges.length - before).toBe(1);
    const rows = await owner.assistPayment.findMany({
      where: { accountId: a.accountId, kind: 'auto_topup' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
    expect(
      (
        await owner.assistSubscription.findUniqueOrThrow({
          where: { accountId: a.accountId },
        })
      ).autoTopUp,
    ).toBe(false);
  });

  it('предупреждения 80% и 100% — по одному разу на период', async () => {
    const a = await createAccount(owner);
    const scope = { accountIds: [a.accountId] };
    await setPlan(owner, a.accountId, 'start');
    const chat = a.ownerTelegramId.toString();
    const mine = () => b.sent.filter((x) => x.chat_id === chat);
    await seedUsage(owner, a.accountId, { units: 319 });
    expect((await b.tick.run(scope)).notices).toBe(0);
    await seedUsage(owner, a.accountId, { units: 320 });
    expect((await b.tick.run(scope)).notices).toBe(1);
    expect((await b.tick.run(scope)).notices).toBe(0);
    expect(mine().at(-1)!.text).toMatch(/80%/);
    await seedUsage(owner, a.accountId, { units: 400 });
    expect((await b.tick.run(scope)).notices).toBe(1);
    expect((await b.tick.run(scope)).notices).toBe(0);
    expect(mine().at(-1)!.text).toMatch(/исчерпан/);
    expect(mine()).toHaveLength(2);
    // Отметка — условным UPDATE: второй проход (крон + ручной вызов) по
    // той же строке предупреждение не отправит.
    const c = await createAccount(owner);
    await setPlan(owner, c.accountId, 'start');
    const st = await seedUsage(owner, c.accountId, { units: 330 });
    const now = new Date();
    expect(
      await b.tick.claimNotice(c.accountId, st.periodKey!, 'warn80', now),
    ).toBe(true);
    expect(
      await b.tick.claimNotice(c.accountId, st.periodKey!, 'warn80', now),
    ).toBe(false);
    expect(
      await b.tick.claimNotice(c.accountId, st.periodKey!, 'warn100', now),
    ).toBe(true);
    expect(
      await b.tick.claimNotice(c.accountId, st.periodKey!, 'warn100', now),
    ).toBe(false);
    // Менеджеру — ничего: оплата — право владельца.
    expect(
      b.sent.some((x) => x.chat_id === a.managerTelegramId.toString()),
    ).toBe(false);
  });

  it('счёт Stars, не оплаченный за срок ссылки, — expired', async () => {
    const a = await createAccount(owner);
    await owner.assistPayment.create({
      data: {
        id: `ap_e4_old_${a.accountId}`,
        accountId: a.accountId,
        kind: 'subscription',
        planId: 'start',
        method: 'stars',
        currency: 'XTR',
        amountMinor: 1463,
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    expect(
      (await b.tick.run({ accountIds: [a.accountId] })).expiredPayments,
    ).toBe(1);
  });
});
