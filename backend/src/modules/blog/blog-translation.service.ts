/**
 * BlogTranslationService — очередь перевода статей через xAI Grok Batch
 * API (ТЗ §35.1, этап 57, по прямому запросу пользователя «использовать
 * Grok AI как и в Solar shop batch mode для перевода статей»).
 *
 * Три отдельных шага одного крона (см. `runTranslationCron`), каждый —
 * идемпотентный и безопасный при повторном вызове (Vercel не гарантирует
 * ровно один инстанс, а крон может быть вызван вручную для отладки):
 *
 * 1. `ensurePendingTranslations` — у каждой APPROVED/PUBLISHED статьи
 *    должны быть строки `BlogPostTranslation` на все локали, кроме её
 *    собственной (см. `nonOriginalLocales` в blog.service.ts).
 *    `skipDuplicates` — по `@@unique([postId, locale])` — делает вызов
 *    безопасным при повторном прогоне.
 * 2. `pollSubmittedBatches` — СНАЧАЛА проверяем уже поданные пачки: если
 *    они готовы за прошедшие сутки, забираем результат, прежде чем
 *    заводить новые (иначе можно годами копить пачки, не разбирая их).
 * 3. `submitPendingBatch` — берём до `config.blog.translateBatchLimit`
 *    ожидающих переводов и подаём их одной пачкой в xAI.
 *
 * Учёт расхода (§26): xAI Batch API берёт деньги за пачку целиком, а не
 * гарантированно за каждый элемент отдельно (документация об этом
 * умалчивает, у нас нет реального аккаунта, чтобы сверить), поэтому
 * решение — записывать одну строку `AiUsageService.record` на КАЖДЫЙ
 * обработанный перевод (ready ИЛИ failed — деньги за пачку потрачены
 * независимо от исхода конкретного элемента) в момент, когда пачка
 * готова. Ставки в прайсе для GROK нет (`common/ai-pricing.ts`) — расход
 * пишется как `unpriced: true`, честно, а не нулём. Это ДОПУЩЕНИЕ,
 * задокументированное как открытый вопрос в ТЗ §35 — при первом реальном
 * прогоне стоит сверить фактический биллинг xAI и, если он оказался
 * потранзакционным, а не попачечным, пересмотреть точку записи.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { GrokBatchService } from '../grok/grok-batch.service';
import { loadConfiguration } from '../../config/configuration';
import {
  BlogPostStatus,
  BlogTranslationStatus,
  GrokBatchJobStatus,
} from '@prisma/client';
import { nonOriginalLocales } from './blog.service';
import {
  applyTranslationBatchResults,
  buildTranslationBatchItems,
  PendingTranslationRow,
} from './blog-translation-apply';
import { sanitizeBlogHtml } from '../../common/sanitize-blog-html';

/**
 * Тот же принцип бюджета времени, что у `GENERATION_TIME_BUDGET_MS` —
 * опрос нескольких пачек подряд (`getBatchResults` — до 50 страниц
 * каждая, см. grok-batch.service.ts) не должен упереться в 300-секундный
 * потолок Vercel Cron без возможности остановиться заранее.
 */
export const TRANSLATION_TIME_BUDGET_MS = 90_000;

/**
 * Форма строки `BlogPostTranslation` вместе с оригинальным текстом
 * родительской статьи (для сборки промпта перевода) — общая для
 * `submitPendingBatch` и `applyCompletedBatch`. Явный интерфейс + явная
 * аннотация на местах `findMany()` (см. использование ниже) — тот же
 * приём, что в blog.service.ts/blog-generation.service.ts, против
 * `any`, которым непровалидированный в песочнице Prisma-клиент иначе
 * заражает `.map()` по цепочке.
 */
interface TranslationWithPost {
  id: string;
  locale: string;
  post: { title: string; bodyHtml: string };
}

@Injectable()
export class BlogTranslationService {
  private readonly logger = new Logger(BlogTranslationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly grokBatch: GrokBatchService,
    private readonly aiUsage: AiUsageService,
  ) {}

