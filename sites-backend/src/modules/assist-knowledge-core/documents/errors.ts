/**
 * Машинные коды отказов Э1 (контракт Э1 §«REST»): TMA и лендинг ветвятся
 * по `error.code`, а не по тексту (как site-core: `siteCoreError`).
 * Форма исключения та же — `{ error: CODE, code: CODE, message }`, поэтому
 * фильтр приложения кладёт код и в `error.code`, и в `error.details.code`.
 *
 * Сверх списка контракта (запись в отчёте K3): `SANDBOX_LIMIT_ACCOUNT`
 * (суточный лимит песочниц кабинета), `SANDBOX_LIMIT_DOMAIN` (обходы домена
 * исчерпаны и кэша нет), `SANDBOX_NOT_FOUND`, `SANDBOX_NOT_READY`,
 * `SANDBOX_TRANSFERRED`, `ANSWER_UNAVAILABLE`, `DOCUMENT_NOT_UPLOADED`, `PUBLIC_CONFIRM_REQUIRED`, `SOURCE_NOT_FOUND`,
 * `SOURCE_READONLY`, `FAQ_NOT_FOUND`, `EXCLUSION_NOT_FOUND`,
 * `EXCLUSION_DUPLICATE`, `EXCLUSION_INVALID`, `VERSION_NOT_FOUND`,
 * `CHUNK_NOT_FOUND`, `ASSIST_NOT_ENABLED`, `ORIGIN_FORBIDDEN`, `URL_INVALID`.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  HttpException,
  HttpStatus,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

export type E1Code =
  | 'URL_REJECTED'
  | 'URL_INVALID'
  | 'OPTED_OUT'
  | 'BLOCKED_CATEGORY'
  | 'SANDBOX_DISABLED'
  | 'SANDBOX_LIMIT_IP'
  | 'SANDBOX_LIMIT_ACCOUNT'
  | 'SANDBOX_LIMIT_DOMAIN'
  | 'SANDBOX_BUDGET'
  | 'SANDBOX_QUESTIONS_EXHAUSTED'
  | 'SANDBOX_EXPIRED'
  | 'SANDBOX_NOT_FOUND'
  | 'SANDBOX_NOT_READY'
  | 'SANDBOX_TRANSFERRED'
  | 'ANSWER_UNAVAILABLE'
  | 'ORIGIN_FORBIDDEN'
  | 'HOST_NOT_VERIFIED'
  /**
   * Р-З9-24: подтверждённые хосты есть, но все отданы «Админке» — обходить
   * для «Сайта» нечего (не «подтвердите хост», а «добавьте хост сайта»).
   */
  | 'HOST_ADMIN_ONLY'
  /** Р-З9-24: адрес url-источника — на хосте другого режима (хост «Админки»). */
  | 'URL_ADMIN_HOST'
  | 'ASSIST_NOT_ENABLED'
  | 'KNOWLEDGE_SOURCE_LIMIT'
  | 'SOURCE_NOT_FOUND'
  | 'SOURCE_READONLY'
  | 'DOCUMENT_TOO_LARGE'
  | 'DOCUMENT_TYPE'
  | 'DOCUMENT_NO_TEXT'
  | 'DOCUMENT_NOT_UPLOADED'
  | 'PUBLIC_CONFIRM_REQUIRED'
  | 'FAQ_NOT_FOUND'
  | 'EXCLUSION_NOT_FOUND'
  | 'EXCLUSION_DUPLICATE'
  | 'EXCLUSION_INVALID'
  | 'VERSION_NOT_FOUND'
  | 'VERSION_NOT_ROLLBACKABLE'
  | 'VERSION_NOT_HELD'
  | 'CHUNK_NOT_FOUND'
  | 'HOT_PAGES_LIMIT'
  | 'LEARNING_BUDGET_EXHAUSTED';

/** 429 у Nest нет отдельного класса — свой, с тем же телом. */
class TooManyRequests extends HttpException {
  constructor(body: Record<string, unknown>) {
    super(body, HttpStatus.TOO_MANY_REQUESTS);
  }
}

const CTOR = {
  400: BadRequestException,
  403: ForbiddenException,
  404: NotFoundException,
  409: ConflictException,
  410: GoneException,
  429: TooManyRequests,
  503: ServiceUnavailableException,
} as const;

export type E1Status = keyof typeof CTOR;

export function e1Error(
  status: E1Status,
  code: E1Code,
  message: string,
): HttpException {
  const Ctor = CTOR[status];
  return new Ctor({ error: code, code, message });
}

/** Код из исключения (для тестов и для перевода ошибок в статус источника). */
export function e1CodeOf(e: unknown): string | undefined {
  if (!(e instanceof HttpException)) return undefined;
  const body = e.getResponse();
  return body && typeof body === 'object'
    ? ((body as { code?: unknown }).code as string | undefined)
    : undefined;
}
