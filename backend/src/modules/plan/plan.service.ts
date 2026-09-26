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
  dailyLimitForTestUser,
  DailySpendLimitExceededException,
  testBudgetDeniedMessage,
} from '../../common/spend-limits';
import {
  FreeScenario,
  isSpendFree,
  testAccessActive,
  normalizeFreeScenarios,
  scenarioOfProjectType,
} from '../../common/test-user-scenarios';
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
  /**
   * Тестовый аккаунт (TODO §III п.37). Влияет РОВНО на одно — суточный
   * потолок расхода на отмеченных сценариях; ни тариф, ни блокировка от
   * него не зависят.
   */
  isTestUser: boolean;
  /** Сценарии с бесплатным использованием; пусто — как у всех. */
  freeScenarios: FreeScenario[];
  /** Операции вне проекта — своя галочка (этап 159, §4.1 ТЗ). */
  freeOutsideProject: boolean;
  /** До какого момента действует доступ. NULL — бессрочно. */
  testAccessUntil: Date | null;
  /** Свой суточный потолок в долларах. NULL — общий для тестовых. */
  testDailyLimitUsd: number | null;
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
        // У анонимного пути пользователя нет, значит и тестовым он быть
        // не может: иначе бесплатный доступ раздавался бы всем разом.
        isTestUser: false,
        freeScenarios: [],
        freeOutsideProject: false,
        testAccessUntil: null,
        testDailyLimitUsd: null,
      };
    }
    const row: {
      plan: string;
      planSelfService: boolean;
      isBlocked: boolean;
      blockedReason: string | null;
      isTestUser: boolean;
      freeScenarios: string[];
      freeOutsideProject: boolean;
      testAccessUntil: Date | null;
      testDailyLimitUsd: number | null;
    } | null = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        plan: true,
        planSelfService: true,
        isBlocked: true,
        blockedReason: true,
        isTestUser: true,
        freeScenarios: true,
        freeOutsideProject: true,
        testAccessUntil: true,
        testDailyLimitUsd: true,
      },
    });
    const plan = planOf(row?.plan);
    return {
      plan,
      spendPlan: spendPlanOf(plan, row?.planSelfService ?? false),
      isBlocked: row?.isBlocked ?? false,
      blockedReason: row?.blockedReason ?? null,
      isTestUser: row?.isTestUser ?? false,
      freeScenarios: normalizeFreeScenarios(row?.freeScenarios),
      freeOutsideProject: row?.freeOutsideProject ?? false,
      testAccessUntil: row?.testAccessUntil ?? null,
      testDailyLimitUsd: row?.testDailyLimitUsd ?? null,
    };
  }

  /** Режим пользователя; неизвестный/анонимный — Lite. */
  /**
   * Режим и суточный потолок одним ответом (этап 144, аудит).
   *
   * Отдельный метод, а не `stateOf`: тот собран для экрана — тащит
   * тарифы со всеми текстами, подписку, кредиты и локаль. Внешнему API
   * из всего этого нужны два числа, и платить за остальное запросами в
   * базу на каждом healthcheck интегратора незачем.
   */
  async budgetOf(userId: string): Promise<{
    plan: PlanId;
    limitMicroUsd: number;
    spentMicroUsd: number;
    remainingMicroUsd: number;
  }> {
    const access = await this.accessOf(userId);
    const verdict = await this.aiUsage.budget(
      userId,
      access.spendPlan,
      new Date(),
      // Тот же вопрос, что в `stateOf` (там же и объяснён): проекта в
      // ответе нет, значит спрашиваем про операции вне проекта.
      isSpendFree(access, 'OUTSIDE_PROJECT') ? testLimitOf(access) : undefined,
    );
    return {
      plan: access.plan,
      limitMicroUsd: verdict.limitMicroUsd,
      spentMicroUsd: verdict.spentMicroUsd,
      remainingMicroUsd: verdict.remainingMicroUsd,
    };
  }

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
  async assertCanSpendUser(
    userId: string | null | undefined,
    /**
     * Проект, ради которого тратим, — по нему определяется сценарий
     * тестового доступа (TODO §III п.37). Передаётся там, где проект
     * УЖЕ в руках; вызовы вне проекта (клон голоса, озвучка, скетч,
     * поиск на YouTube) его не имеют, и для них действует строгое
     * правило `isSpendFree` — бесплатно только при всех галочках.
     */
    opts: { projectId?: string | null } = {},
  ): Promise<void> {
    const access = await this.accessOf(userId);
    await this.assertSpend(access, userId ?? null, opts.projectId ?? null);
  }

  /** То же для открытых маршрутов — по владельцу сессии. */
  async assertCanSpendSession(sessionId: string): Promise<void> {
    const session = await this.sessions.getSession(sessionId);
    const access = await this.accessOf(session?.userId ?? null);
    await this.assertSpend(
      access,
      session?.userId ?? null,
      session?.projectId ?? null,
    );
  }

  /**
   * Общая часть обеих проверок.
   *
   * Порядок важен и не изменился: сначала блокировка — решение
   * оператора, которое тестовый флаг НЕ отменяет, иначе заблокировать
   * тестировщика было бы нечем. Потом потолок.
   *
   * Тестовый доступ МЕНЯЕТ потолок, а не отменяет его. «Бесплатно»
   * здесь про пользователя, а не про нас: провайдеру платим в любом
   * случае, и аккаунт, которому специально разрешили не считать деньги,
   * — последнее место, где стоит убирать край (TODO §III п.37, пункт
   * «Лимиты»).
   */
  private async assertSpend(
    access: UserAccess,
    userId: string | null,
    projectId: string | null,
  ): Promise<void> {
    this.assertNotBlocked(access);

    const free = await this.spendIsFree(access, projectId);
    const verdict = await this.aiUsage.budget(
      userId ?? null,
      access.spendPlan,
      new Date(),
      free ? testLimitOf(access) : undefined,
    );
    if (!verdict.allowed) {
      this.logger.warn(
        `дневной лимит расхода исчерпан: ${
          userId ?? 'анонимные'
        }${free ? ' (тестовый доступ)' : ''} потратил(и) ${verdict.spentMicroUsd} мкд при потолке ${verdict.limitMicroUsd}`,
      );
      // Е-1.2 шестого аудита: отдельный класс, не общий ForbiddenException —
      // это временное состояние (см. doc-comment DailySpendLimitExceededException).
      throw new DailySpendLimitExceededException(
        free ? testBudgetDeniedMessage() : budgetDeniedMessage(!userId),
      );
    }
  }

  /**
   * Тип проекта читается ТОЛЬКО когда он может что-то изменить.
   *
   * Тестовых аккаунтов единицы, а через эту проверку проходит каждый
   * платный вызов продукта: лишняя поездка в базу на всех ради
   * нескольких — плохой обмен.
   */
  private async spendIsFree(
    access: UserAccess,
    projectId: string | null,
  ): Promise<boolean> {
    // Срок проверяется ЗДЕСЬ, до поездки за типом проекта (этап 159,
    // §4.2): истёкший доступ — это обычный пользователь, и лишний
    // запрос ради него не нужен.
    if (!testAccessActive(access)) return false;
    // Ни одной галочки — ни одного разрешения; сюда же попадает
    // прежнее «тестовый, но ничего не открыто».
    if (!access.freeScenarios.length && !access.freeOutsideProject) {
      return false;
    }
    // Проекта нет — операция вне проекта. Проект есть, а сценария у
    // него нет — неизвестный тип, и он не бесплатен (аудит этапа 159:
    // свалив эти два случая в один, мы сделали бы новый тип проекта
    // бесплатным сам собой).
    const target = projectId
      ? (scenarioOfProjectType(await this.projectTypeOf(projectId)) ??
        'UNKNOWN_PROJECT')
      : 'OUTSIDE_PROJECT';
    const free = isSpendFree(access, target);
    if (free) {
      this.logger.log(`тестовый доступ: потолок не применён (${target})`);
    }
    return free;
  }

  private async projectTypeOf(projectId: string): Promise<string | null> {
    const row: { type: string } | null = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { type: true },
    });
    return row?.type ?? null;
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
    /**
     * Тестовый доступ (TODO §III п.37).
     *
     * Наружу уходит, потому что молчаливая отметка — половина фичи:
     * тестировщик, которому не сказали, что он на тестовом доступе, не
     * отличит бесплатный проход от сломанного биллинга и придёт с
     * вопросом «почему с меня не списывают». Сценарии передаются
     * кодами: как их называть, решает интерфейс, у которого есть языки.
     */
    testAccess: { isTestUser: boolean; freeScenarios: FreeScenario[] };
    subscription: {
      plan: PlanId;
      status: string;
      currentPeriodEnd: Date;
      cancelAtPeriodEnd: boolean;
    } | null;
    credits: { balance: number };
  }> {
    const access = await this.accessOf(userId);
    /**
     * Потолок тестового аккаунта.
     *
     * Ответ общий на весь интерфейс, проекта в нём нет — значит и
     * вопрос тот же, что у операции вне проекта: снят ли общий потолок.
     * С этапа 159 на это отвечает своя галочка, а не вывод из трёх
     * сценарных. Тестировщик с одной сценарной галочкой видит свой
     * тарифный потолок — и это правда: вне проекта действует он.
     */
    const verdict = await this.aiUsage.budget(
      userId,
      access.spendPlan,
      new Date(),
      isSpendFree(access, 'OUTSIDE_PROJECT') ? testLimitOf(access) : undefined,
    );
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
      testAccess: {
        // `testAccessActive`, а не `isTestUser` (аудит этапа 159):
        // истёкший срок гасит доступ, а строка остаётся. Оставь здесь
        // голый флаг — и человек, у которого доступ вчера кончился,
        // читал бы на экране «тестовый доступ, бесплатно: товарка»,
        // пока `isSpendFree` отвечает отказом. Это ровно то обещание,
        // которого нет в проверке, — и предупреждение об этом уже
        // стояло в комментарии строкой ниже.
        isTestUser: testAccessActive(access),
        // Галочки без действующего доступа не действуют — и показывать
        // их не надо: иначе на экране появится обещание, которого нет в
        // проверке.
        freeScenarios: testAccessActive(access) ? access.freeScenarios : [],
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

/**
 * Суточный потолок тестового аккаунта: свой, если задан, иначе общий
 * (этап 159, §4.3 ТЗ на работу с тестировщиком).
 *
 * Общий `DAILY_SPEND_LIMIT_USD_TEST_USER` — это потолок НА КАЖДОГО
 * тестировщика: трое это втрое больше денег в сутки, и сказать «этому
 * меньше» было нечем. Ноль — законное значение и означает ровно ноль, а
 * не «как у всех»: тестировщику можно временно закрыть трату, не снимая
 * с него флага и не теряя его галочек.
 */
function testLimitOf(access: { testDailyLimitUsd: number | null }): number {
  const own = access.testDailyLimitUsd;
  if (own === null || own === undefined || own < 0) {
    return dailyLimitForTestUser();
  }
  return Math.round(own * 1_000_000);
}
