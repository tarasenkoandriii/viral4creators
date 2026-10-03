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
  // Э3:
  GOAL_ORDER_ID_INVALID: 422,
  PICKER_INVALID: 403,
  EVENT_INVALID: 400,
  // Э5:
  VOICE_UNAVAILABLE: 403,
  VOICE_LIMIT: 429,
  VOICE_NOT_HEARD: 422,
  AUDIO_INVALID: 400,
  // Э6:
  VIDEO_UNAVAILABLE: 404,
  // Э6-бис:
  VOICE_CONTROL_OFF: 403,
  PLAN_EXPIRED: 409,
  PLAN_CONFLICT: 409,
  PLAN_CHANGED: 409,
  UI_PLAN_TOO_LARGE: 413,
  VOICE_TEST_INVALID: 403,
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
  GOAL_ORDER_ID_INVALID: 'Номер заказа похож на контакт — не принят',
  PICKER_INVALID: 'Ссылка выбора цели недействительна или уже использована',
  EVENT_INVALID: 'Неверный пакет событий',
  VOICE_UNAVAILABLE: 'Голос сейчас недоступен — напишите текстом',
  VOICE_LIMIT: 'Голос на сегодня исчерпан — напишите текстом',
  VOICE_NOT_HEARD: 'Не расслышал — повторите или напишите текстом',
  AUDIO_INVALID: 'Запись не подходит — повторите или напишите текстом',
  VIDEO_UNAVAILABLE: 'Видео сейчас недоступно',
  VOICE_CONTROL_OFF: 'Голосовое управление на этом сайте не включено',
  PLAN_EXPIRED: 'Предложение устарело — повторите команду',
  PLAN_CONFLICT: 'План уже изменился — обновите страницу',
  PLAN_CHANGED: 'План изменился — подтвердите заново',
  UI_PLAN_TOO_LARGE: 'Страница слишком большая для голосового управления',
  VOICE_TEST_INVALID:
    'Ссылка проверки недействительна или уже использована — получите новую в кабинете',
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
