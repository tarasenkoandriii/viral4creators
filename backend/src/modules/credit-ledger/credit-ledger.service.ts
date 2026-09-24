/**
 * CreditLedgerService — леджер купленных/потраченных кредитов на
 * генерацию ролика (ТЗ §41.1, этап 62).
 *
 * Add-only: баланс = SUM(delta) по всем строкам пользователя, никогда не
 * кэшируется отдельным столбцом — тот же дух, что `AiUsage` (этап 31):
 * сумма по строкам не дрейфует, кэш дрейфует.
 *
 * Кредит — это оплаченный РОЛИК, а не любой платный вызов сервиса.
 * `assertCanSpendUser`/`checkBudget` (девять платных мест — разбор,
 * релевантность, промпт, постобработка, поиск, озвучка, распознавание
 * фото, аудит, генерация) не тронуты этим модулем вообще: кредитный
 * баланс проверяется ТОЛЬКО здесь, а вызывается — только из
 * `GenerationService.generateVideo()`/`markFailed()` (§41.1). Смешивать
 * решение «что такое один кредит» c общим суточным лимитом означало бы
 * молча решить за владельца продукта, что кредит покрывает любой вызов
 * ИИ, а не ролик.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TelegramNotifyService } from '../notify/telegram-notify.service';
import { isUniqueConstraintViolation } from '../../common/prisma-errors';
import {
  FREE_GRANT_REASONS,
  freeGrantDailyCap,
  type FreeGrantReason,
} from '../../common/free-tier';

/** Начало суток UTC — та же граница, по которой считается суточный
 * расход (`AiUsageService.spentToday`): два разных «сегодня» в одном
 * продукте — источник вопросов, на которые никто не может ответить. */
