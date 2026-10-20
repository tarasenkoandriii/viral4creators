/**
 * Тексты ошибок закрытого раздела Story‑Tales (аудит интерфейсов, S2‑1,
 * S3‑1). Без React и сети — проверяется `scripts/story-errors.test.ts`.
 *
 * Сервер объясняет отказ сам: `HttpExceptionFilter` отвечает конвертом
 * `{ success:false, error:{ code, message, details } }`, и человеку
 * показывается именно `error.message`. Общий запасной текст — только
 * когда ответ пришёл без объяснения; «ответ не получен» — только когда
 * ответа нет вовсе (сеть, таймаут): тогда сервер мог успеть выполнить
 * действие, и повторять его вслепую нельзя.
 */

/** Ошибка, сформулированная клиентом для человека (её текст показывается). */
export class StoryClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoryClientError';
  }
}

export const STORY_NO_RESPONSE =
  'Ответ сервера не получен (нет связи или истекло ожидание). Действие могло выполниться — обновите статус перед повтором.';
export const STORY_FALLBACK = 'Не удалось выполнить действие.';

type ErrorLike = {
  name?: string;
  message?: string;
  code?: string;
  isAxiosError?: boolean;
  request?: unknown;
  response?: {
    status?: number;
    data?: unknown;
  };
};

function text(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const parts = value.filter(
      (v): v is string => typeof v === 'string' && v.trim() !== ''
    );
    return parts.length ? parts.join('; ') : null;
  }
  return null;
}

/** Сообщение сервера из конверта ошибки (или `null`, если его нет). */
export function storyServerMessage(e: unknown): string | null {
  const data = (e as ErrorLike | null)?.response?.data as
    | { error?: { message?: unknown } | string; message?: unknown }
    | undefined;
  if (!data || typeof data !== 'object') return null;
  if (typeof data.error === 'object' && data.error)
    return text(data.error.message) ?? text(data.message);
  return text(data.message);
}

/** Машинный код отказа (`error.details.code`), например `NARRATOR_LOOK_REPEAT_REQUIRED`. */
export function storyErrorCode(e: unknown): string | null {
  const data = (e as ErrorLike | null)?.response?.data as
    | { error?: { details?: { code?: unknown } } }
    | undefined;
  const code = data?.error?.details?.code;
  return typeof code === 'string' ? code : null;
}

const NETWORK_CODES = new Set([
  'ERR_NETWORK',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ERR_CANCELED',
]);

/** Запрос ушёл, но ответа нет: сеть оборвалась или истекло ожидание. */
export function isStoryNoResponse(e: unknown): boolean {
  const err = e as ErrorLike | null;
  if (!err || typeof err !== 'object' || err.response) return false;
  return (
    err.isAxiosError === true ||
    err.request !== undefined ||
    (typeof err.code === 'string' && NETWORK_CODES.has(err.code))
  );
}

/**
 * ST2-U-13: почему не загрузился раздел. Закрытая разработка отвечает 404
 * (`StoryAccessGuard`, режим `owner`), без входа — 401/403: это «раздел закрыт».
 * Всё остальное (сеть, таймаут, 5xx, 429) — сбой, который надо показать
 * текстом с кнопкой «Повторить», а не выдавать за закрытый раздел.
 */
export function storyLoadFailure(e: unknown): 'closed' | 'error' {
  const status = (e as ErrorLike | null)?.response?.status;
  return status === 404 || status === 401 || status === 403
    ? 'closed'
    : 'error';
}

const STATUS_TEXT: Record<number, string> = {
  400: 'Сервер отклонил запрос.',
  403: 'Доступ закрыт.',
  404: 'Не найдено — обновите список.',
  409: 'Действие конфликтует с текущим состоянием — обновите статус.',
  413: 'Слишком большой файл.',
  429: 'Слишком много запросов — попробуйте чуть позже.',
};

/**
 * Текст ошибки для человека.
 * - есть сообщение сервера → оно;
 * - ответ пришёл без сообщения → `fallback` (или текст по HTTP-статусу);
 * - ответа нет (сеть/таймаут) → `noResponse`;
 * - ошибка клиента (`StoryClientError`) → её текст.
 */
