/**
 * Project / ProductItem / photo / voice / reference API — frontend side of
 * doc/PRODUCT-PROJECT-SPEC.md §4 (Экраны 1–5), Stage 8 of the plan.
 * Thin functions over the shared ApiClient (services/api.ts) so the same
 * auth interceptor (Telegram initData / dev header / login cookie) applies.
 *
 * Every /projects call requires an identity (backend TelegramIdentityGuard,
 * 401 otherwise) — `isUnauthorized()` lets screens show the "log in first"
 * state instead of a generic error.
 */

import axios from 'axios';
import { api } from './api';
import { readStoredLocale, defaultLocale } from '../lib/i18n';
import type { Dictionary } from '../lib/get-dictionary';
import type {
  AnalysisSelectionView,
  AudienceProfile,
  AuditState,
  BrandManifestSnapshot,
  CameraMove,
  CharacterCast,
  CharacterCasting,
  GenerationPrompt,
  LibraryRecommendation,
  PlanId,
  PlanState,
  PublicationPlatform,
  PublicationRequest,
  PublishingChannel,
  ReferenceSlots,
  RelevanceState,
  SceneAsset,
  Session,
  SharedVideoPage,
  SoundCheckState,
  SubtitlesMode,
  SubtitleTheme,
  TermsStatus,
  UserVoice,
  VideoAnalysis,
  VoiceMode,
  YoutubeSearchResponse,
} from '../types';
import type {
  BrandCharacterView,
  BrandSceneView,
  BrandManifestSummaryView,
  BrandManifestView,
  CountryOption,
  CreateGreetingBriefInput,
  ItemDeletePreview,
  JsonObject,
  ProcessPhotoResult,
  ProductItemView,
  ProductPriceSource,
  ProjectDeletePreview,
  ProjectSummaryView,
  ProjectType,
  ProjectView,
  TranscribeResult,
} from '../types/project';

// ── Error helpers ──────────────────────────────────────────────────────

export function isUnauthorized(err: unknown): boolean {
  return axios.isAxiosError(err) && err.response?.status === 401;
}

/**
 * Найдено доп. аудитом (LOW) — раньше 404 от `getItemDeletePreview`/
 * `getProjectDeletePreview` (уже удалено, например с другого устройства
 * или другой вкладкой) и обычный сбой сети читались одинаково: пустой
 * `preview` и общий текст «не удалось посчитать точно» (см.
 * ProjectScreen.tsx's onDeleteItem/onDeleteProject). 404 здесь —
 * не «не смогли посчитать», а «нечего удалять».
 */
export function isNotFoundError(err: unknown): boolean {
  return axios.isAxiosError(err) && err.response?.status === 404;
}

/**
 * Human-readable message from the backend envelope, falling back to the
 * axios message.
 *
 * Г-5.1 (аудит round4, этап 64): раньше и встроенные тексты для 429/403/
 * 404/409/«нет сети», и дефолтный `fallback`, были русскими литералами
 * без исключения — немецкий пользователь читал «Нет связи с сервером» в
 * немецком интерфейсе. Третий необязательный параметр — `dict.errors` —
 * даёт переводы для встроенных случаев; когда он не передан (старые
 * вызовы, которых по всему фронтенду ещё много), поведение НЕ меняется —
 * прежние русские тексты остаются дефолтом, это не регресс, а
 * постепенная миграция вызовов на перевод.
 */
export function errorMessage(
  err: unknown,
  fallback?: string,
  dict?: Dictionary['errors']
): string {
  const t = {
    tooManyRequests:
      dict?.tooManyRequests ?? 'Слишком много запросов — попробуйте чуть позже',
    forbidden: dict?.forbidden ?? 'Доступ закрыт',
    notFound: dict?.notFound ?? 'Не найдено',
    conflict:
      dict?.conflict ?? 'Операция уже выполняется — дождитесь её окончания',
    network: dict?.network ?? 'Нет связи с сервером — проверьте сеть',
    generic: fallback ?? dict?.generic ?? 'Что-то пошло не так',
  };
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as
      | { error?: { message?: string | string[] } }
      | undefined;
    const m = data?.error?.message;
    if (Array.isArray(m)) return m.join('; ');
    if (typeof m === 'string' && m) return m;
    // Сервер объясняет отказ сам (конверт `error.message`); сюда
    // попадаем, только если объяснения нет. Текст axios вида «Request
    // failed with status code 403» пользователю не показываем — это
    // технический шум, а не причина (этап 48, В-5.2).
    if (err.response?.status === 429) return t.tooManyRequests;
    if (err.response?.status === 403) return t.forbidden;
    if (err.response?.status === 404) return t.notFound;
    if (err.response?.status === 409) return t.conflict;
    if (!err.response) return t.network;
    return t.generic;
  }
  return err instanceof Error ? err.message : t.generic;
}

/**
 * Машинный код отказа — для телеметрии шагов («Тонкая красная линия»
 * §8), не для человека.
 *
 * Рядом с `errorMessage`, а не вместо него, и это главное: в таблицу
 * частот уезжает КОД, потому что текст отказа сервер сочиняет по-русски
 * (или отдаёт сообщение с пользовательскими данными внутри), а
 * группировать надо одинаковые отказы. `http-500` и «Что-то пошло не
 * так» — это одна причина и пять разных строк.
 */
