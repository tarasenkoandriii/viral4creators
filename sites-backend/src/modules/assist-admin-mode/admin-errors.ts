/**
 * Отказы «Админки» с машинным кодом (TMA и iframe `wa.` ветвятся по
 * `error.code`, как у site-core). Текст — человеческий, без деталей
 * секретов, JWT и тел ответов API.
 */
import { HttpException } from '@nestjs/common';

export type AdminErrorCode =
  | 'ADMIN_MODE_OFF'
  | 'ADMIN_PLAN_REQUIRED'
  | 'ADMIN_SITE_NOT_VERIFIED'
  | 'ADMIN_HOST_INVALID'
  | 'ADMIN_ACCESS_INVALID'
  | 'ADMIN_ROLEMAP_INVALID'
  | 'ADMIN_IDENTITY_NOT_SET'
  | 'ADMIN_IDENTITY_REJECTED'
  | 'ADMIN_SESSION_INVALID'
  | 'ADMIN_SECRETS_UNAVAILABLE'
  | 'ADMIN_LIMIT'
  | 'ADMIN_DAILY_BUDGET'
  | 'ADMIN_RATE_LIMITED'
  | 'CONNECTOR_NOT_FOUND'
  | 'CONNECTOR_SPEC_INVALID'
  | 'CONNECTOR_SPEC_UNREACHABLE'
  | 'CONNECTOR_HOST_NOT_ALLOWED'
  | 'OPERATION_NOT_FOUND'
  | 'OPERATION_KIND_LOWER'
  | 'OPERATION_UNSUPPORTED'
  | 'ADMIN_ACTIONS_NEXT_STAGE'
  | 'CONVERSATION_NOT_FOUND'
  | 'MESSAGE_NOT_FOUND'
  | 'LEARNING_ITEM_NOT_FOUND'
  | 'PRIVATE_CRAWL_INVALID';

export function adminError(
  status: number,
  code: AdminErrorCode,
  message: string,
): HttpException {
  return new HttpException({ error: code, code, message }, status);
}
