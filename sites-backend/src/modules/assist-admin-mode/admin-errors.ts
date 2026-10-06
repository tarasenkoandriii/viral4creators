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
  | 'CONVERSATION_NOT_FOUND'
  | 'MESSAGE_NOT_FOUND'
  | 'LEARNING_ITEM_NOT_FOUND'
  | 'PRIVATE_CRAWL_INVALID'
  // Э8 «Админка: действия»
  | 'ADMIN_ACTIONS_PLAN'
  | 'OPERATION_CONFIG_INVALID'
  | 'OPERATION_FORBIDDEN'
  | 'PROPOSAL_NOT_FOUND'
  | 'PROPOSAL_EXPIRED'
  | 'PROPOSAL_CHANGED'
  | 'PROPOSAL_DECIDED'
  | 'PROPOSAL_PHRASE'
  | 'PROPOSAL_RISK_ACK'
  | 'ACTION_LIMIT'
  | 'ACTION_AMOUNT_LIMIT'
  | 'ACTION_UNAVAILABLE'
  | 'COMPENSATION_UNAVAILABLE'
  | 'MEMO_NOT_FOUND'
  | 'MEMO_INVALID'
  // Аудит 06.10: сухой прогон мемо «Админки» (§5-бис.17 п.7)
  | 'MEMO_GATES'
  | 'MEMO_CHECK_REQUIRED'
  | 'MEMO_CONFLICT'
  | 'MEMO_LIMIT'
  | 'MEMO_REVISION';

export function adminError(
  status: number,
  code: AdminErrorCode,
  message: string,
): HttpException {
  return new HttpException({ error: code, code, message }, status);
}
