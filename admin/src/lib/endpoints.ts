import { apiGet, apiGetBlob, apiPost, apiPatch, apiPut, apiDelete } from './admin-api';
import type {
  AudioTracksResult,
  AudioTrackView,
  AdminReferralsOverview,
  ReferralsWindow,
  AdminCreatorProfile,
  AdminCreatorProfileListResult,
  AdminPortfolioItem,
  AdminPortfolioListResult,
  AdminAuctionListing,
  AdminAuctionListResult,
  ClientSiteDraftDetails,
  ClientSiteDraftListResult,
  ClientSiteDraftRow,
  ClientSiteDraftStatus,
  AdminLibraryEntry,
  AdminUserBrief,
  AdminUserDetail,
  AdminUserListResult,
  CostReport,
  PlanId,
  AdminLibraryEntryDetail,
  AdminLibraryPage,
  AdminMe,
  LibraryVisibility,
  SessionListResult,
  SessionDetail,
  SessionSortKey,
  SortDirection,
  AuditStateView,
  VideoVersion,
  TelemetryResult,
  EnvSettingsResult,
  AudioSeparationSettingsView,
  TutorialLocalesSettingsView,
  TutorialMotion,
  TutorialVoiceSettingsView,
  AudioSeparationState,
  VoiceoverProviderKey,
  VoiceoverProviderSettingsView,
  SpeechRecognitionProviderKey,
  SpeechRecognitionProviderSettingsView,
  VoiceAssistantSettingsView,
  SetVoiceAssistantInput,
  PersonaLookQuotaSettingsView,
  SetPersonaLookQuotaInput,
  MusicCatalogView,
  AiGuideSettingsView,
  SetAiGuideSettingsInput,
  WizardCandidateRow,
  WizardExperienceRow,
  WizardHintRow,
  WizardSiblingStats,
  WizardStatsView,
  WizardStepFrequency,
  WizardTextInput,
  ProviderBalance,
  AnalysisProviderKey,
  AnalysisProviderSettingsView,
  VideoProviderKey,
  VideoProviderSettingsView,
  GrokTransportKey,
  GrokTransportSettingsView,
  AssistantAdminSettingsView,
  SetAssistantSettingsInput,
  AssistantAdminResult,
  TutorialVideoListResult,
  TutorialVideoDataStatus,
  TutorialTempoEstimate,
  TutorialVersionRow,
  TutorialVideoAssetRow,
  TutorialScenarioListResult,
  TutorialScenarioRow,
  FixtureSeedResult,
  PublicationListResult,
  PublicationPlatform,
  PublicationPrivacy,
  PublicationRequest,
  SharedVideoListResult,
  SharedVideoPage,
  AdminBlogPostDetail,
  AdminBlogPostPage,
  AdminPaymentListResult,
  AdminPaymentRow,
  AdminBroadcastListResult,
  AdminCatalogBatchListResult,
  AdminAbTestListResult,
  AdminFeedImportListResult,
  CronJobInfo,
  CronRunLog,
  UiSnapshotList,
  UiSnapshotSummary,
  CronSummary,
  AvatarVideo,
  SoundCheckState,
  WorkflowWindow,
  WorkflowFunnelResult,
  WorkflowCohortConversionResult,
  VirtualStudio,
  VirtualStudioVariant,
  VirtualStudioFragment,
  VirtualStudioVoiceOption,
  TesterInvite,
  TesterProgress,
  TestTicketDetail,
  TestTicketRow,
  TicketStatus,
  TutorialScenarioSaveResult,} from './types';

// ── Аутентификация (backend/src/modules/admin-auth) ──