export function storyErrorText(
  e: unknown,
  opts: {
    fallback?: string;
    noResponse?: string;
    /** Язык интерфейса: вне ru русский текст сервера не показывается. */
    locale?: string;
    /** Тексты `storyUi` (ошибки по статусу и по коду сервера). */
    ui?: StoryErrorStrings;
  } = {}
): string {
  const locale = opts.locale ?? 'ru';
  const ui = opts.ui;
  const code = storyErrorCode(e);
  const byCode = code && ui ? (ui.codes as Record<string, string>)[code] : '';
  if (byCode && locale !== 'ru') return byCode;
  const server = storyServerMessage(e);
  if (server && (locale === 'ru' || !CYRILLIC.test(server))) return server;
  if (byCode) return byCode;
  const err = e as ErrorLike | null;
  if (err && typeof err === 'object' && err.response) {
    if (opts.fallback) return opts.fallback;
    const status = err.response.status ?? 0;
    if (ui) {
      const map: Record<number, string> = {
        400: ui.errors.s400,
        403: ui.errors.s403,
        404: ui.errors.s404,
        409: ui.errors.s409,
        413: ui.errors.s413,
        429: ui.errors.s429,
      };
      return (
        map[status] ?? (status >= 500 ? ui.errors.s5xx : ui.errors.fallback)
      );
    }
    return (
      STATUS_TEXT[status] ??
      (status >= 500
        ? 'Ошибка сервера. Обновите статус перед повтором.'
        : STORY_FALLBACK)
    );
  }
  if (isStoryNoResponse(e))
    return opts.noResponse ?? ui?.errors.noResponse ?? STORY_NO_RESPONSE;
  if (e instanceof StoryClientError) return e.message;
  return opts.fallback ?? ui?.errors.fallback ?? STORY_FALLBACK;
}

/** Часть словаря `storyUi`, нужная для текстов ошибок. */
export type StoryErrorStrings = {
  errors: Record<
    | 's400'
    | 's403'
    | 's404'
    | 's409'
    | 's413'
    | 's429'
    | 's5xx'
    | 'fallback'
    | 'noResponse'
    | 'micUnsupported'
    | 'micDenied'
    | 'micNotFound'
    | 'micBusy'
    | 'micOther',
    string
  >;
  codes: Record<string, string>;
};
const CYRILLIC = /[А-Яа-яЁёІіЇїЄєҐґ]/;

/**
 * Ошибки микрофона (S3‑1): `getUserMedia`/`MediaRecorder` дают английские
 * имена DOMException — человеку нужна подсказка, где включить разрешение.
 */
export const MIC_UNSUPPORTED = 'StoryMicUnsupported';
export function storyMicErrorText(
  e: unknown,
  ui?: Pick<StoryErrorStrings, 'errors'>
): string {
  const name = (e as { name?: string } | null)?.name ?? '';
  if (ui) {
    const m = ui.errors;
    switch (name) {
      case MIC_UNSUPPORTED:
        return m.micUnsupported;
      case 'NotAllowedError':
      case 'PermissionDeniedError':
      case 'SecurityError':
        return m.micDenied;
      case 'NotFoundError':
      case 'DevicesNotFoundError':
      case 'OverconstrainedError':
        return m.micNotFound;
      case 'NotReadableError':
      case 'TrackStartError':
      case 'AbortError':
        return m.micBusy;
      default:
        return m.micOther;
    }
  }
  switch (name) {
    case MIC_UNSUPPORTED:
      return 'Запись с микрофона здесь не поддерживается. Обновите Telegram или откройте раздел в браузере с поддержкой записи — либо выберите готовый аудиофайл.';
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'Нет доступа к микрофону. Разрешите микрофон для Telegram (настройки телефона → Telegram → Микрофон) или для этого сайта в настройках браузера и попробуйте снова. Можно выбрать готовый аудиофайл.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'Микрофон не найден. Подключите микрофон или выберите готовый аудиофайл.';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'Микрофон занят другим приложением или недоступен. Закройте другие записи и попробуйте снова.';
    default:
      return 'Не удалось включить микрофон. Проверьте разрешение в Telegram или браузере — либо выберите готовый аудиофайл.';
  }
}

/** Есть ли в окружении всё нужное для записи (иначе — `MIC_UNSUPPORTED`). */
export function storyMicSupported(env: {
  mediaDevices?: { getUserMedia?: unknown } | null;
  MediaRecorder?: unknown;
}): boolean {
  return (
    typeof env.mediaDevices?.getUserMedia === 'function' &&
    typeof env.MediaRecorder === 'function'
  );
}
