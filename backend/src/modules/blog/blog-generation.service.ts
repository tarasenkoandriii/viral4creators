/**
 * BlogGenerationService — суточный генератор черновиков блога (doc/TODO.md
 * §II.3: "Суточный крон ищет новые ролики с высокой динамикой просмотров
 * в заданных категориях... и заводит черновики публикаций: обложка,
 * ссылка, метрики, автоматический разбор Gemini").
 *
 * Источник — `YoutubeSearchService.searchTrending` (свой бюджет,
 * `BlogYoutubeBudgetService`, отдельный от пользовательской квоты — TODO
 * §II.3) + разбор Gemini по тем же критериям, что уже применяет продукт
 * для релевантности референсов (§II.4). Ничего не публикуется само —
 * TODO §II.3: "Это не автопостинг: черновик попадает в очередь", статус
 * всегда DRAFT.
 */

import { Injectable, Logger } from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import { createGeminiClient, geminiApiKey } from '../../common/gemini-client';
import { blogDisabledExplicitly } from '../../common/blog-categories';
import { GEMINI_MODEL } from '../../common/gemini-model';
import { PrismaService } from '../../prisma/prisma.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { YoutubeSearchService } from '../youtube-search/youtube-search.service';
import { BlogYoutubeBudgetService } from './blog-youtube-budget.service';
import { loadConfiguration } from '../../config/configuration';
import { selectBlogCandidates } from './blog-candidate-selection';
import {
  buildBlogAnalysisPrompt,
  parseBlogAnalysisResponse,
} from './blog-analysis-prompt';
import { blogSlugFor } from './blog-slug';
import { sanitizeBlogHtml } from '../../common/sanitize-blog-html';
import { BlogPostStatus } from '@prisma/client';
import { BlobService } from '../storage/blob.service';
import { downloadAndUploadBlogCoverImage } from './blog-cover-image';
import { fetchOgImage } from '../../common/og-image-fetcher';

/**
 * Сколько записей за один прогон бэкофилла обложек (`/api/cron/blog`,
 * третий шаг после генерации и перевода) — щедро с запасом относительно
 * `draftsPerRunLimit` (обычно на порядок меньше кандидатов реально
 * нуждаются в повторе), но с потолком, чтобы не съесть весь
 * GENERATION_TIME_BUDGET_MS на одних загрузках картинок.
 */
export const COVER_BACKFILL_LIMIT = 20;

/**
 * Vercel Cron Job живёт 300 с (Hobby); генерация делает синхронный вызов
 * Gemini на КАЖДОГО кандидата (как AnalysisService — короткие референсы
 * укладываются в лимит функции без асинхронного job/poll), поэтому нужен
 * запас на случай, если категорий/кандидатов больше, чем обычно.
 */
export const GENERATION_TIME_BUDGET_MS = 180_000;

