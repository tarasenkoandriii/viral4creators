/**
 * Право начать рендер — «Условно бесплатный Lite» §8.1, этап 132.
 *
 * ## Почему это отдельный сервис, а не условие в каждом старте
 *
 * Пользовательских стартов рендера в продукте ТРИ — одиночная генерация
 * товарки, поздравление и партия по каталогу, — и найдены они были не
 * сразу: партия вообще уходит в xAI напрямую, минуя
 * `GenerationService.generateVideo()`, из-за чего проверку бюджета туда
 * когда-то пришлось дописывать отдельно. Копия условия в трёх местах
 * разошлась бы по той же причине, по которой расходятся любые две
 * копии одного правила, — не от невнимательности, а просто со временем.
 *
 * Поэтому правило живёт здесь целиком, а снаружи у него один вход.
 * Что каждый старт действительно его зовёт — сторожит
 * `scripts/check-docs.mjs` (шов «кто зовёт провайдера видео, зовёт и
 * assertCanRender»).
 *
 * ## Порядок проверок — и почему именно такой
 *
 * ```
 * 1. рубильник выключен                     → пропускаем всех, как до этапа 132
 * 2. право (подписка или снятая стена)      → суточный потолок → рендерим
 * 3. иначе: резерв кредита удался           → рендерим БЕЗ проверки потолка
 * 4. иначе                                  → стена (403)
 * ```
 *
 * Кредит обходит суточный потолок, и это не изобретение этого этапа: в
 * `GenerationService` всегда стояло `if (!usedCredit) assertCanSpendUser(...)`
 * — купленный кредит специально не упирается в лимит режима. Бесплатные
 * кредиты наследуют то же поведение; менять его ради программы нельзя,
 * иначе изменится смысл УЖЕ ПРОДАННЫХ кредитов.
 */

import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlanService } from '../plan/plan.service';
import { CreditLedgerService } from '../credit-ledger/credit-ledger.service';
import { hasRenderRight, wallEnabled } from '../../common/free-tier';

/**
 * Код отказа — читает клиент, чтобы нарисовать стену, а не общую
 * ошибку. Тот же приём, что у остальных осмысленных отказов продукта.
 */
export const GENERATION_LOCKED = 'generation-locked';

/** Текст стены. Один на все три старта: человеку всё равно, какой из них. */
export const GENERATION_LOCKED_MESSAGE =
  'Бесплатные генерации закончились. Подпишитесь на канал, пригласите ' +
  'друзей или купите пакет — и продолжим.';

export class GenerationLockedException extends ForbiddenException {
  constructor() {
    super({
      statusCode: 403,
      message: GENERATION_LOCKED_MESSAGE,
      reason: GENERATION_LOCKED,
    });
  }
}

/** Чем оплачен этот старт — вызывающему нужно для возврата при неудаче. */
export interface RenderAccess {
  /** Списан кредит: при неудаче его надо вернуть (`refundIfReserved`). */
  usedCredit: boolean;
}

@Injectable()
export class RenderAccessService {
  private readonly logger = new Logger(RenderAccessService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlanService,
    private readonly credits: CreditLedgerService,
  ) {}

