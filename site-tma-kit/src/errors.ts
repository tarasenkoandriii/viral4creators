/**
 * Машинные коды сервера → текст человеку на языке интерфейса.
 *
 * Сервер пишет `error.message` по-русски, а кабинет — на uk/ru/en. Поэтому
 * экраны ветвятся по `error.code` (и `lastCheck.code`), а серверный текст
 * — только запасной путь для кода, которого здесь ещё нет.
 *
 * Списки ниже — зеркало `sites-backend`: `SiteCoreCode`
 * (`site-core.constants.ts`) и `CheckCode` (`ownership-checker.ts`).
 * `assist/scripts/errors.test.ts` читает эти файлы сервера и падает, если
 * там появился код без перевода здесь (и наоборот), а словари обязаны
 * перевести каждый код на все три языка.
 */

import type { Dictionary } from './dictionaries/ru';
import { ApiError } from './envelope';
import type { HostCheck } from './types';

/** Отказы маршрутов ядра (`error.code` конверта). */
export const API_ERROR_CODES = [
  'ACCOUNT_REQUIRED',
  'ACCOUNT_ROLE_REQUIRED',
  'PRODUCT_ROLE_REQUIRED',
  'SITE_NOT_FOUND',
  'HOST_NOT_FOUND',
  'HOST_INVALID',
  'HOST_DUPLICATE',
  'HOST_OPTED_OUT',
  'HOST_BLOCKED',
  'HOST_NOT_VERIFIED',
  'METHOD_NOT_ALLOWED',
  'REVERIFY_BLOCKED',
  'INVITE_INVALID',
  'INVITE_ROLE_INVALID',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** Итоги проверки владения (`lastCheck.code`, `verify().code`). */
export const CHECK_CODES = [
  'VERIFIED',
  'DNS_NOT_FOUND',
  'DNS_RESOLVERS_DISAGREE',
  'DNS_UNAVAILABLE',
  'FILE_NOT_FOUND',
  'TOKEN_MISMATCH',
  'META_NOT_FOUND',
  'HTTP_ERROR',
  'REDIRECT_OTHER_HOST',
  'TOO_MANY_REDIRECTS',
  'BODY_TOO_LARGE',
  'UNSAFE_URL',
  'NETWORK_ERROR',
] as const;
export type CheckCode = (typeof CHECK_CODES)[number];

const isIn = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === 'string' && (list as readonly string[]).includes(v);

/**
 * Текст ошибки для человека. Порядок: известный код ядра → наш перевод;
 * нет связи / 401 / 429 → общий перевод; иначе — текст сервера (он
 * конкретнее «что-то пошло не так»), иначе — общий текст.
 */
export function errorText(e: unknown, dict: Dictionary): string {
  const t = dict.errors;
  if (e instanceof ApiError) {
    if (isIn(API_ERROR_CODES, e.code)) return t.api[e.code];
    if (e.code === 'network') return t.client.network;
    if (e.code === 'no_telegram') return t.client.noIdentity;
    if (e.status === 401 || e.code === 'UNAUTHORIZED') {
      return t.client.unauthorized;
    }
    if (e.status === 429 || e.code === 'RATE_LIMIT_EXCEEDED') {
      return t.client.rateLimited;
    }
    if (e.status >= 500 || e.code === 'bad_response') return t.client.server;
  }
  return e instanceof Error && e.message ? e.message : dict.common.error;
}

/**
 * Итог проверки владения → текст. Неизвестный код — текст сервера, если
 * он есть, иначе общий «не нашли» (честнее, чем молчать о провале).
 */
export function checkText(
  check: Pick<HostCheck, 'ok' | 'code' | 'message'>,
  dict: Dictionary
): string {
  if (isIn(CHECK_CODES, check.code)) return dict.errors.check[check.code];
  if (check.ok) return dict.errors.check.VERIFIED;
  return check.message || dict.verify.notFound;
}
