/**
 * AdminCronService — реестр крон-задач + ручной запуск из
 * админки с записью истории (этап 69, доп. ТЗ «Кроны в админке»,
 * аналогично Solar Shop). Инжектит `CronJobsService` напрямую (тот же
 * модуль `CronModule` — без кросс-модульного импорта, см.
 * doc/PRODUCT-PROJECT-SPEC.md §69 про то, почему не через
 * `AdminPanelModule`).
 *
 * Семантика debug решена отдельно по каждому из десяти джобов (решение
 * владельца продукта через AskUserQuestion — их результаты уже
 * компактные объекты счётчиков, а не массивы по каждому элементу, как у
 * Solar Shop):
 * - `sweep-orphans` — ЕДИНСТВЕННЫЙ, где debug меняет ПОВЕДЕНИЕ: он
 *   маппится на `dryRun: true` (удаление файлов из Blob безвозвратно —
 *   единственная из десяти операций, где случайный клик реально
 *   необратим).
 * - Остальные девять — debug влияет только на то, отдаётся ли клиенту
 *   `debugLog` (сырой JSON результата); поведение самого запуска не
 *   меняется.
 */

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JOB_LOCK_MS } from '../../common/cron-job-lock';
import { CronJobsService, VERCEL_CRON_TRIGGERED_BY } from './cron-jobs.service';
import { buildRunSummary } from './cron-run-summary';
import {
  CronHistoryQuery,
  CronSummaryQuery,
  HISTORY_DEFAULT_LIMIT,
  HISTORY_MAX_LIMIT,
} from './cron-history-query';
import {
  ceilToMinute,
  countExpectedRuns,
  loadVercelSchedules,
  parseCronExpression,
} from './cron-schedule';
import { CRON_LOG_RETENTION_DAYS } from './cron-retention';

export interface CronJobInfo {
  jobKey: string;
  description: string;
}

export type CronRunStatusValue = 'RUNNING' | 'SUCCESS' | 'FAILED';

export interface CronRunLogRow {
  id: string;
  jobKey: string;
  triggeredBy: string;
  debugMode: boolean;
  status: CronRunStatusValue;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  summary: string | null;
  debugLog: unknown;
  errorMessage: string | null;
}

/** Сколько последних неуспешных прогонов на джоб отдаёт сводка. */
export const SUMMARY_RECENT_FAILURES = 5;

/**
 * Запас на «тик ещё не записан»: Vercel стартует функцию не ровно в
 * минуту расписания, и строка `CronRunLog` появляется спустя секунды
 * после тика. Без запаса сводка «за сегодня» сразу после тика
 * показывала ложное `missed: 1`. Последние три минуты не ожидаются.
 */
export const SUMMARY_EXPECTED_GRACE_MS = 3 * 60_000;

export interface CronFailureRow {
  id: string;
  startedAt: Date;
  triggeredBy: string;
  durationMs: number | null;
  summary: string | null;
  errorMessage: string | null;
}

export interface CronJobSummary {
  jobKey: string;
  /** Cron-выражение из vercel.json; null — у джоба нет расписания. */
  schedule: string | null;
  /** Сколько раз джоб должен был стартовать по расписанию в
   * `[since, min(until, now))`; null — расписание неизвестно/не разобрано. */
  expected: number | null;
  /** Прогоны от Vercel Cron (`triggeredBy = 'vercel-cron'`) за весь период. */
  scheduledRuns: number;
  /** Они же, но только в окне ожидания `[expectedSince, expectedUntil)` —
   * именно с ними сравнивается `expected`. */
  scheduledRunsInWindow: number;
  /** Ручные запуски оператором из админки. */
  manualRuns: number;
  /** max(0, expected − scheduledRunsInWindow); null — если expected неизвестно. */
  missed: number | null;
  total: number;
  byStatus: Record<CronRunStatusValue, number>;
  medianDurationMs: number | null;
  maxDurationMs: number | null;
  /** RUNNING-строки, начатые раньше, чем `now − JOB_LOCK_MS`: замок
   * джоба уже истёк, а прогон так и не записал итог — зависший/убитый. */
  stuckRunning: number;
  stuck: boolean;
  recentFailures: CronFailureRow[];
}

