/**
 * "Plain JSON object" check shared by JsonField and the router-free unit
 * test — same rule the backend's IsJsonObject validator enforces
 * (object, not array, ≤16 KB).
 *
 * Этап 56: сообщения об ошибках переехали в словарь (dict.jsonObject) —
 * эта функция чистая логика, переведённые тексты приходят от вызывающего
 * (тот же приём, что `lockLabel` в lib/plan.ts).
 */

import type { JsonObject } from '../../types/project';

export const JSON_OBJECT_MAX_BYTES = 16 * 1024;

export interface ParseJsonObjectMessages {
  notAnObject: string;
  tooLarge: string;
  invalidJson: string;
}

export function parseJsonObject(
  text: string,
  t: ParseJsonObjectMessages
): {
  value: JsonObject | null;
  error: string | null;
} {
  const trimmed = text.trim();
  if (!trimmed) return { value: null, error: null };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      return { value: null, error: t.notAnObject };
    }
    if (new TextEncoder().encode(trimmed).length > JSON_OBJECT_MAX_BYTES)
      return { value: null, error: t.tooLarge };
    return { value: parsed as JsonObject, error: null };
  } catch {
    return { value: null, error: t.invalidJson };
  }
}
