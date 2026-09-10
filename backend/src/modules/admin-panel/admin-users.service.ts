/**
 * AdminUsersService — пользователи в админке (ТЗ §25, этап 30).
 *
 * Дыра, которую этап 29 сделал заметной: у пользователя появилась колонка
 * `plan`, а посмотреть или поправить её можно было только через psql. То
 * же самое давно было верно про `isOperator` — единственный флаг доступа
 * в админку выставлялся руками в базе. Пока проект один и разработчик
 * один, это терпимо; как только оператор не он — нет.
 *
 * Что тут есть и чего намеренно нет:
 *  - есть список с поиском, фильтрами и сводкой по каждому пользователю
 *    (сколько сессий, проектов, манифестов, разборов, заявок);
 *  - есть правка режима и флага оператора;
 *  - **нет удаления пользователя.** Удаление уносит каскадом проекты,
 *    манифесты и заявки, а разборы библиотеки остаются без автора
 *    (`ON DELETE SET NULL`) — необратимая операция такого веса не должна
 *    делаться в один клик из списка. Понадобится — отдельным этапом, с
 *    подтверждением и явным перечнем того, что исчезнет.
 */

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { selectSessionSummaries } from '../../common/session-summary';
import { PlanId, planOf, PLAN_IDS, spendPlanOf } from '../../common/plans';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { dailyLimitForPlan } from '../../common/spend-limits';
import { CreditLedgerService } from '../credit-ledger/credit-ledger.service';
import { TelegramStarsService } from '../billing/telegram-stars.service';

export interface AdminUserSummary {
  id: string;
  telegramId: string;
  firstName: string | null;
  username: string | null;
  isOperator: boolean;
  isBlocked: boolean;
  blockedAt: Date | null;
  blockedReason: string | null;
  plan: PlanId;
  planSince: Date | null;
  /** Режим выбран самим пользователем (потолок расхода — как у Lite). */
  planSelfService: boolean;
  termsVersion: string | null;
  termsAcceptedAt: Date | null;
  createdAt: Date;
  /** Расход на ИИ за всё время (ТЗ §26), в микродолларах. */
  costMicroUsd: number;
  costCalls: number;
  /** Расход с начала суток UTC и потолок его режима (ТЗ §26.4). */
  spentTodayMicroUsd: number;
  dailyLimitMicroUsd: number;
  counts: {
    sessions: number;
    projects: number;
    brandManifests: number;
    libraryEntries: number;
    publications: number;
  };
  /** Этап 62 (ТЗ §41): баланс купленных кредитов на генерацию. */
  credits: { balance: number };
  /** Этап 62: активная подписка, если есть. null — Lite или без покупок. */
  subscription: {
    plan: PlanId;
    status: string;
    method: 'STARS' | 'WAYFORPAY';
    currentPeriodEnd: Date;
    cancelAtPeriodEnd: boolean;
  } | null;
}

export interface AdminUserListResult {
  items: AdminUserSummary[];
  total: number;
  page: number;
  pageSize: number;
  /** Сводка по всей базе, не по странице — иначе она вводит в заблуждение. */
  byPlan: Record<PlanId, number>;
  operators: number;
  blocked: number;
}

export interface AdminUserDetail extends AdminUserSummary {
  /** Расход по операциям — из чего сложилась сумма. */
  costByOperation: Array<{ key: string; costMicroUsd: number; calls: number }>;
  /** Последние сессии — чтобы из карточки было куда провалиться. */
  recentSessions: Array<{
    sessionId: string;
    status: string;
    createdAt: Date;
    lastActivityAt: Date;
    productName: string | null;
    hasGeneratedVideo: boolean;
  }>;
}

/** Что пришло из формы админки; оба поля необязательны. */
export interface AdminUserPatch {
  plan?: string;
  isOperator?: boolean;
  isBlocked?: boolean;
  /** Причина блокировки — попадает в текст отказа пользователю. */
  blockedReason?: string | null;
}

