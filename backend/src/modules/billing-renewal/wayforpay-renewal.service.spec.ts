/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

/**
 * WayForPayRenewalService (этап 62, ТЗ §41.2/41.4; идемпотентность —
 * Г-2.7 аудита round4, этап 64) — настоящее серверное списание по
 * сохранённому `recToken`: успех продлевает период и пишет Payment,
 * неудача идёт в грейс-период (PAST_DUE) до `GRACE_PERIOD_DAYS`, после —
 * CANCELED + понижение до LITE. Claim (`subscription.updateMany`) и
 * детерминированный `orderReference` (`payment.upsert`) защищают от
 * двойного списания при ретрае/конкурентном прогоне.
 */

import { WayForPayRenewalService } from './wayforpay-renewal.service';
import { encryptToken } from '../../common/token-crypto';

const PAYMENT_TOKEN_KEY = 'b'.repeat(43) + '=';

function build() {
  const prisma = {
    payment: {
      upsert: jest.fn().mockResolvedValue({ id: 'pay1' }),
      update: jest.fn().mockResolvedValue({}),
      // М-1.4: прежние попытки этого периода — по умолчанию нет.
      findMany: jest.fn().mockResolvedValue([]),
    },
    subscription: {
      // Claim (Г-2.7) — по умолчанию успешно захвачен, тесты гонки
      // переопределяют.
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const plans = { applyPurchasedPlan: jest.fn().mockResolvedValue(undefined) };
  const wayforpay = { chargeRecToken: jest.fn() };
  const svc = new WayForPayRenewalService(
    prisma as any,
    plans as any,
    wayforpay as any,
  );
  return { svc, prisma, plans, wayforpay };
}

const envBefore = { ...process.env };
beforeEach(() => {
  process.env.PAYMENT_TOKEN_KEY = PAYMENT_TOKEN_KEY;
});
afterEach(() => {
  process.env = { ...envBefore };
});

const recTokenEnc = () => encryptToken('rec-abc', PAYMENT_TOKEN_KEY);

const subscription = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 's1',
  userId: 'u1',
  plan: 'STANDARD',
  currentPeriodEnd: new Date(Date.now() - 60_000), // просрочена на минуту — свежая просрочка
  recTokenEnc: recTokenEnc(),
  ...over,
});

describe('WayForPayRenewalService.charge — claim перед списанием (Г-2.7)', () => {
  it('захватывает строку атомарным updateMany ДО расшифровки/списания', async () => {
    const { svc, prisma, wayforpay } = build();
    wayforpay.chargeRecToken.mockResolvedValue({
      ok: true,
      transactionStatus: 'Approved',
      rawPayload: {},
      recToken: 'rec-new',
    });
    const sub = subscription();
    await svc.charge(sub);
    expect(prisma.subscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 's1',
          currentPeriodEnd: sub.currentPeriodEnd,
        }),
        data: { status: 'RENEWING' },
      }),
    );
  });

  it('строка уже захвачена другим прогоном (count 0) — отступает без списания', async () => {
    const { svc, prisma, wayforpay } = build();
    prisma.subscription.updateMany.mockResolvedValue({ count: 0 });
    const outcome = await svc.charge(subscription());
    expect(outcome).toBe('past_due');
    expect(wayforpay.chargeRecToken).not.toHaveBeenCalled();
    expect(prisma.payment.upsert).not.toHaveBeenCalled();
  });
});

