/**
 * PlanService — «в каком режиме работает этот пользователь и что ему
 * можно» (ТЗ §23, этап 29).
 *
 * Две особенности, из которых растёт весь остальной код:
 *
 * 1. **Анонимная сессия — это Lite.** Пакет живёт на пользователе, а
 *    анонимный браузерный путь пользователя не имеет. Значит и режим у
 *    него самый узкий: разбор и генерация в родных форматах. Это не
 *    наказание, а следствие — премиальные вещи (библиотека, бренд,
 *    публикация) и так требуют идентичности.
 *
 * 2. **Проверка идёт по сессии, а не по заголовку.** Большая часть
 *    маршрутов открыта и предъявителем считает UUID сессии (§7.8),
 *    поэтому режим берётся у владельца сессии — иначе пользователь
 *    Premium терял бы свои возможности на каждом открытом маршруте.
 */

import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SessionService } from '../../common/session.service';
import {
  DEFAULT_PLAN,
  featureDeniedMessage,
  PlanFeature,
  PlanId,
  planAllows,
  planOf,
  PLANS,
  plansFor,
  spendPlanOf,
} from '../../common/plans';
import { DEFAULT_LOCALE, SupportedLocale } from '../../common/locale';
import {
  budgetDeniedMessage,
  DailySpendLimitExceededException,
} from '../../common/spend-limits';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { CreditLedgerService } from '../credit-ledger/credit-ledger.service';
import { TelegramStarsService } from '../billing/telegram-stars.service';

/** Что сервису нужно знать о правах пользователя перед платной операцией. */
export interface UserAccess {
  /** Режим, определяющий доступные функции. */
  plan: PlanId;
  /**
   * Режим, определяющий суточный потолок расхода (этап 54, Б-3.8). Пока
   * оплаты нет, пользователь переключает режим сам — и до этого этапа
   * вместе с функциями получал потолок Premium ($30 вместо $2). Теперь
   * самостоятельно выбранный режим даёт функции, но деньги считаются по
   * Lite; режим, назначенный оператором, — по своему потолку.
   */
  spendPlan: PlanId;
  isBlocked: boolean;
  blockedReason: string | null;
}

@Injectable()
export class PlanService {
  private readonly logger = new Logger(PlanService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly aiUsage: AiUsageService,
    private readonly creditLedger: CreditLedgerService,
    private readonly stars: TelegramStarsService,
  ) {}

