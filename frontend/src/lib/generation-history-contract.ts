import type { HistoryPage } from './private-history-pager';
export type HistoryStatus =
  | 'queued'
  | 'processing'
  | 'complete'
  | 'failed'
  | 'cancelled'
  | 'unknown';
export interface GenerationHistoryItem {
  id: string;
  sessionId: string;
  status: HistoryStatus;
  createdAt: string;
  resolution: string | null;
}
const statuses: HistoryStatus[] = [
  'queued',
  'processing',
  'complete',
  'failed',
  'cancelled',
  'unknown',
];
export function parseGenerationHistoryPage(
  raw: unknown
): HistoryPage<GenerationHistoryItem> {
  const value = raw as { items?: unknown; nextCursor?: unknown } | null;
  if (
    !value ||
    !Array.isArray(value.items) ||
    !(value.nextCursor === null || typeof value.nextCursor === 'string')
  )
    throw Error('Invalid history response');
  const items = value.items.map((row: unknown) => {
    const r = row as Record<string, unknown> | null;
    if (
      !r ||
      typeof r.id !== 'string' ||
      !r.id ||
      typeof r.sessionId !== 'string' ||
      !r.sessionId ||
      typeof r.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(r.createdAt))
    )
      throw Error('Invalid history record');
    return {
      id: r.id,
      sessionId: r.sessionId,
      createdAt: r.createdAt,
      status: statuses.includes(r.status as HistoryStatus)
        ? (r.status as HistoryStatus)
        : ('unknown' as const),
      resolution:
        typeof r.resolution === 'string' && /^\d{3,4}p$/.test(r.resolution)
          ? r.resolution
          : null,
    };
  });
  return { items, nextCursor: value.nextCursor as string | null };
}
