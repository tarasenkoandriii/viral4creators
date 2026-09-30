/**
 * Отказы сервера в поздравлении — человеческим текстом на языке
 * интерфейса (CONTRACT6 G-FE п. 8).
 *
 * Сервер кладёт машинный код в `error.details.code`
 * (`backend/src/common/greeting-errors.ts`), а текст отказа пишет
 * по-русски. Известный код переводит словарь (`greetingErrors`, пять
 * локалей); неизвестный — показывается текст сервера, как раньше: новый
 * код на сервере не должен превращаться в «Что-то пошло не так».
 *
 * Без axios и React — правила проверяются тестом
 * (scripts/greeting-errors.test.ts).
 */

/**
 * Сервер ответил 2xx без тела. Раньше это было `Error('Пустой ответ: …')`
 * — русская строка с внутренним именем запроса, которую `errorMessage`
 * показывал человеку как есть на любом языке. Текст ошибки — для журнала;
 * на экран идёт общий перевод «Что-то пошло не так».
 */
export class EmptyResponseError extends Error {
  constructor(readonly what: string) {
    super(`Empty response: ${what}`);
    this.name = 'EmptyResponseError';
  }
}

/** Машинный код отказа из тела ответа (`error.details.code`). */
export function greetingErrorCodeOf(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return null;
  const details = (error as { details?: unknown }).details;
  if (!details || typeof details !== 'object') return null;
  const code = (details as { code?: unknown }).code;
  return typeof code === 'string' && code ? code : null;
}

/**
 * Текст отказа для экрана.
 *
 * @param table — словарь `greetingErrors` (код → текст).
 * @param generic — общий текст на языке интерфейса (пустой ответ).
 * @param fallback — прежний разбор (`errorMessage` с `dict.errors`):
 *   текст сервера, переводы 403/404/409/сети.
 */
export function describeGreetingError(
  err: unknown,
  table: Readonly<Record<string, string>>,
  generic: string,
  fallback: (err: unknown) => string
): string {
  if (err instanceof EmptyResponseError) return generic;
  const body = (err as { response?: { data?: unknown } } | null)?.response
    ?.data;
  const code = greetingErrorCodeOf(body);
  // `hasOwnProperty`, а не `table[code]`: код вида «toString» не должен
  // достать из прототипа функцию вместо текста.
  if (code && Object.prototype.hasOwnProperty.call(table, code)) {
    const text = table[code];
    if (text) return text;
  }
  return fallback(err);
}

/** Код отказа из ошибки запроса (axios-подобной) или `null`. */
export function greetingErrorCodeOfError(err: unknown): string | null {
  const body = (err as { response?: { data?: unknown } } | null)?.response
    ?.data;
  return greetingErrorCodeOf(body);
}

/**
 * Сценарий устарел: после сборки сменились фото, их порядок или образ
 * ведущего (смену голоса сервер перештамповывает сам). Выход один —
 * пересобрать сценарий, и экран ведёт к этой кнопке (проверочный аудит
 * CONTRACT6).
 */
export const GREETING_SCRIPT_STALE = 'GREETING_SCRIPT_STALE';
