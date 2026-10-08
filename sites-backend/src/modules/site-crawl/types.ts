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
  // `spa` — текст рисуется скриптами. С браузерным воркером (Ш3 (20)) такие
  // страницы прогона `assist` рендерятся, а причина остаётся, если рендер не
  // удался, не поставлен (воркер выключен, суточный лимит) или для QA.
  | 'spa';

/** Опции IP-pinned запроса (net/pinned-fetch.ts). */
export interface PinnedFetchOptions {
  /**
   * Э8: изменяющие методы — только для API-коннектора «Админки» и только с
   * `maxRedirects: 0` (тело не пересылается на другой адрес никогда).
   */
  method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  /** Тело запроса (JSON-текст) — только с изменяющим методом. */
  body?: string;
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
  /**
   * Р-З10-10: хосты сайта, которые прогон НЕ трогает вовсе — ни robots, ни
   * sitemap, ни страниц (ссылки на них — `skipped/excluded`). Хосты
   * «Админки» (`site_hosts.assistRole = admin`) у прогонов `assist`
   * добавляются сами (Р-З9-24).
   */
  excludeHosts?: string[];
  requestedByTelegramId?: bigint;
}

// ── Ш3 (20), Р-З10-20: рендер SPA браузерным воркером ───────────────────

/**
 * Запрос рендера страниц одного хоста. site-crawl очередь воркера не
 * импортирует (правила графа `crawl-product-neutral`/`browser-jobs-zone`):
 * порт реализует допущенный к очереди модуль и вешает его на
 * `SiteCrawlService.spaRender` (как `VoiceMapService.onVersionBuilt`).
 */
export interface SpaRenderRequest {
  accountId: string;
  siteId: string;
  hostId: string;
  /** Имя хоста (обход — только https:443, замок задания = имя). */
  host: string;
  runId: string;
  urls: string[];
}

export type SpaRenderTicket =
  | { jobId: string }
  /** Очередь сайта занята — попробовать на следующем тике. */
  | { retry: true }
  /** Не будет сегодня: воркер выключен, суточный лимит, хост, сбой. */
  | { refused: 'disabled' | 'limit' | 'host' | 'error' };

/** Страница рендера: `i` — номер адреса в запросе (адрес не от воркера). */
export interface SpaRenderedPage {
  i: number;
  ok: boolean;
  /** «Очищенный» HTML видимой страницы — вход того же `extractPage`. */
  html: string | null;
  /** Ссылки своего хоста (меню SPA рисуется скриптом). */
  links: string[];
}

export type SpaRenderPoll =
  /** `claimed` — воркер уже взял задание (идёт), иначе ждёт в очереди. */
  | { status: 'waiting'; claimed?: boolean }
  | { status: 'done'; pages: SpaRenderedPage[] }
  | { status: 'failed' };

export interface SpaRenderPort {
  request(r: SpaRenderRequest): Promise<SpaRenderTicket>;
  poll(accountId: string, jobId: string): Promise<SpaRenderPoll>;
  cancel(accountId: string, jobId: string): Promise<void>;
  /** Итог разобран — HTML в очереди больше не нужен (аудит P3 (6)). */
  release(accountId: string, jobId: string): Promise<void>;
  /**
   * Воркер жив: heartbeat очереди свежее `staleMs` (аудит P3 (7)) — без
   * него задание, которое никто не взял, не держит прогон 2 ч.
   */
  workerAlive(staleMs: number): Promise<boolean>;
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
