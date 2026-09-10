/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

/**
 * AdminBillingService (ТЗ §41, этап 62) — список платежей и возврат.
 * Возврат устроен по-разному для двух провайдеров (см. комментарий в
 * самом сервисе): Stars — настоящий вызов API, WayForPay — только
 * пометка статуса (деньги оператор возвращает вручную).
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminBillingService } from './admin-billing.service';

function payment(over: Record<string, unknown> = {}) {
  return {
    id: 'pay1',
    userId: 'u1',
    user: { telegramId: '12345' },
    method: 'STARS',
    purpose: 'CREDIT_PACK',
    plan: null,
    creditsGranted: 20,
    status: 'SUCCEEDED',
    currency: 'XTR',
    amount: 100,
    providerRef: 'ref1',
    failureReason: null,
    createdAt: new Date('2026-09-01'),
    ...over,
  };
}

function build() {
  const prisma = {
    payment: {
      findMany: jest.fn().mockResolvedValue([payment()]),
      count: jest.fn().mockResolvedValue(1),
      findUnique: jest.fn().mockResolvedValue(payment()),
      update: jest
        .fn()
        .mockImplementation(({ data }: { data: any }) =>
          Promise.resolve({ ...payment(), ...data }),
        ),
    },
  };
  const stars = { refundStarPayment: jest.fn().mockResolvedValue(true) };
  const svc = new AdminBillingService(prisma as any, stars as any);
  return { svc, prisma, stars };
}

describe('AdminBillingService.listPayments', () => {
  it('фильтрует по известному статусу/методу, неизвестные значения игнорирует', async () => {
    const { svc, prisma } = build();
    await svc.listPayments({
      status: 'SUCCEEDED',
      method: 'STARS',
      page: 1,
      pageSize: 20,
    });
    expect(prisma.payment.findMany.mock.calls[0][0].where).toEqual({
      status: 'SUCCEEDED',
      method: 'STARS',
    });
  });

  it('неизвестный статус/метод в фильтре не попадает в запрос', async () => {
    const { svc, prisma } = build();
    await svc.listPayments({
      status: 'BOGUS',
      method: 'CASH',
      page: 1,
      pageSize: 20,
    } as any);
    expect(prisma.payment.findMany.mock.calls[0][0].where).toEqual({});
  });

  it('возвращает telegramId пользователя из include, не отдельным запросом', async () => {
    const { svc } = build();
    const res = await svc.listPayments({ page: 1, pageSize: 20 });
    expect(res.items[0].telegramId).toBe('12345');
    expect(res.total).toBe(1);
  });
});

describe('AdminBillingService.refund', () => {
  it('несуществующий платёж — 404', async () => {
    const { svc, prisma } = build();
    prisma.payment.findUnique.mockResolvedValue(null);
    await expect(svc.refund('op1', 'pay1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('платёж не SUCCEEDED — отказ, статус не трогается', async () => {
    const { svc, prisma } = build();
    prisma.payment.findUnique.mockResolvedValue(payment({ status: 'PENDING' }));
    await expect(svc.refund('op1', 'pay1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.payment.update).not.toHaveBeenCalled();
  });

  it('Stars: реальный вызов refundStarPayment, статус меняется на REFUNDED при успехе', async () => {
    const { svc, prisma, stars } = build();
    const res = await svc.refund('op1', 'pay1');
    expect(stars.refundStarPayment).toHaveBeenCalledWith('12345', 'ref1');
    expect(prisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'pay1' },
        data: { status: 'REFUNDED' },
      }),
    );
    expect(res.status).toBe('REFUNDED');
  });

  it('Stars: отказ API — статус не меняется, update не вызывается', async () => {
    const { svc, prisma, stars } = build();
    stars.refundStarPayment.mockResolvedValue(false);
    const res = await svc.refund('op1', 'pay1');
    expect(prisma.payment.update).not.toHaveBeenCalled();
    expect(res.status).toBe('SUCCEEDED');
  });

  it('WayForPay: API-возврата нет — только пометка REFUNDED, refundStarPayment не зовётся', async () => {
    const { svc, prisma, stars } = build();
    prisma.payment.findUnique.mockResolvedValue(
      payment({ method: 'WAYFORPAY', providerRef: 'wfp-ref' }),
    );
    const res = await svc.refund('op1', 'pay1');
    expect(stars.refundStarPayment).not.toHaveBeenCalled();
    expect(prisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'REFUNDED' } }),
    );
    expect(res.status).toBe('REFUNDED');
  });
});
