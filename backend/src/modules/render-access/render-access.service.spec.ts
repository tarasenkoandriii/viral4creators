/**
 * Право начать рендер — «Условно бесплатный Lite» §8.1, этап 132.
 *
 * Это единственное место в продукте, которое решает, тратить ли наши
 * деньги на ролик, и до него такого места не было вовсе. Поэтому тесты
 * здесь проверяют не «работает ли метод», а те три вопроса, на которых
 * он может ошибиться дорого: пускать ли без права, чем оплачено и не
 * потеряли ли мы по дороге суточный потолок.
 */

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import {
  GenerationLockedException,
  RenderAccessService,
} from './render-access.service';

const WALL = 'FREE_TIER_WALL_ENABLED';
const before = process.env[WALL];
afterEach(() => {
  if (before === undefined) delete process.env[WALL];
  else process.env[WALL] = before;
});

function build(
  over: {
    wall?: boolean;
    user?: Record<string, unknown> | null;
    credit?: boolean;
  } = {},
) {
  if (over.wall) process.env[WALL] = 'true';
  else delete process.env[WALL];

  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue(over.user ?? null) },
  };
  const plans = {
    assertCanSpendUser: jest.fn().mockResolvedValue(undefined),
  };
  const credits = {
    reserveForGeneration: jest.fn().mockResolvedValue(over.credit ?? false),
    grantWelcomeIfFirst: jest.fn().mockResolvedValue(true),
  };
  const svc = new RenderAccessService(
    prisma as never,
    plans as never,
    credits as never,
  );
  return { svc, prisma, plans, credits };
}

const unlocked = {
  liteUnlockedAt: new Date('2026-09-01'),
  liteRevokedAt: null,
};

describe('RenderAccessService — рубильник выключен', () => {
  it('ведёт себя ровно как продукт до этапа 132', async () => {
    // Кредита нет — суточный потолок, как и было. Ни одного нового
    // отказа: выключенный рубильник обязан возвращать прежний продукт
    // целиком, иначе им нельзя пользоваться как аварийным.
    const { svc, plans } = build();
    await expect(svc.assertCanRender('u1', 'v1')).resolves.toEqual({
      usedCredit: false,
    });
    expect(plans.assertCanSpendUser).toHaveBeenCalledWith('u1', {
      projectId: null,
    });
  });

  it('анонимный проходит — как и раньше, под общим потолком', async () => {
    const { svc, plans } = build();
    await expect(svc.assertCanRender(null, 'v1')).resolves.toEqual({
      usedCredit: false,
    });
    expect(plans.assertCanSpendUser).toHaveBeenCalledWith(null, {
      projectId: null,
    });
  });

  it('кредит по-прежнему обходит суточный потолок', async () => {
    // Так было всегда: `if (!usedCredit) assertCanSpendUser(...)`.
    // Менять это ради программы нельзя — изменится смысл уже проданных
    // кредитов.
    const { svc, plans } = build({ credit: true });
    await expect(svc.assertCanRender('u1', 'v1')).resolves.toEqual({
      usedCredit: true,
    });
    expect(plans.assertCanSpendUser).not.toHaveBeenCalled();
  });
});

