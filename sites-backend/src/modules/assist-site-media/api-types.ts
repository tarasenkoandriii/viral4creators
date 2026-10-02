/**
 * Формы API Э6 «видео и подсветка» (кабинет TMA помощника) — повтор в
 * `assist/src/lib/media-api.ts` (сверяет его тест разбора).
 */

/** Ролик обучалки на экране «Видео» TMA. */
export interface SiteVideoView {
  id: string;
  title: string;
  locale: string;
  durationMs: number | null;
  /** Снят за логином / на не подтверждённом хосте — посетителям нельзя. */
  requiresLogin: boolean;
  /** «Показывать в виджете» — решение владельца. */
  enabled: boolean;
  syncedAt: string;
}

/** GET /assist/sites/:id/videos */
export interface SiteVideosView {
  siteId: string;
  /** Видео в ответах — возможность тарифа (Business+). */
  planAllowsVideo: boolean;
  videos: SiteVideoView[];
  /** Deep-link «Снять новое обучение» в визард обучалки генератора; null — не настроен. */
  tutorialLink: string | null;
  /** Карта интерфейса сайта: страниц в карте, с сигналом «карта устарела». */
  uiMap: {
    pages: number;
    stalePages: number;
    lastCapturedAt: string | null;
  };
}

/** PATCH /assist/sites/:id/videos/:vid */
export interface SiteVideoPatch {
  enabled: boolean;
}

export type MediaCabinetErrorCode =
  | 'SITE_NOT_FOUND'
  | 'VIDEO_NOT_FOUND'
  | 'VIDEO_PATCH_INVALID'
  | 'VIDEO_REQUIRES_LOGIN'
  | 'VIDEO_PLAN_REQUIRED';
