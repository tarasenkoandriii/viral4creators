/**
 * Экран «Видео» Э6 (ТЗ помощника §4.11: «список роликов сайта,
 * переключатель „показывать в виджете“, кнопка „снять новое обучение“») —
 * повтор типов `sites-backend/src/modules/assist-site-media/api-types.ts`
 * (сверку держит scripts/media-api.test.ts) и клиент
 * `/assist/sites/:id/videos`. Разбор строгий, как у остальных экранов.
 */
import { ApiError, type ApiClient } from '../kit';
import { arr, count, obj, str, text } from './widget-api';

export interface SiteVideoView {
  id: string;
  title: string;
  locale: string;
  durationMs: number | null;
  requiresLogin: boolean;
  enabled: boolean;
  syncedAt: string;
}

export interface SiteVideosView {
  siteId: string;
  planAllowsVideo: boolean;
  videos: SiteVideoView[];
  tutorialLink: string | null;
  uiMap: {
    pages: number;
    stalePages: number;
    /** Э-С Ш4: устаревших элементов (порог промахов по виду вёрстки). */
    staleElements: number;
    lastCapturedAt: string | null;
  };
}

// ── Э-С Ш4: общая карта интерфейса (GET /assist/sites/:id/ui-map) ────────

export const UI_MAP_SOURCES = [
  'crawl',
  'tutorial',
  'loader',
  'qa',
  'manual',
] as const;
export type UiMapSource = (typeof UI_MAP_SOURCES)[number];
export const UI_MAP_VIEWPORTS = ['any', 'desktop', 'mobile'] as const;
export type UiMapViewport = (typeof UI_MAP_VIEWPORTS)[number];

export interface SiteUiMapStaleElement {
  label: string;
  tag: string;
  viewport: 'desktop' | 'mobile' | 'both';
  staleAt: string;
}

export interface SiteUiMapPage {
  host: string;
  path: string;
  viewports: UiMapViewport[];
  sources: UiMapSource[];
  elements: number;
  staleElements: number;
  stale: SiteUiMapStaleElement[];
  lastCapturedAt: string | null;
}

export interface SiteUiMapView {
  siteId: string;
  pages: number;
  elements: number;
  staleElements: number;
  stalePages: number;
  bySource: Partial<Record<UiMapSource, number>>;
  byStability: { strong: number; medium: number; fragile: number };
  lastCapturedAt: string | null;
  items: SiteUiMapPage[];
  truncated: boolean;
  /** Э6-бис (г): точечный переобход устаревших страниц (null — сервер не прислал). */
  recrawl: SiteUiRecrawlView | null;
}

export interface SiteUiRecrawlView {
  perDay: number;
  today: number;
  recent: Array<{
    host: string;
    path: string;
    status: 'requested' | 'budget';
    staleElements: number;
    createdAt: string;
  }>;
}