@Injectable()
export class BlogGenerationService {
  private readonly logger = new Logger(BlogGenerationService.name);
  private readonly genai: GoogleGenAI | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly youtubeSearch: YoutubeSearchService,
    private readonly budget: BlogYoutubeBudgetService,
    private readonly aiUsage: AiUsageService,
    private readonly blob: BlobService,
  ) {
    // Тот же приём, что у `wizard-hint`/`translation`/`siblings`: без
    // ключа клиент не создаётся, а не бросает из конструктора. Блог —
    // необязательная часть продукта, и отсутствие его ключа не должно
    // ронять СТАРТ всего API (`.env.docker.example`: «стенд поднимается
    // и без единого ключа, просто соответствующий сервис честно
    // откажет»). Найдено аудитом этапа 135: до этой правки генератор
    // физически не мог сообщить, что ключа нет, — он падал раньше, чем
    // успевал это проверить.
    this.genai = geminiApiKey() ? createGeminiClient() : null;
  }

  /**
   * Один прогон суточного крона. Возвращает сводку для тела ответа
   * /api/cron/blog — числа, не текст, чтобы оператор мог проверить без
   * разбора логов.
   */
  async runDailyGeneration(): Promise<{
    categoriesTried: number;
    candidatesConsidered: number;
    draftsCreated: number;
    skippedBudget: boolean;
    /**
     * Чего не хватило, чтобы вообще начать. `null` — всё на месте.
     *
     * Заведено после живого прогона на проде: экран крона показывал
     * `categoriesTried=0, candidatesConsidered=0, draftsCreated=0` — и
     * это выглядело как «поискали и ничего не нашли», хотя на деле
     * `BLOG_CATEGORIES` просто не был задан. Строка в логе была, но
     * оператор смотрит на экран, а не в логи бессерверной функции.
     * Тот же приём, что у `cleanup-sessions` и `tutorial-scenario-run`
     * (`cron-run-summary.ts`): пропуск обязан отличаться от нуля.
     */
    notConfigured: string | null;
  }> {
    const config = loadConfiguration().blog;
    const started = Date.now();
    const summary = {
      categoriesTried: 0,
      candidatesConsidered: 0,
      draftsCreated: 0,
      skippedBudget: false,
      notConfigured: null as string | null,
    };

    // Выключен решением человека — это не проблема, и говорить о нём
    // надо иначе, чем о нехватке ключа. `BLOG_CATEGORIES` задан
    // пустым — единственный способ остановить генератор, который тратит
    // квоту YouTube, вызовы Gemini и перевод Grok (см.
    // `common/blog-categories.ts`).
    if (blogDisabledExplicitly()) {
      summary.notConfigured =
        'выключен намеренно: BLOG_CATEGORIES задан пустым';
      return summary;
    }

    // Ключи проверяем ОБА сразу, а не по одному на прогон: задав один и
    // не задав другой, оператор получил бы те же нули и пошёл бы на
    // второй круг гадания. Список — то, что надо дозаполнить.
    const missing: string[] = [];
    if (!this.youtubeSearch.configured()) missing.push('YOUTUBE_API_KEY');
    if (!geminiApiKey()) missing.push('GEMINI_API_KEY');
    if (missing.length > 0) {
      summary.notConfigured = `не задано: ${missing.join(', ')}`;
      this.logger.log(
        `Генератор черновиков блога ничего не делает — ${summary.notConfigured}`,
      );
      return summary;
    }

    // Явная аннотация результата findMany — тот же приём, что
    // blog.service.ts/library.service.ts: без неё `.map()` теряет тип
    // элемента из-за непровалидированного в песочнице Prisma-клиента.
    const existingRows: { youtubeVideoId: string | null }[] =
      await this.prisma.blogPost.findMany({
        where: { youtubeVideoId: { not: null } },
        select: { youtubeVideoId: true },
      });
    const existingVideoIds = new Set(
      existingRows.map((r) => r.youtubeVideoId as string),
    );

    for (const category of config.categories) {
      if (Date.now() - started >= GENERATION_TIME_BUDGET_MS) {
        this.logger.warn(
          `Генератор блога упёрся в бюджет времени на категории "${category}" — остаток досмотрит следующий прогон.`,
        );
        break;
      }
      if (summary.draftsCreated >= config.draftsPerRunLimit) break;

      summary.categoriesTried++;

      if (!(await this.budget.reserve())) {
        summary.skippedBudget = true;
        this.logger.log(
          `Суточный бюджет YouTube-поисков блога исчерпан — категория "${category}" пропущена.`,
        );
        continue;
      }

      const results = await this.youtubeSearch.searchTrending(category);
      const candidates = selectBlogCandidates(results, {
        existingVideoIds,
        minViewCount: 0,
        limit: config.draftsPerRunLimit - summary.draftsCreated,
      });
      summary.candidatesConsidered += candidates.length;

      for (const candidate of candidates) {
        if (Date.now() - started >= GENERATION_TIME_BUDGET_MS) break;
        if (summary.draftsCreated >= config.draftsPerRunLimit) break;

        const created = await this.analyzeAndCreateDraft(candidate, category);
        if (created) {
          existingVideoIds.add(candidate.videoId);
          summary.draftsCreated++;
        }
      }
    }

    this.logger.log(
      `Прогон генератора блога завершён: ${JSON.stringify(summary)}`,
    );
    return summary;
  }

  private async analyzeAndCreateDraft(
    candidate: {
      videoId: string;
      title: string;
      channelTitle: string;
      thumbnailUrl: string | null;
      viewCount: number | null;
    },
    category: string,
  ): Promise<boolean> {
    // Сюда не попасть без ключа: `runDailyGeneration` уходит раньше с
    // `notConfigured`. Проверка — чтобы это осталось правдой и после
    // следующей правки, а не держалось на памяти читающего.
    if (!this.genai) return false;
    const config = loadConfiguration().blog;
    const prompt = buildBlogAnalysisPrompt({
      title: candidate.title,
      channelTitle: candidate.channelTitle,
      category,
    });

    let responseText: string;
    try {
      const response = await this.genai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ text: prompt }],
        config: { responseMimeType: 'application/json' },
      });
      // Деньги потрачены независимо от того, распарсится ли ответ ниже —
      // расход пишется сразу (тот же принцип, что в AnalysisService).
      await this.aiUsage.record({
        operation: 'blog-analysis',
        model: GEMINI_MODEL,
        userId: null,
        inputTokens: extractUsage(response).input,
        outputTokens: extractUsage(response).output,
      });
      responseText = response.text ?? '';
    } catch (error) {
      this.logger.warn(
        `Разбор Gemini для ролика ${candidate.videoId} не удался: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }

    const analysis = parseBlogAnalysisResponse(responseText);
    if (!analysis) {
      this.logger.warn(
        `Ответ Gemini для ролика ${candidate.videoId} не разобрался как {score, title, bodyHtml} — черновик не заведён.`,
      );
      return false;
    }
    if (analysis.score < config.minScoreToDraft) {
      this.logger.log(
        `Ролик ${candidate.videoId} набрал ${analysis.score} < ${config.minScoreToDraft} — черновик не заведён.`,
      );
      return false;
    }

    const slug = blogSlugFor(analysis.title, candidate.videoId);
    const cover = await this.resolveCoverImage(candidate, slug);

    try {
      await this.prisma.blogPost.create({
        data: {
          slug,
          status: BlogPostStatus.DRAFT,
          source: 'YOUTUBE_TREND',
          category,
          youtubeVideoId: candidate.videoId,
          youtubeChannelTitle: candidate.channelTitle,
          youtubeViewCount: candidate.viewCount,
          thumbnailUrl: cover.thumbnailUrl,
          sourceImageUrl: cover.sourceImageUrl,
          score: analysis.score,
          scoreReasoning: analysis.scoreReasoning,
          originalLocale: 'ru',
          title: analysis.title,
          // Г-3.1: HTML от Gemini — вход в промпт частично из чужого
          // YouTube-описания (prompt-injection), санитизация обязательна.
          bodyHtml: sanitizeBlogHtml(analysis.bodyHtml),
        },
      });
      return true;
    } catch (error) {
      // Уникальность youtubeVideoId — на случай гонки между параллельными
      // прогонами крона (Vercel не гарантирует ровно один инстанс); не
      // падать всем прогоном ради одной дублирующейся строки.
      this.logger.warn(
        `Не удалось создать черновик для ${candidate.videoId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  /**
   * Обложка черновика (этап 95): перезаливаем YouTube-превью в
   * собственный Blob (`blog-cover-image.ts`), а на редкий случай, когда
   * YouTube Data API вообще не дал превью (`candidate.thumbnailUrl ===
   * null`) — пробуем og:image со страницы самого ролика через
   * `og-image-fetcher.ts` (тот же общий модуль, что и
   * `headless-chromium.ts`, портированный из Solar Shop). Любая неудача
   * на любом шаге не блокирует публикацию черновика — просто обложки не
   * будет вовсе (`thumbnailUrl`/`sourceImageUrl` остаются null), тот же
   * принцип "текст важнее картинки", что и в `blog-cover-image.ts`.
   */
  private async resolveCoverImage(
    candidate: { videoId: string; thumbnailUrl: string | null },
    slug: string,
  ): Promise<{ thumbnailUrl: string | null; sourceImageUrl: string | null }> {
    if (candidate.thumbnailUrl) {
      return downloadAndUploadBlogCoverImage(
        candidate.thumbnailUrl,
        slug,
        this.blob,
      );
    }

    const watchUrl = `https://www.youtube.com/watch?v=${candidate.videoId}`;
    const og = await fetchOgImage(watchUrl);
    if (!og.imageUrl) {
      this.logger.log(
        `У ролика ${candidate.videoId} нет thumbnailUrl, og:image-запасной вариант тоже не дал картинки: ${og.diagnostic}`,
      );
      return { thumbnailUrl: null, sourceImageUrl: null };
    }
    return downloadAndUploadBlogCoverImage(og.imageUrl, slug, this.blob);
  }

  /**
   * Бэкофилл обложек (этап 95): для черновиков/постов, у которых
   * перезаливка в момент создания не удалась (`thumbnailUrl` до сих пор
   * равен `sourceImageUrl` — мягкий откат на хотлинк), пробуем ещё раз.
   * Вызывается третьим шагом из `CronJobsService.runBlog` — тот же
   * маршрут `/api/cron/blog`, отдельного крон-слота не заводится
   * (Vercel Hobby считает кроны поштучно, тот же принцип, что уже
   * объединяет генерацию и перевод в одном вызове).
   */
  async runCoverImageBackfill(limit = COVER_BACKFILL_LIMIT): Promise<{
    candidates: number;
    uploaded: number;
    stillFallback: number;
  }> {
    // Берём с запасом (не всё, что попало в выборку по sourceImageUrl,
    // обязательно всё ещё нуждается в повторе — сравнение с
    // thumbnailUrl ниже фильтрует именно "откат ещё не заменён"), но не
    // без предела — иначе один прогон рискует читать всю таблицу.
    const rows: {
      id: string;
      slug: string;
      thumbnailUrl: string | null;
      sourceImageUrl: string | null;
    }[] = await this.prisma.blogPost.findMany({
      where: { sourceImageUrl: { not: null } },
      select: {
        id: true,
        slug: true,
        thumbnailUrl: true,
        sourceImageUrl: true,
      },
      orderBy: { createdAt: 'asc' },
      take: limit * 4,
    });

    const pending = rows
      .filter((r) => r.sourceImageUrl && r.thumbnailUrl === r.sourceImageUrl)
      .slice(0, limit);

    let uploaded = 0;
    for (const row of pending) {
      const result = await downloadAndUploadBlogCoverImage(
        row.sourceImageUrl as string,
        row.slug,
        this.blob,
      );
      if (result.thumbnailUrl !== row.sourceImageUrl) {
        await this.prisma.blogPost.update({
          where: { id: row.id },
          data: { thumbnailUrl: result.thumbnailUrl },
        });
        uploaded++;
      }
    }

    if (pending.length > 0) {
      this.logger.log(
        `Бэкофилл обложек блога: ${uploaded}/${pending.length} перезалито в свой Blob.`,
      );
    }

    return {
      candidates: pending.length,
      uploaded,
      stillFallback: pending.length - uploaded,
    };
  }
}

/** Токены из ответа Gemini — тот же формат, что AiUsageService.recordGemini разбирает, но здесь нет самого ответа под рукой в виде unknown, поэтому явная выборка полей. */
function extractUsage(response: unknown): { input: number; output: number } {
  const meta = (
    response as {
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        thoughtsTokenCount?: number;
      };
    }
  )?.usageMetadata;
  return {
    input: meta?.promptTokenCount ?? 0,
    output: (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0),
  };
}