export function errorCode(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    if (!status) return 'network';
    return `http-${status}`;
  }
  return 'client';
}

function unwrap<T>(res: { data?: T }, what: string): T {
  if (res.data === undefined) throw new Error(`Пустой ответ: ${what}`);
  return res.data;
}

// ── Reference ──────────────────────────────────────────────────────────

let countriesCache: CountryOption[] | null = null;

export async function getCountries(): Promise<CountryOption[]> {
  if (countriesCache) return countriesCache;
  const res = await api.get<CountryOption[]>('/reference/countries');
  countriesCache = unwrap(res, 'countries');
  return countriesCache;
}

// ── Projects ───────────────────────────────────────────────────────────

export async function listProjects(): Promise<ProjectSummaryView[]> {
  return unwrap(await api.get<ProjectSummaryView[]>('/projects'), 'projects');
}

export async function getProject(projectId: string): Promise<ProjectView> {
  return unwrap(
    await api.get<ProjectView>(`/projects/${projectId}`),
    'project'
  );
}

export async function createProject(input: {
  type: ProjectType;
  title: string;
  /** Необязателен только для `CLIENT_SITE` (§4.1): у проекта «сайт
   * заказчика» нет ни товара, ни цены, и страна там ничего не считает —
   * сервер подставляет её сам, чтобы не ставить лишний шаг на входе.
   * Для GREETING_VIDEO страна ОБЯЗАТЕЛЬНА (как у SINGLE/LINE) — сервер
   * (`resolveCountryCode`) отклонит запрос без неё. */
  countryCode?: string;
  brandManifestId?: string;
  /** Обязателен, когда `type === 'GREETING_VIDEO'` (ТЗ
   * TZ-Greeting-Video-Project-Type.md §4.1/§8); игнорируется остальными
   * тремя типами. */
  greetingBrief?: CreateGreetingBriefInput;
}): Promise<ProjectView> {
  return unwrap(await api.post<ProjectView>('/projects', input), 'project');
}

export async function updateProject(
  projectId: string,
  input: {
    title?: string;
    type?: ProjectType;
    countryCode?: string;
    brandManifestId?: string | null;
  }
): Promise<ProjectView> {
  return unwrap(
    await api.patch<ProjectView>(`/projects/${projectId}`, input),
    'project'
  );
}

export async function deleteProject(projectId: string): Promise<void> {
  await api.delete(`/projects/${projectId}`);
}

/**
 * «Умный» алерт удаления (этап 89): точные счётчики того, что каскадом
 * уйдёт из БД вместе с проектом — до самого `deleteProject`, чтобы
 * диалог подтверждения мог показать их пользователю, а не общую фразу.
 */
export async function getProjectDeletePreview(
  projectId: string
): Promise<ProjectDeletePreview> {
  return unwrap(
    await api.get<ProjectDeletePreview>(
      `/projects/${projectId}/delete-preview`
    ),
    'delete-preview'
  );
}

// ── Items ──────────────────────────────────────────────────────────────

export type AudienceInput = Omit<Partial<AudienceProfile>, 'source'>;

export interface ItemInput {
  title?: string | null;
  description?: string | null;
  price?: number | null;
  priceSource?: ProductPriceSource;
  /** Spec §18: user's correction of the target audience; null clears it. */
  audience?: AudienceInput | null;
}

export async function addItem(
  projectId: string,
  input: ItemInput = {}
): Promise<ProductItemView> {
  return unwrap(
    await api.post<ProductItemView>(`/projects/${projectId}/items`, input),
    'item'
  );
}

export async function updateItem(
  projectId: string,
  itemId: string,
  input: ItemInput
): Promise<ProductItemView> {
  return unwrap(
    await api.patch<ProductItemView>(
      `/projects/${projectId}/items/${itemId}`,
      input
    ),
    'item'
  );
}

export async function deleteItem(
  projectId: string,
  itemId: string
): Promise<void> {
  await api.delete(`/projects/${projectId}/items/${itemId}`);
}

/** То же самое (см. `getProjectDeletePreview`), только для одного товара. */
export async function getItemDeletePreview(
  projectId: string,
  itemId: string
): Promise<ItemDeletePreview> {
  return unwrap(
    await api.get<ItemDeletePreview>(
      `/projects/${projectId}/items/${itemId}/delete-preview`
    ),
    'delete-preview'
  );
}

// ── Photo → analogs (two-step presigned Blob flow, spec §6.1) ───────────

interface PresignedUpload {
  uploadUrl: string;
  pathname: string;
}

async function putToBlob(
  target: PresignedUpload,
  file: Blob,
  contentType: string,
  onProgress?: (p: number) => void
) {
  await axios.put(target.uploadUrl, file, {
    headers: { 'Content-Type': contentType },
    onUploadProgress: (e) => {
      if (onProgress && e.total)
        onProgress(Math.round((e.loaded / e.total) * 100));
    },
  });
}

/**
 * Upload the product photo and run analog search + category detection.
 * `onProgress` covers the PUT only; the processing step is a single await.
 */
