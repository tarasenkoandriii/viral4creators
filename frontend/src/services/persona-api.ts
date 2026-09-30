/**
 * «Я в кадре» (ТЗ Greeting 2.0 §4, §6) — тонкие функции над общим `api`
 * (services/api.ts), тем же приёмом, что sketch-api.ts: один
 * axios-экземпляр — один перехватчик авторизации.
 *
 * Маршруты и формы ответов — контракт волны (/tmp/k/CONTRACT4.md «API»);
 * сервер пишут параллельно, поэтому ответы читаются терпимо к мелким
 * расхождениям конверта (`{data: …}` и без него).
 */

import axios from 'axios';
import { api } from './api';
import {
  isPersonaDisabledResponse,
  personaErrorInfo,
  type PersonaQuota,
  type PersonaLook,
  type PersonaMe,
  type LookPreset,
  type PublishedShare,
} from '../lib/persona-flow';
import type { UserVoice } from '../types';
import { normalizeAudioMime } from '../lib/voice-sample';

function unwrap<T>(res: { data?: T }, what: string): T {
  if (res.data === undefined) throw new Error(`Пустой ответ: ${what}`);
  return res.data;
}

/** Режим выключен флагом `PERSONA_ENABLED` (или не развёрнут) — прячем всё. */
export function isPersonaDisabled(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false;
  return isPersonaDisabledResponse(err.response?.status, err.response?.data)
    .disabled;
}

/**
 * Машинный код отказа (`PERSONA_CONSENT_OUTDATED`, `PERSONA_EXISTS`,
 * `PERSONA_UNDER_18`, `PERSONA_LOOK_QUOTA`…) из `error.details.code`
 * конверта фильтра исключений (разбор — `personaErrorInfo`).
 */
export function personaErrorCode(err: unknown): string | null {
  if (!axios.isAxiosError(err)) return null;
  return personaErrorInfo(err.response?.data).code;
}

/** Остаток квоты из 429 (`error.details.quota`), если сервер его прислал. */
export function personaErrorQuota(err: unknown): PersonaQuota | null {
  if (!axios.isAxiosError(err)) return null;
  return personaErrorInfo(err.response?.data).quota;
}

/** 429 на создании образа — квота тарифа (В-7). */
export function isPersonaQuotaRefusal(err: unknown): boolean {
  return axios.isAxiosError(err) && err.response?.status === 429;
}

export async function getPersonaMe(): Promise<PersonaMe> {
  const me = unwrap(await api.get<PersonaMe>('/personas/me'), 'personas/me');
  return {
    persona: me.persona ?? null,
    looks: Array.isArray(me.looks) ? me.looks : [],
    voice: me.voice ?? null,
    quota: me.quota ?? { dayLeft: 0, monthLeft: 0 },
    ...(typeof me.enabled === 'boolean' ? { enabled: me.enabled } : {}),
  };
}

export interface ConsentText {
  text: string;
  version: string;
}

/** Текст согласия — серверный и версионный: версия уходит обратно в `POST /personas`. */
export async function getConsentText(locale: string): Promise<ConsentText> {
  const raw = unwrap(
    await api.get<Partial<ConsentText> & { consentTextVersion?: string }>(
      `/personas/consent-text?locale=${encodeURIComponent(locale)}`
    ),
    'consent-text'
  );
  return {
    text: raw.text ?? '',
    version: raw.version ?? raw.consentTextVersion ?? '',
  };
}

export interface PersonaUploads {
  personaId: string;
  selfieUploadUrl: string;
  selfiePathname: string;
  livenessUploadUrl: string;
  livenessPathname: string;
}

/**
 * Персона создаётся ПОСЛЕ съёмки, хотя согласие дано до камеры: так
 * известны типы файлов (iOS пишет ролик в mp4, и ссылка загрузки
 * подписывается под тип — CreatePersonaDto), а брошенная на полпути
 * съёмка не оставляет на сервере персону без снимков. Галочка согласия
 * при этом всё равно стоит раньше камеры — камера без неё не включается.
 */
export async function createPersona(input: {
  consentTextVersion: string;
  locale: string;
  selfieMimeType: string;
  livenessMimeType: string;
}): Promise<PersonaUploads> {
  return unwrap(
    await api.post<PersonaUploads>('/personas', {
      consent: true,
      consentTextVersion: input.consentTextVersion,
      locale: input.locale,
      selfieMimeType: input.selfieMimeType,
      livenessMimeType: input.livenessMimeType,
    }),
    'personas'
  );
}

/**
 * PUT в Blob по выданному адресу. Тип — голый (без `;codecs=`): он часть
 * подписи адреса, и сервер выдавал его под голый тип.
 */
