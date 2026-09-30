/**
 * Статус голосовой реплики → что сказать человеку и что сделать с
 * микрофоном (этап K3, ТЗ Greeting 2.0 §4А.3 строка «Тишина, шум,
 * обрывок», §4А.7.5 В-14).
 *
 * Чистые функции: решение «гасить ли микрофон на сутки» слишком дорого
 * ошибиться, чтобы проверять его только руками в браузере. Память о
 * потолке (сутки UTC, «сказать один раз») — общая с голосом советника,
 * в `hint-audio-session.ts`; здесь её нет, чтобы не было двух копий.
 */

import type { VoiceStatus, VoiceUnderstandResult } from './voice-types';

/**
 * Сбой запроса (сеть, любой HTTP-код, подпись PUT в Blob) — всегда
 * «недоступно», НИКОГДА не потолок.
 *
 * Потолок сервер сообщает только телом `200 { status: 'budget-exhausted' }`.
 * 403 значит другое — оператор закрыл голос, чужая сессия, протухший
 * initData, просроченная подпись Blob, — и принимать его за потолок
 * значило бы запереть микрофон до полуночи UTC из-за временного сбоя
 * (аудит волны 1). Текст сервера, если он есть, показывается как `reply`:
 * «доступ закрыт оператором» полезнее общего «недоступно».
 */
export function voiceResultOfError(
  serverMessage: string | null | undefined
): VoiceUnderstandResult {
  return voiceResultOfStatus(
    'unavailable',
    serverMessage && serverMessage.trim() ? serverMessage.trim() : null
  );
}

/** Сообщение сервера из тела ошибки (конверт `{ error: { message } }`). */
export function serverMessageOf(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { error?: { message?: unknown }; message?: unknown };
  const m = b.error?.message ?? b.message;
  return typeof m === 'string' ? m : null;
}

/** Пустой разбор с данным статусом — то, что вернул бы сервер. */
export function voiceResultOfStatus(
  status: VoiceStatus,
  reply: string | null = null
): VoiceUnderstandResult {
  return {
    status,
    transcript: null,
    language: null,
    intent: null,
    confidence: 0,
    reply,
    scriptMismatch: false,
  };
}

export interface VoiceStatusTexts {
  notHeard: string;
  unavailable: string;
  budgetExhausted: string;
}

export interface VoiceStatusOutcome {
  /** Строка под микрофоном; `null` — статус молчит (ok, повтор потолка). */
  text: string | null;
  tone: 'info' | 'warning' | 'error';
  /** Выключить прослушивание (и больше не включать его сегодня). */
  stopForToday: boolean;
}

/**
 * Не `ok` → что показать.
 *
 * «Не расслышал» — всегда наша строка: состояние одно, и текст не должен
 * зависеть от того, где оно возникло. «Недоступно» — `reply` сервера,
 * если он объяснил причину (анонимная сессия, суточный лимит аккаунта,
 * оператор), иначе наша общая строка.
 *
 * Потолок говорится ОДИН раз на страницу (§4А.7.5), сколько бы каналов о
 * нём ни узнали: `mayAnnounceBudget` — право сказать, выданное общим
 * `claimVoiceBudgetNotice`. Микрофон гаснет в любом случае.
 */
export function voiceStatusOutcome(
  result: Pick<VoiceUnderstandResult, 'status' | 'reply'>,
  texts: VoiceStatusTexts,
  mayAnnounceBudget: boolean
): VoiceStatusOutcome | null {
  switch (result.status) {
    case 'ok':
      return null;
    case 'not-heard':
      return { text: texts.notHeard, tone: 'info', stopForToday: false };
    case 'unavailable':
      return {
        text: result.reply || texts.unavailable,
        tone: 'warning',
        stopForToday: false,
      };
    case 'budget-exhausted':
      return {
        text: mayAnnounceBudget ? texts.budgetExhausted : null,
        tone: 'warning',
        stopForToday: true,
      };
  }
}
