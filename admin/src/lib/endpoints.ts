import { apiGet, apiPost, apiPatch, apiDelete } from './admin-api';
import type {
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
  VoiceoverProviderKey,
  VoiceoverProviderSettingsView,
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
  AvatarVideo,
  SoundCheckState,
  WorkflowWindow,
  WorkflowFunnelResult,
  WorkflowCohortConversionResult,
  VirtualStudio,
  VirtualStudioVariant,
  VirtualStudioFragment,
  VirtualStudioVoiceOption,
} from './types';

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

export function setVoiceoverProviderDefault(provider: VoiceoverProviderKey) {
  return apiPatch<VoiceoverProviderSettingsView>('/admin/settings/voiceover-provider', {
    provider,
  });
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

export function patchUser(
  id: string,
  patch: {
    plan?: PlanId;
    isOperator?: boolean;
    isBlocked?: boolean;
    blockedReason?: string;
  }
) {
  return apiPatch<AdminUserDetail>(`/admin/users/${id}`, patch);
}

// ── Расходы (ТЗ §26) ───────────────────────────────────────────────────

export function getCosts(params: { top?: number } = {}) {
  return apiGet<CostReport>('/admin/costs', params);
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
 * сама берёт последний на каждый jobKey (см. lastRunFor() в page.tsx). */
export function getCronHistory(jobKey?: string) {
  return apiGet<CronRunLog[]>('/admin/cron/history', jobKey ? { jobKey } : undefined);
}

export function runCronJob(jobKey: string, debug: boolean) {
  return apiPost<CronRunLog>(`/admin/cron/${jobKey}/run?debug=${debug}`);
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
 * Удаляет сгенерированный сценарий (этап 106) — нужно для сломанных/
 * никогда не проходящих сценариев: `tutorial-scenario-generate` только
 * добавляет строки (`create`, не `upsert`), а `tutorial-scenario-run`
 * берёт их все по `createdAt asc` без пропуска уже провалившихся —
 * без удаления сломанный сценарий будет падать и слать алерт на
 * каждом прогоне крона бесконечно.
 */
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
