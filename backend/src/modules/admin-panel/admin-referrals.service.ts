/**
 * Вкладка «Приглашения» в админке — «Условно бесплатный Lite» §11,
 * этап 135.
 *
 * Отвечает на один вопрос владельца: работает канал или нет и во что он
 * обходится. Отсюда и набор чисел — §11 называет их поимённо, и ни
 * одного сверх этого списка здесь нет.
 *
 * ## Две честности, которые пришлось соблюсти
 *
 * 1. **Переходы не имеют даты.** Это не упущение, а решение §5.2:
 *    переход — счётчик `ReferralCode.visitCount`, а не строка, потому
 *    что у клика нет ключа и персональных полей быть не может. Значит
 *    «доля дошедших до ролика от перешедших» считается ЗА ВСЁ ВРЕМЯ, и
 *    экран так её и подписывает. Приделать сюда период значило бы
 *    придумать число, которого в базе нет.
 * 2. **«Потрачено» — это оценка сверху, и она названа оценкой.**
 *    Списание (`CONSUME`) не помнит, какой именно кредит потратили:
 *    бесплатный или купленный. Поэтому по каждому человеку берётся
 *    `min(начислено бесплатных, списано всего)` — больше бесплатных, чем
 *    ему выдали, он потратить не мог. Пока оплата кредитов выключена
 *    (`PLANS_BILLING_ENABLED`), оценка совпадает с точным числом.
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { FREE_GRANT_REASONS } from '../../common/free-tier';
import { estimateCost } from '../../common/ai-pricing';
import { VIDEO_DURATION_SECONDS } from '../../common/veo-duration';
import { referralUnlockTarget } from '../../common/referral';

export type ReferralsWindow = 'day' | 'week' | 'month';

const WINDOW_MS: Record<ReferralsWindow, number> = {
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
};

/**
 * Модель и разрешение умолчания продукта (§2.1): провайдер приходит
 * настройкой оператора с фолбэком `grok`, разрешение мастера — 480p.
 * Цена берётся из общего прайса, а не вписывается числом: сменится
 * ставка или переопределит её переменная окружения — экран сойдётся
 * сам, а зашитые «$0.64» молча разъехались бы с реальностью.
 */
export const FREE_GENERATION_MODEL = 'grok-imagine-video-1.5:480p';

/**
 * `null` — ставки для модели умолчания в прайсе нет.
 *
 * Аудит этапа 135: `estimateCost` отвечает на неизвестную модель нулём
 * и флагом `unpriced`, и первая редакция флаг не смотрела — переименуй
 * кто-нибудь ключ модели, и экран показал бы «начислено 40 генераций,
 * $0.00» как правду. Ноль в графе денег — самое опасное из молчаливых
 * значений: по нему принимают решение продолжать.
 */
export function freeGenerationCostMicroUsd(
  env: NodeJS.ProcessEnv = process.env,
  /** Параметром — чтобы ветку «ставки нет» можно было проверить. */
  model: string = FREE_GENERATION_MODEL,
): number | null {
  const estimate = estimateCost(
    model,
    { seconds: VIDEO_DURATION_SECONDS },
    env,
  );
  return estimate.unpriced ? null : estimate.costMicroUsd;
}

/** Пачка засчётов в один час — повод посмотреть глазами, а не приговор. */
export interface SuspiciousInviter {
  inviterId: string;
  telegramId: string | null;
  /** Сколько засчитано всего (не снятых). */
  counted: number;
  /** Самая плотная пачка: сколько засчитано в пределах одного часа. */
  burst: number;
  burstStartedAt: string;
  /**
   * Приглашения ИЗ ЭТОЙ пачки — то, что оператор и снимает.
   *
   * Найдено аудитом этапа 135: первая редакция отдавала только числа, и
   * снять приглашение можно было, лишь введя его id руками, — а взять
   * этот id было НЕГДЕ, он нигде не показывался. Кнопка, для которой
   * нет данных, хуже отсутствующей.
   */
  burstReferralIds: string[];
  liteUnlocked: boolean;
}

