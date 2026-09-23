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

export type PortfolioItemStatus = 'PENDING' | 'PUBLISHED' | 'REJECTED' | 'SOLD';
export type PortfolioItemSourceType = 'SELF_UPLOAD' | 'CONTRACT';
/** Водяной знак на публичном превью (ТЗ на маркетплейс §9/§22, защита от пиратства). */
export type WatermarkModeValue = 'SITE_NAME' | 'CUSTOM' | 'NONE';
export type WatermarkIntensityValue = 'SLIGHT' | 'STANDARD' | 'STRONG';
export type WatermarkStatusValue =
  | 'PENDING'
  | 'PROCESSING'
  | 'READY'
  | 'FAILED'
  | 'SKIPPED';

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
  /**
   * Настройки и статус водяного знака (ТЗ на маркетплейс §9/§22) —
   * видны только владельцу; на публичных маршрутах videoUrl уже сам по
   * себе резолвится в защищённую версию (common/watermark.ts,
   * publicVideoUrl), эти поля туда не идут — незачем.
   */
  watermarkMode: WatermarkModeValue;
  watermarkText: string | null;
  watermarkIntensity: WatermarkIntensityValue;
  watermarkStatus: WatermarkStatusValue;
  /**
   * Аудит-фикс: обещаны комментарием у AuctionListing.portfolioItem
   * («те же данные, что показываются владельцу карточкой «Продано» на
   * /my-portfolio») ещё в Этапе 1 аукциона, но ни разу не попадали в
   * этот тип — карточку «Продано» было нечем заполнить.
   */
  soldAt: string | null;
  soldPrice: number | null;
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

// ── Аукцион готовых видео (ТЗ на маркетплейс §22, Этап 2) ────────────────
// Отдельный, более лёгкий контур от Тендера (Фаза 2, остаётся отложен до
// сигнала §19.4) — свой AuctionPayment, без Contract/Escrow «Сейф 5%».

export type AuctionTypeValue = 'BLITZ' | 'STANDARD';
/** Валюта выплаты продавцу (§22) — задаёт смысл всех цен лота, без конвертации между участниками торгов. */
export type AuctionCurrencyValue = 'UAH' | 'USD' | 'EUR';
export type AuctionListingStatusValue =
  | 'PENDING_MODERATION'
  | 'QUEUED'
  | 'ACTIVE'
  | 'WON'
  | 'EXPIRED'
  | 'REJECTED'
  | 'WITHDRAWN';

/** Полная карточка — видна только владельцу (creator) через GET /auctions/mine. */
export interface AuctionListingView {
  id: string;
  creatorProfileId: string;
  portfolioItemId: string;
  brandManifestId: string | null;
  includeBrandManifest: boolean;
  auctionType: AuctionTypeValue;
  payoutCurrency: AuctionCurrencyValue;
  /** §22.6 — когда исполнитель подтвердил право на эксклюзивную перепродажу. */
  rightsConfirmedAt: string;
  expiresAt: string | null;
  aiAssessment: string | null;
  brandManifestAiAudit: string | null;
  startingPrice: number;
  reservePrice: number | null;
  buyNowPrice: number | null;
  status: AuctionListingStatusValue;
  highestBidAmount: number | null;
  bidCount: number;
  createdAt: string;
  /**
   * Антиснайпер (ТЗ на живой аукцион §7.3) — явный чекбокс продавца при
   * подаче заявки, не поведение по умолчанию (по запросу, отклонение от
   * исходного ТЗ). false = торги закрываются строго по expiresAt.
   */
  antiSnipeEnabled: boolean;
  /** Сколько раз реально продлился expiresAt антиснайпером (0, если antiSnipeEnabled: false). */
  extensions: number;
  /**
   * Живой аукцион (ТЗ на живой аукцион §7.8, ПРАВКА 1.4) — явный
   * чекбокс продавца при подаче заявки, тот же приём, что
   * antiSnipeEnabled. Без него оператор не может назначить студию
   * этому лоту, даже для BLITZ (см. AuctionService.assignVirtualStudio).
   */
  liveStreamOptIn: boolean;
  /** Живой аукцион (§7.8) — какая студия назначена лоту оператором, null — ещё не назначена. */
  virtualStudioId: string | null;
  /** Живой аукцион (§7.5) — идёт ли сейчас трансляция (эфир мог свернуться авто-сворачиванием, торги при этом продолжаются). */
  liveStreamActive: boolean;
}

/**
 * Карточка на /auctions и /auctions/:id — только ACTIVE-лоты (§22, «не
 * должна оставлять мёртвые публичные ссылки»). Ни aiAssessment, ни
 * reservePrice не отдаются — резерв не должен быть виден покупателю
 * буквально (§22, «Три разные цены»), только факт «резерв не достигнут»
 * постфактум для EXPIRED, которые сюда и не попадают.
 */
