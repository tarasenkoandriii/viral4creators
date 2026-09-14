/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

/**
 * BillingRenewalWorkerService (этап 62, ТЗ §41.4) — крон-воркер продления
 * подписок: выбирает просроченные строки и ветвится на три случая —
 * запрошенная отмена, WayForPay (списание) и Stars (сверка). Провайдерские
 * сервисы здесь мокнуты — их собственная логика (грейс-период, backoff)
 * проверена отдельно в wayforpay-renewal.service.spec.ts и
 * stars-subscription-reconcile.service.spec.ts.
 */

import { BillingRenewalWorkerService } from './billing-renewal-worker.service';

function build(rows: unknown[] = [], opts: { jobLockHeld?: boolean } = {}) {
  const prisma = {
    subscription: {
      findMany: jest.fn().mockResolvedValue(rows),
      update: jest.fn().mockResolvedValue({}),
    },
    // Джоб-уровневый замок (Е-1.3 шестого аудита) — по умолчанию свободен,
    // тот же мок, что у catalog-batch/ab-test/feed-import-воркеров.
    cronJobLock: {
      create: jest.fn(() =>
        opts.jobLockHeld
          ? Promise.reject(
              Object.assign(new Error('unique'), { code: 'P2002' }),
            )
          : Promise.resolve(undefined),
      ),
      updateMany: jest
        .fn()
        .mockResolvedValue({ count: opts.jobLockHeld ? 0 : 1 }),
    },
  };
  const plans = { applyPurchasedPlan: jest.fn().mockResolvedValue(undefined) };
  const wayforpayRenewal = { charge: jest.fn() };
  const starsReconcile = { reconcile: jest.fn() };
  const svc = new BillingRenewalWorkerService(
    prisma as any,
    plans as any,
    wayforpayRenewal as any,
    starsReconcile as any,
  );
  return { svc, prisma, plans, wayforpayRenewal, starsReconcile };
}

const row = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 's1',
  userId: 'u1',
  plan: 'STANDARD',
  method: 'WAYFORPAY',
  currentPeriodEnd: new Date(Date.now() - 60_000),
  cancelAtPeriodEnd: false,
  recTokenEnc: 'enc',
  ...over,
});

describe('BillingRenewalWorkerService.runBatch — выбор просроченных подписок', () => {
  it('берёт только просроченные и не отменённые, до cronBatch штук', async () => {
    const { svc, prisma } = build([]);
    await svc.runBatch();
    expect(prisma.subscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          currentPeriodEnd: { lte: expect.any(Date) },
          status: { not: 'CANCELED' },
        }),
      }),
    );
  });

  it('пустая выборка — нулевая сводка, ничего не падает', async () => {
    const { svc } = build([]);
    const result = await svc.runBatch();
    expect(result).toEqual({
      processed: 0,
      renewed: 0,
      canceled: 0,
      pastDue: 0,
    });
  });
});

describe('BillingRenewalWorkerService.runBatch — запрошенная отмена (cancelAtPeriodEnd)', () => {
  it('не звонит ни одному провайдеру — сразу CANCELED + понижение до LITE', async () => {
    const { svc, prisma, plans, wayforpayRenewal, starsReconcile } = build([
      row({ cancelAtPeriodEnd: true }),
    ]);
    const result = await svc.runBatch();
    expect(prisma.subscription.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { status: 'CANCELED' },
    });
    expect(plans.applyPurchasedPlan).toHaveBeenCalledWith('u1', 'LITE');
    expect(wayforpayRenewal.charge).not.toHaveBeenCalled();
    expect(starsReconcile.reconcile).not.toHaveBeenCalled();
    expect(result.canceled).toBe(1);
  });
});

describe('BillingRenewalWorkerService.runBatch — ветвление по method', () => {
  it('WAYFORPAY идёт в WayForPayRenewalService.charge', async () => {
    const { svc, wayforpayRenewal, starsReconcile } = build([
      row({ method: 'WAYFORPAY' }),
    ]);
    wayforpayRenewal.charge.mockResolvedValue('renewed');
    const result = await svc.runBatch();
    expect(wayforpayRenewal.charge).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's1' }),
    );
    expect(starsReconcile.reconcile).not.toHaveBeenCalled();
    expect(result.renewed).toBe(1);
  });

  it('STARS идёт в StarsSubscriptionReconcileService.reconcile', async () => {
    const { svc, wayforpayRenewal, starsReconcile } = build([
      row({ method: 'STARS' }),
    ]);
    starsReconcile.reconcile.mockResolvedValue('past_due');
    const result = await svc.runBatch();
    expect(starsReconcile.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's1' }),
    );
    expect(wayforpayRenewal.charge).not.toHaveBeenCalled();
    expect(result.pastDue).toBe(1);
  });

  it('canceled от провайдерского сервиса тоже учитывается в сводке', async () => {
    const { svc, wayforpayRenewal } = build([row({ method: 'WAYFORPAY' })]);
    wayforpayRenewal.charge.mockResolvedValue('canceled');
    const result = await svc.runBatch();
    expect(result.canceled).toBe(1);
  });
});

describe('BillingRenewalWorkerService.runBatch — устойчивость к сбоям одной строки', () => {
  it('падение одной подписки не мешает обработать остальные', async () => {
    const { svc, wayforpayRenewal, starsReconcile } = build([
      row({ id: 's1', method: 'WAYFORPAY' }),
      row({ id: 's2', method: 'STARS' }),
    ]);
    wayforpayRenewal.charge.mockRejectedValue(new Error('сеть недоступна'));
    starsReconcile.reconcile.mockResolvedValue('past_due');
    const result = await svc.runBatch();
    expect(result.processed).toBe(2);
    expect(result.pastDue).toBe(1);
  });
});

describe('BillingRenewalWorkerService.runBatch — джоб-уровневый замок (Е-1.3 шестого аудита)', () => {
  it('замок уже занят другим прогоном — тик пропускается, подписки не читаются', async () => {
    const { svc, prisma, wayforpayRenewal, starsReconcile } = build(
      [row({ method: 'WAYFORPAY' })],
      { jobLockHeld: true },
    );
    const result = await svc.runBatch();
    expect(prisma.subscription.findMany).not.toHaveBeenCalled();
    expect(wayforpayRenewal.charge).not.toHaveBeenCalled();
    expect(starsReconcile.reconcile).not.toHaveBeenCalled();
    expect(result).toEqual({
      processed: 0,
      renewed: 0,
      canceled: 0,
      pastDue: 0,
    });
  });

  it('замок снимается после успешного прогона', async () => {
    const { svc, prisma } = build([]);
    await svc.runBatch();
    expect(prisma.cronJobLock.updateMany).toHaveBeenCalledWith({
      where: { jobKey: 'billing-renew', ownerToken: expect.any(String) },
      data: { lockedUntil: null, ownerToken: null },
    });
  });

  it('замок снимается даже если провайдерский вызов упал', async () => {
    const { svc, prisma, wayforpayRenewal } = build([
      row({ method: 'WAYFORPAY' }),
    ]);
    wayforpayRenewal.charge.mockRejectedValue(new Error('сбой'));
    await svc.runBatch();
    expect(prisma.cronJobLock.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { jobKey: 'billing-renew', ownerToken: expect.any(String) },
        data: { lockedUntil: null, ownerToken: null },
      }),
    );
  });
});