export interface AdminReferralsOverview {
  window: ReferralsWindow;
  from: string;
  to: string;
  /** Состояния приглашений за период — по дате, когда состояние наступило. */
  period: {
    identified: number;
    generated: number;
    revoked: number;
  };
  /** За всё время: у переходов нет даты (см. шапку файла). */
  allTime: {
    visits: number;
    identified: number;
    generated: number;
    /** Доля перешедших, дошедших до ролика. `null` — переходов ещё нет. */
    visitToGenerated: number | null;
  };
  unlock: {
    target: number;
    /** Действующая разблокировка (отзыв не позже её). */
    active: number;
    earned: number;
    grandfathered: number;
    byOperator: number;
    revoked: number;
  };
  credits: {
    granted: number;
    /** Оценка сверху, см. шапку файла. */
    spentEstimate: number;
    /** `null` — ставки в прайсе нет, и денег на экране не будет. */
    unitCostMicroUsd: number | null;
    grantedMicroUsd: number | null;
    spentEstimateMicroUsd: number | null;
  };
  suspicious: SuspiciousInviter[];
}

/** Окно, в котором пачка засчётов считается пачкой (§11). */
const BURST_WINDOW_MS = 60 * 60 * 1000;
/** С какого размера пачка попадает в список. */
const BURST_MIN = 3;

@Injectable()
export class AdminReferralsService {
  constructor(private readonly prisma: PrismaService) {}

  async overview(window: ReferralsWindow): Promise<AdminReferralsOverview> {
    const to = new Date();
    const from = new Date(to.getTime() - WINDOW_MS[window]);

    const [
      identifiedPeriod,
      generatedPeriod,
      revokedPeriod,
      identifiedAll,
      generatedAll,
      visitsAgg,
      unlockRows,
      granted,
      suspicious,
    ] = await Promise.all([
      this.prisma.referral.count({ where: { identifiedAt: { gte: from } } }),
      this.prisma.referral.count({
        where: { generatedAt: { gte: from }, revokedAt: null },
      }),
      this.prisma.referral.count({ where: { revokedAt: { gte: from } } }),
      this.prisma.referral.count(),
      this.prisma.referral.count({
        where: { status: 'GENERATED', revokedAt: null },
      }),
      this.prisma.referralCode.aggregate({ _sum: { visitCount: true } }),
      this.unlockCounts(),
      this.prisma.creditLedger.count({
        where: { reason: { in: [...FREE_GRANT_REASONS] } },
      }),
      this.suspicious(),
    ]);

    const visits: number =
      (visitsAgg as { _sum: { visitCount: number | null } })._sum.visitCount ??
      0;
    const spentEstimate = await this.spentFreeCredits();
    const unitCostMicroUsd = freeGenerationCostMicroUsd();

    return {
      window,
      from: from.toISOString(),
      to: to.toISOString(),
      period: {
        identified: identifiedPeriod,
        generated: generatedPeriod,
        revoked: revokedPeriod,
      },
      allTime: {
        visits,
        identified: identifiedAll,
        generated: generatedAll,
        // Делить на ноль нечем и незачем: «нет данных» честнее нуля,
        // который читается как «канал не работает».
        visitToGenerated: visits > 0 ? generatedAll / visits : null,
      },
      unlock: { target: referralUnlockTarget(), ...unlockRows },
      credits: {
        granted,
        spentEstimate,
        unitCostMicroUsd,
        grantedMicroUsd:
          unitCostMicroUsd === null ? null : granted * unitCostMicroUsd,
        spentEstimateMicroUsd:
          unitCostMicroUsd === null ? null : spentEstimate * unitCostMicroUsd,
      },
      suspicious,
    };
  }

