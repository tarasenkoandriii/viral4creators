/**
 * Коды ошибок кабинета виджета Э2 (контракт Э2 §6 «Кабинет» + сверх
 * контракта у W4/W5) → текст на языке интерфейса. Остальное — как у
 * экранов знаний (коды Э1 и кита).
 *
 * `scripts/widget-view.test.ts` сверяет список с `SetupCode` в
 * `sites-backend/src/modules/assist-site-setup/errors.ts` и кодами W5.
 */

import { ApiError, type Dictionary } from '../kit';
import type { AppDictionary } from '../i18n';
import { knowledgeErrorText } from './knowledge-errors';

export const SETUP_ERROR_CODES = [
  'BAD_REQUEST',
  'WIDGET_CONFIG_INVALID',
  'PERSONA_INVALID',
  'LEADS_CONFIG_INVALID',
  'HOST_NOT_VERIFIED',
  'WIDGET_NOT_PUBLISHED',
  'VERSION_NOT_FOUND',
  'VERSION_CONFLICT',
  'ASSET_TYPE',
  'ASSET_TOO_LARGE',
  'PERSONA_GATE_FAILED',
  'KEYS_MISSING',
  'WIZARD_DRAFT_LIMIT',
  'WIZARD_NOT_STARTED',
  // Э3 (T): триггеры и сценарии вовлечения.
  'ENGAGEMENT_INVALID',
] as const;
export type SetupErrorCode = (typeof SETUP_ERROR_CODES)[number];

export function isSetupErrorCode(v: unknown): v is SetupErrorCode {
  return (
    typeof v === 'string' &&
    (SETUP_ERROR_CODES as readonly string[]).includes(v)
  );
}

/** Ошибка клиента до запроса (файл не того типа/размера) — тот же перевод. */
export class ClientSetupError extends Error {
  readonly code: SetupErrorCode;
  constructor(code: SetupErrorCode) {
    super(code);
    this.code = code;
  }
}

export function setupErrorText(
  e: unknown,
  app: AppDictionary,
  dict: Dictionary
): string {
  if (e instanceof ClientSetupError) return app.setup.errors[e.code];
  if (e instanceof ApiError) {
    if (isSetupErrorCode(e.code)) return app.setup.errors[e.code];
    if (e.code === 'FORBIDDEN' || e.code === 'http_403') {
      return app.setup.common.noAccess;
    }
  }
  return knowledgeErrorText(e, app, dict);
}
