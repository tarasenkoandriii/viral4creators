/**
 * AdminCronService — реестр одиннадцати крон-задач + ручной запуск из
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
import { CronJobsService } from './cron-jobs.service';
import { buildRunSummary } from './cron-run-summary';

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

/**
 * Реестр — те же одиннадцать маршрутов `/api/cron/*`, тексты описаний
 * переиспользуют формулировки из доккомментариев `cron.controller.ts`
 * (не выдумываются заново).
 */
const JOB_REGISTRY: CronJobInfo[] = [
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
    jobKey: 'export-sync-run',
    description:
      'Досмотр статуса дочерних рендеров автоэкспорта яруса B независимо от открытого экрана прогресса.',
  },
  {
    jobKey: 'cleanup-sessions',
    description:
      'Уборка истёкших сессий (и их файлов), admin/user-сессий и невостребованной библиотеки.',
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
   */
  async getHistory(jobKey?: string, limit = 50): Promise<CronRunLogRow[]> {
    const rows = await this.prisma.cronRunLog.findMany({
      where: jobKey ? { jobKey } : undefined,
      orderBy: { startedAt: 'desc' },
      take: limit,
    });
    return rows as CronRunLogRow[];
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
      case 'export-sync-run':
        return this.jobs.runExportSyncRun();
      case 'cleanup-sessions':
        return this.jobs.runCleanupSessions();
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