  /**
   * Режим и блокировка одним запросом. Оба отвечают на один вопрос —
   * «что этому пользователю сейчас можно», — и разделять их на две
   * поездки в базу ради симметрии кода незачем.
   */
  async accessOf(userId: string | null | undefined): Promise<UserAccess> {
    if (!userId) {
      return {
        plan: DEFAULT_PLAN,
        spendPlan: DEFAULT_PLAN,
        isBlocked: false,
        blockedReason: null,
      };
    }
    const row: {
      plan: string;
      planSelfService: boolean;
      isBlocked: boolean;
      blockedReason: string | null;
    } | null = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        plan: true,
        planSelfService: true,
        isBlocked: true,
        blockedReason: true,
      },
    });
    const plan = planOf(row?.plan);
    return {
      plan,
      spendPlan: spendPlanOf(plan, row?.planSelfService ?? false),
      isBlocked: row?.isBlocked ?? false,
      blockedReason: row?.blockedReason ?? null,
    };
  }

  /** Режим пользователя; неизвестный/анонимный — Lite. */
  async planOfUser(userId: string | null | undefined): Promise<PlanId> {
    return (await this.accessOf(userId)).plan;
  }

  /**
   * Заблокированному запрещены ПЛАТНЫЕ вызовы (ТЗ §25.3): разбор,
   * релевантность, промпт, генерация, аудит, расшифровка голоса,
   * распознавание фото, поиск аналогов и поиск на YouTube. Читать и
   * скачивать уже сделанное он может — блокировка останавливает трату
   * денег, а не отбирает результат, за который уже заплачено.
   *
   * Режим при блокировке сознательно НЕ трогается: на Lite заблокированный
   * переедет сам, когда закончится оплаченный период.
   */
  assertNotBlocked(access: UserAccess): void {
    if (!access.isBlocked) return;
    throw new ForbiddenException(
      access.blockedReason
        ? `Платные операции приостановлены: ${access.blockedReason}. Уже созданные проекты и готовые ролики остаются доступны.`
        : 'Платные операции приостановлены. Уже созданные проекты и готовые ролики остаются доступны; за разъяснениями обратитесь в поддержку.',
    );
  }

  async assertUserNotBlocked(userId: string | null | undefined): Promise<void> {
    this.assertNotBlocked(await this.accessOf(userId));
  }

  /** То же для открытых маршрутов: блокировку проверяем у ВЛАДЕЛЬЦА сессии. */
  async assertSessionNotBlocked(sessionId: string): Promise<void> {
    const session = await this.sessions.getSession(sessionId);
    await this.assertUserNotBlocked(session?.userId ?? null);
  }

  /**
   * Единственная проверка, которую делают все платные вызовы (ТЗ §26.4):
   * не заблокирован ли пользователь и остался ли у него дневной лимит.
   *
   * Две причины держать их вместе, а не по отдельности на каждом вызове:
   * обе отвечают на один вопрос — «можно ли сейчас тратить деньги на
   * этого человека», — и обе иначе пришлось бы не забыть в девяти местах.
   * Порядок важен: сначала блокировка (решение оператора, объясняет себя
   * причиной), потом лимит (временный и снимется завтра).
   */
  async assertCanSpendUser(userId: string | null | undefined): Promise<void> {
    const access = await this.accessOf(userId);
    this.assertNotBlocked(access);

    const verdict = await this.aiUsage.budget(userId ?? null, access.spendPlan);
    if (!verdict.allowed) {
      this.logger.warn(
        `дневной лимит расхода исчерпан: ${
          userId ?? 'анонимные'
        } потратил(и) ${verdict.spentMicroUsd} мкд при потолке ${verdict.limitMicroUsd}`,
      );
      // Е-1.2 шестого аудита: отдельный класс, не общий ForbiddenException —
      // это временное состояние (см. doc-comment DailySpendLimitExceededException).
      throw new DailySpendLimitExceededException(budgetDeniedMessage(!userId));
    }
  }

  /** То же для открытых маршрутов — по владельцу сессии. */
  async assertCanSpendSession(sessionId: string): Promise<void> {
    const session = await this.sessions.getSession(sessionId);
    await this.assertCanSpendUser(session?.userId ?? null);
  }

  /**
   * Всё, что интерфейсу нужно знать разом: режим, матрица, блокировка и
   * состояние дневного лимита. Собрано в одном месте, потому что иначе
   * каждый из четырёх ответов пришлось бы собирать в контроллере, а
   * анонимный путь — не забыть отдельно.
   *
   * Наружу уходят ПРИЗНАКИ, а не суммы: сколько именно потрачено — дело
   * оператора, у пользователя вопрос другой, «можно ли мне сейчас
   * работать».
   *
   * `subscription`/`credits` (этап 62, ТЗ §41.4) — читаются НАПРЯМУЮ через
   * Prisma/`CreditLedgerService`, без импорта `billing`/`billing-renewal`:
   * тот же принцип независимости, что уже был у `PlanService`/
   * `AiUsageService` — платёжные модули знают про `PlanService`, а не
   * наоборот, иначе вышел бы цикл импортов.
   */
  async stateOf(
    userId: string | null,
    locale: SupportedLocale = DEFAULT_LOCALE,
  ): Promise<{
    plan: PlanId;
    plans: typeof PLANS;
    billingEnabled: boolean;
    blocked: { isBlocked: boolean; reason: string | null };
    budget: { exhausted: boolean; nearlyExhausted: boolean };
    subscription: {
      plan: PlanId;
      status: string;
      currentPeriodEnd: Date;
      cancelAtPeriodEnd: boolean;
    } | null;
    credits: { balance: number };
  }> {
    const access = await this.accessOf(userId);
    const verdict = await this.aiUsage.budget(userId, access.spendPlan);
    const [subscriptionRow, creditsBalance] = userId
      ? await Promise.all([
          this.prisma.subscription.findUnique({
            where: { userId },
            select: {
              plan: true,
              status: true,
              currentPeriodEnd: true,
              cancelAtPeriodEnd: true,
            },
          }),
          this.creditLedger.balanceOf(userId),
        ])
      : [null, 0];
    return {
      plan: access.plan,
      plans: plansFor(locale),
      billingEnabled: process.env.PLANS_BILLING_ENABLED === 'true',
      blocked: {
        isBlocked: access.isBlocked,
        reason: access.blockedReason,
      },
      budget: {
        exhausted: !verdict.allowed,
        // Предупредить до начала длинного пути честнее, чем отказать на
        // кнопке «сгенерировать» после разбора и промпта.
        nearlyExhausted:
          verdict.allowed &&
          verdict.limitMicroUsd > 0 &&
          verdict.remainingMicroUsd / verdict.limitMicroUsd < 0.2,
      },
      subscription: subscriptionRow
        ? {
            plan: planOf(subscriptionRow.plan),
            status: subscriptionRow.status,
            currentPeriodEnd: subscriptionRow.currentPeriodEnd,
            cancelAtPeriodEnd: subscriptionRow.cancelAtPeriodEnd,
          }
        : null,
      credits: { balance: creditsBalance },
    };
  }

  /** Режим владельца сессии — для открытых маршрутов под /sessions. */
  async planOfSession(sessionId: string): Promise<PlanId> {
    const session = await this.sessions.getSession(sessionId);
    return this.planOfUser(session?.userId ?? null);
  }

  /** Бросает 403 с текстом, который не стыдно показать пользователю. */
  assert(plan: PlanId, feature: PlanFeature): void {
    if (planAllows(plan, feature)) return;
    throw new ForbiddenException(featureDeniedMessage(feature));
  }

  async assertUser(
    userId: string | null | undefined,
    feature: PlanFeature,
  ): Promise<void> {
    this.assert(await this.planOfUser(userId), feature);
  }

  async assertSession(sessionId: string, feature: PlanFeature): Promise<void> {
    this.assert(await this.planOfSession(sessionId), feature);
  }

  /**
   * Смена режима.
   *
   * Пока оплаты нет (`PLANS_BILLING_ENABLED!=='true'`) — пользователь
   * переключается сам, бесплатно, как и раньше.
   *
   * Когда оплата включена (этап 62, ТЗ §41.4): понижение до LITE — это
   * ЗАПРОС ОТМЕНЫ, а не мгновенное понижение — доступ должен остаться до
   * конца уже оплаченного периода, иначе пользователь платит за месяц, а
   * теряет его в момент клика. Флаг `cancelAtPeriodEnd` подхватывает крон
   * продления (`billing-renewal-worker.service.ts`) в момент, когда
   * период реально закончится. Повышение до STANDARD/PREMIUM — это
   * покупка, не выбор режима; кидаем 403 с прямым указанием, куда идти.
   */
  async setPlan(userId: string, plan: PlanId): Promise<PlanId> {
    if (process.env.PLANS_BILLING_ENABLED === 'true') {
      if (plan !== 'LITE') {
        throw new ForbiddenException(
          'Смена режима стала покупкой — оформите подписку через ' +
            'POST /api/billing/checkout/subscription.',
        );
      }
      const subscription = await this.prisma.subscription.findUnique({
        where: { userId },
        select: { id: true, status: true, method: true },
      });
      // Нет активной подписки (или уже отменена) — отменять нечего,
      // запрос идемпотентен: просто возвращаем текущий (уже LITE) режим.
      if (subscription && subscription.status !== 'CANCELED') {
        await this.prisma.subscription.update({
          where: { id: subscription.id },
          data: { cancelAtPeriodEnd: true },
        });
        this.logger.log(
          `user ${userId} requested subscription cancellation (access continues until period end)`,
        );
        // Г-2.2 (аудит round4): без этого Telegram продолжает списывать
        // Stars каждые 30 дней после нашей локальной отмены — сообщаем
        // ему СРАЗУ, не дожидаясь крона продления (тот дойдёт до строки,
        // только когда период уже истёк).
        if (subscription.method === 'STARS') {
          await this.notifyTelegramCancellation(userId);
        }
      }
      return this.planOfUser(userId);
    }
    const row: { plan: string } = await this.prisma.user.update({
      where: { id: userId },
      // Флаг самостоятельного выбора: функции — да, потолок — Lite (Б-3.8).
      data: { plan, planSince: new Date(), planSelfService: true },
      select: { plan: true },
    });
    this.logger.log(`user ${userId} switched plan to ${plan}`);
    return planOf(row.plan);
  }

  /**
   * Применяет купленный/системно назначенный режим (этап 62). Вызывается
   * ТОЛЬКО из вебхуков оплаты и крона продления/отмены подписки — никогда
   * напрямую из контроллера, у которого для смены режима есть `setPlan`.
   *
   * `planSelfService: false` — это ключевое отличие от `setPlan`: режим
   * назначен оплатой/системой, а не выбором пользователя, значит суточный
   * потолок должен считаться по НЕМУ (см. `spendPlanOf`), а не по Lite.
   */
  async applyPurchasedPlan(userId: string, plan: PlanId): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { plan, planSince: new Date(), planSelfService: false },
    });
    this.logger.log(`user ${userId} plan set to ${plan} by billing`);
  }

  /**
   * Best-effort уведомление Telegram об отмене подписки Stars (Г-2.2).
   * `telegram_payment_charge_id`, который требует Bot API, нигде не
   * хранится отдельным полем — берём его с последнего успешного платежа
   * Stars за подписку этого пользователя (`Payment.providerRef` — это и
   * есть charge id, см. `billing.service.ts:handleStarsSuccess`).
   * Отсутствие подходящего платежа/telegramId — не ошибка вызова
   * `setPlan`: локальная отмена уже применена, это только курьерский шаг.
   */
  private async notifyTelegramCancellation(userId: string): Promise<void> {
    const [user, lastPayment] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { telegramId: true },
      }),
      this.prisma.payment.findFirst({
        where: {
          userId,
          method: 'STARS',
          purpose: 'SUBSCRIPTION',
          status: 'SUCCEEDED',
        },
        orderBy: { createdAt: 'desc' },
        select: { providerRef: true },
      }),
    ]);
    if (!user?.telegramId || !lastPayment) return;
    const ok = await this.stars.cancelSubscription(
      user.telegramId,
      lastPayment.providerRef,
    );
    if (!ok) {
      this.logger.warn(
        `не удалось подтвердить отмену подписки Stars в Telegram для user ${userId} — локальная отмена применена, спишет ли Telegram следующий период, нужно проверить вручную`,
      );
    }
  }
}
