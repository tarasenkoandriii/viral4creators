/**
 * AiUsageService — журнал расходов на внешние платные вызовы (ТЗ §26,
 * этап 31).
 *
 * Два правила, из которых всё остальное следует:
 *
 * 1. **Учёт никогда не роняет работу.** Запись расхода идёт ПОСЛЕ того,
 *    как вызов уже сделан и деньги уже потрачены. Уронить на ней разбор
 *    или готовую генерацию значит взять с владельца деньги и не отдать
 *    результат — поэтому весь `record` завёрнут в try/catch и в худшем
 *    случае пишет предупреждение в лог.
 *
 * 2. **Ноль в отчёте должен быть правдой.** Если ставки для модели нет,
 *    строка пишется с `unpriced: true`, а не с молчаливым нулём: иначе
 *    новая модель, добавленная в код и забытая в прайсе, тихо занижает
 *    сумму. Вкладка «Расходы» показывает такие вызовы отдельно.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SessionService } from '../../common/session.service';
import {
  AiOperation,
  AiProvider,
  estimateCost,
  MODEL_RATES,
  UsageUnits,
} from '../../common/ai-pricing';
import {
  allDailyLimits,
  BudgetVerdict,
  checkBudget,
  dailyLimitForAnonymous,
  dailyLimitForPlan,
  startOfDayUtc,
} from '../../common/spend-limits';
import { PlanId } from '../../common/plans';

export interface RecordUsageInput extends UsageUnits {
  operation: AiOperation;
  model: string;
  /** Явный владелец расхода. Если не задан — определится по сессии. */
  userId?: string | null;
  sessionId?: string | null;
  /** Провайдер: обычно берётся из прайса по модели. */
  provider?: AiProvider;
}

/** Ответ Gemini SDK в той части, которая нас интересует. */
interface GeminiUsageMetadata {
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    /** Повторно использованный вход — тарифицируется дешевле (§26.1). */
    cachedContentTokenCount?: number;
  };
}

/** Ответ OpenAI chat.completions в той же части. */
interface OpenAiUsage {
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

export interface CostBucket {
  key: string;
  costMicroUsd: number;
  calls: number;
}

export interface CostReport {
  pricingVersion: string;
  totalMicroUsd: number;
  totalCalls: number;
  last24hMicroUsd: number;
  last7dMicroUsd: number;
  last30dMicroUsd: number;
  byProvider: CostBucket[];
  byOperation: CostBucket[];
  byModel: CostBucket[];
  /** Вызовы без ставки в прайсе — их деньги в сумму не попали. */
  unpricedCalls: number;
  /** Пользователей с хотя бы одним платным вызовом. */
  payingUsers: number;
  /** Расход, не привязанный ни к какому пользователю (анонимные сессии). */
  anonymousMicroUsd: number;
  /** Средние — по тем, у кого расход вообще был. */
  avgPerUserMicroUsd: number;
  avgPerSessionMicroUsd: number;
  sessionsWithCost: number;
  /** Потолки (§26.4) и то, сколько анонимные уже выбрали сегодня. */
  limits: { byPlan: Record<string, number>; anonymous: number };
  anonymousSpentTodayMicroUsd: number;
  top: Array<{
    userId: string;
    telegramId: string | null;
    username: string | null;
    isBlocked: boolean;
    plan: string;
    costMicroUsd: number;
    calls: number;
  }>;
}

@Injectable()
export class AiUsageService {
  private readonly logger = new Logger(AiUsageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
  ) {}

