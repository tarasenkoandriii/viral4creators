/**
 * API Client Service
 *
 * Centralized HTTP client for backend API communication.
 * Provides base configuration and error handling.
 */

import axios, { AxiosInstance, AxiosError, AxiosRequestConfig } from 'axios';
import { ModerationStatus } from '../types';
import type {
  Session as FullSession,
  VideoAnalysis as FullVideoAnalysis,
  ExportVariant,
} from '../types';
import { getAuthHeaders, getTelegramWebApp } from '../lib/telegram';
import { initialLocale } from '../lib/i18n';

/**
 * API response wrapper
 */
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
  meta: {
    timestamp: string;
    requestId: string;
  };
}

/**
 * API Client class
 */
class ApiClient {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000/api',
      timeout: 120000, // 120 seconds - allows for long-running AI operations
      headers: {
        'Content-Type': 'application/json',
      },
      // Needed for the persistent Telegram login cookie (see
      // lib/telegram-login.ts) — backend/frontend are separate domains
      // in production, and a cross-origin cookie needs this explicitly
      // set on both the request AND the CORS response (already
      // `credentials: true` on the backend, see main.ts). No effect on
      // the ordinary anonymous flow: there's no cookie to send until
      // someone actually clicks "Log in with Telegram".
      withCredentials: true,
    });

    // Request interceptor — attaches Telegram/dev-login auth headers when
    // available (see lib/telegram.ts). Outside Telegram and without the
    // dev stand, getAuthHeaders() returns {} and every request stays
    // exactly as anonymous as it always was — this is additive, not a
    // gate: see doc/TELEGRAM-ADMIN.md.
    //
    // Accept-Language (аудит 2026-09-08, Г-5.2) — до этого этапа локаль
    // уходила на бэкенд ТОЛЬКО при создании сессии; всё остальное, что
    // отдаётся клиенту готовым текстом (режимы, пакеты кредитов, общий
    // текст ошибки 500), было жёстко зашито по-русски независимо от
    // выбора языка в интерфейсе. `initialLocale(...)` — та же функция
    // разрешения локали, что и у `I18nContext` (lib/i18n-context.ts):
    // явный выбор человека, иначе язык Telegram-клиента, иначе русский
    // по умолчанию — интерцептор живёт вне дерева React и не может
    // прочитать текущую локаль из контекста напрямую, поэтому повторяет
    // ту же логику, а не берёт только `readStoredLocale()` (это дало бы
    // рассинхрон: интерфейс на языке Telegram, а бэкенд всегда по-русски,
    // пока человек ни разу не тронул переключатель языка вручную).
    // Вызывается на КАЖДЫЙ запрос — переключение языка без перезагрузки
    // страницы сразу меняет заголовок следующего запроса.
    this.client.interceptors.request.use((config) => {
      Object.assign(config.headers, getAuthHeaders());
      config.headers['Accept-Language'] = initialLocale(
        getTelegramWebApp()?.initDataUnsafe?.user?.language_code
      );
      return config;
    });

    // Response interceptor for error handling
    this.client.interceptors.response.use(
      (response) => response,
      (error: AxiosError) => {
        if (error.response) {
          // Server responded with error status
          console.error('API Error:', error.response.data);
        } else if (error.request) {
          // No response received
          console.error('Network Error:', error.message);
        } else {
          // Request setup error
          console.error('Request Error:', error.message);
        }
        return Promise.reject(error);
      }
    );
  }

  /**
   * GET request
   */
  async get<T>(url: string): Promise<ApiResponse<T>> {
    const response = await this.client.get<ApiResponse<T>>(url);
    return response.data;
  }

  /**
   * POST request
   */
  async post<T>(
    url: string,
    data?: unknown,
    config?: AxiosRequestConfig
  ): Promise<ApiResponse<T>> {
    const response = await this.client.post<ApiResponse<T>>(url, data, config);
    return response.data;
  }

  /**
   * PATCH request
   */
  async patch<T>(url: string, data?: unknown): Promise<ApiResponse<T>> {
    const response = await this.client.patch<ApiResponse<T>>(url, data);
    return response.data;
  }

  /**
   * DELETE request (204 → no envelope; resolves to undefined)
   */
  async delete(url: string): Promise<void> {
    await this.client.delete(url);
  }

  /** DELETE that returns an envelope (e.g. the remaining list). */
  async deleteWithBody<T>(url: string): Promise<ApiResponse<T>> {
    const response = await this.client.delete<ApiResponse<T>>(url);
    return response.data;
  }

  /**
   * PUT request with a JSON body against our own API (envelope-wrapped).
   */
  async putJson<T>(url: string, data?: unknown): Promise<ApiResponse<T>> {
    const response = await this.client.put<ApiResponse<T>>(url, data);
    return response.data;
  }

  /**
   * PUT request for file upload
   */
  async put(url: string, data: Blob, contentType: string): Promise<void> {
    await axios.put(url, data, {
      headers: {
        'Content-Type': contentType,
      },
    });
  }

  /**
   * Upload file to a presigned URL with progress tracking via XMLHttpRequest.
   * Currently unused — uploadVideo/uploadProductImage below call axios.put
   * directly instead — kept in case a future presigned-upload caller wants
   * progress events without pulling in axios.
   */
  async uploadFile(
    presignedUrl: string,
    file: File,
    onProgress?: (progress: number) => void
  ): Promise<void> {
    // Use XMLHttpRequest for progress tracking with fetch-like behavior
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();

      // Track upload progress
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable && onProgress) {
          const progress = (e.loaded / e.total) * 100;
          onProgress(Math.round(progress));
        }
      });

      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          reject(new Error(`Upload failed with status ${xhr.status}`));
        }
      });

      xhr.addEventListener('error', () => {
        reject(new Error('Upload failed'));
      });

      xhr.addEventListener('abort', () => {
        reject(new Error('Upload aborted'));
      });

      // Open PUT request to presigned URL
      xhr.open('PUT', presignedUrl);

      // Set Content-Type header - this is part of the presigned URL signature
      xhr.setRequestHeader('Content-Type', file.type);

      // Send the file
      xhr.send(file);
    });
  }
}

