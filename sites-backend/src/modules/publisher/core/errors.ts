/**
 * AI Publisher — исключение и фильтр ошибок (P-A1, проектный документ
 * §11.1–11.2).
 *
 * `PubError(code, details)` — HTTP-статус по коду (`contracts/errors.ts`).
 * `PubExceptionFilter` рендерит общий конверт sites-backend
 * (`{success:false, error:{code, message, details?}, meta}`), но:
 *  - `details` — целиком (`fields`, `currentRevision`, `from/to/allowed`,
 *    `gate/missing`, …): общий `HttpExceptionFilter` пропускает наружу
 *    только `reason/retryAfterMs/errors`, а клиентам Publisher нужны
 *    подробности (§11.2) — Р-PUB-A1-2;
 *  - текст — на языке `Accept-Language` (uk/ru/en, умолчание uk);
 *  - `PUB_RATE_LIMITED` ставит `Retry-After` из `details.retryAfterSec`.
 *
 * Фильтр вешается на контроллеры Publisher (`@PubCabinetController`,
 * публичные контроллеры P-B1/P-D — `@UseFilters(PubExceptionFilter)`);
 * прочие исключения (гварды site-core, 404 Nest) остаются общему фильтру.
 */
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import {
  PUB_ERROR_STATUS,
  pubErrorMessage,
  pubLangOf,
  type FieldIssue,
  type PubErrorCode,
  type PubLang,
} from '../contracts/errors';

export class PubError extends HttpException {
  constructor(
    readonly code: PubErrorCode,
    readonly details: Record<string, unknown> = {},
  ) {
    super(
      {
        error: code,
        code,
        message: pubErrorMessage(code, 'uk', details.reason),
        details,
      },
      PUB_ERROR_STATUS[code],
    );
    this.name = 'PubError';
  }

  messageIn(lang: PubLang): string {
    return pubErrorMessage(this.code, lang, this.details.reason);
  }
}

export function pubError(
  code: PubErrorCode,
  details: Record<string, unknown> = {},
): PubError {
  return new PubError(code, details);
}

/** 400 `PUB_VALIDATION {fields}`. */
export function validationError(fields: FieldIssue[]): PubError {
  return new PubError('PUB_VALIDATION', { fields });
}

/** Бросить `PUB_VALIDATION`, если есть ошибки полей. */
export function assertNoIssues(fields: FieldIssue[]): void {
  if (fields.length > 0) throw validationError(fields);
}

export function isPubError(e: unknown, code?: PubErrorCode): e is PubError {
  return e instanceof PubError && (code === undefined || e.code === code);
}

/** Код Publisher из исключения (тесты, логи). */
export function pubCodeOf(e: unknown): PubErrorCode | undefined {
  return e instanceof PubError ? e.code : undefined;
}

/** Заголовок ответов кабинета и ошибок Publisher (§11.3, аудит P3-3). */
export const PUB_NO_STORE = 'private, no-store';

@Catch(PubError)
export class PubExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('PubExceptionFilter');

  catch(e: PubError, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const requestId = randomUUID();
    const status = e.getStatus();
    const lang = pubLangOf(
      req.headers?.['accept-language'] as string | undefined,
    );
    const path = req.path ?? (req.url ?? '').split('?')[0];
    const line = `${req.method} ${path} → ${status} ${e.code} [${requestId}]`;
    if (status >= 500) this.logger.error(line);
    else this.logger.warn(line);
    // Аудит P3-3: ошибки Publisher тоже не кэшируются.
    res.setHeader('Cache-Control', PUB_NO_STORE);
    if (e.code === 'PUB_RATE_LIMITED') {
      const after = Number(e.details.retryAfterSec);
      if (Number.isFinite(after) && after > 0) {
        res.setHeader('Retry-After', String(Math.ceil(after)));
      }
    }
    const hasDetails = Object.keys(e.details).length > 0;
    res.status(status).json({
      success: false,
      error: {
        code: e.code,
        message: e.messageIn(lang),
        ...(hasDetails ? { details: e.details } : {}),
      },
      meta: { timestamp: new Date().toISOString(), requestId, path },
    });
  }
}
