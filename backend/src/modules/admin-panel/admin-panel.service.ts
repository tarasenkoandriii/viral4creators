/**
 * AdminPanelService
 *
 * MVP-объём админки для viral4creators: список/детали сессий + базовая
 * телеметрия. У продукта нет пользователей/модерации контента (в
 * отличие от проекта, из которого перенесён паттерн Telegram-логина —
 * см. doc/TELEGRAM-ADMIN.md) — единственное, чем управляет админка,
 * уже целиком лежит в существующей модели Session, отдельных таблиц
 * под это заводить не пришлось.
 */

import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Session as SessionRow, WorkflowKind } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SessionService } from '../../common/session.service';
import {
  SessionSummaryRow,
  selectSessionSummaries,
  countSessionSummaries,
  SessionSortKey,
  SortDirection,
} from '../../common/session-summary';
import { GenerationStatus } from '../../common/types/generation.types';
import { getEnvSettings, EnvCheckResult } from './env-settings';
import {
  SESSION_COHORT_HORIZON_MS,
  BATCH_COHORT_HORIZON_MS,
  isCohortMatured,
} from '../../common/workflow-funnel-cohort';

/** Сводка из узкой строки (common/session-summary.ts). */
function summaryFromSlim(row: SessionSummaryRow): SessionSummary {
  return {
    sessionId: row.id,
    status: row.status,
    generationStatus: row.generationStatus ?? null,
    createdAt: row.createdAt,
    lastActivityAt: row.lastActivityAt,
    userId: row.userId,
    ownerPlan: row.ownerPlan ?? null,
    ownerUsername: row.ownerUsername ?? null,
    ownerFirstName: row.ownerFirstName ?? null,
    productName: row.productName ?? null,
    hasGeneratedVideo: Boolean(row.downloadUrl),
    downloadUrl: row.downloadUrl ?? null,
    quality: row.quality ?? null,
    provider: row.provider ?? null,
    resolution: row.resolution ?? null,
    voiceMode: row.voiceMode ?? null,
    errorCode: row.errorCode ?? null,
    errorMessage: row.errorMessage ?? null,
    errorRetryable: row.errorRetryable ?? null,
  };
}

export interface SessionSummary {
  sessionId: string;
  status: string;
  /** `Session.generationStatus` (этап 51) — статус самого рендера,
   * отдельно от статуса сессии в целом. */
  generationStatus: string | null;
  createdAt: Date;
  lastActivityAt: Date;
  userId: string | null;
  /** Тариф владельца на момент запроса — `null` у анонимных сессий. */
  ownerPlan: string | null;
  ownerUsername: string | null;
  ownerFirstName: string | null;
  productName: string | null;
  hasGeneratedVideo: boolean;
  downloadUrl: string | null;
  /** 'fast' | 'standard' — качество рендера, ТОЛЬКО у Veo (`provider`
   * не 'grok'). У Grok — `null` не значит «нет данных», см. `resolution`. */
  quality: string | null;
  /** 'veo' | 'grok' | null — `null` исторически значит 'veo' (поле
   * появилось позже, писалось только для Grok — см. GeneratedVideo). */
  provider: string | null;
  /** '480p' | '720p' | '1080p' — своя ось качества у Grok, не пересекается
   * с `quality` (этап 86: колонка «Качество» в админке раньше читала
   * только `quality` и у Grok-роликов — а это, по дефолту фронтенда,
   * почти все — всегда была пустой). */
  resolution: string | null;
  /** 'veo' | 'voiceover' | 'dub' — режим озвучки бренда в снимке сессии. */
  voiceMode: string | null;
  /** Доп. запрос владельца продукта: причина провала — видна прямо в
   * списке, рядом с кнопкой повтора (см. `retryGeneration` ниже). */
  errorCode: string | null;
  errorMessage: string | null;
  /** `null` — рендера/ошибки не было вовсе, отличать от `false`
   * (провал есть, но не повторяемый — например бан контент-фильтром). */
  errorRetryable: boolean | null;
}

