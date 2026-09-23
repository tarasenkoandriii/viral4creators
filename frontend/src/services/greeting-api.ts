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
  GreetingCards,
  GreetingCardsView,
  GreetingMusicView,
  GreetingReferenceImageView,
  GreetingScenesView,
  GreetingStickerView,
  GreetingVoiceView,
  GrokPresetVoice,
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
export async function getGreetingVoice(
  sessionId: string
): Promise<GreetingVoiceView> {
  return unwrap(
    await api.get<GreetingVoiceView>(`/sessions/${sessionId}/greeting-voice`),
    'greeting-voice'
  );
}

export async function selectGreetingSenderVoice(
  sessionId: string,
  resembleVoiceId: string | null
): Promise<GreetingVoiceView> {
  return unwrap(
    await api.patch<GreetingVoiceView>(
      `/sessions/${sessionId}/greeting-voice`,
      { resembleVoiceId }
    ),
    'greeting-voice'
  );
}

/**
 * Пресетный голос xAI — реплику произносит сама модель, с настоящим
 * липсинком. Взаимоисключающе со своим клоном: сервер гасит его сам,
 * поэтому ответ читается целиком, а не подставляется локально.
 */
export async function selectGreetingPresetVoice(
  sessionId: string,
  presetVoiceId: string | null
): Promise<GreetingVoiceView> {
  return unwrap(
    await api.patch<GreetingVoiceView>(
      `/sessions/${sessionId}/greeting-voice`,
      { presetVoiceId }
    ),
    'greeting-voice'
  );
}

// ── Сколько сцен снимать (фича №7) ─────────────────────────────────────

export async function getGreetingScenes(
  sessionId: string
): Promise<GreetingScenesView> {
  return unwrap(
    await api.get<GreetingScenesView>(`/sessions/${sessionId}/greeting-scenes`),
    'greeting-scenes'
  );
}

export async function setGreetingScenes(
  sessionId: string,
  sceneCount: number
): Promise<GreetingScenesView> {
  return unwrap(
    await api.patch<GreetingScenesView>(
      `/sessions/${sessionId}/greeting-scenes`,
      { sceneCount }
    ),
    'greeting-scenes'
  );
}

// ── Наклейка поверх кадра (фича №8) ────────────────────────────────────

/**
 * Поиск наклеек. Пустой запрос до сети не доходит, а повторный
 * кешируется на сервере сутки — того требуют условия Pixabay.
 */
export async function searchGreetingStickers(
  sessionId: string,
  query: string
): Promise<GreetingStickerView> {
  return unwrap(
    await api.get<GreetingStickerView>(
      `/sessions/${sessionId}/greeting-sticker?q=${encodeURIComponent(query)}`
    ),
    'greeting-sticker'
  );
}

/**
 * Выбрать наклейку из выдачи. `query` шлётся вместе с id не для
 * красоты: сервер берёт кандидата из кеша ЭТОГО запроса, а не из тела.
 */
export async function selectGreetingSticker(
  sessionId: string,
  query: string,
  stickerId: string,
  placement?: string
): Promise<GreetingStickerView> {
  return unwrap(
    await api.post<GreetingStickerView>(
      `/sessions/${sessionId}/greeting-sticker`,
      { query, stickerId, ...(placement ? { placement } : {}) }
    ),
    'greeting-sticker'
  );
}

export async function moveGreetingSticker(
  sessionId: string,
  placement: string
): Promise<GreetingStickerView> {
  return unwrap(
    await api.patch<GreetingStickerView>(
      `/sessions/${sessionId}/greeting-sticker`,
      { placement }
    ),
    'greeting-sticker'
  );
}

export async function clearGreetingSticker(
  sessionId: string
): Promise<GreetingStickerView> {
  return unwrap(
    await api.deleteWithBody<GreetingStickerView>(
      `/sessions/${sessionId}/greeting-sticker`
    ),
    'greeting-sticker'
  );
}

// ── Карточки: титульная и закрывающая (фичи №38/№39) ───────────────────

/** Зеркалит backend `MAX_CARD_TEXT_LENGTH` — сервер обрежет так же. */
export const MAX_GREETING_CARD_LENGTH = 70;

export async function getGreetingCards(
  sessionId: string
): Promise<GreetingCardsView> {
  return unwrap(
    await api.get<GreetingCardsView>(`/sessions/${sessionId}/greeting-cards`),
    'greeting-cards'
  );
}

