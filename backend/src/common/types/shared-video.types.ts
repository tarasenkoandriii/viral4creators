/**
 * Публичная страница готового ролика и петля шеринга (ТЗ §40, этап 60,
 * doc/TODO.md §III.1). Mirrored in frontend/src/types,
 * admin/src/lib/types.ts и landing/src/lib/shared-video-api.ts.
 *
 * Тот же паттерн снимка, что и у `PublicationRequest`
 * (backend/src/common/types/publication.types.ts): строка переживает
 * TTL-уборку сессии, потому что копирует всё нужное при создании и не
 * держит FK на `Session`.
 */

export type SharedVideoStatus = 'PENDING' | 'PUBLISHED' | 'REJECTED';

/** Полная проекция — владельцу страницы и оператору модерации. */
export interface SharedVideoPageView {
  id: string;
  userId: string;
  sessionId: string;
  generatedVideoId: string;
  status: SharedVideoStatus;
  videoUrl: string;
  aspectRatio: string | null;
  title: string;
  productName: string;
  productDescription: string | null;
  price: number | null;
  currency: string | null;
  category: string | null;
  productImageUrl: string | null;
  locale: string;
  moderatorId: string | null;
  moderatedAt: string | null;
  rejectReason: string | null;
  viewCount: number;
  firstGenerationCount: number;
  /** Лента (этап 80, TODO §III.9) — см. doc/SOCIAL-FEED-SPEC.md §3.1. */
  likeCount: number;
  shareCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SharedVideoListResult {
  items: SharedVideoPageView[];
  total: number;
  page: number;
  pageSize: number;
  /** Число PENDING вне фильтра — бейдж в навигации админки. */
  pending: number;
}

/**
 * Публичная проекция — GET /shared-video/:id, читает landing (OG-теги +
 * плеер). Без внутренних id (userId/sessionId/generatedVideoId) и без
 * состояния модерации: посетителю страницы это знать незачем.
 */
export interface SharedVideoPublicView {
  id: string;
  videoUrl: string;
  aspectRatio: string | null;
  title: string;
  productName: string;
  productDescription: string | null;
  price: number | null;
  currency: string | null;
  category: string | null;
  productImageUrl: string | null;
  locale: string;
  viewCount: number;
  likeCount: number;
  shareCount: number;
  createdAt: string;
}

/**
 * Лента (этап 80, TODO §III.9, doc/SOCIAL-FEED-SPEC.md §4) —
 * GET /shared-video/feed. Та же публичная проекция + флаг «уже лайкнул
 * этот вошедший пользователь» (только если identity была — см. §4:
 * маршрут без гварда, `req.telegramUserId` заполняется опционально).
 */
export interface SharedVideoFeedItemView extends SharedVideoPublicView {
  likedByViewer: boolean;
}

export interface SharedVideoFeedResult {
  items: SharedVideoFeedItemView[];
  /** id последней страницы страницы — передать назад в `cursor` за
   * следующей порцией; null — дальше ленты нет. */
  nextCursor: string | null;
}