export interface CronSummary {
  since: Date;
  until: Date;
  /**
   * Окно подсчёта `expected` и `scheduledRunsInWindow`:
   * `[max(since, now − срок хранения), min(until, now − запас))`, обе
   * границы округлены вверх до минуты. Старше срока хранения строки уже
   * удалены уборкой — ожидать их значило бы рисовать ложные пропуски;
   * последние минуты — см. `SUMMARY_EXPECTED_GRACE_MS`.
   * Округление до минуты: тик по расписанию всегда на целой минуте, а
   * строка стартует с задержкой в секунды — считать строки в
   * `[ceil(S), ceil(U))` = относить строку к минуте её тика (при
   * задержке старта меньше минуты).
   */
  expectedSince: Date;
  expectedUntil: Date;
  expectedGraceMs: number;
  retentionDays: number;
  lockMs: number;
  /** false — vercel.json не найден, `expected` у всех null. */
  schedulesLoaded: boolean;
  jobs: CronJobSummary[];
}

/**
 * Реестр — те же двенадцать маршрутов `/api/cron/*`, тексты описаний
 * переиспользуют формулировки из доккомментариев `cron.controller.ts`
 * (не выдумываются заново).
 */
const JOB_REGISTRY: CronJobInfo[] = [
  {
    jobKey: 'api-video',
    description:
      'Заявки внешнего API на ролик: сессия от товара, разбор из библиотеки, промпт и генерация — тот же путь, что проходит человек в мастере.',
  },
  {
    jobKey: 'balances-watch',
    description:
      'Сторож остатков у провайдеров: порог и «остаток не читается» — в канал ошибок. Раз в сутки: порог отвечает на «когда пополнять», а не «всё ли ещё работает».',
  },
  {
    jobKey: 'report',
    description:
      'Суточный (и по понедельникам недельный) отчёт в канал статистики.',
  },
  {
    jobKey: 'blog',
    description:
      'Генерация черновиков блога из YouTube-трендов + очередь перевода xAI Grok Batch API.',
  },
  {
    jobKey: 'publish',
    description: 'Выгрузка одобренных заявок в YouTube/TikTok.',
  },
  {
    jobKey: 'billing-renew',
    description: 'Продление подписок с истёкшим оплаченным периодом.',
  },
  {
    jobKey: 'marketing-broadcast',
    description:
      'Сборка и доставка подборки удачных роликов подписчикам рекламного канала.',
  },
  {
    jobKey: 'catalog-batch-run',
    description: 'Обработка партии пакетной генерации по каталогу товаров.',
  },
  {
    jobKey: 'ab-test-run',
    description: 'Обработка A/B-вариантов одного ролика.',
  },
  {
    jobKey: 'feed-import-run',
    description:
      'Импорт товарного фида по ссылке (YML/CSV) — скачивание и заведение позиций.',
  },
  {
    jobKey: 'auction-close',
    description:
      'Закрытие аукционных лотов по дедлайну (ТЗ на маркетплейс §22) — WON/EXPIRED и продвижение очереди на освободившееся место.',
  },
  {
    jobKey: 'auction-assess',
    description:
      'ИИ-оценка видео/брендбука одной заявки на аукцион (ТЗ на маркетплейс §22, Этап 3) — платный вызов Gemini, одна заявка за тик.',
  },
  {
    jobKey: 'auction-google-ads-sync',
    description:
      'Подстраховка паузы Google Ads-кампаний блиц-лотов (аудит-фикс, §22) — повтор для лотов, ушедших из ACTIVE без подтверждённой паузы.',
  },
  {
    jobKey: 'portfolio-watermark',
    description:
      'Водяной знак на превью портфолио/аукциона (ТЗ на маркетплейс §9/§22, защита от пиратства) — одно действие (отправка/опрос ffmpeg) за тик.',
  },
  {
    jobKey: 'live-auction-tick',
    description:
      'Авто-сворачивание живых трансляций аукциона без ставок за 15 минут (ТЗ на живой аукцион §7.5, Этап 5) — сам аукцион продолжается, сворачивается только эфир.',
  },
  {
    jobKey: 'export-sync-run',
    description:
      'Досмотр статуса дочерних рендеров автоэкспорта яруса B независимо от открытого экрана прогресса.',
  },
  {
    jobKey: 'tutorial-scenario-generate',
    description:
      'Генерация сценариев для будущей автозаписи обучающих видео (ИИ по шагам обучалки), с прикидкой стоимости.',
  },
  {
    jobKey: 'tutorial-scenario-run',
    description:
      'Исполнение уже сгенерированных (и, если платных, одобренных) сценариев headless-браузером против фикстурного пользователя — регрессионный прогон экранов мастера.',
  },
  {
    jobKey: 'tutorial-assembly-poll',
    description:
      'Опрос только сборок слайд-шоу обучалки (без браузера и без платных вызовов) — чтобы ссылка на готовый ролик появлялась у человека через минуты, а не в следующий суточный прогон сценариев.',
  },
  {
    jobKey: 'ui-snapshot-run',
    description:
      'Крон-обход интерфейса TMA (5 маршрутов, ru/light) headless-браузером против фикстурного пользователя — скриншот, перцептивный хэш, сравнение с предыдущим снимком того же маршрута, тревога при расхождении.',
  },
  {
    jobKey: 'cleanup-sessions',
    description:
      'Уборка истёкших сессий (и их файлов), admin/user-сессий, невостребованной библиотеки, а также ' +
      'мягко удалённых Project/ProductItem/Session (этап 89) старше грейс-периода.',
  },
  {
    jobKey: 'ai-usage-rollup',
    description:
      'Свёртка журнала расходов: месяцы старше 90 дней схлопываются в агрегаты по провайдеру/операции/модели/пользователю, ' +
      'сырые строки удаляются. Отчёты «за всё время» после этого собираются из двух источников — свёртки и свежих строк.',
  },
  {
    jobKey: 'voice-uploads-sweep',
    description:
      'Удаление необработанных голосовых записей (реплики мастера поздравления и брифа, диктовка описания товара) ' +
      'старше часа — файл и строка учёта. Каждые 15 минут: Условия обещают, что звук не хранится.',
  },
  {
    jobKey: 'persona-sources-purge',
    description:
      '«Я в кадре»: удаление селфи и ролика живости через 30 дней после последнего образа персоны (В-3) ' +
      'и файлов незавершённых попыток старше суток. Раз в сутки.',
  },
  {
    jobKey: 'sweep-orphans',
    description:
      'Метла по осиротевшим файлам хранилища (sessions/projects/brand-manifests/publications). ' +
      'Debug здесь = dryRun: ничего не удаляет, только показывает, что было бы удалено.',
  },
];