export async function uploadAndProcessPhoto(
  projectId: string,
  itemId: string,
  file: File,
  onProgress?: (p: number) => void
): Promise<ProcessPhotoResult> {
  const base = `/projects/${projectId}/items/${itemId}/photo`;
  const target = unwrap(
    await api.post<PresignedUpload>(`${base}/upload-url`, {
      fileName: file.name || 'photo.jpg',
      fileSize: file.size,
      mimeType: file.type,
    }),
    'upload-url'
  );
  await putToBlob(target, file, file.type, onProgress);
  return unwrap(
    await api.post<ProcessPhotoResult>(`${base}/process`, {
      pathname: target.pathname,
      // §35.5 (этап 59): распознавание товара — не кэшируется, поэтому
      // генерируется сразу на UI-локали пользователя.
      locale: readStoredLocale() ?? defaultLocale,
    }),
    'process'
  );
}

// ── Voice → text (spec §6.2) ───────────────────────────────────────────

export async function uploadAndTranscribeVoice(
  projectId: string,
  itemId: string,
  audio: Blob,
  mimeType: string,
  apply: boolean
): Promise<TranscribeResult> {
  const base = `/projects/${projectId}/items/${itemId}/voice`;
  const target = unwrap(
    await api.post<PresignedUpload>(`${base}/upload-url`, {
      fileName: 'voice',
      fileSize: audio.size,
      mimeType,
    }),
    'upload-url'
  );
  await putToBlob(target, audio, mimeType);
  return unwrap(
    await api.post<TranscribeResult>(`${base}/transcribe`, {
      pathname: target.pathname,
      apply,
    }),
    'transcribe'
  );
}

// ── Brand manifests (only what Экран 1 needs — the section itself is Stage 9) ──

export async function listBrandManifests(): Promise<
  BrandManifestSummaryView[]
> {
  return unwrap(
    await api.get<BrandManifestSummaryView[]>('/brand-manifests'),
    'brand-manifests'
  );
}

// ── Brand manifests — full CRUD (Stage 9, spec §12) ────────────────────

export interface ManifestInput {
  title?: string;
  styleNotes?: string | null;
  voiceNotes?: string | null;
  /** Озвучка (§15.1, этап 35). */
  voiceMode?: VoiceMode;
  ttsVoiceId?: string | null;
  ttsModel?: string | null;
  /** Движение камеры (§29, этап 46). */
  cameraMove?: CameraMove;
  /** Жёстко вшитые субтитры (TODO §Уровень 2.7, этап 67). */
  subtitlesMode?: SubtitlesMode;
  subtitleTheme?: SubtitleTheme;
  filters?: JsonObject | null;
  effects?: JsonObject | null;
}

export async function getBrandManifest(id: string): Promise<BrandManifestView> {
  return unwrap(
    await api.get<BrandManifestView>(`/brand-manifests/${id}`),
    'brand-manifest'
  );
}

export async function createBrandManifest(
  input: ManifestInput & { title: string }
): Promise<BrandManifestView> {
  return unwrap(
    await api.post<BrandManifestView>('/brand-manifests', input),
    'brand-manifest'
  );
}

export async function updateBrandManifest(
  id: string,
  input: ManifestInput
): Promise<BrandManifestView> {
  return unwrap(
    await api.patch<BrandManifestView>(`/brand-manifests/${id}`, input),
    'brand-manifest'
  );
}

export async function deleteBrandManifest(id: string): Promise<void> {
  await api.delete(`/brand-manifests/${id}`);
}

export interface CharacterInput {
  label?: string;
  description?: string | null;
}

/**
 * Characters and (Stage 22, spec §17.1) brand scenes share one REST shape:
 * `/brand-manifests/:id/<characters|scenes>/...`. The scene functions below
 * are thin aliases over the same helpers with the other segment.
 */
export type BrandAssetKind = 'characters' | 'scenes';

async function addBrandAsset(
  kind: BrandAssetKind,
  manifestId: string,
  input: CharacterInput & { label: string }
): Promise<BrandCharacterView> {
  return unwrap(
    await api.post<BrandCharacterView>(
      `/brand-manifests/${manifestId}/${kind}`,
      input
    ),
    kind
  );
}

async function updateBrandAsset(
  kind: BrandAssetKind,
  manifestId: string,
  assetId: string,
  input: CharacterInput
): Promise<BrandCharacterView> {
  return unwrap(
    await api.patch<BrandCharacterView>(
      `/brand-manifests/${manifestId}/${kind}/${assetId}`,
      input
    ),
    kind
  );
}

async function deleteBrandAsset(
  kind: BrandAssetKind,
  manifestId: string,
  assetId: string
): Promise<void> {
  await api.delete(`/brand-manifests/${manifestId}/${kind}/${assetId}`);
}

/** PNG/JPEG only — the photo becomes a Veo referenceImage (spec §10.2 / §17). */
async function uploadBrandAssetPhoto(
  kind: BrandAssetKind,
  manifestId: string,
  assetId: string,
  file: File,
  onProgress?: (p: number) => void
): Promise<BrandCharacterView> {
  const base = `/brand-manifests/${manifestId}/${kind}/${assetId}/photo`;
  const target = unwrap(
    await api.post<PresignedUpload>(`${base}/upload-url`, {
      fileName: file.name || 'photo.jpg',
      fileSize: file.size,
      mimeType: file.type,
    }),
    'upload-url'
  );
  await putToBlob(target, file, file.type, onProgress);
  return unwrap(
    await api.post<BrandCharacterView>(`${base}/confirm`, {
      pathname: target.pathname,
    }),
    'confirm'
  );
}

