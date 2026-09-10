import { CreditLedgerService } from './credit-ledger.service';

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

function setup(
  opts: { balance?: number; createImpl?: (data: unknown) => unknown } = {},
) {
  const balance = opts.balance ?? 0;
  const prisma: Record<string, unknown> = {
    creditLedger: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { delta: balance } }),
      create: jest
        .fn()
        .mockImplementation(async ({ data }: { data: unknown }) => {
          if (opts.createImpl) return opts.createImpl(data);
          return { id: 'cl1', ...(data as Record<string, unknown>) };
        }),
      findFirst: jest.fn().mockResolvedValue(null),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    $executeRaw: jest.fn().mockResolvedValue(1),
    $transaction: jest.fn(),
  };
  (prisma.$transaction as jest.Mock).mockImplementation(
    (fn: (tx: unknown) => unknown) => fn(prisma),
  );
  const service = new CreditLedgerService(prisma as never);
  return { service, prisma };
}

describe('CreditLedgerService', () => {
  describe('balanceOf', () => {
    it('returns 0 for anonymous (userId null)', async () => {
      const { service } = setup();
      expect(await service.balanceOf(null)).toBe(0);
    });

    it('returns 0 when the ledger has no rows (aggregate sum null)', async () => {
      const { service, prisma } = setup();
      (
        prisma.creditLedger as { aggregate: jest.Mock }
      ).aggregate.mockResolvedValue({
        _sum: { delta: null },
      });
      expect(await service.balanceOf('u1')).toBe(0);
    });

    it('returns the SUM(delta) for a real user', async () => {
      const { service } = setup({ balance: 4 });
      expect(await service.balanceOf('u1')).toBe(4);
    });
  });

  describe('balancesFor — этап 62, список админки', () => {
    it('пустой список пользователей — пустой результат, без запроса к базе', async () => {
      const { service, prisma } = setup();
      expect(await service.balancesFor([])).toEqual({});
      expect(
        (prisma.creditLedger as { groupBy: jest.Mock }).groupBy,
      ).not.toHaveBeenCalled();
    });

    it('отдаёт баланс по каждому id из groupBy', async () => {
      const { service, prisma } = setup();
      (prisma.creditLedger as { groupBy: jest.Mock }).groupBy.mockResolvedValue(
        [
          { userId: 'u1', _sum: { delta: 3 } },
          { userId: 'u2', _sum: { delta: -1 } },
        ],
      );
      expect(await service.balancesFor(['u1', 'u2', 'u3'])).toEqual({
        u1: 3,
        u2: -1,
      });
    });

    it('пользователь без единой строки леджера просто отсутствует в ответе (не 0 явно, но читается как 0)', async () => {
      const { service, prisma } = setup();
      (prisma.creditLedger as { groupBy: jest.Mock }).groupBy.mockResolvedValue(
        [],
      );
      const result = await service.balancesFor(['u1']);
      expect(result.u1).toBeUndefined();
      expect(result.u1 ?? 0).toBe(0);
    });
  });

  describe('reserveForGeneration', () => {
    it('returns false for anonymous — anonymous users never hold credits', async () => {
      const { service, prisma } = setup({ balance: 5 });
      expect(await service.reserveForGeneration(null, 'gv1')).toBe(false);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('returns false and inserts nothing when balance is 0', async () => {
      const { service, prisma } = setup({ balance: 0 });
      const ok = await service.reserveForGeneration('u1', 'gv1');
      expect(ok).toBe(false);
      expect(
        (prisma.creditLedger as { create: jest.Mock }).create,
      ).not.toHaveBeenCalled();
    });

    it('reserves under an advisory lock and inserts one CONSUME row when balance > 0', async () => {
      const { service, prisma } = setup({ balance: 3 });
      const ok = await service.reserveForGeneration('u1', 'gv1');
      expect(ok).toBe(true);
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
      expect(
        (prisma.creditLedger as { create: jest.Mock }).create,
      ).toHaveBeenCalledWith({
        data: {
          userId: 'u1',
          delta: -1,
          reason: 'CONSUME',
          generatedVideoId: 'gv1',
        },
      });
    });

    it('treats a P2002 unique-constraint race on (generatedVideoId, reason) as already-reserved, not a failure', async () => {
      const { service } = setup({
        balance: 1,
        createImpl: () => {
          throw { code: 'P2002' };
        },
      });
      expect(await service.reserveForGeneration('u1', 'gv1')).toBe(true);
    });

    it('propagates a genuinely unexpected error', async () => {
      const { service } = setup({
        balance: 1,
        createImpl: () => {
          throw new Error('db is down');
        },
      });
      await expect(service.reserveForGeneration('u1', 'gv1')).rejects.toThrow(
        'db is down',
      );
    });
  });

  describe('refundIfReserved', () => {
    it('is a no-op when generatedVideoId is falsy', async () => {
      const { service, prisma } = setup();
      await service.refundIfReserved(null);
      await service.refundIfReserved(undefined);
      expect(
        (prisma.creditLedger as { findFirst: jest.Mock }).findFirst,
      ).not.toHaveBeenCalled();
    });

    it('is a no-op when no CONSUME row exists for that attempt (plain daily-limit path, not a credit)', async () => {
      const { service, prisma } = setup();
      await service.refundIfReserved('gv1');
      expect(
        (prisma.creditLedger as { create: jest.Mock }).create,
      ).not.toHaveBeenCalled();
    });

    it('inserts exactly one REFUND row when a CONSUME row exists', async () => {
      const { service, prisma } = setup();
      (
        prisma.creditLedger as { findFirst: jest.Mock }
      ).findFirst.mockResolvedValue({
        userId: 'u1',
      });
      await service.refundIfReserved('gv1');
      expect(
        (prisma.creditLedger as { create: jest.Mock }).create,
      ).toHaveBeenCalledWith({
        data: {
          userId: 'u1',
          delta: 1,
          reason: 'REFUND',
          generatedVideoId: 'gv1',
        },
      });
    });

    it('swallows a repeat refund (P2002 on the same generatedVideoId) rather than throwing — best-effort, called from markFailed()', async () => {
      const { service, prisma } = setup({
        createImpl: () => {
          throw { code: 'P2002' };
        },
      });
      (
        prisma.creditLedger as { findFirst: jest.Mock }
      ).findFirst.mockResolvedValue({
        userId: 'u1',
      });
      await expect(service.refundIfReserved('gv1')).resolves.toBeUndefined();
    });

    it('never throws even on an unexpected error — best-effort by contract', async () => {
      const { service, prisma } = setup({
        createImpl: () => {
          throw new Error('db is down');
        },
      });
      (
        prisma.creditLedger as { findFirst: jest.Mock }
      ).findFirst.mockResolvedValue({
        userId: 'u1',
      });
      await expect(service.refundIfReserved('gv1')).resolves.toBeUndefined();
    });
  });

  describe('grant', () => {
    it('inserts a PURCHASE row with the given delta and paymentId', async () => {
      const { service, prisma } = setup();
      await service.grant('u1', 20, 'pay1');
      expect(
        (prisma.creditLedger as { create: jest.Mock }).create,
      ).toHaveBeenCalledWith({
        data: {
          userId: 'u1',
          delta: 20,
          reason: 'PURCHASE',
          paymentId: 'pay1',
        },
      });
    });
  });

  describe('adminAdjust', () => {
    it('inserts an ADMIN_ADJUST row without a paymentId', async () => {
      const { service, prisma } = setup();
      await service.adminAdjust('u1', -2);
      expect(
        (prisma.creditLedger as { create: jest.Mock }).create,
      ).toHaveBeenCalledWith({
        data: { userId: 'u1', delta: -2, reason: 'ADMIN_ADJUST' },
      });
    });
  });
});
