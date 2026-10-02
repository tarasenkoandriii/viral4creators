/**
 * Типы модуля `site-crawl` — стык между агентами Э1 (контракт Э1, §«Стыки»).
 * Менять форму — только через координатора: от неё зависят индексация
 * (K2: assist-*-knowledge) и песочница (K3: assist-sandbox).
 *
 * site-crawl ОБЩИЙ с QA (ТЗ помощника §4.2): ничего не знает о продуктах,
 * пишет только `site_pages`, `site_crawl_*`, кэш robots.
 */

import type { PrismaClient } from '@prisma/client';
import type { HostPurpose } from '../site-core/ownership/host-access';
import type { UiMapElement } from '../site-core/ui-map/ui-map';

/** Блок основного текста страницы — вход чанкера (assist-knowledge-core). */
export type ExtractedBlockType = 'h' | 'p' | 'li' | 'tr' | 'faq' | 'pre';

export interface ExtractedBlock {
  t: ExtractedBlockType;
  /** Текст блока, нормализованные пробелы, без HTML. `tr` — «Заголовок: значение; …». */
  text: string;
  /** Уровень заголовка 1–6 (только `t = 'h'`). */
  level?: number;
  /** Путь заголовков-предков: ['Доставка', 'По Украине']. */
  path: string[];
  /** Отзыв/комментарий посетителя сайта (§6.5 п.3) — пониженный вес. */
  ugc?: true;
}

/** Результат извлечения основного контента (без меню/футера/куки-баннеров). */
export interface ExtractedPage {
  /** Нормализованный URL страницы (после редиректов того же хоста). */
  url: string;
  title: string | null;
  /** `<html lang>` или эвристика по буквам: 'uk' | 'ru' | 'en' | … */
  lang: string | null;
  /** Основной текст целиком (блоки через \n) — для хеша и для QA. */
  text: string;
  blocks: ExtractedBlock[];
  /** SHA-256 hex нормализованного `text`. */
  contentHash: string;
  /** Ссылки страницы: абсолютные, нормализованные (url.ts), https. */
  links: string[];
  /** `<meta name="robots" content="noindex">` или X-Robots-Tag. */
  noindex: boolean;
  canonical: string | null;
  /** `<meta name="theme-color">` — фон публичной песочницы без скриншота. */
  themeColor: string | null;
  /**
   * Э6: карта интерфейса страницы (кнопки, ссылки своего сайта, поля) —
   * extract/ui-map.ts; обход пишет её в `site_ui_maps` (источник `crawl`).
   */
  uiElements?: UiMapElement[];
}

export type SkipReason =
  | 'robots'
  | 'noindex'
  | 'not_html'
  | 'too_large'
  | 'redirect_offsite'
  | 'ssrf'
  | 'excluded'
  | 'limit'
  | 'http_4xx'
  | 'http_5xx'
  | 'timeout'
  | 'empty'
  | 'duplicate'
  | 'opted_out'
  | 'unverified_host'
  | 'not_https'
  /** Текст рисуется скриптами (SPA): в Э1 не рендерим — ждём воркер QA. */
  | 'spa';

/** Опции IP-pinned запроса (net/pinned-fetch.ts). */
export interface PinnedFetchOptions {
  method?: 'GET' | 'HEAD';
  headers?: Record<string, string>;
  /** Тело больше — `BodyTooLargeError` (поток обрывается, память ограничена). */
  maxBytes: number;
  timeoutMs: number;
  /** Каждый хоп — заново резолв, проверка, pin. 0 — редирект не идём. */
  maxRedirects: number;
  /** true — редирект на другой origin = `RedirectOffsiteError`. */
  sameOrigin: boolean;
  /**
   * true — тело длиннее `maxBytes` обрезается, а не бросает (проверка меты
   * владения: `<head>` в начале страницы, а главная легко больше лимита).
   */
  truncateAtMaxBytes?: boolean;
}

export interface PinnedResponse {
  /** Финальный URL (после редиректов). */
  url: string;
  status: number;
  /** Заголовки в нижнем регистре. */
  headers: Record<string, string>;
  body: Buffer;
  /** Пройденные редиректы (URL), по порядку. */
  redirects: string[];
  /** IP, к которому реально подключились на последнем хопе. */
  ip: string;
}

/** Условный запрос (§4-тер.2): неизменённая страница — 304 без тела. */
export interface ConditionalHeaders {
  etag?: string | null;
  lastModified?: string | null;
}

export type FetchPageResult =
  | {
      ok: true;
      page: ExtractedPage;
      httpStatus: number;
      etag: string | null;
      lastModified: string | null;
    }
  | {
      ok: false;
      /** 304 по условному запросу — не ошибка, страница не изменилась. */
      notModified?: true;
      reason?: SkipReason;
      httpStatus?: number;
    };

/**
 * Клиент БД, которого достаточно fetcher'у: кэш robots и отказ доменов.
 * И `PrismaService` (крон обхода), и `AssistPublicDb` (публичная песочница
 * под ролью assist_public — GRANT в миграции …_assist_knowledge) подходят.
 */
export type CrawlCacheDb = Pick<
  PrismaClient,
  'siteCrawlRobots' | 'siteOptOutDomain'
>;

export interface FetchPageOptions {
  /** Назначение (уровень допуска ядра): `assist-crawl` | `assist-sandbox` | `qa-*`. */
  purpose: HostPurpose;
  db: CrawlCacheDb;
  conditional?: ConditionalHeaders;
  /** Пауза между запросами к одному хосту (вежливость, §3.4 / лендинг §6.3). */
  minDelayMsPerHost?: number;
}

export interface RobotsRules {
  isAllowed(url: string): boolean;
  crawlDelayMs: number | null;
  sitemaps: string[];
}

export interface SitemapEntry {
  url: string;
  lastmod: Date | null;
}

/** Запрос прогона обхода от продукта. */
export interface CrawlRequest {
  accountId: string;
  siteId: string;
  product: 'assist' | 'qa';
  trigger: 'initial' | 'schedule' | 'manual' | 'webhook' | 'hot';
  /** full — sitemap/ссылки; hot — только `urls` условным запросом; urls — список. */
  mode: 'full' | 'hot' | 'urls';
  maxPages: number;
  urls?: string[];
  /** Исключения продукта (§4-тер.12): эти URL/префиксы не обходим вовсе. */
  excludePrefixes?: string[];
  /** Исключения «ровно этот URL» (без подстраниц). */
  excludeUrls?: string[];
  requestedByTelegramId?: bigint;
}

export interface CrawlRunView {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  trigger: string;
  mode: string;
  pagesSeen: number;
  pagesChanged: number;
  pagesUnchanged: number;
  pagesSkipped: number;
  pagesFailed: number;
  pagesGone: number;
  /** Пропущенные по причинам: { robots: 3, noindex: 2, … }. */
  skippedByReason: Partial<Record<SkipReason, number>>;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

export interface CrawlTickResult {
  runsTouched: number;
  pagesFetched: number;
  pagesChanged: number;
  finishedRunIds: string[];
  /** Тик упёрся в бюджет времени — продолжит следующий. */
  budgetExhausted: boolean;
}
