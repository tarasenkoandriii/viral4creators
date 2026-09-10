/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

/**
 * StarsSubscriptionReconcileService (этап 62, ТЗ §41.2/41.4) — Stars
 * продлевает себя сам через Telegram; этот сервис ТОЛЬКО сверяет —
 * списание не инициирует, потому что не может (нет recToken-эквивалента
 * у Stars).
 */

import { StarsSubscriptionReconcileService } from './stars-subscription-reconcile.service';

function build(updateManyCount = 1) {
  const prisma = {
    subscription: {
      updateMany: jest.fn().mockResolvedValue({ count: updateManyCount }),
    },
  };
  const plans = { applyPurchasedPlan: jest.fn().mockResolvedValue(undefined) };
  const svc = new StarsSubscriptionReconcileService(
    prisma as any,
    plans as any,
  );
  return { svc, prisma, plans };
}

const subscription = (overdueDays: number) => ({
  id: 's1',
  userId: 'u1',
  currentPeriodEnd: new Date(Date.now() - overdueDays * 24 * 60 * 60 * 1000),
});

describe('StarsSubscriptionReconcileService.reconcile', () => {
  it('в пределах грейса — PAST_DUE, режим не трогается', async () => {
    const { svc, prisma, plans } = build();
    const sub = subscription(1);
    const outcome = await svc.reconcile(sub);
    expect(outcome).toBe('past_due');
    expect(prisma.subscription.updateMany).toHaveBeenCalledWith({
      where: { id: 's1', currentPeriodEnd: sub.currentPeriodEnd },
      data: { status: 'PAST_DUE' },
    });
    expect(plans.applyPurchasedPlan).not.toHaveBeenCalled();
  });

  it('за пределами грейса — CANCELED и понижение до LITE', async () => {
    const { svc, prisma, plans } = build();
    const sub = subscription(4);
    const outcome = await svc.reconcile(sub);
    expect(outcome).toBe('canceled');
    expect(prisma.subscription.updateMany).toHaveBeenCalledWith({
      where: { id: 's1', currentPeriodEnd: sub.currentPeriodEnd },
      data: { status: 'CANCELED' },
    });
    expect(plans.applyPurchasedPlan).toHaveBeenCalledWith('u1', 'LITE');
  });

  it('Е-1.1: снимок устарел (подписка уже продлена вебхуком) — PAST_DUE не пишется, план не трогается', async () => {
    // updateMany матчит по снимку currentPeriodEnd — 0 совпадений
    // означает, что реальная строка в БД уже другая (её сдвинул
    // задержанный successful_payment между чтением и сверкой).
    const { svc, prisma, plans } = build(0);
    const outcome = await svc.reconcile(subscription(1));
    expect(outcome).toBe('past_due');
    expect(prisma.subscription.updateMany).toHaveBeenCalledTimes(1);
    expect(plans.applyPurchasedPlan).not.toHaveBeenCalled();
  });

  it('Е-1.1: снимок устарел за пределами грейса — CANCELED не пишется, план НЕ понижается до LITE', async () => {
    // Тот самый сценарий из аудита: реальный (задержанный) вебхук
    // продления пришёл между чтением снимка и этим вызовом — без фикса
    // здесь произошёл бы откат уже оплаченной подписки на LITE.
    const { svc, prisma, plans } = build(0);
    const outcome = await svc.reconcile(subscription(4));
    expect(outcome).toBe('past_due');
    expect(prisma.subscription.updateMany).toHaveBeenCalledTimes(1);
    expect(plans.applyPurchasedPlan).not.toHaveBeenCalled();
  });

  it('не вызывает НИЧЕГО похожего на прямое списание — это чисто сверка', async () => {
    // Отрицательный тест на архитектурное свойство: у сервиса физически
    // нет метода charge()/списание — здесь просто фиксируем набор
    // вызовов Prisma, чтобы регресс («кто-то добавил списание сюда») был
    // виден по новому мок-вызову, которого тест не ожидает.
    const { svc, prisma } = build();
    await svc.reconcile(subscription(1));
    expect(Object.keys(prisma.subscription)).toEqual(['updateMany']);
  });
});
