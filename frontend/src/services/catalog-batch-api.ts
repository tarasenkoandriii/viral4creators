/**
 * Пакетная генерация по каталогу (ТЗ §44, этап 65) — тонкие функции над
 * общим `api` (services/api.ts), тем же приёмом, что billing-api.ts/
 * marketing-api.ts.
 *
 * Оба маршрута за `TelegramIdentityGuard` на бэкенде (партия принадлежит
 * владельцу проекта) — анонимный путь ловит 401, экран показывает
 * `isUnauthorized()` (см. projects-api.ts).
 */

import { api } from './api';
import type { CatalogBatchStatusView, StartCatalogBatchResult } from '../types';

function unwrap<T>(res: { data?: T }, what: string): T {
  if (res.data === undefined) throw new Error(`Пустой ответ: ${what}`);
  return res.data;
}

export async function startCatalogBatch(
  projectId: string,
  dto: {
    sourceSessionId: string;
    productItemIds: string[];
    provider?: 'veo' | 'grok';
    resolution?: '480p' | '720p' | '1080p';
  }
): Promise<StartCatalogBatchResult> {
  return unwrap(
    await api.post<StartCatalogBatchResult>(
      `/projects/${projectId}/catalog-batch`,
      dto
    ),
    'catalog batch'
  );
}

export async function getCatalogBatch(
  projectId: string,
  batchId: string
): Promise<CatalogBatchStatusView> {
  return unwrap(
    await api.get<CatalogBatchStatusView>(
      `/projects/${projectId}/catalog-batch/${batchId}`
    ),
    'catalog batch status'
  );
}

/** Точечный повтор FAILED-строк (Д-1.3, этап 74) — без `productItemId`
 * повторяет все провалившиеся строки партии, с ним — только одну.
 * `skippedBusy` (Е-2.4 шестого аудита) — товары, которые в момент повтора
 * оказались заняты ДРУГОЙ активной партией: сервер их не тронул, чтобы не
 * задвоить оплаченный рендер. */
export async function retryCatalogBatch(
  projectId: string,
  batchId: string,
  productItemId?: string
): Promise<{ retried: number; skippedBusy: string[] }> {
  return unwrap(
    await api.post<{ retried: number; skippedBusy: string[] }>(
      `/projects/${projectId}/catalog-batch/${batchId}/retry`,
      productItemId ? { productItemId } : {}
    ),
    'catalog batch retry'
  );
}