// Export singleton instance
export const api = new ApiClient();

// ============================================================================
// Session API Methods
// ============================================================================

export interface Session {
  sessionId: string;
  createdAt: string;
  lastActivityAt: string;
  status: string;
}

/**
 * Create a new session.
 *
 * `locale` (этап 59, ТЗ §35.5) — UI-локаль пользователя на момент
 * создания сессии; сохраняется на бэкенде неизменной на весь срок жизни
 * сессии и используется для локализации ИИ-вывода (разбор видео,
 * распознавание товара, отчёт о релевантности, аудит ролика).
 * Необязательный параметр — без него бэкенд по умолчанию считает 'ru'
 * (обратная совместимость со старыми клиентами).
 */
export async function createSession(locale?: string): Promise<Session> {
  const response = await api.post<{ sessionId: string; session: Session }>(
    '/sessions',
    locale ? { locale } : undefined
  );

  if (!response.data) {
    throw new Error('Failed to create session');
  }

  // Handle double-wrapped response
  const data =
    'data' in response.data && typeof response.data.data === 'object'
      ? (response.data.data as { sessionId: string; session: Session })
      : response.data;

  return data.session;
}

/**
 * «Сделать такой же» (этап 60, ТЗ §40) — деплинк с публичной страницы
 * ролика (`landing/…/video/:id`, `?fromShared=<id>`). Публичный маршрут:
 * никакой идентификации не требуется, как и у `createSession`. Бэкенд
 * создаёт новую анонимную сессию и, если у страницы есть доступный
 * (§21.3) разбор библиотеки, применяет его сразу — поэтому вызывающая
 * сторона (useWorkflow) должна следом дочитать сессию `getSession`,
 * а не просто запомнить id, как при обычном создании с чистого листа.
 */
export async function forkSharedVideo(
  pageId: string,
  locale?: string
): Promise<{ sessionId: string }> {
  const response = await api.post<{ sessionId: string }>(
    `/shared-video/${pageId}/fork`,
    locale ? { locale } : undefined
  );
  if (!response.data) {
    throw new Error('Failed to fork shared video');
  }
  const data =
    'data' in response.data && typeof response.data.data === 'object'
      ? (response.data.data as { sessionId: string })
      : response.data;
  return data;
}

/**
 * Load a session — used by the wizard to pick up product info / brand
 * manifest that a project-bound session already carries (Stage 10).
 * Returns null for 404 so the caller can fall back to a fresh session.
 */
