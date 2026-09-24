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
 * Сколько раз повторять провалившийся перевод, прежде чем оставить его
 * в покое.
 *
 * Перевод проваливается по двум разным причинам: разовый сбой xAI (её
 * лечит повтор) и что-то в самом тексте статьи, на чём модель спотыкается
 * каждый раз (её повтор не лечит, а деньги тратит). Три попытки
 * разделяют эти случаи достаточно: дальше нужен человек, и он видит
 * такую строку в карточке записи.
 */
export const MAX_TRANSLATION_ATTEMPTS = 3;

/**
 * Сколько ждать ответа по поданной пачке, прежде чем счесть её зависшей.
 *
 * xAI обещает сутки на пачку, поэтому порог заметно больше: обрывать
 * раньше значило бы платить второй раз за работу, которая ещё делается.
 * Трое суток — это «ответа не будет уже никогда», а не «долго».
 */
export const STUCK_BATCH_TTL_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Почему пачка не подана. Три РАЗНЫЕ причины, и раньше все три
 * назывались одним словом `skipped` — по логу нельзя было отличить
 * «всё переведено» от «очередь встала».
 */
export type SubmitOutcome =
  /** Переводить нечего — норма. */
  | 'nothing-to-translate'
  /** xAI отказал в подаче: деньги не потрачены, работа не сделана. */
  | 'submit-failed'
  /** Бюджет времени съеден опросом уже поданных пачек. */
  | 'out-of-time';

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
      | SubmitOutcome
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
    // Раньше здесь и ниже стояло одно слово `skipped` на три разные
    // причины: переводить нечего (норма), подача не удалась (деньги не
    // потрачены, но и работа не сделана) и бюджет времени выбран
    // опросом (очередь встала — вот это и надо ловить первым). По логу
    // и по ответу крона они были неотличимы.
    const submittedBatch =
      Date.now() - started < TRANSLATION_TIME_BUDGET_MS
        ? await this.submitPendingBatch()
        : 'out-of-time';

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
    { xaiBatchId: string; count: number } | SubmitOutcome
  > {
    const config = loadConfiguration();
    // Находка аудита 24.09.2026: `FAILED` не подбирал НИКТО — ни этот
    // отбор, ни `ensurePendingTranslations` (там `createMany` +
    // `skipDuplicates`, существующую строку он не чинит). Провалившийся
    // перевод оставался мёртвым навсегда, притом что деньги за элемент
    // пачки уже списаны, а доккомментарий `blog-translation-apply.ts`
    // обещал «следующий прогон обязан повторить его в новой пачке».
    //
    // Повтор ограничен `MAX_TRANSLATION_ATTEMPTS`: перевод, который
    // проваливается на самом тексте статьи (а не на разовом сбое xAI),
    // иначе тратил бы деньги каждые сутки бесконечно.
    const pending: TranslationWithPost[] =
      await this.prisma.blogPostTranslation.findMany({
        where: {
          OR: [
            { status: BlogTranslationStatus.PENDING, batchJobId: null },
            {
              status: BlogTranslationStatus.FAILED,
              attempts: { lt: MAX_TRANSLATION_ATTEMPTS },
            },
          ],
        },
        include: { post: { select: { title: true, bodyHtml: true } } },
        orderBy: { createdAt: 'asc' },
        take: config.blog.translateBatchLimit,
      });
    if (pending.length === 0) return 'nothing-to-translate';

    const rows: PendingTranslationRow[] = pending.map((t) => ({
      id: t.id,
      locale: t.locale,
      title: t.post.title,
      bodyHtml: t.post.bodyHtml,
    }));
    const items = buildTranslationBatchItems(rows, config.grok.model);

    // Порядок: СНАЧАЛА строка в базе, потом деньги. Обратный порядок
    // (он тут и стоял) давал двойную оплату: упади процесс между
    // успешной подачей и записью — таймаут функции, деплой, сбой БД, —
    // и переводы остались бы `PENDING` с пустым `batchJobId`, то есть
    // следующий прогон подал бы ТЕ ЖЕ элементы второй оплаченной
    // пачкой, а первая осталась бы висеть в xAI, никому не известная.
    // Именно этот порядок и описан в схеме (`GrokBatchJob.xaiBatchId`:
    // «Null, пока submitBatch не вернул id — короткое окно между
    // записью строки и ответом xAI»), просто код делал наоборот.
    const job = await this.prisma.grokBatchJob.create({
      data: {
        xaiBatchId: null,
        status: GrokBatchJobStatus.SUBMITTED,
        requestCount: items.length,
      },
    });
    await this.prisma.blogPostTranslation.updateMany({
      where: { id: { in: pending.map((t) => t.id) } },
      data: { status: BlogTranslationStatus.QUEUED, batchJobId: job.id },
    });

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
      // Отпускаем переводы обратно в очередь и закрываем job как
      // FAILED. До этой правки значение `GrokBatchJobStatus.FAILED` не
      // присваивалось нигде вообще, хотя схема описывает его именно
      // так («submitBatch вернул ошибку, пачка не была подана вовсе»):
      // история неудачных подач не сохранялась.
      await this.prisma.blogPostTranslation.updateMany({
        where: { batchJobId: job.id },
        data: { status: BlogTranslationStatus.PENDING, batchJobId: null },
      });
      await this.prisma.grokBatchJob.update({
        where: { id: job.id },
        data: {
          status: GrokBatchJobStatus.FAILED,
          errorMessage: result.error ?? 'подача пачки не удалась',
          completedAt: new Date(),
        },
      });
      return 'submit-failed';
    }

    await this.prisma.grokBatchJob.update({
      where: { id: job.id },
      data: { xaiBatchId: result.xaiBatchId },
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
    const jobs: {
      id: string;
      xaiBatchId: string | null;
      submittedAt: Date;
    }[] = await this.prisma.grokBatchJob.findMany({
      where: { status: GrokBatchJobStatus.SUBMITTED },
      orderBy: { submittedAt: 'asc' },
      select: { id: true, xaiBatchId: true, submittedAt: true },
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
        // Теперь это ДОСТИЖИМАЯ ветка, и она означает конкретное:
        // строку завели, а ответа xAI по ней так и не получили —
        // процесс умер между двумя запросами. Раньше такого окна не
        // было (строка создавалась уже с id), и комментарий здесь
        // честно говорил «не должно случаться»; после перестановки
        // порядка окно появилось, и молча пропускать такую строку
        // нельзя — она держит свои переводы в QUEUED навсегда.
        await this.releaseOrphanJob(job.id);
        continue;
      }

      const status = await this.grokBatch.getBatchStatus(job.xaiBatchId);
      // Зависшую снимаем до всех прочих решений: она и так уже съела
      // больше времени, чем ей отведено.
      if (Date.now() - job.submittedAt.getTime() > STUCK_BATCH_TTL_MS) {
        await this.releaseStuckJob(job.id);
        continue;
      }
      // `pendingCount === null` — поля `num_pending` в ответе НЕ БЫЛО.
      // Раньше оно читалось как ноль, то есть «пачка готова», и дальше
      // пустой список результатов превращал ВСЮ оплаченную пачку в
      // мёртвые FAILED с записью расхода на каждый элемент. Одна
      // неожиданная форма ответа xAI — и пачка потеряна целиком.
      if (!status || status.pendingCount === null || status.pendingCount > 0) {
        continue;
      }

      const applied = await this.applyCompletedBatch(job.id, job.xaiBatchId);
      if (applied) completedJobs++;
    }
    return { polledJobs, completedJobs };
  }

  /**
   * Пачка, по которой xAI так и не ответил, — не вечная.
   *
   * Находка аудита 24.09.2026: у `SUBMITTED` не было ни таймаута, ни
   * счётчика попыток. Истёкший, удалённый или просто зависший батч
   * оставался в этом статусе НАВСЕГДА, держа свои переводы в `QUEUED`
   * (а `QUEUED` в новую пачку не попадает — `batchJobId` не пуст). Хуже
   * того, опрос идёт от старых к новым, поэтому зависшие съедали бюджет
   * времени первыми, и после нескольких таких конвейер перевода
   * останавливался целиком — молча, без единого признака где-либо.
   *
   * `STUCK_BATCH_TTL_MS` заметно больше суток: xAI обещает сутки на
   * пачку, и обрывать её раньше значило бы платить второй раз за работу,
   * которая ещё делается.
   */
  private async releaseStuckJob(jobId: string): Promise<void> {
    await this.prisma.blogPostTranslation.updateMany({
      where: { batchJobId: jobId, status: BlogTranslationStatus.QUEUED },
      data: { status: BlogTranslationStatus.PENDING, batchJobId: null },
    });
    await this.prisma.grokBatchJob.update({
      where: { id: jobId },
      data: {
        status: GrokBatchJobStatus.FAILED,
        errorMessage: 'xAI не ответил по этой пачке дольше допустимого',
        completedAt: new Date(),
      },
    });
    this.logger.warn(
      `пачка перевода ${jobId} зависла и снята — переводы вернулись в очередь`,
    );
  }

  /**
   * Строка пачки без `xaiBatchId` — процесс умер между её созданием и
   * ответом xAI. Переводы под ней надо отпустить: сама пачка либо не
   * подана вовсе, либо подана, но её идентификатор потерян — в обоих
   * случаях ждать по ней нечего.
   */
  private async releaseOrphanJob(jobId: string): Promise<void> {
    await this.prisma.blogPostTranslation.updateMany({
      where: { batchJobId: jobId, status: BlogTranslationStatus.QUEUED },
      data: { status: BlogTranslationStatus.PENDING, batchJobId: null },
    });
    await this.prisma.grokBatchJob.update({
      where: { id: jobId },
      data: {
        status: GrokBatchJobStatus.FAILED,
        errorMessage: 'идентификатор пачки не получен — подача оборвалась',
        completedAt: new Date(),
      },
    });
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

    const detailed = await this.grokBatch.getBatchResultsDetailed(xaiBatchId);
    if (!detailed.complete) {
      // М-3.2б седьмого аудита: результаты прочитаны не полностью —
      // «не смогли прочитать», а не «xAI не перевёл». Ждём следующего
      // тика, ничего не помечаем и расход не пишем.
      this.logger.warn(
        `пачка ${xaiBatchId}: результаты прочитаны не полностью — повтор следующим тиком`,
      );
      return false;
    }
    const rawResults = detailed.resultsByRequestId;
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
            // Счётчик растёт ИМЕННО здесь, на неудаче: по нему
            // `submitPendingBatch` решает, стоит ли пробовать снова, и
            // он же отделяет разовый сбой xAI от статьи, на которой
            // модель спотыкается каждый раз.
            attempts: { increment: 1 },
            // `batchJobId` снимаем: пачка отработала, и держаться за
            // неё строке больше незачем — иначе повтор снова упёрся бы
            // в условие отбора (та самая ловушка, из-за которой FAILED
            // и был тупиком).
            batchJobId: null,
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