export const addBrandCharacter = (
  manifestId: string,
  input: CharacterInput & { label: string }
) => addBrandAsset('characters', manifestId, input);

/**
 * Доп. запрос владельца продукта: сохранить замену персонажа,
 * сделанную на экране сессии (`kind: 'photo' | 'text'` в
 * `CharacterCasting.tsx`), постоянным персонажем бренда —
 * `photoPathname` копируется на бекенде в постоянный путь (не
 * переиспользуется напрямую — сессионное фото удаляется вместе с
 * сессией).
 */
export async function addCharacterFromSessionCast(
  manifestId: string,
  input: {
    label: string;
    description?: string | null;
    photoPathname?: string | null;
  }
): Promise<BrandCharacterView> {
  return unwrap(
    await api.post<BrandCharacterView>(
      `/brand-manifests/${manifestId}/characters/from-session-cast`,
      input
    ),
    'characters'
  );
}

/**
 * Доп. запрос владельца продукта: статичное превью персонажа из
 * текстового описания (двойной клик по описанию в
 * `CharacterCasting.tsx`). `url`/`pathname`: `null` — Gemini не смог
 * (best-effort на бекенде, не исключение) — не значит «повторить точно
 * так же», просто не получилось в этот раз. `pathname` нужен для
 * `usePreviewAsPhoto()` ниже, если пользователь решит продвинуть
 * превью до настоящего фото.
 */
/** Ответ превью: картинка (или `null`) и остаток квоты (§6.8
 * doc/AI-SKETCH-SPEC.md). Лимит исчерпан — сервер отвечает 429 с текстом. */
export interface CharacterPreviewResponse {
  url: string | null;
  pathname: string | null;
  dayUsed: number;
  dayLimit: number;
  monthUsed: number;
  monthLimit: number;
}

export async function generateCharacterPreview(
  sessionId: string,
  characterId: string,
  description: string
): Promise<CharacterPreviewResponse> {
  return unwrap(
    await api.post<CharacterPreviewResponse>(
      `/sessions/${sessionId}/characters/${characterId}/preview`,
      { description }
    ),
    'preview'
  );
}

/**
 * Доп. запрос владельца продукта: «использовать как фото» — продвигает
 * уже сгенерированное превью (`pathname` из `generateCharacterPreview`)
 * до статуса настоящего фото персонажа — дальше оно ведёт себя как
 * обычная загруженная фотография (референс для Veo/Grok, §10.2/§15
 * ТЗ), не только превью для самого пользователя.
 *
 * Названа без префикса `use` намеренно — с ним ESLint-правило
 * `react-hooks/rules-of-hooks` принимает обычную асинхронную функцию
 * за React-хук по одному соглашению об именах и требует вызывать её
 * по хуковым правилам, которых у неё нет.
 */
export async function promotePreviewToPhoto(
  sessionId: string,
  characterId: string,
  previewPathname: string,
  description?: string | null
): Promise<CharacterCasting> {
  return unwrap(
    await api.post<CharacterCasting>(
      `/sessions/${sessionId}/characters/${characterId}/preview/use-as-photo`,
      { previewPathname, description }
    ),
    'casting'
  );
}

export const updateBrandCharacter = (
  manifestId: string,
  characterId: string,
  input: CharacterInput
) => updateBrandAsset('characters', manifestId, characterId, input);
export const deleteBrandCharacter = (manifestId: string, characterId: string) =>
  deleteBrandAsset('characters', manifestId, characterId);
export const uploadBrandCharacterPhoto = (
  manifestId: string,
  characterId: string,
  file: File,
  onProgress?: (p: number) => void
) =>
  uploadBrandAssetPhoto(
    'characters',
    manifestId,
    characterId,
    file,
    onProgress
  );

export const addBrandScene = (
  manifestId: string,
  input: CharacterInput & { label: string }
): Promise<BrandSceneView> => addBrandAsset('scenes', manifestId, input);
export const updateBrandScene = (
  manifestId: string,
  sceneId: string,
  input: CharacterInput
): Promise<BrandSceneView> =>
  updateBrandAsset('scenes', manifestId, sceneId, input);
export const deleteBrandScene = (manifestId: string, sceneId: string) =>
  deleteBrandAsset('scenes', manifestId, sceneId);
export const uploadBrandScenePhoto = (
  manifestId: string,
  sceneId: string,
  file: File,
  onProgress?: (p: number) => void
): Promise<BrandSceneView> =>
  uploadBrandAssetPhoto('scenes', manifestId, sceneId, file, onProgress);

// ── Project → Session (Stage 10, spec §7.8 snapshot) ───────────────────

export interface ItemSessionSummary {
  sessionId: string;
  status: string;
  createdAt: string;
  lastActivityAt: string;
  videoUrl: string | null;
  hasBrandManifest: boolean;
}

/**
 * Start a generation Session from a product item. The backend copies the
 * item (and the project's Brand Manifest, if any) into the session; the
 * wizard then finds product info already filled in.
 */