describe('WayForPayRenewalService.charge — успешное списание', () => {
  it('продлевает currentPeriodEnd на 30 суток и переводит Payment в SUCCEEDED', async () => {
    const { svc, prisma, wayforpay } = build();
    wayforpay.chargeRecToken.mockResolvedValue({
      ok: true,
      transactionStatus: 'Approved',
      rawPayload: {},
      recToken: 'rec-new',
    });
    const outcome = await svc.charge(subscription());
    expect(outcome).toBe('renewed');
    // Детерминированный orderReference — sub:<id>:<periodEnd> (Г-2.7).
    expect(prisma.payment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          method_providerRef: {
            method: 'WAYFORPAY',
            providerRef: expect.stringMatching(/^sub:s1:\d+$/),
          },
        },
        create: expect.objectContaining({ status: 'PENDING' }),
      }),
    );
    expect(prisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'pay1' },
        data: expect.objectContaining({ status: 'SUCCEEDED' }),
      }),
    );
    expect(prisma.subscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 's1' },
        data: expect.objectContaining({ status: 'ACTIVE' }),
      }),
    );
    const data = prisma.subscription.update.mock.calls[0][0].data;
    expect(new Date(data.currentPeriodEnd).getTime()).toBeGreaterThan(
      Date.now(),
    );
  });

  it('обновляет recTokenEnc, если провайдер вернул новый токен', async () => {
    const { svc, prisma, wayforpay } = build();
    wayforpay.chargeRecToken.mockResolvedValue({
      ok: true,
      transactionStatus: 'Approved',
      rawPayload: {},
      recToken: 'rec-new',
    });
    await svc.charge(subscription());
    const data = prisma.subscription.update.mock.calls[0][0].data;
    expect(data.recTokenEnc).toBeDefined();
    expect(data.recTokenEnc).not.toBe(recTokenEnc());
  });

  it('вырезает recToken/cardPan/authCode из rawPayload перед сохранением (Г-3.3)', async () => {
    const { svc, prisma, wayforpay } = build();
    wayforpay.chargeRecToken.mockResolvedValue({
      ok: true,
      transactionStatus: 'Approved',
      rawPayload: { transactionStatus: 'Approved', recToken: 'secret-rec' },
      recToken: 'rec-new',
    });
    await svc.charge(subscription());
    const data = prisma.payment.update.mock.calls[0][0].data;
    expect(data.rawPayload).not.toHaveProperty('recToken');
    expect(data.rawPayload).toMatchObject({ transactionStatus: 'Approved' });
  });
});

describe('WayForPayRenewalService.charge — неудача внутри грейс-периода', () => {
  it('транзакция отклонена — PAST_DUE, а не CANCELED (просрочка свежая)', async () => {
    const { svc, prisma, plans, wayforpay } = build();
    wayforpay.chargeRecToken.mockResolvedValue({
      ok: false,
      transactionStatus: 'Declined',
      rawPayload: {},
    });
    const outcome = await svc.charge(subscription());
    expect(outcome).toBe('past_due');
    expect(prisma.subscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 's1' }),
        data: { status: 'PAST_DUE' },
      }),
    );
    expect(plans.applyPurchasedPlan).not.toHaveBeenCalled();
  });

  it('сетевая ошибка API — тоже PAST_DUE в пределах грейса, Payment остаётся PENDING (не обновляется)', async () => {
    const { svc, prisma, wayforpay } = build();
    wayforpay.chargeRecToken.mockRejectedValue(new Error('таймаут'));
    const outcome = await svc.charge(subscription());
    expect(outcome).toBe('past_due');
    // PENDING-строка заводится ДО вызова провайдера (claim-before-charge)
    // — при сетевой ошибке она НЕ обновляется, следующий ретрай
    // переиспользует её по тому же orderReference.
    expect(prisma.payment.upsert).toHaveBeenCalled();
    expect(prisma.payment.update).not.toHaveBeenCalled();
  });
});

describe('WayForPayRenewalService.charge — грейс-период исчерпан', () => {
  const overdueBeyondGrace = () =>
    subscription({
      currentPeriodEnd: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000),
    });

  it('просрочка дольше GRACE_PERIOD_DAYS — CANCELED и понижение до LITE', async () => {
    const { svc, prisma, plans, wayforpay } = build();
    wayforpay.chargeRecToken.mockResolvedValue({
      ok: false,
      transactionStatus: 'Declined',
      rawPayload: {},
    });
    const outcome = await svc.charge(overdueBeyondGrace());
    expect(outcome).toBe('canceled');
    expect(prisma.subscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 's1' }),
        data: { status: 'CANCELED' },
      }),
    );
    expect(plans.applyPurchasedPlan).toHaveBeenCalledWith('u1', 'LITE');
  });

  it('сетевая ошибка за пределами грейса — тоже сдаёмся', async () => {
    const { svc, plans, wayforpay } = build();
    wayforpay.chargeRecToken.mockRejectedValue(new Error('таймаут'));
    const outcome = await svc.charge(overdueBeyondGrace());
    expect(outcome).toBe('canceled');
    expect(plans.applyPurchasedPlan).toHaveBeenCalledWith('u1', 'LITE');
  });
});

