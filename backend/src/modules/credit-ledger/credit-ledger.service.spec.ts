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
  const notify = { alert: jest.fn().mockResolvedValue(true) };
  const service = new CreditLedgerService(prisma as never, notify as never);
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

/**
 * Бесплатные начисления — «Условно бесплатный Lite» §4.1, этап 132.
 *
 * Два вопроса, на которых здесь можно ошибиться дорого: выдать вторую
 * приветственную генерацию тому, кто уже получил, и не остановиться,
 * когда наша же ошибка начнёт раздавать генерации пачками.
 */
describe('CreditLedgerService — бесплатные начисления', () => {
  const KEY = 'FREE_GRANT_DAILY_CAP';
  const before = process.env[KEY];
  afterEach(() => {
    if (before === undefined) delete process.env[KEY];
    else process.env[KEY] = before;
  });

  function build(over: { granted?: number; create?: jest.Mock } = {}) {
    const create =
      over.create ?? jest.fn().mockResolvedValue({ id: 'row', delta: 1 });
    const prisma = {
      creditLedger: {
        count: jest.fn().mockResolvedValue(over.granted ?? 0),
        create,
      },
    };
    const notify = { alert: jest.fn().mockResolvedValue(true) };
    return {
      svc: new CreditLedgerService(prisma as never, notify as never),
      prisma,
      create,
      notify,
    };
  }

  it('первая приветственная выдаётся', async () => {
    const { svc, create } = build();
    await expect(svc.grantWelcomeIfFirst('u1')).resolves.toBe(true);
    expect(create).toHaveBeenCalledWith({
      data: { userId: 'u1', delta: 1, reason: 'WELCOME', referralId: null },
    });
  });

  it('вторая — не выдаётся, и это не ошибка', async () => {
    // Идемпотентность держится на частичном уникальном индексе, а не на
    // том, что вызов один: метод зовётся на КАЖДОМ старте рендера у
    // человека без права. P2002 здесь — нормальный ход событий.
    const create = jest.fn().mockRejectedValue({ code: 'P2002' });
    const { svc } = build({ create });
    await expect(svc.grantWelcomeIfFirst('u1')).resolves.toBe(false);
  });

  it('упёрлись в суточный потолок — не начисляем и не роняем вызов', async () => {
    const { svc, create } = build({ granted: 50 });
    await expect(svc.grantWelcomeIfFirst('u1')).resolves.toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it('о сработавшем предохранителе узнаёт служебный канал, а не только лог', async () => {
    // Найдено аудитом этапа 134: §12.3 обещает тревогу, а уходила одна
    // строка в лог — в бессерверном деплое её не увидит никто, и
    // программа могла бы простоять выключенной сутки.
    const { svc, notify } = build({ granted: 50 });
    await svc.grantWelcomeIfFirst('u1');
    expect(notify.alert).toHaveBeenCalledWith(
      // Отпечаток БЕЗ переменной части: с именем пользователя внутри
      // дедупликация не сработала бы никогда.
      'free-grant-daily-cap',
      expect.stringContaining('50'),
    );
  });

  it('молчащий канал тревог не ломает начисление', async () => {
    const { svc, notify } = build({ granted: 50 });
    notify.alert.mockRejectedValue(new Error('Telegram недоступен'));
    await expect(svc.grantWelcomeIfFirst('u1')).resolves.toBe(false);
  });

  it('потолок ноль — начислений нет вовсе, база не спрашивается', async () => {
    process.env[KEY] = '0';
    const { svc, prisma } = build();
    await expect(svc.grantWelcomeIfFirst('u1')).resolves.toBe(false);
    expect(prisma.creditLedger.count).not.toHaveBeenCalled();
  });

  it('потолок считает ВСЕ бесплатные причины, а не одну', async () => {
    // Иначе четыре причины дадут четыре независимых потолка, и
    // предохранитель перестанет быть предохранителем.
    const { svc, prisma } = build();
    await svc.grantWelcomeIfFirst('u1');
    const where = prisma.creditLedger.count.mock.calls[0][0].where;
    expect(where.reason.in).toEqual(
      expect.arrayContaining([
        'WELCOME',
        'SUBSCRIPTION',
        'REFERRAL',
        'REFERRAL_INVITEE',
      ]),
    );
  });

  it('не-P2002 пробрасывается — тихо терять начисления нельзя', async () => {
    const create = jest.fn().mockRejectedValue(new Error('база легла'));
    const { svc } = build({ create });
    await expect(svc.grantWelcomeIfFirst('u1')).rejects.toThrow('база легла');
  });
});