export interface SessionListResult {
  items: SessionSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export interface TelemetryResult {
  total: number;
  byStatus: Record<string, number>;
  createdLast24h: number;
  createdLast7d: number;
  failedGenerations: number;
}

export interface EnvSettingsResult {
  checks: EnvCheckResult[];
  /** True if every check passed — lets the UI show one overall verdict, not just per-row. */
  allOk: boolean;
}

/**
 * Воронка движения по воркфлоу (этап 78, doc/WORKFLOW-FUNNEL-SPEC.md,
 * doc/WORKFLOW-FUNNEL-COHORT-CONVERSION-SPEC.md) — окна СКОЛЬЗЯЩИЕ от
 * текущего момента, та же семантика, что уже использует
 * `createdLast24h`/`createdLast7d` в `getTelemetry()`, не календарная.
 */
export type WorkflowWindow = 'hour' | 'day' | 'week' | 'month';

const WORKFLOW_WINDOW_MS: Record<WorkflowWindow, number> = {
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
};

/** Три реальных воркфлоу проекта (§2.1 обоих ТЗ) — общий словарь ключей
 * стадий/подписей/имени в API, переиспользуемый обеими вкладками
 * (событийная воронка и когортная конверсия) экрана «Воронка». */
type WorkflowName = 'session' | 'catalog_batch' | 'ab_test';

interface WorkflowDescriptor {
  workflow: WorkflowName;
  label: string;
  kind: WorkflowKind;
  /** Первая стадия (создание сущности, `fromStage: null`) — не входит в
   * `stages[]` ни событийной воронки (там она есть как обычная стадия
   * пути, см. ниже STAGE_ORDER), ни когортной (там она — `cohortSize`,
   * см. §5 когортного ТЗ). */
  startStage: string;
  /** Терминальная стадия ошибки — исключается из основного пути
   * (`stages[]`), показывается отдельной секцией `failures[]` (§7.2
   * родительского ТЗ). */
  errorStage: string;
  /** Основной путь БЕЗ терминальной ошибки, включая стартовую стадию —
   * используется событийной воронкой как есть; когортная конверсия сама
   * убирает первый элемент (он — `cohortSize`). */
  stageOrder: string[];
  stageLabels: Record<string, string>;
  /** Горизонт зрелости когорты (§3.2 когортного ТЗ) — своя константа на
   * воркфлоу, выведенная из уже существующих дедлайнов пайплайна. */
  horizonMs: number;
}

const WORKFLOW_DESCRIPTORS: WorkflowDescriptor[] = [
  {
    workflow: 'session',
    label: 'Сессия',
    kind: WorkflowKind.SESSION,
    startStage: 'created',
    errorStage: 'error',
    stageOrder: [
      'created',
      'video_uploaded',
      'analyzing',
      'analysis_complete',
      'product_info_added',
      'prompt_generated',
      'generating_video',
      'video_complete',
    ],
    stageLabels: {
      created: 'Создана',
      video_uploaded: 'Видео загружено',
      analyzing: 'Идёт разбор',
      analysis_complete: 'Разбор завершён',
      product_info_added: 'Данные о товаре добавлены',
      prompt_generated: 'Промпт сгенерирован',
      generating_video: 'Генерация видео',
      video_complete: 'Видео готово',
      error: 'Ошибка',
    },
    horizonMs: SESSION_COHORT_HORIZON_MS,
  },
  {
    workflow: 'catalog_batch',
    label: 'Пакетная генерация',
    kind: WorkflowKind.CATALOG_BATCH_ITEM,
    startStage: 'PENDING',
    errorStage: 'FAILED',
    stageOrder: ['PENDING', 'GENERATING', 'DONE'],
    stageLabels: {
      PENDING: 'В очереди',
      GENERATING: 'Генерируется',
      DONE: 'Готово',
      FAILED: 'Ошибка',
    },
    horizonMs: BATCH_COHORT_HORIZON_MS,
  },
  {
    workflow: 'ab_test',
    label: 'A/B-варианты',
    kind: WorkflowKind.AB_TEST_VARIANT,
    startStage: 'PENDING',
    errorStage: 'FAILED',
    stageOrder: ['PENDING', 'GENERATING', 'DONE'],
    stageLabels: {
      PENDING: 'В очереди',
      GENERATING: 'Генерируется',
      DONE: 'Готово',
      FAILED: 'Ошибка',
    },
    horizonMs: BATCH_COHORT_HORIZON_MS,
  },
];

export interface WorkflowFunnelStage {
  key: string;
  label: string;
  count: number;
  uniqueUsers: number | null;
}

/** Решение §7.2 родительского ТЗ: терминальная ошибка разбита по
 * стадии, с которой сорвалась сущность (`fromStage` события), а не
 * общим числом. */
export interface WorkflowFunnelFailureBreakdown {
  fromStage: string;
  fromLabel: string;
  count: number;
  uniqueUsers: number;
}

export interface WorkflowFunnelBlock {
  workflow: WorkflowName;
  label: string;
  /** Основной путь, БЕЗ терминальной ошибки. */
  stages: WorkflowFunnelStage[];
  /** Отсортировано по count desc (§6.3). */
  failures: WorkflowFunnelFailureBreakdown[];
  /** Сумма count по failures — для заголовка боковой секции. */
  totalFailed: number;
}

export interface WorkflowFunnelResult {
  window: WorkflowWindow;
  from: string;
  to: string;
  /** Ровно 3, в порядке §2.1 (session, catalog_batch, ab_test). */
  blocks: WorkflowFunnelBlock[];
}

export interface CohortConversionStage {
  key: string;
  label: string;
  /** Нарастающим итогом, ≤ cohortSize. */
  reached: number;
  /** 0..1. */
  pctOfCohort: number;
  /** Обычно 0..1, но может быть > 1.0 при обходе стадий (переход в
   * ANALYSIS_COMPLETE минуя ANALYZING через `LibraryService`, §4.1
   * когортного ТЗ) — намеренно НЕ клампится. `null` для самой первой
   * стадии после старта когорты (нет предыдущей) и когда предыдущая
   * стадия ни разу не была достигнута (деление на ноль не выражается
   * процентом). */
  pctOfPrevious: number | null;
  /** `null`, если `reached === 0`. */
  avgDurationFromStartMs: number | null;
}

export interface CohortConversionBlock {
  workflow: WorkflowName;
  label: string;
  /** Сущностей, попавших в когорту (= первая стадия, pctOfCohort всегда 1). */
  cohortSize: number;
  /** БЕЗ стартовой стадии — она вынесена в cohortSize. */
  stages: CohortConversionStage[];
  /** false = «когорта ещё не завершена», см. §3.2 когортного ТЗ. */
  matured: boolean;
  /** ISO — когда станет matured (= to + HORIZON, from-агностично). */
  maturesAt: string;
}

export interface WorkflowCohortConversionResult {
  window: WorkflowWindow;
  from: string;
  to: string;
  blocks: CohortConversionBlock[];
}

@Injectable()
export class AdminPanelService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionService: SessionService,
  ) {}

  /** Единственный флаг доступа для MVP-админки — НЕ self-service,
   * выставляется вручную в БД (см. doc/TELEGRAM-ADMIN.md). Аутентификация
   * (AdminSessionGuard) сама по себе не требует isOperator — вход и
   * доступ к данным проверяются раздельно, честное 403, а не ошибка
   * входа. */
  async assertOperator(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isOperator: true },
    });
    if (!user?.isOperator) {
      throw new ForbiddenException('Operator access required');
    }
  }

  async listSessions(opts: {
    status?: string;
    quality?: string;
    voiceMode?: string;
    plan?: string;
    createdFrom?: Date;
    createdTo?: Date;
    search?: string;
    sortBy: SessionSortKey;
    sortDir: SortDirection;
    page: number;
    pageSize: number;
  }): Promise<SessionListResult> {
    const filter = {
      status: opts.status,
      quality: opts.quality,
      voiceMode: opts.voiceMode,
      plan: opts.plan,
      createdFrom: opts.createdFrom,
      createdTo: opts.createdTo,
      search: opts.search,
    };
    const [rows, total] = await Promise.all([
      // Этап 51 (В-4.4): без колонки `data` — см. common/session-summary.ts.
      selectSessionSummaries(this.prisma, {
        ...filter,
        sortBy: opts.sortBy,
        sortDir: opts.sortDir,
        skip: (opts.page - 1) * opts.pageSize,
        take: opts.pageSize,
      }),
      // Тот же фильтр, что у выборки (не отдельный ORM `where`) — иначе
      // счётчик и список могут разойтись при первом же новом фильтре,
      // который забудут добавить в оба места.
      countSessionSummaries(this.prisma, filter),
    ]);

    return {
      items: rows.map((row: SessionSummaryRow) => summaryFromSlim(row)),
      total,
      page: opts.page,
      pageSize: opts.pageSize,
    };
  }

  /**
   * `deletedAt: null` (этап 89) — мягко удалённая сессия не видна и
   * оператору: тот же приём, что `SessionService.getSession` для её
   * владельца, только `findFirst` вместо `findUnique` — второе поле в
   * `where` рядом с `id`.
   */
  async getSession(id: string): Promise<SessionSummary & { data: unknown }> {
    const row = await this.prisma.session.findFirst({
      where: { id, deletedAt: null },
    });
    if (!row) {
      throw new NotFoundException(`Session ${id} not found`);
    }
    return { ...this.toSummary(row), data: row.data };
  }

  /**
   * Удаление сессии оператором — софт-delete (этап 89).
   *
   * До этой правки — отдельная от пользовательской реализация (Б-5.9,
   * этап 88.2): собрать пути файлов → удалить строку → удалить файлы,
   * синхронно в этом запросе. Явный запрос владельца продукта на этапе
   * 89 — «тот же механизм в админке для сессий» — закрыл это удвоение:
   * оператор зовёт тот же `SessionService.softDeleteSession`, что и
   * пользовательский `DELETE /sessions/:id`. Строка получает `deletedAt`
   * и перестаёт быть видна (`getSession`/`listSessions` выше), а
   * физическую уборку строки и файлов в Blob уносит
   * `purgeSoftDeletedSessions()` из крона спустя `SOFT_DELETE_GRACE_MS`.
   */
  async deleteSession(id: string): Promise<{ ok: true }> {
    const { deleted } = await this.sessionService.softDeleteSession(id);
    if (!deleted) throw new NotFoundException(`Session ${id} not found`);
    return { ok: true };
  }

  async getTelemetry(): Promise<TelemetryResult> {
    const now = new Date();
    const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const since7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [
      total,
      byStatusRaw,
      createdLast24h,
      createdLast7d,
      failedGenerations,
    ] = await Promise.all([
      this.prisma.session.count(),
      this.prisma.session.groupBy({
        by: ['status'] as const,
        _count: { _all: true },
      }),
      this.prisma.session.count({ where: { createdAt: { gte: since24h } } }),
      this.prisma.session.count({ where: { createdAt: { gte: since7d } } }),
      // Этап 51 (В-4.1): статус рендера — колонка с индексом, а не путь в
      // JSON. Фильтр по пути распаковывал `data` у каждой строки: 39 мс и
      // 86 МБ буферов на штатных 3 500 сессиях, 2,6 с на 300 тысячах.
      this.prisma.session.count({
        where: { generationStatus: GenerationStatus.FAILED },
      }),
    ]);

    const byStatus: Record<string, number> = {};
    for (const row of byStatusRaw as Array<{
      status: string;
      _count: { _all: number };
    }>) {
      byStatus[row.status] = row._count._all;
    }

    return {
      total,
      byStatus,
      createdLast24h,
      createdLast7d,
      failedGenerations,
    };
  }

  /** Читает `process.env` живьём при каждом запросе (не кэшируется) —
   * так вкладка «Настройки» в админке сразу отражает правку .env после
   * рестарта процесса, без отдельного эндпоинта "reload config". */
  getEnvSettings(): EnvSettingsResult {
    const checks = getEnvSettings(process.env);
    return { checks, allOk: checks.every((c) => c.ok) };
  }

  /**
   * Событийная воронка (этап 78, doc/WORKFLOW-FUNNEL-SPEC.md §5) — на
   * каждой стадии считается число РАЗНЫХ сущностей с хотя бы одним
   * событием (workflow, stage) внутри скользящего окна (§3.3 документа).
   * Три отдельных запроса, не один обобщённый — тот же почерк, что у
   * остальных экранов `AdminPanelService` (§3 п.6 документа): у трёх
   * воркфлоу разные таблицы-владельцы для JOIN'а уникальных пользователей.
   */
  async getWorkflowFunnel(
    window: WorkflowWindow,
  ): Promise<WorkflowFunnelResult> {
    const to = new Date();
    const from = new Date(to.getTime() - WORKFLOW_WINDOW_MS[window]);

    const blocks = await Promise.all(
      WORKFLOW_DESCRIPTORS.map((d) => this.getFunnelBlock(d, from, to)),
    );

    return { window, from: from.toISOString(), to: to.toISOString(), blocks };
  }

  private async getFunnelBlock(
    descriptor: WorkflowDescriptor,
    from: Date,
    to: Date,
  ): Promise<WorkflowFunnelBlock> {
    type StageRow = { stage: string; count: number; uniqueUsers: number };
    type FailureRow = {
      fromStage: string | null;
      count: number;
      uniqueUsers: number;
    };

    // Владелец (для «уникальных пользователей», §4 документа) — три
    // разных пути JOIN'а, ни одного общего: сессия хранит userId прямо
    // на себе, партия/A-B — на родительском Run. LEFT JOIN, не INNER —
    // событие исторически «случилось» даже если сама сущность/владелец
    // с тех пор удалены (Б-5.9 и т.п.) — теряется только разбивка по
    // пользователю, не сам факт события.
    let stageRows: StageRow[];
    let failureRows: FailureRow[];
    if (descriptor.kind === WorkflowKind.SESSION) {
      stageRows = await this.prisma.$queryRaw<StageRow[]>`
        SELECT e.stage AS stage,
               COUNT(DISTINCT e."entityId")::int AS count,
               COUNT(DISTINCT s."userId")::int AS "uniqueUsers"
        FROM "workflow_stage_events" e
        LEFT JOIN "sessions" s ON s.id = e."entityId"
        WHERE e.workflow = 'SESSION'
          AND e."occurredAt" >= ${from}
          AND e."occurredAt" < ${to}
          AND e.stage <> ${descriptor.errorStage}
        GROUP BY e.stage
      `;
      failureRows = await this.prisma.$queryRaw<FailureRow[]>`
        SELECT e."fromStage" AS "fromStage",
               COUNT(DISTINCT e."entityId")::int AS count,
               COUNT(DISTINCT s."userId")::int AS "uniqueUsers"
        FROM "workflow_stage_events" e
        LEFT JOIN "sessions" s ON s.id = e."entityId"
        WHERE e.workflow = 'SESSION'
          AND e."occurredAt" >= ${from}
          AND e."occurredAt" < ${to}
          AND e.stage = ${descriptor.errorStage}
        GROUP BY e."fromStage"
        ORDER BY count DESC
      `;
    } else if (descriptor.kind === WorkflowKind.CATALOG_BATCH_ITEM) {
      stageRows = await this.prisma.$queryRaw<StageRow[]>`
        SELECT e.stage AS stage,
               COUNT(DISTINCT e."entityId")::int AS count,
               COUNT(DISTINCT r."userId")::int AS "uniqueUsers"
        FROM "workflow_stage_events" e
        LEFT JOIN "catalog_batch_items" i ON i.id = e."entityId"
        LEFT JOIN "catalog_batch_runs" r ON r.id = i."batchId"
        WHERE e.workflow = 'CATALOG_BATCH_ITEM'
          AND e."occurredAt" >= ${from}
          AND e."occurredAt" < ${to}
          AND e.stage <> ${descriptor.errorStage}
        GROUP BY e.stage
      `;
      failureRows = await this.prisma.$queryRaw<FailureRow[]>`
        SELECT e."fromStage" AS "fromStage",
               COUNT(DISTINCT e."entityId")::int AS count,
               COUNT(DISTINCT r."userId")::int AS "uniqueUsers"
        FROM "workflow_stage_events" e
        LEFT JOIN "catalog_batch_items" i ON i.id = e."entityId"
        LEFT JOIN "catalog_batch_runs" r ON r.id = i."batchId"
        WHERE e.workflow = 'CATALOG_BATCH_ITEM'
          AND e."occurredAt" >= ${from}
          AND e."occurredAt" < ${to}
          AND e.stage = ${descriptor.errorStage}
        GROUP BY e."fromStage"
        ORDER BY count DESC
      `;
    } else {
      stageRows = await this.prisma.$queryRaw<StageRow[]>`
        SELECT e.stage AS stage,
               COUNT(DISTINCT e."entityId")::int AS count,
               COUNT(DISTINCT r."userId")::int AS "uniqueUsers"
        FROM "workflow_stage_events" e
        LEFT JOIN "ab_test_variants" v ON v.id = e."entityId"
        LEFT JOIN "ab_test_runs" r ON r.id = v."runId"
        WHERE e.workflow = 'AB_TEST_VARIANT'
          AND e."occurredAt" >= ${from}
          AND e."occurredAt" < ${to}
          AND e.stage <> ${descriptor.errorStage}
        GROUP BY e.stage
      `;
      failureRows = await this.prisma.$queryRaw<FailureRow[]>`
        SELECT e."fromStage" AS "fromStage",
               COUNT(DISTINCT e."entityId")::int AS count,
               COUNT(DISTINCT r."userId")::int AS "uniqueUsers"
        FROM "workflow_stage_events" e
        LEFT JOIN "ab_test_variants" v ON v.id = e."entityId"
        LEFT JOIN "ab_test_runs" r ON r.id = v."runId"
        WHERE e.workflow = 'AB_TEST_VARIANT'
          AND e."occurredAt" >= ${from}
          AND e."occurredAt" < ${to}
          AND e.stage = ${descriptor.errorStage}
        GROUP BY e."fromStage"
        ORDER BY count DESC
      `;
    }

    const byKey = new Map(stageRows.map((r) => [r.stage, r]));
    const stages: WorkflowFunnelStage[] = descriptor.stageOrder.map((key) => {
      const row = byKey.get(key);
      return {
        key,
        label: descriptor.stageLabels[key],
        count: row ? Number(row.count) : 0,
        uniqueUsers: row ? Number(row.uniqueUsers) : 0,
      };
    });

    const failures: WorkflowFunnelFailureBreakdown[] = failureRows
      // `fromStage` пуст только у самого первого события сущности —
      // терминальная ошибка им быть не может (§3.1 документа), но
      // защищаемся от неожиданных данных, а не падаем.
      .filter(
        (r): r is FailureRow & { fromStage: string } => r.fromStage !== null,
      )
      .map((r) => ({
        fromStage: r.fromStage,
        fromLabel: descriptor.stageLabels[r.fromStage] ?? r.fromStage,
        count: Number(r.count),
        uniqueUsers: Number(r.uniqueUsers),
      }));
    const totalFailed = failures.reduce((sum, f) => sum + f.count, 0);

    return {
      workflow: descriptor.workflow,
      label: descriptor.label,
      stages,
      failures,
      totalFailed,
    };
  }

  /**
   * Когортная конверсия (этап 78, doc/WORKFLOW-FUNNEL-COHORT-
   * CONVERSION-SPEC.md §5) — переиспользует ту же таблицу
   * `WorkflowStageEvent` без изменений схемы (§2.1 документа), считает
   * ДРУГОЙ вопрос, чем `getWorkflowFunnel`: не «что произошло за окно»,
   * а «что случилось с теми, кто СТАРТОВАЛ в этом окне», без ограничения
   * по времени самого перехода (§3.1 документа).
   */
  async getWorkflowCohortConversion(
    window: WorkflowWindow,
  ): Promise<WorkflowCohortConversionResult> {
    const to = new Date();
    const from = new Date(to.getTime() - WORKFLOW_WINDOW_MS[window]);

    const blocks = await Promise.all(
      WORKFLOW_DESCRIPTORS.map((d) => this.getCohortBlock(d, from, to)),
    );

    return { window, from: from.toISOString(), to: to.toISOString(), blocks };
  }

  private async getCohortBlock(
    descriptor: WorkflowDescriptor,
    from: Date,
    to: Date,
  ): Promise<CohortConversionBlock> {
    const cohortSizeRows = await this.prisma.$queryRaw<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM "workflow_stage_events"
      WHERE workflow = ${descriptor.kind}::"WorkflowKind"
        AND "fromStage" IS NULL
        AND "occurredAt" >= ${from}
        AND "occurredAt" < ${to}
    `;
    const cohortSize = Number(cohortSizeRows[0]?.count ?? 0);

    type StageRow = {
      stage: string;
      reached: number;
      avgDurationMs: number | null;
    };
    // Пустая когорта — сразу пустой результат, без лишнего запроса
    // (когорта «за последний час» в ночное время часто пуста).
    const stageRows: StageRow[] =
      cohortSize === 0
        ? []
        : await this.prisma.$queryRaw<StageRow[]>`
            WITH cohort AS (
              SELECT "entityId", "occurredAt" AS "cohortStart"
              FROM "workflow_stage_events"
              WHERE workflow = ${descriptor.kind}::"WorkflowKind"
                AND "fromStage" IS NULL
                AND "occurredAt" >= ${from}
                AND "occurredAt" < ${to}
            )
            SELECT e.stage AS stage,
                   COUNT(DISTINCT e."entityId")::int AS reached,
                   AVG(EXTRACT(EPOCH FROM (e."occurredAt" - c."cohortStart")) * 1000)::float8 AS "avgDurationMs"
            FROM "workflow_stage_events" e
            JOIN cohort c ON c."entityId" = e."entityId"
            WHERE e.workflow = ${descriptor.kind}::"WorkflowKind"
              AND e.stage <> ${descriptor.startStage}
              AND e.stage <> ${descriptor.errorStage}
            GROUP BY e.stage
          `;

    const byKey = new Map(stageRows.map((r) => [r.stage, r]));
    // stageOrder включает стартовую стадию первым элементом (переиспользуется
    // событийной воронкой как есть) — здесь пропускаем её (slice(1)):
    // она представлена как cohortSize, а не элемент stages[] (§5 документа).
    let previousReached: number | null = null;
    const stages: CohortConversionStage[] = descriptor.stageOrder
      .slice(1)
      .map((key) => {
        const row = byKey.get(key);
        const reached = row ? Number(row.reached) : 0;
        const pctOfCohort = cohortSize > 0 ? reached / cohortSize : 0;
        // null для первой стадии после старта (нет предыдущей, §4.2) и
        // когда предыдущая стадия ни разу не достигнута — деление на 0
        // не выражается процентом, а не бесконечностью.
        const pctOfPrevious =
          previousReached === null || previousReached === 0
            ? null
            : reached / previousReached;
        const avgDurationFromStartMs =
          reached > 0 && row?.avgDurationMs != null
            ? Number(row.avgDurationMs)
            : null;
        previousReached = reached;
        return {
          key,
          label: descriptor.stageLabels[key],
          reached,
          pctOfCohort,
          pctOfPrevious,
          avgDurationFromStartMs,
        };
      });

    const maturesAt = new Date(to.getTime() + descriptor.horizonMs);

    return {
      workflow: descriptor.workflow,
      label: descriptor.label,
      cohortSize,
      stages,
      matured: isCohortMatured(to, descriptor.horizonMs),
      maturesAt: maturesAt.toISOString(),
    };
  }

  private toSummary(row: SessionRow): SessionSummary {
    return summaryFromSlim({
      id: row.id,
      status: row.status,
      generationStatus: row.generationStatus,
      createdAt: row.createdAt,
      lastActivityAt: row.lastActivityAt,
      userId: row.userId,
      // Однострочная деталь сессии не джойнит `users` (см.
      // session-summary.ts — джойн существует ради списка): у оператора
      // здесь и так есть `userId` и `data` целиком, если понадобится тариф.
      ownerPlan: null,
      ownerUsername: null,
      ownerFirstName: null,
      productName:
        (
          (row.data as Record<string, unknown>)?.productInformation as
            | { productName?: string }
            | undefined
        )?.productName ?? null,
      downloadUrl:
        (
          (row.data as Record<string, unknown>)?.generatedVideo as
            | { downloadUrl?: string }
            | undefined
        )?.downloadUrl ?? null,
      quality:
        (
          (row.data as Record<string, unknown>)?.generatedVideo as
            | { quality?: string }
            | undefined
        )?.quality ?? null,
      provider:
        (
          (row.data as Record<string, unknown>)?.generatedVideo as
            | { provider?: string }
            | undefined
        )?.provider ?? null,
      resolution:
        (
          (row.data as Record<string, unknown>)?.generatedVideo as
            | { resolution?: string }
            | undefined
        )?.resolution ?? null,
      voiceMode:
        (
          (row.data as Record<string, unknown>)?.brandManifestSnapshot as
            | { voiceMode?: string }
            | undefined
        )?.voiceMode ?? null,
      errorCode:
        (
          (row.data as Record<string, unknown>)?.generatedVideo as
            | { error?: { code?: string } }
            | undefined
        )?.error?.code ?? null,
      errorMessage:
        (
          (row.data as Record<string, unknown>)?.generatedVideo as
            | { error?: { message?: string } }
            | undefined
        )?.error?.message ?? null,
      errorRetryable:
        (
          (row.data as Record<string, unknown>)?.generatedVideo as
            | { error?: { retryable?: boolean } }
            | undefined
        )?.error?.retryable ?? null,
    });
  }
}
