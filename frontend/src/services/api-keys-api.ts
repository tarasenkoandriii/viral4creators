/**
 * Ключи внешнего API (этап 145, docs-tz/TZ-Vneshnee-API.md).
 *
 * Тонкая обёртка над тремя маршрутами. Секрет приходит ровно в одном
 * ответе — на выдачу; больше его не существует нигде, и просить его у
 * сервера второй раз бессмысленно, поэтому отдельного «показать ключ»
 * здесь нет и не появится.
 */

import { api } from './api';
import type { ApiKeyView } from '../lib/api-keys';

export type { ApiKeyView };

export interface ApiKeyList {
  keys: ApiKeyView[];
  /**
   * Потолок живых ключей — числом ОТ СЕРВЕРА, а не копией здесь (аудит
   * этапа 145): копии таких чисел расходятся с оригиналом всегда в
   * худшую сторону — человеку показывают кнопку, которую сервер потом
   * запрещает.
   */
  maxActive: number;
}

export async function listApiKeys(): Promise<ApiKeyList> {
  const res = await api.get<ApiKeyList>('/api-keys');
  return res.data ?? { keys: [], maxActive: 0 };
}

export async function issueApiKey(
  name: string
): Promise<{ key: ApiKeyView; secret: string }> {
  const res = await api.post<{ key: ApiKeyView; secret: string }>('/api-keys', {
    name,
  });
  if (!res.data) throw new Error('Пустой ответ: выдача ключа');
  return res.data;
}

/** Куда слать исход заявки. Пустая строка — не слать (этап 146). */
export async function setApiKeyWebhook(
  id: string,
  webhookUrl: string
): Promise<ApiKeyView> {
  const res = await api.patch<ApiKeyView>(
    `/api-keys/${encodeURIComponent(id)}/webhook`,
    { webhookUrl }
  );
  if (!res.data) throw new Error('Пустой ответ: адрес вебхука');
  return res.data;
}

export async function revokeApiKey(id: string): Promise<void> {
  await api.delete(`/api-keys/${encodeURIComponent(id)}`);
}
