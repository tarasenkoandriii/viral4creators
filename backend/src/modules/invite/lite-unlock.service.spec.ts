/**
 * Разблокировка Lite — «Условно бесплатный Lite» §4.2, §5.4, этап 135.
 *
 * Проверки про два места, где ошибка стоит дорого: условие, снимающее
 * стену насовсем, и отзыв, который обязан пережить следующее
 * приглашение.
 */

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { LiteUnlockService } from './lite-unlock.service';

function build(
  over: {
    user?: {
      liteUnlockedAt: Date | null;
      liteRevokedAt: Date | null;
      unlockCheck: { id: string } | null;
    } | null;
    counted?: number;
  } = {},
) {
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue(
        over.user === undefined
          ? {
              liteUnlockedAt: null,
              liteRevokedAt: null,
              unlockCheck: { id: 'c1' },
            }
          : over.user,
      ),
      update: jest.fn().mockResolvedValue({}),
    },
    referral: { count: jest.fn().mockResolvedValue(over.counted ?? 7) },
  };
  return { svc: new LiteUnlockService(prisma as never), prisma };
}

const envTarget = async (value: string, fn: () => Promise<void>) => {
  const before = process.env.REFERRAL_UNLOCK_TARGET;
  process.env.REFERRAL_UNLOCK_TARGET = value;
  try {
    await fn();
  } finally {
    if (before === undefined) delete process.env.REFERRAL_UNLOCK_TARGET;
    else process.env.REFERRAL_UNLOCK_TARGET = before;
  }
};

describe('LiteUnlockService.maybeUnlock', () => {
  it('семь засчитанных плюс подписка снимают стену', async () => {
    const { svc, prisma } = build();
    await expect(svc.maybeUnlock('u1')).resolves.toBe(true);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: {
        liteUnlockedAt: expect.any(Date),
        liteUnlockSource: 'EARNED',
      },
    });
  });

  it('шести не хватает', async () => {
    const { svc, prisma } = build({ counted: 6 });
    await expect(svc.maybeUnlock('u1')).resolves.toBe(false);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('без подтверждённой подписки семь приглашений не снимают стену', async () => {
    // Условие §4.2 — «И», а не «или»: подписка даёт одну генерацию,
    // приглашения — по одной за каждое, а стену снимает только пара.
    const { svc, prisma } = build({
      user: { liteUnlockedAt: null, liteRevokedAt: null, unlockCheck: null },
    });
    await expect(svc.maybeUnlock('u1')).resolves.toBe(false);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('засчитанными считаются только НЕ снятые оператором', async () => {
    const { svc, prisma } = build();
    await svc.maybeUnlock('u1');
    expect(prisma.referral.count).toHaveBeenCalledWith({
      where: { inviterId: 'u1', status: 'GENERATED', revokedAt: null },
    });
  });

  it('уже открытую стену второй раз не открывают', async () => {
    const { svc, prisma } = build({
      user: {
        liteUnlockedAt: new Date('2026-09-20T00:00:00Z'),
        liteRevokedAt: null,
        unlockCheck: { id: 'c1' },
      },
    });
    await expect(svc.maybeUnlock('u1')).resolves.toBe(false);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('отзыв оператора не отменяется следующим приглашением', async () => {
    // Главное правило этапа: отзыв сделан отдельным действием и с
    // обязательной причиной. Если бы автоматическая проверка возвращала
    // доступ, он не значил бы ничего — а приглашений у человека
    // по-прежнему семь, и условие формально выполнено.
    const { svc, prisma } = build({
      user: {
        liteUnlockedAt: new Date('2026-09-20T00:00:00Z'),
        liteRevokedAt: new Date('2026-09-22T00:00:00Z'),
        unlockCheck: { id: 'c1' },
      },
    });
    await expect(svc.maybeUnlock('u1')).resolves.toBe(false);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('нулевая цель — законная настройка «хватит подписки»', async () => {
    await envTarget('0', async () => {
      const { svc } = build({ counted: 0 });
      await expect(svc.maybeUnlock('u1')).resolves.toBe(true);
    });
  });

  it('несуществующий пользователь — тихо нет', async () => {
    const { svc, prisma } = build({ user: null });
    await expect(svc.maybeUnlock('u1')).resolves.toBe(false);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

describe('LiteUnlockService — действия оператора', () => {
  it('отзыв пишет причину и НЕ стирает дату разблокировки', async () => {
    // «Почему у меня пропал доступ» должно иметь ответ в базе, а не
    // выясняться по отсутствию поля.
    const { svc, prisma } = build();
    await svc.revoke('u1', 'накрутка: семь приглашений за четыре минуты');
    const data = prisma.user.update.mock.calls[0][0].data;
    expect(data).toEqual({
      liteRevokedAt: expect.any(Date),
      liteRevokedReason: 'накрутка: семь приглашений за четыре минуты',
    });
    expect(data).not.toHaveProperty('liteUnlockedAt');
  });

  it('возврат доступа не правит старых строк, а кладёт новую дату', async () => {
    const { svc, prisma } = build();
    await svc.grantByOperator('u1');
    const data = prisma.user.update.mock.calls[0][0].data;
    expect(data).toEqual({
      liteUnlockedAt: expect.any(Date),
      liteUnlockSource: 'OPERATOR',
    });
    // История отзыва остаётся на месте: право считается по паре дат.
    expect(data).not.toHaveProperty('liteRevokedAt');
    expect(data).not.toHaveProperty('liteRevokedReason');
  });
});
