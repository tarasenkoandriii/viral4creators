/**
 * Frontend TypeScript Interfaces
 *
 * Type definitions matching backend API structures.
 */

// Session types
export enum SessionStatus {
  CREATED = 'created',
  VIDEO_UPLOADED = 'video_uploaded',
  ANALYZING = 'analyzing',
  ANALYSIS_COMPLETE = 'analysis_complete',
  PRODUCT_INFO_ADDED = 'product_info_added',
  PROMPT_GENERATED = 'prompt_generated',
  GENERATING_VIDEO = 'generating_video',
  VIDEO_COMPLETE = 'video_complete',
  ERROR = 'error',
}

export interface Session {
  sessionId: string;
  createdAt: string;
  lastActivityAt: string;
  status: SessionStatus;
  originalVideo?: OriginalVideo;
  videoAnalysis?: VideoAnalysis;
  productInformation?: ProductInformation;
  generationPrompt?: GenerationPrompt;
  generatedVideo?: GeneratedVideo;
  /** Прошлые завершённые/проваленные попытки генерации (доп. запрос
   * владельца продукта: полная история версий) — самая свежая первая.
   * Зеркало бэкендового `Session.videoHistory`. */
  videoHistory?: GeneratedVideo[];
  brandManifestSnapshot?: BrandManifestSnapshot;
  characterCasting?: CharacterCasting;
  relevance?: RelevanceState;
  analysisSelection?: AnalysisSelection;
  projectId?: string | null;
  productItemId?: string | null;
}

// ── Relevance (spec §18.3) — mirrors backend relevance.types.ts ──────────

export type RelevanceVerdict = 'use' | 'adapt' | 'skip';

export interface RelevanceReport {
  reportId: string;
  generatedAt: string;
  score: number;
  verdict: RelevanceVerdict;
  summary: string;
  reasoning: string[];
  matches: string[];
  gaps: string[];
  adjustments: string[];
  promptAdvice: string;
  inputs: {
    productAudience: boolean;
    videoAudience: boolean;
    promotedProduct: boolean;
  };
}

export interface RelevanceState {
  report: RelevanceReport | null;
  useInPrompt: boolean;
  updatedAt: string;
}

// ── Scenes & extras keep/drop (§19) — mirrors backend analysis.types.ts ──

export interface AnalysisSelection {
  droppedScenes: string[];
  droppedExtras: string[];
  updatedAt: string;
}

export interface SceneSelectionRow {
  id: string;
  start: number;
  end: number;
  title: string;
  active: boolean;
}

export interface ExtraSelectionRow {
  id: string;
  label: string;
  description: string;
  active: boolean;
}

export interface AnalysisSelectionView {
  scenes: SceneSelectionRow[];
  extras: ExtraSelectionRow[];
  updatedAt: string | null;
}

// ── Library of analyses (§21) — mirrors backend library.types.ts ────────

export type LibraryVisibility = 'PUBLIC' | 'PRIVATE' | 'HIDDEN';

export interface LibraryEntryView {
  id: string;
  sourceType: 'youtube' | 'upload';
  sourceUrl: string | null;
  title: string | null;
  thumbnailUrl: string | null;
  category: string | null;
  audienceGender: AudienceGender | null;
  audienceAgeRange: string | null;
  audienceInterests: string[];
  aspectRatio: string | null;
  sceneCount: number;
  characterCount: number;
  usageCount: number;
  visibility: LibraryVisibility;
  /** Приватная запись, показанная её же автору (§21.3). */
  own: boolean;
  createdAt: string;
}

export interface LibraryRecommendation extends LibraryEntryView {
  score: number;
  reasons: string[];
}

/** GET /me/terms — acceptance of the offer & terms of use (§20). */
export interface TermsStatus {
  version: string;
  acceptedAt: string | null;
  accepted: boolean;
}

/** GET /me/marketing-consent — согласие на рассылку подборки удачных
 * роликов через Telegram-бота (ТЗ §42, этап 63). Отдельно от
 * TermsStatus: не версионировано и не блокирует ни один сценарий
 * сервиса — просто «сейчас подписан или нет». */
