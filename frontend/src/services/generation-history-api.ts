import { api } from './api';
import type { HistoryPage } from '../lib/private-history-pager';
import {
  parseGenerationHistoryPage,
  type GenerationHistoryItem,
} from '../lib/generation-history-contract';
export type {
  GenerationHistoryItem,
  HistoryStatus,
} from '../lib/generation-history-contract';
export async function listGenerationHistory(
  before?: string
): Promise<HistoryPage<GenerationHistoryItem>> {
  const query = new URLSearchParams({ limit: '20' });
  if (before) query.set('before', before);
  const response = await api.get<unknown>(`/generation-history?${query}`);
  return parseGenerationHistoryPage(response.data);
}