  /**
   * Сколько людей с разблокировкой и откуда она у них.
   *
   * «Действующая» считается тем же правилом, что и право на рендер:
   * отзыв сильнее разблокировки, только если он позже неё (§9). В SQL
   * это сравнение двух колонок, поэтому здесь два счётчика и вычитание,
   * а не один `where`: Prisma не умеет сравнивать колонку с колонкой без
   * сырого запроса, а сырой запрос ради одного числа на служебном экране
   * — плохой размен.
   */
  private async unlockCounts(): Promise<{
    active: number;
    earned: number;
    grandfathered: number;
    byOperator: number;
    revoked: number;
  }> {
    // Найдено аудитом этапа 135: первая редакция тянула сюда ВСЕХ, у
    // кого стоит `liteUnlockedAt`, — а его ставит ещё и миграция
    // «сохранённого доступа» (§4.4), то есть это вся база
    // зарегистрированных до 24 сентября. Служебный экран не должен
    // материализовать таблицу пользователей ради пяти чисел.
    //
    // Поэтому четыре `count` и ОДНА маленькая выборка: строки с отзывом
    // — это ручные действия оператора, их считанные единицы, и только у
    // них нужно сравнить две даты между собой (такого `where` Prisma без
    // сырого запроса не умеет).
    const [total, earned, grandfathered, byOperator, revokedRows] =
      await Promise.all([
        this.prisma.user.count({ where: { liteUnlockedAt: { not: null } } }),
        this.prisma.user.count({ where: { liteUnlockSource: 'EARNED' } }),
        this.prisma.user.count({
          where: { liteUnlockSource: 'GRANDFATHERED' },
        }),
        this.prisma.user.count({ where: { liteUnlockSource: 'OPERATOR' } }),
        this.prisma.user.findMany({
          where: { liteRevokedAt: { not: null } },
          select: { liteUnlockedAt: true, liteRevokedAt: true },
        }) as Promise<
          { liteUnlockedAt: Date | null; liteRevokedAt: Date | null }[]
        >,
      ]);

    // Отзыв сильнее разблокировки, только если он ПОЗЖЕ неё (§9): после
    // возврата доступа оператором дата разблокировки новее, и строка
    // снова считается действующей.
    const revoked = revokedRows.filter(
      (r) =>
        r.liteUnlockedAt !== null &&
        r.liteRevokedAt !== null &&
        r.liteRevokedAt.getTime() >= r.liteUnlockedAt.getTime(),
    ).length;

    return {
      active: total - revoked,
      earned,
      grandfathered,
      byOperator,
      revoked,
    };
  }

  /**
   * Сколько бесплатных генераций уже потрачено — оценка сверху.
   *
   * По каждому получателю бесплатных начислений: `min(начислено,
   * списано)`. Списание не помнит, чей кредит тратит, но потратить
   * бесплатных БОЛЬШЕ, чем выдали, человек не мог — значит это верхняя
   * граница, и она честная.
   */
  private async spentFreeCredits(): Promise<number> {
    const grantedBy: { userId: string; _count: { _all: number } }[] =
      await this.prisma.creditLedger.groupBy({
        by: ['userId'],
        where: { reason: { in: [...FREE_GRANT_REASONS] } },
        _count: { _all: true },
      });
    if (grantedBy.length === 0) return 0;

    const userIds = grantedBy.map((g) => g.userId);
    const consumedBy: { userId: string; _count: { _all: number } }[] =
      await this.prisma.creditLedger.groupBy({
        by: ['userId'],
        where: { reason: 'CONSUME', userId: { in: userIds } },
        _count: { _all: true },
      });
    const consumed = new Map(
      consumedBy.map((c) => [c.userId, c._count._all] as const),
    );
    let total = 0;
    for (const g of grantedBy) {
      total += Math.min(g._count._all, consumed.get(g.userId) ?? 0);
    }
    return total;
  }

