/**
 * YoutubeSearchService — reference-video search via YouTube Data API v3
 * (doc/PRODUCT-PROJECT-SPEC.md §6.4, §9; Stage 11 of the plan).
 *
 * Two calls per search, exactly as the spec lays out:
 *   1. search.list  (100 units) — ids, titles, channels, thumbnails;
 *      maxResults=50, no pagination (§9.3: a second page costs another
 *      100 units for the same user action, so we take all 50 at once).
 *   2. videos.list  (~1 unit)   — statistics + contentDetails for those
 *      ids in ONE batch request (≤50 ids), never per video.
 * The rows are merged into the table shape of §6.4; sorting is the
 * client's job (whole result set, one page).
 *
 * Quota: per-user daily cap (YoutubeSearchUsageService) checked BEFORE
 * the paid call and recorded only after Google answered search.list —
 * a transport failure or a bad key must not eat the user's allowance.
 * Google's own quotaExceeded (403) is surfaced as 429 with a plain
 * message, not as a generic 502.
 */

import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import axios, { AxiosError } from 'axios';
import { loadConfiguration } from '../../config/configuration';
import { formatDuration, parseIsoDuration } from './youtube-duration';
import {
  YoutubeSearchResponse,
  YoutubeSearchResultView,
} from './youtube-search.types';
import { YoutubeSearchUsageService } from './youtube-search-usage.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { PlanService } from '../plan/plan.service';

const API = 'https://www.googleapis.com/youtube/v3';
export const MAX_RESULTS = 50;
const TIMEOUT_MS = 15_000;

/** Subset of the search.list response we read. Exported for tests. */
export interface SearchListItem {
  id?: { kind?: string; videoId?: string };
  snippet?: {
    title?: string;
    channelTitle?: string;
    channelId?: string;
    publishedAt?: string;
    thumbnails?: Record<string, { url?: string } | undefined>;
  };
}

/** Subset of the videos.list response we read. Exported for tests. */
export interface VideoListItem {
  id?: string;
  contentDetails?: { duration?: string };
  statistics?: { viewCount?: string; likeCount?: string };
  /**
   * Приходит только когда в `part` попросили `snippet` (этап 136,
   * `fetchVideoTags`). У поисковых вызовов `part` — `statistics,
   * contentDetails`, и там этого поля нет вовсе: теги нужны одному
   * ролику при регистрации ссылки, а не пятидесяти строкам таблицы.
   */
  snippet?: { tags?: string[] };
}

export interface SearchOptions {
  regionCode?: string;
  language?: string;
}

type Thumbnails = NonNullable<SearchListItem['snippet']>['thumbnails'];

/** Best thumbnail for a table row: medium (320px) → high → default. */
function pickThumbnail(thumbs: Thumbnails | undefined): string | null {
  if (!thumbs) return null;
  return thumbs.medium?.url ?? thumbs.high?.url ?? thumbs.default?.url ?? null;
}