export async function updateGreetingCards(
  sessionId: string,
  cards: GreetingCards
): Promise<GreetingCardsView> {
  return unwrap(
    await api.patch<GreetingCardsView>(
      `/sessions/${sessionId}/greeting-cards`,
      cards
    ),
    'greeting-cards'
  );
}

// ── Музыкальная подложка (фича №4) ─────────────────────────────────────

/**
 * Темы, подходящие поводу сессии, плюс выбранная. Пустой список тем —
 * рабочее состояние: каталог ведёт владелец продукта, и до первой
 * загруженной темы секция просто не показывается.
 */
export async function getGreetingMusic(
  sessionId: string
): Promise<GreetingMusicView> {
  return unwrap(
    await api.get<GreetingMusicView>(`/sessions/${sessionId}/greeting-music`),
    'greeting-music'
  );
}

export async function selectGreetingMusic(
  sessionId: string,
  themeId: string | null
): Promise<GreetingMusicView> {
  return unwrap(
    await api.patch<GreetingMusicView>(
      `/sessions/${sessionId}/greeting-music`,
      { themeId }
    ),
    'greeting-music'
  );
}

/**
 * Поиск по библиотекам со свободной лицензией (Freesound, Jamendo,
 * Mubert). Ничего не меняет и денег не стоит — отсюда GET.
 */
export async function searchGreetingMusicLibrary(
  sessionId: string,
  query: string
): Promise<GreetingMusicView> {
  return unwrap(
    await api.get<GreetingMusicView>(
      `/sessions/${sessionId}/greeting-music/library?q=${encodeURIComponent(
        query
      )}`
    ),
    'greeting-music'
  );
}

/**
 * Взять найденный трек. Сервер скачает его к себе: ссылка провайдера
 * живёт своей жизнью, а копия у нас — то, что можно предъявить при
 * разборе лицензии.
 */
export async function selectGreetingMusicFromLibrary(
  sessionId: string,
  query: string,
  provider: string,
  providerTrackId: string
): Promise<GreetingMusicView> {
  return unwrap(
    await api.post<GreetingMusicView>(
      `/sessions/${sessionId}/greeting-music/library`,
      { query, provider, providerTrackId }
    ),
    'greeting-music'
  );
}

/**
 * Своя музыка: presigned PUT → подтверждение. Тот же приём, что у
 * референс-изображений выше, плюс подтверждение прав — ролик человек
 * отправляет другому человеку, и чужая фонограмма в нём это
 * распространение.
 */
export async function uploadGreetingMusic(
  sessionId: string,
  file: File,
  title: string,
  rightsConfirmed: boolean,
  onProgress?: (p: number) => void
): Promise<GreetingMusicView> {
  const target = unwrap(
    await api.post<PresignedUpload & { trackId: string }>(
      `/sessions/${sessionId}/greeting-music/upload-url`,
      {
        fileName: file.name || 'music.mp3',
        fileSize: file.size,
        mimeType: file.type,
      }
    ),
    'music-upload-url'
  );
  await putToBlob(target, file, file.type, onProgress);
  return unwrap(
    await api.post<GreetingMusicView>(
      `/sessions/${sessionId}/greeting-music/confirm`,
      { pathname: target.pathname, title, rightsConfirmed }
    ),
    'greeting-music'
  );
}

/**
 * Ссылка на трек вместо загрузки: файл остаётся у владельца, мы храним
 * только адрес. Взамен не управляем его временем жизни — если трек
 * исчезнет, постобработка ролика честно провалится.
 */
export async function linkGreetingMusic(
  sessionId: string,
  url: string,
  title: string,
  rightsConfirmed: boolean
): Promise<GreetingMusicView> {
  return unwrap(
    await api.post<GreetingMusicView>(
      `/sessions/${sessionId}/greeting-music/link`,
      { url, title, rightsConfirmed }
    ),
    'greeting-music'
  );
}

/** Типы, которые примет бэкенд (`MUSIC_MIME_TYPES`). */
export const GREETING_MUSIC_ACCEPT =
  'audio/mpeg,audio/mp4,audio/aac,audio/wav,audio/x-wav,audio/ogg,audio/webm';
export const MAX_GREETING_MUSIC_BYTES = 20 * 1024 * 1024;

/** Роестр пресетных голосов. Бесплатный читающий вызов, отсюда GET. */
export async function listGreetingPresetVoices(
  sessionId: string
): Promise<GrokPresetVoice[]> {
  return unwrap(
    await api.get<GrokPresetVoice[]>(
      `/sessions/${sessionId}/greeting-voice/presets`
    ),
    'greeting-voice-presets'
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