@Injectable()
export class AdminCronService {
  private readonly logger = new Logger(AdminCronService.name);

  constructor(
    private readonly jobs: CronJobsService,
    private readonly prisma: PrismaService,
  ) {}

  getRegistry(): CronJobInfo[] {
    return JOB_REGISTRY;
  }

  /**
   * Без `jobKey` — последние прогоны по всем джобам вперемешку (клиент
   * сам берёт последний на каждый jobKey — тот же приём, что
   * `lastRunFor()` у Solar Shop); с `jobKey` — история одного джоба.
   *
   * Период `[since, until)`, `limit` (потолок `HISTORY_MAX_LIMIT`) и
   * курсор `before` = id последней строки предыдущей страницы: порядок
   * `startedAt desc, id desc` — стабильный и при одинаковом startedAt.
   * Страница неполная (< limit) — дальше строк нет.
   */
  async getHistory(
    query: Partial<CronHistoryQuery> = {},
  ): Promise<CronRunLogRow[]> {
    const limit = Math.min(
      Math.max(1, query.limit ?? HISTORY_DEFAULT_LIMIT),
      HISTORY_MAX_LIMIT,
    );
    const where: Record<string, unknown> = {};
    if (query.jobKey) where.jobKey = query.jobKey;
    if (query.since || query.until) {
      where.startedAt = {
        ...(query.since ? { gte: query.since } : {}),
        ...(query.until ? { lt: query.until } : {}),
      };
    }
    const rows = await this.prisma.cronRunLog.findMany({
      where,
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: limit,
      ...(query.before ? { cursor: { id: query.before }, skip: 1 } : {}),
    });
    return rows as CronRunLogRow[];
  }