  /**
   * Пускать ли этот старт рендера.
   *
   * @param userId владелец сессии; `null` — анонимный браузерный путь.
   * @param generatedVideoId ключ ПОПЫТКИ: по нему списывается и
   *   возвращается кредит. Обязателен — без него списание не
   *   идемпотентно, а этот метод зовётся в том числе из мест, которые
   *   вызывающий повторяет.
   * @param opts.projectId нужен `assertCanSpendUser` ради тестового
   *   доступа (TODO §III п.37): без него самая дорогая операция
   *   продукта осталась бы под потолком даже у тестировщика.
   * @param opts.mode `'batch'` — партия по каталогу. Отличий два, и оба
   *   не косметические:
   *
   *   - **кредитами партия не оплачивается.** Двенадцать бесплатных
   *     генераций одним кликом опустошили бы лестницу, которую человек
   *     собирал неделю;
   *   - **суточный потолок здесь не спрашивается.** Его спрашивает сам
   *     вызывающий — и спрашивает УМНЕЕ: стоимостью всей пачки разом,
   *     а не одного ролика. Повторить это здесь нечем, а спросить
   *     заодно значило бы поставить рядом вторую, более слабую
   *     проверку тех же денег.
   */
  async assertCanRender(
    userId: string | null | undefined,
    generatedVideoId: string,
    opts: {
      projectId?: string | null;
      mode?: 'single' | 'batch';
    } = {},
  ): Promise<RenderAccess> {
    const batch = opts.mode === 'batch';
    const creditsAllowed = !batch;

    // Рубильник выключен — ведём себя ровно как до этапа 132: кредит,
    // если он есть, иначе суточный потолок. Ни одного нового отказа.
    if (!wallEnabled()) {
      const usedCredit = creditsAllowed
        ? await this.credits.reserveForGeneration(userId, generatedVideoId)
        : false;
      if (!usedCredit && !batch) {
        await this.plans.assertCanSpendUser(userId ?? null, {
          projectId: opts.projectId ?? null,
        });
      }
      return { usedCredit };
    }

    // Анонимный не может ни иметь права, ни держать кредиты (их не
    // начисляют без identity). Отказываем стеной, а не суточным
    // лимитом: «попробуйте завтра» там, где нужно «войдите», — худший
    // из возможных ответов.
    if (!userId) throw new GenerationLockedException();

    if (await this.hasRight(userId)) {
      if (!batch) {
        await this.plans.assertCanSpendUser(userId, {
          projectId: opts.projectId ?? null,
        });
      }
      return { usedCredit: false };
    }

    if (creditsAllowed) {
      // Приветственная генерация выдаётся ЗДЕСЬ, а не при заведении
      // пользователя: `TelegramIdentityMiddleware` заводит его на первом
      // же запросе любого маршрута, и начисление оттуда означало бы
      // лишнюю запись в базу на каждый холодный вход. Здесь же оно
      // случается ровно тогда, когда впервые понадобилось.
      await this.credits.grantWelcomeIfFirst(userId);
      const usedCredit = await this.credits.reserveForGeneration(
        userId,
        generatedVideoId,
      );
      if (usedCredit) return { usedCredit };
    }

    this.logger.log(
      `стена: ${userId} без права и без кредитов (${generatedVideoId})`,
    );
    throw new GenerationLockedException();
  }

  /**
   * Право — оплаченной подпиской или снятой стеной.
   *
   * Подписка читается СТРОКОЙ `Subscription`, а не `users.plan`: пока
   * оплата выключена, режим пользователь ставит себе сам, и стена,
   * глядящая на режим, снималась бы одной кнопкой в интерфейсе.
   */
  private async hasRight(userId: string): Promise<boolean> {
    const row: {
      liteUnlockedAt: Date | null;
      liteRevokedAt: Date | null;
      subscription: { status: string; currentPeriodEnd: Date } | null;
    } | null = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        liteUnlockedAt: true,
        liteRevokedAt: true,
        subscription: { select: { status: true, currentPeriodEnd: true } },
      },
    });
    if (!row) return false;
    const sub = row.subscription;
    // ACTIVE/RENEWING с неистёкшим периодом. PAST_DUE намеренно нет:
    // это состояние «списание не прошло», и рендерить в долг незачем.
    const hasActiveSubscription =
      !!sub &&
      (sub.status === 'ACTIVE' || sub.status === 'RENEWING') &&
      sub.currentPeriodEnd.getTime() > Date.now();
    return hasRenderRight({
      liteUnlockedAt: row.liteUnlockedAt,
      liteRevokedAt: row.liteRevokedAt,
      hasActiveSubscription,
    });
  }
}