export async function createSessionFromItem(
  projectId: string,
  itemId: string
): Promise<Session> {
  const res = unwrap(
    await api.post<{ sessionId: string; session: Session }>(
      `/projects/${projectId}/items/${itemId}/sessions`,
      // §35.5 (этап 59): та же локаль, что и у анонимной createSession.
      { locale: readStoredLocale() ?? defaultLocale }
    ),
    'session'
  );
  return res.session;
}

export async function listItemSessions(
  projectId: string,
  itemId: string
): Promise<ItemSessionSummary[]> {
  return unwrap(
    await api.get<ItemSessionSummary[]>(
      `/projects/${projectId}/items/${itemId}/sessions`
    ),
    'sessions'
  );
}

// ── YouTube reference-video search (Stage 11/12, spec §6.4 / §9) ────────

/**
 * One search.list call = 100 quota units on the shared Google project and
 * one of the user's daily searches — so the UI calls this on an explicit
 * action (button / Enter), never on every keystroke.
 */
export async function searchYoutube(
  q: string,
  opts: { regionCode?: string | null; language?: string | null } = {}
): Promise<YoutubeSearchResponse> {
  const params = new URLSearchParams({ q });
  if (opts.regionCode) params.set('regionCode', opts.regionCode);
  if (opts.language) params.set('language', opts.language);
  return unwrap(
    await api.get<YoutubeSearchResponse>(
      `/youtube-search?${params.toString()}`
    ),
    'youtube-search'
  );
}

// ── Character casting + per-session manifest copy (Stage 14, spec §10/§12) ──

export async function getCasting(sessionId: string): Promise<CharacterCasting> {
  return unwrap(
    await api.get<CharacterCasting>(`/sessions/${sessionId}/characters`),
    'casting'
  );
}

/** Client-side shape of one cast for PUT — only what the server accepts. */
export interface CastInput {
  characterId: string;
  active: boolean;
  order: number;
  replacement: {
    kind: CharacterCast['replacement']['kind'];
    description?: string | null;
    photoUrl?: string | null;
    brandCharacterId?: string | null;
    label?: string | null;
  };
}

export async function putCasting(
  sessionId: string,
  casts: CastInput[]
): Promise<CharacterCasting> {
  return unwrap(
    await api.putJson<CharacterCasting>(`/sessions/${sessionId}/characters`, {
      casts,
    }),
    'casting'
  );
}

/** "Новый скин" — PNG/JPEG only (Veo referenceImage input formats). */
export async function uploadCastPhoto(
  sessionId: string,
  characterId: string,
  file: File,
  description: string | null,
  onProgress?: (p: number) => void
): Promise<CharacterCasting> {
  const base = `/sessions/${sessionId}/characters/${characterId}/photo`;
  const target = unwrap(
    await api.post<PresignedUpload>(`${base}/upload-url`, {
      fileName: file.name || 'photo.jpg',
      fileSize: file.size,
      mimeType: file.type,
    }),
    'upload-url'
  );
  await putToBlob(target, file, file.type, onProgress);
  return unwrap(
    await api.post<CharacterCasting>(`${base}/confirm`, {
      pathname: target.pathname,
      ...(description ? { description } : {}),
    }),
    'confirm'
  );
}

export interface BrandSnapshotInput {
  styleNotes?: string | null;
  voiceNotes?: string | null;
  /** Озвучка (§15.1, этап 35). */
  voiceMode?: VoiceMode;
  ttsVoiceId?: string | null;
  /**
   * Явный выбор провайдера синтеза ДЛЯ ЭТОЙ СЕССИИ, в обход
   * платформенного дефолта (этап 91, `RevoicePanel`) — см. доккомментарий
   * `UpdateBrandSnapshotRequestDto.ttsProvider` на бэкенде. `'veo'` не
   * входит намеренно: это не провайдер синтеза, а «не озвучивать вовсе».
   */
  ttsProvider?: 'elevenlabs' | 'resemble';
  ttsModel?: string | null;
  /** Движение камеры (§29, этап 46). */
  cameraMove?: CameraMove;
  /** Жёстко вшитые субтитры (TODO §Уровень 2.7, этап 67). */
  subtitlesMode?: SubtitlesMode;
  subtitleTheme?: SubtitleTheme;
  filters?: Record<string, unknown> | null;
  effects?: Record<string, unknown> | null;
}

/** Edits THIS session's manifest copy — the manifest itself is untouched (§12). */
export async function updateBrandSnapshot(
  sessionId: string,
  input: BrandSnapshotInput
): Promise<BrandManifestSnapshot> {
  return unwrap(
    await api.patch<BrandManifestSnapshot>(
      `/sessions/${sessionId}/brand-manifest`,
      input
    ),
    'brand-snapshot'
  );
}

// ── Post-generation audit (Stage 16/17, spec §11) ──────────────────────

export async function getAudit(sessionId: string): Promise<AuditState> {
  return unwrap(
    await api.get<AuditState>(`/sessions/${sessionId}/audit`),
    'audit'
  );
}

/** No `issue` → Gemini watches the video; with `issue` → the user is the detector (§11.3). */
export async function runAudit(
  sessionId: string,
  issue?: string
): Promise<AuditState> {
  return unwrap(
    await api.post<AuditState>(
      `/sessions/${sessionId}/audit`,
      issue ? { issue } : {},
      { timeout: 280000 }
    ),
    'audit'
  );
}