export interface MarketingConsentStatus {
  consented: boolean;
  consentedAt: string | null;
  revokedAt: string | null;
}

// Video types
// The reference video is either an uploaded file (transiently held in
// Vercel Blob until analysis consumes it — never a permanent store) or a
// public YouTube link (Gemini fetches it directly, nothing stored at all).
/** Picture format of the reference (spec §16) — a default for the ad's ratio. */
export interface VideoFrame {
  width: number | null;
  height: number | null;
  aspectRatio: string;
  source: 'file' | 'gemini' | 'manual';
}

export interface UploadedVideo {
  sourceType: 'upload';
  blobPathname: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  uploadedAt: string;
  frame?: VideoFrame;
}

export interface YouTubeVideo {
  sourceType: 'youtube';
  youtubeUrl: string;
  registeredAt: string;
  frame?: VideoFrame;
}

export type OriginalVideo = UploadedVideo | YouTubeVideo;

// Analysis types
export enum AnalysisStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETE = 'complete',
  FAILED = 'failed',
}

// ── Audience (spec §18, Stage 23) — mirrors backend audience.types.ts ─────

export type AudienceGender = 'women' | 'men' | 'any';

export interface AudienceProfile {
  ageRange: string | null;
  gender: AudienceGender | null;
  interests: string[];
  summary: string | null;
  source: 'gemini' | 'user';
}

export interface PromotedProduct {
  category: string | null;
  description: string | null;
  priceTier: string | null;
}

/** A person Gemini saw in the reference video (spec §10) — mirrors backend analysis.types.ts. */
export interface AnalysisCharacter {
  id: string;
  label: string;
  role: string | null;
  appearance: string;
  prominence: 'main' | 'secondary' | 'background';
  /** Seconds where the browser grabs the preview frame (§18.1). */
  previewAt?: number | null;
  previewUrl?: string | null;
}

/** Background crowd / passers-by (§19) — keep/drop only, no casting. */
export interface AnalysisExtra {
  id: string;
  label: string;
  description: string;
  previewAt?: number | null;
  previewUrl?: string | null;
}

/** Structured scene row with timecodes (§18.1). */
export interface AnalysisScene {
  id: string;
  start: number;
  end: number;
  title: string;
  previewAt: number | null;
  previewUrl?: string | null;
}

export interface VideoAnalysis {
  analysisId: string;
  analyzedAt: string;
  status: AnalysisStatus;
  sceneBreakdown: string;
  /** undefined on analyses made before Stage 13 or when parsing failed; [] = nobody in frame. */
  characters?: AnalysisCharacter[];
  scenes?: AnalysisScene[];
  extras?: AnalysisExtra[];
  /** Picture format as Gemini read it (§16) — carried into library entries. */
  frame?: VideoFrame;
  audience?: AudienceProfile;
  promotedProduct?: PromotedProduct;
  /** Copied from the library instead of a fresh Gemini call (§21). */
  fromLibrary?: boolean;
  userEdits?: string;
  error?: {
    code: string;
    message: string;
    timestamp: string;
  };
}

// Product types
export interface ProductInformation {
  productName: string;
  productDescription: string;
  productImagePathname?: string;
  productImageMimeType?: string;
  addedAt: string;
  // Present only when the session was started from a project item
  // (POST /projects/:id/items/:itemId/sessions — spec §7.8 snapshot).
  productImageUrl?: string;
  category?: string | null;
  price?: number | null;
  currency?: string | null;
  countryCode?: string | null;
  languageCode?: string | null;
  /** Voice-over language chosen on the product step (spec §13). */
  dialogueLanguage?: string | null;
  sourceProductItemId?: string;
}

// ── Character casting (spec §10) — mirrors backend casting.types.ts ──────

export type CastReplacementKind = 'none' | 'photo' | 'text' | 'brand';

export interface CastReplacement {
  kind: CastReplacementKind;
  photoUrl: string | null;
  photoPathname: string | null;
  description: string | null;
  brandCharacterId: string | null;
  label: string | null;
}