const USER_SELECT = {
  id: true,
  telegramId: true,
  firstName: true,
  username: true,
  isOperator: true,
  isBlocked: true,
  blockedAt: true,
  blockedReason: true,
  plan: true,
  planSince: true,
  planSelfService: true,
  termsVersion: true,
  termsAcceptedAt: true,
  createdAt: true,
  _count: {
    select: {
      sessions: true,
      projects: true,
      brandManifests: true,
      libraryEntries: true,
      publications: true,
    },
  },
} as const;

interface UserRowWithCounts {
  id: string;
  telegramId: string;
  firstName: string | null;
  username: string | null;
  isOperator: boolean;
  isBlocked: boolean;
  blockedAt: Date | null;
  blockedReason: string | null;
  plan: string;
  planSince: Date | null;
  planSelfService: boolean;
  termsVersion: string | null;
  termsAcceptedAt: Date | null;
  createdAt: Date;
  _count: {
    sessions: number;
    projects: number;
    brandManifests: number;
    libraryEntries: number;
    publications: number;
  };
}

@Injectable()
export class AdminUsersService {
  private readonly logger = new Logger(AdminUsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiUsage: AiUsageService,
    private readonly creditLedger: CreditLedgerService,
    private readonly stars: TelegramStarsService,
  ) {}