function startOfTodayUtc(now: Date = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

@Injectable()
export class CreditLedgerService {
  private readonly logger = new Logger(CreditLedgerService.name);

  constructor(
    private readonly prisma: PrismaService,
    /**
     * Тревога о суточном предохранителе (§12.3 ТЗ «Условно бесплатный
     * Lite»). Найдено аудитом этапа 134: ТЗ обещало «в служебный канал
     * уходит тревога», а уходила одна строка в лог — в бессерверном
     * деплое её не увидит никто, и программа могла бы простоять
     * выключенной сутки. `NotifyModule` глобальный, дедупликация по
     * отпечатку встроена: упёршийся потолок не зальёт канал.
     */
    private readonly notify: TelegramNotifyService,
  ) {}

  /** Текущий баланс. Анонимным (userId=null) кредиты не начисляют —
   * покупка требует identity (§41.2, checkout всегда идентифицирован). */
  async balanceOf(userId: string | null | undefined): Promise<number> {
    if (!userId) return 0;
    const r = (await this.prisma.creditLedger.aggregate({
      where: { userId },
      _sum: { delta: true },
    })) as { _sum: { delta: number | null } };
    return r._sum.delta ?? 0;
  }

  /**
   * Балансы сразу для нескольких пользователей — одним `groupBy`, а не
   * N отдельными `balanceOf` (тот же приём, что
   * `AiUsageService.forUsers` — список админки на N строк не должен
   * делать N запросов ради одной колонки). Отсутствующие в результате
   * id — баланс 0 (кредитов не было вовсе, groupBy их не вернёт).
   */
  async balancesFor(userIds: string[]): Promise<Record<string, number>> {
    if (userIds.length === 0) return {};
    // Незакрытый баг типов Prisma `groupBy` (prisma/prisma#17297, #6494):
    // `by` вместе с `where` не резолвится компилятором даже с `as const`
    // — сложный внутренний тип части перегрузок требует, чтобы объект
    // аргумента ОДНОВРЕМЕННО был массивом (отсюда "missing length, pop,
    // push..." в реальной ошибке tsc на Vercel). `as any` на аргументе —
    // задокументированный обходной путь; форма РЕЗУЛЬТАТА по-прежнему
    // проверяется явным касом ниже.
    const rows = (await this.prisma.creditLedger.groupBy({
      by: ['userId'] as const,
      where: { userId: { in: userIds } },
      _sum: { delta: true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)) as Array<{ userId: string; _sum: { delta: number | null } }>;
    const result: Record<string, number> = {};
    for (const row of rows) result[row.userId] = row._sum.delta ?? 0;
    return result;
  }

  /**
   * Пытается списать один кредит на старт рендера. `true` — кредит
   * списан, вызывающий пропускает суточный лимит для ЭТОЙ ОДНОЙ попытки;
   * `false` — баланса нет, вызывающий идёт по старому пути
   * (`assertCanSpendUser`).
   *
   * Списывается СРАЗУ, а не по завершении: иначе две параллельные
   * генерации одного пользователя обе видят «баланс > 0» до того, как
   * баланс уменьшится, и обе стартуют бесплатно. `pg_advisory_xact_lock`
   * по userId — тот же приём, что `PublicationService.create()`
   * (`publication.service.ts`), сериализует конкурентные резервы одного
   * пользователя; уникальный индекс `(generatedVideoId, reason)` —
   * второй защитный слой на случай повторного вызова с тем же
   * `generatedVideoId` (например, ретрай клиента): вторая попытка ловит
   * P2002 и трактуется как «уже списано», а не как ошибка.
   */
  async reserveForGeneration(
    userId: string | null | undefined,
    generatedVideoId: string,
  ): Promise<boolean> {
    if (!userId) return false;
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`credit:${userId}`}))`;

      const r = (await tx.creditLedger.aggregate({
        where: { userId },
        _sum: { delta: true },
      })) as { _sum: { delta: number | null } };
      const balance = r._sum.delta ?? 0;
      if (balance <= 0) return false;

      try {
        await tx.creditLedger.create({
          data: { userId, delta: -1, reason: 'CONSUME', generatedVideoId },
        });
        return true;
      } catch (error) {
        if (isUniqueConstraintViolation(error)) return true;
        throw error;
      }
    });
  }

  /**
   * Приветственная генерация — одна на пользователя, навсегда
   * («Условно бесплатный Lite» §4.1, этап 132).
   *
   * Идемпотентность держится НЕ на том, что вызов один: этот метод
   * зовётся из `RenderAccessService` на каждом старте рендера у
   * человека без права. Держится она на частичном уникальном индексе
   * `(userId, reason) WHERE reason = 'WELCOME'` — P2002 здесь означает
   * «уже выдавали», а не ошибку. Тот же приём, что защищает начисление
   * за оплату от повторного вебхука.
   *
   * Предохранитель (`FREE_GRANT_DAILY_CAP`) считает бесплатные
   * начисления ВСЕЙ программы за сутки. Упёрлись — не начисляем и
   * говорим об этом в лог: это защита от нашей же ошибки в условии
   * засчёта, а не от пользователя, и человек, пришедший в неудачный
   * день, получит своё начисление позже, когда потолок отпустит.
   */
  async grantWelcomeIfFirst(userId: string): Promise<boolean> {
    return this.grantFree(userId, 'WELCOME');
  }

  /**
   * Бесплатное начисление любой причины (§4.1). `WELCOME` — этап 132,
   * остальные приезжают этапами 133–134 и пользуются тем же путём:
   * одно место, где считается предохранитель, и одно, где пишется
   * строка журнала.
   */
  async grantFree(
    userId: string,
    reason: FreeGrantReason,
    /** Ключ идемпотентности для причин, которых бывает больше одной
     * на человека (`REFERRAL`/`REFERRAL_INVITEE` — по одной на
     * приглашение). `WELCOME`/`SUBSCRIPTION` обходятся без него:
     * там ключ — сам пользователь. */
    referralId?: string | null,
  ): Promise<boolean> {
    const cap = freeGrantDailyCap();
    if (cap === 0) return false;
    const granted = await this.prisma.creditLedger.count({
      where: {
        reason: { in: FREE_GRANT_REASONS as string[] },
        createdAt: { gte: startOfTodayUtc() },
      },
    });
    if (granted >= cap) {
      this.logger.warn(
        `суточный потолок бесплатных начислений исчерпан (${granted}/${cap}) — ` +
          `${reason} для ${userId} не начислен, попробуем завтра`,
      );
      // Отпечаток без переменной части — иначе дедупликация не
      // сработает никогда, и канал зальёт одной и той же тревогой.
      // Начисление при этом не теряется: догоняющий проход
      // (`ReferralService.settlePending`, `InviteService.stateOf`)
      // вернётся к нему, когда потолок отпустит.
      await this.notify
        .alert(
          'free-grant-daily-cap',
          `Суточный потолок бесплатных начислений исчерпан (${granted}/${cap}). ` +
            `Начисления отложены до следующих суток; уже выданное не тронуто.`,
        )
        .catch(() => false);
      return false;
    }
    try {
      await this.prisma.creditLedger.create({
        data: { userId, delta: 1, reason, referralId: referralId ?? null },
      });
      return true;
    } catch (error) {
      // Уже начисляли — это нормальный ход событий, а не сбой.
      if (isUniqueConstraintViolation(error)) return false;
      throw error;
    }
  }

  /**
   * Возврат кредита при неудаче рендера — вызывается из
   * `GenerationService.markFailed()`, best-effort (никогда не бросает,
   * как и остальной best-effort код рядом с ним — алерты, уборка). No-op,
   * если списания не было (обычный дневной лимит, не кредит) или возврат
   * уже сделан (уникальный индекс не даст вставить вторую пару
   * CONSUME/REFUND для одного `generatedVideoId`).
   */
  async refundIfReserved(
    generatedVideoId: string | null | undefined,
  ): Promise<void> {
    if (!generatedVideoId) return;
    try {
      const consumed = await this.prisma.creditLedger.findFirst({
        where: { generatedVideoId, reason: 'CONSUME' },
        select: { userId: true },
      });
      if (!consumed) return;

      await this.prisma.creditLedger.create({
        data: {
          userId: consumed.userId,
          delta: 1,
          reason: 'REFUND',
          generatedVideoId,
        },
      });
    } catch (error) {
      if (isUniqueConstraintViolation(error)) return; // уже возвращён
      this.logger.warn(
        `не удалось вернуть кредит за ${generatedVideoId}: ${String(error)}`,
      );
    }
  }

  /**
   * Начисление за успешную оплату пакета — вызывается из
   * `BillingService` после подтверждённого платежа.
   *
   * `tx` (аудит round4, Г-2.5) — опциональный клиент активной
   * `$transaction`: `BillingService.applySuccessfulPayment` фиксирует
   * статус `Payment` и начисление кредитов ОДНОЙ транзакцией, чтобы сбой
   * между ними не оставлял «деньги получены, кредиты не начислены»
   * навсегда. `@@unique([paymentId, reason])` на `credit_ledger` вторым
   * слоем защищает от двойного начисления по одному и тому же платежу —
   * P2002 здесь означает «уже начислено», не ошибку.
   */
  async grant(
    userId: string,
    delta: number,
    paymentId: string | null,
    // `Prisma.TransactionClient`, не `typeof this.prisma` (=`PrismaService`)
    // — тот же корневой баг, что и «Внеплановый фикс №1» (39 ошибок), но
    // здесь не в самом колбэке `$transaction`, а в СИГНАТУРЕ обычного
    // метода, куда вызывающий (`billing.service.ts`'s
    // `applySuccessfulPayment`, уже типизированный правильно) передаёт
    // реальный `tx`. `typeof this.prisma` в этом файле — тип
    // `PrismaService`, а не транзакционного клиента; их несовместимость
    // была невидна в песочнице (нестабный клиент), но не в реальной
    // сборке (см. doc/PRODUCT-PROJECT-IMPLEMENTATION-PLAN.md).
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = tx ?? this.prisma;
    try {
      await client.creditLedger.create({
        data: { userId, delta, reason: 'PURCHASE', paymentId },
      });
    } catch (error) {
      if (isUniqueConstraintViolation(error)) return; // уже начислено
      throw error;
    }
  }

  /** Ручная правка оператором (админка «Оплата») — компенсация или
   * исправление ошибки, без привязки к платежу. */
  async adminAdjust(userId: string, delta: number): Promise<void> {
    await this.prisma.creditLedger.create({
      data: { userId, delta, reason: 'ADMIN_ADJUST' },
    });
  }
}
