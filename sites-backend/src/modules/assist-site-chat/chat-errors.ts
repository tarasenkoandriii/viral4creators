/**
 * Коды отказов REST Э2, которые бросает W3 (контракт §6: UPPER_SNAKE в
 * конверте). Форма исключения — как e1Error/siteCoreError
 * (`{ error, code, message }`): фильтр приложения кладёт код в
 * `error.code`, маршрут W2 пробрасывает исключение как есть.
 *
 * Интеграция Э2: статус выводится ИЗ КОДА — один код = один статус во всём
 * публичном API (таблица совпадает с `assist-widget/widget-errors.ts`,
 * сверяет `chat-errors.spec.ts`). `WIDGET_DISABLED` — 403, как у гварда и
 * сессии W2: «виджет не обслуживает этот запрос» — клиент показывает форму
 * лида и НЕ повторяет запрос; 503 звал бы повторы, а нехватку
 * `ASSIST_SECRETS_KEY` видно по `logger.error`, а не по статусу посетителю.
 * Подробности (`errors[]` полей лида) — на верхнем уровне тела: фильтр
 * пропускает наружу только ключи из своего списка, вложенный `details` он
 * бы отбросил.
 */
import { HttpException } from '@nestjs/common';

export type SiteChatErrorCode =
  'LEAD_INVALID' | 'CONSENT_REQUIRED' | 'WIDGET_DISABLED' | 'BAD_REQUEST';

export const SITE_CHAT_ERROR_STATUS: Record<SiteChatErrorCode, number> = {
  LEAD_INVALID: 400,
  CONSENT_REQUIRED: 400,
  WIDGET_DISABLED: 403,
  BAD_REQUEST: 400,
};

export function chatError(
  code: SiteChatErrorCode,
  message: string,
  details?: { errors?: unknown[] },
): HttpException {
  return new HttpException(
    { error: code, code, message, ...(details ?? {}) },
    SITE_CHAT_ERROR_STATUS[code],
  );
}

export function chatErrorCode(e: unknown): string | undefined {
  if (!(e instanceof HttpException)) return undefined;
  const body = e.getResponse();
  return body && typeof body === 'object'
    ? ((body as { code?: unknown }).code as string | undefined)
    : undefined;
}
