/**
 * HttpExceptionFilter — единый формат ошибок, тот же конверт, что у backend
 * (backend/src/common/filters/http-exception.filter.ts — там история):
 *
 *   { success: false, error: { code, message, details? }, meta: { timestamp, requestId, path } }
 *
 * Правило то же: `HttpException` — это то, что мы сказали сами, текст
 * уходит пользователю как есть (по-русски); всё остальное — авария, клиент
 * получает одну фразу и `requestId`, подробности — только в лог.
 *
 * Отличие от backend: нет локализации по `Accept-Language` — у backend она
 * держится на его модуле `locale`, которого здесь нет; TMA подставляет свои
 * тексты по `error.code`/статусу. Копировать фильтр через
 * sync-sites-shared нельзя по той же причине (импорт `../locale`).
 */

import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  bodyParserMessage,
  bodyParserStatus,
  stripRouteNotFoundQuery,
} from '../../shared/http-error-helpers';

/** Ответы-ошибки без своего заголовка кэша (Н-D1-1). */
export const ERROR_CACHE_CONTROL = 'private, no-store';

export const INTERNAL_ERROR_MESSAGE =
  'Внутренняя ошибка сервера. Если она повторяется, сообщите код обращения из ответа.';

/**
 * Поля, которые исключение может передать клиенту помимо текста, — явным
 * списком, чтобы наружу не утекло ничего случайного. `errors` — построчные
 * ошибки полей кабинета Э2 (`WIDGET_CONFIG_INVALID` и др.: `{ path, code }[]`,
 * контракт Э2 §6 «details — errors[]»): их кладёт только `setupError`.
 */
const PASSTHROUGH_KEYS = ['reason', 'retryAfterMs', 'errors'] as const;

/** Машинный код отказа (`{ code: 'HOST_DUPLICATE', message }`). */
const MACHINE_CODE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
/**
 * Код в поле `error` — только UPPER_SNAKE: Nest кладёт туда фразу статуса
 * («Forbidden», «Conflict»), и её нельзя принять за код (клиент ветвится по
 * `FORBIDDEN`, а не по «Forbidden»).
 */
const ERROR_FIELD_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

export function detailsOf(
  responseObj: Record<string, unknown>,
): Record<string, unknown> | null {
  const details: Record<string, unknown> = {};
  for (const key of PASSTHROUGH_KEYS) {
    if (responseObj[key] !== undefined) details[key] = responseObj[key];
  }
  const code = responseObj.code;
  if (typeof code === 'string' && MACHINE_CODE.test(code)) {
    details.code = code;
  }
  return Object.keys(details).length > 0 ? details : null;
}

export interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  meta: {
    timestamp: string;
    requestId: string;
    path?: string;
  };
}

/** Путь без query-строки: в ней бывают секреты и одноразовые коды. */
export function safePath(request: { url?: string; path?: string }): string {
  if (request.path) return request.path;
  const url = request.url ?? '';
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

/**
 * Код по статусу — для каждого 4xx/5xx, который бросает Nest или наш код.
 * Внутренний аудит 19.10 (IA-D1-01 = IA-C-03): без 405 штатный отказ метода
 * (`GET` раскрытия контакта) уходил с кодом `INTERNAL_SERVER_ERROR` — клиент
 * и мониторинг видели «сбой сервера». Р-IA-FXC-1: все 4xx перечислены явно;
 * незнакомый 4xx — `CLIENT_ERROR` (отказ клиента, не авария), незнакомый
 * 5xx — `INTERNAL_SERVER_ERROR`. Прежние коды (422 → `VALIDATION_ERROR`,
 * 429 → `RATE_LIMIT_EXCEEDED`) не меняются: по ним ветвятся клиенты.
 */
const CODE_BY_STATUS: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'BAD_REQUEST',
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHORIZED',
  [HttpStatus.PAYMENT_REQUIRED]: 'PAYMENT_REQUIRED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.METHOD_NOT_ALLOWED]: 'METHOD_NOT_ALLOWED',
  [HttpStatus.NOT_ACCEPTABLE]: 'NOT_ACCEPTABLE',
  [HttpStatus.PROXY_AUTHENTICATION_REQUIRED]: 'PROXY_AUTHENTICATION_REQUIRED',
  [HttpStatus.REQUEST_TIMEOUT]: 'REQUEST_TIMEOUT',
  [HttpStatus.CONFLICT]: 'CONFLICT',
  [HttpStatus.GONE]: 'GONE',
  [HttpStatus.LENGTH_REQUIRED]: 'LENGTH_REQUIRED',
  [HttpStatus.PRECONDITION_FAILED]: 'PRECONDITION_FAILED',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'PAYLOAD_TOO_LARGE',
  [HttpStatus.URI_TOO_LONG]: 'URI_TOO_LONG',
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: 'UNSUPPORTED_MEDIA_TYPE',
  [HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE]: 'RANGE_NOT_SATISFIABLE',
  [HttpStatus.EXPECTATION_FAILED]: 'EXPECTATION_FAILED',
  [HttpStatus.I_AM_A_TEAPOT]: 'I_AM_A_TEAPOT',
  [HttpStatus.MISDIRECTED]: 'MISDIRECTED_REQUEST',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'VALIDATION_ERROR',
  [HttpStatus.LOCKED]: 'LOCKED',
  [HttpStatus.FAILED_DEPENDENCY]: 'FAILED_DEPENDENCY',
  [HttpStatus.PRECONDITION_REQUIRED]: 'PRECONDITION_REQUIRED',
  [HttpStatus.TOO_MANY_REQUESTS]: 'RATE_LIMIT_EXCEEDED',
  431: 'REQUEST_HEADER_FIELDS_TOO_LARGE',
  451: 'UNAVAILABLE_FOR_LEGAL_REASONS',
  [HttpStatus.NOT_IMPLEMENTED]: 'NOT_IMPLEMENTED',
  [HttpStatus.BAD_GATEWAY]: 'BAD_GATEWAY',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'SERVICE_UNAVAILABLE',
  [HttpStatus.GATEWAY_TIMEOUT]: 'GATEWAY_TIMEOUT',
};

