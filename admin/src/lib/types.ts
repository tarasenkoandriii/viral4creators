// Ответы backend/src/modules/admin-auth и backend/src/modules/admin-panel
// (см. doc/TELEGRAM-ADMIN.md) — держать в синхроне с
// AdminPanelService/AdminAuthService на бэкенде вручную, отдельного
// codegen в проекте нет.

import type { FreeScenario } from './free-scenarios';

export interface AdminMe {
  userId: string;
  isOperator: boolean;
}

export type SessionSortKey = 'createdAt' | 'lastActivityAt' | 'status' | 'plan';
export type SortDirection = 'asc' | 'desc';

export interface SessionSummary {
  sessionId: string;
  status: string;
  generationStatus: string | null;
  createdAt: string;
  lastActivityAt: string;
  userId: string | null;
  ownerPlan: string | null;
  ownerUsername: string | null;
  ownerFirstName: string | null;
  productName: string | null;
  hasGeneratedVideo: boolean;
  downloadUrl: string | null;
  quality: string | null;
  provider: string | null;
  resolution: string | null;
  voiceMode: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  errorRetryable: boolean | null;
}

export interface SessionListResult {
  items: SessionSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export interface VideoVersionAudit {
  auditId: string;
  verdict: 'clean' | 'issues' | 'unknown';
  summary: string;
  hasPromptFix: boolean;
}

export interface VideoVersion {
  generatedVideoId: string;
  status: string;
  downloadUrl: string | null;
  quality: string | null;
  aspectRatio: string | null;
  provider: string | null;
  resolution: string | null;
  avoidText: string | null;
  initiatedAt: string | null;
  completedAt: string | null;
  isCurrent: boolean;
  audits: VideoVersionAudit[];
}

export interface VideoAudit {
  auditId: string;
  status: 'complete' | 'failed';
  verdict: 'clean' | 'issues' | 'unknown';
  summary: string;
  /** Есть ли предложенное исправление промпта — от него зависит,
   * показывать ли «Исправить и перегенерировать». */
  promptFix: { suggestedText: string } | null;
}

export interface AuditStateView {
  history: VideoAudit[];
  appliedFixes: number;
  limit: number;
  overLimit: boolean;
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

// ── Фикстурный пользователь обучалки (backend/src/modules/tutorial-runner/fixture-seed*, этап 105) ──

export interface FixtureSeedResult {
  userId: string;
  telegramId: string;
  manifestId: string;
  characterId: string;
  projectId: string;
  itemId: string;
  sessionId: string;
  log: string[];
}

// ── Озвучка по умолчанию (backend/src/modules/admin-panel/admin-voiceover-settings.service.ts) ──

export type VoiceoverProviderKey = 'elevenlabs' | 'resemble' | 'soniox' | 'veo';

/**
 * Сохранение фона при дубляже
 * (docs-tz/TZ-Voice-Replace-Keep-Background.md, этап E).
 */
export type AudioSeparationState = 'on' | 'off';

export interface AudioSeparationSettingsView {
  state: AudioSeparationState;
  /** Настроен ли Replicate: без ключа выключатель ничего не решает. */
  providerConfigured: boolean;
  /** Что произойдёт при следующем дубляже — одной фразой. */
  effect: string;
}

/** Языки генерации сценариев обучалки (ТЗ TZ-Tutorial-Video-Voiced.md, этап C). */
export interface TutorialLocalesSettingsView {
  /** Что реально будет генерироваться. */
  locales: string[];
  /** Из чего выбирать. */
  supported: string[];
  /** Сколько кодов прислал оператор и сколько приняли. */
  submitted: number;
  accepted: number;
  /** Отброшенные коды списком: «2 из 3» не говорит, что именно не так. */
  rejectedCodes: string[];
  /** Ни один присланный код не принят — подставлено умолчание. */
  fellBackToDefault: boolean;
  /** Что будет на следующем ночном прогоне — одной фразой. */
  effect: string;
}

/** Озвучка обучающих роликов (ТЗ TZ-Tutorial-Video-Voiced.md, этап B). */
/** Режим движения обучающего ролика — ровно `SlideshowMotion`
 *  бэкенда (`tutorial-video-assembly.ts`); строки сверяет шов в
 *  `scripts/check-docs.mjs`. */
export type TutorialMotion = 'none' | 'fade' | 'fade+zoom';

export interface TutorialVoiceSettingsView {
  enabled: boolean;
  /** Голос провайдера; null — голос по умолчанию. */
  voiceId: string | null;
  /** Требовать вычитку реплик перед озвучкой (этап D). */
  requireNarrationReview: boolean;
  /** Подписи на кадрах (этап E) — единственный из выключателей
   *  карточки, включённый по умолчанию, и от звука не зависит. */
  captions: boolean;
  /** Движение в слайд-шоу (этап G): переходы и зум. По умолчанию
   *  `none`. */
  motion: TutorialMotion;
  /** Указатель клика (этап H). По умолчанию выключен. */
  pointer: boolean;
  /** Ключ провайдера синтеза, который возьмут при следующей сборке. */
  provider: string;
  /** Настроен ли он: без ключа выключатель ничего не решает. */
  providerConfigured: boolean;
  /** Что произойдёт при следующем ночном прогоне — одной фразой. */
  effect: string;
  /** То же про подписи, отдельной фразой: они от звука не зависят. */
  captionsEffect: string;
  /** То же про движение. */
  motionEffect: string;
  /** То же про указатель клика. */
  pointerEffect: string;
}

// ── Распознавание речи (Soniox, 29.09.2026) ──
// Зеркалит backend/src/common/speech-recognition-provider.ts.
export type SpeechRecognitionProviderKey = 'gemini' | 'soniox';

export interface SpeechRecognitionProviderSettingsView {
  active: SpeechRecognitionProviderKey;
  /** `admin` — выбрано на этом экране; `default` — не менялось (Gemini). */
  source: 'admin' | 'default';
  options: Array<{ key: SpeechRecognitionProviderKey; configured: boolean }>;
}

// ── Голосовой помощник (этап K3 ТЗ Greeting 2.0, 29.09.2026) ──
// Зеркалит backend/src/modules/admin-panel/admin-voice-assistant-settings.service.ts.
/** Тариф или `ANONYMOUS` — общий потолок сессий без владельца (0 — голос без входа выключен). */
export type VoiceAssistantPlan = 'LITE' | 'STANDARD' | 'PREMIUM' | 'ANONYMOUS';
export type VoiceAssistantProviderKey = 'elevenlabs' | 'resemble' | 'soniox';

export interface VoiceAssistantCapView {
  /** Действующий суточный потолок голоса, USD (сутки UTC). */
  usd: number;
  /** Умолчание В-14 для тарифа. */
  defaultUsd: number;
  source: 'admin' | 'default';
}

export interface VoiceAssistantSettingsView {
  caps: Record<VoiceAssistantPlan, VoiceAssistantCapView>;
  voice: { provider: VoiceAssistantProviderKey; voiceId: string | null; source: 'admin' | 'default' };
  providers: Array<{ key: VoiceAssistantProviderKey; configured: boolean }>;
}

export interface SetVoiceAssistantInput {
  caps?: Partial<Record<VoiceAssistantPlan, number>>;
  /** `null` — вернуть голос по умолчанию. */
  voice?: { provider: VoiceAssistantProviderKey; voiceId: string | null } | null;
}

// ── Квота образов «Я в кадре» (этап F ТЗ Greeting 2.0 §4.2, В-7, 30.09.2026) ──
// Зеркалит backend/src/modules/admin-panel/admin-persona-look-quota-settings.service.ts.
// «Обучалка по сайту: выключатель и суточные потолки» (П-Т9, заход 7;
// backend admin-site-tutorial-settings.service.ts).
export interface SiteTutorialCapView {
  value: number;
  /** Задано в админке; null — не задано (действует env/код). */
  stored: number | null;
  defaultValue: number;
  source: 'admin' | 'env' | 'default';
  /** Расход за текущие UTC-сутки по всем пользователям; null — не прочитан. */
  usedToday: number | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface SiteTutorialSettingsView {
  paused: boolean;
  pausedUpdatedAt: string | null;
  pausedUpdatedBy: string | null;
  rounds: SiteTutorialCapView;
  liveSessions: SiteTutorialCapView;
  day: string;
  cacheSeconds: number;
}

/** Не присланное не трогается; null у потолка — вернуть умолчание. */
export interface SetSiteTutorialSettingsInput {
  paused?: boolean;
  roundsPerDay?: number | null;
  liveSessionsPerDay?: number | null;
}

export type PersonaLookQuotaPlan = 'LITE' | 'STANDARD' | 'PREMIUM';
export type PersonaLookQuotaPeriod = 'day' | 'month';

export interface PersonaLookQuotaCell {
  /** Действующее число новых образов за период. */
  value: number;
  /** Умолчание В-7. */
  defaultValue: number;
  source: 'admin' | 'default';
}

export type PersonaLookQuotaSettingsView = Record<
  PersonaLookQuotaPlan,
  Record<PersonaLookQuotaPeriod, PersonaLookQuotaCell>
>;

/** Не присланное не трогается. Целые 0…1000. */
export type SetPersonaLookQuotaInput = Partial<
  Record<PersonaLookQuotaPlan, Partial<Record<PersonaLookQuotaPeriod, number>>>
>;

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

// ── Разбор референса по умолчанию (ТЗ VEO-MODEL-VERSION-CHOICE-SPEC.md §17) ──

export type AnalysisProviderKey = 'gemini' | 'grok';

export interface AnalysisProviderOptionView {
  key: AnalysisProviderKey;
  configured: boolean;
  /** По прямому запросу владельца продукта: сам разбор через Grok ещё
   * не реализован — пункт показывается, но выбрать его нельзя. */
  available: boolean;
  unavailableReason?: string;
}

export interface AnalysisProviderSettingsView {
  active: AnalysisProviderKey;
  source: 'admin' | 'env-default';
  options: AnalysisProviderOptionView[];
}

// ── Провайдер видео-генерации по умолчанию (ТЗ §11.1/§20 — админская
// половина решения, найденная недостающей при аудите) ──

export type VideoProviderKey = 'grok' | 'veo';

export interface VideoProviderOptionView {
  key: VideoProviderKey;
}

export interface VideoProviderSettingsView {
  active: VideoProviderKey;
  source: 'admin' | 'env-default';
  options: VideoProviderOptionView[];
}

// ── Транспорт Grok для одиночных роликов (доп. запрос владельца
// продукта, 14.09.2026; backend grok-video-transport.ts) ──

export type GrokTransportKey = 'sync' | 'batch';

export interface GrokTransportOptionView {
  key: GrokTransportKey;
}

export interface GrokTransportSettingsView {
  active: GrokTransportKey;
  source: 'admin' | 'env-default';
  options: GrokTransportOptionView[];
}

// ── Очередь публикации (backend/src/modules/publication, этап 18) ──

export type PublicationPlatform = 'YOUTUBE' | 'TIKTOK';
export type PublicationStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'PUBLISHED' | 'FAILED';
/** Этап 61 (ТЗ §14.3): запрошенная видимость на площадке. */
export type PublicationPrivacy = 'PRIVATE' | 'UNLISTED' | 'PUBLIC';

export interface PublicationRequest {
  id: string;
  userId: string;
  /** null у заявок Фазы 3 (этап 101, §4.7) — см. tutorialVideoAssetId. */
  sessionId: string | null;
  generatedVideoId: string | null;
  /** Этап 101 (§4.7): заявка на публикацию обучающего видео, не ролика. */
  tutorialVideoAssetId: string | null;
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
  /** Разрешены ли субтитры (скоуп force-ssl, этап 137 ТЗ
   * TZ-Multilingual-YouTube.md). У каналов, подключённых раньше, —
   * false: право выдаётся только новым согласием. */
  captionsAllowed: boolean;
}

/**
 * Альтернативная звуковая дорожка ролика (этап 138/139 ТЗ
 * TZ-Multilingual-YouTube.md) — зеркало `AudioTrackView` на бэкенде.
 */
export interface AudioTrackView {
  id: string;
  locale: string;
  status: string;
  /** Что произносит дорожка: единственный способ оператору понять, что он заливает. */
  speech: string | null;
  /** Готовый полный звук — то, что уходит в Studio. */
  trackUrl: string | null;
  /** Только голос: полезен, когда сборка не удалась, а речь есть. */
  voiceUrl: string | null;
  /** Задача сборки ещё идёт. */
  mixing: boolean;
  /** Собрана для ПРЕЖНЕЙ версии ролика — заливать её нельзя. */
  stale: boolean;
  voiceSeconds: number | null;
  overflowSeconds: number | null;
  tempoRate: number | null;
  attempts: number;
  note: string | null;
  mixError: string | null;
  /** Субтитры дорожки (этап 141): оператор скачивает их тем же заходом. */
  subtitlesSrt: string | null;
  uploadedAt: string | null;
  uploadedById: string | null;
}

export interface AudioTracksResult {
  sessionId: string;
  /** Язык оригинала — на него дорожка не нужна. */
  sourceLocale: string;
  /** Локали, которые есть смысл собрать сейчас. */
  toBuild: string[];
  tracks: AudioTrackView[];
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

/** Зеркало enum GreetingOccasion из backend/prisma/schema.prisma —
 * отдельного codegen в проекте нет, как и у остальных типов этого файла. */
export type GreetingOccasion =
  | 'BIRTHDAY'
  | 'WEDDING'
  | 'ANNIVERSARY'
  | 'NEW_YEAR'
  | 'CHRISTMAS'
  | 'GRADUATION'
  | 'VALENTINES_DAY'
  | 'WOMENS_DAY'
  | 'MOTHERS_DAY'
  | 'FATHERS_DAY'
  | 'DEFENDERS_DAY'
  | 'TEACHERS_DAY'
  | 'FIRST_SCHOOL_DAY'
  | 'NEW_BABY'
  | 'BAPTISM'
  | 'HOUSEWARMING'
  | 'PROMOTION'
  | 'RETIREMENT'
  | 'FAREWELL_COLLEAGUE'
  | 'CORPORATE'
  | 'APOLOGY'
  | 'GET_WELL'
  | 'CONDOLENCE'
  | 'OTHER';

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
  /** Витрина (этап 1 плана docs-tz/AUDIT-Greeting-Landing-And-Upgrade-Plan.md)
   * — зеркало backend/src/common/types/shared-video.types.ts. NULL у
   * `projectType` означает товарный ролик. */
  projectType: 'SINGLE' | 'LINE' | 'CLIENT_SITE' | 'GREETING_VIDEO' | null;
  occasion: GreetingOccasion | null;
  featured: boolean;
  /** NULL у поздравлений — у них нет товара. */
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

/** Состояние очереди перевода одной записи блога. */
export type BlogTranslationsState =
  | 'not-started'
  | 'awaiting-cron'
  | 'in-progress'
  | 'ready'
  | 'failed';

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
  /** Что с переводами на самом деле — число `готово/всего` на это не отвечает. */
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
  /**
   * Тестовый аккаунт (TODO §III п.37): на отмеченных сценариях суточный
   * потолок расхода не применяется. Тариф при этом остаётся своим —
   * тестировщик видит тот же набор функций, что и пользователь.
   */
  isTestUser: boolean;
  /** Сценарии с бесплатным использованием; действуют только с флагом. */
  freeScenarios: FreeScenario[];
  /**
   * Операции ВНЕ проекта — своя галочка (этап 159). До неё условием
   * было «отмечены все три сценария»: верно по происхождению, но
   * тестировщику одного сценария означало, что половина его работы
   * идёт за его счёт.
   */
  freeOutsideProject: boolean;
  /** До какого числа действует доступ. null — бессрочно. */
  testAccessUntil: string | null;
  /** Свой суточный потолок в долларах. null — общий для тестовых. */
  testDailyLimitUsd: number | null;
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

/**
 * Короткая карточка пользователя для подписи рядом с id на любом экране
 * (`GET /admin/users/brief?ids=…`). Неизвестные id в ответе просто
 * отсутствуют. `AdminUserSummary` структурно её надмножество — списком
 * пользователей можно заранее наполнить кеш подписей.
 */
export interface AdminUserBrief {
  id: string;
  telegramId: string;
  username: string | null;
  firstName: string | null;
  isOperator: boolean;
  isTestUser: boolean;
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
  /**
   * Окружение последнего запуска мини-аппа (этап 156,
   * `docs-tz/TZ-Rabota-s-Testirovshchikom.md` §3.4). `null` у всех, кроме
   * тестовых аккаунтов: пишется только им.
   *
   * `value` — сознательно `unknown`: набор полей окружения будет меняться
   * вслед за тем, что понадобится для воспроизведения, а карточка
   * показывает его как есть. Объявить здесь копию формы значило бы
   * завести третье место, которое будет расходиться с двумя первыми
   * (`frontend/src/lib/environment.ts`, `backend/src/common/environment.ts`).
   */
  environment: { at: string; value: unknown } | null;
  costByOperation: CostBucket[];
  /** Подписи операций — приезжают с карточкой, как у `CostReport`
   *  (своей копии словаря в админке нет, и заводить её нельзя). */
  operationLabels: Record<string, string>;
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
export type PaymentPurpose = 'SUBSCRIPTION' | 'CREDIT_PACK' | 'AUCTION';
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

export type SubscriptionStatus =
  | 'ACTIVE'
  | 'PAST_DUE'
  | 'CANCELED'
  | 'RENEWING';

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
  /** Символы синтезированной речи; ноль у всего, что не синтез
   *  (этап F ТЗ docs-tz/TZ-Tutorial-Video-Voiced.md). */
  characters: number;
}

export interface PricingRow {
  model: string;
  provider: string;
  inputPerMTokUsd: number | null;
  /** Свои ставки входа по модальности (C1 захода 8); null — как текст.
   *  Необязательны: старый бэкенд их не отдаёт. */
  audioInputPerMTokUsd?: number | null;
  imageInputPerMTokUsd?: number | null;
  videoInputPerMTokUsd?: number | null;
  cachedInputPerMTokUsd: number | null;
  /** Звук из кеша; null — по ставке кеша. */
  cachedAudioInputPerMTokUsd?: number | null;
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
  /** Подписи операций — приезжают с отчётом, второй копии в админке
   *  нет (см. `operationLabel` в lib/money.ts). */
  operationLabels: Record<string, string>;
  /** Суточные потолки (§26.4) и то, сколько анонимные выбрали сегодня. */
  /**
   * Тестовые аккаунты (TODO §III п.37) — отдельным блоком: во все
   * остальные числа отчёта они НЕ входят.
   */
  testUsers: {
    accounts: number;
    costMicroUsd: number;
    calls: number;
    spentTodayMicroUsd: number;
    /** Разрез по операциям ВНУТРИ тестовых: расход ночной обучалки
     *  пишется на фикстурного исполнителя, а он тестовый — в общей
     *  таблице операций его нет по построению. */
    byOperation: CostBucket[];
  };
  limits: {
    byPlan: Record<string, number>;
    anonymous: number;
    /** Потолок тестовых аккаунтов на их сценариях (TODO §III п.37). */
    testUser: number;
  };
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

/** Исход сверх статуса: SKIPPED — прогон отработал, но работу пропустил
 * (замок, не настроено, потолок). Статус у такого прогона SUCCESS. */
export type CronRunOutcome = 'SKIPPED';

// ── Снимки интерфейса крона ui-snapshot-run
// (backend/src/modules/ui-snapshot/ui-snapshot-query.service.ts) ──────

export interface UiSnapshotPrevious {
  id: string;
  createdAt: string;
  blobUrl: string | null;
}

export interface UiSnapshotItem {
  id: string;
  routeKey: string;
  locale: string;
  theme: string;
  createdAt: string;
  changed: boolean;
  /** Расстояние между отпечатками 0..1; null у первого снимка и у сбоя. */
  diffScore: number | null;
  /** Публичный адрес PNG в Blob; null — снимок не удалось снять. */
  blobUrl: string | null;
  /** Адрес картинки, с которой сравнивали. */
  comparedToUrl: string | null;
  /** Первые символы dHash. */
  diffHash: string | null;
  error: string | null;
  /** Только у изменившихся: предыдущий снимок той же комбинации. */
  previous: UiSnapshotPrevious | null;
}

export interface UiSnapshotList {
  items: UiSnapshotItem[];
  /** Курсор следующей страницы; null — дальше нет. */
  nextBefore: string | null;
}

export interface UiSnapshotRouteSummary {
  routeKey: string;
  total: number;
  changed: number;
  errors: number;
  lastAt: string | null;
  recentChangedAt: string[];
}

export interface UiSnapshotSummary {
  since: string;
  routes: UiSnapshotRouteSummary[];
  /** Сколько дней хранятся обычные снимки: за период длиннее этого
   * `total` и `errors` считают только последние дни. */
  plainRetentionDays: number;
}

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
  /** SKIPPED — пропуск; null/нет — обычный исход по статусу. */
  outcome?: CronRunOutcome | null;
}

/** Сводка за период — `GET /admin/cron/summary` (AdminCronService.getSummary). */
export interface CronFailure {
  id: string;
  startedAt: string;
  triggeredBy: string;
  durationMs: number | null;
  summary: string | null;
  errorMessage: string | null;
}

export interface CronJobSummary {
  jobKey: string;
  schedule: string | null;
  /** По расписанию vercel.json в окне expectedSince..expectedUntil; null — неизвестно. */
  expected: number | null;
  scheduledRuns: number;
  manualRuns: number;
  /** Прогоны Vercel Cron в окне ожидания — с ними сравнивается expected. */
  scheduledRunsInWindow: number;
  missed: number | null;
  /** Первый прогон Vercel Cron в журнале за срок хранения; null — ни одного. */
  firstScheduledRunAt: string | null;
  /** Начало окна ожидания этого джоба: не раньше минуты первого прогона. */
  expectedSinceJob: string;
  total: number;
  byStatus: Record<CronRunStatus, number>;
  /** Из byStatus.SUCCESS — сколько были пропуском (исход SKIPPED). */
  skipped: number;
  /** Последний настоящий успех (не пропуск) до конца периода; null — нет. */
  lastSuccessAt: string | null;
  /** Последний провал до конца периода; null — нет. */
  lastFailureAt: string | null;
  medianDurationMs: number | null;
  maxDurationMs: number | null;
  /** RUNNING дольше замка JOB_LOCK_MS — зависший/убитый прогон. */
  stuckRunning: number;
  stuck: boolean;
  recentFailures: CronFailure[];
}

export interface CronSummary {
  since: string;
  until: string;
  /** Окно подсчёта expected: [max(since, now − срок хранения),
   * min(until, now − запас)), границы округлены вверх до минуты. */
  expectedSince: string;
  expectedUntil: string;
  expectedGraceMs: number;
  retentionDays: number;
  lockMs: number;
  schedulesLoaded: boolean;
  jobs: CronJobSummary[];
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

// ── ИИ-консультант на лендинге (doc/LANDING-TUTORIAL-AI-CONSULTANT-SPEC.md,
// backend/src/modules/assistant) ──

export interface AssistantSettingsView {
  enabled: boolean;
  proactiveEnabled: boolean;
  dailyBudgetMicroUsd: number;
  model: string;
}

export interface AssistantAdminSettingsView extends AssistantSettingsView {
  knowledgeBuiltAt: string;
  knowledgeCommit: string;
  today: {
    questions: number;
    proactiveQuestions: number;
    spentMicroUsd: number;
    budgetMicroUsd: number;
    percentOfBudget: number;
  };
}

export interface SetAssistantSettingsInput {
  enabled?: boolean;
  proactiveEnabled?: boolean;
  /** Доллары, не микро-доллары — конвертирует бэкенд (SetAssistantSettingsDto). */
  dailyBudgetUsd?: number;
  model?: string;
}

export type AssistantActionKind = 'step' | 'open-app' | 'plan' | 'faq' | 'legal' | 'video';

export interface AssistantAction {
  kind: AssistantActionKind;
  stepId?: number;
  planId?: string;
  faqIndex?: number;
  slug?: string;
  /** Только у kind:'video' (этап 99, §4.8) — подставлены сервером. */
  subjectKey?: string;
  url?: string;
  title?: string;
}

export interface AssistantExchangeRow {
  id: string;
  createdAt: string;
  locale: string;
  page: string;
  stepId: number | null;
  question: string;
  answer: string;
  actions: AssistantAction[] | null;
  inTokens: number;
  outTokens: number;
  cachedTokens: number;
  costMicroUsd: number;
  latencyMs: number;
  flagged: boolean;
  triggeredBy: string;
}

export interface AssistantFeedResult {
  rows: AssistantExchangeRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AssistantAggregates {
  days: number;
  questionsPerDay: number;
  avgCostMicroUsd: number;
  budgetExhaustedCount: number;
  /** 0..1. */
  actionsOpenAppShare: number;
  topQuestions: Array<{ question: string; count: number }>;
}

export interface AssistantAdminResult {
  feed: AssistantFeedResult;
  aggregates7: AssistantAggregates;
  aggregates30: AssistantAggregates | null;
}

// ── Сценарии обучалки (§4.10/§4.11 ТЗ,
// backend/src/modules/tutorial-scenario/tutorial-scenario-admin.*, этап
// 94; страница подключена этапом 105) — список сгенерированных
// сценариев регресс-раннера и одобрение costly=true перед автоматическим
// исполнением ──

export interface TutorialScenarioRow {
  id: string;
  createdAt: string;
  subjectKey: string;
  locale: string;
  /** Список шагов ScenarioStep (goto/fill/click/waitFor/assertVisible/assertText/triggerPaidOperation) — не исполняемый код. */
  steps: unknown;
  generatedBy: string;
  costly: boolean;
  estimatedCostMicroUsd: number | null;
  costUnpriced: boolean;
  approved: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
  /** Отметка о вычитке РЕПЛИК (этап D) — третье решение вокруг
   *  сценария, отдельное и от `approved` («можно тратить»), и от
   *  `reviewed` у готового ролика («можно показывать»). */
  narrationReviewedBy: string | null;
  narrationReviewedAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunError: string | null;
}

/** Ответ на правку шагов: строка плюс реплики, которые валидация
 *  отбросила. Без второго поля оператор видел зелёное «сохранено» и
 *  не находил свою реплику в списке. */
export interface TutorialScenarioSaveResult extends TutorialScenarioRow {
  droppedNarrations: { stepNumber: number; reason: string }[];
}

export interface TutorialScenarioListResult {
  rows: TutorialScenarioRow[];
  total: number;
  page: number;
  pageSize: number;
}

/** Итог «Засеять демо обучающего лендинга» (бэкенд
 *  `TutorialScenarioAdminService.seedSiteTutorialDemo`). */
export interface SiteTutorialDemoSeedResult {
  total: number;
  created: number;
  updated: number;
  unchanged: number;
  pairs: {
    subjectKey: string;
    locale: string;
    scenario: string;
    outcome: 'created' | 'updated' | 'unchanged';
  }[];
  /** `null` — `LANDING_PUBLIC_URL` бэкенда не задан или не https:
   *  строки засеяны, но съёмка витрины не пойдёт. */
  polygonOrigin: string | null;
}

// ── Обучалки по сайту заказчика (doc/CLIENT-SITE-TUTORIAL-SPEC.md §5.2,
// §8.3; backend/src/modules/client-site-tutorial, этап 113) — вкладка
// «Обучалки по сайтам» ──

export type ClientSiteDraftStatus =
  | 'DRAFTING'
  | 'PENDING_REVIEW'
  | 'APPROVED'
  | 'REJECTED';

export interface ClientSiteDraftRow {
  id: string;
  projectId: string;
  baseUrl: string;
  title: string | null;
  status: ClientSiteDraftStatus;
  stepCount: number;
  roundCount: number;
  previewFrameCount: number | null;
  requiresLiveLoginReplay: boolean;
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClientSiteDraftDetails extends ClientSiteDraftRow {
  /** Список шагов ScenarioStep — не исполняемый код. */
  steps: unknown;
  /** Прямые ссылки на кадры предпросмотра в Blob — та же серия, что
   * видел пользователь. Без них одобрение шло бы вслепую. */
  frameUrls: string[];
  hasCredentials: boolean;
  /** Сколько шагов дописал каждый раунд; раунд = кадр. По нему экран
   * подписывает кадр его шагами (перенос QA TMA §12, 01.10.2026). */
  stepsPerRound: number[];
  /** Предупреждение стоп-листа §8.3 по каждому раунду, `null` — не было. */
  roundDangerWarnings: (string | null)[];
}

export interface ClientSiteDraftListResult {
  items: ClientSiteDraftRow[];
  total: number;
  page: number;
  pageSize: number;
}

// ── Обучающие видео (doc/TMA-UI-SNAPSHOT-AND-TUTORIAL-VIDEO-SPEC.md
// §4.8/§4.9, backend/src/modules/tutorial-runner, этап 99) — вкладки
// «Видео-контент»/«Состояние данных» ──

// Ровно те строки, что пишет бэкенд (`tutorial-scenario-runner.
// service.ts`, `client-site-tutorial-admin.service.ts`) и отдаёт как
// есть, без маппинга. До правки аудита этапа A здесь стояли
// 'submitted' и 'completed', которых бэкенд не писал НИКОГДА, а
// реальные 'preparing' и 'complete' отсутствовали — собранный ролик
// показывался жёлтым бейджем с сырым текстом «complete».
export type TutorialVideoAssemblyStatus =
  | 'preparing'
  | 'pending'
  | 'complete'
  | 'failed';

export interface TutorialVideoAssetRow {
  id: string;
  createdAt: string;
  subjectKey: string;
  locale: string;
  title: string;
  scenarioId: string | null;
  frameCount: number | null;
  blobUrl: string | null;
  externalUrl: string | null;
  durationMs: number | null;
  reviewed: boolean;
  assemblyStatus: TutorialVideoAssemblyStatus;
  assemblyError: string | null;
  assemblyJobId: string | null;
  assemblyStartedAt: string | null;
  /** 'light' | 'dark' — тема интерфейса на съёмке; null — не записана. */
  theme?: string | null;
  capturedAt?: string | null;
  captureBuild?: string | null;
  activeVersionId?: string | null;
}

// ── Проверка качества демо через Gemini (06.10.2026,
// doc/TUTORIAL-DEMO-QUALITY-SPEC.md; backend/src/modules/tutorial-quality) ──
// Фаза наблюдения: отчёт и сигнал оператору, одобрение не меняется.

export type DemoQualityStatus = 'pending' | 'running' | 'complete' | 'error';
export type DemoQualityPhase = 'upload' | 'wait' | 'analyze';
export type DemoQualityVerdict = 'ok' | 'warn' | 'fail';
export type DemoQualitySeverity = 'critical' | 'major' | 'minor';

export interface DemoQualityIssue {
  category: string;
  severity: DemoQualitySeverity;
  startMs: number;
  endMs: number;
  explanation: string;
  confidence: number;
  source: 'model' | 'server' | 'preflight';
}

export type DemoQualityCheckResult = 'match' | 'mismatch' | 'unknown' | 'not_applicable';

export interface DemoQualityReport {
  rubricVersion: string;
  summary: string;
  scores: { readability: number; stepMatch: number; pacing: number; consistency: number } | null;
  issues: DemoQualityIssue[];
  missingEvidence: string[];
  theme: { expected: string | null; observed: string; result: DemoQualityCheckResult };
  language: { expected: string; speech: string; captions: string; result: DemoQualityCheckResult };
  freshness: 'current' | 'stale_candidate' | 'unknown';
  invalid: string | null;
  droppedIssues: number;
}

export interface DemoQualityCheck {
  id: string;
  assetId: string;
  versionId: string | null;
  trigger: string;
  status: DemoQualityStatus;
  phase: DemoQualityPhase;
  verdict: DemoQualityVerdict | null;
  attempts: number;
  nextAttemptAt: string | null;
  error: string | null;
  report: DemoQualityReport | null;
  preflight: { ok: boolean; problems: string[]; durationMs: number } | null;
  costMicroUsd: number | null;
  unpriced: boolean;
  modelId: string;
  rubricVersion: string;
  reusedFromId: string | null;
  durationMs: number | null;
  theme: string | null;
  locale: string;
  captureBuild: string | null;
  /** 'tma' | 'polygon' | 'client-site' (заход 7); null — у старых записей. */
  captureMode: string | null;
  createdAt: string;
  checkedAt: string | null;
  // ── заход 7 (07.10.2026) — поля могут отсутствовать у старого бэкенда ──
  /** Итоговый вердикт: переопределение оператора сильнее модели. */
  effectiveVerdict?: DemoQualityVerdict | null;
  override?: DemoQualityOverrideInfo | null;
  /** Контрольные кадры шагов с таймкодами этого файла. */
  controlFrames?: DemoQualityControlFrame[] | null;
  /** Чёрные/замершие кадры декодером; null — не заказывались. */
  signals?: DemoQualitySignals | null;
}

export interface DemoQualityOverrideInfo {
  verdict: DemoQualityVerdict;
  reason: string | null;
  by: string | null;
  at: string | null;
}

export interface DemoQualityControlFrame {
  stepIndex: number;
  startMs: number;
  endMs: number;
  imageUrl: string;
  caption: string | null;
}

export interface DemoQualitySignalInterval {
  startMs: number;
  endMs: number;
}

export interface DemoQualitySignals {
  status: 'pending' | 'running' | 'complete' | 'error' | string;
  black: DemoQualitySignalInterval[];
  freeze: DemoQualitySignalInterval[];
  suspicious: Array<DemoQualitySignalInterval & { kind: 'black' | 'freeze'; explanation: string }>;
  error: string | null;
}

/** Строка журнала переопределений вердикта. */
export interface DemoQualityOverrideEntry {
  id: string;
  checkId: string;
  fromVerdict: DemoQualityVerdict | null;
  toVerdict: DemoQualityVerdict | null;
  reason: string;
  by: string;
  at: string;
}

export interface DemoQualityOverrideResult {
  check: DemoQualityCheck;
  overrides: DemoQualityOverrideEntry[];
}

export interface DemoQualityLatest {
  enabled: boolean;
  checks: Record<string, DemoQualityCheck>;
}

export interface DemoQualityEnqueueResult {
  check: DemoQualityCheck;
  created: boolean;
  reason: 'already-queued' | 'already-checked' | 'retry' | null;
}

export interface DemoQualityApprovedResult {
  queued: number;
  skipped: number;
  remaining: number;
  cap: number;
}

// ── Темп обучалок в постпродакшене (06.10.2026,
// doc/TUTORIAL-POSTPROD-TEMPO-SPEC.md) — тот же API, что у пользователя,
// под защитой админки: GET/POST /admin/tutorial-video-assets/:id/… ──

export type TutorialTempoWarning =
  | { code: 'pauses-at-minimum'; frames: number }
  | { code: 'source-frame-too-short'; frameIndexes: number[] }
  | { code: 'speech-unmeasured'; frameIndexes: number[] }
  | { code: 'zoom-dropped' };

export type TutorialTempoUnavailableReason =
  | 'no-manifest'
  | 'whole-track'
  | 'sources-pending'
  | 'not-complete'
  | 'frames-purged';

export interface TutorialVersionRow {
  id: string;
  kind: 'source' | 'tempo';
  factor: number;
  preset: 'calm' | 'normal' | 'fast' | null;
  status: 'preparing' | 'pending' | 'complete' | 'failed';
  durationMs: number | null;
  url: string | null;
  active: boolean;
  requiresApproval: boolean;
  approved: boolean;
  createdAt: string;
  /** Причина провала — оператору видна, пользователю нет. */
  error?: string | null;
}

export interface TutorialTempoEstimate {
  assetId: string;
  title: string;
  url: string | null;
  currentDurationMs: number | null;
  editable: boolean;
  reason: TutorialTempoUnavailableReason | null;
  factor: number;
  durationMs: number | null;
  sourceDurationMs: number | null;
  minimumDurationMs: number | null;
  warnings: TutorialTempoWarning[];
  voiced: boolean;
  activeFactor: number;
  inFlight: TutorialVersionRow | null;
}

export interface TutorialVideoListResult {
  rows: TutorialVideoAssetRow[];
  total: number;
  page: number;
  pageSize: number;
  /** Id роликов, отмеченных «В демо обучающего лендинга»
   *  (`tutorial.siteTutorialDemoAssets`). Нет поля — старый бэкенд. */
  siteTutorialDemoAssetIds?: string[];
}

export interface TutorialVideoCoverageCell {
  subjectKey: string;
  locale: string;
  reviewedCount: number;
}

export interface TutorialVideoLastRun {
  jobKey: string;
  status: CronRunStatus | null;
  startedAt: string | null;
  finishedAt: string | null;
  summary: string | null;
  errorMessage: string | null;
}

export interface TutorialVideoDataStatus {
  knowledge: { builtAt: string; commit: string };
  /** Локаль → число шагов обучалки в базе знаний ассистента. */
  stepCounts: Record<string, number>;
  videoCoverage: TutorialVideoCoverageCell[];
  lastRuns: TutorialVideoLastRun[];
}

// ── Маркетплейс исполнителей — Этап 0 (backend/src/modules/creator-profile, ТЗ §20 №19) ──

export interface AdminCreatorProfile {
  id: string;
  userId: string;
  displayName: string | null;
  slug: string | null;
  niches: string[];
  priceRangeMin: number | null;
  priceRangeMax: number | null;
  bio: string | null;
  isAcceptingOrders: boolean;
  contactHandle: string | null;
  socialLinks: { id: string; platform: string; url: string }[];
  isFeatured: boolean;
  viewCount: number;
  portfolioItemCount: number;
  createdAt: string;
}

export interface AdminCreatorProfileListResult {
  items: AdminCreatorProfile[];
  total: number;
  page: number;
  pageSize: number;
}

// Аудит-фикс: не включало SOLD (та же неточность, третий раз подряд —
// уже чинилась в backend/common/types/marketplace.types.ts и
// marketplace/lib/client-api.ts; SOLD есть с самого Этапа 1 аукциона).
export type AdminPortfolioItemStatus = 'PENDING' | 'PUBLISHED' | 'REJECTED' | 'SOLD';

export interface AdminPortfolioItem {
  id: string;
  creatorProfileId: string;
  sourceType: string;
  videoUrl: string;
  title: string;
  thumbnailUrl: string | null;
  status: AdminPortfolioItemStatus;
  likeCount: number;
  viewCount: number;
  collectionTag: string | null;
  rejectionReason: string | null;
  createdAt: string;
  /** Водяной знак на публичном превью (§9/§22, защита от пиратства) — статус обработки виден оператору. */
  watermarkStatus: 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED' | 'SKIPPED';
}

export interface AdminPortfolioListResult {
  items: AdminPortfolioItem[];
  total: number;
  page: number;
  pageSize: number;
}

// ── Аукцион готовых видео (ТЗ на маркетплейс §22) — модерация оператором ──
// Реальный пробел, закрытый этим фиксом: бэкенд (AdminAuctionController —
// список/approve/reject/confirm-payment) существовал с Этапа 2, но ни
// одной страницы под него не было — оператору было физически нечем
// одобрить или отклонить заявку, кроме прямых запросов к API.

export type AdminAuctionListingStatus =
  | 'PENDING_MODERATION'
  | 'QUEUED'
  | 'ACTIVE'
  | 'WON'
  | 'EXPIRED'
  | 'REJECTED'
  | 'WITHDRAWN';

export interface AdminAuctionListing {
  id: string;
  creatorProfileId: string;
  creatorDisplayName: string | null;
  portfolioItemId: string;
  portfolioItemTitle: string;
  portfolioItemVideoUrl: string;
  brandManifestId: string | null;
  includeBrandManifest: boolean;
  auctionType: 'BLITZ' | 'STANDARD';
  payoutCurrency: 'UAH' | 'USD' | 'EUR';
  rightsConfirmedAt: string;
  expiresAt: string | null;
  /** ИИ-оценка видео/брендбука (§22, Этап 3) — сводка для оператора, не автоматическое решение. */
  aiAssessment: string | null;
  brandManifestAiAudit: string | null;
  startingPrice: number;
  reservePrice: number | null;
  buyNowPrice: number | null;
  status: AdminAuctionListingStatus;
  rejectionReason?: string | null;
  highestBidAmount: number | null;
  bidCount: number;
  createdAt: string;
  /**
   * Информационная UAH-оценка текущей цены (highestBidAmount либо
   * startingPrice) через статичный курс backend/src/common/fx-rates.ts —
   * только чтобы на глаз сравнивать лоты в разных валютах в очереди.
   * null, если payoutCurrency уже UAH. НЕ авторитетная сумма сделки.
   */
  currentPriceUahEquivalent: number | null;
  /** Антиснайпер (ТЗ на живой аукцион §7.3) — чекбокс продавца при подаче заявки. */
  antiSnipeEnabled: boolean;
  /** Сколько раз реально продлился expiresAt антиснайпером. */
  extensions: number;
  /**
   * Живой аукцион (§7.8, ПРАВКА 1.4) — согласие продавца на живую
   * трансляцию лота, тот же приём, что antiSnipeEnabled. Без него
   * назначить студию нельзя, даже для BLITZ.
   */
  liveStreamOptIn: boolean;
  /** Живой аукцион (§7.8) — какая студия назначена лоту, null — ещё не назначена. */
  virtualStudioId: string | null;
  /** Живой аукцион (§7.5) — идёт ли сейчас трансляция прямо сейчас. */
  liveStreamActive: boolean;
}

export interface AdminAuctionListResult {
  items: AdminAuctionListing[];
  total: number;
  page: number;
  pageSize: number;
}

// ── Виртуальная студия (backend/src/modules/virtual-studio, Этап 1-3
// docs-tz/TZ-Virtualnaya-Studiya-i-AI-Vedushaya.md) — admin-only. ──

export type VirtualStudioStatusValue = 'DRAFT' | 'READY' | 'ARCHIVED';

export interface VirtualStudioVariant {
  id: string;
  studioId: string;
  imageUrl: string;
  prompt: string;
  createdAt: string;
}

export interface VirtualStudio {
  id: string;
  name: string;
  refPrompt: string;
  selectedVariantId: string | null;
  status: VirtualStudioStatusValue;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  variants?: VirtualStudioVariant[];
}

export type VirtualStudioFragmentKind = 'VIDEO' | 'VOICE' | 'ANALYSIS';
/** Тот же словарь, что GenerationStatus на бэкенде (common/types/generation.types.ts). */
export type VirtualStudioFragmentStatus = 'pending' | 'processing' | 'complete' | 'failed';

export interface VirtualStudioFragment {
  id: string;
  studioId: string;
  variantId: string | null;
  kind: VirtualStudioFragmentKind;
  status: VirtualStudioFragmentStatus;
  provider: string;
  voiceId: string | null;
  text: string | null;
  sourceVideoUrl: string | null;
  brandManifestId: string | null;
  resultUrl: string | null;
  resultText: string | null;
  providerJobId: string | null;
  durationSec: number | null;
  errorMessage: string | null;
  createdAt: string;
  readyAt: string | null;
}

export interface VirtualStudioVoiceOption {
  voiceId: string;
  name: string;
  previewUrl: string | null;
  accent: string | null;
}

// ── Каталог музыкальных тем поздравлений (фича №4) ──

export interface MusicCatalogThemeView {
  id: string;
  title: string;
  url: string;
  /** `null` — тема подходит любому поводу. */
  occasions: string[] | null;
}

/** Глобальный рубильник советника в мастере («Тонкая красная линия» §3.4). */
export interface AiGuideSettingsView {
  enabled: boolean;
  /** Общий дневной потолок расхода фичи, микродоллары. */
  dailyBudgetMicroUsd: number;
  /** Сколько подсказок в сутки положено одному человеку. */
  personalLimit: number;
}

/** Частичное сохранение: карточка правит поля по одному. */
export interface SetAiGuideSettingsInput {
  enabled?: boolean;
  dailyBudgetMicroUsd?: number;
  personalLimit?: number;
}

export interface MusicCatalogView {
  /** Сырое значение настройки — то, что оператор редактирует. */
  raw: string;
  /** Что из сырого значения реально приняли. */
  themes: MusicCatalogThemeView[];
  /** Сколько записей было в присланном JSON; `null` — разобрать не удалось. */
  submitted: number | null;
  /** Сколько отброшено при разборе. */
  rejected: number | null;
  maxThemes: number;
}

// ── Балансы провайдеров (TODO §III п.36) ──

export type ProviderBalanceState =
  | 'ok'
  | 'not-configured'
  | 'unsupported'
  | 'error';

export interface ProviderBalance {
  provider: string;
  state: ProviderBalanceState;
  /** Микродоллары — тот же масштаб, что у расходов. */
  amountMicroUsd?: number;
  /**
   * Сырое значение провайдера. У xAI это сальдо предоплатного журнала
   * в центах с обратным знаком: «−1827» и показанные «$18.27» — одно
   * и то же, и сверяющему с консолью надо видеть оба.
   */
  raw?: string;
  detail?: string;
  /**
   * Консоль провайдера: где посмотреть остаток своими глазами. У GROK
   * наше число расходится с консолью (аккаунт на постоплате), и пока
   * это не разобрано, экран обязан давать дорогу к первоисточнику.
   */
  dashboardUrl?: string;
  /**
   * Остаток НЕ в деньгах: символы у ElevenLabs, поиски у SerpApi
   * (этап 142). Отдельным полем, а не пересчётом в доллары — цена
   * единицы зависит от тарифа и меняется без нашего участия.
   */
  units?: {
    /** Отрицательное — перебор сверх лимита (у ElevenLabs это штатно). */
    left: number;
    total?: number;
    label: string;
    resetsAt?: string;
  };
  /** Разбивка журнала пополнений и списаний, если провайдер её отдал. */
  changes?: ProviderBalanceChanges;
  /** Сырой ответ — только когда остаток разобрать не удалось. */
  rawBody?: string;
  /**
   * `false` — продукт этим провайдером сейчас не пользуется (не выбран
   * «Озвучкой по умолчанию» и не встречается в свежих брендбуках и
   * сессиях), и сторож остатков о нём молчит. Нет поля — используется.
   */
  inUse?: boolean;
  /** Почему провайдер сочтён неиспользуемым. */
  usageNote?: string;
  checkedAt: string;
}

export interface ProviderBalanceChanges {
  purchasedMicroUsd: number;
  spentMicroUsd: number;
  entries: number;
  /** `false` — журнал пришёл неполным, разбивка справочная. */
  matchesTotal: boolean;
}

// ── Советник в мастере («Тонкая красная линия» §10) ────────────────

export interface WizardStatsView {
  cache: { rows: number; hits: number; hitRate: number };
  hints: { total: number; flagged: number; bySource: Record<string, number> };
}

export interface WizardStepFrequency {
  scenario: string;
  stepId: string;
  counts: Record<string, number>;
  total: number;
}

export interface WizardExperienceText {
  id: string;
  locale: string;
  symptom: string;
  cause: string | null;
  advice: string;
  source: string;
  reviewed: boolean;
  updatedAt: string;
}

export interface WizardExperienceRow {
  id: string;
  scenario: string;
  stepId: string;
  status: string;
  occurrences: number;
  createdAt: string;
  updatedAt: string;
  texts: WizardExperienceText[];
  /** Ключи словаря, которых больше нет, — запись не идёт в подсказку. */
  brokenKeys: string[];
  publishable: boolean;
}

export interface WizardCandidateRow {
  id: string;
  scenario: string;
  stepId: string;
  locale: string;
  rawText: string;
  origin: string;
  status: string;
  matchedId: string | null;
  matchScore: number | null;
  decision: string | null;
  why: string | null;
  createdAt: string;
  matched?: WizardExperienceRow | null;
}

export interface WizardSiblingStats {
  auto: number;
  suggest: number;
  histogram: {
    buckets: Array<{ from: number; count: number }>;
    decisions: Record<string, number>;
    total: number;
  };
}

export interface WizardTextInput {
  symptom: string;
  cause?: string;
  advice: string;
}

export interface WizardHintRow {
  id: string;
  createdAt: string;
  scenario: string;
  stepId: string;
  locale: string;
  source: string;
  hint: string;
  inTokens: number;
  outTokens: number;
  costMicroUsd: number;
  latencyMs: number;
  flagged: boolean;
}

// ── Приглашения («Условно бесплатный Lite» §11, этап 135) ──

export type ReferralsWindow = 'day' | 'week' | 'month';

export interface SuspiciousInviter {
  inviterId: string;
  telegramId: string | null;
  counted: number;
  /** Самая плотная пачка засчётов в пределах одного часа. */
  burst: number;
  burstStartedAt: string;
  /** Приглашения из этой пачки — то, что оператор и снимает. */
  burstReferralIds: string[];
  liteUnlocked: boolean;
}

export interface AdminReferralsOverview {
  window: ReferralsWindow;
  from: string;
  to: string;
  period: { identified: number; generated: number; revoked: number };
  /** Переходы не имеют даты (§5.2 — счётчик, а не строка), отсюда «за всё время». */
  allTime: {
    visits: number;
    identified: number;
    generated: number;
    /** `null` — переходов ещё не было, а не «ноль процентов». */
    visitToGenerated: number | null;
  };
  unlock: {
    target: number;
    active: number;
    earned: number;
    grandfathered: number;
    byOperator: number;
    revoked: number;
  };
  credits: {
    granted: number;
    /** Оценка сверху: списание не помнит, чей кредит потратили. */
    spentEstimate: number;
    /** `null` — ставки модели нет в прайсе, денег на экране не будет. */
    unitCostMicroUsd: number | null;
    grantedMicroUsd: number | null;
    spentEstimateMicroUsd: number | null;
  };
  suspicious: SuspiciousInviter[];
}

// ── Работа с тестировщиком (этапы 155–158) ─────────────────────────────
// Модель backend/src/modules/admin-panel/admin-tester-invites.service.ts и
// admin-test-tickets.service.ts — держать в синхроне вручную.

export interface TesterInvite {
  id: string;
  label: string;
  freeScenarios: string[];
  /** Операции вне проекта: клон голоса, озвучка, скетч, поиск (этап 159). */
  freeOutsideProject: boolean;
  /** Что проверять — текст брифа на экране `#/testing` (аудит 161). */
  brief: string | null;
  /** Свой суточный потолок в долларах. null — общий для тестовых. */
  dailyLimitUsd: number | null;
  expiresAt: string | null;
  /** Готовая ссылка — остаётся только скопировать. */
  link: string;
  activated: boolean;
  activatedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export type TicketStatus =
  | 'NEW'
  | 'IN_PROGRESS'
  | 'ANSWERED'
  | 'FIXED'
  | 'REJECTED'
  | 'DUPLICATE';

export interface TestTicketRow {
  id: string;
  number: number;
  createdAt: string;
  source: string;
  status: TicketStatus;
  preview: string;
  scenario: string | null;
  uiLocale: string;
  envKey: string | null;
  /** Окружение одной строкой — собрано на бэкенде, здесь только текст. */
  envSummary: string;
  /**
   * Окружение снято НЕ в момент находки. Из бота оно всегда последнее
   * известное: человек мог написать боту с телефона про то, что видел
   * на десктопе.
   */
  envStale: boolean;
  attachments: number;
  tester: { id: string; telegramId: string; label: string };
  replySentAt: string | null;
  replyFailedAt: string | null;
}

export interface TicketAttachment {
  url: string;
  kind: string;
  size: number;
  fileName: string | null;
  mimeType: string | null;
}

export interface TicketComment {
  at: string;
  from: 'TESTER' | 'OPERATOR';
  by?: string;
  text: string;
  attachments?: TicketAttachment[];
}

export interface TestTicketDetail extends TestTicketRow {
  text: string;
  env: Record<string, unknown> | null;
  envCapturedAt: string | null;
  appBuild: string | null;
  sessionId: string | null;
  sessionLocale: string | null;
  stepId: string | null;
  attachmentList: TicketAttachment[] | null;
  comments: TicketComment[] | null;
  statusBy: string | null;
  statusAt: string | null;
  statusNote: string | null;
  /** Открыт ли диалог с ботом — без него ответ отправить нельзя. */
  canReply: boolean;
  /**
   * Тикеты с ТЕМ ЖЕ ОКРУЖЕНИЕМ. Именно окружением, а не «похожие»: у
   * находки из бота нет ни сценария, ни шага, и ключ вырождается в «та
   * же платформа и локаль».
   */
  /** Сколько их всего — список ниже обрезан бэкендом. */
  sameEnvironmentTotal: number;
  sameEnvironment: Array<{
    id: string;
    number: number;
    createdAt: string;
    status: TicketStatus;
    preview: string;
  }>;
}

export interface TesterProgress {
  userId: string;
  telegramId: string;
  label: string;
  scenarios: Array<{
    scenario: FreeScenario;
    open: boolean;
    sessions: number;
    tickets: number;
  }>;
  /** До какого числа действует доступ. null — бессрочно. */
  accessUntil: string | null;
  accessActive: boolean;
  /** Фактический расход за сегодня и потолок этого тестировщика. */
  spentTodayMicroUsd: number;
  dailyLimitMicroUsd: number;
  openTickets: number;
  closedTickets: number;
  lastActivityAt: string | null;
}

// ── Кадры лендинга поздравлений (заход 8, doc/GREETING-FRAMES-CAPTURE.md) ──

/** Что сделает `POST …/greeting-frames/fixture-video` (бэкенд `fixtureVideoAction`). */
export type GreetingFixtureVideoAction =
  | 'none'
  | 'poll'
  | 'poll-post'
  | 'script-and-render'
  | 'render'
  | 'new-version-render';

export type GreetingFixtureVideoStage =
  | 'missing'
  | 'started'
  | 'rendering'
  | 'post-processing'
  | 'complete'
  | 'failed';

/** `GET /admin/ui-snapshot/greeting-frames/fixture-video/state` — только чтение базы. */
export interface GreetingFixtureVideoState {
  skipped?: string;
  sessionId?: string;
  sessionCreatedAt?: string;
  versions?: number;
  hasPrompt?: boolean;
  stage?: GreetingFixtureVideoStage;
  video?: {
    status: string;
    postStatus: string | null;
    postError: string | null;
    error: string | null;
    downloadUrl: string | null;
    initiatedAt: string | null;
    completedAt: string | null;
    resolution: string | null;
  };
  next?: { action: GreetingFixtureVideoAction; paid: boolean };
  rerender?: { action: GreetingFixtureVideoAction; paid: boolean } | null;
  /** Сколько стоил прошлый прогон с рендером (журнал расходов); null — неизвестно. */
  lastRun?: {
    sessionId: string;
    costMicroUsd: number;
    unpriced: boolean;
    at: string;
  } | null;
}

/** Ответ `POST …/fixture-video` — один шаг. */
export interface GreetingFixtureVideoResult {
  skipped?: string;
  sessionId?: string;
  stage?: Exclude<GreetingFixtureVideoStage, 'missing'>;
  postError?: string;
  video?: { status: string; downloadUrl?: string; postStatus?: string };
}

/** Ответ `POST /admin/ui-snapshot/greeting-frames` (форма `CaptureResult`). */
export interface GreetingFramesCaptureResult {
  skipped?: string;
  locales: Array<{
    locale: string;
    /** Адреса PNG по номеру кадра (1–4); неполный набор — смотри `problems`. */
    cards: Record<string, string>;
    problems: string[];
  }>;
}

// ── Отметка «младше 18» режима «Я в кадре» (В-4, заход 8) ──

export interface PersonaAgeClear {
  at: string;
  /** userId оператора. */
  by: string;
  reason: string;
  markedAt: string | null;
  refusals: string[];
}

/** `GET /admin/users/:id/persona-age`. Оценки возраста нет намеренно (§4.4 ТЗ). */
export interface PersonaAgeState {
  userId: string;
  personaEnabled: boolean;
  persona: {
    id: string;
    under18: boolean;
    markedAt: string | null;
    refusals: string[] | null;
    verified: boolean;
    deletePending: boolean;
    filesPending: boolean;
    consentGivenAt: string;
  } | null;
  /** Журнал снятий, новые сверху. */
  clears: PersonaAgeClear[];
}