function toInt(v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Pure merge of the two API answers into table rows, keeping search.list
 * order (YouTube's relevance ranking — the client re-sorts on demand).
 * Videos missing from videos.list keep null stats rather than vanishing.
 */
export function mergeResults(
  search: SearchListItem[],
  videos: VideoListItem[],
): YoutubeSearchResultView[] {
  const byId = new Map<string, VideoListItem>();
  for (const v of videos) if (v.id) byId.set(v.id, v);

  const rows: YoutubeSearchResultView[] = [];
  for (const item of search) {
    const videoId = item.id?.videoId;
    if (!videoId) continue; // channels/playlists — shouldn't appear with type=video, but be safe
    const details = byId.get(videoId);
    const seconds = parseIsoDuration(details?.contentDetails?.duration);
    rows.push({
      videoId,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      title: decodeEntities(item.snippet?.title ?? ''),
      channelTitle: decodeEntities(item.snippet?.channelTitle ?? ''),
      channelId: item.snippet?.channelId ?? '',
      publishedAt: item.snippet?.publishedAt ?? '',
      thumbnailUrl: pickThumbnail(item.snippet?.thumbnails),
      durationSeconds: seconds,
      durationLabel: seconds === null ? null : formatDuration(seconds),
      viewCount: toInt(details?.statistics?.viewCount),
      likeCount: toInt(details?.statistics?.likeCount),
    });
  }
  return rows;
}

/** search.list returns titles HTML-escaped (`&amp;`, `&#39;`); videos.list doesn't. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

@Injectable()
export class YoutubeSearchService {
  private readonly logger = new Logger(YoutubeSearchService.name);
  private readonly apiKey: string;

  constructor(
    private readonly usage: YoutubeSearchUsageService,
    private readonly aiUsage: AiUsageService,
    private readonly plans: PlanService,
  ) {
    this.apiKey = loadConfiguration().youtube.apiKey;
  }

  /**
   * Задан ли ключ. Нужен генератору блога: без ключа `searchTrending`
   * молча отдаёт пустой список, и прогон крона выглядит как «поискали и
   * ничего не нашли». Отличать «не настроено» от «пусто» — работа
   * вызывающего, и спросить об этом он должен явно.
   */
  configured(): boolean {
    return !!this.apiKey;
  }

  async search(
    userId: string,
    query: string,
    opts: SearchOptions = {},
  ): Promise<YoutubeSearchResponse> {
    // ТЗ §25.3: заблокированному платные вызовы запрещены.
    await this.plans.assertCanSpendUser(userId);

    const q = query.trim();
    if (!this.apiKey) {
      throw new ServiceUnavailableException(
        'YouTube search is not configured (YOUTUBE_API_KEY). Paste a YouTube link or upload a file instead.',
      );
    }
    // Слот занимается ДО обращения к Google (Б-1.9): квота у Google
    // общая на весь деплой, и перебор одного пользователя выключает
    // поиск всем остальным. Раньше между чтением счётчика и его
    // увеличением помещался второй запрос.
    if (!(await this.usage.reserve(userId))) {
      const status = await this.usage.status(userId);
      throw new HttpException(
        `Daily YouTube search limit reached (${status.used}/${status.limit} today). Paste a link or upload a file instead, or try again tomorrow.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    let search: { items?: SearchListItem[] };
    try {
      search = await this.call<{ items?: SearchListItem[] }>('search', {
        part: 'snippet',
        type: 'video',
        maxResults: String(MAX_RESULTS),
        q,
        ...(opts.regionCode
          ? { regionCode: opts.regionCode.toUpperCase() }
          : {}),
        ...(opts.language ? { relevanceLanguage: opts.language } : {}),
      });
    } catch (error) {
      // Слот возвращаем, только если Google этот запрос НЕ посчитал: он
      // не дошёл (сеть, таймаут) или отвергнут за исчерпанную квоту всего
      // деплоя — чужая авария не должна съедать суточную квоту человека.
      // Любой другой ответ, включая 4xx, у Google тарифицируется («все
      // запросы, в том числе неверные, стоят не меньше одной единицы»),
      // и возвращать за него слот значило бы разрешить перебор на ошибках
      // (этап 54, В-2.15). До этого возвращали на любой ошибке.
      if (!chargedByGoogle(error)) await this.usage.release(userId);
      throw error;
    }

    const items = search.items ?? [];
    const ids = items
      .map((i) => i.id?.videoId)
      .filter((id): id is string => !!id);

    // Второй вызов — `videos.list` за длительностью и просмотрами. Свой
    // слот квоты пользователя он не занимает: у Google он стоит 1 единицу
    // против 100 у поиска и без поиска не бывает, то есть это часть той же
    // операции. А вот в журнале он виден: `calls` считает HTTP-вызовы.
    let videos: VideoListItem[] = [];
    let calls = 1;
    if (ids.length > 0) {
      try {
        const res = await this.call<{ items?: VideoListItem[] }>('videos', {
          part: 'statistics,contentDetails',
          id: ids.join(','),
          maxResults: String(MAX_RESULTS),
        });
        videos = res.items ?? [];
        calls = 2;
      } catch (e) {
        // Stats are a nicety; the search itself succeeded. Degrade to a
        // table without duration/views rather than failing the whole call.
        if (chargedByGoogle(e)) calls = 2;
        this.logger.warn(
          `videos.list failed, returning search results without stats: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    // ТЗ §26. Поиск на YouTube тратит суточную квоту, а не деньги, —
    // строка всё равно пишется, с нулевой ставкой: в отчёте видно, кто
    // расходует квоту, и ноль здесь означает «бесплатно», а не «забыли».
    await this.aiUsage.record({
      operation: 'video-search',
      model: 'youtube-data-api',
      userId,
      calls,
    });

    return {
      query: q,
      results: mergeResults(items, videos),
      usage: await this.usage.status(userId),
    };
  }

  /**
   * Поиск для суточного генератора черновиков блога (doc/TODO.md §II.3,
   * этап 57) — сознательно НЕ переиспользует `search()`: та привязана к
   * конкретному пользователю (`PlanService.assertCanSpendUser`,
   * `YoutubeSearchUsageService` — персональная суточная квота), а у
   * генератора нет пользователя вообще, только собственный, отдельный
   * потолок (`config/configuration.ts`, `blog.youtubeSearchDailyLimit`) —
   * TODO §II.3: «суточный поиск блога должен иметь свой потолок,
   * отдельный от пользовательского». Квоту и вызов Google проверяет
   * BlogGenerationService ДО обращения сюда; этот метод только делает
   * сам HTTP-запрос и разбирает ответ, переиспользуя `call()`/`translate()`
   * — тот же клиент и тот же перевод ошибок Google, что и у `search()`.
   *
   * Расход в журнале (§26) пишется с `userId: null` — это системный
   * вызов, не действие какого-то пользователя; у `youtube-data-api`
   * ставка нулевая (бесплатная суточная квота), так что на общий
   * анонимный денежный потолок (§26.4) это не влияет никак.
   */
  async searchTrending(
    query: string,
    opts: SearchOptions = {},
  ): Promise<YoutubeSearchResultView[]> {
    if (!this.apiKey) return [];

    const q = query.trim();
    if (!q) return [];

    let search: { items?: SearchListItem[] };
    try {
      search = await this.call<{ items?: SearchListItem[] }>('search', {
        part: 'snippet',
        type: 'video',
        maxResults: String(MAX_RESULTS),
        q,
        ...(opts.regionCode
          ? { regionCode: opts.regionCode.toUpperCase() }
          : {}),
        ...(opts.language ? { relevanceLanguage: opts.language } : {}),
      });
    } catch (error) {
      this.logger.warn(
        `searchTrending("${q}") failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }

    const items = search.items ?? [];
    const ids = items
      .map((i) => i.id?.videoId)
      .filter((id): id is string => !!id);

    let videos: VideoListItem[] = [];
    let calls = 1;
    if (ids.length > 0) {
      try {
        const res = await this.call<{ items?: VideoListItem[] }>('videos', {
          part: 'statistics,contentDetails',
          id: ids.join(','),
          maxResults: String(MAX_RESULTS),
        });
        videos = res.items ?? [];
        calls = 2;
      } catch (e) {
        this.logger.warn(
          `videos.list failed in searchTrending, returning rows without stats: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    await this.aiUsage.record({
      operation: 'video-search',
      model: 'youtube-data-api',
      userId: null,
      calls,
    });

    return mergeResults(items, videos);
  }

  /**
   * Теги исходного ролика по его id (ТЗ TZ-Multilingual-YouTube.md,
   * этап 136) — умолчание для поля тегов в панели публикации.
   *
   * Отдельный вызов `videos.list` с `part: 'snippet'`, а не расширение
   * поискового: у поиска пятьдесят строк, и теги там не нужны ни одной
   * — нужны ровно тому ролику, который человек выбрал в референс. К
   * тому же ссылку можно вставить руками, минуя поиск вовсе, и тогда
   * расширять было бы нечего.
   *
   * Суточный слот пользователя НЕ занимает — по той же причине, по
   * которой его не занимает `videos.list` за статистикой в `search()`:
   * у Google он стоит 1 единицу против 100 у поиска и случается не по
   * отдельной команде человека, а внутри уже начатого действия.
   * Тратить на него суточную квоту поиска значило бы отнимать у людей
   * поиски за чужой счёт.
   *
   * Никогда не бросает: теги — украшение поля ввода, а не условие
   * регистрации референса. Нет ключа, не та ссылка, Google промолчал,
   * у автора теги не заполнены — во всех случаях пустой список, и у
   * панели публикации на этот случай есть обязательный запасной
   * источник.
   */
  async fetchVideoTags(
    videoId: string,
    sessionId: string | null = null,
  ): Promise<string[]> {
    if (!this.apiKey || !videoId) return [];

    let res: { items?: VideoListItem[] };
    try {
      res = await this.call<{ items?: VideoListItem[] }>('videos', {
        part: 'snippet',
        id: videoId,
        maxResults: '1',
      });
    } catch (e) {
      // Запись в журнал (§26) — только если Google этот запрос посчитал:
      // не дошедший вызов ничего не стоил и в отчёте о расходе квоты
      // выглядел бы расходом, которого не было.
      if (chargedByGoogle(e)) {
        await this.aiUsage.record({
          operation: 'video-tags',
          model: 'youtube-data-api',
          sessionId,
          calls: 1,
        });
      }
      this.logger.warn(
        `videos.list(snippet) failed for ${videoId}, continuing without source tags: ${e instanceof Error ? e.message : String(e)}`,
      );
      return [];
    }

    await this.aiUsage.record({
      operation: 'video-tags',
      model: 'youtube-data-api',
      sessionId,
      calls: 1,
    });

    const tags = res.items?.[0]?.snippet?.tags ?? [];
    // `videos.list` теги не экранирует (в отличие от заголовков в
    // `search.list`), но прогнать через тот же декодер дешевле, чем
    // однажды показать человеку `&amp;` в поле ввода.
    return tags
      .map((t) => decodeEntities(String(t)).trim())
      .filter((t) => t.length > 0);
  }

  private async call<T>(
    endpoint: 'search' | 'videos',
    params: Record<string, string>,
  ): Promise<T> {
    try {
      const res = await axios.get<T>(`${API}/${endpoint}`, {
        params: { ...params, key: this.apiKey },
        timeout: TIMEOUT_MS,
      });
      return res.data;
    } catch (e) {
      throw this.translate(endpoint, e);
    }
  }

  /** Google error → HttpException with a message the UI can show as-is. */
  private translate(endpoint: string, e: unknown): HttpException {
    const err = e as AxiosError<{
      error?: {
        code?: number;
        message?: string;
        errors?: Array<{ reason?: string }>;
      };
    }>;
    const status = err.response?.status;
    const body = err.response?.data?.error;
    const reason = body?.errors?.[0]?.reason;
    this.logger.warn(
      `YouTube ${endpoint} failed: HTTP ${status ?? '—'} ${reason ?? ''} ${body?.message ?? err.message}`,
    );
    const quotaExhausted =
      status === 403 &&
      (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded');
    return markCharged(
      this.translateResponse(status, reason, err.code),
      Boolean(err.response) && !quotaExhausted,
    );
  }

  private translateResponse(
    status: number | undefined,
    reason: string | undefined,
    code: string | undefined,
  ): HttpException {
    if (
      status === 403 &&
      (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded')
    ) {
      return new HttpException(
        'YouTube Data API daily quota is exhausted for this deployment. Paste a link or upload a file instead, or try again tomorrow.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (status === 400 || status === 403) {
      return new ServiceUnavailableException(
        `YouTube search rejected the request (${reason ?? status}) — check YOUTUBE_API_KEY and that YouTube Data API v3 is enabled.`,
      );
    }
    return new HttpException(
      `YouTube search is unavailable right now (${status ?? code ?? 'network'}). Paste a link or upload a file instead.`,
      HttpStatus.BAD_GATEWAY,
    );
  }
}

/**
 * Посчитал ли Google запрос в своей квоте — от этого зависит, тратить ли
 * слот пользователя (этап 54, В-2.15). Флаг вешается на переведённое
 * исключение, потому что наружу уходит уже оно, а не исходная ошибка axios.
 */
const CHARGED = Symbol('chargedByGoogle');

function markCharged(error: HttpException, charged: boolean): HttpException {
  (error as HttpException & { [CHARGED]?: boolean })[CHARGED] = charged;
  return error;
}

export function chargedByGoogle(error: unknown): boolean {
  return Boolean((error as { [CHARGED]?: boolean } | null)?.[CHARGED]);
}
