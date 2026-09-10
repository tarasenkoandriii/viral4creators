/**
 * Структурные типы блога (doc/TELEGRAM-ADMIN.md §5: "structural row types,
 * like every service here") — тот же приём, что library.types.ts.
 */
import {
  BlogPostStatus,
  BlogPostSource,
  BlogTranslationStatus,
} from '@prisma/client';

/** Карточка в списке — без полного тела (то же деление, что у библиотеки). */
export interface AdminBlogPostListItem {
  id: string;
  slug: string;
  status: BlogPostStatus;
  source: BlogPostSource;
  category: string;
  title: string;
  thumbnailUrl: string | null;
  score: number | null;
  originalLocale: string;
  publishedAt: string | null;
  createdAt: string;
  /** Сколько из четырёх не-оригинальных локалей уже готовы (READY). */
  translationsReady: number;
  translationsTotal: number;
}

export interface AdminBlogPostPage {
  items: AdminBlogPostListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AdminBlogTranslationView {
  locale: string;
  status: BlogTranslationStatus;
  title: string | null;
  bodyHtml: string | null;
  errorMessage: string | null;
  translatedAt: string | null;
}

export interface AdminBlogPostDetail extends AdminBlogPostListItem {
  bodyHtml: string;
  scoreReasoning: string | null;
  youtubeVideoId: string | null;
  youtubeChannelTitle: string | null;
  youtubeViewCount: number | null;
  moderatorId: string | null;
  moderatedAt: string | null;
  rejectReason: string | null;
  translations: AdminBlogTranslationView[];
}

/** Публичная витрина (этап 58 её использует; API уже готов). */
export interface PublicBlogPostListItem {
  slug: string;
  title: string;
  category: string;
  thumbnailUrl: string | null;
  publishedAt: string | null;
  /**
   * `false`, когда запрошенная локаль ещё не переведена и отдан оригинал
   * — solar-shop-урок §35.1: молчаливая подмена языка недопустима, витрина
   * обязана честно показать пометку "перевод скоро появится", а не
   * выдавать русский текст за перевод.
   */
  isRequestedLocale: boolean;
}

export interface PublicBlogPostPage {
  items: PublicBlogPostListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PublicBlogPostDetail extends PublicBlogPostListItem {
  bodyHtml: string;
  youtubeVideoId: string | null;
}
