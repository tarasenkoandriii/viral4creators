/**
 * Коды ошибок кабинета Э3 (H, L, A, T — контракт Э3 §6 «Коды ошибок») →
 * текст на языке интерфейса. Остальное — как у экранов виджета (коды Э2,
 * Э1 и кита). `scripts/e3-api.test.ts` сверяет список с серверными
 * `*_ERROR_CODES` и с `SetupCode`.
 */

import { ApiError, fieldErrors, type Dictionary } from '../kit';
import type { AppDictionary } from '../i18n';
import { HANDOFF_ERROR_CODES } from './handoff-types';
import { LEARNING_ERROR_CODES } from './learning-types';
import { setupErrorText } from './setup-errors';
import { ANALYTICS_ERROR_CODES } from './stats-types';

export const E3_ERROR_CODES = [
  ...HANDOFF_ERROR_CODES,
  ...LEARNING_ERROR_CODES,
  ...ANALYTICS_ERROR_CODES,
  'ENGAGEMENT_INVALID',
] as const;
export type E3ErrorCode = (typeof E3_ERROR_CODES)[number];

export function isE3ErrorCode(v: unknown): v is E3ErrorCode {
  return (
    typeof v === 'string' && (E3_ERROR_CODES as readonly string[]).includes(v)
  );
}

/**
 * Построчные ошибки полей формы (`details.errors[]` у `ENGAGEMENT_INVALID`,
 * `HANDOFF_CONFIG_INVALID`): «путь — что не так». Путь — как прислал сервер
 * (`triggers[0].text.ru`): по нему видно, какой триггер/день править.
 */
export function fieldErrorLines(e: unknown, app: AppDictionary): string[] {
  const t = app.e3.fieldErrors as Record<string, string>;
  return fieldErrors(e).map((f) => {
    const what = t[f.code] ?? t.other;
    return f.path ? `${f.path} — ${what}` : what;
  });
}

export function e3ErrorText(
  e: unknown,
  app: AppDictionary,
  dict: Dictionary
): string {
  if (e instanceof ApiError && isE3ErrorCode(e.code)) {
    return app.e3.errors[e.code];
  }
  return setupErrorText(e, app, dict);
}

/**
 * Ошибка формы целиком: текст по коду + построчные ошибки полей. Нужна
 * экранам, где сервер отвечает `*_INVALID` с `details.errors[]`
 * (`GOAL_INVALID`, `ANALYTICS_CONFIG_INVALID`, `HANDOFF_CONFIG_INVALID`,
 * `ENGAGEMENT_INVALID`): одно «Проверьте настройки» без строк не говорит,
 * какое поле править.
 */
export function e3ErrorNotice(
  e: unknown,
  app: AppDictionary,
  dict: Dictionary
): { tone: 'danger'; text: string; lines: string[] } {
  return {
    tone: 'danger',
    text: e3ErrorText(e, app, dict),
    lines: fieldErrorLines(e, app),
  };
}
