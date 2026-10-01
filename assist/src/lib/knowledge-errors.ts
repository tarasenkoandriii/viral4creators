/**
 * Коды ошибок Э1 (контракт Э1 §6, «Коды ошибок Э1») → текст на языке
 * интерфейса. Коды ядра (`HOST_NOT_VERIFIED`, `PRODUCT_ROLE_REQUIRED`…)
 * переводит кит (`kit/errors.ts`) — здесь только коды помощника.
 *
 * `scripts/knowledge-errors.test.ts` проверяет: каждый код переведён на
 * uk/ru/en, и каждый UPPER_SNAKE-код, который бросают модули знаний и
 * песочницы в `sites-backend`, есть либо здесь, либо в ките.
 */

import { ApiError, errorText, type Dictionary } from '../kit';
import type { AppDictionary } from '../i18n';

export const KNOWLEDGE_ERROR_CODES = [
  // Список контракта Э1 §6.
  'URL_REJECTED',
  'OPTED_OUT',
  'BLOCKED_CATEGORY',
  'SANDBOX_DISABLED',
  'SANDBOX_LIMIT_IP',
  'SANDBOX_BUDGET',
  'SANDBOX_QUESTIONS_EXHAUSTED',
  'SANDBOX_EXPIRED',
  'KNOWLEDGE_SOURCE_LIMIT',
  'DOCUMENT_TOO_LARGE',
  'DOCUMENT_TYPE',
  'DOCUMENT_NO_TEXT',
  'VERSION_NOT_ROLLBACKABLE',
  'VERSION_NOT_HELD',
  'HOT_PAGES_LIMIT',
  'LEARNING_BUDGET_EXHAUSTED',
  // Сверх контракта — добавили K3 (`documents/errors.ts`, E1Code) и K2
  // (`KNOWLEDGE_BUSY` в indexer.ts); тест сверяет с их файлами.
  'URL_INVALID',
  'SANDBOX_LIMIT_ACCOUNT',
  'SANDBOX_LIMIT_DOMAIN',
  'SANDBOX_NOT_FOUND',
  'SANDBOX_NOT_READY',
  'SANDBOX_TRANSFERRED',
  'ORIGIN_FORBIDDEN',
  'ASSIST_NOT_ENABLED',
  'SOURCE_NOT_FOUND',
  'SOURCE_READONLY',
  'DOCUMENT_NOT_UPLOADED',
  'PUBLIC_CONFIRM_REQUIRED',
  'FAQ_NOT_FOUND',
  'EXCLUSION_NOT_FOUND',
  'EXCLUSION_DUPLICATE',
  'EXCLUSION_INVALID',
  'VERSION_NOT_FOUND',
  'CHUNK_NOT_FOUND',
  'KNOWLEDGE_BUSY',
  'ANSWER_UNAVAILABLE',
] as const;
export type KnowledgeErrorCode = (typeof KNOWLEDGE_ERROR_CODES)[number];

export function isKnowledgeErrorCode(v: unknown): v is KnowledgeErrorCode {
  return (
    typeof v === 'string' &&
    (KNOWLEDGE_ERROR_CODES as readonly string[]).includes(v)
  );
}

/**
 * Ошибка клиента до запроса (размер/тип файла, просроченный билет
 * загрузки) — с тем же кодом, что вернул бы сервер: один перевод.
 */
export class ClientKnowledgeError extends Error {
  readonly code: KnowledgeErrorCode | 'UPLOAD_FAILED';
  constructor(code: KnowledgeErrorCode | 'UPLOAD_FAILED') {
    super(code);
    this.code = code;
  }
}

/**
 * Текст ошибки экранов знаний/песочницы: код Э1 → перевод помощника;
 * 403 без кода — «нет доступа к знаниям»; остальное — как в ките.
 */
export function knowledgeErrorText(
  e: unknown,
  app: AppDictionary,
  dict: Dictionary
): string {
  if (e instanceof ClientKnowledgeError) {
    return e.code === 'UPLOAD_FAILED'
      ? app.knowledge.sources.uploadFailed
      : app.errors[e.code];
  }
  if (e instanceof ApiError) {
    if (isKnowledgeErrorCode(e.code)) return app.errors[e.code];
    // 403 без своего кода (guard Nest отдаёт FORBIDDEN или пустое тело):
    // человеку — «нет доступа к знаниям», а не «что-то пошло не так».
    if (e.code === 'FORBIDDEN' || e.code === 'http_403') {
      return app.knowledge.noAccess;
    }
  }
  return errorText(e, dict);
}