  /**
   * Один прогон: сперва разобрать готовые пачки, потом завести
   * недостающие PENDING-строки, потом подать новую пачку. Порядок именно
   * такой (не наоборот) — см. заголовок файла, пункт 2.
   */
  async runTranslationCron(): Promise<{
    polledJobs: number;
    completedJobs: number;
    translationsEnsured: number;
    submittedBatch:
      | { xaiBatchId: string; count: number }
      | 'skipped'
      | 'not-configured'
      | null;
  }> {
    if (!this.grokBatch.isConfigured()) {
      this.logger.log(
        'GROK_API_KEY не задан — очередь перевода блога ничего не делает.',
      );
      return {
        polledJobs: 0,
        completedJobs: 0,
        translationsEnsured: 0,
        submittedBatch: 'not-configured',
      };
    }

    const started = Date.now();
    const { polledJobs, completedJobs } =
      await this.pollSubmittedBatches(started);
    const translationsEnsured = await this.ensurePendingTranslations();
    const submittedBatch =
      Date.now() - started < TRANSLATION_TIME_BUDGET_MS
        ? await this.submitPendingBatch()
        : 'skipped';

    this.logger.log(
      `Прогон очереди перевода блога: опрошено пачек ${polledJobs}, завершено ${completedJobs}, ` +
        `новых PENDING-переводов ${translationsEnsured}, подача новой пачки: ${JSON.stringify(submittedBatch)}`,
    );
    return { polledJobs, completedJobs, translationsEnsured, submittedBatch };
  }

  /**
   * Заводит PENDING-строки переводов для всех локалей, кроме оригинала,
   * у каждой APPROVED/PUBLISHED статьи. `skipDuplicates` — безопасно при
   * повторном вызове (уникальность по `[postId, locale]`).
   */
  async ensurePendingTranslations(): Promise<number> {
    // Явная аннотация — см. комментарий в blog.service.ts/adminList про
    // тот же приём против непровалидированного в песочнице Prisma-клиента.
    const posts: { id: string; originalLocale: string }[] =
      await this.prisma.blogPost.findMany({
        where: {
          status: { in: [BlogPostStatus.APPROVED, BlogPostStatus.PUBLISHED] },
        },
        select: { id: true, originalLocale: true },
      });
    if (posts.length === 0) return 0;

    const data = posts.flatMap((post) =>
      nonOriginalLocales(post.originalLocale).map((locale) => ({
        postId: post.id,
        locale,
      })),
    );
    if (data.length === 0) return 0;

    const result = await this.prisma.blogPostTranslation.createMany({
      data,
      skipDuplicates: true,
    });
    return result.count;
  }

  /**
   * Подаёт до `config.blog.translateBatchLimit` ожидающих переводов
   * одной пачкой xAI. Ожидающие — те, у кого ещё нет `batchJobId`: уже
   * поданные, но ещё не готовые (`QUEUED`), в новую пачку не попадают —
   * иначе один и тот же перевод оказался бы одновременно в двух пачках.
   */
  async submitPendingBatch(): Promise<
    { xaiBatchId: string; count: number } | 'skipped'
  > {
    const config = loadConfiguration();
    const pending: TranslationWithPost[] =
      await this.prisma.blogPostTranslation.findMany({
        where: { status: BlogTranslationStatus.PENDING, batchJobId: null },
        include: { post: { select: { title: true, bodyHtml: true } } },
        orderBy: { createdAt: 'asc' },
        take: config.blog.translateBatchLimit,
      });
    if (pending.length === 0) return 'skipped';

    const rows: PendingTranslationRow[] = pending.map((t) => ({
      id: t.id,
      locale: t.locale,
      title: t.post.title,
      bodyHtml: t.post.bodyHtml,
    }));
    const items = buildTranslationBatchItems(rows, config.grok.model);

    const result = await this.grokBatch.submitBatch(
      `blog-translations-${new Date().toISOString()}`,
      items,
    );
    // Проверяем именно отсутствие xaiBatchId, а не наличие result.error:
    // GrokBatchSubmitResult различает свои две ветки необязательными
    // полями (`error?: undefined` / `xaiBatchId?: undefined`), и `if
    // (result.error)` не сужает тип для TS до конца (error — строка,
    // пустая строка тоже ложна) — компилятор ниже всё ещё видел бы
    // `result.xaiBatchId` как `string | undefined`.
    if (!result.xaiBatchId) {
      this.logger.warn(
        `Не удалось подать пачку перевода блога: ${result.error}`,
      );
      return 'skipped';
    }

    const job = await this.prisma.grokBatchJob.create({
      data: {
        xaiBatchId: result.xaiBatchId,
        status: GrokBatchJobStatus.SUBMITTED,
        requestCount: items.length,
      },
    });
    await this.prisma.blogPostTranslation.updateMany({
      where: { id: { in: pending.map((t) => t.id) } },
      data: { status: BlogTranslationStatus.QUEUED, batchJobId: job.id },
    });

    return { xaiBatchId: result.xaiBatchId, count: items.length };
  }