  /**
   * Записать один вызов. Никогда не бросает: см. правило 1 в шапке.
   *
   * Вызывающий обязан `await`, а не `void` (этап 47, В-2.1). Функция на
   * Vercel не обязана дожить до конца промиса, который отпустила:
   * ответ отдан — экземпляр заморожен, `INSERT` не долетел. Строка
   * расхода — это то, по чему считаются суточный потолок в деньгах и
   * счётчик проб голоса; не записанная строка означает, что потолок не
   * сработает. Задержка — один индексный `INSERT`, дешевле любого из
   * вызовов, которые он учитывает.
   */
  async record(input: RecordUsageInput): Promise<void> {
    try {
      const units: UsageUnits = {
        inputTokens: input.inputTokens ?? 0,
        cachedInputTokens: input.cachedInputTokens ?? 0,
        outputTokens: input.outputTokens ?? 0,
        seconds: input.seconds ?? 0,
        calls: input.calls ?? 1,
        characters: input.characters ?? 0,
      };
      const cost = estimateCost(input.model, units);

      let userId = input.userId ?? null;
      if (!userId && input.sessionId) {
        // Открытые маршруты знают только сессию (§7.8) — владельца
        // достаём здесь, один индексный поиск на вызов, который стоит
        // денег, это шум.
        const session = await this.sessions.getSession(input.sessionId);
        userId = session?.userId ?? null;
      }

      const provider =
        input.provider ?? MODEL_RATES[input.model]?.provider ?? 'GEMINI';

      await this.prisma.aiUsage.create({
        data: {
          userId,
          // Флаг ставится ЗДЕСЬ, при вставке, и больше не меняется:
          // `userId IS NULL` после удаления аккаунта означало бы
          // «анонимный», и расход удалённого выбивал бы общий потолок
          // анонимных для всех остальных (этап 40, А-1.10).
          anonymous: userId === null,
          sessionId: input.sessionId ?? null,
          provider,
          operation: input.operation,
          model: input.model,
          inputTokens: units.inputTokens ?? 0,
          cachedInputTokens: units.cachedInputTokens ?? 0,
          outputTokens: units.outputTokens ?? 0,
          seconds: units.seconds ?? 0,
          calls: units.calls ?? 1,
          characters: units.characters ?? 0,
          costMicroUsd: cost.costMicroUsd,
          pricingVersion: cost.pricingVersion,
          unpriced: cost.unpriced,
        },
      });

      if (cost.unpriced) {
        this.logger.warn(
          `нет ставки в прайсе для модели ${input.model} (${input.operation}) — объём записан, деньги нет; добавьте её в common/ai-pricing.ts`,
        );
      }
    } catch (e) {
      // Деньги уже потрачены, результат у пользователя есть — падать
      // здесь нельзя ни при каких условиях.
      this.logger.warn(
        `не удалось записать расход (${input.operation}/${input.model}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  /** Расход по ответу Gemini — токены лежат в `usageMetadata`. */
  async recordGemini(
    response: unknown,
    ctx: Omit<
      RecordUsageInput,
      'inputTokens' | 'cachedInputTokens' | 'outputTokens'
    >,
  ): Promise<void> {
    const meta = (response as GeminiUsageMetadata)?.usageMetadata;
    await this.record({
      ...ctx,
      inputTokens: meta?.promptTokenCount ?? 0,
      cachedInputTokens: meta?.cachedContentTokenCount ?? 0,
      // Размышления тарифицируются как выход и в счёт попадают — не
      // учитывать их значит занижать расход на самых дорогих вызовах.
      outputTokens:
        (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0),
    });
  }

  /** Расход по ответу OpenAI chat.completions. */
  async recordOpenAi(
    response: unknown,
    ctx: Omit<
      RecordUsageInput,
      'inputTokens' | 'cachedInputTokens' | 'outputTokens'
    >,
  ): Promise<void> {
    const usage = (response as OpenAiUsage)?.usage;
    await this.record({
      ...ctx,
      inputTokens: usage?.prompt_tokens ?? 0,
      cachedInputTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
    });
  }

  // ── Суточные потолки (ТЗ §26.4) ──────────────────────────────────────

  /**
   * Сколько потрачено с начала суток (UTC): либо этим пользователем,
   * либо — при `userId: null` — всеми анонимными вместе.
   */
  async spentToday(
    userId: string | null,
    now: Date = new Date(),
  ): Promise<number> {
    // Анонимных считаем по флагу, а не по `userId IS NULL`: см. поле
    // `anonymous` в схеме (этап 40, А-1.10).
    const where = userId
      ? { userId, createdAt: { gte: startOfDayUtc(now) } }
      : { anonymous: true, createdAt: { gte: startOfDayUtc(now) } };
    const r = (await this.prisma.aiUsage.aggregate({
      where,
      _sum: { costMicroUsd: true },
    })) as { _sum: { costMicroUsd: number | null } };
    return r._sum.costMicroUsd ?? 0;
  }

  /**
   * Сколько раз пользователь сегодня делал такую операцию. Нужен там, где
   * ограничивать надо не деньгами, а числом: проба голоса стоит копейки,
   * и суточный потолок расхода она выберет очень нескоро — а нажать
   * «Прослушать» двести раз подряд можно за минуту (§15.3).
   */
  async countToday(
    userId: string | null,
    operation: AiOperation,
    now: Date = new Date(),
  ): Promise<number> {
    return this.prisma.aiUsage.count({
      where: { userId, operation, createdAt: { gte: startOfDayUtc(now) } },
    });
  }

  /**
   * Остаток на сегодня. У вошедшего потолок свой и зависит от режима, у
   * анонимных — один общий на всех: персонального у них быть не может,
   * а без общего достаточно выйти из аккаунта, чтобы обойти лимит.
   */
  async budget(
    userId: string | null,
    plan: PlanId,
    now: Date = new Date(),
  ): Promise<BudgetVerdict> {
    const limit = userId ? dailyLimitForPlan(plan) : dailyLimitForAnonymous();
    return checkBudget(await this.spentToday(userId, now), limit);
  }

  /** Расход за сегодня сразу у нескольких — для колонки в админке. */
  async spentTodayByUsers(
    userIds: string[],
    now: Date = new Date(),
  ): Promise<Record<string, number>> {
    if (userIds.length === 0) return {};
    // Незакрытый баг типов Prisma `groupBy` (prisma/prisma#17297, #6494):
    // `by` вместе с `where` не резолвится компилятором даже с `as const`
    // — `as any` на аргументе обходит это; форма РЕЗУЛЬТАТА по-прежнему
    // проверяется явным касом ниже.
    const rows = (await this.prisma.aiUsage.groupBy({
      by: ['userId'] as const,
      where: {
        userId: { in: userIds },
        createdAt: { gte: startOfDayUtc(now) },
      },
      _sum: { costMicroUsd: true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)) as Array<{
      userId: string;
      _sum: { costMicroUsd: number | null };
    }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.userId] = r._sum.costMicroUsd ?? 0;
    return out;
  }

  // ── Отчёты для админки ───────────────────────────────────────────────

  /**
   * Кеш отчёта на минуту (Б-1.7).
   *
   * Отчёт — тринадцать агрегатов по журналу, который не чистится
   * никогда: измерено на 800 тыс. строк — 1,19 с полных сканов, и время
   * растёт линейно вместе с таблицей. Оператор при этом обновляет
   * вкладку несколько раз подряд, а цифры за минуту не меняются
   * настолько, чтобы это меняло решения.
   */
  private static readonly REPORT_CACHE_MS = 60_000;
  private reportCache: {
    at: number;
    topLimit: number;
    value: CostReport;
  } | null = null;

  async report(topLimit = 10): Promise<CostReport> {
    const cached = this.reportCache;
    if (
      cached &&
      cached.topLimit === topLimit &&
      Date.now() - cached.at < AiUsageService.REPORT_CACHE_MS
    ) {
      return cached.value;
    }
    const now = Date.now();
    const since = (days: number) => new Date(now - days * 24 * 60 * 60 * 1000);

    const sum = async (where: Record<string, unknown>) => {
      const r = (await this.prisma.aiUsage.aggregate({
        where,
        _sum: { costMicroUsd: true },
      })) as { _sum: { costMicroUsd: number | null } };
      return r._sum.costMicroUsd ?? 0;
    };

    const bucket = async (field: 'provider' | 'operation' | 'model') => {
      // Незакрытый баг типов Prisma `groupBy` (prisma/prisma#17297,
      // #6494) — см. тот же комментарий выше в этом файле; здесь ломает
      // не `where`, а сочетание `_sum` и `_count` сразу.
      const rows = (await this.prisma.aiUsage.groupBy({
        by: [field] as const,
        _sum: { costMicroUsd: true },
        _count: { _all: true },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)) as Array<
        Record<string, string> & {
          _sum: { costMicroUsd: number | null };
          _count: { _all: number };
        }
      >;
      return rows
        .map((r) => ({
          key: r[field],
          costMicroUsd: r._sum.costMicroUsd ?? 0,
          calls: r._count._all,
        }))
        .sort((a, b) => b.costMicroUsd - a.costMicroUsd);
    };

    const [
      totalMicroUsd,
      totalCalls,
      last24hMicroUsd,
      last7dMicroUsd,
      last30dMicroUsd,
      byProvider,
      byOperation,
      byModel,
      unpricedCalls,
      anonymousMicroUsd,
      perUserRaw,
      payingUsersRow,
      usersTotalMicroUsd,
      distinctSessions,
      pricingRow,
    ] = await Promise.all([
      sum({}),
      this.prisma.aiUsage.count(),
      sum({ createdAt: { gte: since(1) } }),
      sum({ createdAt: { gte: since(7) } }),
      sum({ createdAt: { gte: since(30) } }),
      bucket('provider'),
      bucket('operation'),
      bucket('model'),
      this.prisma.aiUsage.count({ where: { unpriced: true } }),
      // Тот же флаг, что и в потолке: «анонимный расход» и «расход
      // удалённого пользователя» — разные вещи (этап 40, А-1.10).
      sum({ anonymous: true }),
      // Топ-10 считается в базе, а не в Node (Б-1.7): без `orderBy` и
      // `take` сюда ехали ВСЕ пользователи с расходом (измерено: 3 750
      // строк, 243 мс) ради десяти строк на экране.
      // Незакрытый баг типов Prisma `groupBy` (prisma/prisma#17297,
      // #6494) — `orderBy`+`take` тут ЕСТЬ (как советуют многие обходные
      // пути в issues), и всё равно не резолвится: `as any` на аргументе.
      this.prisma.aiUsage.groupBy({
        by: ['userId'] as const,
        where: { userId: { not: null } },
        _sum: { costMicroUsd: true },
        _count: { _all: true },
        orderBy: { _sum: { costMicroUsd: 'desc' } },
        take: topLimit,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any) as Promise<
        Array<{
          userId: string;
          _sum: { costMicroUsd: number | null };
          _count: { _all: number };
        }>
      >,
      // Сколько всего пользователей с расходом и сколько они потратили —
      // два числа под таблицей; раньше они считались из той же полной
      // выборки, теперь из двух агрегатов.
      this.prisma.$queryRaw`
        SELECT count(DISTINCT "userId")::int AS "count"
        FROM "ai_usage"
        WHERE "userId" IS NOT NULL
      ` as Promise<Array<{ count: number }>>,
      sum({ userId: { not: null } }),
      // `distinct` у Prisma 7 считается НЕ в SQL, а в JavaScript: клиент
      // выбирает все строки и дедуплицирует их в памяти. На журнале в
      // 800 тыс. строк это ~25 МБ в куче функции ради ОДНОГО числа, и с
      // ростом журнала кончается падением по памяти (этап 37, А-1.1).
      // Сырой запрос считает то же самое одним числом в базе.
      this.prisma.$queryRaw`
        SELECT count(DISTINCT "sessionId")::int AS "count"
        FROM "ai_usage"
        WHERE "sessionId" IS NOT NULL
      ` as Promise<Array<{ count: number }>>,
      this.prisma.aiUsage.findFirst({
        orderBy: { createdAt: 'desc' },
        select: { pricingVersion: true },
      }) as Promise<{ pricingVersion: string } | null>,
    ]);

    // Prisma-клиент в песочнице не сгенерирован, поэтому тип у groupBy
    // теряется внутри Promise.all — возвращаем его здесь, одной строкой,
    // вместо `any` в пяти местах ниже.
    const perUser = perUserRaw as Array<{
      userId: string;
      _sum: { costMicroUsd: number | null };
      _count: { _all: number };
    }>;

    // Порядок уже задан базой (`orderBy` + `take`), пересортировывать
    // нечего — здесь только приведение формы.
    const topRows = perUser.map((r) => ({
      userId: r.userId,
      costMicroUsd: r._sum.costMicroUsd ?? 0,
      calls: r._count._all,
    }));
    const users = topRows.length
      ? ((await this.prisma.user.findMany({
          where: { id: { in: topRows.map((r) => r.userId) } },
          select: {
            id: true,
            telegramId: true,
            username: true,
            isBlocked: true,
            plan: true,
          },
        })) as Array<{
          id: string;
          telegramId: string;
          username: string | null;
          isBlocked: boolean;
          plan: string;
        }>)
      : [];

    const payingUsers = payingUsersRow[0]?.count ?? 0;
    const usersTotal = usersTotalMicroUsd;
    // Postgres отдаёт count одной строкой; пустой результат невозможен,
    // но `?? 0` дешевле, чем предположение.
    const sessionsWithCost = distinctSessions[0]?.count ?? 0;

    const result: CostReport = {
      // Версия берётся из последней записи, а не из константы: если прайс
      // правили, старые строки посчитаны по старым ставкам, и показывать
      // текущую версию над суммой, собранной из разных, — враньё.
      pricingVersion: pricingRow?.pricingVersion ?? 'нет данных',
      totalMicroUsd,
      totalCalls,
      last24hMicroUsd,
      last7dMicroUsd,
      last30dMicroUsd,
      byProvider,
      byOperation,
      byModel,
      unpricedCalls,
      payingUsers,
      anonymousMicroUsd,
      avgPerUserMicroUsd: payingUsers
        ? Math.round(usersTotal / payingUsers)
        : 0,
      avgPerSessionMicroUsd: sessionsWithCost
        ? Math.round(totalMicroUsd / sessionsWithCost)
        : 0,
      sessionsWithCost,
      limits: allDailyLimits(),
      anonymousSpentTodayMicroUsd: await this.spentToday(null),
      top: topRows.map((r) => {
        const u = users.find((x) => x.id === r.userId);
        return {
          userId: r.userId,
          telegramId: u?.telegramId ?? null,
          username: u?.username ?? null,
          isBlocked: u?.isBlocked ?? false,
          plan: u?.plan ?? 'LITE',
          costMicroUsd: r.costMicroUsd,
          calls: r.calls,
        };
      }),
    };

    this.reportCache = { at: Date.now(), topLimit, value: result };
    return result;
  }

  /** Расход одного пользователя — для карточки и колонки в списке. */
  async forUsers(
    userIds: string[],
  ): Promise<Record<string, { costMicroUsd: number; calls: number }>> {
    if (userIds.length === 0) return {};
    // Незакрытый баг типов Prisma `groupBy` (prisma/prisma#17297, #6494)
    // — см. тот же комментарий выше в этом файле.
    const rows = (await this.prisma.aiUsage.groupBy({
      by: ['userId'] as const,
      where: { userId: { in: userIds } },
      _sum: { costMicroUsd: true },
      _count: { _all: true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)) as Array<{
      userId: string;
      _sum: { costMicroUsd: number | null };
      _count: { _all: number };
    }>;
    const out: Record<string, { costMicroUsd: number; calls: number }> = {};
    for (const r of rows) {
      out[r.userId] = {
        costMicroUsd: r._sum.costMicroUsd ?? 0,
        calls: r._count._all,
      };
    }
    return out;
  }

  /** Разбивка расхода одного пользователя по операциям. */
  async breakdownForUser(userId: string): Promise<CostBucket[]> {
    // Незакрытый баг типов Prisma `groupBy` (prisma/prisma#17297, #6494)
    // — см. тот же комментарий выше в этом файле.
    const rows = (await this.prisma.aiUsage.groupBy({
      by: ['operation'] as const,
      where: { userId },
      _sum: { costMicroUsd: true },
      _count: { _all: true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)) as Array<{
      operation: string;
      _sum: { costMicroUsd: number | null };
      _count: { _all: number };
    }>;
    return rows
      .map((r) => ({
        key: r.operation,
        costMicroUsd: r._sum.costMicroUsd ?? 0,
        calls: r._count._all,
      }))
      .sort((a, b) => b.costMicroUsd - a.costMicroUsd);
  }
}