/** Fix → prompt draft (approval reset); returns the prompt and the iteration counter. */
export async function applyAuditFix(
  sessionId: string,
  auditId: string,
  text?: string
): Promise<{ prompt: GenerationPrompt; state: AuditState }> {
  return unwrap(
    await api.post<{ prompt: GenerationPrompt; state: AuditState }>(
      `/sessions/${sessionId}/audit/apply`,
      { auditId, ...(text ? { text } : {}) }
    ),
    'audit-apply'
  );
}

// ── Voice sound check (этап 73) — отдельно от артефакт-аудита выше:
// «звучит ли голос по-человечески», а не «сломано ли что-то» ───────────

export async function getSoundCheck(
  sessionId: string
): Promise<SoundCheckState> {
  return unwrap(
    await api.get<SoundCheckState>(`/sessions/${sessionId}/sound-check`),
    'sound-check'
  );
}

export async function runSoundCheck(
  sessionId: string
): Promise<SoundCheckState> {
  return unwrap(
    await api.post<SoundCheckState>(
      `/sessions/${sessionId}/sound-check`,
      {},
      { timeout: 280000 }
    ),
    'sound-check'
  );
}

// ── Publication queue (Stage 18, spec §8/§11) — needs identity ──────────

export interface PublicationInput {
  platform: PublicationPlatform;
  title?: string;
  description?: string;
  tags?: string[];
}

/** Puts the finished video in the moderation queue — never publishes directly. */
export async function requestPublication(
  sessionId: string,
  input: PublicationInput
): Promise<PublicationRequest> {
  return unwrap(
    await api.post<PublicationRequest>(
      `/sessions/${sessionId}/publications`,
      input
    ),
    'publication'
  );
}

export async function listPublications(
  sessionId: string
): Promise<PublicationRequest[]> {
  return unwrap(
    await api.get<PublicationRequest[]>(`/sessions/${sessionId}/publications`),
    'publications'
  );
}

export async function withdrawPublication(
  sessionId: string,
  requestId: string
): Promise<void> {
  await api.delete(`/sessions/${sessionId}/publications/${requestId}`);
}

// ── Каналы выгрузки (ТЗ §14.2/14.4, этап 61) — needs identity ───────────
// OAuth start — обычный POST (identity едет заголовками, не cookie), а не
// голая ссылка: возвращает URL, на который фронтенд сам делает редирект.

export async function listChannels(): Promise<PublishingChannel[]> {
  return unwrap(await api.get<PublishingChannel[]>('/channels'), 'channels');
}

export async function startChannelOAuth(
  platform: PublicationPlatform
): Promise<string> {
  const { url } = unwrap(
    await api.post<{ url: string }>(`/channels/oauth/${platform}/start`),
    'oauth url'
  );
  return url;
}

export async function disconnectChannel(id: string): Promise<void> {
  await api.delete(`/channels/${id}`);
}

// ── Публичная страница ролика (ТЗ §40, этап 60) — needs identity ───────
// (владельческая сторона; форк с чужой ссылки — `forkSharedVideo` в
// services/api.ts, публичный маршрут, идентификации не требует)

/** Ставит готовый ролик на модерацию — как и публикация, никогда не публикует сразу. */
export async function createSharedVideo(
  sessionId: string,
  title?: string
): Promise<SharedVideoPage> {
  return unwrap(
    await api.post<SharedVideoPage>(`/sessions/${sessionId}/shared-video`, {
      ...(title ? { title } : {}),
    }),
    'shared-video'
  );
}

export async function listSharedVideos(
  sessionId: string
): Promise<SharedVideoPage[]> {
  return unwrap(
    await api.get<SharedVideoPage[]>(`/sessions/${sessionId}/shared-video`),
    'shared-videos'
  );
}

/** Отзыв — в ЛЮБОМ статусе (не только PENDING, в отличие от публикации). */
export async function withdrawSharedVideo(
  sessionId: string,
  pageId: string
): Promise<void> {
  await api.delete(`/sessions/${sessionId}/shared-video/${pageId}`);
}

// ── Scenes + reference slots (spec §17) ────────────────────────────────

export async function listScenes(sessionId: string): Promise<SceneAsset[]> {
  return unwrap(
    await api.get<SceneAsset[]>(`/sessions/${sessionId}/scenes`),
    'scenes'
  );
}

/** PNG/JPEG ≤10 MB → presigned PUT → confirm with label/description. */
export async function uploadScene(
  sessionId: string,
  file: File,
  label: string,
  description: string | null,
  onProgress?: (p: number) => void
): Promise<SceneAsset[]> {
  const target = unwrap(
    await api.post<PresignedUpload & { sceneId: string }>(
      `/sessions/${sessionId}/scenes/upload-url`,
      {
        fileName: file.name || 'scene.jpg',
        fileSize: file.size,
        mimeType: file.type,
      }
    ),
    'upload-url'
  );
  await putToBlob(target, file, file.type, onProgress);
  return unwrap(
    await api.post<SceneAsset[]>(`/sessions/${sessionId}/scenes/confirm`, {
      pathname: target.pathname,
      label,
      ...(description ? { description } : {}),
    }),
    'scenes'
  );
}