export async function getSession(
  sessionId: string
): Promise<FullSession | null> {
  const response = await api.get<FullSession | null>(`/sessions/${sessionId}`);
  if (!response.data) return null;
  const data =
    'data' in response.data && typeof response.data.data === 'object'
      ? (response.data.data as FullSession | null)
      : response.data;
  return data ?? null;
}

// ============================================================================
// Video API Methods
// ============================================================================

export interface UploadVideoRequest {
  fileName: string;
  fileSize: number;
  mimeType: string;
}

export interface UploadVideoUrlResponse {
  uploadUrl: string;
  pathname: string;
}

/**
 * Upload a video file as the analysis reference.
 *
 * Two-step direct-to-storage upload: ask the backend for a presigned
 * Vercel Blob PUT URL, then PUT the file bytes straight to Blob storage.
 * The backend never sees the raw file — this is what lets a 100MB video
 * through even though Vercel Functions cap request bodies at 4.5MB.
 */
export async function uploadVideo(
  sessionId: string,
  file: File,
  onProgress?: (progress: number) => void,
  size?: { width: number; height: number } | null
): Promise<void> {
  const response = await api.post<UploadVideoUrlResponse>(
    `/sessions/${sessionId}/video/upload-url`,
    {
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type,
      // Spec §16: pixel size read in the browser → reference frame.
      ...(size ? { width: size.width, height: size.height } : {}),
    }
  );

  if (!response.data) {
    throw new Error('Failed to get upload URL');
  }

  // Handle double-wrapped response
  const data =
    'data' in response.data && typeof response.data.data === 'object'
      ? (response.data.data as UploadVideoUrlResponse)
      : response.data;

  await axios.put(data.uploadUrl, file, {
    headers: { 'Content-Type': file.type },
    onUploadProgress: (progressEvent) => {
      if (onProgress && progressEvent.total) {
        const progress = (progressEvent.loaded / progressEvent.total) * 100;
        onProgress(Math.round(progress));
      }
    },
  });
}

/**
 * Register a public YouTube URL as the analysis reference instead of
 * uploading a file. Gemini fetches the video itself server-side — nothing
 * is uploaded or stored on our side for this path.
 */
export async function registerYoutubeVideo(
  sessionId: string,
  youtubeUrl: string
): Promise<void> {
  await api.post(`/sessions/${sessionId}/video/youtube`, { youtubeUrl });
}

// ============================================================================
// Analysis API Methods
// ============================================================================

/**
 * Same shape as types/index.ts VideoAnalysis (characters, scenes, audience,
 * promotedProduct — spec §10/§18), with `status` as plain string literals
 * because the workflow compares it to 'complete' / 'failed' directly.
 */
export interface VideoAnalysis extends Omit<FullVideoAnalysis, 'status'> {
  status: 'pending' | 'processing' | 'complete' | 'failed';
}

/**
 * Trigger video analysis
 */
export async function triggerAnalysis(
  sessionId: string
): Promise<{ analysisId: string; status: string }> {
  // This now runs the actual Gemini analysis synchronously on the backend
  // (see AnalysisService.analyzeVideo) rather than kicking off a
  // background job — the default 120s client timeout was set for the old
  // "returns immediately" behavior and is too tight for that. 280s stays
  // just under Vercel Hobby's fixed 300s Function duration cap.
  const response = await api.post<{ analysisId: string; status: string }>(
    `/sessions/${sessionId}/analysis`,
    undefined,
    { timeout: 280000 }
  );

  if (!response.data) {
    throw new Error('Failed to trigger analysis');
  }

  // Handle double-wrapped response
  const data =
    'data' in response.data && typeof response.data.data === 'object'
      ? (response.data.data as { analysisId: string; status: string })
      : response.data;

  return data;
}

/**
 * Get analysis status and results (for polling)
 */
export async function getAnalysisStatus(
  sessionId: string
): Promise<VideoAnalysis> {
  const response = await api.get<VideoAnalysis>(
    `/sessions/${sessionId}/analysis`
  );

  if (!response.data) {
    throw new Error('Failed to get analysis status');
  }

  // Handle double-wrapped response
  const data =
    'data' in response.data && typeof response.data.data === 'object'
      ? (response.data.data as VideoAnalysis)
      : response.data;

  return data;
}