export interface PublicAuctionListingView {
  id: string;
  creatorProfileId: string;
  creatorDisplayName: string | null;
  portfolioItemId: string;
  title: string;
  videoUrl: string;
  thumbnailUrl: string | null;
  /** true ⇒ бейдж «Эксклюзив» (§22.1). */
  isExclusiveBundle: boolean;
  auctionType: AuctionTypeValue;
  payoutCurrency: AuctionCurrencyValue;
  startingPrice: number;
  buyNowPrice: number | null;
  highestBidAmount: number | null;
  bidCount: number;
  expiresAt: string;
  /**
   * Антиснайпер включён продавцом (§7.3) — сообщается покупателям
   * заранее, до ставки: знать, что поздняя ставка продлит торги, а не
   * просто «повезло успеть», влияет на их собственную стратегию ставок.
   */
  antiSnipeEnabled: boolean;
  /** Сколько раз уже продлевались торги — видимый сигнал активности лота покупателю. */
  extensions: number;
}

export interface BidView {
  id: string;
  listingId: string;
  amount: number;
  createdAt: string;
}

/**
 * GET /auctions/my-bids — закрывает реальный пробел: победитель обычных
 * торгов (не «купить сейчас») иначе никак не узнаёт, что выиграл, и не
 * может перейти к оплате (§22, страница лота 404-ится сразу после WON).
 */
export interface MyBidView {
  listingId: string;
  title: string;
  thumbnailUrl: string | null;
  /** Лучшая ставка ЭТОГО покупателя на этот лот, не обязательно выигравшая. */
  myBidAmount: number;
  listingStatus: AuctionListingStatusValue;
  isWinner: boolean;
  /** Актуально только когда isWinner — оплачен ли уже AuctionPayment. */
  paymentPaid: boolean;
}

/** Живой аукцион (ТЗ на живой аукцион §7, Этап 5) — одна подсказка озвучки, готовая к воспроизведению. */
export interface AuctionLiveVoiceCueView {
  id: string;
  seq: number;
  kind: 'LOT_DESC' | 'INVITE' | 'PRAISE' | 'BID_STATS';
  audioUrl: string;
  createdAt: string;
}

/**
 * GET /auctions/:id/state — снимок эфира для клиента, подключившегося
 * позже начала (§7.6). Не ограничен статусом ACTIVE — см. доккомментарий
 * AuctionService.getLiveState.
 *
 * Аудит (сверка с SilverFinance, `liveStream.ts`'s `getStreamState()` +
 * `BlitzStream.tsx`) — версия этого поля до аудита отдавала только
 * `lastCue` (одну последнюю готовую подсказку). Этого достаточно, чтобы
 * показать «текущую» реплику, но НЕДОСТАТОЧНО для плеера, который должен
 * прокручивать pregen-подсказки (LOT_DESC/INVITE/PRAISE) по кругу в паузах
 * между ставками — единственный источник этого списка. SilverFinance для
 * той же задачи отдаёт клиенту весь готовый плейлист клипов, а не только
 * «последний» — клиент сам крутит ротацию (см. их `BlitzStream.tsx`,
 * `pickNext()`). `cues` ниже — тот же приём: упорядоченный по `seq` список
 * готовых подсказок (pregen и уже случившиеся BID_STATS), из которого
 * клиент строит собственную ротацию/шаффл.
 */
export interface AuctionLiveStateView {
  listingId: string;
  status: AuctionListingStatusValue;
  liveStreamActive: boolean;
  /** Этап 6 (§7.8) — `BroadcastEvent.startDate` для JSON-LD на странице лота. null, если эфир ещё не начинался. */
  liveStreamStartedAt: string | null;
  expiresAt: string | null;
  highestBidAmount: number | null;
  bidCount: number;
  /** null, если студия не назначена или у неё ещё нет готового видео-фрагмента. */
  videoUrl: string | null;
  /**
   * Готовые подсказки озвучки, упорядоченные по `seq` (не более
   * последних ~50 — playlist, не полная история лота с сотнями ставок).
   * Пустой массив, если для лота ещё не сгенерировано ни одной.
   */
  cues: AuctionLiveVoiceCueView[];
}

export interface AdminAuctionListingView extends AuctionListingView {
  creatorDisplayName: string | null;
  portfolioItemTitle: string;
  portfolioItemVideoUrl: string;
  /**
   * Информационная UAH-оценка текущей цены лота (highestBidAmount либо
   * startingPrice, если ставок ещё нет) через common/fx-rates.ts
   * (convertForDisplay, статичный курс) — только для оператора, чтобы
   * сравнивать на глаз лоты в разных валютах в очереди модерации. null,
   * когда payoutCurrency уже UAH (конвертация в саму себя не несёт
   * информации) — НЕ авторитетная сумма сделки, платёж всегда идёт в
   * payoutCurrency лота.
   */
  currentPriceUahEquivalent: number | null;
}

export interface AdminAuctionListResult {
  items: AdminAuctionListingView[];
  total: number;
  page: number;
  pageSize: number;
}
