/**
 * Импорт товарного фида по ссылке (TODO §Уровень 2 п.8, этап 68, §47) —
 * тонкие функции над общим `api` (services/api.ts), тем же приёмом, что
 * ab-test-api.ts/catalog-batch-api.ts.
 *
 * Все три маршрута за `TelegramIdentityGuard` на бэкенде (импорт
 * принадлежит владельцу проекта) — анонимный путь ловит 401, экран
 * показывает `isUnauthorized()` (см. projects-api.ts).
 */

import { api } from './api';
import type {
  FeedImportRunSummary,
  FeedImportStatusView,
  StartFeedImportResult,
} from '../types';

function unwrap<T>(res: { data?: T }, what: string): T {
  if (res.data === undefined) throw new Error(`Пустой ответ: ${what}`);
  return res.data;
}

export async function startFeedImport(
  projectId: string,
  sourceUrl: string
): Promise<StartFeedImportResult> {
  return unwrap(
    await api.post<StartFeedImportResult>(
      `/projects/${projectId}/feed-imports`,
      { sourceUrl }
    ),
    'feed import'
  );
}

export async function listFeedImports(
  projectId: string
): Promise<FeedImportRunSummary[]> {
  return unwrap(
    await api.get<FeedImportRunSummary[]>(
      `/projects/${projectId}/feed-imports`
    ),
    'feed import list'
  );
}

export async function getFeedImport(
  projectId: string,
  runId: string
): Promise<FeedImportStatusView> {
  return unwrap(
    await api.get<FeedImportStatusView>(
      `/projects/${projectId}/feed-imports/${runId}`
    ),
    'feed import status'
  );
}
