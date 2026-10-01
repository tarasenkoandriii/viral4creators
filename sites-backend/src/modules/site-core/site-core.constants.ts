/**
 * Числа и коды ядра site-core в одном месте (ТЗ помощника §3.3, QA-ТЗ
 * §1.5, §2.4, §5.1). Меняются только вместе с обоими ТЗ: подтверждение
 * одно на два продукта, и «90 дней» в QA не может значить другое, чем в
 * помощнике.
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';

/** Подтверждение действует 90 дней, затем повтор (QA §2.4). */
export const OWNERSHIP_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Льгота виджета помощника после `revoked`/`expired` — 72 ч (ТЗ помощника
 * §3.3, В-14). Свойство ТОЛЬКО `purpose = 'assist-widget'`, не статуса.
 */
export const WIDGET_GRACE_MS = 72 * 60 * 60 * 1000;

/** Потолок тела файла/меты при проверке владения (QA §5.1). */
export const VERIFY_BODY_LIMIT_BYTES = 64 * 1024;

/** Таймаут одной исходящей проверки (QA §5.1: ≤ 10 с). */
export const VERIFY_TIMEOUT_MS = 10_000;

/**
 * Сколько редиректов В ПРЕДЕЛАХ ТОГО ЖЕ хоста терпим (`/` → `/uk/`).
 * Редирект на другой хост — отказ сразу, без счёта.
 */
export const VERIFY_MAX_SAME_HOST_REDIRECTS = 3;

/** Подсказка поддоменов: сколько читаем главной и сколько отдаём. */
export const SUGGEST_BODY_LIMIT_BYTES = 256 * 1024;
export const SUGGEST_MAX_HOSTS = 20;

/** Приглашение участника: одноразовое, 7 дней (ТЗ помощника §3.2). */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Крон перепроверки: сколько хостов за прогон и сколько параллельно. */
export const RECHECK_BATCH = 200;
export const RECHECK_CONCURRENCY = 5;
/** Запас до `maxDuration` функции Vercel: остальное — завтра. */
export const RECHECK_TIME_BUDGET_MS = 45_000;

export const HOST_STATUSES = [
  'pending',
  'verified',
  'expired',
  'revoked',
] as const;
export type HostStatus = (typeof HOST_STATUSES)[number];

export const VERIFY_METHODS = ['dns', 'file', 'meta'] as const;
export type VerifyMethod = (typeof VERIFY_METHODS)[number];

/**
 * Машинные коды отказов и итогов проверки: TMA ветвится по ним, а не по
 * тексту (site-tma-kit/src/envelope.ts читает `error.code`).
 */
export type SiteCoreCode =
  | 'ACCOUNT_REQUIRED'
  | 'ACCOUNT_ROLE_REQUIRED'
  | 'PRODUCT_ROLE_REQUIRED'
  | 'SITE_NOT_FOUND'
  | 'HOST_NOT_FOUND'
  | 'HOST_INVALID'
  | 'HOST_DUPLICATE'
  | 'HOST_OPTED_OUT'
  | 'HOST_BLOCKED'
  | 'HOST_NOT_VERIFIED'
  | 'METHOD_NOT_ALLOWED'
  | 'REVERIFY_BLOCKED'
  | 'INVITE_INVALID'
  | 'INVITE_ROLE_INVALID';

type ExceptionCtor = new (body: Record<string, unknown>) => HttpException;

/**
 * Исключение с машинным кодом. `error` — чтобы фильтр поставил код в
 * `error.code` конверта (его читает TMA), `code` — чтобы он же попал в
 * `error.details.code` (как в app.setup.spec.ts).
 */
export function siteCoreError(
  Ctor: ExceptionCtor,
  code: SiteCoreCode,
  message: string,
): HttpException {
  return new Ctor({ error: code, code, message });
}

export const notFoundSite = () =>
  siteCoreError(NotFoundException, 'SITE_NOT_FOUND', 'Сайт не найден');
export const notFoundHost = () =>
  siteCoreError(NotFoundException, 'HOST_NOT_FOUND', 'Хост не найден');
export const badHost = (message: string) =>
  siteCoreError(BadRequestException, 'HOST_INVALID', message);
export const duplicateHost = () =>
  siteCoreError(
    ConflictException,
    'HOST_DUPLICATE',
    'Этот хост уже есть в кабинете — откройте существующий',
  );
export const forbidden = (code: SiteCoreCode, message: string) =>
  siteCoreError(ForbiddenException, code, message);
