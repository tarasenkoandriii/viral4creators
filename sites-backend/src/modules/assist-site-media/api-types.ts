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
  /**
   * Карта интерфейса сайта: страниц в карте; Э-С Ш4 — страниц с устаревшими
   * элементами и самих таких элементов (порог промахов по виду вёрстки).
   */
  uiMap: {
    pages: number;
    stalePages: number;
    staleElements: number;
    lastCapturedAt: string | null;
  };
}

/** Э-С Ш4: элемент, устаревший для вида вёрстки (подпись — текст сайта). */
export interface SiteUiMapStaleElement {
  label: string;
  tag: string;
  viewport: 'desktop' | 'mobile' | 'both';
  staleAt: string;
}

export type SiteUiMapSource = 'crawl' | 'tutorial' | 'loader' | 'qa' | 'manual';
export type SiteUiMapViewport = 'any' | 'desktop' | 'mobile';

/** Э-С Ш4: страница общей карты интерфейса. */
export interface SiteUiMapPage {
  host: string;
  path: string;
  viewports: SiteUiMapViewport[];
  sources: SiteUiMapSource[];
  elements: number;
  staleElements: number;
  /** До 5 устаревших элементов страницы. */
  stale: SiteUiMapStaleElement[];
  lastCapturedAt: string | null;
}

/** GET /assist/sites/:id/ui-map — сводка общей карты интерфейса (Э-С Ш4). */
export interface SiteUiMapView {
  siteId: string;
  pages: number;
  elements: number;
  staleElements: number;
  stalePages: number;
  bySource: Partial<Record<SiteUiMapSource, number>>;
  byStability: { strong: number; medium: number; fragile: number };
  lastCapturedAt: string | null;
  /** Сначала страницы с устаревшими элементами (≤ 50). */
  items: SiteUiMapPage[];
  truncated: boolean;
  /**
   * Э6-бис (г), решение владельца п.4: точечный переобход страниц с
   * устаревшими элементами (по тарифу — страниц в сутки; за счёт бюджета
   * знаний). `recent` — последние 10 записей журнала.
   */
  recrawl?: {
    perDay: number;
    today: number;
    recent: Array<{
      host: string;
      path: string;
      status: 'requested' | 'budget';
      staleElements: number;
      createdAt: string;
    }>;
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
