// СГЕНЕРИРОВАНО scripts/sync-sites-shared.mjs — не править.
// Источник: backend/src/common/express-body-default.ts. Правка — в источнике, затем
// `node scripts/sync-sites-shared.mjs`; CI сверяет копию флагом --check.

import type { NextFunction, Request, Response } from 'express';

/**
 * Заход 12 (Р-З12-А2): Express 5 / body-parser 2 больше НЕ кладут `{}` в
 * `req.body`, когда тела нет или его тип не подошёл ни одному парсеру
 * (GET, POST без тела, `text/plain` на JSON-маршрут), — `req.body` остаётся
 * `undefined`. Express 4 (body-parser 1) всегда начинал с
 * `req.body = req.body || {}`.
 *
 * На это опирается больше сотни обработчиков вида `@Body() body: unknown`
 * / `{ x?: unknown }` / `Record<string, unknown>` (ValidationPipe
 * подставляет `{}` только DTO-классам): без тела `body.x` упал бы
 * TypeError → 500 вместо прежних 400/422 из своей проверки. Чтобы
 * обновление не меняло поведение ни одного маршрута, `{}` по умолчанию
 * возвращается здесь — ОДНИМ слоем, первым в стеке express (до helmet,
 * CORS и любых парсеров).
 *
 * Почему до парсеров, а не после: body-parser 2 перезаписывает
 * `req.body` разобранным телом (JSON, строка `text()`, Buffer `raw()`),
 * а «тело уже прочитано» определяет по потоку запроса (`isFinished`), а
 * не по `req.body`, — заранее выставленный `{}` ничего не ломает и ровно
 * повторяет порядок Express 4.
 *
 * Имя функции — своё: Nest пропускает собственный парсер, если в стеке
 * уже есть слой с именем `jsonParser`/`urlencodedParser`.
 */
export function defaultEmptyBody(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  if (req.body === undefined) req.body = {};
  next();
}
