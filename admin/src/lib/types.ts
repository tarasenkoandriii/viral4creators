// Ответы backend/src/modules/admin-auth и backend/src/modules/admin-panel
// (см. doc/TELEGRAM-ADMIN.md) — держать в синхроне с
// AdminPanelService/AdminAuthService на бэкенде вручную, отдельного
// codegen в проекте нет.

export interface AdminMe {
  userId: string;
  isOperator: boolean;
}

export interface SessionSummary {
  sessionId: string;
  status: string;
  createdAt: string;
  lastActivityAt: string;
  userId: string | null;
  productName: string | null;
  hasGeneratedVideo: boolean;
  downloadUrl: string | null;
}

export interface SessionListResult {
  items: SessionSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export interface SessionDetail extends SessionSummary {
  data: unknown;
}

export interface TelemetryResult {
  total: number;
  byStatus: Record<string, number>;
  createdLast24h: number;
  createdLast7d: number;
  failedGenerations: number;
}

export type EnvSeverity = 'ok' | 'warning' | 'critical';

export interface EnvCheckResult {
  key: string;
  group: string;
  required: boolean;
  set: boolean;
  ok: boolean;
  severity: EnvSeverity;
  message: string;
  /** Only present for vars the backend considers non-secret — see env-settings.ts. */
  value?: string;
}

export interface EnvSettingsResult {
  checks: EnvCheckResult[];
  allOk: boolean;
}

// ── Озвучка по умолчанию (backend/src/modules/admin-panel/admin-voiceover-settings.service.ts) ──

export type VoiceoverProviderKey = 'elevenlabs' | 'resemble' | 'veo';

export interface VoiceoverProviderOptionView {
  key: VoiceoverProviderKey;
  /** Настроен ли ключ/аккаунт на этом стенде — у `veo` всегда `true`. */
  configured: boolean;
}

export interface VoiceoverProviderSettingsView {
  active: VoiceoverProviderKey;
  /** `admin` — задано явно в этом экране; `env-default` — стенд ни разу
   * не трогал селектор (используется старый TTS_PROVIDER/дефолт). */
  source: 'admin' | 'env-default';
  options: VoiceoverProviderOptionView[];
}

// ── Очередь публикации (backend/src/modules/publication, этап 18) ──

export type PublicationPlatform = 'YOUTUBE' | 'TIKTOK';
export type PublicationStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'PUBLISHED' | 'FAILED';
/** Этап 61 (ТЗ §14.3): запрошенная видимость на площадке. */
export type PublicationPrivacy = 'PRIVATE' | 'UNLISTED' | 'PUBLIC';

export interface PublicationRequest {
  id: string;
  userId: string;
  sessionId: string;
  generatedVideoId: string;
  projectId: string | null;
  productItemId: string | null;
  platform: PublicationPlatform;
  status: PublicationStatus;
  videoUrl: string;
  title: string;
  description: string;
  tags: string[];
  category: string | null;
  moderatorId: string | null;
  moderatedAt: string | null;
  rejectReason: string | null;
  externalUrl: string | null;
  publishedAt: string | null;
  publishError: string | null;
  /** Этап 61 (ТЗ §14.2): null у APPROVED значит «канал не подключён». */
  channelId: string | null;
  privacy: PublicationPrivacy;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

/** Этап 61 (ТЗ §14.2/14.4) — канал выгрузки, подключённый пользователем. */
export type ChannelStatus = 'ACTIVE' | 'REVOKED' | 'EXPIRED';

export interface PublishingChannel {
  id: string;
  platform: PublicationPlatform;
  externalId: string;
  title: string;
  avatarUrl: string | null;
  status: ChannelStatus;
  createdAt: string;
}

export interface PublicationListResult {
  items: PublicationRequest[];
  total: number;
  page: number;
  pageSize: number;
  /** PENDING всего, независимо от фильтра — для бейджа в навигации. */
  pending: number;
}

// ── Публичная страница ролика (backend/src/modules/shared-video, этап 60, ТЗ §40) ──

export type SharedVideoStatus = 'PENDING' | 'PUBLISHED' | 'REJECTED';

export interface SharedVideoPage {
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
  items: SharedVideoPage[];
  total: number;
  page: number;
  pageSize: number;
  /** PENDING всего, независимо от фильтра — для бейджа в навигации. */
  pending: number;
}

// ── Библиотека разборов (ТЗ §21, модерация §21.1) ──────────────────────

export type LibraryVisibility = 'PUBLIC' | 'PRIVATE' | 'HIDDEN';

export interface AdminLibraryEntry {
  id: string;
  sourceKey: string;
  sourceType: 'youtube' | 'upload';
  sourceUrl: string | null;
  title: string | null;
  thumbnailUrl: string | null;
  category: string | null;
  audienceGender: string | null;
  audienceAgeRange: string | null;
  audienceInterests: string[];
  aspectRatio: string | null;
  sceneCount: number;
  characterCount: number;
  usageCount: number;
  visibility: LibraryVisibility;
  own: boolean;
  hiddenReason: string | null;
  moderatedAt: string | null;
  ownerId: string | null;
  sessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminLibraryPage {
  items: AdminLibraryEntry[];
  total: number;
  page: number;
  pageSize: number;
}

/** GET /admin/library/:id — то же плюс сам разбор. */
export interface AdminLibraryEntryDetail extends AdminLibraryEntry {
  analysis: {
    sceneBreakdown?: string;
    characters?: { id: string; label: string }[];
    scenes?: { id: string; title: string; start: number; end: number }[];
    extras?: { id: string; label: string }[];
  } | null;
}


// ── Блог/новости (ТЗ §36/§37, этап 57 backend / 58 UI) ─────────────────
// Модель backend/src/modules/blog/blog.types.ts — держать в синхроне
// вручную, как и остальные типы этого файла.

export type BlogPostStatus = 'DRAFT' | 'APPROVED' | 'PUBLISHED' | 'REJECTED';
export type BlogPostSource = 'YOUTUBE_TREND' | 'MANUAL';
export type BlogTranslationStatus = 'PENDING' | 'QUEUED' | 'READY' | 'FAILED';

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

// ── Пользователи (ТЗ §25, этап 30) ─────────────────────────────────────

export type PlanId = 'LITE' | 'STANDARD' | 'PREMIUM';

export interface AdminUserSummary {
  id: string;
  telegramId: string;
  firstName: string | null;
  username: string | null;
  isOperator: boolean;
  isBlocked: boolean;
  blockedAt: string | null;
  blockedReason: string | null;
  plan: PlanId;
  planSince: string | null;
  /** Режим выбран самим пользователем: функции — режима, потолок расхода —
   * как у Lite (этап 54, Б-3.8). Назначение из админки снимает флаг. */
  planSelfService: boolean;
  termsVersion: string | null;
  termsAcceptedAt: string | null;
  createdAt: string;
  /** Расход на ИИ за всё время (ТЗ §26), в микродолларах. */
  costMicroUsd: number;
  costCalls: number;
  /** Расход с начала суток UTC и потолок его режима (ТЗ §26.4). */
  spentTodayMicroUsd: number;
  dailyLimitMicroUsd: number;
  counts: {
    sessions: number;
    projects: number;
    brandManifests: number;
    libraryEntries: number;
    publications: number;
  };
  /** Этап 62 (ТЗ §41): баланс купленных кредитов на генерацию. */
  credits: { balance: number };
  /** Этап 62: активная подписка, если есть. null — Lite или без покупок. */
  subscription: AdminUserSubscription | null;
}

export interface AdminUserListResult {
  items: AdminUserSummary[];
  total: number;
  page: number;
  pageSize: number;
  /** Сводка по всей базе, не по текущей странице. */
  byPlan: Record<PlanId, number>;
  operators: number;
  blocked: number;
}

export interface AdminUserDetail extends AdminUserSummary {
  costByOperation: CostBucket[];
  recentSessions: Array<{
    sessionId: string;
    status: string;
    createdAt: string;
    lastActivityAt: string;
    productName: string | null;
    hasGeneratedVideo: boolean;
  }>;
}

// ── Оплата: подписки и пакеты кредитов (ТЗ §41, этап 62) ───────────────
// Модель backend/src/modules/admin-panel/admin-billing.service.ts (платежи)
// и backend/src/modules/admin-panel/admin-users.service.ts (баланс/подписка
// в карточке пользователя) — держать в синхроне вручную.

export type PaymentMethod = 'STARS' | 'WAYFORPAY';
export type PaymentPurpose = 'SUBSCRIPTION' | 'CREDIT_PACK';
export type PaymentStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'REFUNDED';

export interface AdminPaymentRow {
  id: string;
  userId: string;
  telegramId: string;
  method: PaymentMethod;
  purpose: PaymentPurpose;
  plan: PlanId | null;
  creditsGranted: number | null;
  status: PaymentStatus;
  currency: string;
  amount: number;
  providerRef: string;
  failureReason: string | null;
  createdAt: string;
}

export interface AdminPaymentListResult {
  items: AdminPaymentRow[];
  total: number;
  page: number;
  pageSize: number;
}

// ── Рекламный канал: рассылка подборки роликов (ТЗ §42, этап 63) ──────
// Модель backend/src/modules/admin-panel/admin-marketing.service.ts —
// держать в синхроне вручную.

export interface AdminBroadcastRow {
  id: string;
  createdAt: string;
  featuredCount: number;
  sent: number;
  failed: number;
  skipped: number;
  pending: number;
  total: number;
}

export interface AdminBroadcastListResult {
  items: AdminBroadcastRow[];
  total: number;
  page: number;
  pageSize: number;
  activeSubscribers: number;
}

export type SubscriptionStatus = 'ACTIVE' | 'PAST_DUE' | 'CANCELED';

// ── Пакетная генерация по каталогу (ТЗ §44, этап 65) ───────────────────
// Модель backend/src/modules/admin-panel/admin-catalog-batch.service.ts —
// держать в синхроне вручную.

export interface AdminCatalogBatchRow {
  id: string;
  createdAt: string;
  projectId: string;
  userId: string;
  pending: number;
  generating: number;
  done: number;
  failed: number;
  total: number;
}

export interface AdminCatalogBatchListResult {
  items: AdminCatalogBatchRow[];
  total: number;
  page: number;
  pageSize: number;
}

// ── A/B-варианты одного ролика (TODO §III.6, этап 66) ──────────────────
// Модель backend/src/modules/admin-panel/admin-ab-test.service.ts —
// держать в синхроне вручную.

export interface AdminAbTestRow {
  id: string;
  createdAt: string;
  projectId: string;
  userId: string;
  sourceSessionId: string;
  pending: number;
  generating: number;
  done: number;
  failed: number;
  total: number;
}

export interface AdminAbTestListResult {
  items: AdminAbTestRow[];
  total: number;
  page: number;
  pageSize: number;
}

// ── Импорт товарного фида по ссылке (TODO §Уровень 2 п.8, этап 68) ─────
// Модель backend/src/modules/admin-panel/admin-feed-import.service.ts —
// держать в синхроне вручную.

export type AdminFeedImportStatus = 'PENDING' | 'IMPORTING' | 'DONE' | 'FAILED';

export interface AdminFeedImportRow {
  id: string;
  createdAt: string;
  projectId: string;
  userId: string;
  sourceUrl: string;
  status: AdminFeedImportStatus;
  error: string | null;
  totalRows: number;
  importedCount: number;
  skippedCount: number;
  failedCount: number;
}

export interface AdminFeedImportListResult {
  items: AdminFeedImportRow[];
  total: number;
  page: number;
  pageSize: number;
}

/** Подписка пользователя, вложенная в AdminUserSummary — null у Lite или
 * у тех, кто ничего не покупал. */
export interface AdminUserSubscription {
  plan: PlanId;
  status: SubscriptionStatus;
  method: PaymentMethod;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
}

// ── Расходы на ИИ (ТЗ §26, этап 31) ────────────────────────────────────
//
// Все суммы — в МИКРОДОЛЛАРАХ целым числом (1 USD = 1 000 000): так их
// считает и хранит бэкенд, чтобы сложение не плыло. Пересчёт в доллары —
// только для показа.

export interface CostBucket {
  key: string;
  costMicroUsd: number;
  calls: number;
}

export interface PricingRow {
  model: string;
  provider: string;
  inputPerMTokUsd: number | null;
  cachedInputPerMTokUsd: number | null;
  outputPerMTokUsd: number | null;
  perSecondUsd: number | null;
  perCallUsd: number | null;
  /** У синтеза речи счёт идёт за символы, а не за токены (§15.3). */
  perMCharsUsd: number | null;
  overridden: boolean;
  note: string;
}

export interface CostReport {
  /** Версия прайса из последней записи — по ней и посчитаны суммы. */
  pricingVersion: string;
  /** Версия прайса, действующая сейчас. Расхождение — не ошибка, а история. */
  currentPricingVersion: string;
  totalMicroUsd: number;
  totalCalls: number;
  last24hMicroUsd: number;
  last7dMicroUsd: number;
  last30dMicroUsd: number;
  byProvider: CostBucket[];
  byOperation: CostBucket[];
  byModel: CostBucket[];
  unpricedCalls: number;
  payingUsers: number;
  anonymousMicroUsd: number;
  avgPerUserMicroUsd: number;
  avgPerSessionMicroUsd: number;
  sessionsWithCost: number;
  /** Суточные потолки (§26.4) и то, сколько анонимные выбрали сегодня. */
  limits: { byPlan: Record<string, number>; anonymous: number };
  anonymousSpentTodayMicroUsd: number;
  top: Array<{
    userId: string;
    telegramId: string | null;
    username: string | null;
    isBlocked: boolean;
    plan: PlanId;
    costMicroUsd: number;
    calls: number;
  }>;
  pricing: PricingRow[];
}

// ── Кроны (backend/src/modules/cron/admin-cron.*, этап 69) ──
// Реестр + ручной запуск с историей — аналогично Solar Shop. debug у
// девяти из десяти джобов раскрывает только debugLog (не меняет
// поведение); у sweep-orphans debug = dryRun (см. AdminCronService).

export interface CronJobInfo {
  jobKey: string;
  description: string;
}

export type CronRunStatus = 'RUNNING' | 'SUCCESS' | 'FAILED';

export interface CronRunLog {
  id: string;
  jobKey: string;
  triggeredBy: string;
  debugMode: boolean;
  status: CronRunStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  summary: string | null;
  debugLog: unknown;
  errorMessage: string | null;
}

// ── Пилот говорящего AI-аватара (backend/src/modules/actors, этап 72,
// doc/AVATAR-LIPSYNC-PIPELINE-SPEC.md) — admin-only, ручной запуск. ──

export type AvatarGenerationStatus = 'pending' | 'processing' | 'complete' | 'failed';

export interface AvatarVideo {
  status: AvatarGenerationStatus;
  provider: 'hedra';
  providerJobId: string | null;
  characterIndex: number;
  sourceCharacterId: string | null;
  characterLabel: string;
  photoUrl: string;
  prompt: string;
  voiceoverPathname: string;
  renderedUrl: string | null;
  downloadUrl: string | null;
  initiatedAt: string;
  completedAt: string | null;
  subtitleStatus: 'skipped' | 'pending' | 'done' | 'failed';
  subtitleTheme: 'classic' | 'bold' | 'minimal';
  subtitlePathname: string | null;
  subtitleUrl: string | null;
  subtitleError: string | null;
  subtitleJobId: string | null;
  subtitleJobStartedAt: string | null;
  costMicroUsd: number | null;
  error: { code: string; message: string; timestamp: string; retryable: boolean } | null;
}

// ── Звуковой чек (этап 73, backend/src/common/sound-check.ts) — «звучит
// ли голос как живой человек», отдельно от готовности самого ролика выше.
// Общая история с Veo-путём (audit/sound-check), здесь subject всегда 'avatar'. ──

export type SoundCheckVerdict = 'human' | 'synthetic' | 'ambiguous' | 'unknown';

export interface SoundCheck {
  checkId: string;
  subject: 'veo' | 'avatar';
  requestedAt: string;
  completedAt: string | null;
  status: 'complete' | 'failed';
  verdict: SoundCheckVerdict;
  summary: string;
  notes: string[];
  error?: string;
}

export interface SoundCheckState {
  history: SoundCheck[];
}

// ── Воронка движения по воркфлоу (этап 78, doc/WORKFLOW-FUNNEL-SPEC.md,
// doc/WORKFLOW-FUNNEL-COHORT-CONVERSION-SPEC.md) — модель
// backend/src/modules/admin-panel/admin-panel.service.ts
// (getWorkflowFunnel/getWorkflowCohortConversion) — держать в синхроне
// вручную. Окна СКОЛЬЗЯЩИЕ от текущего момента, не календарные.

export type WorkflowWindow = 'hour' | 'day' | 'week' | 'month';
export type WorkflowName = 'session' | 'catalog_batch' | 'ab_test';

export interface WorkflowFunnelStage {
  key: string;
  label: string;
  count: number;
  uniqueUsers: number | null;
}

/** Терминальная ошибка разбита по стадии, с которой сорвалась сущность
 * (§7.2 родительского ТЗ), не общим числом. */
export interface WorkflowFunnelFailureBreakdown {
  fromStage: string;
  fromLabel: string;
  count: number;
  uniqueUsers: number;
}

export interface WorkflowFunnelBlock {
  workflow: WorkflowName;
  label: string;
  /** Основной путь, БЕЗ терминальной ошибки. */
  stages: WorkflowFunnelStage[];
  /** Отсортировано по count desc. */
  failures: WorkflowFunnelFailureBreakdown[];
  totalFailed: number;
}

export interface WorkflowFunnelResult {
  window: WorkflowWindow;
  from: string;
  to: string;
  blocks: WorkflowFunnelBlock[];
}

export interface CohortConversionStage {
  key: string;
  label: string;
  /** Нарастающим итогом, ≤ cohortSize. */
  reached: number;
  /** 0..1. */
  pctOfCohort: number;
  /** Обычно 0..1, но может быть > 1.0 при обходе стадий (когортный ТЗ
   * §4.1) — НЕ обрезать до 100%. `null` для первой стадии после старта
   * когорты и когда предыдущая стадия ни разу не достигнута. */
  pctOfPrevious: number | null;
  /** `null`, если `reached === 0`. */
  avgDurationFromStartMs: number | null;
}

export interface CohortConversionBlock {
  workflow: WorkflowName;
  label: string;
  /** Сущностей, попавших в когорту (= первая стадия, pctOfCohort всегда 1). */
  cohortSize: number;
  /** БЕЗ стартовой стадии — она вынесена в cohortSize. */
  stages: CohortConversionStage[];
  /** false = «когорта ещё не завершена», см. когортный ТЗ §3.2. */
  matured: boolean;
  /** ISO — когда станет matured. */
  maturesAt: string;
}

export interface WorkflowCohortConversionResult {
  window: WorkflowWindow;
  from: string;
  to: string;
  blocks: CohortConversionBlock[];
}