  /**
   * Кто засчитал приглашения пачкой (§11).
   *
   * Считается в памяти, а не в SQL, и это осознанно: скользящее окно по
   * времени на группу — запрос, который потом никто не прочитает, а
   * засчитанных приглашений у программы с потолком в полсотни начислений
   * в сутки заведомо немного. Берём последний месяц и не больше тысячи
   * строк: список подозрительных — повод посмотреть глазами, а не отчёт.
   */
  private async suspicious(): Promise<SuspiciousInviter[]> {
    const since = new Date(Date.now() - WINDOW_MS.month);
    const rows: { id: string; inviterId: string; generatedAt: Date | null }[] =
      await this.prisma.referral.findMany({
        where: {
          status: 'GENERATED',
          revokedAt: null,
          generatedAt: { gte: since },
        },
        select: { id: true, inviterId: true, generatedAt: true },
        // `desc`, а не `asc`: при упоре в потолок выборки нужны СВЕЖИЕ
        // засчёты, а не самые старые за месяц (аудит этапа 135 — первая
        // редакция показала бы позапрошлую пачку и не заметила
        // сегодняшнюю). Внутри пригласившего даты сортируются по
        // возрастанию уже в памяти: скользящее окно требует порядка.
        orderBy: { generatedAt: 'desc' },
        take: 1000,
      });

    const byInviter = new Map<string, { id: string; at: Date }[]>();
    for (const r of rows) {
      if (!r.generatedAt) continue;
      const list = byInviter.get(r.inviterId) ?? [];
      list.push({ id: r.id, at: r.generatedAt });
      byInviter.set(r.inviterId, list);
    }

    const found: Omit<SuspiciousInviter, 'telegramId' | 'liteUnlocked'>[] = [];
    for (const [inviterId, all] of byInviter) {
      all.sort((a, b) => a.at.getTime() - b.at.getTime());
      let best = 0;
      let bestLeft = 0;
      let bestRight = -1;
      let left = 0;
      for (let right = 0; right < all.length; right++) {
        while (
          all[right].at.getTime() - all[left].at.getTime() >
          BURST_WINDOW_MS
        ) {
          left++;
        }
        const size = right - left + 1;
        if (size > best) {
          best = size;
          bestLeft = left;
          bestRight = right;
        }
      }
      if (best >= BURST_MIN) {
        const burstRows = all.slice(bestLeft, bestRight + 1);
        found.push({
          inviterId,
          counted: all.length,
          burst: best,
          burstStartedAt: burstRows[0].at.toISOString(),
          burstReferralIds: burstRows.map((r) => r.id),
        });
      }
    }
    found.sort((a, b) => b.burst - a.burst);
    const top = found.slice(0, 50);
    if (top.length === 0) return [];

    const users: {
      id: string;
      telegramId: string;
      liteUnlockedAt: Date | null;
      liteRevokedAt: Date | null;
    }[] = await this.prisma.user.findMany({
      where: { id: { in: top.map((f) => f.inviterId) } },
      select: {
        id: true,
        telegramId: true,
        liteUnlockedAt: true,
        liteRevokedAt: true,
      },
    });
    const byId = new Map(users.map((u) => [u.id, u] as const));
    return top.map((f) => {
      const u = byId.get(f.inviterId);
      return {
        ...f,
        telegramId: u?.telegramId ?? null,
        liteUnlocked: !!(
          u?.liteUnlockedAt &&
          (!u.liteRevokedAt ||
            u.liteRevokedAt.getTime() < u.liteUnlockedAt.getTime())
        ),
      };
    });
  }

  /**
   * Снять засчитанное приглашение (§5.4).
   *
   * Строка НЕ удаляется и из списков не исчезает: разбор накрутки не на
   * чем вести, если следы стирать. Уже начисленный кредит не
   * отбирается — отнятое обиднее невыданного, — но дальнейшие начисления
   * по этому приглашению прекращаются: `settlePending` берёт только
   * `revokedAt: null`.
   *
   * Разблокировку это тоже НЕ отнимает, даже если засчитанных стало
   * меньше семи. Отнять её — отдельное действие оператора, с
   * собственной причиной.
   */
  async revokeReferral(
    id: string,
    reason: string,
  ): Promise<{ revoked: boolean }> {
    const updated = await this.prisma.referral.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return { revoked: updated.count > 0 };
  }
}
