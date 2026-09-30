/**
 * Машинные коды отказов поздравления (волна исправлений по сквозному
 * аудиту Greeting, CONTRACT6).
 *
 * ## Зачем коды, а не только текст
 *
 * Клиент ветвится по коду и переводит его своим словарём (раздел
 * `greetingErrors`, пять локалей); текст сервера — запасной вариант для
 * кода, которого словарь ещё не знает. Раньше половина отказов шла
 * по-английски с UUID внутри: человек видел «Greeting brief not found
 * for project 3f2a…», а интерфейс не мог отличить «сценарий устарел» от
 * «сценария нет» иначе, чем разбором текста.
 *
 * Фильтр исключений уже передаёт `code` из тела в `error.details.code`
 * (`detailsOf` в `filters/http-exception.filter.ts`) — достаточно
 * бросить исключение с объектом `{ code, message }`.
 *
 * ## Правила
 *
 * - Код — короткий идентификатор (`MACHINE_CODE` фильтра), префикс
 *   `GREETING_`; значение совпадает с именем, чтобы поиск по коду из
 *   ответа находил место в коде.
 * - Сообщение — по-русски, человеческим языком, без UUID и внутренних
 *   имён полей/маршрутов: его показывают как есть, когда словарь молчит.
 * - Код не переиспользуется под другой смысл: клиент переводит его
 *   одним текстом на все места.
 *
 * Полный список с текстами — /tmp/k/G-CODES.md на время волны, дальше —
 * doc/API.md, раздел «Поздравления».
 */
export const GREETING_ERROR_CODES = {
  // ── G-B1: рендер, деньги, сценарий ──────────────────────────────────
  /** Сессия создана не из проекта-поздравления (нет снимка брифа). */
  GREETING_NOT_GREETING_SESSION: 'GREETING_NOT_GREETING_SESSION',
  /** Сценария ещё нет — рендерить нечего. */
  GREETING_SCRIPT_MISSING: 'GREETING_SCRIPT_MISSING',
  /** Сценарий не прошёл проверку контента (FLAGGED/BYPASSED). */
  GREETING_SCRIPT_FLAGGED: 'GREETING_SCRIPT_FLAGGED',
  /** Бриф/фото/голос сменились после сборки сценария — собрать заново. */
  GREETING_SCRIPT_STALE: 'GREETING_SCRIPT_STALE',
  /** Ручное одобрение сценария поздравлению не положено (нет такого шага). */
  GREETING_APPROVE_NOT_SUPPORTED: 'GREETING_APPROVE_NOT_SUPPORTED',
  /** Ролик уже запускается или считается — второй старт не нужен. */
  GREETING_RENDER_IN_PROGRESS: 'GREETING_RENDER_IN_PROGRESS',
  /** Ролик уже готов — другой делается новой версией через правку брифа. */
  GREETING_VIDEO_ALREADY_READY: 'GREETING_VIDEO_ALREADY_READY',
  /** Идёт правка брифа/сценария — рендер после неё. */
  GREETING_EDIT_IN_PROGRESS: 'GREETING_EDIT_IN_PROGRESS',
  /** Правка брифа пришлась на старт ролика — ролик уже в работе. */
  GREETING_EDIT_AFTER_RENDER_STARTED: 'GREETING_EDIT_AFTER_RENDER_STARTED',
  /** Повод «Другое» без текста повода. */
  GREETING_OCCASION_TEXT_REQUIRED: 'GREETING_OCCASION_TEXT_REQUIRED',
  /** Бриф проекта не найден (или проект удалён). */
  GREETING_BRIEF_NOT_FOUND: 'GREETING_BRIEF_NOT_FOUND',
  /** Выбранный бренд-бук не найден у пользователя. */
  GREETING_BRAND_NOT_FOUND: 'GREETING_BRAND_NOT_FOUND',
  /** Провайдер рендера не подключён на стенде (нет ключа). */
  GREETING_PROVIDER_UNAVAILABLE: 'GREETING_PROVIDER_UNAVAILABLE',
  // ── G-B2: референсы, голос, персона, карточки ───────────────────────
  /** Смена фото/голоса/музыки/наклейки/сцен/карточек, пока ролик считается. */
  GREETING_CHANGE_DURING_RENDER: 'GREETING_CHANGE_DURING_RENDER',
  /** Уже 7 фото — предел видеомодели. */
  GREETING_REFERENCE_LIMIT: 'GREETING_REFERENCE_LIMIT',
  /** Путь загрузки не из этой сессии. */
  GREETING_REFERENCE_PATH_INVALID: 'GREETING_REFERENCE_PATH_INVALID',
  /** Это фото уже добавлено (повторное подтверждение). */
  GREETING_REFERENCE_ALREADY_ADDED: 'GREETING_REFERENCE_ALREADY_ADDED',
  /** Файл не дошёл до хранилища — загрузить заново. */
  GREETING_REFERENCE_UPLOAD_MISSING: 'GREETING_REFERENCE_UPLOAD_MISSING',
  /** Фото не найдено в списке сессии (удалено в другой вкладке). */
  GREETING_REFERENCE_NOT_FOUND: 'GREETING_REFERENCE_NOT_FOUND',
  /** Голос персоны на Hedra без образа-ведущего — чужое лицо заговорило бы им. */
  GREETING_PERSONA_VOICE_NEEDS_PRESENTER:
    'GREETING_PERSONA_VOICE_NEEDS_PRESENTER',
  /** Голос бренд-бука (свой клон) удалён или ждёт удаления у провайдера. */
  GREETING_BRAND_VOICE_UNAVAILABLE: 'GREETING_BRAND_VOICE_UNAVAILABLE',
} as const;

export type GreetingErrorCode =
  (typeof GREETING_ERROR_CODES)[keyof typeof GREETING_ERROR_CODES];

/** Тело исключения Nest: `throw new BadRequestException(greetingError(...))`. */
export interface GreetingErrorBody {
  code: GreetingErrorCode;
  message: string;
}

export function greetingError(
  code: GreetingErrorCode,
  message: string,
): GreetingErrorBody {
  return { code, message };
}
