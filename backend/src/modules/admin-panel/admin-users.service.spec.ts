/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AdminUsersService } from './admin-users.service';

const counts = {
  sessions: 3,
  projects: 1,
  brandManifests: 0,
  libraryEntries: 2,
  publications: 0,
};

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    telegramId: '12345',
    firstName: 'Андрій',
    username: 'andrii',
    isOperator: false,
    isBlocked: false,
    blockedAt: null,
    blockedReason: null,
    plan: 'LITE',
    planSince: null,
    planSelfService: false,
    isTestUser: false,
    freeScenarios: [] as string[],
    termsVersion: '2026-09-06',
    termsAcceptedAt: new Date('2026-09-01'),
    createdAt: new Date('2026-08-01'),
    _count: counts,
    ...over,
  };
}

function build(user: Record<string, unknown> | null = row()) {
  const prisma = {
    user: {
      findMany: jest.fn().mockResolvedValue([row()]),
      findUnique: jest.fn().mockResolvedValue(user),
      count: jest.fn().mockResolvedValue(7),
      groupBy: jest.fn().mockResolvedValue([
        { plan: 'LITE', _count: { _all: 5 } },
        { plan: 'PREMIUM', _count: { _all: 2 } },
      ]),
      update: jest.fn().mockResolvedValue({}),
    },
    session: { findMany: jest.fn().mockResolvedValue([]) },
    // Этап 51: последние сессии карточки читаются сырым запросом без `data`.
    $queryRaw: jest.fn().mockResolvedValue([]),
    // Спека отстала от кода: сводка сессий пользователя идёт через
    // `session-summary.ts` (`$queryRawUnsafe` с параметрами, этап 51);
    // счётчик — `{ count }`.
    $queryRawUnsafe: jest
      .fn()
      .mockImplementation(async (sql: string) =>
        /COUNT\(/i.test(sql) ? [{ count: BigInt(0) }] : [],
      ),
    // Этап 62: подписки — своим сервисом внутри AdminUsersService.
    subscription: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
    },
    // Последний платёж Stars за подписку (Г-2.2, этап 64) — по умолчанию
    // не найден, тесты STARS-отмены переопределяют.
    payment: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  // Учёт расходов (§26): в этих тестах он должен молчать, но быть.
  const aiUsage = {
    forUsers: jest.fn().mockResolvedValue({}),
    breakdownForUser: jest.fn().mockResolvedValue([]),
    spentTodayByUsers: jest.fn().mockResolvedValue({}),
  };
  // Этап 62: баланс кредитов — своим сервисом. Е-1.5 шестого аудита:
  // `adminAdjust` тоже мокается здесь — прежде им никто не пользовался.
  const creditLedger = {
    balancesFor: jest.fn().mockResolvedValue({}),
    adminAdjust: jest.fn().mockResolvedValue(undefined),
  };
  // Г-2.2 (аудит round4, этап 64): немедленная отмена подписки Stars в
  // Telegram при отмене оператором.
  const stars = {
    cancelSubscription: jest.fn().mockResolvedValue(true),
  };
  return {
    svc: new AdminUsersService(
      prisma as any,
      aiUsage as any,
      creditLedger as any,
      stars as any,
    ),
    prisma,
    aiUsage,
    creditLedger,
    stars,
  };
}

describe('AdminUsersService (ТЗ §25)', () => {
  it('список отдаёт сводку по всей базе, а не по странице', async () => {
    const { svc, prisma } = build();
    const res = await svc.list({ q: 'andr', page: 1, pageSize: 20 });

    expect(res.byPlan).toEqual({ LITE: 5, STANDARD: 0, PREMIUM: 2 });
    // groupBy вызывается БЕЗ where — иначе цифра «сколько у нас кого»
    // под отфильтрованным списком читалась бы как общая и врала.
    expect(prisma.user.groupBy).toHaveBeenCalledWith({
      by: ['plan'],
      _count: { _all: true },
    });
    expect(res.items[0].counts.sessions).toBe(3);
  });

  it('поиск ищет по telegramId, username и имени сразу', async () => {
    const { svc, prisma } = build();
    await svc.list({ q: ' andr ', page: 1, pageSize: 20 });
    const where = prisma.user.findMany.mock.calls[0][0].where;
    expect(where.OR).toHaveLength(3);
    expect(JSON.stringify(where.OR)).toContain('andr');
    expect(JSON.stringify(where.OR)).not.toContain(' andr ');
  });

  it('неизвестный режим в фильтре игнорируется, а не подставляется в запрос', async () => {
    const { svc, prisma } = build();
    await svc.list({ plan: 'GOLD', page: 1, pageSize: 20 });
    expect(prisma.user.findMany.mock.calls[0][0].where.plan).toBeUndefined();
  });

  it('неизвестный режим в колонке показывается как Lite', async () => {
    const { svc } = build(row({ plan: 'GOLD' }));
    expect((await svc.get('u1')).plan).toBe('LITE');
  });

  it('смена режима проставляет planSince', async () => {
    const { svc, prisma } = build();
    await svc.patch('op1', 'u1', { plan: 'PREMIUM' });
    const data = prisma.user.update.mock.calls[0][0].data;
    expect(data.plan).toBe('PREMIUM');
    expect(data.planSince).toBeInstanceOf(Date);
  });

  it('назначение оператором снимает флаг самостоятельного выбора (этап 54, Б-3.8)', async () => {
    const { svc, prisma } = build();
    await svc.patch('op1', 'u1', { plan: 'PREMIUM' });
    expect(prisma.user.update.mock.calls[0][0].data.planSelfService).toBe(
      false,
    );
  });

  it('тот же режим, выбранный пользователем самим, оператор «подтверждает» — флаг снимается', async () => {
    const { svc, prisma } = build(row({ plan: 'LITE', planSelfService: true }));
    await svc.patch('op1', 'u1', { plan: 'LITE' });
    expect(prisma.user.update.mock.calls[0][0].data).toEqual({
      planSelfService: false,
    });
  });

  it('тот же режим не пишется в базу', async () => {
    const { svc, prisma } = build();
    await svc.patch('op1', 'u1', { plan: 'LITE' });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('несуществующий режим отвергается', async () => {
    const { svc } = build();
    await expect(
      svc.patch('op1', 'u1', { plan: 'GOLD' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('оператор не может снять права с самого себя', async () => {
    const { svc, prisma } = build(row({ id: 'op1', isOperator: true }));
    await expect(
      svc.patch('op1', 'op1', { isOperator: false }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('снять права с ДРУГОГО оператора можно', async () => {
    const { svc, prisma } = build(row({ id: 'u1', isOperator: true }));
    await svc.patch('op1', 'u1', { isOperator: false });
    expect(prisma.user.update.mock.calls[0][0].data.isOperator).toBe(false);
  });

  it('выдать права другому можно', async () => {
    const { svc, prisma } = build();
    await svc.patch('op1', 'u1', { isOperator: true });
    expect(prisma.user.update.mock.calls[0][0].data.isOperator).toBe(true);
  });
});

describe('AdminUsersService — блокировка (ТЗ §25.3)', () => {
  it('блокировка проставляет время и причину', async () => {
    const { svc, prisma } = build();
    await svc.patch('op1', 'u1', {
      isBlocked: true,
      blockedReason: '  накрутка  ',
    });
    const data = prisma.user.update.mock.calls[0][0].data;
    expect(data.isBlocked).toBe(true);
    expect(data.blockedAt).toBeInstanceOf(Date);
    expect(data.blockedReason).toBe('накрутка');
  });

  it('снятие блокировки чистит причину и время', async () => {
    // Причина, оставшаяся у разблокированного, читается потом как
    // действующий запрет.
    const { svc, prisma } = build(
      row({ isBlocked: true, blockedReason: 'накрутка' }),
    );
    await svc.patch('op1', 'u1', { isBlocked: false });
    const data = prisma.user.update.mock.calls[0][0].data;
    expect(data.isBlocked).toBe(false);
    expect(data.blockedAt).toBeNull();
    expect(data.blockedReason).toBeNull();
  });

  it('оператор не может заблокировать самого себя', async () => {
    const { svc, prisma } = build(row({ id: 'op1' }));
    await expect(
      svc.patch('op1', 'op1', { isBlocked: true }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('причину можно поправить, не трогая состояние', async () => {
    const { svc, prisma } = build(row({ isBlocked: true }));
    await svc.patch('op1', 'u1', { blockedReason: 'уточнение' });
    const data = prisma.user.update.mock.calls[0][0].data;
    expect(data.blockedReason).toBe('уточнение');
    expect(data.isBlocked).toBeUndefined();
  });

  it('блокировка не трогает режим', async () => {
    // Решение владельца продукта: на Lite заблокированный переедет сам,
    // когда закончится оплаченный период.
    const { svc, prisma } = build(row({ plan: 'PREMIUM' }));
    await svc.patch('op1', 'u1', { isBlocked: true });
    const data = prisma.user.update.mock.calls[0][0].data;
    expect(data.plan).toBeUndefined();
    expect(data.planSince).toBeUndefined();
  });

  it('расход берётся одним запросом на всю страницу', async () => {
    const { svc, aiUsage } = build();
    await svc.list({ page: 1, pageSize: 20 });
    expect(aiUsage.forUsers).toHaveBeenCalledTimes(1);
    expect(aiUsage.forUsers).toHaveBeenCalledWith(['u1']);
  });
});

describe('AdminUsersService — кредиты и подписка (этап 62, ТЗ §41)', () => {
  it('баланс кредитов по умолчанию 0, если пользователь не встретился в groupBy', async () => {
    const { svc } = build();
    const res = await svc.list({ page: 1, pageSize: 20 });
    expect(res.items[0].credits).toEqual({ balance: 0 });
    expect(res.items[0].subscription).toBeNull();
  });

  it('баланс кредитов и подписка подставляются из соответствующих сервисов', async () => {
    const { svc, prisma, creditLedger } = build();
    creditLedger.balancesFor.mockResolvedValue({ u1: 7 });
    prisma.subscription.findMany.mockResolvedValue([
      {
        userId: 'u1',
        plan: 'STANDARD',
        status: 'ACTIVE',
        method: 'STARS',
        currentPeriodEnd: new Date('2026-10-01'),
        cancelAtPeriodEnd: false,
      },
    ]);
    const res = await svc.list({ page: 1, pageSize: 20 });
    expect(res.items[0].credits).toEqual({ balance: 7 });
    expect(res.items[0].subscription).toEqual({
      plan: 'STANDARD',
      status: 'ACTIVE',
      method: 'STARS',
      currentPeriodEnd: new Date('2026-10-01'),
      cancelAtPeriodEnd: false,
    });
  });

  it('карточка пользователя тоже несёт кредиты и подписку', async () => {
    const { svc, prisma, creditLedger } = build();
    creditLedger.balancesFor.mockResolvedValue({ u1: 3 });
    prisma.subscription.findMany.mockResolvedValue([
      {
        userId: 'u1',
        plan: 'PREMIUM',
        status: 'PAST_DUE',
        method: 'WAYFORPAY',
        currentPeriodEnd: new Date('2026-09-15'),
        cancelAtPeriodEnd: true,
      },
    ]);
    const detail = await svc.get('u1');
    expect(detail.credits).toEqual({ balance: 3 });
    expect(detail.subscription?.status).toBe('PAST_DUE');
    expect(prisma.subscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: { in: ['u1'] } } }),
    );
  });

  describe('cancelSubscription', () => {
    it('ставит cancelAtPeriodEnd — доступ остаётся до конца периода', async () => {
      const { svc, prisma } = build();
      prisma.subscription.findUnique.mockResolvedValue({
        id: 's1',
        status: 'ACTIVE',
      });
      await svc.cancelSubscription('op1', 'u1');
      expect(prisma.subscription.update).toHaveBeenCalledWith({
        where: { id: 's1' },
        data: { cancelAtPeriodEnd: true },
      });
    });

    it('без подписки — 404', async () => {
      const { svc, prisma } = build();
      prisma.subscription.findUnique.mockResolvedValue(null);
      await expect(svc.cancelSubscription('op1', 'u1')).rejects.toThrow();
      expect(prisma.subscription.update).not.toHaveBeenCalled();
    });

    it('уже CANCELED — идемпотентно, без лишнего update', async () => {
      const { svc, prisma } = build();
      prisma.subscription.findUnique.mockResolvedValue({
        id: 's1',
        status: 'CANCELED',
      });
      await svc.cancelSubscription('op1', 'u1');
      expect(prisma.subscription.update).not.toHaveBeenCalled();
    });

    it('STARS-подписку оператор отменяет и сразу в Telegram (Г-2.2, этап 64)', async () => {
      const { svc, prisma, stars } = build();
      prisma.subscription.findUnique.mockResolvedValue({
        id: 's1',
        status: 'ACTIVE',
        method: 'STARS',
      });
      prisma.payment.findFirst.mockResolvedValue({ providerRef: 'charge-9' });
      await svc.cancelSubscription('op1', 'u1');
      // build() по умолчанию возвращает user.findUnique = row() с
      // telegramId '12345'.
      expect(stars.cancelSubscription).toHaveBeenCalledWith(
        '12345',
        'charge-9',
      );
    });
  });

  describe('adjustCredit (Е-1.5 шестого аудита)', () => {
    it('вызывает adminAdjust с той же дельтой и логирует правку', async () => {
      const { svc, creditLedger } = build();
      await svc.adjustCredit('op1', 'u1', 5);
      expect(creditLedger.adminAdjust).toHaveBeenCalledWith('u1', 5);
    });

    it('отрицательная дельта — тоже проходит (списание/исправление)', async () => {
      const { svc, creditLedger } = build();
      await svc.adjustCredit('op1', 'u1', -3);
      expect(creditLedger.adminAdjust).toHaveBeenCalledWith('u1', -3);
    });

    it('дельта 0 — 400, adminAdjust не вызывается', async () => {
      const { svc, creditLedger } = build();
      await expect(svc.adjustCredit('op1', 'u1', 0)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(creditLedger.adminAdjust).not.toHaveBeenCalled();
    });

    it('дельта не целое число — 400, adminAdjust не вызывается', async () => {
      const { svc, creditLedger } = build();
      await expect(svc.adjustCredit('op1', 'u1', 2.5)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(creditLedger.adminAdjust).not.toHaveBeenCalled();
    });

    it('пользователь не найден — 404, adminAdjust не вызывается', async () => {
      const { svc, prisma, creditLedger } = build(null);
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(svc.adjustCredit('op1', 'missing', 5)).rejects.toThrow();
      expect(creditLedger.adminAdjust).not.toHaveBeenCalled();
    });
  });
});

describe('AdminUsersService — тестовый доступ (TODO §III п.37)', () => {
  const patched = (prisma: any) => prisma.user.update.mock.calls[0][0].data;

  it('галочки сохраняются набором целиком, а не добавкой', async () => {
    // Форма шлёт полный набор: иначе снять галочку было бы нечем.
    const { svc, prisma } = build(
      row({ isTestUser: true, freeScenarios: ['PRODUCT_VIDEO'] }),
    );
    await svc.patch('op', 'u1', { freeScenarios: ['GREETING_VIDEO'] });
    expect(patched(prisma).freeScenarios).toEqual(['GREETING_VIDEO']);
  });

  it('снятие флага чистит галочки', async () => {
    // Оставленный набор у обычного пользователя — мусор, который читают
    // как действующее разрешение, а при повторном включении флага он ещё
    // и сработает молча.
    const { svc, prisma } = build(
      row({ isTestUser: true, freeScenarios: ['PRODUCT_VIDEO'] }),
    );
    await svc.patch('op', 'u1', { isTestUser: false });
    expect(patched(prisma)).toMatchObject({
      isTestUser: false,
      freeScenarios: [],
    });
  });

  it('незнакомый сценарий — отказ, а не молчаливое отбрасывание', async () => {
    // Молча отбросить значило бы показать оператору сохранённую форму
    // без той галочки, которую он ставил, и без объяснения.
    const { svc, prisma } = build(row({ isTestUser: true }));
    await expect(
      svc.patch('op', 'u1', { freeScenarios: ['PRODUCT_VIDEO', 'VIDEO'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('тот же набор в другом порядке не считается изменением', async () => {
    const { svc, prisma } = build(
      row({
        isTestUser: true,
        freeScenarios: ['PRODUCT_VIDEO', 'GREETING_VIDEO'],
      }),
    );
    await svc.patch('op', 'u1', {
      freeScenarios: ['GREETING_VIDEO', 'PRODUCT_VIDEO'],
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('флаг и набор доезжают до карточки', async () => {
    const { svc } = build(
      row({ isTestUser: true, freeScenarios: ['CLIENT_SITE'] }),
    );
    const detail = await svc.get('u1');
    expect(detail.isTestUser).toBe(true);
    expect(detail.freeScenarios).toEqual(['CLIENT_SITE']);
  });

  it('мусор из колонки не доезжает до карточки', async () => {
    // Та же причина, что и у planOf рядом: в колонке может лежать
    // значение, которого код уже не знает.
    const { svc } = build(
      row({ isTestUser: true, freeScenarios: ['CLIENT_SITE', 'nonsense'] }),
    );
    expect((await svc.get('u1')).freeScenarios).toEqual(['CLIENT_SITE']);
  });
});