export interface TelegramLoginWidgetPayload {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

// Ответ содержит только expiresAt — сам токен сессии живёт исключительно
// в httpOnly cookie и клиентскому JS недоступен (см.
// admin-auth.controller.ts на бэкенде).
export function telegramCallback(payload: TelegramLoginWidgetPayload) {
  return apiPost<{ expiresAt: string }>('/admin/auth/telegram-callback', payload);
}

export function logout() {
  return apiPost<{ ok: true }>('/admin/auth/logout');
}

/** Docker dev-запуск (см. doc/TELEGRAM-ADMIN.md) — вход без Telegram
 * Login Widget. На бэкенде эндпоинт отвечает 404, если ALLOW_DEV_AUTH
 * !=true или NODE_ENV=production. */
export function devLogin(devUserId: string) {
  return apiPost<{ expiresAt: string }>('/admin/auth/dev-login', { devUserId });
}

export function getMe() {
  return apiGet<AdminMe>('/admin/auth/me');
}

// ── Сессии (backend/src/modules/admin-panel) ──

export function listSessions(
  params: {
    status?: string;
    quality?: string;
    voiceMode?: string;
    plan?: string;
    createdFrom?: string;
    createdTo?: string;
    search?: string;
    sortBy?: SessionSortKey;
    sortDir?: SortDirection;
    page?: number;
    pageSize?: number;
  } = {}
) {
  return apiGet<SessionListResult>('/admin/sessions', params);
}

export function getSession(id: string) {
  return apiGet<SessionDetail>(`/admin/sessions/${id}`);
}

export function deleteSession(id: string) {
  return apiDelete<{ ok: true }>(`/admin/sessions/${id}`);
}

/**
 * Звуковые дорожки ролика (этап 139). Список сам дозабирает готовые
 * сборки на бэкенде — отдельного «обновить» для этого не нужно.
 */
export function getAudioTracks(sessionId: string) {
  return apiGet<AudioTracksResult>(`/admin/audio-tracks/${sessionId}`);
}

/**
 * Собрать ОДНУ дорожку. По одной за запрос: перевод, синтез и задача
 * ffmpeg — это десятки секунд, и четыре подряд не укладывались в таймаут
 * функции. Экран идёт по списку `toBuild` сам.
 */
export function buildAudioTrack(sessionId: string, locale: string) {
  return apiPost<AudioTrackView>(
    `/admin/audio-tracks/${sessionId}/build/${locale}`
  );
}

/**
 * Отметка «залито в Studio». Именно отметка, а не проверка: API
 * звуковых дорожек у YouTube нет вовсе.
 */
export function setAudioTrackUploaded(id: string, uploaded: boolean) {
  return apiPost<AudioTrackView>(`/admin/audio-tracks/track/${id}/uploaded`, {
    uploaded,
  });
}

/** Доп. запрос владельца продукта: тот же платный рендер с теми же
 * настройками, что и кнопка «Повторить» у пользователя — просто из
 * админки. Работает только для сессий с проваленным рендером. */
export function retrySessionGeneration(id: string) {
  return apiPost<SessionDetail>(`/admin/sessions/${id}/retry`);
}

/** Без этого опроса рендер, запущенный из админки (retry выше), никогда
 * не продвинется дальше 'processing' — у оператора нет собственного
 * визарда, который опрашивал бы статус за пользователя. */
export function pollSessionStatus(id: string) {
  return apiGet<SessionDetail>(`/admin/sessions/${id}/status`);
}

/** Доп. запрос владельца продукта: проверка на артефакты прямо из
 * админки. Идёт через `/admin/sessions/:id/audit`, НЕ через публичный
 * `/sessions/:id/audit` — тот стоит за `SessionOwnerGuard` и требует
 * Telegram-личность владельца сессии, которой у оператора нет и быть
 * не может (см. доккомментарий `AdminGenerationRetryController`).
 * Результат при этом всё равно виден клиенту: адмінский маршрут пишет
 * в ту же `Session.data.videoAudit`, что читает визард пользователя. */
export function runVideoAudit(sessionId: string) {
  return apiPost<AuditStateView>(`/admin/sessions/${sessionId}/audit`);
}

/** Доп. запрос владельца продукта, после реального случая: аудит нашёл
 * артефакты, и простое «Повторить» с тем же промптом воспроизвело бы их
 * снова. Применяет предложенное аудитом исправление к черновику
 * промпта, одобряет его за отсутствующего пользователя и тут же
 * перегенерирует — три шага одним кликом. */
export function applyFixAndRetry(sessionId: string) {
  return apiPost<SessionDetail>(`/admin/sessions/${sessionId}/apply-fix-and-retry`);
}

/** Доп. запрос владельца продукта: «должно быть несколько кнопок для
 * каждой версии» — раньше каждая новая попытка молча перезаписывала
 * файл предыдущей в Blob, смотреть было нечего. Теперь путь на попытку
 * уникален, и этот маршрут собирает их все вместе с их же аудитами. */
export function getSessionVersions(sessionId: string) {
  return apiGet<VideoVersion[]>(`/admin/sessions/${sessionId}/versions`);
}

export function getTelemetry() {
  return apiGet<TelemetryResult>('/admin/telemetry');
}

/** Никогда не содержит секретных значений (ключей/токенов/строк
 * подключения к БД) — только статус "задано корректно / нет" и
 * пояснение, см. backend/src/modules/admin-panel/env-settings.ts. */
export function getEnvSettings() {
  return apiGet<EnvSettingsResult>('/admin/settings');
}

/** «Озвучка по умолчанию» — в отличие от getEnvSettings() выше, это не
 * диагностика, а редактируемая настройка (см. её PATCH ниже). */
export function getVoiceoverProviderSettings() {
  return apiGet<VoiceoverProviderSettingsView>('/admin/settings/voiceover-provider');
}

export function getAudioSeparationSettings() {
  return apiGet<AudioSeparationSettingsView>('/admin/settings/audio-separation');
}

export function setAudioSeparationState(state: AudioSeparationState) {
  return apiPatch<AudioSeparationSettingsView>('/admin/settings/audio-separation', {
    state,
  });
}

/** Языки генерации сценариев обучалки — пятый уровень отката §9 ТЗ
 * TZ-Tutorial-Video-Voiced.md: сузить до ['ru'] без деплоя. */
export function getTutorialLocalesSettings() {
  return apiGet<TutorialLocalesSettingsView>('/admin/settings/tutorial-locales');
}

export function setTutorialLocalesSettings(raw: string) {
  return apiPatch<TutorialLocalesSettingsView>('/admin/settings/tutorial-locales', { raw });
}

/** Озвучка обучающих роликов — третий уровень отката §9 ТЗ
 * TZ-Tutorial-Video-Voiced.md: выключается без деплоя. */
export function getTutorialVoiceSettings() {
  return apiGet<TutorialVoiceSettingsView>('/admin/settings/tutorial-voice');
}

export function setTutorialVoiceSettings(input: {
  enabled: boolean;
  voiceId?: string | null;
  /** Обязательное: «не прислали — оставить как было» завело бы у
   *  выключателя третье состояние. */
  requireNarrationReview: boolean;
  /** Обязательное по той же причине. */
  captions: boolean;
  /** Движение (этап G). Обязательное по той же причине. */
  motion: TutorialMotion;
  /** Указатель клика (этап H). Обязательное по той же причине. */
  pointer: boolean;
}) {
  return apiPatch<TutorialVoiceSettingsView>('/admin/settings/tutorial-voice', input);
}

/** «Распознавание речи» — Gemini или Soniox для всего голосового ввода. */
export function getSpeechRecognitionSettings() {
  return apiGet<SpeechRecognitionProviderSettingsView>('/admin/settings/speech-recognition-provider');
}

export function setSpeechRecognitionProvider(provider: SpeechRecognitionProviderKey) {
  return apiPatch<SpeechRecognitionProviderSettingsView>('/admin/settings/speech-recognition-provider', {
    provider,
  });
}

/** «Голосовой помощник» — суточные потолки голоса по тарифу (В-14) и голос помощника (В-11). */
export function getVoiceAssistantSettings() {
  return apiGet<VoiceAssistantSettingsView>('/admin/settings/voice-assistant');
}

export function setVoiceAssistantSettings(input: SetVoiceAssistantInput) {
  return apiPatch<VoiceAssistantSettingsView>('/admin/settings/voice-assistant', input);
}

/** «Квота образов «Я в кадре»» — новых образов персоны в сутки и в месяц по тарифу (В-7). */
export function getPersonaLookQuotaSettings() {
  return apiGet<PersonaLookQuotaSettingsView>('/admin/settings/persona-look-quota');
}

export function setPersonaLookQuotaSettings(input: SetPersonaLookQuotaInput) {
  return apiPatch<PersonaLookQuotaSettingsView>('/admin/settings/persona-look-quota', input);
}

export function setVoiceoverProviderDefault(provider: VoiceoverProviderKey) {
  return apiPatch<VoiceoverProviderSettingsView>('/admin/settings/voiceover-provider', {
    provider,
  });
}

/**
 * «Каталог музыки для поздравлений» (фича №4). В отличие от соседних
 * селекторов значение здесь не одно слово из списка, а JSON, который
 * оператор вставляет целиком; разбор на бэкенде терпимый, поэтому
 * ответ несёт ещё и РАЗОБРАННЫЙ каталог — иначе опечатка в ссылке
 * выглядела бы как «сохранилось, но темы не появилось».
 */
export function getMusicCatalog() {
  return apiGet<MusicCatalogView>('/admin/settings/music-catalog');
}

/** Пустая строка — осмысленное значение: «выключить музыку в мастере». */
export function setMusicCatalog(raw: string) {
  return apiPatch<MusicCatalogView>('/admin/settings/music-catalog', { raw });
}

/**
 * Глобальный рубильник советника в мастере («Тонкая красная линия»
 * §3.4). Отдельно от ассистента: разные фичи, разные бюджеты.
 */
export function getAiGuideSettings() {
  return apiGet<AiGuideSettingsView>('/admin/settings/ai-guide');
}

/**
 * Пишутся только переданные поля. Слать всю карточку целиком нельзя:
 * сохранение бюджета возвращало бы рубильник к тому значению, которое
 * лежало на экране в момент загрузки.
 */
export function setAiGuideSettings(input: SetAiGuideSettingsInput) {
  return apiPatch<AiGuideSettingsView>('/admin/settings/ai-guide', input);
}

/** «Разбор референса по умолчанию» — тот же принцип, что у озвучки выше
 * (ТЗ §17). */
export function getAnalysisProviderSettings() {
  return apiGet<AnalysisProviderSettingsView>('/admin/settings/analysis-provider');
}

export function setAnalysisProviderDefault(provider: AnalysisProviderKey) {
  return apiPatch<AnalysisProviderSettingsView>('/admin/settings/analysis-provider', {
    provider,
  });
}

/** «Провайдер видео-генерации по умолчанию» — тот же принцип, что у
 * озвучки/разбора выше (ТЗ §11.1/§20 — админская половина решения,
 * найденная недостающей при аудите). */
export function getVideoProviderSettings() {
  return apiGet<VideoProviderSettingsView>('/admin/settings/video-provider');
}

export function setVideoProviderDefault(provider: VideoProviderKey) {
  return apiPatch<VideoProviderSettingsView>('/admin/settings/video-provider', {
    provider,
  });
}

/** «Транспорт Grok для одиночных роликов» — синхронные вызовы или
 * Batch API (доп. запрос владельца продукта, 14.09.2026). */
export function getGrokTransportSettings() {
  return apiGet<GrokTransportSettingsView>('/admin/settings/grok-transport');
}

export function setGrokTransport(transport: GrokTransportKey) {
  return apiPatch<GrokTransportSettingsView>('/admin/settings/grok-transport', {
    transport,
  });
}

// ── Воронка движения по воркфлоу (этап 78, doc/WORKFLOW-FUNNEL-SPEC.md,
// doc/WORKFLOW-FUNNEL-COHORT-CONVERSION-SPEC.md) ──

export function getWorkflowFunnel(window: WorkflowWindow) {
  return apiGet<WorkflowFunnelResult>('/admin/workflow-funnel', { window });
}

export function getWorkflowCohortConversion(window: WorkflowWindow) {
  return apiGet<WorkflowCohortConversionResult>(
    '/admin/workflow-funnel/cohort-conversion',
    { window },
  );
}

// ── Очередь публикации (backend/src/modules/publication) ──
// Оператор подтверждает/отклоняет; APPROVED с назначенным каналом
// подхватывает крон-воркер выгрузки (этап 61, ТЗ §14.5) — сам
// PUBLISHED/FAILED и внешняя ссылка появляются уже без участия оператора.

export function listPublications(params: { status?: string; page?: number; pageSize?: number } = {}) {
  return apiGet<PublicationListResult>('/admin/publications', params);
}

export function getPublication(id: string) {
  return apiGet<PublicationRequest>(`/admin/publications/${id}`);
}

/** channelId — необязательный ручной выбор; без него сервис сам находит
 * канал проекта/бренда/единственный канал автора (§14.2). */
export function approvePublication(
  id: string,
  opts: { channelId?: string; privacy?: PublicationPrivacy } = {},
) {
  return apiPost<PublicationRequest>(`/admin/publications/${id}/approve`, opts);
}

export function rejectPublication(id: string, reason: string) {
  return apiPost<PublicationRequest>(`/admin/publications/${id}/reject`, { reason });
}

/** FAILED → APPROVED, backoff сброшен (§14.5) — попробовать выгрузку заново. */
export function retryPublication(id: string) {
  return apiPost<PublicationRequest>(`/admin/publications/${id}/retry`);
}

// ── Публичная страница ролика (backend/src/modules/shared-video, этап 60) ──
// Тот же паттерн модерации: PENDING → PUBLISHED (страница сразу видна на
// landing/video/:id) | REJECTED (с причиной, копия ролика не удаляется —
// автор может отозвать её сам в любом статусе).

export function listSharedVideos(params: { status?: string; page?: number; pageSize?: number } = {}) {
  return apiGet<SharedVideoListResult>('/admin/shared-videos', params);
}

export function getSharedVideo(id: string) {
  return apiGet<SharedVideoPage>(`/admin/shared-videos/${id}`);
}

export function approveSharedVideo(id: string) {
  return apiPost<SharedVideoPage>(`/admin/shared-videos/${id}/approve`);
}

export function rejectSharedVideo(id: string, reason: string) {
  return apiPost<SharedVideoPage>(`/admin/shared-videos/${id}/reject`, { reason });
}

/** Кураторский отбор в публичную витрину (§5 docs-tz/TZ-Greeting-Video-Landing.md). */
export function setSharedVideoShowcase(id: string, showcase: boolean) {
  return apiPost<SharedVideoPage>(`/admin/shared-videos/${id}/showcase`, { showcase });
}

// ── Библиотека разборов (§21.1) ────────────────────────────────────────

export async function listLibrary(params: {
  visibility?: string;
  sourceType?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}): Promise<AdminLibraryPage> {
  return apiGet<AdminLibraryPage>('/admin/library', params);
}

export async function getLibraryEntry(
  id: string
): Promise<AdminLibraryEntryDetail> {
  return apiGet<AdminLibraryEntryDetail>(`/admin/library/${id}`);
}

export async function updateLibraryEntry(
  id: string,
  patch: {
    visibility?: LibraryVisibility;
    hiddenReason?: string | null;
    category?: string | null;
  }
): Promise<AdminLibraryEntry> {
  return apiPatch<AdminLibraryEntry>(`/admin/library/${id}`, patch);
}

export async function deleteLibraryEntry(id: string): Promise<void> {
  await apiDelete<void>(`/admin/library/${id}`);
}


// ── Блог/новости (backend/src/modules/blog, ТЗ §36/§37) ────────────────
// Тот же паттерн модерации, что публикации/библиотека:
// approve/reject/publish/unpublish — отдельные POST, а не PATCH статуса,
// потому что у каждого перехода своя проверка (см. blog.controller.ts).

export function listBlogPosts(params: {
  status?: string;
  category?: string;
  page?: number;
  pageSize?: number;
}) {
  return apiGet<AdminBlogPostPage>('/admin/blog', params);
}

export function getBlogPost(id: string) {
  return apiGet<AdminBlogPostDetail>(`/admin/blog/${id}`);
}

export function createBlogPost(body: {
  category: string;
  title: string;
  bodyHtml: string;
  originalLocale?: string;
}) {
  return apiPost<AdminBlogPostDetail>('/admin/blog', body);
}

export function updateBlogPost(
  id: string,
  patch: { title?: string; bodyHtml?: string; category?: string }
) {
  return apiPatch<AdminBlogPostDetail>(`/admin/blog/${id}`, patch);
}

export function approveBlogPost(id: string) {
  return apiPost<AdminBlogPostDetail>(`/admin/blog/${id}/approve`);
}

export function rejectBlogPost(id: string, reason: string) {
  return apiPost<AdminBlogPostDetail>(`/admin/blog/${id}/reject`, { reason });
}

export function publishBlogPost(id: string) {
  return apiPost<AdminBlogPostDetail>(`/admin/blog/${id}/publish`);
}

export function unpublishBlogPost(id: string) {
  return apiPost<AdminBlogPostDetail>(`/admin/blog/${id}/unpublish`);
}

export function deleteBlogPost(id: string) {
  return apiDelete<void>(`/admin/blog/${id}`);
}

// ── Пользователи (ТЗ §25) ──────────────────────────────────────────────
// Режим и флаг оператора правятся здесь, а не в psql. Снять оператора с
// самого себя бэкенд не даст — иначе некому будет вернуть.

export function listUsers(params: {
  q?: string;
  plan?: string;
  operators?: string;
  blocked?: string;
  page?: number;
  pageSize?: number;
}) {
  return apiGet<AdminUserListResult>('/admin/users', params);
}

export function getUser(id: string) {
  return apiGet<AdminUserDetail>(`/admin/users/${id}`);
}

/** Подписи для id пользователей на любом экране (до 200 id за раз).
 *  Батчит и кеширует `lib/user-briefs.ts` — напрямую из страниц не звать. */
export function getUserBriefs(ids: string[]) {
  return apiGet<AdminUserBrief[]>('/admin/users/brief', { ids: ids.join(',') });
}

/** Аватар из Telegram; null — фото нет (бэкенд ответил 404). */
export function getUserAvatar(id: string) {
  return apiGetBlob(`/admin/users/${encodeURIComponent(id)}/avatar`);
}

export function patchUser(
  id: string,
  patch: {
    plan?: PlanId;
    isOperator?: boolean;
    isBlocked?: boolean;
    blockedReason?: string;
    isTestUser?: boolean;
    /** Полный набор галочек, а не добавка: иначе снять одну нечем. */
    freeScenarios?: string[];
    /** Операции вне проекта — своя галочка (этап 159). */
    freeOutsideProject?: boolean;
  }
) {
  return apiPatch<AdminUserDetail>(`/admin/users/${id}`, patch);
}

// ── Расходы (ТЗ §26) ───────────────────────────────────────────────────

export function getCosts(params: { top?: number } = {}) {
  return apiGet<CostReport>('/admin/costs', params);
}

/**
 * «Сколько ОСТАЛОСЬ» — в отличие от `getCosts` выше, отвечающего на
 * «сколько потрачено». `refresh` обходит кеш бэкенда: ограничение
 * частоты у провайдера чужое, и доводит до него наш экран.
 */
export function getProviderBalances(refresh = false) {
  return apiGet<{ items: ProviderBalance[] }>(
    '/admin/balances',
    refresh ? { refresh: '1' } : undefined,
  );
}

// ── Оплата (ТЗ §41, этап 62) ────────────────────────────────────────────
// Возврат устроен по-разному для двух провайдеров: у Stars это настоящий
// вызов API, у WayForPay — только пометка REFUNDED (деньги оператор
// возвращает вручную в личном кабинете WayForPay, см. AdminBillingService).

export function listPayments(params: {
  status?: string;
  method?: string;
  page?: number;
  pageSize?: number;
} = {}) {
  return apiGet<AdminPaymentListResult>('/admin/payments', params);
}

export function refundPayment(id: string) {
  return apiPost<AdminPaymentRow>(`/admin/payments/${id}/refund`);
}

/** Ставит cancelAtPeriodEnd — доступ остаётся до конца уже оплаченного
 * периода, без возврата денег (это отдельное действие «Возврат»). */
export function cancelSubscription(userId: string) {
  return apiPost<AdminUserDetail>(`/admin/users/${userId}/cancel-subscription`);
}

/** Е-1.5 шестого аудита: ручная правка баланса кредитов оператором —
 * `CreditLedgerService.adminAdjust()` был реализован с этапа 62, но
 * отсюда никогда не вызывался. Положительная дельта — компенсация,
 * отрицательная — списание/исправление ошибочного начисления. */
export function adjustCredit(userId: string, delta: number) {
  return apiPost<AdminUserDetail>(`/admin/users/${userId}/credit-adjust`, {
    delta,
  });
}

// ── Рекламный канал (ТЗ §42, этап 63) ──────────────────────────────────
// Read-only: отбор контента для выпуска автоматический (см.
// AdminMarketingService на бэкенде), оператору здесь нечего нажимать.

export function listMarketingBroadcasts(
  params: { page?: number; pageSize?: number } = {},
) {
  return apiGet<AdminBroadcastListResult>('/admin/marketing/broadcasts', params);
}

// ── Пакетная генерация по каталогу (ТЗ §44, этап 65) ───────────────────
// Read-only: партия либо идёт, либо завершилась, оператору здесь нечего
// нажимать (см. AdminCatalogBatchService на бэкенде).

export function listCatalogBatches(
  params: { page?: number; pageSize?: number } = {},
) {
  return apiGet<AdminCatalogBatchListResult>('/admin/catalog-batches', params);
}

// ── A/B-варианты одного ролика (TODO §III.6, этап 66) ───────────────────
// Read-only: запуск либо идёт, либо завершился, оператору здесь нечего
// нажимать (см. AdminAbTestService на бэкенде).

export function listAbTests(
  params: { page?: number; pageSize?: number } = {},
) {
  return apiGet<AdminAbTestListResult>('/admin/ab-tests', params);
}

// ── Импорт товарного фида по ссылке (TODO §Уровень 2 п.8, этап 68) ─────
// Read-only: импорт либо идёт, либо завершился, оператору здесь нечего
// нажимать (см. AdminFeedImportService на бэкенде).

export function listFeedImports(
  params: { page?: number; pageSize?: number } = {},
) {
  return apiGet<AdminFeedImportListResult>('/admin/feed-imports', params);
}

// ── Кроны: реестр + ручной запуск (доп. ТЗ «Кроны в админке», этап 69,
// аналогично Solar Shop) ─────────────────────────────────────────────

export function getCronRegistry() {
  return apiGet<CronJobInfo[]>('/admin/cron/registry');
}

/** Без jobKey — последние прогоны по всем джобам вперемешку; страница
 * сама берёт последний на каждый jobKey (см. lastRunFor() в page.tsx).
 * since/until — ISO, полуинтервал [since, until); limit — до 500;
 * before — id последней строки предыдущей страницы. */
export function getCronHistory(
  params: { jobKey?: string; since?: string; until?: string; limit?: number; before?: string } = {},
) {
  return apiGet<CronRunLog[]>('/admin/cron/history', params);
}

/** Сводка по каждому джобу за период [since, until). */
export function getCronSummary(since: string, until: string) {
  return apiGet<CronSummary>('/admin/cron/summary', { since, until });
}

export function runCronJob(jobKey: string, debug: boolean) {
  return apiPost<CronRunLog>(`/admin/cron/${jobKey}/run?debug=${debug}`);
}

// ── Снимки интерфейса (крон ui-snapshot-run) ───────────────────────────

/** Сводка по маршрутам с `since` (ISO; по умолчанию — сутки). */
export function getUiSnapshotSummary(since?: string) {
  return apiGet<UiSnapshotSummary>('/admin/ui-snapshot/summary', { since });
}

/** Лента снимков, новые сверху. `changed: 'true'` — только изменившиеся
 * (фильтр в базе); `before` — `nextBefore` прошлой страницы. */
export function getUiSnapshots(
  params: { route?: string; since?: string; limit?: number; before?: string; changed?: 'true' } = {},
) {
  return apiGet<UiSnapshotList>('/admin/ui-snapshot/snapshots', params);
}

// ── Пилот говорящего AI-аватара (backend/src/modules/actors, этап 72,
// doc/AVATAR-LIPSYNC-PIPELINE-SPEC.md §5.3) — admin-only, ручной запуск. ──

export function generateAvatarVideo(
  sessionId: string,
  body: {
    characterIndex: number;
    prompt?: string;
    aspectRatio?: string;
    resolution?: string;
    subtitles?: boolean;
  },
) {
  return apiPost<AvatarVideo>(`/admin/actors/${sessionId}/generate`, body);
}

export function getAvatarVideoStatus(sessionId: string) {
  return apiGet<AvatarVideo>(`/admin/actors/${sessionId}/status`);
}

// Этап 73: звуковой чек аватар-ролика — «звучит ли голос как живой
// человек», отдельный платный Gemini-вызов, не часть generate/status выше.
export function getAvatarSoundCheck(sessionId: string) {
  return apiGet<SoundCheckState>(`/admin/actors/${sessionId}/sound-check`);
}

export function runAvatarSoundCheck(sessionId: string) {
  return apiPost<SoundCheckState>(`/admin/actors/${sessionId}/sound-check`);
}

// ── ИИ-консультант на лендинге (doc/LANDING-TUTORIAL-AI-CONSULTANT-SPEC.md) ──

export function getAssistantSettings() {
  return apiGet<AssistantAdminSettingsView>('/admin/settings/assistant');
}

export function setAssistantSettings(input: SetAssistantSettingsInput) {
  return apiPatch<AssistantAdminSettingsView>('/admin/settings/assistant', input);
}

export function getAssistantAdmin(params: {
  flagged?: boolean;
  locale?: string;
  stepId?: number;
  search?: string;
  page?: number;
  pageSize?: number;
  days?: 7 | 30;
}) {
  return apiGet<AssistantAdminResult>('/admin/assistant', {
    flagged: params.flagged === undefined ? undefined : String(params.flagged),
    locale: params.locale,
    stepId: params.stepId,
    search: params.search,
    page: params.page,
    pageSize: params.pageSize,
    days: params.days,
  });
}

// ── Сценарии обучалки — одобрение costly=true перед автоматическим
// исполнением (§4.10/§4.11 ТЗ,
// backend/src/modules/tutorial-scenario/tutorial-scenario-admin.*, этап
// 94; страница подключена этапом 105) ──

export function getTutorialScenarios(params: {
  subjectKey?: string;
  locale?: string;
  costly?: boolean;
  approved?: boolean;
  page?: number;
  pageSize?: number;
}) {
  return apiGet<TutorialScenarioListResult>('/admin/tutorial-scenarios', {
    subjectKey: params.subjectKey,
    locale: params.locale,
    costly: params.costly === undefined ? undefined : String(params.costly),
    approved: params.approved === undefined ? undefined : String(params.approved),
    page: params.page,
    pageSize: params.pageSize,
  });
}

export function approveTutorialScenario(id: string) {
  return apiPatch<TutorialScenarioRow>(`/admin/tutorial-scenarios/${id}/approve`);
}

/**
 * Очередь модерации обучалок по САЙТУ ЗАКАЗЧИКА (§5.2/§8.3
 * doc/CLIENT-SITE-TUTORIAL-SPEC.md, этап 113). Отдельно от сценариев
 * выше: там одобряется право потратить наши деньги на платный шаг, а
 * здесь — право показать от имени продукта видео с ЧУЖИМ сайтом в
 * кадре, где вдобавок мог остаться необратимый шаг («Оплатить»).
 */
export function getClientSiteDrafts(params: {
  status?: ClientSiteDraftStatus;
  page?: number;
  pageSize?: number;
}) {
  return apiGet<ClientSiteDraftListResult>('/admin/site-tutorial-drafts', {
    status: params.status,
    page: params.page,
    pageSize: params.pageSize,
  });
}

export function getClientSiteDraft(id: string) {
  return apiGet<ClientSiteDraftDetails>(`/admin/site-tutorial-drafts/${id}`);
}

/** Одобрение — ИМЕННО оно запускает платную сборку ролика (§8.3). */
export function approveClientSiteDraft(id: string) {
  return apiPatch<ClientSiteDraftRow>(
    `/admin/site-tutorial-drafts/${id}/approve`,
  );
}

export function rejectClientSiteDraft(id: string, reason: string) {
  return apiPatch<ClientSiteDraftRow>(
    `/admin/site-tutorial-drafts/${id}/reject`,
    { reason },
  );
}

/**
 * Заменяет шаги сценария написанными руками (этап C + сквозной аудит
 * A+B+C). Промпт нарочно отдаёт плейсхолдеры селекторов, «которые
 * оператор поправит на настоящие», — это и есть тот рычаг. Строка
 * помечается `generatedBy: manual`, генератор её больше не трогает;
 * одобрение и результат прошлого прогона сбрасываются.
 */
export function replaceTutorialScenarioSteps(id: string, steps: string) {
  return apiPatch<TutorialScenarioSaveResult>(
    `/admin/tutorial-scenarios/${id}/steps`,
    { steps },
  );
}

/** Отметка «реплики прочитаны» (этап D). Снимаемая: перечитал,
 *  передумал, снял. */
export function setTutorialScenarioNarrationReviewed(
  id: string,
  reviewed: boolean,
) {
  return apiPatch<TutorialScenarioRow>(
    `/admin/tutorial-scenarios/${id}/narration-reviewed`,
    { reviewed },
  );
}

/**
 * Удаляет сгенерированный сценарий (этап 106) — нужно для сломанных
 * сценариев и как единственный способ сбросить устаревшее одобрение:
 * генератор снимает его только при изменившихся платных шагах, а
 * кнопки «отозвать» нет. Удалённая строка пересоздаётся ближайшей
 * ночью — уже неодобренной.
 */
export function deleteTutorialScenario(id: string) {
  return apiDelete<{ id: string }>(`/admin/tutorial-scenarios/${id}`);
}

/**
 * Заводит/обновляет фикстурного пользователя для регресс-раннера
 * обучалки (§3.3 ТЗ, этап 105) — то же самое, что раньше требовало
 * ручного CLI-запуска `scripts/seed-fixture-user.ts` с прод
 * DATABASE_URL. `telegramId` берёт из FIXTURE_TELEGRAM_ID окружения
 * бэкенда сам, аргументов не принимает.
 */
export function seedFixtureUser() {
  return apiPost<FixtureSeedResult>('/admin/tutorial-runner/seed-fixture-user');
}

// ── Обучающие видео — вкладки «Видео-контент»/«Состояние данных»
// (doc/TMA-UI-SNAPSHOT-AND-TUTORIAL-VIDEO-SPEC.md §4.9,
// backend/src/modules/tutorial-runner/tutorial-video-admin.*, этап 99) ──

export function getTutorialVideoAssets(params: {
  subjectKey?: string;
  locale?: string;
  reviewed?: boolean;
  page?: number;
  pageSize?: number;
}) {
  return apiGet<TutorialVideoListResult>('/admin/tutorial-video-assets', {
    subjectKey: params.subjectKey,
    locale: params.locale,
    reviewed: params.reviewed === undefined ? undefined : String(params.reviewed),
    page: params.page,
    pageSize: params.pageSize,
  });
}

export function setTutorialVideoReviewed(id: string, reviewed: boolean) {
  return apiPatch<TutorialVideoAssetRow>(`/admin/tutorial-video-assets/${id}/review`, {
    reviewed,
  });
}

export function getTutorialVideoDataStatus() {
  return apiGet<TutorialVideoDataStatus>('/admin/tutorial-video-assets/data-status');
}

/**
 * Этап 101 (ТЗ §4.7, Фаза 3) — публикация одобренного обучающего видео на
 * YouTube/TikTok, тем же конвейером, что рекламные ролики
 * (`PublicationService.publishTutorialVideo`). В отличие от
 * `approvePublication`, `channelId` здесь ОБЯЗАТЕЛЕН — угадывать канал
 * неоткуда (нет ни проекта, ни бренд-манифеста), он должен принадлежать
 * именно оператору, вызвавшему публикацию.
 */
export function publishTutorialVideo(
  id: string,
  opts: {
    platform: PublicationPlatform;
    channelId: string;
    privacy?: PublicationPrivacy;
    title?: string;
    description?: string;
    tags?: string[];
  },
) {
  return apiPost<PublicationRequest>(`/admin/tutorial-video-assets/${id}/publish`, opts);
}

// ── Темп обучалок (06.10.2026): версия публичного демо становится
// действующей ТОЛЬКО по «Одобрить версию» — повторное одобрение
// оператором (решение владельца). Расчёт бесплатный, сборка — платная. ──

export function getTutorialTempo(id: string, factor: number) {
  return apiGet<TutorialTempoEstimate>(`/admin/tutorial-video-assets/${id}/tempo`, {
    factor: String(factor),
  });
}

export function getTutorialVersions(id: string) {
  return apiGet<TutorialVersionRow[]>(`/admin/tutorial-video-assets/${id}/versions`);
}

export function requestTutorialVersion(id: string, factor: number) {
  return apiPost<{ version: TutorialVersionRow; reused: boolean }>(
    `/admin/tutorial-video-assets/${id}/versions`,
    { factor },
  );
}

export function approveTutorialVersion(id: string, versionId: string) {
  return apiPost<TutorialVersionRow>(
    `/admin/tutorial-video-assets/${id}/versions/${versionId}/approve`,
  );
}

export function revertTutorialTempo(id: string) {
  return apiPost<TutorialVersionRow>(`/admin/tutorial-video-assets/${id}/revert`);
}

// ── Маркетплейс исполнителей — Этап 0 (backend/src/modules/creator-profile, ТЗ §20 №19) ──

export function listCreatorProfiles(
  params: { isFeatured?: boolean; page?: number; pageSize?: number } = {},
) {
  return apiGet<AdminCreatorProfileListResult>('/admin/creator-profiles', {
    isFeatured: params.isFeatured === undefined ? undefined : String(params.isFeatured),
    page: params.page,
    pageSize: params.pageSize,
  });
}

export function setCreatorProfileFeatured(id: string, isFeatured: boolean) {
  return apiPatch<AdminCreatorProfile>(`/admin/creator-profiles/${id}/featured`, { isFeatured });
}

// Портфолио — модерация (аудит-фикс: бэкенд был готов, экрана не было).

export function listPortfolioItems(
  params: { status?: string; page?: number; pageSize?: number } = {},
) {
  return apiGet<AdminPortfolioListResult>('/admin/portfolio-items', {
    status: params.status || undefined,
    page: params.page,
    pageSize: params.pageSize,
  });
}

export function approvePortfolioItem(id: string) {
  return apiPost<AdminPortfolioItem>(`/admin/portfolio-items/${id}/approve`, {});
}

export function rejectPortfolioItem(id: string, reason: string) {
  return apiPost<AdminPortfolioItem>(`/admin/portfolio-items/${id}/reject`, { reason });
}

export function broadcastTopOfWeek() {
  return apiPost<{ sent: boolean; count: number }>('/admin/portfolio-items/broadcast-top-of-week', {});
}

// ── Аукцион готовых видео (ТЗ на маркетплейс §22) — модерация оператором ──

export function listAuctionListings(
  params: { status?: string; page?: number; pageSize?: number } = {},
) {
  return apiGet<AdminAuctionListResult>('/admin/auctions', {
    status: params.status || undefined,
    page: params.page,
    pageSize: params.pageSize,
  });
}

export function approveAuctionListing(id: string) {
  return apiPost<AdminAuctionListing>(`/admin/auctions/${id}/approve`, {});
}

export function rejectAuctionListing(id: string, reason: string) {
  return apiPost<AdminAuctionListing>(`/admin/auctions/${id}/reject`, { reason });
}

/** Запасной ручной путь — основной: покупатель сам платит через self-serve чек-аут, вебхук WayForPay применяет оплату сам (см. auction.service.ts). */
export function confirmAuctionPayment(id: string) {
  return apiPost<AdminAuctionListing>(`/admin/auctions/${id}/confirm-payment`, {});
}

/**
 * Живой аукцион (§7.8, ПРАВКА 1.4) — назначить студию эфира лоту.
 * `videoFragmentId` не передаём из UI намеренно (см. доккомментарий
 * AuctionService.assignVirtualStudio) — бэкенд сам берёт самый свежий
 * готовый VIDEO-фрагмент выбранной студии; отдельный пикер фрагмента
 * можно добавить позже, если понадобится более тонкий контроль.
 * Backend сам отклонит вызов (BadRequestException), если лот не BLITZ
 * или продавец не давал согласия (liveStreamOptIn) — UI это тоже
 * проверяет заранее (см. page.tsx), чтобы не показывать кнопку там, где
 * она гарантированно откажет, но сама валидация — на сервере.
 */
export function assignAuctionVirtualStudio(id: string, virtualStudioId: string) {
  return apiPost<AdminAuctionListing>(`/admin/auctions/${id}/studio`, { virtualStudioId });
}

// ── Виртуальная студия (backend/src/modules/virtual-studio, Этап 1-3
// docs-tz/TZ-Virtualnaya-Studiya-i-AI-Vedushaya.md) — admin-only. ──

export function listVirtualStudios() {
  return apiGet<VirtualStudio[]>('/admin/virtual-studio');
}

export function createVirtualStudio(name: string, refPrompt: string) {
  return apiPost<VirtualStudio>('/admin/virtual-studio', { name, refPrompt });
}

export function deleteVirtualStudio(id: string) {
  return apiDelete<{ ok: true }>(`/admin/virtual-studio/${id}`);
}

export function listVirtualStudioVariants(studioId: string) {
  return apiGet<VirtualStudioVariant[]>(`/admin/virtual-studio/${studioId}/variants`);
}

export function generateVirtualStudioVariant(studioId: string, prompt?: string) {
  return apiPost<VirtualStudioVariant>(`/admin/virtual-studio/${studioId}/variants`, { prompt });
}

export function selectVirtualStudioVariant(studioId: string, variantId: string) {
  return apiPost<VirtualStudio>(`/admin/virtual-studio/${studioId}/variants/${variantId}/select`, {});
}

export function deleteVirtualStudioVariant(studioId: string, variantId: string) {
  return apiDelete<{ ok: true }>(`/admin/virtual-studio/${studioId}/variants/${variantId}`);
}

export function listVirtualStudioFragments(studioId: string) {
  return apiGet<VirtualStudioFragment[]>(`/admin/virtual-studio/${studioId}/fragments`);
}

export function createVirtualStudioVideoFragment(
  studioId: string,
  body: {
    provider: 'grok' | 'hedra';
    prompt: string;
    durationSec?: number;
    aspectRatio?: string;
    resolution?: string;
    voiceFragmentId?: string;
  },
) {
  return apiPost<VirtualStudioFragment>(`/admin/virtual-studio/${studioId}/fragments/video`, body);
}

export function createVirtualStudioVoiceFragment(
  studioId: string,
  body: { provider: 'resemble' | 'elevenlabs'; voiceId: string; text: string; language?: string },
) {
  return apiPost<VirtualStudioFragment>(`/admin/virtual-studio/${studioId}/fragments/voice`, body);
}

export function createVirtualStudioAnalysisFragment(
  studioId: string,
  body: { sourceVideoUrl: string; brandManifestId?: string },
) {
  return apiPost<VirtualStudioFragment>(`/admin/virtual-studio/${studioId}/fragments/analysis`, body);
}

export function getVirtualStudioFragmentStatus(studioId: string, fragmentId: string) {
  return apiGet<VirtualStudioFragment>(`/admin/virtual-studio/${studioId}/fragments/${fragmentId}/status`);
}

export function deleteVirtualStudioFragment(studioId: string, fragmentId: string) {
  return apiDelete<{ ok: true }>(`/admin/virtual-studio/${studioId}/fragments/${fragmentId}`);
}

export function listVirtualStudioVoices(provider: 'resemble' | 'elevenlabs') {
  return apiGet<{ voices: VirtualStudioVoiceOption[]; error?: string }>('/admin/virtual-studio/voices', {
    provider,
  });
}

export function getVirtualStudioHedraEnabled() {
  return apiGet<{ enabled: boolean }>('/admin/virtual-studio/settings/hedra-enabled');
}

export function setVirtualStudioHedraEnabled(enabled: boolean) {
  return apiPost<{ enabled: boolean }>('/admin/virtual-studio/settings/hedra-enabled', { enabled });
}

// ── Советник в мастере («Тонкая красная линия» §10) ────────────────

export function getWizardStats() {
  return apiGet<WizardStatsView>('/admin/wizard-guide/stats');
}

export function getWizardSteps(days = 7) {
  return apiGet<WizardStepFrequency[]>(`/admin/wizard-guide/steps?days=${days}`);
}

export function getWizardExperience(params: {
  status?: string;
  unreviewedLocale?: string;
} = {}) {
  const q = new URLSearchParams();
  if (params.status) q.set('status', params.status);
  if (params.unreviewedLocale)
    q.set('unreviewedLocale', params.unreviewedLocale);
  const suffix = q.toString() ? `?${q}` : '';
  return apiGet<WizardExperienceRow[]>(
    `/admin/wizard-guide/experience${suffix}`,
  );
}

export function saveWizardText(
  id: string,
  locale: string,
  body: WizardTextInput,
) {
  return apiPut<WizardExperienceRow>(
    `/admin/wizard-guide/experience/${id}/texts/${locale}`,
    body,
  );
}

export function markWizardTextReviewed(id: string, locale: string) {
  return apiPost<WizardExperienceRow>(
    `/admin/wizard-guide/experience/${id}/texts/${locale}/reviewed`,
    {},
  );
}

export function publishWizardExperience(id: string) {
  return apiPost<WizardExperienceRow>(
    `/admin/wizard-guide/experience/${id}/publish`,
    {},
  );
}

export function setWizardExperienceStatus(id: string, status: string) {
  return apiPatch<WizardExperienceRow>(`/admin/wizard-guide/experience/${id}`, {
    status,
  });
}

export function getWizardCandidates(params: {
  status?: string;
  decision?: string;
} = {}) {
  const q = new URLSearchParams();
  if (params.status) q.set('status', params.status);
  if (params.decision) q.set('decision', params.decision);
  const suffix = q.toString() ? `?${q}` : '';
  return apiGet<WizardCandidateRow[]>(
    `/admin/wizard-guide/candidates${suffix}`,
  );
}

export function promoteWizardCandidate(id: string, body: WizardTextInput) {
  return apiPost<WizardExperienceRow>(
    `/admin/wizard-guide/candidates/${id}/promote`,
    body,
  );
}

export function mergeWizardCandidate(id: string, experienceId: string) {
  return apiPost<{ ok: true }>(`/admin/wizard-guide/candidates/${id}/merge`, {
    experienceId,
  });
}

/** «Это другое» — вернуть кандидата в очередь и откатить счётчик. */
export function unmergeWizardCandidate(id: string) {
  return apiPost<{ ok: true }>(`/admin/wizard-guide/candidates/${id}/unmerge`, {});
}

export function attachWizardCandidate(
  id: string,
  experienceId: string,
  body: WizardTextInput,
) {
  return apiPost<WizardExperienceRow>(
    `/admin/wizard-guide/candidates/${id}/attach`,
    { ...body, experienceId },
  );
}

export function rejectWizardCandidate(id: string) {
  return apiPost<{ ok: true }>(`/admin/wizard-guide/candidates/${id}/reject`, {});
}

export function getWizardSiblings() {
  return apiGet<WizardSiblingStats>('/admin/wizard-guide/siblings');
}

export function setWizardSiblings(body: { auto?: number; suggest?: number }) {
  return apiPatch<{ auto: number; suggest: number }>(
    '/admin/wizard-guide/siblings',
    body,
  );
}

export function getWizardHints(params: {
  source?: string;
  locale?: string;
  flagged?: boolean;
} = {}) {
  const q = new URLSearchParams();
  if (params.source) q.set('source', params.source);
  if (params.locale) q.set('locale', params.locale);
  if (params.flagged !== undefined) q.set('flagged', String(params.flagged));
  const suffix = q.toString() ? `?${q}` : '';
  return apiGet<WizardHintRow[]>(`/admin/wizard-guide/hints${suffix}`);
}

// ── Приглашения («Условно бесплатный Lite» §11, этап 135) ──

export function getReferralsOverview(window: ReferralsWindow) {
  return apiGet<AdminReferralsOverview>('/admin/referrals', { window });
}

/** Снять засчитанное приглашение. Причина обязательна — её проверяет и сервер. */
export function revokeReferral(id: string, reason: string) {
  return apiPost<{ revoked: boolean }>(`/admin/referrals/${id}/revoke`, {
    reason,
  });
}

/** Отнять разблокировку Lite. Автоматика её не отнимает никогда — только оператор. */
export function revokeUserLite(userId: string, reason: string) {
  return apiPost<AdminUserDetail>(`/admin/users/${userId}/lite-revoke`, {
    reason,
  });
}

/** Вернуть разблокировку после отзыва: новая дата поверх, история остаётся. */
export function unlockUserLite(userId: string) {
  return apiPost<AdminUserDetail>(`/admin/users/${userId}/lite-unlock`);
}

// ── Работа с тестировщиком (этапы 155–158) ─────────────────────────────

export function getTesterInvites() {
  return apiGet<TesterInvite[]>('/admin/tester-invites');
}

export function createTesterInvite(body: {
  label: string;
  freeScenarios: string[];
  freeOutsideProject?: boolean;
  brief?: string | null;
  dailyLimitUsd?: number | null;
  expiresAt?: string | null;
}) {
  return apiPost<TesterInvite>('/admin/tester-invites', body);
}

export function revokeTesterInvite(id: string, reason: string) {
  return apiPost<TesterInvite>(`/admin/tester-invites/${id}/revoke`, {
    reason,
  });
}

/** `status: 'OPEN'` — не статус, а «что ждёт нас»: рабочий вид вкладки. */
export function getTestTickets(
  params: { status?: string; userId?: string; envKey?: string } = {}
) {
  return apiGet<TestTicketRow[]>('/admin/test-tickets', params);
}

export function getTesterProgress() {
  return apiGet<TesterProgress[]>('/admin/test-tickets/progress');
}

export function getTestTicket(id: string) {
  return apiGet<TestTicketDetail>(`/admin/test-tickets/${id}`);
}

export function setTestTicketStatus(
  id: string,
  status: TicketStatus,
  note?: string
) {
  return apiPatch<TestTicketDetail>(`/admin/test-tickets/${id}/status`, {
    status,
    note,
  });
}

export function replyToTestTicket(id: string, text: string) {
  return apiPost<TestTicketDetail>(`/admin/test-tickets/${id}/reply`, { text });
}