export interface CharacterCast {
  characterId: string;
  active: boolean;
  /** 1-based activation order — first three photo-casts become Veo referenceImages (§10.3). */
  order: number;
  replacement: CastReplacement;
}

export interface CharacterCasting {
  casts: CharacterCast[];
  updatedAt: string;
}

// ── Post-generation audit (spec §11) — mirrors backend audit.types.ts ──────

export interface AuditIssue {
  id: string;
  severity: 'high' | 'medium' | 'low';
  category: string;
  description: string;
  timecode: string | null;
}

export interface PromptFix {
  suggestedText: string;
  rationale: string;
}

export interface VideoAudit {
  auditId: string;
  generatedVideoId: string;
  source: 'gemini' | 'user';
  requestedAt: string;
  completedAt: string | null;
  status: 'complete' | 'failed';
  verdict: 'clean' | 'issues' | 'unknown';
  summary: string;
  issues: AuditIssue[];
  promptFix: PromptFix | null;
  promptText: string;
  error?: string;
}

export interface AuditState {
  history: VideoAudit[];
  appliedFixes: number;
  limit: number;
  overLimit: boolean;
}

// ── Voice sound check (этап 73) — отдельная от VideoAudit проверка
// «звучит ли голос по-человечески», mirrors backend common/types/audit.types.ts ──

export interface SoundCheck {
  checkId: string;
  subject: 'veo' | 'avatar';
  requestedAt: string;
  completedAt: string | null;
  status: 'complete' | 'failed';
  verdict: 'human' | 'synthetic' | 'ambiguous' | 'unknown';
  summary: string;
  notes: string[];
  error?: string;
}

export interface SoundCheckState {
  history: SoundCheck[];
}

// ── Клонирование своего голоса (этап 73, TODO п.32) — mirrors backend
// common/types/user-voice.types.ts ──

export type UserVoiceStatus = 'training' | 'ready' | 'failed';

