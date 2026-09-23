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
import {
  Buckets,
  GroupedUsageRow,
  Totals,
  bucketsFromGrouped,
  mergeBuckets,
  mergeTotals,
  microToNumber,
  monthEnd,
  monthStart,
  monthsReadyToRoll,
} from './ai-usage-rollup';
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
  /**
   * Фактическая цена от провайдера — вместо расчёта по прайсу.
   *
   * Обычно цена считается по модели и единицам (`estimateCost`), и это
   * единственный способ, когда провайдер счёт за конкретный вызов не
   * присылает. Hedra — присылает: готовая задача несёт `cost`, который
   * клиент уже умеет читать. Оценка по предсказанной длительности
   * озвучки в этом случае — приближение, а факт есть факт, и в отчёте о
   * расходах должен стоять он.
   *
   * Задан — берётся как есть, `estimateCost` не зовётся вовсе.
   */
  costMicroUsd?: number;
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
  /**
   * Тестовые аккаунты (TODO §III п.37) — ОТДЕЛЬНЫМ блоком, потому что
   * во все остальные числа этого отчёта они не входят.
   *
   * Провайдеру за них заплачено, и молча выкинуть их расход значило бы
   * занизить реальные траты. Но и смешивать нельзя: прогон сценария
   * ради проверки — это не экономика продукта, а её проверка, и
   * средний чек, посчитанный вместе с ней, отвечает не на тот вопрос.
   */
  testUsers: {
    /** Сколько аккаунтов помечено тестовыми (не «сколько тратили»). */
    accounts: number;
    costMicroUsd: number;
    calls: number;
    spentTodayMicroUsd: number;
  };
  /** Потолки (§26.4) и то, сколько анонимные уже выбрали сегодня. */
  limits: {
    byPlan: Record<string, number>;
    anonymous: number;
    /** Потолок тестовых аккаунтов на их сценариях (TODO §III п.37). */
    testUser: number;
  };
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
      // Фактическая цена провайдера важнее расчётной: см.
      // доккомментарий поля. Версия прайса и признак «нет ставки»
      // остаются от расчёта — они описывают НАШ прайс, а не счёт
      // провайдера, и подменять их фактом было бы неправдой.
      const estimated = estimateCost(input.model, units);
      const cost =
        input.costMicroUsd === undefined
          ? estimated
          : { ...estimated, costMicroUsd: input.costMicroUsd };

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
   * Сколько потрачено СЕГОДНЯ (UTC) на конкретную операцию, по всем
   * вызовам сразу — независимо от пользователя/анонимности.
   *
   * Нужен ИИ-консультанту на лендинге (doc/LANDING-TUTORIAL-AI-
   * CONSULTANT-SPEC.md §7.2): у него один ОБЩИЙ суточный бюджет на всех
   * анонимных посетителей сразу, а не персональный потолок и не общий
   * потолок анонимных ВСЕГО продукта (`spentToday(null)` выше) — тот
   * смешал бы расход консультанта с обычным анонимным использованием
   * мастера (разбор/генерация до входа), которое тратит совсем другие
   * деньги на совсем других условиях. Отдельный метод, а не фильтр
   * поверх `spentToday()` — семантика другая (по операции, не по
   * владельцу), совмещать в одной сигнатуре значило бы либо разрешить
   * бессмысленную комбинацию (userId + operation), либо усложнить обе
   * вызывающие стороны ради вызова, которого им не нужно.
   */
  async spentTodayForOperation(
    operation: AiOperation,
    now: Date = new Date(),
  ): Promise<number> {
    const r = (await this.prisma.aiUsage.aggregate({
      where: { operation, createdAt: { gte: startOfDayUtc(now) } },
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
    operation: AiOperation | readonly AiOperation[],
    now: Date = new Date(),
  ): Promise<number> {
    return this.countSince(userId, operation, startOfDayUtc(now));
  }

  /**
   * То же, что `countToday`, с произвольной нижней границей — для месячных
   * квот (doc/AI-SKETCH-SPEC.md §8.2). Сырые строки текущего месяца в
   * `ai_usage` есть всегда: свёртка (`rollupOldMonths`) трогает только
   * прошедшие месяцы.
   */
  async countSince(
    userId: string | null,
    operation: AiOperation | readonly AiOperation[],
    since: Date,
  ): Promise<number> {
    return this.prisma.aiUsage.count({
      where: {
        userId,
        // Несколько операций против ОДНОГО лимита: превью персонажа и
        // ИИ-скетч — обе генерации картинки и обе считаются в одну
        // квоту §8.2, иначе её фактический потолок вдвое выше (A-10).
        operation: Array.isArray(operation)
          ? { in: operation as AiOperation[] }
          : (operation as AiOperation),
        createdAt: { gte: since },
      },
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
    /**
     * Потолок, отличный от тарифного, — сегодня это тестовый доступ
     * (TODO §III п.37). Передаётся именно потолок, а не признак «он
     * тестовый»: решение, КОМУ он положен, принимает `PlanService`, а
     * здесь остаётся один вопрос — уложились или нет.
     */
    limitOverride?: number,
  ): Promise<BudgetVerdict> {
    const limit =
      limitOverride ??
      (userId ? dailyLimitForPlan(plan) : dailyLimitForAnonymous());
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

    /**
     * Тестовые аккаунты исключаются из ВСЕХ чисел ниже и показываются
     * отдельным блоком (TODO §III п.37). Один список на весь отчёт —
     * иначе два десятка запросов читали бы одно и то же.
     */
    const testIds = await this.testUserIds();
    const notTest = this.notTestUsers(testIds);

    const sum = async (where: Record<string, unknown>) => {
      const r = (await this.prisma.aiUsage.aggregate({
        where,
        _sum: { costMicroUsd: true },
      })) as { _sum: { costMicroUsd: number | null } };
      return r._sum.costMicroUsd ?? 0;
    };

    /**
     * Разрез «за всё время» — из сырых строк И из свёртки (этап 118).
     * Окна 1/7/30 дней складывать не нужно: они заведомо короче срока
     * хранения сырых строк, свёртка туда не дотягивается.
     */
    const bucket = async (field: 'provider' | 'operation' | 'model') => {
      // Незакрытый баг типов Prisma `groupBy` (prisma/prisma#17297,
      // #6494) — см. тот же комментарий выше в этом файле; здесь ломает
      // не `where`, а сочетание `_sum` и `_count` сразу.
      const rows = (await this.prisma.aiUsage.groupBy({
        by: [field] as const,
        where: notTest,
        _sum: { costMicroUsd: true },
        _count: { _all: true },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)) as Array<
        Record<string, string> & {
          _sum: { costMicroUsd: number | null };
          _count: { _all: number };
        }
      >;
      const raw: Buckets = new Map(
        rows.map((r) => [
          r[field],
          { costMicroUsd: r._sum.costMicroUsd ?? 0, calls: r._count._all },
        ]),
      );
      const merged = mergeBuckets(
        raw,
        await this.rolledBuckets(field, notTest),
      );
      return [...merged]
        .map(([key, totals]) => ({ key, ...totals }))
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
      rolledAll,
      rolledAnonymous,
      rolledUsers,
      rolledUnpriced,
      rolledTopCandidates,
    ] = await Promise.all([
      sum(notTest),
      this.prisma.aiUsage.count({ where: notTest }),
      sum({ ...notTest, createdAt: { gte: since(1) } }),
      sum({ ...notTest, createdAt: { gte: since(7) } }),
      sum({ ...notTest, createdAt: { gte: since(30) } }),
      bucket('provider'),
      bucket('operation'),
      bucket('model'),
      this.prisma.aiUsage.count({ where: { unpriced: true, ...notTest } }),
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
        where: { userId: { not: null }, ...notTest },
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
      //
      // Объединение двух таблиц, а не максимум из двух чисел (этап 118):
      // множества пересекаются частично, и `max` схлопнул бы
      // непересекающиеся половины — тысяча «только сырых» и восемьсот
      // «только свёрнутых» дали бы тысячу вместо тысячи восьмисот, а
      // средним на человека делится ПОЛНАЯ сумма, включая свёрнутую.
      // `UNION` (не `UNION ALL`) дедуплицирует сам.
      // Тестовые исключаются связью с `users`, а не списком
      // идентификаторов в параметре: запрос остаётся статическим, без
      // массива в плейсхолдере, и читается так же, как раньше.
      this.prisma.$queryRaw`
        SELECT count(*)::int AS "count" FROM (
          SELECT a."userId" FROM "ai_usage" a
            JOIN "users" u ON u."id" = a."userId"
            WHERE u."isTestUser" = false
          UNION
          SELECT m."userId" FROM "ai_usage_monthly" m
            JOIN "users" u ON u."id" = m."userId"
            WHERE u."isTestUser" = false
        ) AS "both"
      ` as Promise<Array<{ count: number }>>,
      sum({ userId: { not: null }, ...notTest }),
      // `distinct` у Prisma 7 считается НЕ в SQL, а в JavaScript: клиент
      // выбирает все строки и дедуплицирует их в памяти. На журнале в
      // 800 тыс. строк это ~25 МБ в куче функции ради ОДНОГО числа, и с
      // ростом журнала кончается падением по памяти (этап 37, А-1.1).
      // Сырой запрос считает то же самое одним числом в базе.
      this.prisma.$queryRaw`
        SELECT count(DISTINCT a."sessionId")::int AS "count"
        FROM "ai_usage" a
        LEFT JOIN "users" u ON u."id" = a."userId"
        WHERE a."sessionId" IS NOT NULL
          AND COALESCE(u."isTestUser", false) = false
      ` as Promise<Array<{ count: number }>>,
      this.prisma.aiUsage.findFirst({
        where: notTest,
        orderBy: { createdAt: 'desc' },
        select: { pricingVersion: true },
      }) as Promise<{ pricingVersion: string } | null>,
      // Вторая половина всех «за всё время» чисел — свёрнутые месяцы
      // (этап 118). Окна 1/7/30 дней сюда не входят: они короче срока
      // хранения сырых строк.
      this.rolledTotals(notTest),
      this.rolledTotals({ anonymous: true }),
      this.rolledTotals({ userId: { not: null }, ...notTest }),
      this.rolledTotals({ unpriced: true, ...notTest }),
      // Кандидаты в топ со стороны свёртки — тоже ограниченной выборкой,
      // а не «все пользователи за всю историю»: это ровно тот дефект
      // (Б-1.7), из-за которого сырой топ считают в базе.
      this.rolledTopUsers(topLimit, notTest),
    ]);

    // Prisma-клиент в песочнице не сгенерирован, поэтому тип у groupBy
    // теряется внутри Promise.all — возвращаем его здесь, одной строкой,
    // вместо `any` в пяти местах ниже.
    const perUser = perUserRaw as Array<{
      userId: string;
      _sum: { costMicroUsd: number | null };
      _count: { _all: number };
    }>;

    // Топ пользователей складывается из двух источников (этап 118).
    //
    // Каждая сторона отсортирована и обрезана в базе (иначе это была бы
    // выборка всех пользователей за всю историю — тот самый дефект
    // Б-1.7), поэтому кандидаты берутся из ОБОИХ списков: человек,
    // расход которого почти весь в свёрнутых месяцах, в сыром топе не
    // виден вовсе. Но обрезанный сырой список знает только про своих
    // десятерых — у кандидата со стороны свёртки его сырая половина в
    // нём отсутствует, и без досчёта она просто пропала бы из суммы и
    // из порядка. Поэтому по списку кандидатов делается ещё два точных
    // запроса — оба по идентификаторам, то есть по индексу и с заведомо
    // известным числом строк.
    //
    // Остаётся честная неточность: пользователь, не попавший ни в одну
    // из двух десяток, но суммарно обошедший десятого, в топ не
    // войдёт. Точный ответ стоил бы полного слияния двух таблиц на
    // каждое открытие вкладки; цена ошибки — порядок строк в
    // справочной таблице, а не деньги.
    const candidateIds = [
      ...new Set([
        ...perUser.map((r) => r.userId),
        ...rolledTopCandidates.keys(),
      ]),
    ].filter((id): id is string => Boolean(id));

    const [rawForCandidates, rolledForCandidates] = candidateIds.length
      ? await Promise.all([
          this.rawBucketsForUsers(candidateIds),
          this.rolledBuckets('userId', { userId: { in: candidateIds } }),
        ])
      : [new Map() as Buckets, new Map() as Buckets];

    const topRows = [...mergeBuckets(rawForCandidates, rolledForCandidates)]
      .filter(([userId]) => Boolean(userId))
      .map(([userId, totals]) => ({ userId, ...totals }))
      .sort((a, b) => b.costMicroUsd - a.costMicroUsd)
      .slice(0, topLimit);
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

    // «Плативших» считает база по объединению обеих таблиц: человек,
    // весь расход которого уже свёрнут, из сырых строк не виден вовсе,
    // и среднее на него без этого завышалось бы.
    const payingUsers = payingUsersRow[0]?.count ?? 0;
    const usersTotal = usersTotalMicroUsd + rolledUsers.costMicroUsd;
    // Postgres отдаёт count одной строкой; пустой результат невозможен,
    // но `?? 0` дешевле, чем предположение.
    const sessionsWithCost = distinctSessions[0]?.count ?? 0;

    // Общая сумма и общее число вызовов — из обоих источников.
    const totalAll = mergeTotals(
      { costMicroUsd: totalMicroUsd, calls: totalCalls },
      rolledAll,
    );

    /**
     * Отдельный блок тестовых. Считается только когда такие аккаунты
     * есть: на проекте без них это три лишних запроса на каждое
     * открытие вкладки ради трёх нулей.
     */
    const testUsers = testIds.length
      ? await (async () => {
          const where = { userId: { in: testIds } };
          const [cost, calls, rolled, today] = await Promise.all([
            sum(where),
            this.prisma.aiUsage.count({ where }),
            this.rolledTotals(where),
            sum({ ...where, createdAt: { gte: startOfDayUtc(new Date(now)) } }),
          ]);
          return {
            accounts: testIds.length,
            costMicroUsd: cost + rolled.costMicroUsd,
            calls: calls + rolled.calls,
            spentTodayMicroUsd: today,
          };
        })()
      : { accounts: 0, costMicroUsd: 0, calls: 0, spentTodayMicroUsd: 0 };

    const result: CostReport = {
      // Версия берётся из последней записи, а не из константы: если прайс
      // правили, старые строки посчитаны по старым ставкам, и показывать
      // текущую версию над суммой, собранной из разных, — враньё.
      pricingVersion: pricingRow?.pricingVersion ?? 'нет данных',
      totalMicroUsd: totalAll.costMicroUsd,
      totalCalls: totalAll.calls,
      last24hMicroUsd,
      last7dMicroUsd,
      last30dMicroUsd,
      byProvider,
      byOperation,
      byModel,
      // Вызовы без ставки — тоже из двух источников: ради этого числа
      // `unpriced` и попал в ключ свёртки, иначе оно сползало бы к нулю
      // по мере сворачивания месяцев.
      unpricedCalls: unpricedCalls + rolledUnpriced.calls,
      payingUsers,
      anonymousMicroUsd: anonymousMicroUsd + rolledAnonymous.costMicroUsd,
      avgPerUserMicroUsd: payingUsers
        ? Math.round(usersTotal / payingUsers)
        : 0,
      // Числитель здесь СЫРОЙ, в отличие от остальных «за всё время»
      // чисел (этап 118). `sessionId` в свёртку не входит (идентификатор
      // сессии, которой давно нет), поэтому знаменатель считается только
      // по сырым строкам — и общая сумма, растущая вечно, делённая на
      // число сессий последних месяцев, расходилась бы без предела.
      // Обе половины дроби взяты из одного источника; на экране это
      // подписано как «за последние месяцы».
      avgPerSessionMicroUsd: sessionsWithCost
        ? Math.round(totalMicroUsd / sessionsWithCost)
        : 0,
      sessionsWithCost,
      testUsers,
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
    // Свёрнутые месяцы — вторая половина «за всё время» (этап 118).
    // Забыть её здесь значит показать в карточке заниженный расход, и
    // заметить это можно будет только сверкой с провайдером.
    const rolled = await this.rolledBuckets('userId', {
      userId: { in: userIds },
    });
    for (const [userId, totals] of rolled) {
      if (!userId) continue;
      const existing = out[userId];
      out[userId] = existing ? mergeTotals(existing, totals) : { ...totals };
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
    const raw: Buckets = new Map(
      rows.map((r) => [
        r.operation,
        { costMicroUsd: r._sum.costMicroUsd ?? 0, calls: r._count._all },
      ]),
    );
    const merged = mergeBuckets(
      raw,
      await this.rolledBuckets('operation', { userId }),
    );
    return [...merged]
      .map(([key, totals]) => ({ key, ...totals }))
      .sort((a, b) => b.costMicroUsd - a.costMicroUsd);
  }

  // ── Свёртка журнала (doc/TODO.md §I-Б.5, этап 118) ─────────────────

  /**
   * Сворачивает завершившиеся месяцы старше срока хранения и удаляет их
   * сырые строки.
   *
   * Месяц обрабатывается ЦЕЛИКОМ и в одной транзакции: снести прежнюю
   * свёртку этого месяца → записать новую → удалить сырые строки. Такой
   * порядок делает прогон идемпотентным без уникального индекса
   * (`userId` nullable, а NULL-ы в Postgres различны — индекс не ловил
   * бы повторы), и обрыв в любой точке оставляет месяц либо целиком
   * свёрнутым, либо целиком сырым, но никогда не половинным: половина
   * означала бы потерянные деньги в отчёте.
   *
   * За прогон — не больше `maxMonths` месяцев: первый запуск на
   * накопленном журнале иначе пытался бы съесть годы за один тик
   * serverless-функции.
   */
  async rollupOldMonths(
    opts: { maxMonths?: number; now?: Date } = {},
  ): Promise<{ months: string[]; foldedRows: number; deletedRows: number }> {
    const now = opts.now ?? new Date();
    const maxMonths = opts.maxMonths ?? 3;

    // Какие месяцы вообще есть в сырых строках. `to_char` по индексу
    // `createdAt` — одно сканирование вместо выборки строк в Node.
    // `to_char` по самой колонке, БЕЗ `AT TIME ZONE 'UTC'`: колонка —
    // `timestamp` без зоны и уже хранит UTC, а `AT TIME ZONE 'UTC'`
    // превратил бы её в `timestamptz`, и `to_char` отрисовал бы месяц в
    // ЗОНЕ СЕССИИ базы. На сервере не в UTC ключ месяца разъехался бы с
    // границами `monthStart`/`monthEnd`, по которым потом идёт выборка,
    // — то есть свёртка взялась бы за месяц, которого по её же
    // границам нет.
    const present = (await this.prisma.$queryRaw`
      SELECT DISTINCT to_char("createdAt", 'YYYY-MM') AS month
      FROM "ai_usage"
    `) as Array<{ month: string }>;

    const months = monthsReadyToRoll(
      present.map((r) => r.month),
      now,
    ).slice(0, maxMonths);

    let foldedRows = 0;
    let deletedRows = 0;
    for (const month of months) {
      const result = await this.rollupMonth(month);
      foldedRows += result.folded;
      deletedRows += result.deleted;
    }
    if (months.length > 0) {
      // Кэш отчёта считает «за всё время» — после свёртки источник
      // изменился, и старый ответ стал бы врать до конца TTL.
      this.reportCache = null;
      this.logger.log(
        `свёртка журнала расходов: месяцев ${months.length} (${months.join(', ')}), строк свёртки ${foldedRows}, удалено сырых ${deletedRows}`,
      );
    }
    return { months, foldedRows, deletedRows };
  }

  private async rollupMonth(
    month: string,
  ): Promise<{ folded: number; deleted: number }> {
    const from = monthStart(month);
    const to = monthEnd(month);
    const window = { createdAt: { gte: from, lt: to } };

    // Группирует БАЗА. Тащить месяц журнала в Node ради сложения — это
    // тот же дефект, который уже чинили в отчёте (А-1.1: 25 МБ в куче
    // ради одного числа), только на порядок крупнее: месяц — это
    // миллионы строк, и функция легла бы по памяти ещё до записи.
    // Незакрытый баг типов Prisma `groupBy` (prisma/prisma#17297,
    // #6494) — см. тот же комментарий выше в этом файле.
    const grouped = (await this.prisma.aiUsage.groupBy({
      by: [
        'userId',
        'anonymous',
        'provider',
        'operation',
        'model',
        'unpriced',
      ] as const,
      where: window,
      _sum: { costMicroUsd: true },
      _count: { _all: true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)) as GroupedUsageRow[];

    const buckets = bucketsFromGrouped(month, grouped);

    // Месяц без сырых строк не трогаем ВООБЩЕ. Иначе безобидный на вид
    // повтор (два прогона внахлёст: реестр админки и настоящий крон —
    // у каждого свой список месяцев, снятый до чужой транзакции)
    // снёс бы уже записанную свёртку и записал вместо неё пустоту, а
    // сырых строк, из которых её пересобрать, к тому моменту нет. Это
    // единственный способ потерять здесь деньги безвозвратно.
    if (buckets.length === 0) return { folded: 0, deleted: 0 };

    // `createMany` кусками по 1000: строк свёртки за месяц может быть
    // много (пользователи × операции × модели), а один гигантский
    // INSERT упирается в предел параметров запроса. Куски едут в ТОЙ ЖЕ
    // транзакции, поэтому атомарность «снести → записать → удалить»
    // сохраняется: обрыв оставляет месяц либо целиком свёрнутым, либо
    // целиком сырым.
    const CHUNK = 1000;
    const inserts = [];
    for (let i = 0; i < buckets.length; i += CHUNK) {
      inserts.push(
        this.prisma.aiUsageMonthly.createMany({
          data: buckets.slice(i, i + CHUNK),
        }),
      );
    }

    const results = (await this.prisma.$transaction([
      this.prisma.aiUsageMonthly.deleteMany({ where: { month } }),
      ...inserts,
      this.prisma.aiUsage.deleteMany({ where: window }),
    ])) as Array<{ count: number }>;

    // Удалено — то, что сказала база, а не длина выборки: в лог и в
    // ответ крона должно попасть реальное число.
    const deleted = results[results.length - 1]?.count ?? 0;
    return { folded: buckets.length, deleted };
  }

  /**
   * Сырые суммы по конкретным пользователям — досчёт второй половины
   * для кандидатов в топ (этап 118).
   *
   * Обрезанный в базе сырой топ знает только про своих десятерых:
   * у кандидата, пришедшего со стороны свёртки, его сырая половина там
   * отсутствует, и без этого запроса она пропала бы и из суммы, и из
   * порядка. Запрос по списку идентификаторов — индекс и заведомо
   * известное число строк.
   */
  private async rawBucketsForUsers(userIds: string[]): Promise<Buckets> {
    // Незакрытый баг типов Prisma `groupBy` (prisma/prisma#17297, #6494)
    // — см. тот же комментарий выше в этом файле.
    const rows = (await this.prisma.aiUsage.groupBy({
      by: ['userId'] as const,
      where: { userId: { in: userIds } },
      _sum: { costMicroUsd: true },
      _count: { _all: true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)) as Array<{
      userId: string | null;
      _sum: { costMicroUsd: number | null };
      _count: { _all: number };
    }>;
    const out: Buckets = new Map();
    for (const row of rows) {
      if (!row.userId) continue;
      out.set(row.userId, {
        costMicroUsd: row._sum.costMicroUsd ?? 0,
        calls: row._count._all,
      });
    }
    return out;
  }

  /**
   * Кандидаты в топ со стороны свёртки — отсортированные и обрезанные
   * базой, ровно как сырой топ. Без `orderBy`+`take` это была бы
   * выборка всех пользователей за всю историю — тот самый дефект
   * Б-1.7, из-за которого сырой топ и считают в базе.
   */
  private async rolledTopUsers(
    limit: number,
    exclude: Record<string, unknown> = {},
  ): Promise<Buckets> {
    // Незакрытый баг типов Prisma `groupBy` (prisma/prisma#17297, #6494)
    // — см. тот же комментарий выше в этом файле.
    const rows = (await this.prisma.aiUsageMonthly.groupBy({
      by: ['userId'] as const,
      where: { userId: { not: null }, ...exclude },
      _sum: { costMicroUsd: true, calls: true },
      orderBy: { _sum: { costMicroUsd: 'desc' } },
      take: limit,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)) as Array<{
      userId: string | null;
      _sum: { costMicroUsd: bigint | null; calls: number | null };
    }>;
    const out: Buckets = new Map();
    for (const row of rows) {
      if (!row.userId) continue;
      out.set(row.userId, {
        costMicroUsd: microToNumber(row._sum.costMicroUsd),
        calls: row._sum.calls ?? 0,
      });
    }
    return out;
  }

  /**
   * Идентификаторы тестовых аккаунтов (TODO §III п.37).
   *
   * Список, а не join в каждом запросе: таких аккаунтов единицы, а
   * запросов в отчёте два десятка, и одинаковое условие во всех них
   * проще держать одним значением, чем повторённой связью.
   */
  private async testUserIds(): Promise<string[]> {
    const rows = (await this.prisma.user.findMany({
      where: { isTestUser: true },
      select: { id: true },
    })) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  /**
   * Условие «строка НЕ тестового аккаунта».
   *
   * Анонимные сюда входят. Написать просто `userId: { notIn: ids }`
   * было бы короче и неверно: в SQL `userId NOT IN (...)` для NULL даёт
   * NULL, то есть анонимный расход выпал бы из отчёта целиком — а к
   * тестовым аккаунтам он отношения не имеет.
   */
  private notTestUsers(ids: string[]): Record<string, unknown> {
    if (!ids.length) return {};
    return { OR: [{ userId: null }, { userId: { notIn: ids } }] };
  }

  /** Итоги свёртки — вторая половина любого отчёта «за всё время». */
  private async rolledTotals(
    where: Record<string, unknown> = {},
  ): Promise<Totals> {
    const r = (await this.prisma.aiUsageMonthly.aggregate({
      where,
      _sum: { costMicroUsd: true, calls: true },
    })) as { _sum: { costMicroUsd: bigint | null; calls: number | null } };
    return {
      costMicroUsd: microToNumber(r._sum.costMicroUsd),
      calls: r._sum.calls ?? 0,
    };
  }

  /** Разрез свёртки по одному измерению — вторая половина `bucket()`. */
  private async rolledBuckets(
    field: 'provider' | 'operation' | 'model' | 'userId',
    where: Record<string, unknown> = {},
  ): Promise<Buckets> {
    const rows = (await this.prisma.aiUsageMonthly.groupBy({
      by: [field] as const,
      where,
      _sum: { costMicroUsd: true, calls: true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)) as Array<
      Record<string, string | null> & {
        _sum: { costMicroUsd: bigint | null; calls: number | null };
      }
    >;
    const out: Buckets = new Map();
    for (const row of rows) {
      const key = (row[field] as string | null) ?? '';
      out.set(key, {
        costMicroUsd: microToNumber(row._sum.costMicroUsd),
        calls: row._sum.calls ?? 0,
      });
    }
    return out;
  }
}