/**
 * Update analysis with user edits
 */
export async function updateAnalysis(
  sessionId: string,
  editedText: string
): Promise<VideoAnalysis> {
  const response = await api.patch<VideoAnalysis>(
    `/sessions/${sessionId}/analysis`,
    { editedText }
  );

  if (!response.data) {
    throw new Error('Failed to update analysis');
  }

  // Handle double-wrapped response
  const data =
    'data' in response.data && typeof response.data.data === 'object'
      ? (response.data.data as VideoAnalysis)
      : response.data;

  return data;
}

// ============================================================================
// Product API Methods
// ============================================================================

export interface ProductInformation {
  productName: string;
  productDescription: string;
}

export interface SubmitProductInfoResponse {
  sessionId: string;
  productName: string;
  productDescription: string;
  status: string;
}

/**
 * Submit product information
 */
export async function submitProductInfo(
  sessionId: string,
  productName: string,
  productDescription: string,
  dialogueLanguage?: string | null
): Promise<SubmitProductInfoResponse> {
  const response = await api.post<SubmitProductInfoResponse>(
    `/sessions/${sessionId}/product`,
    {
      productName,
      productDescription,
      ...(dialogueLanguage ? { dialogueLanguage } : {}),
    }
  );

  if (!response.data) {
    throw new Error('Failed to submit product information');
  }

  // Handle double-wrapped response
  const data =
    'data' in response.data && typeof response.data.data === 'object'
      ? (response.data.data as SubmitProductInfoResponse)
      : response.data;

  return data;
}

// ============================================================================
// Prompt API Methods
// ============================================================================

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

/**
 * Generate text-to-video prompt from analysis and product info
 */
export async function generatePrompt(
  sessionId: string
): Promise<GenerationPrompt> {
  const response = await api.post<GenerationPrompt>(
    `/sessions/${sessionId}/prompt`
  );

  if (!response.data) {
    throw new Error('Failed to generate prompt');
  }

  // Handle double-wrapped response
  const data =
    'data' in response.data && typeof response.data.data === 'object'
      ? (response.data.data as GenerationPrompt)
      : response.data;

  return data;
}

/**
 * Update prompt with user edits
 */
export async function updatePrompt(
  sessionId: string,
  editedText: string,
  voiceoverScript?: string
): Promise<GenerationPrompt> {
  const response = await api.patch<GenerationPrompt>(
    `/sessions/${sessionId}/prompt`,
    // §15.2: не переданный текст озвучки сервер не трогает — иначе
    // правка промпта молча стирала бы выверенные реплики.
    voiceoverScript === undefined
      ? { editedText }
      : { editedText, voiceoverScript }
  );

  if (!response.data) {
    throw new Error('Failed to update prompt');
  }

  // Handle double-wrapped response
  const data =
    'data' in response.data && typeof response.data.data === 'object'
      ? (response.data.data as GenerationPrompt)
      : response.data;

  return data;
}

/**
 * Approve prompt for video generation
 */
export async function approvePrompt(
  sessionId: string
): Promise<GenerationPrompt> {
  const response = await api.post<GenerationPrompt>(
    `/sessions/${sessionId}/prompt/approve`
  );

  if (!response.data) {
    throw new Error('Failed to approve prompt');
  }

  // Handle double-wrapped response
  const data =
    'data' in response.data && typeof response.data.data === 'object'
      ? (response.data.data as GenerationPrompt)
      : response.data;

  return data;
}

// ============================================================================
// Product Image Upload API Methods
// ============================================================================

export interface UploadProductImageRequest {
  fileName: string;
  fileSize: number;
  mimeType: string;
}

export interface UploadProductImageResponse {
  uploadUrl: string;
  pathname: string;
}

/**
 * Upload a product image file.
 *
 * Same two-step direct-to-storage pattern as uploadVideo above: ask the
 * backend for a presigned Vercel Blob PUT URL, then PUT the file bytes
 * straight to Blob storage. This replaces the old direct multipart-to-backend
 * upload, which sent the whole image through the Function's request body —
 * fine locally, but a real phone photo (3-8MB) exceeds Vercel's fixed 4.5MB
 * body limit and would fail with 413 every time. See
 * doc/VERCEL-READINESS-AUDIT.md, finding #4. The upload target moved from S3
 * to Vercel Blob later on, consolidating storage onto one provider — see
 * BlobService's doc comment.
 */
