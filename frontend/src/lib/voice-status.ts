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

import type {
  VoiceReason,
  VoiceStatus,
  VoiceUnderstandResult,
} from './voice-types';

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
  /** Фраза длиннее потолка — когда сервер не прислал своей строки. */
  tooLong: string;
}

/**
 * Машинные коды «запись слишком длинная» в `error.details.code`. Свой
 * список, а не одна строка: код даёт сервер, и имя у него может быть
 * общим для голоса или своим у поздравления.
 */
export const TOO_LONG_CODES: readonly string[] = [
  'too-long',
  'VOICE_TOO_LONG',
  'GREETING_VOICE_TOO_LONG',
];

/**
 * Отказ выдачи ссылки загрузки (`…/upload-url`) по размеру записи. Это
 * не «распознавание недоступно», а та же причина, что `too-long`:
 * человек должен услышать «короче», на своём языке, а не русский текст
 * сервера.
 *
 * Решение — по машинному признаку (CONTRACT6 G-FE п. 13): `reason:
 * 'too-long'` (фильтр пропускает `reason` в `error.details`) или код из
 * `TOO_LONG_CODES`. Раньше решал текст («длинн|минут|filesize…»):
 * переформулированный отказ сервера молча превращался в «недоступно»,
 * а любая 400 со словом «минута» — в «слишком длинно». Отказ без
 * признака — обычное «недоступно»: клиент режет реплику на 45 с
 * (`voice-listen.ts`), так что до этого отказа честная запись и так не
 * доходит.
 */
export function uploadRefusalOf(
  httpStatus: number | undefined,
  body: unknown
): VoiceUnderstandResult | null {
  if (httpStatus !== 400 || !body || typeof body !== 'object') return null;
  const b = body as {
    error?: { details?: { reason?: unknown; code?: unknown } };
    reason?: unknown;
    code?: unknown;
  };
  const details = b.error?.details;
  const reason = details?.reason ?? b.reason;
  const code = details?.code ?? b.code;
  const tooLong =
    reason === 'too-long' ||
    (typeof code === 'string' && TOO_LONG_CODES.includes(code));
  if (!tooLong) return null;
  return { ...voiceResultOfStatus('unavailable'), reason: 'too-long' };
}

export interface VoiceStatusOutcome {
  /** Строка под микрофоном; `null` — статус молчит (ok, повтор потолка). */
  text: string | null;
  tone: 'info' | 'warning' | 'error';
  /** Выключить прослушивание (и больше не включать его сегодня). */
  stopForToday: boolean;
  /**
   * Выключить прослушивание до нажатия — не до завтра (изменение
   * контракта 2): оператор закрыл голос, нужен вход, исчерпан лимит
   * аккаунта. Слушать дальше значит слать реплики в тот же отказ.
   */
  stopUntilTap: boolean;
}

/**
 * Отказы, после которых слушать бессмысленно, пока человек не нажмёт
 * сам: следующая фраза получит тот же ответ, а строка — тот же текст.
 * `too-long` сюда не входит: отказ одной фразе, следующая пройдёт.
 */
export const STOP_UNTIL_TAP_REASONS: readonly VoiceReason[] = [
  'operator-off',
  'login-required',
  'account-limit',
];

export function stopsUntilTap(reason: VoiceReason | null | undefined): boolean {
  return !!reason && STOP_UNTIL_TAP_REASONS.includes(reason);
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
  result: Pick<VoiceUnderstandResult, 'status' | 'reply' | 'reason'>,
  texts: VoiceStatusTexts,
  mayAnnounceBudget: boolean
): VoiceStatusOutcome | null {
  switch (result.status) {
    case 'ok':
      return null;
    case 'not-heard':
      return {
        text: texts.notHeard,
        tone: 'info',
        stopForToday: false,
        stopUntilTap: false,
      };
    case 'unavailable':
      // `too-long` — тоже здесь: `reply` сервера («короче, пожалуйста»),
      // без него — наша строка; микрофон слушает дальше.
      return {
        text:
          result.reply ||
          (result.reason === 'too-long' ? texts.tooLong : texts.unavailable),
        tone: 'warning',
        stopForToday: false,
        stopUntilTap: stopsUntilTap(result.reason),
      };
    case 'budget-exhausted':
      return {
        text: mayAnnounceBudget ? texts.budgetExhausted : null,
        tone: 'warning',
        stopForToday: true,
        stopUntilTap: false,
      };
  }
}
