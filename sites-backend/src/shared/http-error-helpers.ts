// СГЕНЕРИРОВАНО scripts/sync-sites-shared.mjs — не править.
// Источник: backend/src/common/http-error-helpers.ts. Правка — в источнике, затем
// `node scripts/sync-sites-shared.mjs`; CI сверяет копию флагом --check.

/**
 * Общие куски фильтров ошибок backend и sites-backend
 * (`common/filters/http-exception.filter.ts` в каждом). Копия —
 * `sites-backend/src/shared/http-error-helpers.ts` через
 * `scripts/sync-sites-shared.mjs`. Заход 12, аудит P3-3/P3-4.
 */

/**
 * Ошибка разбора тела (body-parser/raw-body: `http-errors` с `expose`,
 * статусом 4xx и `type` вида `entity.too.large`/`entity.parse.failed`/
 * `encoding.unsupported`) — это отказ клиенту, а не авария: раньше
 * слишком большое тело (413) или неподдержанная `Content-Encoding` (415)
 * давали 500 и ERROR в лог. Текст пакета наружу не отдаём — своя фраза по
 * статусу. `SyntaxError` битого JSON сюда тоже подходит, но Nest
 * превращает его в 400 раньше фильтра.
 */
export function bodyParserStatus(exception: unknown): number | null {
  if (!exception || typeof exception !== 'object') return null;
  const e = exception as { expose?: unknown; status?: unknown; type?: unknown };
  if (
    e.expose === true &&
    typeof e.status === 'number' &&
    e.status >= 400 &&
    e.status < 500 &&
    typeof e.type === 'string' &&
    /^(entity|request|charset|encoding)\./.test(e.type)
  ) {
    return e.status;
  }
  return null;
}

/** Фраза ответа для ошибки разбора тела (без текста пакета). */
export function bodyParserMessage(status: number): string {
  return status === 413
    ? 'Тело запроса слишком большое'
    : 'Неверное тело запроса';
}

const ROUTE_NOT_FOUND = /^Cannot ([A-Z]+) ([^?]*)\?.*$/s;

/**
 * Nest на неизвестный маршрут бросает 404 с текстом
 * `Cannot <METHOD> <originalUrl>` — вместе с query, где бывают одноразовый
 * OAuth-`code` и секреты вебхуков. `meta.path` фильтры чистят (`safePath`),
 * а этот текст уходил и в ответ, и в warn-строку лога. Отрезаем query;
 * любой другой текст — без изменений.
 */
export function stripRouteNotFoundQuery(message: string): string {
  const m = ROUTE_NOT_FOUND.exec(message);
  return m ? `Cannot ${m[1]} ${m[2]}` : message;
}