  /**
   * Опрашивает все `SUBMITTED`-пачки. Готова — когда `pendingCount===0`
   * (см. предупреждение в grok-batch.service.ts про num_pending vs
   * num_success). Не готова — просто пропускаем, следующий прогон
   * проверит снова; xAI не гарантирует срок (best-effort, до 24 часов).
   */
  private async pollSubmittedBatches(
    started: number,
  ): Promise<{ polledJobs: number; completedJobs: number }> {
    const jobs: { id: string; xaiBatchId: string | null }[] =
      await this.prisma.grokBatchJob.findMany({
        where: { status: GrokBatchJobStatus.SUBMITTED },
        orderBy: { submittedAt: 'asc' },
      });

    let polledJobs = 0;
    let completedJobs = 0;
    for (const job of jobs) {
      if (Date.now() - started >= TRANSLATION_TIME_BUDGET_MS) {
        this.logger.warn(
          `Опрос пачек перевода блога упёрся в бюджет времени — остаток проверит следующий прогон.`,
        );
        break;
      }
      polledJobs++;
      if (!job.xaiBatchId) {
        // Не должно случаться (создаётся вместе с xaiBatchId), но не
        // падать всем прогоном ради одной сломанной строки.
        continue;
      }

      const status = await this.grokBatch.getBatchStatus(job.xaiBatchId);
      if (!status || status.pendingCount > 0) continue;

      const applied = await this.applyCompletedBatch(job.id, job.xaiBatchId);
      if (applied) completedJobs++;
    }
    return { polledJobs, completedJobs };
  }

  /** Разбирает результаты одной готовой пачки и закрывает её. */
  private async applyCompletedBatch(
    jobId: string,
    xaiBatchId: string,
  ): Promise<boolean> {
    const queued: TranslationWithPost[] =
      await this.prisma.blogPostTranslation.findMany({
        where: { batchJobId: jobId, status: BlogTranslationStatus.QUEUED },
        include: { post: { select: { title: true, bodyHtml: true } } },
      });
    if (queued.length === 0) {
      // Пачка готова, но переводов под ней уже нет (например, статью
      // отредактировали и adminUpdate сбросил их обратно на PENDING) —
      // просто закрываем job, разбирать нечего.
      await this.prisma.grokBatchJob.update({
        where: { id: jobId },
        data: { status: GrokBatchJobStatus.COMPLETED, completedAt: new Date() },
      });
      return true;
    }

    const rawResults = await this.grokBatch.getBatchResults(xaiBatchId);
    const rows: PendingTranslationRow[] = queued.map((t) => ({
      id: t.id,
      locale: t.locale,
      title: t.post.title,
      bodyHtml: t.post.bodyHtml,
    }));
    const applied = applyTranslationBatchResults(rows, rawResults);

    let failedCount = 0;
    for (const item of applied) {
      if (item.outcome === 'ready') {
        await this.prisma.blogPostTranslation.update({
          where: { id: item.translationId },
          data: {
            status: BlogTranslationStatus.READY,
            title: item.title,
            // Г-3.1: тот же риск, что у Gemini-черновика — xAI переводит
            // уже размеченный HTML, но не обязан вернуть ровно ту же
            // разметку без посторонних тегов.
            bodyHtml: sanitizeBlogHtml(item.bodyHtml as string),
            errorMessage: null,
            translatedAt: new Date(),
          },
        });
      } else {
        failedCount++;
        await this.prisma.blogPostTranslation.update({
          where: { id: item.translationId },
          data: {
            status: BlogTranslationStatus.FAILED,
            errorMessage: item.errorMessage ?? 'неизвестная ошибка перевода',
          },
        });
      }
      // См. заголовок файла: расход пишется на каждый обработанный
      // элемент готовой пачки, независимо от исхода.
      await this.aiUsage.record({
        operation: 'translate',
        model: loadConfiguration().grok.model,
        provider: 'GROK',
        userId: null,
        calls: 1,
      });
    }

    await this.prisma.grokBatchJob.update({
      where: { id: jobId },
      data: {
        status: GrokBatchJobStatus.COMPLETED,
        completedAt: new Date(),
        errorMessage:
          failedCount > 0
            ? `${failedCount}/${applied.length} переводов пачки не удались`
            : null,
      },
    });
    this.logger.log(
      `Пачка ${xaiBatchId} разобрана: готово ${applied.length - failedCount}, не удалось ${failedCount}.`,
    );
    return true;
  }
}
