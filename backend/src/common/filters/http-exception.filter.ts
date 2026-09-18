/**
 * HttpExceptionFilter — единый формат ошибок API.
 *
 * ## Что уходит клиенту, а что остаётся в логе (этап 54, Б-3.6)
 *
 * До этого этапа сообщение ЛЮБОГО исключения уходило наружу как есть:
 * `exception.message` от Prisma («connect ECONNREFUSED 10.0.0.5:6543»),
 * от драйвера, от `fetch`, от `TypeError` в нашем коде. Стек не уходил,
 * но и без него текст ошибки — разведка: адреса внутренних сервисов,
 * имена таблиц, версии библиотек.
 *
 * Правило теперь простое. **`HttpException` — это то, что мы сказали
 * сами** (валидация, 404, 409 «уже идёт», лимиты): текст написан для
 * пользователя и уходит без изменений. **Всё остальное — авария**, и
 * клиент получает одну и ту же фразу плюс `requestId`; сам текст, стек,
 * путь и метод — в лог с тем же `requestId`, чтобы по жалобе «вот код»
 * найти запись за секунды. Сообщение даже не пытается быть полезным для
 * пользователя: у него всё равно нет способа что-то с ним сделать, а
 * фронтенд с этапа 48 подставляет свои русские тексты по статусу.
 */

import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { localeFromRequest, SupportedLocale } from '../locale';

/**
 * Поля, которые исключение может передать клиенту ПОМИМО текста. Раньше
 * фильтр оставлял из объекта только `message`, и структурный ответ (429
 * скетча с `quota`/`upgrade`) терялся по дороге — аудит A-2. Пробрасываем
 * не всё подряд, а явный список: остальное могло бы утечь наружу.
 */
const PASSTHROUGH_KEYS = [
  'quota',
  'upgrade',
  'reason',
  'retryAfterMs',
] as const;

function detailsOf(
  responseObj: Record<string, unknown>,
): Record<string, unknown> | null {
  const details: Record<string, unknown> = {};
  for (const key of PASSTHROUGH_KEYS) {
    if (responseObj[key] !== undefined) details[key] = responseObj[key];
  }
  return Object.keys(details).length > 0 ? details : null;
}

interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    /** Машиночитаемые подробности ответа (см. `PASSTHROUGH_KEYS`). */
    details?: Record<string, unknown>;
  };
  meta: {
    timestamp: string;
    requestId: string;
    path?: string;
  };
}

/**
 * Общий текст ошибки 500 — конверт остаётся русским по умолчанию (locale
 * не распознана — нет заголовка `Accept-Language`, старый клиент), но
 * теперь читает локаль запроса (аудит 2026-09-08, Г-5.2): раньше эта
 * фраза уходила по-русски ЛЮБОМУ клиенту независимо от локали интерфейса
 * — единственный текст в ответе, который пользователь реально видит,
 * когда сервер сломался у него на глазах.
 */
const INTERNAL_ERROR_MESSAGE_BY_LOCALE: Readonly<
  Record<SupportedLocale, string>
> = {
  ru: 'Внутренняя ошибка сервера. Если она повторяется, сообщите код обращения из ответа.',
  uk: 'Внутрішня помилка сервера. Якщо вона повторюється, повідомте код звернення з відповіді.',
  en: 'Internal server error. If it keeps happening, report the request code from this response.',
  de: 'Interner Serverfehler. Falls das wiederholt auftritt, teilen Sie bitte den Anfrage-Code aus dieser Antwort mit.',
  es: 'Error interno del servidor. Si se repite, informe el código de solicitud de esta respuesta.',
};

export const INTERNAL_ERROR_MESSAGE = INTERNAL_ERROR_MESSAGE_BY_LOCALE.ru;

export function internalErrorMessage(locale: SupportedLocale): string {
  return INTERNAL_ERROR_MESSAGE_BY_LOCALE[locale];
}

/**
 * М-4.3 седьмого аудита: путь без query-строки — в ней живут секрет
 * вебхука Resemble (`?secret=`, по проектному решению) и одноразовый
 * OAuth-`code`; полный `request.url` уходил и в лог, и в `meta.path`.
 */
function safePath(request: { url?: string; path?: string }): string {
  if (request.path) return request.path;
  const url = request.url ?? '';
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = uuidv4();
    const locale = localeFromRequest(request);

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let errorCode = 'INTERNAL_SERVER_ERROR';
    let errorMessage = internalErrorMessage(locale);
    let errorDetails: Record<string, unknown> | null = null;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'string') {
        errorMessage = exceptionResponse;
      } else if (typeof exceptionResponse === 'object') {
        const responseObj = exceptionResponse as Record<string, unknown>;
        errorMessage = messageOf(responseObj.message) || errorMessage;
        errorCode =
          (responseObj.error as string) || this.getErrorCodeFromStatus(status);
        errorDetails = detailsOf(responseObj);
      }
      // 4xx — ожидаемые ответы, им хватает warn; 5xx, брошенные нами
      // намеренно, — всё равно авария.
      const line = `${request.method} ${safePath(request)} → ${status} ${errorCode}: ${errorMessage} [${requestId}]`;
      if (status >= 500) this.logger.error(line, stackOf(exception));
      else this.logger.warn(line);
    } else {
      // Не наше исключение: подробности — только в лог.
      const detail =
        exception instanceof Error
          ? `${exception.name}: ${exception.message}`
          : String(exception);
      this.logger.error(
        `${request.method} ${safePath(request)} → 500 ${detail} [${requestId}]`,
        stackOf(exception),
      );
    }

    const errorResponse: ErrorResponse = {
      success: false,
      error: {
        code: errorCode,
        message: errorMessage,
        ...(errorDetails ? { details: errorDetails } : {}),
      },
      meta: {
        timestamp: new Date().toISOString(),
        requestId,
        path: safePath(request),
      },
    };

    response.status(status).json(errorResponse);
  }

  private getErrorCodeFromStatus(status: number): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return 'BAD_REQUEST';
      case HttpStatus.UNAUTHORIZED:
        return 'UNAUTHORIZED';
      case HttpStatus.FORBIDDEN:
        return 'FORBIDDEN';
      case HttpStatus.NOT_FOUND:
        return 'NOT_FOUND';
      case HttpStatus.CONFLICT:
        return 'CONFLICT';
      case HttpStatus.UNPROCESSABLE_ENTITY:
        return 'VALIDATION_ERROR';
      case HttpStatus.TOO_MANY_REQUESTS:
        return 'RATE_LIMIT_EXCEEDED';
      case HttpStatus.SERVICE_UNAVAILABLE:
        return 'SERVICE_UNAVAILABLE';
      case HttpStatus.INTERNAL_SERVER_ERROR:
      default:
        return 'INTERNAL_SERVER_ERROR';
    }
  }
}

/** `ValidationPipe` кладёт в `message` массив строк — склеиваем. */
function messageOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(String).join('; ');
  return undefined;
}

function stackOf(exception: unknown): string | undefined {
  return exception instanceof Error ? exception.stack : undefined;
}