export function codeFromStatus(status: number): string {
  const known = CODE_BY_STATUS[status];
  if (known) return known;
  return status >= 400 && status < 500
    ? 'CLIENT_ERROR'
    : 'INTERNAL_SERVER_ERROR';
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

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = uuidv4();

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let errorCode = 'INTERNAL_SERVER_ERROR';
    let errorMessage = INTERNAL_ERROR_MESSAGE;
    let errorDetails: Record<string, unknown> | null = null;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      errorCode = codeFromStatus(status);
      const body = exception.getResponse();
      if (typeof body === 'string') {
        errorMessage = body;
      } else if (body && typeof body === 'object') {
        const obj = body as Record<string, unknown>;
        errorMessage = messageOf(obj.message) || errorMessage;
        // Nest кладёт в `error` фразу статуса («Bad Request») — это не
        // код. Своё `error` берём, только если оно похоже на машинный
        // идентификатор; иначе код — по статусу (у backend здесь
        // оседает фраза, и клиент ветвится по тексту — не повторяем).
        if (typeof obj.error === 'string' && ERROR_FIELD_CODE.test(obj.error)) {
          errorCode = obj.error;
        }
        errorDetails = detailsOf(obj);
      }
      // Заход 12 (аудит P3-4): 404 Nest «Cannot GET /x?code=…» — без query.
      errorMessage = stripRouteNotFoundQuery(errorMessage);
      const line = `${request.method} ${safePath(request)} → ${status} ${errorCode}: ${errorMessage} [${requestId}]`;
      if (status >= 500) this.logger.error(line, stackOf(exception));
      else this.logger.warn(line);
    } else if (bodyParserStatus(exception) !== null) {
      status = bodyParserStatus(exception) as number;
      errorCode = codeFromStatus(status);
      errorMessage = bodyParserMessage(status);
      this.logger.warn(
        `${request.method} ${safePath(request)} → ${status} ${errorCode} [${requestId}]`,
      );
    } else {
      // Не наше исключение: текст драйвера/провайдера — только в лог.
      const detail =
        exception instanceof Error
          ? `${exception.name}: ${exception.message}`
          : String(exception);
      this.logger.error(
        `${request.method} ${safePath(request)} → 500 ${detail} [${requestId}]`,
        stackOf(exception),
      );
    }

    const payload: ErrorResponse = {
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

    // Н-D1-1 (внутренний аудит 19.10): ответ-ошибка не кэшируется. 401
    // глобального входа приходит раньше гвардов маршрута (`PubNoStoreGuard`
    // кабинета Publisher), поэтому заголовок ставит фильтр; уже заданный
    // маршрутом заголовок не трогаем.
    if (
      typeof response.getHeader === 'function' &&
      !response.headersSent &&
      response.getHeader('Cache-Control') === undefined
    ) {
      response.setHeader('Cache-Control', ERROR_CACHE_CONTROL);
    }
    response.status(status).json(payload);
  }
}
