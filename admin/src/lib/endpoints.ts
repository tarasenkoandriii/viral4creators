import { apiGet, apiPost, apiPatch, apiDelete } from './admin-api';
import type {
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
  TelemetryResult,
  EnvSettingsResult,
  VoiceoverProviderKey,
  VoiceoverProviderSettingsView,
  PublicationListResult,
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

export function listSessions(params: { status?: string; page?: number; pageSize?: number } = {}) {
  return apiGet<SessionListResult>('/admin/sessions', params);
}

export function getSession(id: string) {
  return apiGet<SessionDetail>(`/admin/sessions/${id}`);
}

export function deleteSession(id: string) {
  return apiDelete<{ ok: true }>(`/admin/sessions/${id}`);
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