  async list(opts: {
    q?: string;
    plan?: string;
    operatorsOnly?: boolean;
    blockedOnly?: boolean;
    page: number;
    pageSize: number;
  }): Promise<AdminUserListResult> {
    const where: Record<string, unknown> = {};
    if (opts.q?.trim()) {
      const q = opts.q.trim();
      // Поиск по всем трём «именам» сразу: оператор знает пользователя
      // либо по telegramId из логов, либо по @username, либо по имени.
      where.OR = [
        { telegramId: { contains: q, mode: 'insensitive' } },
        { username: { contains: q, mode: 'insensitive' } },
        { firstName: { contains: q, mode: 'insensitive' } },
      ];
    }
    if (opts.plan && (PLAN_IDS as readonly string[]).includes(opts.plan)) {
      where.plan = opts.plan;
    }
    if (opts.operatorsOnly) where.isOperator = true;
    if (opts.blockedOnly) where.isBlocked = true;

    const [rows, total, byPlanRaw, operators, blocked] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: USER_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (opts.page - 1) * opts.pageSize,
        take: opts.pageSize,
      }),
      this.prisma.user.count({ where }),
      // Сводка считается по ВСЕЙ базе, без `where`: цифра «сколько у нас
      // кого» под отфильтрованным списком читалась бы как общая и врала.
      this.prisma.user.groupBy({ by: ['plan'], _count: { _all: true } }),
      this.prisma.user.count({ where: { isOperator: true } }),
      this.prisma.user.count({ where: { isBlocked: true } }),
    ]);

    const byPlan = { LITE: 0, STANDARD: 0, PREMIUM: 0 } as Record<
      PlanId,
      number
    >;
    for (const row of byPlanRaw as Array<{
      plan: string;
      _count: { _all: number };
    }>) {
      byPlan[planOf(row.plan)] += row._count._all;
    }

    const list = rows as unknown as UserRowWithCounts[];
    // Расход берётся одним запросом на всю страницу, а не по строке:
    // двадцать отдельных агрегаций ради колонки — верный способ сделать
    // список медленным ровно тогда, когда он вырастет. Кредиты и
    // подписки (этап 62) — тем же приёмом.
    const ids = list.map((r) => r.id);
    const [costs, today, credits, subscriptions] = await Promise.all([
      this.aiUsage.forUsers(ids),
      this.aiUsage.spentTodayByUsers(ids),
      this.creditLedger.balancesFor(ids),
      this.subscriptionsFor(ids),
    ]);

    return {
      items: list.map((r) =>
        this.toSummary(
          r,
          costs[r.id],
          today[r.id],
          credits[r.id],
          subscriptions[r.id],
        ),
      ),
      total,
      page: opts.page,
      pageSize: opts.pageSize,
      byPlan,
      operators,
      blocked,
    };
  }

  async get(id: string): Promise<AdminUserDetail> {
    const row = (await this.prisma.user.findUnique({
      where: { id },
      select: USER_SELECT,
    })) as unknown as UserRowWithCounts | null;
    if (!row) throw new NotFoundException(`User ${id} not found`);

    const [sessions, costs, costByOperation, today, credits, subscriptions] =
      await Promise.all([
        // Этап 51 (В-4.4): десять последних сессий без колонки `data`.
        selectSessionSummaries(this.prisma, {
          userId: id,
          orderBy: 'lastActivityAt',
          take: 10,
        }),
        this.aiUsage.forUsers([id]),
        this.aiUsage.breakdownForUser(id),
        this.aiUsage.spentTodayByUsers([id]),
        this.creditLedger.balancesFor([id]),
        this.subscriptionsFor([id]),
      ]);

    return {
      ...this.toSummary(
        row,
        costs[id],
        today[id],
        credits[id],
        subscriptions[id],
      ),
      costByOperation,
      recentSessions: sessions.map((s) => {
        return {
          sessionId: s.id,
          status: s.status,
          createdAt: s.createdAt,
          lastActivityAt: s.lastActivityAt,
          productName: s.productName ?? null,
          hasGeneratedVideo: Boolean(s.downloadUrl),
        };
      }),
    };
  }

  /**
   * Правка режима и флага оператора.
   *
   * `actorId` — кто правит. Он нужен ровно для одного правила: **оператор
   * не может снять флаг оператора с самого себя.** Правило выглядит
   * мелочью, но без него один неверный клик оставляет админку без
   * единственного человека, который мог бы это исправить, — а вернуть
   * флаг можно будет только через psql, то есть ровно тем способом, от
   * которого этот экран и должен избавлять.
   *
   * Выдать флаг другому — можно: это и есть смысл экрана. Каждое такое
   * изменение пишется в лог с обеими сторонами, потому что повышение прав
   * — единственная операция здесь, о которой потом спрашивают «кто это
   * сделал».
   */
  async patch(
    actorId: string,
    id: string,
    patch: AdminUserPatch,
  ): Promise<AdminUserDetail> {
    const target = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        telegramId: true,
        isOperator: true,
        isBlocked: true,
        plan: true,
        planSelfService: true,
      },
    });
    if (!target) throw new NotFoundException(`User ${id} not found`);

    const data: Record<string, unknown> = {};

    if (patch.plan !== undefined) {
      if (!(PLAN_IDS as readonly string[]).includes(patch.plan)) {
        throw new BadRequestException(`Unknown plan: ${patch.plan}`);
      }
      if (patch.plan !== target.plan) {
        data.plan = patch.plan;
        data.planSince = new Date();
      }
      // Назначение оператором — всегда «настоящий» режим, с его потолком
      // расхода (Б-3.8), даже если пользователь до этого выбрал его сам.
      if (patch.plan !== target.plan || target.planSelfService) {
        data.planSelfService = false;
      }
    }

    if (patch.isOperator !== undefined) {
      if (
        patch.isOperator === false &&
        target.id === actorId &&
        target.isOperator
      ) {
        throw new ForbiddenException(
          'Нельзя снять права оператора с самого себя — иначе некому будет их вернуть. Попросите это сделать другого оператора.',
        );
      }
      if (patch.isOperator !== target.isOperator) {
        data.isOperator = patch.isOperator;
      }
    }

    if (patch.isBlocked !== undefined) {
      // Блокировать самого себя — тот же класс ошибки, что и снятие
      // собственных прав: заблокированный оператор не сможет пользоваться
      // сервисом, а вернуть всё придётся через psql.
      if (patch.isBlocked === true && target.id === actorId) {
        throw new ForbiddenException(
          'Нельзя заблокировать самого себя. Попросите это сделать другого оператора.',
        );
      }
      if (patch.isBlocked !== target.isBlocked) {
        data.isBlocked = patch.isBlocked;
        // Снятие блокировки чистит и причину: оставленная причина у
        // разблокированного пользователя — мусор, который потом читают
        // как действующий запрет.
        data.blockedAt = patch.isBlocked ? new Date() : null;
        data.blockedReason = patch.isBlocked
          ? patch.blockedReason?.trim() || null
          : null;
      }
    } else if (patch.blockedReason !== undefined) {
      // Правка причины без смены состояния — например, оператор уточняет
      // формулировку, которую видит пользователь.
      data.blockedReason = patch.blockedReason?.trim() || null;
    }

    if (Object.keys(data).length === 0) return this.get(id);

    await this.prisma.user.update({ where: { id }, data });

    if (data.plan) {
      this.logger.log(
        `operator ${actorId} set plan of ${target.telegramId} to ${String(data.plan)}`,
      );
    }
    if (data.isBlocked !== undefined) {
      this.logger.warn(
        `operator ${actorId} ${data.isBlocked ? 'BLOCKED' : 'UNBLOCKED'} ${target.telegramId}${
          data.blockedReason ? ` (${String(data.blockedReason)})` : ''
        }`,
      );
    }
    if (data.isOperator !== undefined) {
      this.logger.warn(
        `operator ${actorId} ${data.isOperator ? 'GRANTED' : 'REVOKED'} operator rights ${data.isOperator ? 'to' : 'from'} ${target.telegramId}`,
      );
    }

    return this.get(id);
  }

  /**
   * Отмена подписки оператором (поддержка) — та же логика, что
   * `PlanService.setPlan(..., 'LITE')` при включённой оплате
   * (`cancelAtPeriodEnd: true`, доступ остаётся до конца периода), но
   * доступна независимо от `PLANS_BILLING_ENABLED`: оператор должен
   * иметь возможность отменить подписку как саппорт-действие даже пока
   * фича выключена для остальных (например, доигрывая последствия ранее
   * включённой оплаты). Без возврата денег — это отдельное действие
   * («Возврат» на странице платежей), не совмещается с отменой.
   */
  async cancelSubscription(actorId: string, userId: string): Promise<void> {
    const subscription = await this.prisma.subscription.findUnique({
      where: { userId },
      select: { id: true, status: true, method: true },
    });
    if (!subscription) {
      throw new NotFoundException(`У пользователя ${userId} нет подписки`);
    }
    if (subscription.status === 'CANCELED') return; // идемпотентно
    await this.prisma.subscription.update({
      where: { id: subscription.id },
      data: { cancelAtPeriodEnd: true },
    });
    this.logger.log(
      `operator ${actorId} requested subscription cancellation for user ${userId} (access continues until period end)`,
    );
    // Г-2.2 (аудит round4) — та же немедленная нотификация Telegram, что
    // и у самостоятельной отмены (`PlanService.setPlan`): иначе Telegram
    // продолжит списывать Stars, а следующий `successful_payment`
    // реанимирует уже отменённую оператором подписку.
    if (subscription.method === 'STARS') {
      await this.notifyTelegramCancellation(userId);
    }
  }

  /**
   * Е-1.5 шестого аудита — ручная правка баланса кредитов оператором
   * (админка «Оплата»/карточка пользователя). `CreditLedgerService.
   * adminAdjust()` был полностью реализован и покрыт тестом с самого
   * этапа 62, но ни один контроллер/UI его не вызывал — оператор
   * структурно не мог компенсировать кредит (например, за подтверждённый
   * вручную, но не дошедший до вебхука платёж) или исправить ошибку
   * без прямого доступа к базе. Каждая правка пишется в лог с обеими
   * сторонами и итоговой дельтой — тот же принцип, что у смены
   * режима/блокировки выше: это единственная операция здесь, о которой
   * потом обязательно спросят «кто и почему это сделал».
   */
  async adjustCredit(
    actorId: string,
    userId: string,
    delta: number,
  ): Promise<void> {
    if (!Number.isInteger(delta) || delta === 0) {
      throw new BadRequestException(
        'Дельта кредита должна быть целым числом, отличным от нуля',
      );
    }
    const target = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, telegramId: true },
    });
    if (!target) throw new NotFoundException(`User ${userId} not found`);

    await this.creditLedger.adminAdjust(userId, delta);
    this.logger.warn(
      `operator ${actorId} adjusted credit balance of ${target.telegramId} by ${delta > 0 ? '+' : ''}${delta}`,
    );
  }

  /** См. `PlanService.notifyTelegramCancellation` — тот же приём и та же
   * причина дублирования (два независимых места отмены, не связанных
   * общим модулем, который стоило бы городить ради одного вызова). */
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
        `не удалось подтвердить отмену подписки Stars в Telegram для user ${userId}`,
      );
    }
  }

  /**
   * Подписки сразу для нескольких пользователей — одним `findMany`, тем
   * же приёмом, что `AiUsageService.forUsers`/`CreditLedgerService.
   * balancesFor`: список админки на N строк не должен бить N запросов
   * ради одной колонки. Отсутствующие в результате id — без подписки
   * (Lite или ничего не покупали).
   */
  private async subscriptionsFor(userIds: string[]): Promise<
    Record<
      string,
      {
        plan: PlanId;
        status: string;
        method: 'STARS' | 'WAYFORPAY';
        currentPeriodEnd: Date;
        cancelAtPeriodEnd: boolean;
      }
    >
  > {
    if (userIds.length === 0) return {};
    const rows = (await this.prisma.subscription.findMany({
      where: { userId: { in: userIds } },
      select: {
        userId: true,
        plan: true,
        status: true,
        method: true,
        currentPeriodEnd: true,
        cancelAtPeriodEnd: true,
      },
    })) as Array<{
      userId: string;
      plan: string;
      status: string;
      method: 'STARS' | 'WAYFORPAY';
      currentPeriodEnd: Date;
      cancelAtPeriodEnd: boolean;
    }>;
    const result: Record<
      string,
      {
        plan: PlanId;
        status: string;
        method: 'STARS' | 'WAYFORPAY';
        currentPeriodEnd: Date;
        cancelAtPeriodEnd: boolean;
      }
    > = {};
    for (const row of rows) {
      result[row.userId] = {
        plan: planOf(row.plan),
        status: row.status,
        method: row.method,
        currentPeriodEnd: row.currentPeriodEnd,
        cancelAtPeriodEnd: row.cancelAtPeriodEnd,
      };
    }
    return result;
  }

  private toSummary(
    row: UserRowWithCounts,
    cost?: { costMicroUsd: number; calls: number },
    spentToday?: number,
    creditsBalance?: number,
    subscription?: {
      plan: PlanId;
      status: string;
      method: 'STARS' | 'WAYFORPAY';
      currentPeriodEnd: Date;
      cancelAtPeriodEnd: boolean;
    },
  ): AdminUserSummary {
    return {
      id: row.id,
      telegramId: row.telegramId,
      firstName: row.firstName,
      username: row.username,
      isOperator: row.isOperator,
      isBlocked: row.isBlocked,
      blockedAt: row.blockedAt,
      blockedReason: row.blockedReason,
      // Через planOf, а не как есть: колонка может содержать значение из
      // будущей или прошлой версии enum, и админка должна показать
      // понятный режим, а не упасть на неизвестной строке.
      plan: planOf(row.plan),
      planSince: row.planSince,
      planSelfService: row.planSelfService,
      termsVersion: row.termsVersion,
      termsAcceptedAt: row.termsAcceptedAt,
      createdAt: row.createdAt,
      costMicroUsd: cost?.costMicroUsd ?? 0,
      costCalls: cost?.calls ?? 0,
      spentTodayMicroUsd: spentToday ?? 0,
      dailyLimitMicroUsd: dailyLimitForPlan(
        spendPlanOf(planOf(row.plan), row.planSelfService),
      ),
      counts: {
        sessions: row._count.sessions,
        projects: row._count.projects,
        brandManifests: row._count.brandManifests,
        libraryEntries: row._count.libraryEntries,
        publications: row._count.publications,
      },
      credits: { balance: creditsBalance ?? 0 },
      subscription: subscription ?? null,
    };
  }
}