export async function uploadProductImage(
  sessionId: string,
  file: File,
  onProgress?: (progress: number) => void
): Promise<void> {
  const response = await api.post<UploadProductImageResponse>(
    `/sessions/${sessionId}/product/image/upload-url`,
    {
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type,
    }
  );

  if (!response.data) {
    throw new Error('Failed to get upload URL');
  }

  // Handle double-wrapped response (same shape as uploadVideo's)
  const data =
    'data' in response.data && typeof response.data.data === 'object'
      ? (response.data.data as UploadProductImageResponse)
      : response.data;

  await axios.put(data.uploadUrl, file, {
    headers: { 'Content-Type': file.type },
    onUploadProgress: (progressEvent) => {
      if (onProgress && progressEvent.total) {
        const progress = (progressEvent.loaded / progressEvent.total) * 100;
        onProgress(Math.round(progress));
      }
    },
  });
}

// ============================================================================
// Video Generation API Methods
// ============================================================================

export type VideoQuality = 'fast' | 'standard';

export interface GeneratedVideo {
  generatedVideoId: string;
  pathname: string;
  fileName: string;
  fileSize?: number;
  mimeType: string;
  status: 'pending' | 'processing' | 'complete' | 'failed';
  initiatedAt: string;
  completedAt?: string;
  /** Spec §16 — asked / rendered / crop owed. */
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
  /** Spec §10.2/§10.3 — which photos Veo received as referenceImages. */
  references?: Array<{
    index: number;
    kind: 'character' | 'scene' | 'product';
    label: string;
    characterId: string | null;
  }>;
  estimatedCompletionTime?: string;
  downloadUrl?: string;
  quality?: VideoQuality;
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
 * Generate video using Google Veo 3.1.
 * @param quality - 'fast' (default, Veo 3.1 Lite) or 'standard' (full Veo 3.1)
 */
export async function generateVideo(
  sessionId: string,
  quality: VideoQuality = 'fast',
  aspectRatio?: string | null,
  provider?: 'veo' | 'grok',
  resolution?: '480p' | '720p' | '1080p'
): Promise<GeneratedVideo> {
  const response = await api.post<GeneratedVideo>(
    `/sessions/${sessionId}/generate`,
    {
      quality,
      ...(aspectRatio ? { aspectRatio } : {}),
      ...(provider ? { provider } : {}),
      ...(resolution ? { resolution } : {}),
    }
  );

  if (!response.data) {
    throw new Error('Failed to start video generation');
  }

  // Handle double-wrapped response
  const data =
    'data' in response.data && typeof response.data.data === 'object'
      ? (response.data.data as GeneratedVideo)
      : response.data;

  return data;
}

/**
 * Доп. запрос владельца продукта: расчёт цены заранее, при выборе
 * провайдера/качества/разрешения (ТЗ VEO-MODEL-VERSION-CHOICE-SPEC.md
 * §11.3) — до кнопки «Сгенерировать», не после. Сессия в URL — только
 * для единообразия с остальными маршрутами генерации, сама сессия не
 * используется бэкендом для этого расчёта.
 */
export async function getCostEstimate(
  sessionId: string,
  provider: 'veo' | 'grok',
  quality?: VideoQuality,
  resolution?: '480p' | '720p' | '1080p'
): Promise<{ costUsd: number; unpriced: boolean }> {
  const params = new URLSearchParams({ provider });
  if (quality) params.set('quality', quality);
  if (resolution) params.set('resolution', resolution);
  const response = await api.get<{ costUsd: number; unpriced: boolean }>(
    `/sessions/${sessionId}/generate/estimate?${params.toString()}`
  );
  if (!response.data) {
    throw new Error('Failed to estimate cost');
  }
  return response.data;
}

/**
 * Get video generation status (for polling)
 */
export async function getVideoStatus(
  sessionId: string
): Promise<GeneratedVideo> {
  const response = await api.get<GeneratedVideo>(
    `/sessions/${sessionId}/generate`
  );

  if (!response.data) {
    throw new Error('Failed to get video status');
  }

  // Handle double-wrapped response
  const data =
    'data' in response.data && typeof response.data.data === 'object'
      ? (response.data.data as GeneratedVideo)
      : response.data;

  return data;
}
