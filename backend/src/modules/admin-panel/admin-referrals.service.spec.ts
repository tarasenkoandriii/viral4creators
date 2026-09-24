/**
 * Вкладка «Приглашения» — «Условно бесплатный Lite» §11, этап 135.
 *
 * Проверки не про «метод отвечает», а про числа: по ним владелец решает,
 * держать программу или выключать (§12.4). Соврать они могут тихо.
 */

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import {
  AdminReferralsService,
  FREE_GENERATION_MODEL,
  freeGenerationCostMicroUsd,
} from './admin-referrals.service';
import { priceEnvKey } from '../../common/ai-pricing';

type Ref = {
  id: string;
  inviterId: string;
  status: string;
  revokedAt: Date | null;
  generatedAt: Date | null;
  identifiedAt: Date;
};

type Ledger = { userId: string; reason: string };

function build(
  over: {
    referrals?: Ref[];
    visits?: number;
    users?: {
      id: string;
      telegramId: string;
      liteUnlockedAt: Date | null;
      liteRevokedAt: Date | null;
      liteUnlockSource: string | null;
    }[];
    ledger?: Ledger[];
  } = {},
) {
  const refs = over.referrals ?? [];
  const users = over.users ?? [];
  const ledger = over.ledger ?? [];
  const FREE = ['WELCOME', 'SUBSCRIPTION', 'REFERRAL', 'REFERRAL_INVITEE'];

  const matches = (r: Ref, where: Record<string, unknown>) => {
    const gte = (v: Date | null, w: unknown) =>
      w === undefined ||
      (v !== null && v.getTime() >= (w as { gte: Date }).gte.getTime());
    if (where.status !== undefined && r.status !== where.status) return false;
    if (where.revokedAt === null && r.revokedAt) return false;
    if (
      where.identifiedAt !== undefined &&
      !gte(r.identifiedAt, where.identifiedAt)
    )
      return false;
    if (
      where.generatedAt !== undefined &&
      !gte(r.generatedAt, where.generatedAt)
    )
      return false;
    if (
      where.revokedAt !== undefined &&
      where.revokedAt !== null &&
      !gte(r.revokedAt, where.revokedAt)
    )
      return false;
    return true;
  };

  const prisma = {
    referral: {
      count: jest.fn(
        async (args?: { where?: Record<string, unknown> }) =>
          refs.filter((r) => matches(r, args?.where ?? {})).length,
      ),
      findMany: jest.fn(async (args: { where: Record<string, unknown> }) =>
        refs
          .filter((r) => matches(r, args.where))
          .sort(
            (a, b) =>
              (a.generatedAt?.getTime() ?? 0) - (b.generatedAt?.getTime() ?? 0),
          )
          .map((r) => ({
            id: r.id,
            inviterId: r.inviterId,
            generatedAt: r.generatedAt,
          })),
      ),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    referralCode: {
      aggregate: jest
        .fn()
        .mockResolvedValue({ _sum: { visitCount: over.visits ?? 0 } }),
    },
    user: {
      // Двойник обязан СЛУШАТЬСЯ `where`: экран теперь считает
      // разблокировки четырьмя `count`-ами и одной маленькой выборкой
      // отозванных, а не тянет всю таблицу (аудит этапа 135).
      count: jest.fn(async (args: { where: Record<string, unknown> }) => {
        const w = args.where;
        return users.filter((u) => {
          if (w.liteUnlockedAt !== undefined && u.liteUnlockedAt === null) {
            return false;
          }
          if (
            w.liteUnlockSource !== undefined &&
            u.liteUnlockSource !== w.liteUnlockSource
          ) {
            return false;
          }
          return true;
        }).length;
      }),
      findMany: jest.fn(async (args: { where: Record<string, unknown> }) => {
        const w = args.where;
        const ids = (w.id as { in?: string[] })?.in;
        if (ids) return users.filter((u) => ids.includes(u.id));
        if (w.liteRevokedAt !== undefined) {
          return users.filter((u) => u.liteRevokedAt !== null);
        }
        return users.filter((u) => u.liteUnlockedAt !== null);
      }),
    },
    creditLedger: {
      count: jest.fn(
        async () => ledger.filter((l) => FREE.includes(l.reason)).length,
      ),
      groupBy: jest.fn(
        async (args: {
          where: { reason: unknown; userId?: { in: string[] } };
        }) => {
          const reason = args.where.reason as
            | string
            | { in: string[] }
            | undefined;
          const wanted =
            typeof reason === 'string' ? [reason] : (reason?.in ?? []);
          const only = args.where.userId?.in;
          const byUser = new Map<string, number>();
          for (const l of ledger) {
            if (!wanted.includes(l.reason)) continue;
            if (only && !only.includes(l.userId)) continue;
            byUser.set(l.userId, (byUser.get(l.userId) ?? 0) + 1);
          }
          return [...byUser].map(([userId, n]) => ({
            userId,
            _count: { _all: n },
          }));
        },
      ),
    },
  };
  return { svc: new AdminReferralsService(prisma as never), prisma };
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000);
const minutesAgo = (m: number) => new Date(Date.now() - m * 60 * 1000);

const ref = (over: Partial<Ref>): Ref => ({
  id: 'r',
  inviterId: 'inviter',
  status: 'GENERATED',
  revokedAt: null,
  generatedAt: hoursAgo(1),
  identifiedAt: hoursAgo(2),
  ...over,
});

describe('цена бесплатной генерации', () => {
  it('берётся из прайса, а не вписана числом', () => {
    // §2.1: умолчание продукта — Grok 480p, восемь секунд, $0.64.
    // Считаем из общего прайса, чтобы смена ставки не оставила на
    // экране старое число.
    expect(freeGenerationCostMicroUsd()).toBe(640_000);
  });

  it('переопределение ставки доезжает до экрана', () => {
    // Ключ собираем тем же `priceEnvKey`, что читает прайс: вписанный
    // руками он разъехался бы молча — переменная просто перестала бы
    // действовать, а экран показывал бы старую цену как настоящую.
    expect(
      freeGenerationCostMicroUsd({
        [priceEnvKey(FREE_GENERATION_MODEL, 'second')]: '0.10',
      } as NodeJS.ProcessEnv),
    ).toBe(800_000);
  });
});

describe('AdminReferralsService.overview — числа', () => {
  it('снятые оператором не считаются засчитанными', async () => {
    const { svc } = build({
      referrals: [ref({ id: 'r1' }), ref({ id: 'r2', revokedAt: hoursAgo(1) })],
      visits: 10,
    });
    const o = await svc.overview('week');
    expect(o.allTime.generated).toBe(1);
  });

  it('доля дошедших до ролика считается от переходов за всё время', async () => {
    // У перехода нет даты (§5.2 — это счётчик, а не строка), поэтому
    // период к нему неприменим, и экран так и подписывает число.
    const { svc } = build({ referrals: [ref({ id: 'r1' })], visits: 4 });
    const o = await svc.overview('week');
    expect(o.allTime.visitToGenerated).toBe(0.25);
  });

  it('без переходов доля — «нет данных», а не ноль', async () => {
    // Ноль читается как «канал не работает», хотя на деле ещё никто не
    // переходил.
    const { svc } = build({ visits: 0 });
    const o = await svc.overview('week');
    expect(o.allTime.visitToGenerated).toBeNull();
  });

  it('разблокировки разложены по источнику, отозванные отдельно', async () => {
    const { svc } = build({
      users: [
        {
          id: 'u1',
          telegramId: '1',
          liteUnlockedAt: hoursAgo(50),
          liteRevokedAt: null,
          liteUnlockSource: 'EARNED',
        },
        {
          id: 'u2',
          telegramId: '2',
          liteUnlockedAt: hoursAgo(50),
          liteRevokedAt: hoursAgo(10),
          liteUnlockSource: 'EARNED',
        },
        {
          id: 'u3',
          telegramId: '3',
          liteUnlockedAt: hoursAgo(5),
          liteRevokedAt: hoursAgo(10),
          liteUnlockSource: 'OPERATOR',
        },
        {
          id: 'u4',
          telegramId: '4',
          liteUnlockedAt: hoursAgo(99),
          liteRevokedAt: null,
          liteUnlockSource: 'GRANDFATHERED',
        },
      ],
    });
    const o = await svc.overview('week');
    // u3 отозван РАНЬШЕ, чем разблокирован заново, — значит доступ есть.
    expect(o.unlock).toMatchObject({
      active: 3,
      revoked: 1,
      earned: 2,
      byOperator: 1,
      grandfathered: 1,
    });
  });

  it('потрачено — не больше, чем начислено этому же человеку', async () => {
    // Списание не помнит, чей кредит тратит. Купивший кредиты и
    // потративший десять не должен превращать четыре бесплатных в
    // десять потраченных.
    const { svc } = build({
      ledger: [
        { userId: 'u1', reason: 'WELCOME' },
        { userId: 'u1', reason: 'REFERRAL' },
        ...Array.from({ length: 10 }, () => ({
          userId: 'u1',
          reason: 'CONSUME',
        })),
      ],
    });
    const o = await svc.overview('week');
    expect(o.credits.granted).toBe(2);
    expect(o.credits.spentEstimate).toBe(2);
  });

  it('неистраченные бесплатные в «потрачено» не попадают', async () => {
    const { svc } = build({
      ledger: [
        { userId: 'u1', reason: 'WELCOME' },
        { userId: 'u2', reason: 'WELCOME' },
        { userId: 'u1', reason: 'CONSUME' },
      ],
    });
    const o = await svc.overview('week');
    expect(o.credits.granted).toBe(2);
    expect(o.credits.spentEstimate).toBe(1);
  });

  it('деньги считаются из штук и ставки, а не отдельно', async () => {
    const { svc } = build({
      ledger: [
        { userId: 'u1', reason: 'WELCOME' },
        { userId: 'u1', reason: 'CONSUME' },
      ],
    });
    const o = await svc.overview('week');
    expect(o.credits.grantedMicroUsd).toBe(640_000);
    expect(o.credits.spentEstimateMicroUsd).toBe(640_000);
  });
});

describe('AdminReferralsService — список подозрительных', () => {
  it('три засчёта в один час попадают в список', async () => {
    const { svc } = build({
      referrals: [
        ref({ id: 'r1', generatedAt: minutesAgo(50) }),
        ref({ id: 'r2', generatedAt: minutesAgo(40) }),
        ref({ id: 'r3', generatedAt: minutesAgo(30) }),
      ],
    });
    const o = await svc.overview('week');
    expect(o.suspicious).toHaveLength(1);
    expect(o.suspicious[0]).toMatchObject({ inviterId: 'inviter', burst: 3 });
  });

  it('те же три, растянутые на сутки, — не пачка', async () => {
    const { svc } = build({
      referrals: [
        ref({ id: 'r1', generatedAt: hoursAgo(30) }),
        ref({ id: 'r2', generatedAt: hoursAgo(20) }),
        ref({ id: 'r3', generatedAt: hoursAgo(10) }),
      ],
    });
    const o = await svc.overview('week');
    expect(o.suspicious).toEqual([]);
  });

  it('пачка ищется скользящим окном, а не по первому засчёту', async () => {
    // Первый стоит особняком, а следующие три — вплотную. Наивный счёт
    // «от первого + час» нашёл бы один и успокоился.
    const { svc } = build({
      referrals: [
        ref({ id: 'r0', generatedAt: hoursAgo(20) }),
        ref({ id: 'r1', generatedAt: minutesAgo(50) }),
        ref({ id: 'r2', generatedAt: minutesAgo(45) }),
        ref({ id: 'r3', generatedAt: minutesAgo(40) }),
      ],
    });
    const o = await svc.overview('week');
    expect(o.suspicious[0]).toMatchObject({ burst: 3, counted: 4 });
  });

  it('снятые оператором в пачку не входят', async () => {
    const { svc } = build({
      referrals: [
        ref({ id: 'r1', generatedAt: minutesAgo(50) }),
        ref({ id: 'r2', generatedAt: minutesAgo(45) }),
        ref({
          id: 'r3',
          generatedAt: minutesAgo(40),
          revokedAt: minutesAgo(1),
        }),
      ],
    });
    const o = await svc.overview('week');
    expect(o.suspicious).toEqual([]);
  });
});

describe('находки аудита этапа 135', () => {
  it('в пачке приезжают id — иначе снимать нечем', async () => {
    // Первая редакция отдавала только числа, и снять приглашение можно
    // было, лишь введя id руками, — а взять его было НЕГДЕ.
    const { svc } = build({
      referrals: [
        ref({ id: 'r1', generatedAt: minutesAgo(50) }),
        ref({ id: 'r2', generatedAt: minutesAgo(45) }),
        ref({ id: 'r3', generatedAt: minutesAgo(40) }),
        // Этот вне окна — в пачку попасть не должен.
        ref({ id: 'r4', generatedAt: hoursAgo(20) }),
      ],
    });
    const o = await svc.overview('week');
    expect(o.suspicious[0].burstReferralIds).toEqual(['r1', 'r2', 'r3']);
  });

  it('разблокировки считаются запросами, а не выгрузкой всей базы', async () => {
    // `liteUnlockedAt` стоит и у всех, кому доступ сохранён миграцией
    // (§4.4), то есть у всей базы зарегистрированных до 24 сентября.
    const { svc, prisma } = build({
      users: [
        {
          id: 'u1',
          telegramId: '1',
          liteUnlockedAt: hoursAgo(50),
          liteRevokedAt: null,
          liteUnlockSource: 'GRANDFATHERED',
        },
      ],
    });
    await svc.overview('week');
    // Единственная выборка пользователей в этом блоке — отозванные, и
    // их единицы: это ручные действия оператора.
    const userFindManyCalls = prisma.user.findMany.mock.calls.filter(
      (c: [{ where: Record<string, unknown> }]) =>
        c[0].where.liteRevokedAt !== undefined,
    );
    expect(userFindManyCalls).toHaveLength(1);
    expect(prisma.user.count).toHaveBeenCalled();
  });

  it('модели нет в прайсе — денег на экране нет, а не $0', async () => {
    // Ноль в графе денег — самое опасное из молчаливых значений: по
    // нему принимают решение продолжать программу. `estimateCost`
    // отвечает на неизвестную модель нулём с флагом `unpriced`, и
    // первая редакция флаг не смотрела: переименуй кто-нибудь ключ
    // модели — и экран показал бы «начислено 40 генераций, $0.00».
    expect(
      freeGenerationCostMicroUsd(process.env, 'модель-которой-нет'),
    ).toBeNull();
    // А у настоящей модели цена есть и в деньги переводится.
    expect(freeGenerationCostMicroUsd()).toBe(640_000);
  });
});

describe('AdminReferralsService.revokeReferral', () => {
  it('снимает только не снятое — второй раз причину не переписывает', async () => {
    const { svc, prisma } = build();
    await svc.revokeReferral('r1', 'пачка');
    expect(prisma.referral.updateMany).toHaveBeenCalledWith({
      where: { id: 'r1', revokedAt: null },
      data: { revokedAt: expect.any(Date), revokedReason: 'пачка' },
    });
  });

  it('пользователя не трогает: прогресс падает, доступ остаётся', async () => {
    // Приёмка этапа 135 дословно: «снятое оператором приглашение
    // уменьшает прогресс, но не отнимает уже выданный доступ». Прогресс
    // падает сам собой — засчитанными считаются только не снятые; а вот
    // разблокировку отнимает ТОЛЬКО отдельное действие, и структурно
    // этот метод до пользователя не дотягивается.
    const { svc, prisma } = build();
    await svc.revokeReferral('r1', 'пачка');
    expect(prisma.user).not.toHaveProperty('update');
  });

  it('строку не удаляет — разбор накрутки не на чем вести', async () => {
    const { svc, prisma } = build();
    await svc.revokeReferral('r1', 'пачка');
    expect(prisma.referral).not.toHaveProperty('delete');
  });
});