export function parseUiRecrawl(v: unknown): SiteUiRecrawlView | null {
  if (!v || typeof v !== 'object') return null;
  const o = obj(v);
  return {
    perDay: count(o.perDay),
    today: count(o.today),
    recent: arr(o.recent)
      .map((x) => {
        const r = obj(x);
        const status =
          r.status === 'budget'
            ? 'budget'
            : r.status === 'requested'
              ? 'requested'
              : null;
        const createdAt = str(r.createdAt);
        if (!status || !createdAt) return null;
        return {
          host: text(r.host),
          path: text(r.path),
          status,
          staleElements: count(r.staleElements),
          createdAt,
        } as const;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .slice(0, 20),
  };
}

export const MEDIA_CABINET_ERROR_CODES = [
  'SITE_NOT_FOUND',
  'VIDEO_NOT_FOUND',
  'VIDEO_PATCH_INVALID',
  'VIDEO_REQUIRES_LOGIN',
  'VIDEO_PLAN_REQUIRED',
] as const;
export type MediaCabinetErrorCode = (typeof MEDIA_CABINET_ERROR_CODES)[number];

const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Deep-link в визард обучалки генератора — только https t.me/… */
const TUTORIAL_LINK =
  /^https:\/\/t\.me\/[A-Za-z0-9_]{3,64}(\/[A-Za-z0-9_]{1,64})?\?startapp=cst_[A-Za-z0-9_-]{1,59}$/;

export function parseVideo(v: unknown): SiteVideoView | null {
  const o = obj(v);
  if (typeof o.id !== 'string' || !ID.test(o.id)) return null;
  return {
    id: o.id,
    title: text(o.title).slice(0, 200),
    locale: text(o.locale).slice(0, 8),
    durationMs:
      typeof o.durationMs === 'number' && Number.isFinite(o.durationMs)
        ? Math.max(0, o.durationMs)
        : null,
    // Закрытый отказ: признак не пришёл — «за логином».
    requiresLogin: o.requiresLogin !== false,
    enabled: o.enabled === true,
    syncedAt: text(o.syncedAt),
  };
}

export function parseSiteVideos(v: unknown): SiteVideosView {
  const o = obj(v);
  const m = obj(o.uiMap);
  const link = str(o.tutorialLink);
  return {
    siteId: text(o.siteId),
    planAllowsVideo: o.planAllowsVideo === true,
    videos: arr(o.videos)
      .map(parseVideo)
      .filter((x): x is SiteVideoView => x !== null),
    tutorialLink: link && TUTORIAL_LINK.test(link) ? link : null,
    uiMap: {
      pages: count(m.pages),
      stalePages: count(m.stalePages),
      staleElements: count(m.staleElements),
      lastCapturedAt: str(m.lastCapturedAt),
    },
  };
}

function member<T extends string>(list: readonly T[], v: unknown): T | null {
  return typeof v === 'string' && (list as readonly string[]).includes(v)
    ? (v as T)
    : null;
}

/** Подпись и путь — текст чужого сайта: только строка, обрезанная. */
function parseStale(v: unknown): SiteUiMapStaleElement | null {
  const o = obj(v);
  const viewport = member(['desktop', 'mobile', 'both'] as const, o.viewport);
  const label = text(o.label).slice(0, 80);
  if (!viewport || !label) return null;
  return {
    label,
    tag: text(o.tag).slice(0, 16),
    viewport,
    staleAt: text(o.staleAt),
  };
}

function parsePage(v: unknown): SiteUiMapPage | null {
  const o = obj(v);
  const host = text(o.host).slice(0, 253);
  const path = text(o.path).slice(0, 300);
  if (!host || !path.startsWith('/')) return null;
  return {
    host,
    path,
    viewports: arr(o.viewports)
      .map((x) => member(UI_MAP_VIEWPORTS, x))
      .filter((x): x is UiMapViewport => x !== null),
    sources: arr(o.sources)
      .map((x) => member(UI_MAP_SOURCES, x))
      .filter((x): x is UiMapSource => x !== null),
    elements: count(o.elements),
    staleElements: count(o.staleElements),
    stale: arr(o.stale)
      .map(parseStale)
      .filter((x): x is SiteUiMapStaleElement => x !== null)
      .slice(0, 5),
    lastCapturedAt: str(o.lastCapturedAt),
  };
}

export function parseSiteUiMap(v: unknown): SiteUiMapView {
  const o = obj(v);
  const bs = obj(o.bySource);
  const st = obj(o.byStability);
  const bySource: Partial<Record<UiMapSource, number>> = {};
  for (const k of UI_MAP_SOURCES)
    if (bs[k] !== undefined) bySource[k] = count(bs[k]);
  return {
    siteId: text(o.siteId),
    pages: count(o.pages),
    elements: count(o.elements),
    staleElements: count(o.staleElements),
    stalePages: count(o.stalePages),
    bySource,
    byStability: {
      strong: count(st.strong),
      medium: count(st.medium),
      fragile: count(st.fragile),
    },
    lastCapturedAt: str(o.lastCapturedAt),
    items: arr(o.items)
      .map(parsePage)
      .filter((x): x is SiteUiMapPage => x !== null)
      .slice(0, 50),
    truncated: o.truncated === true,
    recrawl: parseUiRecrawl(o.recrawl),
  };
}

/** Код ошибки экрана → ключ словаря; иначе null (общий перевод ошибок). */
export function mediaErrorCode(e: unknown): MediaCabinetErrorCode | null {
  return e instanceof ApiError &&
    (MEDIA_CABINET_ERROR_CODES as readonly string[]).includes(e.code)
    ? (e.code as MediaCabinetErrorCode)
    : null;
}

/** Длительность «0:42». */
export function duration(ms: number | null): string {
  if (ms === null) return '';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export interface MediaApi {
  list(siteId: string): Promise<SiteVideosView>;
  /** Э-С Ш4: сводка общей карты интерфейса. */
  uiMap(siteId: string): Promise<SiteUiMapView>;
  setEnabled(
    siteId: string,
    videoId: string,
    enabled: boolean
  ): Promise<SiteVideoView>;
}

function seg(id: string): string {
  if (!ID.test(id)) throw new Error('bad id');
  return id;
}

export function createMediaApi(client: ApiClient): MediaApi {
  const p = (id: string) => `/assist/sites/${seg(id)}/videos`;
  return {
    list: async (id) => parseSiteVideos(await client.request('GET', p(id))),
    uiMap: async (id) =>
      parseSiteUiMap(
        await client.request('GET', `/assist/sites/${seg(id)}/ui-map`)
      ),
    setEnabled: async (id, vid, enabled) => {
      const v = parseVideo(
        await client.request('PATCH', `${p(id)}/${seg(vid)}`, { enabled })
      );
      if (!v) throw new ApiError('BAD_RESPONSE', 'bad response', 0);
      return v;
    },
  };
}