  /**
   * Агрегат за период по каждому jobKey — «проверить сутки целиком»
   * одним запросом, а не листая историю по 50 строк. Все подсчёты — на
   * стороне БД (groupBy + percentile_cont): у двухминутных джобов за
   * сутки ~720 строк на КАЖДЫЙ, тащить их в процесс ради счётчиков
   * незачем. Опирается на индекс `(jobKey, startedAt)` и `(startedAt)`.
   */
  async getSummary(
    query: CronSummaryQuery,
    now: Date = new Date(),
  ): Promise<CronSummary> {
    const { since, until } = query;
    const range = { gte: since, lt: until };
    const stuckBefore = new Date(
      Math.min(until.getTime(), now.getTime() - JOB_LOCK_MS),
    );

    const retentionStart = new Date(
      now.getTime() - CRON_LOG_RETENTION_DAYS * 86_400_000,
    );
    const expectedSince = ceilToMinute(
      new Date(Math.max(since.getTime(), retentionStart.getTime())),
    );
    const expectedUntil = ceilToMinute(
      new Date(
        Math.min(until.getTime(), now.getTime() - SUMMARY_EXPECTED_GRACE_MS),
      ),
    );
    const windowOpen = expectedUntil.getTime() > expectedSince.getTime();

    const [groups, medians, stuckGroups, windowGroups] = await Promise.all([
      this.prisma.cronRunLog.groupBy({
        by: ['jobKey', 'status', 'triggeredBy'],
        where: { startedAt: range },
        _count: { _all: true },
        _max: { durationMs: true },
      }),
      this.prisma.$queryRaw<
        Array<{ jobKey: string; median: number | string | null }>
      >`SELECT "jobKey", percentile_cont(0.5) WITHIN GROUP (ORDER BY "durationMs") AS median
        FROM "cron_run_logs"
        WHERE "startedAt" >= ${since} AND "startedAt" < ${until} AND "durationMs" IS NOT NULL
        GROUP BY "jobKey"`,
      stuckBefore.getTime() > since.getTime()
        ? this.prisma.cronRunLog.groupBy({
            by: ['jobKey'],
            where: {
              status: 'RUNNING',
              startedAt: { gte: since, lt: stuckBefore },
            },
            _count: { _all: true },
          })
        : Promise.resolve(
            [] as Array<{ jobKey: string; _count: { _all: number } }>,
          ),
      windowOpen
        ? this.prisma.cronRunLog.groupBy({
            by: ['jobKey'],
            where: {
              triggeredBy: VERCEL_CRON_TRIGGERED_BY,
              startedAt: { gte: expectedSince, lt: expectedUntil },
            },
            _count: { _all: true },
          })
        : Promise.resolve(
            [] as Array<{ jobKey: string; _count: { _all: number } }>,
          ),
    ]);

    const schedules = loadVercelSchedules();
    const keys = JOB_REGISTRY.map((j) => j.jobKey);
    for (const g of groups as Array<{ jobKey: string }>) {
      if (!keys.includes(g.jobKey)) keys.push(g.jobKey);
    }

    const jobs: CronJobSummary[] = keys.map((jobKey) => {
      const byStatus: Record<CronRunStatusValue, number> = {
        RUNNING: 0,
        SUCCESS: 0,
        FAILED: 0,
      };
      let scheduledRuns = 0;
      let manualRuns = 0;
      let maxDurationMs: number | null = null;
      for (const g of groups as Array<{
        jobKey: string;
        status: CronRunStatusValue;
        triggeredBy: string;
        _count: { _all: number };
        _max: { durationMs: number | null };
      }>) {
        if (g.jobKey !== jobKey) continue;
        const n = g._count._all;
        byStatus[g.status] = (byStatus[g.status] ?? 0) + n;
        if (g.triggeredBy === VERCEL_CRON_TRIGGERED_BY) scheduledRuns += n;
        else manualRuns += n;
        const m = g._max.durationMs;
        if (m != null && (maxDurationMs == null || m > maxDurationMs)) {
          maxDurationMs = m;
        }
      }
      const medianRow = medians.find((r) => r.jobKey === jobKey);
      const medianDurationMs =
        medianRow && medianRow.median != null
          ? Math.round(Number(medianRow.median))
          : null;
      const stuckRunning =
        (
          stuckGroups as Array<{ jobKey: string; _count: { _all: number } }>
        ).find((g) => g.jobKey === jobKey)?._count._all ?? 0;
      const scheduledRunsInWindow =
        (
          windowGroups as Array<{ jobKey: string; _count: { _all: number } }>
        ).find((g) => g.jobKey === jobKey)?._count._all ?? 0;

      const schedule = schedules?.[jobKey] ?? null;
      let expected: number | null = null;
      if (schedule) {
        try {
          expected = windowOpen
            ? countExpectedRuns(
                parseCronExpression(schedule),
                expectedSince,
                expectedUntil,
              )
            : 0;
        } catch (error) {
          this.logger.warn(
            `сводка кронов: расписание ${jobKey} не разобрано: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      return {
        jobKey,
        schedule,
        expected,
        scheduledRuns,
        scheduledRunsInWindow,
        manualRuns,
        missed:
          expected == null
            ? null
            : Math.max(0, expected - scheduledRunsInWindow),
        total: byStatus.RUNNING + byStatus.SUCCESS + byStatus.FAILED,
        byStatus,
        medianDurationMs,
        maxDurationMs,
        stuckRunning,
        stuck: stuckRunning > 0,
        recentFailures: [],
      };
    });

    await Promise.all(
      jobs
        .filter((j) => j.byStatus.FAILED > 0)
        .map(async (j) => {
          j.recentFailures = (await this.prisma.cronRunLog.findMany({
            where: { jobKey: j.jobKey, status: 'FAILED', startedAt: range },
            orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
            take: SUMMARY_RECENT_FAILURES,
            select: {
              id: true,
              startedAt: true,
              triggeredBy: true,
              durationMs: true,
              summary: true,
              errorMessage: true,
            },
          })) as CronFailureRow[];
        }),
    );

    return {
      since,
      until,
      expectedSince,
      expectedUntil,
      expectedGraceMs: SUMMARY_EXPECTED_GRACE_MS,
      retentionDays: CRON_LOG_RETENTION_DAYS,
      lockMs: JOB_LOCK_MS,
      schedulesLoaded: schedules != null,
      jobs,
    };
  }

  async run(
    jobKey: string,
    triggeredBy: string,
    debugMode: boolean,
  ): Promise<CronRunLogRow> {
    if (!JOB_REGISTRY.some((j) => j.jobKey === jobKey)) {
      throw new BadRequestException(`Неизвестный крон: ${jobKey}`);
    }

    const row = (await this.prisma.cronRunLog.create({
      data: { jobKey, triggeredBy, debugMode, status: 'RUNNING' },
    })) as CronRunLogRow;

    const startedAt = Date.now();
    try {
      const result = await this.dispatch(jobKey, debugMode);
      const durationMs = Date.now() - startedAt;
      const summary = buildRunSummary(jobKey, result);
      const updated = (await this.prisma.cronRunLog.update({
        where: { id: row.id },
        data: {
          status: 'SUCCESS',
          finishedAt: new Date(),
          durationMs,
          summary,
          debugLog: debugMode ? (result as object) : undefined,
        },
      })) as CronRunLogRow;
      this.logger.log(
        `Ручной запуск ${jobKey} (оператор ${triggeredBy}): ${summary}`,
      );
      return updated;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Ручной запуск ${jobKey} (оператор ${triggeredBy}) провалился: ${errorMessage}`,
      );
      return (await this.prisma.cronRunLog.update({
        where: { id: row.id },
        data: {
          status: 'FAILED',
          finishedAt: new Date(),
          durationMs,
          summary: `Ошибка: ${errorMessage}`,
          errorMessage,
        },
      })) as CronRunLogRow;
    }
  }

  /**
   * Диспетчер по jobKey. `sweep-orphans` — единственный, где debug
   * меняет поведение (маппится на dryRun); cursor из ручного запуска
   * никогда не передаётся — каждый прогон начинается с начала, как у
   * настоящего крона без query.
   */
  private async dispatch(jobKey: string, debugMode: boolean): Promise<unknown> {
    switch (jobKey) {
      case 'api-video':
        return this.jobs.runApiVideo();
      case 'balances-watch':
        return this.jobs.runBalancesWatch();
      case 'report':
        return this.jobs.runReport();
      case 'blog':
        return this.jobs.runBlog();
      case 'publish':
        return this.jobs.runPublish();
      case 'billing-renew':
        return this.jobs.runBillingRenew();
      case 'marketing-broadcast':
        return this.jobs.runMarketingBroadcast();
      case 'catalog-batch-run':
        return this.jobs.runCatalogBatchRun();
      case 'ab-test-run':
        return this.jobs.runAbTestRun();
      case 'feed-import-run':
        return this.jobs.runFeedImportRun();
      case 'auction-close':
        return this.jobs.runAuctionClose();
      case 'auction-assess':
        return this.jobs.runAuctionAssess();
      case 'auction-google-ads-sync':
        return this.jobs.runAuctionGoogleAdsSync();
      case 'portfolio-watermark':
        return this.jobs.runPortfolioWatermark();
      case 'live-auction-tick':
        return this.jobs.runLiveAuctionTick();
      case 'export-sync-run':
        return this.jobs.runExportSyncRun();
      case 'tutorial-scenario-generate':
        return this.jobs.runTutorialScenarioGenerate();
      case 'tutorial-scenario-run':
        return this.jobs.runTutorialScenarioRun();
      case 'tutorial-assembly-poll':
        return this.jobs.runTutorialAssemblyPoll();
      case 'ui-snapshot-run':
        return this.jobs.runUiSnapshotRun();
      case 'ai-usage-rollup':
        return this.jobs.runAiUsageRollup();
      case 'cleanup-sessions':
        return this.jobs.runCleanupSessions();
      case 'voice-uploads-sweep':
        return this.jobs.runVoiceUploadsSweep();
      case 'persona-sources-purge':
        return this.jobs.runPersonaSourcesPurge();
      case 'sweep-orphans':
        return this.jobs.runSweepOrphans({
          dryRun: debugMode ? '1' : undefined,
        });
      default:
        // Недостижимо — jobKey уже проверен по JOB_REGISTRY в run().
        throw new BadRequestException(`Неизвестный крон: ${jobKey}`);
    }
  }
}
