/**
 * Ошибки публичного API виджета (контракт Э2 §6): REST-конверт
 * `{ success:false, error:{ code UPPER_SNAKE, message, details? } }` строит
 * общий HttpExceptionFilter — здесь только код, статус и короткая фраза.
 *
 * В текст ошибки НИКОГДА не попадают вопрос, поля лида, токены и origin
 * посетителя: фильтр пишет `message` в лог (§6.6, приёмка Э2 п.6).
 */
import { HttpException } from '@nestjs/common';
import type { WidgetErrorCode } from './api-types';

export const WIDGET_ERROR_STATUS: Record<WidgetErrorCode, number> = {
  ORIGIN_DENIED: 403,
  WIDGET_UNKNOWN_KEY: 404,
  WIDGET_DISABLED: 403,
  SESSION_REQUIRED: 401,
  SESSION_EXPIRED: 401,
  RATE_LIMITED: 429,
  QUESTION_TOO_LONG: 400,
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  PREVIEW_INVALID: 403,
  LEAD_INVALID: 400,
  CONSENT_REQUIRED: 400,
  SITE_QUOTA: 429,
  PLATFORM_BUDGET: 503,
  UPSTREAM: 502,
};

const MESSAGE: Record<WidgetErrorCode, string> = {
  ORIGIN_DENIED: 'Помощник не работает на этом сайте',
  WIDGET_UNKNOWN_KEY: 'Неизвестный ключ виджета',
  WIDGET_DISABLED: 'Виджет выключен',
  SESSION_REQUIRED: 'Нужна сессия виджета',
  SESSION_EXPIRED: 'Сессия виджета истекла',
  RATE_LIMITED: 'Слишком много запросов — попробуйте чуть позже',
  QUESTION_TOO_LONG: 'Вопрос слишком длинный',
  BAD_REQUEST: 'Неверный запрос',
  NOT_FOUND: 'Не найдено',
  PREVIEW_INVALID: 'Ссылка предпросмотра недействительна или уже использована',
  LEAD_INVALID: 'Проверьте поля заявки',
  CONSENT_REQUIRED: 'Нужно согласие на обработку контактов',
  SITE_QUOTA: 'Помощник сейчас не отвечает — оставьте заявку',
  PLATFORM_BUDGET: 'Помощник сейчас не отвечает — оставьте заявку',
  UPSTREAM: 'Ответ прервался — повторите вопрос',
};

export function widgetError(
  code: WidgetErrorCode,
  extra: { message?: string; retryAfterMs?: number } = {},
): HttpException {
  return new HttpException(
    {
      error: code,
      message: extra.message ?? MESSAGE[code],
      ...(extra.retryAfterMs !== undefined
        ? { retryAfterMs: extra.retryAfterMs }
        : {}),
    },
    WIDGET_ERROR_STATUS[code],
  );
}
