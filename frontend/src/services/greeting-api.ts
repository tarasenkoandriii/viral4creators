/**
 * GREETING_VIDEO — четвёртый тип проекта (ТЗ TZ-Greeting-Video-Project-Type.md)
 * и follow-up запрос: загрузка референс-изображений для Grok
 * reference-to-video (до 7, скетч как у остальных изображений проекта).
 *
 * Отдельный файл, а не дополнение `projects-api.ts`/`useWorkflow`'а
 * (`services/api.ts`) — той же причине, что у бэкенда: GREETING_VIDEO не
 * проходит через `PromptService`/`GenerationService` (нет разбора
 * референса, нет ProductInformation), у него свои два эндпоинта
 * (`/sessions/:id/greeting-prompt`, `/sessions/:id/greeting-video`) и своя
 * форма брифа. Смешивать с `useWorkflow` значило бы городить ветвление в
 * хуке, рассчитанном на другой конечный автомат.
 */

import axios from 'axios';
import { api } from './api';
import { readStoredLocale, defaultLocale } from '../lib/i18n';
import type { GeneratedVideo, GenerationPrompt, Session } from '../types';
import type {
  GreetingBriefView,
  GreetingReferenceImageView,
  GreetingSenderVoice,
  UpdateGreetingBriefInput,
} from '../types/project';
import type { ItemSessionSummary } from './projects-api';

function unwrap<T>(res: { data?: T }, what: string): T {
  if (res.data === undefined) throw new Error(`Пустой ответ: ${what}`);
  return res.data;
}

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

// ── Brief (§8 ТЗ) ────────────────────────────────────────────────────────

export async function getGreetingBrief(
  projectId: string
): Promise<GreetingBriefView> {
  return unwrap(
    await api.get<GreetingBriefView>(`/projects/${projectId}/greeting-brief`),
    'greeting-brief'
  );
}

export async function updateGreetingBrief(
  projectId: string,
  input: UpdateGreetingBriefInput
): Promise<GreetingBriefView> {
  return unwrap(
    await api.patch<GreetingBriefView>(
      `/projects/${projectId}/greeting-brief`,
      input
    ),
    'greeting-brief'
  );
}

/** POST /projects/:id/greeting-brief/sessions — необходимое дополнение к
 * §8 ТЗ: ни один существующий маршрут не создаёт Session без ProductItem
 * (см. аудит §11 «Соответствие §8 ТЗ»). */
export async function createGreetingSession(
  projectId: string
): Promise<Session> {
  const res = unwrap(
    await api.post<{ sessionId: string; session: Session }>(
      `/projects/${projectId}/greeting-brief/sessions`,
      { locale: readStoredLocale() ?? defaultLocale }
    ),
    'session'
  );
  return res.session;
}

/** GET /projects/:id/greeting-brief/sessions — тем же приёмом, что
 * `listItemSessions`, позволяет вернувшемуся создателю продолжить уже
 * начатую сборку ролика, а не начинать сессию заново каждый раз. */
export async function listGreetingSessions(
  projectId: string
): Promise<ItemSessionSummary[]> {
  return unwrap(
    await api.get<ItemSessionSummary[]>(
      `/projects/${projectId}/greeting-brief/sessions`
    ),
    'sessions'
  );
}

// ── Референс-изображения (доп. запрос, до 7, скетч как у остальных) ────

export async function listGreetingReferences(
  sessionId: string
): Promise<GreetingReferenceImageView[]> {
  return unwrap(
    await api.get<GreetingReferenceImageView[]>(
      `/sessions/${sessionId}/greeting-references`
    ),
    'greeting-references'
  );
}

/**
 * Нарисовать референс-кадр по брифу сессии — фича №6 компаньон-ТЗ.
 *
 * Возвращает ВЕСЬ список, как и остальные методы этого раздела: кадр
 * ложится в те же `greetingReferenceImages`, что и загруженные вручную,
 * и дальше живёт наравне с ними (удаление, подпись, скетч).
 */
export async function generateGreetingReferenceFrame(
  sessionId: string,
  setting?: string | null
): Promise<GreetingReferenceImageView[]> {
  return unwrap(
    await api.post<GreetingReferenceImageView[]>(
      `/sessions/${sessionId}/greeting-references/generate`,
      setting ? { setting } : {}
    ),
    'greeting-references'
  );
}

