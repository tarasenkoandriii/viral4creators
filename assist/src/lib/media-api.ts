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
  uiMap: { pages: number; stalePages: number; lastCapturedAt: string | null };
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
      lastCapturedAt: str(m.lastCapturedAt),
    },
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
    setEnabled: async (id, vid, enabled) => {
      const v = parseVideo(
        await client.request('PATCH', `${p(id)}/${seg(vid)}`, { enabled })
      );
      if (!v) throw new ApiError('BAD_RESPONSE', 'bad response', 0);
      return v;
    },
  };
}
