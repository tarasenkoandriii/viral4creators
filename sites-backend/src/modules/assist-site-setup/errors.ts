/**
 * Машинные коды кабинета виджета Э2 (контракт Э2 §6 «Коды ошибок»): TMA
 * ветвится по `error.code`, а не по тексту. Форма исключения та же, что у
 * Э1 (`e1Error`): `{ error: CODE, code: CODE, message }` — фильтр
 * приложения кладёт код в `error.code` и `error.details.code`.
 *
 * `errors[]` (путь + код поля) кладётся в тело под ключом `errors` —
 * контракт: «WIDGET_CONFIG_INVALID (details — errors[])». Фильтр
 * приложения пропускает наружу только ключи из PASSTHROUGH_KEYS — `errors`
 * туда добавляет координатор (запрос в отчёте W4); до этого TMA показывает
 * общий текст по коду.
 *
 * Сверх списка контракта: `BAD_REQUEST` (тело не той формы — как у
 * публичных маршрутов), `ASSET_TYPE` с `reason: 'dimensions'` (аватар не
 * квадрат ≥ 128 px), `VERSION_CONFLICT` (409: 5 гонок публикации подряд).
 */
import { HttpException, HttpStatus } from '@nestjs/common';

export type SetupCode =
  | 'BAD_REQUEST'
  | 'WIDGET_CONFIG_INVALID'
  | 'PERSONA_INVALID'
  | 'LEADS_CONFIG_INVALID'
  | 'HOST_NOT_VERIFIED'
  | 'WIDGET_NOT_PUBLISHED'
  | 'VERSION_NOT_FOUND'
  | 'ASSET_TYPE'
  | 'ASSET_TOO_LARGE'
  | 'PERSONA_GATE_FAILED'
  | 'KEYS_MISSING'
  | 'VERSION_CONFLICT';

export interface FieldError {
  path: string;
  code: string;
}

export function setupError(
  status: HttpStatus,
  code: SetupCode,
  message: string,
  extra: { errors?: FieldError[]; reason?: string } = {},
): HttpException {
  return new HttpException({ error: code, code, message, ...extra }, status);
}

/** Код из исключения (тесты). */
export function setupCodeOf(e: unknown): string | undefined {
  if (!(e instanceof HttpException)) return undefined;
  const body = e.getResponse();
  return body && typeof body === 'object'
    ? ((body as { code?: unknown }).code as string | undefined)
    : undefined;
}