export async function updateScene(
  sessionId: string,
  sceneId: string,
  input: { label?: string; description?: string | null }
): Promise<SceneAsset[]> {
  return unwrap(
    await api.patch<SceneAsset[]>(
      `/sessions/${sessionId}/scenes/${sceneId}`,
      input
    ),
    'scenes'
  );
}

export async function deleteScene(
  sessionId: string,
  sceneId: string
): Promise<SceneAsset[]> {
  const res = await api.deleteWithBody<SceneAsset[]>(
    `/sessions/${sessionId}/scenes/${sceneId}`
  );
  return unwrap(res, 'scenes');
}

export async function getReferenceSlots(
  sessionId: string
): Promise<ReferenceSlots> {
  return unwrap(
    await api.get<ReferenceSlots>(`/sessions/${sessionId}/references`),
    'references'
  );
}

export async function putReferenceSlots(
  sessionId: string,
  slots: string[]
): Promise<ReferenceSlots> {
  return unwrap(
    await api.putJson<ReferenceSlots>(`/sessions/${sessionId}/references`, {
      slots,
    }),
    'references'
  );
}

export async function resetReferenceSlots(
  sessionId: string
): Promise<ReferenceSlots> {
  return unwrap(
    await api.deleteWithBody<ReferenceSlots>(
      `/sessions/${sessionId}/references`
    ),
    'references'
  );
}

// ── Stage 23: preview frames, relevance (spec §18) ─────────────────────

/**
 * Upload browser-captured preview frames (JPEG blobs keyed by
 * "character:c1" / "scene:s2") and get the analysis back with previewUrl
 * filled in. Frames that fail to upload are skipped, not fatal.
 */
export async function uploadPreviewFrames(
  sessionId: string,
  frames: Array<{ key: string; blob: Blob }>
): Promise<VideoAnalysis | null> {
  if (frames.length === 0) return null;
  const targets = unwrap(
    await api.post<Array<{ key: string; uploadUrl: string; pathname: string }>>(
      `/sessions/${sessionId}/analysis/previews/upload-url`,
      { keys: frames.map((f) => f.key) }
    ),
    'upload-url'
  );
  const uploaded = await Promise.all(
    targets.map(async (t) => {
      const frame = frames.find((f) => f.key === t.key);
      if (!frame) return null;
      try {
        await putToBlob(t, frame.blob, 'image/jpeg');
        return { key: t.key, pathname: t.pathname };
      } catch {
        return null;
      }
    })
  );
  const items = uploaded.filter(
    (x): x is { key: string; pathname: string } => x !== null
  );
  if (items.length === 0) return null;
  return unwrap(
    await api.post<VideoAnalysis>(
      `/sessions/${sessionId}/analysis/previews/confirm`,
      { items }
    ),
    'confirm'
  );
}

export async function getRelevance(sessionId: string): Promise<RelevanceState> {
  return unwrap(
    await api.get<RelevanceState>(`/sessions/${sessionId}/relevance`),
    'relevance'
  );
}

export async function runRelevance(sessionId: string): Promise<RelevanceState> {
  return unwrap(
    await api.post<RelevanceState>(
      `/sessions/${sessionId}/relevance`,
      undefined,
      { timeout: 120000 }
    ),
    'relevance'
  );
}

export async function setRelevanceUseInPrompt(
  sessionId: string,
  useInPrompt: boolean
): Promise<RelevanceState> {
  return unwrap(
    await api.patch<RelevanceState>(`/sessions/${sessionId}/relevance`, {
      useInPrompt,
    }),
    'relevance'
  );
}

// ── Stage 24: scenes & extras selection, library, terms (§19–§21) ──────

export async function getAnalysisSelection(
  sessionId: string
): Promise<AnalysisSelectionView> {
  return unwrap(
    await api.get<AnalysisSelectionView>(
      `/sessions/${sessionId}/analysis/selection`
    ),
    'selection'
  );
}

export async function putAnalysisSelection(
  sessionId: string,
  input: { droppedScenes: string[]; droppedExtras: string[] }
): Promise<AnalysisSelectionView> {
  return unwrap(
    await api.putJson<AnalysisSelectionView>(
      `/sessions/${sessionId}/analysis/selection`,
      input
    ),
    'selection'
  );
}

export async function recommendFromLibrary(
  sessionId: string,
  limit = 12
): Promise<LibraryRecommendation[]> {
  return unwrap(
    await api.get<LibraryRecommendation[]>(
      `/library/recommend?sessionId=${encodeURIComponent(sessionId)}&limit=${limit}`
    ),
    'library'
  );
}

/** Third path to a scenario (§21): take a stored analysis as the reference. */
export async function applyLibraryEntry(
  sessionId: string,
  entryId: string
): Promise<VideoAnalysis> {
  return unwrap(
    await api.post<VideoAnalysis>(`/sessions/${sessionId}/video/library`, {
      entryId,
    }),
    'library'
  );
}

export async function getTermsStatus(): Promise<TermsStatus> {
  return unwrap(await api.get<TermsStatus>('/me/terms'), 'terms');
}

export async function acceptTerms(version: string): Promise<TermsStatus> {
  return unwrap(
    await api.post<TermsStatus>('/me/terms/accept', { version }),
    'terms'
  );
}

// ── Режимы сервиса (§23) ───────────────────────────────────────────────

