/**
 * Голосовая реплика мастера поздравления — клиент этапа K3 ТЗ
 * `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md` §4А.
 *
 * Бриф заполняется ДО сессии, поэтому маршрутов два, а сервис один:
 *
 *   до старта  POST /projects/:projectId/greeting-voice/upload-url
 *              POST /projects/:projectId/greeting-voice/understand
 *   после      POST /sessions/:sessionId/voice/upload-url   (K2)
 *              POST /sessions/:sessionId/voice/understand
 *
 * Тот же двухшаговый поток, что у голосового описания товара
 * (`uploadAndTranscribeVoice` в projects-api.ts): подписанный PUT прямо в
 * Blob, затем разбор по `pathname`. Сервер ничего не применяет — только
 * разбирает; применяет экран после «Да».
 *
 * Контракт «никогда не бросает»: любой сбой превращается в статус
 * `unavailable` (`voiceResultOfError`), потому что прослушивание идёт фоном, и
 * необработанная ошибка здесь означала бы молча погасший микрофон.
 */

import axios from 'axios';
import { api } from './api';
import { serverMessageOf, voiceResultOfError } from '../lib/voice-status';
import type {
  VoiceUnderstandContext,
  VoiceUnderstandResult,
} from '../lib/voice-types';

export type {
  VoiceCommand,
  VoiceField,
  VoiceIntent,
  VoiceStatus,
  VoiceUnderstandContext,
  VoiceUnderstandResult,
} from '../lib/voice-types';

interface PresignedUpload {
  uploadUrl: string;
  pathname: string;
}

function unwrap<T>(res: { data?: T }, what: string): T {
  if (res.data === undefined) throw new Error(`Empty response: ${what}`);
  return res.data;
}

/** Куда слать реплику: до сессии — проект, после — сессия. */
export interface VoiceScope {
  projectId: string;
  sessionId: string | null;
}

export function voiceBase(scope: VoiceScope): string {
  return scope.sessionId
    ? `/sessions/${scope.sessionId}/voice`
    : `/projects/${scope.projectId}/greeting-voice`;
}

/**
 * Загрузить отрезок речи и получить разбор. Не бросает: сеть, 4xx, 5xx —
 * всё приходит статусом `unavailable`. Потолок (В-14) — только из тела
 * ответа 200 (`status: 'budget-exhausted'`).
 */
export async function understandVoice(
  scope: VoiceScope,
  audio: Blob,
  mimeType: string,
  context: VoiceUnderstandContext
): Promise<VoiceUnderstandResult> {
  const base = voiceBase(scope);
  try {
    const target = unwrap(
      await api.post<PresignedUpload>(`${base}/upload-url`, {
        fileName: 'voice',
        fileSize: audio.size,
        mimeType,
      }),
      'voice-upload-url'
    );
    await axios.put(target.uploadUrl, audio, {
      headers: { 'Content-Type': mimeType },
    });
    return unwrap(
      await api.post<VoiceUnderstandResult>(`${base}/understand`, {
        pathname: target.pathname,
        ...context,
      }),
      'voice-understand'
    );
  } catch (e) {
    // Любой сбой — «недоступно», но не потолок (см. `voiceResultOfError`).
    const body = axios.isAxiosError(e) ? e.response?.data : undefined;
    return voiceResultOfError(serverMessageOf(body));
  }
}