/**
 * Три варианта сеттинга под повод сессии — фича №36.
 *
 * POST, а не GET: вызов платный (см. доккомментарий роута на бэкенде).
 * Бэкенд возвращает `[]` при любой ошибке модели, поэтому пустой ответ
 * здесь — норма, а не повод показывать ошибку: кадр рисуется и без
 * сеттинга.
 */
export async function suggestGreetingSceneSettings(
  sessionId: string
): Promise<string[]> {
  return unwrap(
    await api.post<string[]>(
      `/sessions/${sessionId}/greeting-references/settings`,
      {}
    ),
    'greeting-reference-settings'
  );
}

/** PNG/JPEG ≤10 MB → presigned PUT → confirm with label/description. */
export async function uploadGreetingReference(
  sessionId: string,
  file: File,
  label: string,
  description: string | null,
  onProgress?: (p: number) => void
): Promise<GreetingReferenceImageView[]> {
  const target = unwrap(
    await api.post<PresignedUpload & { imageId: string }>(
      `/sessions/${sessionId}/greeting-references/upload-url`,
      {
        fileName: file.name || 'reference.jpg',
        fileSize: file.size,
        mimeType: file.type,
      }
    ),
    'upload-url'
  );
  await putToBlob(target, file, file.type, onProgress);
  return unwrap(
    await api.post<GreetingReferenceImageView[]>(
      `/sessions/${sessionId}/greeting-references/confirm`,
      {
        pathname: target.pathname,
        label,
        ...(description ? { description } : {}),
      }
    ),
    'greeting-references'
  );
}

export async function updateGreetingReference(
  sessionId: string,
  imageId: string,
  input: { label?: string; description?: string | null }
): Promise<GreetingReferenceImageView[]> {
  return unwrap(
    await api.patch<GreetingReferenceImageView[]>(
      `/sessions/${sessionId}/greeting-references/${imageId}`,
      input
    ),
    'greeting-references'
  );
}

export async function deleteGreetingReference(
  sessionId: string,
  imageId: string
): Promise<GreetingReferenceImageView[]> {
  return unwrap(
    await api.deleteWithBody<GreetingReferenceImageView[]>(
      `/sessions/${sessionId}/greeting-references/${imageId}`
    ),
    'greeting-references'
  );
}

export const MAX_GREETING_REFERENCE_IMAGES = 7;

// ── Голос отправителя (фича №34) ───────────────────────────────────────

/**
 * Выбранный для ЭТОЙ сессии клон отправителя — `null`, если не выбран
 * (озвучит голос по умолчанию). Само клонирование идёт прежними
 * ручками `/voices/*` (`projects-api.ts`), здесь только выбор.
 */
export async function getGreetingSenderVoice(
  sessionId: string
): Promise<GreetingSenderVoice | null> {
  return unwrap(
    await api.get<GreetingSenderVoice | null>(
      `/sessions/${sessionId}/greeting-voice`
    ),
    'greeting-voice'
  );
}

export async function selectGreetingSenderVoice(
  sessionId: string,
  resembleVoiceId: string | null
): Promise<GreetingSenderVoice | null> {
  return unwrap(
    await api.patch<GreetingSenderVoice | null>(
      `/sessions/${sessionId}/greeting-voice`,
      { resembleVoiceId }
    ),
    'greeting-voice'
  );
}

// ── Сценарий + видео (§5.1–§5.3 ТЗ) ─────────────────────────────────────

export async function generateGreetingPrompt(
  sessionId: string
): Promise<GenerationPrompt> {
  return unwrap(
    await api.post<GenerationPrompt>(`/sessions/${sessionId}/greeting-prompt`),
    'greeting-prompt'
  );
}

export async function startGreetingVideo(
  sessionId: string
): Promise<GeneratedVideo> {
  return unwrap(
    await api.post<GeneratedVideo>(`/sessions/${sessionId}/greeting-video`),
    'greeting-video'
  );
}

export async function getGreetingVideoStatus(
  sessionId: string
): Promise<GeneratedVideo | undefined> {
  const res = await api.get<GeneratedVideo | undefined>(
    `/sessions/${sessionId}/greeting-video`
  );
  return res.data;
}
