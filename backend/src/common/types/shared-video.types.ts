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

import { GreetingOccasion } from './greeting.types';

export type SharedVideoStatus = 'PENDING' | 'PUBLISHED' | 'REJECTED';

/**
 * Витрина (этап 1 плана docs-tz/AUDIT-Greeting-Landing-And-Upgrade-Plan.md).
 * `projectType`/`occasion` — снимок того, ИЗ ЧЕГО сделан ролик; NULL у
 * `projectType` означает товарный ролик (см. доккомментарий колонки в
 * schema.prisma — почему это доказуемо, а не предположительно).
 */
export interface SharedVideoOriginFields {
  projectType: 'SINGLE' | 'LINE' | 'CLIENT_SITE' | 'GREETING_VIDEO' | null;
  occasion: GreetingOccasion | null;
  /** Производное от `showcasedAt`: страница отобрана оператором в
   * публичную витрину. Наружу отдаётся булево — ровно тот контракт, что
   * просит §5 ТЗ лендинга; время отбора остаётся внутри. */
  featured: boolean;
}

/** Полная проекция — владельцу страницы и оператору модерации. */
export interface SharedVideoPageView extends SharedVideoOriginFields {
  id: string;
  userId: string;
  sessionId: string;
  generatedVideoId: string;
  status: SharedVideoStatus;
  videoUrl: string;
  aspectRatio: string | null;
  title: string;
  /** NULL у поздравлений — у них нет товара (находка 1.1 аудита). */
  productName: string | null;
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
export interface SharedVideoPublicView extends SharedVideoOriginFields {
  id: string;
  videoUrl: string;
  aspectRatio: string | null;
  title: string;
  /**
   * Кадр-постер: `og:image` страницы и `poster` у `<video>`. NULL —
   * нормальное состояние (постер делается best-effort при публикации),
   * и лендинг подставляет запасную картинку.
   */
  posterUrl: string | null;
  /** NULL у поздравлений — у них нет товара (находка 1.1 аудита). */
  productName: string | null;
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

/**
 * Витрина поздравлений на лендинге — GET /shared-video/showcase
 * (§5 ТЗ лендинга). Отдельно от ленты (`SharedVideoFeedResult`): у
 * витрины нет ни зрителя, ни лайков, зато есть фильтры по типу проекта
 * и поводу, а отбор идёт по кураторской отметке оператора, а не по
 * одному лишь статусу PUBLISHED.
 */
export interface SharedVideoShowcaseResult {
  items: SharedVideoPublicView[];
  nextCursor: string | null;
}
