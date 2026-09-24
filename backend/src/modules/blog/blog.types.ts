/** Состояние очереди перевода одной записи — см. `translationsState`. */
export type BlogTranslationsState =
  /** Черновик или отклонённая: переводов нет и не должно быть. */
  | 'not-started'
  /** Одобрена, но крон ещё не завёл строки — ближайшим прогоном заведёт. */
  | 'awaiting-cron'
  /** Часть в очереди xAI или переводится — ждать. */
  | 'in-progress'
  /** Все готовы. */
  | 'ready'
  /** Хотя бы один провалился — вот тут нужен человек. */
  | 'failed';

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
  /**
   * Что с переводами на самом деле. Число `готово/всего` на это не
   * отвечает: `0/4` одинаково у черновика, у только что одобренной
   * статьи, у стоящей в очереди xAI и у провалившейся навсегда — а
   * вмешательство человека нужно только в последнем случае.
   */
  translationsState: BlogTranslationsState;
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
