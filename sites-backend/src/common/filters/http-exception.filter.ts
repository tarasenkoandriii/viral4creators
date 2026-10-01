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

export const INTERNAL_ERROR_MESSAGE =
  'Внутренняя ошибка сервера. Если она повторяется, сообщите код обращения из ответа.';

/**
 * Поля, которые исключение может передать клиенту помимо текста, — явным
 * списком, чтобы наружу не утекло ничего случайного.
 */
const PASSTHROUGH_KEYS = ['reason', 'retryAfterMs'] as const;

/** Машинный код отказа (`{ code: 'HOST_DUPLICATE', message }`). */
const MACHINE_CODE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

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

const CODE_BY_STATUS: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'BAD_REQUEST',
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHORIZED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.CONFLICT]: 'CONFLICT',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'VALIDATION_ERROR',
  [HttpStatus.TOO_MANY_REQUESTS]: 'RATE_LIMIT_EXCEEDED',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'SERVICE_UNAVAILABLE',
};

function codeFromStatus(status: number): string {
  return CODE_BY_STATUS[status] ?? 'INTERNAL_SERVER_ERROR';
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
        if (typeof obj.error === 'string' && MACHINE_CODE.test(obj.error)) {
          errorCode = obj.error;
        }
        errorDetails = detailsOf(obj);
      }
      const line = `${request.method} ${safePath(request)} → ${status} ${errorCode}: ${errorMessage} [${requestId}]`;
      if (status >= 500) this.logger.error(line, stackOf(exception));
      else this.logger.warn(line);
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

    response.status(status).json(payload);
  }
}