describe('WayForPayRenewalService.charge — отсутствие recToken', () => {
  it('без recTokenEnc — сразу как исчерпанный грейс (списывать нечем), claim не трогаем', async () => {
    const { svc, prisma, plans, wayforpay } = build();
    const outcome = await svc.charge(subscription({ recTokenEnc: null }));
    expect(outcome).toBe('canceled');
    expect(plans.applyPurchasedPlan).toHaveBeenCalledWith('u1', 'LITE');
    expect(wayforpay.chargeRecToken).not.toHaveBeenCalled();
    // М-1.5: отмена — условная (updateMany по снимку срока), claim'а нет.
    expect(prisma.subscription.updateMany).toHaveBeenCalledTimes(1);
  });

  it('повреждённый recTokenEnc (не расшифровывается) — не роняет крон, идёт по грейсу', async () => {
    const { svc, wayforpay } = build();
    const outcome = await svc.charge(
      subscription({ recTokenEnc: 'мусор.не.токен' }),
    );
    expect(['past_due', 'canceled']).toContain(outcome);
    expect(wayforpay.chargeRecToken).not.toHaveBeenCalled();
  });
});

// М-1.4/М-1.5 седьмого аудита.
describe('WayForPayRenewalService.charge — номер заказа и условные статусы', () => {
  it('после терминального отказа новая попытка идёт с суффиксом, незавершённая — переиспользует номер', async () => {
    const { svc, prisma, wayforpay } = build();
    wayforpay.chargeRecToken.mockResolvedValue({
      ok: false,
      transactionStatus: 'Declined',
      rawPayload: {},
    });
    const sub = subscription();
    const base = `sub:s1:${sub.currentPeriodEnd.getTime()}`;
    prisma.payment.findMany.mockResolvedValueOnce([
      { providerRef: base, status: 'FAILED' },
    ]);
    await svc.charge(sub);
    expect(
      prisma.payment.upsert.mock.calls[0][0].where.method_providerRef
        .providerRef,
    ).toBe(`${base}:1`);

    prisma.payment.findMany.mockResolvedValueOnce([
      { providerRef: base, status: 'FAILED' },
      { providerRef: `${base}:1`, status: 'PENDING' },
    ]);
    await svc.charge(sub);
    expect(
      prisma.payment.upsert.mock.calls[1][0].where.method_providerRef
        .providerRef,
    ).toBe(`${base}:1`);
  });

  it('промежуточный статус (InProcessing) — Payment остаётся PENDING, не FAILED', async () => {
    const { svc, prisma, wayforpay } = build();
    wayforpay.chargeRecToken.mockResolvedValue({
      ok: false,
      transactionStatus: 'InProcessing',
      rawPayload: {},
    });
    await svc.charge(subscription());
    expect(prisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PENDING' }),
      }),
    );
  });

  it('срок сдвинулся во время продления (count 0) — не отменяем и не понижаем до LITE', async () => {
    const { svc, prisma, plans, wayforpay } = build();
    prisma.subscription.updateMany
      .mockResolvedValueOnce({ count: 1 }) // claim
      .mockResolvedValueOnce({ count: 0 }); // giveUp — уже продлили
    wayforpay.chargeRecToken.mockResolvedValue({
      ok: false,
      transactionStatus: 'Declined',
      rawPayload: {},
    });
    const outcome = await svc.charge(
      subscription({
        currentPeriodEnd: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000),
      }),
    );
    expect(outcome).toBe('past_due');
    expect(plans.applyPurchasedPlan).not.toHaveBeenCalled();
  });
});