export async function putPersonaFile(
  uploadUrl: string,
  file: Blob,
  contentType: string,
  onProgress?: (p: number) => void
): Promise<void> {
  await axios.put(uploadUrl, file, {
    headers: { 'Content-Type': contentType },
    onUploadProgress: (e) => {
      if (onProgress && e.total)
        onProgress(Math.round((e.loaded / e.total) * 100));
    },
  });
}

export interface VerifyResult {
  status: 'ok' | 'refused';
  reasons?: string[];
  ageMin?: number | null;
  ageMax?: number | null;
  baseLook?: PersonaLook | null;
}

export async function verifyPersona(): Promise<VerifyResult> {
  return unwrap(
    await api.post<VerifyResult>('/personas/me/verify', {}),
    'personas/me/verify'
  );
}

export interface CreateLookInput {
  preset?: LookPreset;
  description?: string;
  targetAge?: number;
  sourceLookId?: string;
}

export async function createLook(input: CreateLookInput): Promise<PersonaLook> {
  return unwrap(
    await api.post<PersonaLook>('/personas/me/looks', input),
    'personas/me/looks'
  );
}

export async function renameLook(
  id: string,
  label: string
): Promise<PersonaLook> {
  return unwrap(
    await api.patch<PersonaLook>(`/personas/me/looks/${id}`, { label }),
    'rename look'
  );
}

/**
 * Перегенерировать базовый образ (§4.1 п.4) — отдельный маршрут E:
 * `verify` у проверенной персоны только возвращает прежний ответ.
 */
export async function regenerateBaseLook(id: string): Promise<PersonaLook> {
  return unwrap(
    await api.post<PersonaLook>(`/personas/me/looks/${id}/regenerate`, {}),
    'regenerate base look'
  );
}

export async function deleteLook(id: string): Promise<void> {
  await api.delete(`/personas/me/looks/${id}`);
}

export async function deletePersona(): Promise<{
  publishedSharesWithPersona: PublishedShare[];
}> {
  const res = await api.deleteWithBody<{
    publishedSharesWithPersona?: PublishedShare[];
  }>('/personas/me');
  return {
    publishedSharesWithPersona: res?.data?.publishedSharesWithPersona ?? [],
  };
}

/** Снять опубликованную страницу — существующий маршрут сессии. */
export async function unpublishShare(share: PublishedShare): Promise<void> {
  if (!share.sessionId) throw new Error('sessionId is required');
  await api.delete(`/sessions/${share.sessionId}/shared-video/${share.id}`);
}

// ── Голос персоны (§4.6) ────────────────────────────────────────────────

export interface VoiceConsentPhrase {
  /** Редакция фразы — уходит в `POST /voices/clone` (сервер сверяет). */
  version: string;
  /** Шаблон с `{name}`. */
  template: string;
  /** Готовая фраза, если сервер знает имя (Telegram); иначе `null`. */
  text: string | null;
}

export async function getVoiceConsentPhrase(
  locale: string
): Promise<VoiceConsentPhrase> {
  const raw = unwrap(
    await api.get<Partial<VoiceConsentPhrase>>(
      `/personas/voice-consent-phrase?locale=${encodeURIComponent(locale)}`
    ),
    'voice-consent-phrase'
  );
  return {
    version: raw.version ?? '',
    template: raw.template ?? raw.text ?? '',
    text: raw.text ?? null,
  };
}

/** Presign + PUT образца — существующий поток user-voices. */
export async function uploadPersonaVoiceSample(
  file: Blob,
  mimeType: string
): Promise<{ pathname: string }> {
  // См. `uploadVoiceSample`: один нормализованный тип на upload-url и PUT.
  const type = normalizeAudioMime(mimeType, 'audio/webm');
  const target = unwrap(
    await api.post<{ uploadUrl: string; pathname: string }>(
      '/voices/upload-url',
      // `forPersona` — другая проверка лимита: голос персоны один и не
      // считается в три обычных клона (§4.2).
      {
        fileName: 'persona-sample',
        fileSize: file.size,
        mimeType: type,
        forPersona: true,
      }
    ),
    'voices/upload-url'
  );
  await putPersonaFile(target.uploadUrl, file, type);
  return { pathname: target.pathname };
}

/**
 * Клон голоса персоны: тот же `POST /voices/clone`, плюс `forPersona`
 * (контракт волны) — сервер привязывает клон к персоне и не считает его
 * в лимит трёх (§4.2).
 */
export async function clonePersonaVoice(
  pathname: string,
  label: string,
  consentPhraseVersion: string
): Promise<UserVoice> {
  return unwrap(
    await api.post<UserVoice>('/voices/clone', {
      pathname,
      label,
      consent: true,
      forPersona: true,
      consentPhraseVersion,
    }),
    'voices/clone'
  );
}