export async function getPlanState(): Promise<PlanState> {
  return unwrap(await api.get<PlanState>('/me/plan'), 'plan');
}

export async function setPlan(plan: PlanId): Promise<PlanState> {
  return unwrap(await api.patch<PlanState>('/me/plan', { plan }), 'plan');
}

// ── Каталог голосов (§15.3) ────────────────────────────────────────────

export interface VoiceOption {
  voiceId: string;
  name: string;
  previewUrl: string | null;
  accent: string | null;
}

export interface VoiceCatalogue {
  /**
   * Настроен ли синтез на стенде. Пустой список без этого флага экран
   * прочитал бы как поломку, а это штатное состояние.
   */
  configured: boolean;
  voices: VoiceOption[];
  error?: string;
  /**
   * Активный провайдер ('elevenlabs' | 'resemble' | ...,
   * doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md §4.1) — используется, чтобы
   * сравнить с `BrandManifestView.ttsProvider` сохранённого голоса и
   * предупредить при рассинхроне (§4.2).
   */
  provider: string;
}

/**
 * Доп. запрос владельца продукта: `provider` — необязательный, явный
 * выбор каталога конкретного провайдера в обход платформенного
 * дефолта (нужен экрану выбора голоса для сессии, когда бренд не
 * задал голос, а пользователь хочет посмотреть каталог именно
 * Resemble, даже если на платформе сейчас активен другой провайдер).
 */
export async function getVoices(
  language?: string,
  provider?: string
): Promise<VoiceCatalogue> {
  const params = new URLSearchParams();
  if (language) params.set('language', language);
  if (provider) params.set('provider', provider);
  const query = params.toString() ? `?${params.toString()}` : '';
  return unwrap(await api.get<VoiceCatalogue>(`/tts/voices${query}`), 'voices');
}

export interface VoicePreview {
  ok: boolean;
  /** mp3 как data-URL: проба живёт секунды и нигде не оседает. */
  audio?: string;
  characters?: number;
  voiceId?: string;
  used: number;
  limit: number;
  reason?: string;
  skipped?: boolean;
}

/**
 * `text` — `null`, когда используется `options.useOriginalDialogue`
 * (сервер сам достаёт текст из анализа сессии, см.
 * `AnalysisService.extractOriginalDialogueSample()` на бекенде — НЕ
 * клонирование голоса диктора оригинала, только текст его реплик,
 * прочитанный кандидат-голосом).
 */
export async function previewVoice(
  text: string | null,
  voiceId?: string | null,
  options?: {
    provider?: string;
    useOriginalDialogue?: boolean;
    sessionId?: string;
  }
): Promise<VoicePreview> {
  return unwrap(
    await api.post<VoicePreview>('/tts/preview', {
      ...(text ? { text } : {}),
      ...(voiceId ? { voiceId } : {}),
      ...(options?.provider ? { provider: options.provider } : {}),
      ...(options?.useOriginalDialogue ? { useOriginalDialogue: true } : {}),
      ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
    }),
    'preview'
  );
}

// ── Клонирование своего голоса (этап 73, TODO п.32) ────────────────────
// Presigned-Blob поток — тот же, что у фото персонажа/сцен: upload-url →
// PUT в Blob → clone (сервер сам проверяет, что запись реально лежит).

export async function listUserVoices(): Promise<UserVoice[]> {
  return unwrap(await api.get<UserVoice[]>('/voices'), 'voices');
}

/**
 * Presign + PUT образца в Blob (шаги 1–2 потока). Отдельно от `clone()`,
 * потому что подпись/согласие собираются интерфейсом между загрузкой
 * записи и стартом обучения — тот же приём, что фото товара
 * (`uploadAndProcessPhoto`), только confirm-шаг здесь отдельная функция.
 */
export async function uploadVoiceSample(
  file: Blob,
  mimeType: string,
  fileName = 'sample'
): Promise<{ pathname: string }> {
  const target = unwrap(
    await api.post<PresignedUpload>('/voices/upload-url', {
      fileName,
      fileSize: file.size,
      mimeType,
    }),
    'upload-url'
  );
  await putToBlob(target, file, mimeType);
  return { pathname: target.pathname };
}

export async function cloneUserVoice(
  pathname: string,
  label: string,
  consent: boolean
): Promise<UserVoice> {
  return unwrap(
    await api.post<UserVoice>('/voices/clone', { pathname, label, consent }),
    'clone'
  );
}

export async function deleteUserVoice(id: string): Promise<void> {
  await api.delete(`/voices/${id}`);
}

/**
 * Отказ стены бесплатного — «Условно бесплатный Lite» §8, этап 132.
 *
 * Сервер объясняет отказ сам (конверт `error.message`), и человеку
 * этого достаточно. Машинный признак нужен интерфейсу для другого:
 * показать дороги, которыми стена открывается, вместо одной красной
 * строки. Ключ `reason` уже проходит наружу фильтром исключений
 * (`PASSTHROUGH_KEYS`), так что ничего специального на сервере для
 * этого не потребовалось.
 */
export function isGenerationLocked(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false;
  if (err.response?.status !== 403) return false;
  const data = err.response?.data as
    | { error?: { details?: { reason?: unknown } } }
    | undefined;
  return data?.error?.details?.reason === 'generation-locked';
}