export interface UserVoice {
  id: string;
  label: string;
  status: UserVoiceStatus;
  /** Идентификатор голоса у Resemble — есть, когда обучение стартовало. */
  resembleVoiceId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Scenes + reference slots (spec §17) — mirrors backend reference.types.ts ──

export interface SceneAsset {
  id: string;
  label: string;
  description: string | null;
  photoUrl: string;
  photoPathname: string;
  createdAt: string;
}

// Найдено при аудите (ТЗ VEO-MODEL-VERSION-CHOICE-SPEC.md §20) —
// 'text-card' добавлен следом за backend'ом (common/reference-plan.ts) —
// та же дублирующая копия типа, что уже несколько раз всплывала между
// фронтендом и бекендом в этом проекте.
export type ReferenceCandidateKind = 'character' | 'scene' | 'product' | 'text-card';

export interface ReferenceCandidate {
  id: string;
  kind: ReferenceCandidateKind;
  label: string;
  thumbnailUrl: string | null;
  textFallback: string;
  /** 'session' — uploaded here (deletable in the chooser); 'brand' — from the manifest (§17.1). */
  origin: 'session' | 'brand';
}

export interface ReferenceSlots {
  candidates: ReferenceCandidate[];
  slots: string[];
  max: number;
  isDefault: boolean;
}

// ── Publication queue (spec §8/§11, Stage 18) — mirrors backend publication.types.ts ──

export type PublicationPlatform = 'YOUTUBE' | 'TIKTOK';
export type PublicationStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'PUBLISHED'
  | 'FAILED';

/** Этап 61 (ТЗ §14.3): запрошенная видимость на площадке. */
export type PublicationPrivacy = 'PRIVATE' | 'UNLISTED' | 'PUBLIC';

export interface PublicationRequest {
  id: string;
  sessionId: string;
  generatedVideoId: string;
  platform: PublicationPlatform;
  status: PublicationStatus;
  videoUrl: string;
  title: string;
  description: string;
  tags: string[];
  category: string | null;
  moderatedAt: string | null;
  rejectReason: string | null;
  externalUrl: string | null;
  publishedAt: string | null;
  publishError: string | null;
  /** Этап 61: null у APPROVED значит «канал не подключён», не ошибка. */
  channelId: string | null;
  privacy: PublicationPrivacy;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

// ── Каналы выгрузки (ТЗ §14.2/14.4, этап 61) — mirrors backend
//    common/types/publishing-channel.types.ts ──

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

// ── Публичная страница ролика и петля шеринга (ТЗ §40, этап 60) — mirrors
//    backend/src/common/types/shared-video.types.ts (владельческая проекция) ──

export type SharedVideoStatus = 'PENDING' | 'PUBLISHED' | 'REJECTED';

export interface SharedVideoPage {
  id: string;
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

// ── Лента (этап 80, TODO §III.9, doc/SOCIAL-FEED-SPEC.md) — надстройка
//    над SharedVideoPage: только PUBLISHED, для показа внутри TMA ──

export interface SharedVideoFeedItem {
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
  likedByViewer: boolean;
}

export interface SharedVideoFeedResult {
  items: SharedVideoFeedItem[];
  nextCursor: string | null;
}

/** Row of GET /youtube-search (spec §6.4 table columns + `url` for registerYoutubeVideo). */
export interface YoutubeSearchResultView {
  videoId: string;
  url: string;
  title: string;
  channelTitle: string;
  channelId: string;
  publishedAt: string;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  durationLabel: string | null;
  viewCount: number | null;
  likeCount: number | null;
}

export interface YoutubeSearchResponse {
  query: string;
  results: YoutubeSearchResultView[];
  usage: { used: number; limit: number; remaining: number };
}

/** Per-session copy of the Brand Manifest (spec §12) — editable for this run only. */
export interface BrandCharacterSnapshot {
  sourceCharacterId: string | null;
  label: string;
  photoUrl: string | null;
  description: string | null;
}

/**
 * Режим озвучки (§15.1): veo — речь синтезирует модель; voiceover — наш
 * голос поверх звука модели; dub — наш голос вместо него.
 */
export type VoiceMode = 'veo' | 'voiceover' | 'dub';

/**
 * Движение камеры (§29): статичный кадр читается как сток, медленный
 * наезд — как работа оператора. Значений сознательно два: выбор из трёх,
 * где два никто не возьмёт, — это шум, а не выбор.
 */
export type CameraMove = 'none' | 'push-in';

/** Жёстко вшитые субтитры (TODO §Уровень 2.7, этап 67): off | on. */
export type SubtitlesMode = 'off' | 'on';

/** Пресетная тема оформления субтитров — значима только при subtitlesMode: 'on'. */
export type SubtitleTheme = 'classic' | 'bold' | 'minimal';

export interface BrandManifestSnapshot {
  brandManifestId: string;
  title: string;
  styleNotes: string | null;
  voiceNotes: string | null;
  /**
   * Озвучка (§15.1, этап 35). Необязательные: у сессий, созданных до
   * этапа 35, этих ключей нет, и читаются они как «голос Veo» — ровно то
   * поведение, которое у них и было.
   */
  voiceMode?: VoiceMode;
  ttsVoiceId?: string | null;
  ttsModel?: string | null;
  /**
   * Провайдер, выпустивший ttsVoiceId (doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md
   * §4.2) — проставляется сервером. Необязательное по той же причине,
   * что и остальная озвучка.
   */
  ttsProvider?: string | null;
  /** Движение камеры (§29, этап 46); у сессий до этапа 46 ключа нет. */
  cameraMove?: CameraMove;
  /** Жёстко вшитые субтитры (TODO §Уровень 2.7, этап 67); у сессий до этапа 67 ключей нет. */
  subtitlesMode?: SubtitlesMode;
  subtitleTheme?: SubtitleTheme;
  filters: Record<string, unknown> | null;
  effects: Record<string, unknown> | null;
  characters: BrandCharacterSnapshot[];
  /** Brand scenes (spec §17.1); absent on sessions created before Stage 22. */
  scenes?: BrandSceneSnapshot[];
  snapshotAt: string;
  editedAt: string | null;
}

export interface BrandSceneSnapshot {
  sourceSceneId: string | null;
  label: string;
  photoUrl: string | null;
  description: string | null;
}

// Prompt types
export enum ModerationStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  FLAGGED = 'flagged',
  BYPASSED = 'bypassed',
}

export interface GenerationPrompt {
  promptId: string;
  generatedText: string;
  userEditedText?: string;
  finalText: string;
  characterCount: number;
  generatedAt: string;
  approvedAt?: string;
  moderationStatus: ModerationStatus;
  moderationFlags?: string[];
  /**
   * Текст озвучки (§15.2, этап 35) — отдельная сущность от промпта:
   * промпт читает Veo, реплики читает синтезатор.
   */
  voiceoverScript?: string;
  voiceoverScriptEdited?: string;
  finalVoiceoverScript?: string;
  voiceoverScriptSource?: 'field' | 'dialogue' | 'none';
}

// Generation types
export enum GenerationStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETE = 'complete',
  FAILED = 'failed',
}

export type VideoQuality = 'fast' | 'standard';

export interface GeneratedVideo {
  generatedVideoId: string;
  pathname: string;
  fileName: string;
  fileSize?: number;
  mimeType: string;
  status: GenerationStatus;
  /** Picture format (spec §16): asked / actually rendered / crop still owed. */
  aspectRatio?: string;
  renderedAspectRatio?: '16:9' | '9:16';
  reframePending?: boolean;
  /**
   * Постобработка одной задачей ffmpeg (§15.4/§16.1, этапы 34–35):
   * обрезка кадра и/или своя звуковая дорожка.
   */
  postStatus?: 'pending' | 'complete' | 'failed' | 'skipped';
  postError?: string;
  /** Исходный ролик Veo — остаётся доступным для сравнения. */
  renderedUrl?: string;
  /** Озвучка (§15, этап 35): синтез идёт до задачи и имеет свой исход. */
  voiceMode?: 'veo' | 'voiceover' | 'dub';
  voiceStatus?: 'skipped' | 'synthesized' | 'failed';
  voiceError?: string;
  voiceoverUrl?: string;
  /** Жёстко вшитые субтитры (TODO §Уровень 2.7, этап 67) — третий ингредиент того же прохода ffmpeg. */
  subtitlesMode?: 'off' | 'on';
  subtitleStatus?: 'skipped' | 'burned' | 'failed';
  subtitleError?: string;
  /** What Veo received as referenceImages (spec §10.2/§10.3); empty on the first-frame path. */
  references?: Array<{
    index: number;
    kind: 'character' | 'scene' | 'product' | 'text-card';
    label: string;
    characterId: string | null;
  }>;
  initiatedAt: string;
  completedAt?: string;
  estimatedCompletionTime?: string;
  downloadUrl?: string;
  quality?: VideoQuality;
  /**
   * Доп. запрос владельца продукта (ТЗ VEO-MODEL-VERSION-CHOICE-SPEC.md
   * §10–11) — найдено при аудите (§16): бэкенд отдаёт эти поля в ответе
   * `GeneratedVideo` уже давно, но фронтендный тип их не объявлял —
   * значит, ни история версий, ни экран генерации не могли их прочитать
   * даже теоретически, хотя данные уже приходили.
   */
  provider?: 'veo' | 'grok';
  /** Только для `provider === 'grok'` (§10.1 ТЗ). */
  resolution?: '480p' | '720p' | '1080p';
  /** Поле «Чего избежать» (§1/§6 ТЗ). */
  avoidText?: string;
  /**
   * Ролики длиннее 8 секунд через Scene Extension (§9 ТЗ, этап 4 плана
   * §14) — все три вместе или ни одного; `undefined` — обычная,
   * однократная генерация.
   */
  chainSegmentsDone?: number;
  chainSegmentsTotal?: number;
  chainTargetDurationSeconds?: number;
  error?: {
    code: string;
    message: string;
    timestamp: string;
    retryable: boolean;
  };
  /** Автоэкспорт под площадки (TODO §III, п.35, этап 75) — id пакетной задачи яруса A. */
  exportJobId?: string;
  exportVariants?: ExportVariant[];
}

/**
 * Один запрошенный вариант автоэкспорта (`doc/MULTI-FORMAT-EXPORT-SPEC.md`
 * §4, этап 75) — зеркало бэкендового `ExportVariant`
 * (`backend/src/common/types/generation.types.ts`).
 */
export interface ExportVariant {
  format: string;
  preset?: string;
  /** A — дешёвая обрезка уже готового файла; B — второй платный рендер Veo. */
  tier: 'A' | 'B';
  status: 'pending' | 'complete' | 'failed';
  outputName?: string;
  pathname?: string;
  url?: string;
  childSessionId?: string;
  error?: string;
  requestedAt: string;
}

// API Request/Response types
export interface UploadVideoRequest {
  fileName: string;
  fileSize: number;
  mimeType: string;
}

export interface UploadVideoResponse {
  uploadUrl: string;
  pathname: string;
}

export interface RegisterYoutubeRequest {
  youtubeUrl: string;
}

export interface UploadProductImageRequest {
  fileName: string;
  fileSize: number;
  mimeType: string;
}

export interface SubmitProductInfoRequest {
  productName: string;
  productDescription: string;
}

export interface UpdateAnalysisRequest {
  editedText: string;
}

export interface UpdatePromptRequest {
  editedText: string;
}

// ── Режимы сервиса (ТЗ §23) — зеркало backend/src/common/plans.ts ──────

export type PlanId = 'LITE' | 'STANDARD' | 'PREMIUM';

export type PlanFeature =
  | 'library'
  | 'relevance'
  | 'audit'
  | 'publication'
  | 'brandManifest'
  | 'referenceAssets'
  | 'characterReplacement'
  | 'customAspectRatio'
  /** Полная модель Veo вместо Lite (§26.1, этап 47). */
  | 'fullQualityVideo'
  /** Клонирование своего голоса через Resemble (этап 73, TODO п.32). */
  | 'voiceCloning'
  /** Дубляж (voiceMode: 'dub') — полная замена звука Veo своим голосом,
   * доп. запрос владельца продукта: премиальный уровень озвучки. */
  | 'voiceDub';

export interface PlanDefinition {
  id: PlanId;
  title: string;
  summary: string;
  features: Record<PlanFeature, boolean>;
  /** Пустой список = любые форматы кадра. */
  aspectRatios: string[];
}

export interface PlanState {
  plan: PlanId;
  plans: Record<PlanId, PlanDefinition>;
  /** Пока false — переключение бесплатное и мгновенное. */
  billingEnabled: boolean;
  /** Блокировка (§25.3) — сервер объясняет её причиной. */
  blocked: { isBlocked: boolean; reason: string | null };
  /**
   * Дневной лимит (§26.4) — только признаки, без сумм: пользователю
   * важно «можно ли сейчас работать», а не наша бухгалтерия.
   */
  budget: { exhausted: boolean; nearlyExhausted: boolean };
  /** Этап 62 (ТЗ §41.4): активная подписка, если есть. null — Lite или
   * без покупок; у анонимного пути — всегда null. */
  subscription: PlanSubscriptionView | null;
  /** Баланс купленных кредитов на генерацию. У анонимного пути — 0
   * (кредиты требуют identity). */
  credits: { balance: number };
}

// ── Оплата: подписки и пакеты кредитов (ТЗ §41, этап 62) ────────────────
// Зеркало backend/src/modules/billing/billing.types.ts и
// backend/src/common/billing-pricing.ts — держать в синхроне вручную, как
// и остальные типы этого файла.

export type SubscriptionStatus = 'ACTIVE' | 'PAST_DUE' | 'CANCELED';

export interface PlanSubscriptionView {
  plan: PlanId;
  status: SubscriptionStatus;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
}

export type PaymentMethod = 'STARS' | 'WAYFORPAY';

export interface SubscriptionPriceDefinition {
  /** XTR — целое число звёзд, копеек не бывает. */
  stars: number;
  /** Минорные единицы валюты WayForPay (копейки/центы). */
  wayforpayMinor: number;
  wayforpayCurrency: string;
}

export interface CreditPackDefinition {
  id: string;
  /** Готовое название с числом («5 роликов») — не собирать из credits
   * самим: склонение уже сделано на бэкенде. */
  title: string;
  credits: number;
  stars: number;
  wayforpayMinor: number;
  wayforpayCurrency: string;
}

export interface BillingPrices {
  subscriptions: Record<
    Extract<PlanId, 'STANDARD' | 'PREMIUM'>,
    SubscriptionPriceDefinition
  >;
  creditPacks: CreditPackDefinition[];
}

/** Ответ обоих `checkout`-маршрутов — ровно одно из двух полей заполнено,
 * в зависимости от переданного method. */
export interface CheckoutResult {
  starsInvoiceUrl?: string;
  wayforpayFormUrl?: string;
  wayforpayFields?: Record<string, string>;
}

// ── Пакетная генерация по каталогу (ТЗ §44, этап 65) — зеркало
// backend/src/modules/catalog-batch/catalog-batch.service.ts ──────────

export interface StartCatalogBatchResult {
  batchId: string;
  itemCount: number;
  /** Товары, пропущенные партией — уже в очереди/обработке другого
   * запуска, не ошибка. */
  skipped: string[];
}

export type CatalogBatchItemStatus =
  | 'PENDING'
  | 'GENERATING'
  | 'DONE'
  | 'FAILED'
  // Доп. запрос владельца продукта (ТЗ §13, этап 2 плана §14) — найдено
  // при аудите: без этого значения тип расходился с реальностью — бэкенд
  // теперь может прислать 'BATCH_QUEUED' (Grok-строка, ждущая подачи как
  // одна пачка), а этот union о нём не знал вовсе.
  | 'BATCH_QUEUED';

export interface CatalogBatchItemView {
  productItemId: string;
  title: string | null;
  photoUrl: string | null;
  sessionId: string | null;
  status: CatalogBatchItemStatus;
  error: string | null;
}

export interface CatalogBatchStatusView {
  batchId: string;
  projectId: string;
  items: CatalogBatchItemView[];
  summary: {
    pending: number;
    generating: number;
    done: number;
    failed: number;
  };
}

// ── A/B-варианты одного ролика (TODO §III.6, этап 66) — зеркало
// backend/src/modules/ab-test/ab-test.service.ts ───────────────────────

export interface StartAbTestResult {
  runId: string;
  /** Сколько строк реально заведено — модель не гарантированно
   * возвращает ровно 3, см. PromptService.generateAbVariants. */
  variantCount: number;
}

export type AbTestVariantStatus = 'PENDING' | 'GENERATING' | 'DONE' | 'FAILED';

export interface AbTestVariantView {
  variantId: string;
  variantIndex: number;
  hookLabel: string;
  ctaLabel: string;
  sessionId: string | null;
  status: AbTestVariantStatus;
  error: string | null;
}

export interface AbTestStatusView {
  runId: string;
  projectId: string;
  variants: AbTestVariantView[];
  summary: {
    pending: number;
    generating: number;
    done: number;
    failed: number;
  };
}

// ── Импорт товарного фида по ссылке (TODO §Уровень 2 п.8, этап 68, §47) —
// зеркало backend/src/modules/product-feed-import/product-feed-import.service.ts ──

export interface StartFeedImportResult {
  runId: string;
}

export type FeedImportRunStatus = 'PENDING' | 'IMPORTING' | 'DONE' | 'FAILED';
export type FeedImportItemStatus =
  | 'PENDING'
  | 'IMPORTED'
  | 'SKIPPED'
  | 'FAILED';

export interface FeedImportItemView {
  rowIndex: number;
  title: string | null;
  status: FeedImportItemStatus;
  reason: string | null;
  productItemId: string | null;
}

export interface FeedImportRunSummary {
  runId: string;
  projectId: string;
  sourceUrl: string;
  status: FeedImportRunStatus;
  error: string | null;
  totalRows: number;
  importedCount: number;
  skippedCount: number;
  failedCount: number;
  createdAt: string;
}

export interface FeedImportStatusView extends FeedImportRunSummary {
  items: FeedImportItemView[];
}