describe('RenderAccessService — стена включена', () => {
  it('без права и без кредитов — стена, а не суточный лимит', async () => {
    const { svc, plans } = build({ wall: true, user: { subscription: null } });
    await expect(svc.assertCanRender('u1', 'v1')).rejects.toBeInstanceOf(
      GenerationLockedException,
    );
    expect(plans.assertCanSpendUser).not.toHaveBeenCalled();
  });

  it('анонимный получает стену, а не «попробуйте завтра»', async () => {
    // «Попробуйте завтра» там, где нужно «войдите», — худший из
    // возможных ответов: человек ждёт сутки и возвращается к тому же.
    const { svc, credits } = build({ wall: true });
    await expect(svc.assertCanRender(null, 'v1')).rejects.toBeInstanceOf(
      GenerationLockedException,
    );
    expect(credits.reserveForGeneration).not.toHaveBeenCalled();
  });

  it('снятая стена пускает — и суточный потолок остаётся на месте', async () => {
    const { svc, plans } = build({
      wall: true,
      user: { ...unlocked, subscription: null },
    });
    await expect(svc.assertCanRender('u1', 'v1')).resolves.toEqual({
      usedCredit: false,
    });
    expect(plans.assertCanSpendUser).toHaveBeenCalled();
  });

  it('отозванная позже разблокировка не пускает', async () => {
    const { svc } = build({
      wall: true,
      user: {
        liteUnlockedAt: new Date('2026-09-01'),
        liteRevokedAt: new Date('2026-09-10'),
        subscription: null,
      },
    });
    await expect(svc.assertCanRender('u1', 'v1')).rejects.toBeInstanceOf(
      GenerationLockedException,
    );
  });

  it('повторная разблокировка после отзыва работает сама собой', async () => {
    const { svc } = build({
      wall: true,
      user: {
        liteUnlockedAt: new Date('2026-09-20'),
        liteRevokedAt: new Date('2026-09-10'),
        subscription: null,
      },
    });
    await expect(svc.assertCanRender('u1', 'v1')).resolves.toEqual({
      usedCredit: false,
    });
  });

  it('действующая подписка пускает', async () => {
    const { svc } = build({
      wall: true,
      user: {
        liteUnlockedAt: null,
        liteRevokedAt: null,
        subscription: {
          status: 'ACTIVE',
          currentPeriodEnd: new Date(Date.now() + 86_400_000),
        },
      },
    });
    await expect(svc.assertCanRender('u1', 'v1')).resolves.toEqual({
      usedCredit: false,
    });
  });

  it('истёкшая подписка не пускает', async () => {
    const { svc } = build({
      wall: true,
      user: {
        liteUnlockedAt: null,
        liteRevokedAt: null,
        subscription: {
          status: 'ACTIVE',
          currentPeriodEnd: new Date(Date.now() - 1000),
        },
      },
    });
    await expect(svc.assertCanRender('u1', 'v1')).rejects.toBeInstanceOf(
      GenerationLockedException,
    );
  });

  it('право читается подпиской, а НЕ users.plan', async () => {
    // Пока `PLANS_BILLING_ENABLED !== 'true'`, режим пользователь ставит
    // себе сам (`planSelfService`). Стена, глядящая на режим, снималась
    // бы одной кнопкой в интерфейсе — поэтому в выборке полей режима
    // нет вовсе, и этот тест сторожит именно выборку.
    const { svc, prisma } = build({ wall: true, user: { subscription: null } });
    await expect(svc.assertCanRender('u1', 'v1')).rejects.toThrow();
    const select = prisma.user.findUnique.mock.calls[0][0].select;
    expect(select.plan).toBeUndefined();
    expect(select.subscription).toBeDefined();
  });

  it('приветственная генерация выдаётся на первом же старте и тут же тратится', async () => {
    const { svc, credits } = build({
      wall: true,
      user: { subscription: null },
      credit: true,
    });
    await expect(svc.assertCanRender('u1', 'v1')).resolves.toEqual({
      usedCredit: true,
    });
    expect(credits.grantWelcomeIfFirst).toHaveBeenCalledWith('u1');
  });
});

describe('RenderAccessService — партия по каталогу', () => {
  it('кредитами не оплачивается', async () => {
    // Двенадцать бесплатных генераций одним кликом опустошили бы
    // лестницу, которую человек собирал неделю.
    const { svc, credits } = build({
      wall: true,
      user: { subscription: null },
      credit: true,
    });
    await expect(
      svc.assertCanRender('u1', 'run1', { mode: 'batch' }),
    ).rejects.toBeInstanceOf(GenerationLockedException);
    expect(credits.reserveForGeneration).not.toHaveBeenCalled();
    expect(credits.grantWelcomeIfFirst).not.toHaveBeenCalled();
  });

  it('суточный потолок не спрашивает — его спрашивает сам воркер, целой пачкой', async () => {
    const { svc, plans } = build({
      wall: true,
      user: { ...unlocked, subscription: null },
    });
    await expect(
      svc.assertCanRender('u1', 'run1', { mode: 'batch' }),
    ).resolves.toEqual({ usedCredit: false });
    expect(plans.assertCanSpendUser).not.toHaveBeenCalled();
  });
});
