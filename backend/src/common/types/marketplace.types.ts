/**
 * View types for the Этап 0 / Фаза 1 marketplace slice (ТЗ на маркетплейс
 * §9, §19–§21; ТЗ на бэкенд §3, §8) plus §20 (публикация/шеринг). Structural
 * row/view types kept separate from Prisma's generated types — see
 * project.service.ts for why.
 *
 * Tender/Submission/Contract/Escrow types deliberately do NOT exist here —
 * that whole contour is Фаза 2, gated on the demand signal from §19.4.
 */

export interface CreatorSocialLinkView {
  id: string;
  platform: string;
  url: string;
}

export interface CreatorProfileView {
  id: string;
  userId: string;
  /** From User.firstName/username at read time — not stored on the profile itself. */
  displayName: string | null;
  /** §20 №1 — vanity-ссылка; null, если не задана (доступ по id продолжает работать). */
  slug: string | null;
  niches: string[];
  priceRangeMin: number | null;
  priceRangeMax: number | null;
  bio: string | null;
  isAcceptingOrders: boolean;
  contactHandle: string | null;
  socialLinks: CreatorSocialLinkView[];
  /** §20 №13 — публичный счётчик просмотров профиля. */
  viewCount: number;
  /** §20 №19 — редакционный бейдж, выставляется только оператором. */
  isFeatured: boolean;
  createdAt: string;
}

export interface CreatorCatalogPortfolioPreview {
  id: string;
  thumbnailUrl: string | null;
  videoUrl: string;
}

/** GET /creators — one row of the public catalog/directory (§9). */
export interface CreatorCatalogItemView {
  id: string;
  slug: string | null;
  displayName: string | null;
  niches: string[];
  priceRangeMin: number | null;
  priceRangeMax: number | null;
  isFeatured: boolean;
  portfolioPreview: CreatorCatalogPortfolioPreview[];
}

export interface CreatorCatalogResult {
  items: CreatorCatalogItemView[];
  nextCursor: string | null;
}

/** §20 №17 — «похожие креаторы», по пересечению ниш. */
export interface SimilarCreatorView {
  id: string;
  displayName: string | null;
  niches: string[];
}

export type PortfolioItemStatus = 'PENDING' | 'PUBLISHED' | 'REJECTED';
export type PortfolioItemSourceType = 'SELF_UPLOAD' | 'CONTRACT';

export interface PortfolioItemView {
  id: string;
  creatorProfileId: string;
  sourceType: PortfolioItemSourceType;
  videoUrl: string;
  title: string;
  thumbnailUrl: string | null;
  status: PortfolioItemStatus;
  likeCount: number;
  /** §20 №13 — публичный счётчик просмотров карточки. */
  viewCount: number;
  /** §20 №20 — тематическая подборка, если отнесена оператором/creator'ом. */
  collectionTag: string | null;
  /** Видна только владельцу через /portfolio-items/mine — на публичных маршрутах не отдаётся. */
  rejectionReason: string | null;
  /** Only meaningful when the caller is identified; false for anonymous viewers. */
  likedByViewer: boolean;
  createdAt: string;
}

/** §20 №17 — «похожие работы» под конкретной карточкой портфолио. */
export interface SimilarPortfolioItemView {
  id: string;
  creatorProfileId: string;
  title: string;
  thumbnailUrl: string | null;
  videoUrl: string;
}

/** §20 №11 — плоская лента новых опубликованных работ (RSS/JSON). */
export interface PortfolioFeedItemView {
  id: string;
  creatorProfileId: string;
  creatorDisplayName: string | null;
  title: string;
  videoUrl: string;
  thumbnailUrl: string | null;
  niches: string[];
  createdAt: string;
}

/** §20 №20 — одна тематическая подборка со своей ссылкой. */
export interface PortfolioCollectionSummaryView {
  tag: string;
  itemCount: number;
}

export interface AdminCreatorProfileItemView extends CreatorProfileView {
  portfolioItemCount: number;
}

export interface AdminCreatorProfileListResult {
  items: AdminCreatorProfileItemView[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AdminPortfolioListResult {
  items: PortfolioItemView[];
  total: number;
  page: number;
  pageSize: number;
}

/** §20 №14 — минимальная аналитика для самого исполнителя (не публичная). */
export interface CreatorStatsView {
  profileViewCount: number;
  totalPortfolioViews: number;
  totalLikes: number;
  itemCount: number;
}

export type CreatorInquiryStatus = 'DRAFT' | 'SENT' | 'CONTACTED';

export interface CreatorInquiryView {
  id: string;
  customerId: string;
  projectId: string | null;
  productDescription: string;
  isProductLine: boolean;
  goal: string | null;
  targetPlatform: string;
  budgetHint: number | null;
  brandManifestId: string | null;
  status: CreatorInquiryStatus;
  contactedCreatorId: string | null;
  createdAt: string;
}

/**
 * §21.3 — placeholder matching: filters the CreatorProfile catalog by
 * niche/price overlap with the inquiry. Wiring this into the real
 * `assistant`/`relevance`-style ranking (§16) is a follow-up, not part of
 * Этап 0's minimal slice.
 */
export interface CreatorInquiryMatchView {
  creatorProfileId: string;
  displayName: string | null;
  niches: string[];
  priceRangeMin: number | null;
  priceRangeMax: number | null;
  contactHandle: string | null;
  matchScore: number;
}

/** §21.4 — technical spec advice, keyed off the inquiry's targetPlatform. */
export interface FormatAdviceView {
  targetPlatform: string;
  aspectRatio: string;
  quality: 'fast' | 'standard';
  note: string;
}
