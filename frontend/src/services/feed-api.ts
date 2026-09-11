/**
 * Лента опубликованных роликов (TODO §III.9, этап 80,
 * doc/SOCIAL-FEED-SPEC.md) — тонкие функции над общим `api`
 * (services/api.ts), тем же приёмом, что ab-test-api.ts.
 *
 * `getFeed`/`recordShare` — публичные маршруты бэкенда (без гварда),
 * работают и анонимно; `like`/`unlike` — за `TelegramIdentityGuard`
 * (лайк без Telegram-идентичности бессмысленен, doc §4), анонимный вызов
 * ловит 401 — экран показывает мягкую подсказку «войдите», не падает
 * (см. `isUnauthorized()` в projects-api.ts).
 */

import { api } from './api';
import type { SharedVideoFeedResult } from '../types';

function unwrap<T>(res: { data?: T }, what: string): T {
  if (res.data === undefined) throw new Error(`Пустой ответ: ${what}`);
  return res.data;
}

export async function getFeed(
  cursor?: string | null,
  pageSize = 20
): Promise<SharedVideoFeedResult> {
  const params = new URLSearchParams();
  if (cursor) params.set('cursor', cursor);
  params.set('pageSize', String(pageSize));
  return unwrap(
    await api.get<SharedVideoFeedResult>(`/shared-video/feed?${params}`),
    'лента'
  );
}

/** Best-effort — сбой не должен мешать самому шерингу (см. FeedScreen). */
export async function recordSharedVideoShare(id: string): Promise<void> {
  await api.post(`/shared-video/${id}/share`, undefined);
}

export async function likeSharedVideo(
  id: string
): Promise<{ likeCount: number; likedByViewer: boolean }> {
  return unwrap(
    await api.post<{ likeCount: number; likedByViewer: boolean }>(
      `/shared-video/${id}/like`,
      undefined
    ),
    'лайк'
  );
}

export async function unlikeSharedVideo(
  id: string
): Promise<{ likeCount: number; likedByViewer: boolean }> {
  // `api.delete()` предполагает 204 без тела (см. withdrawSharedVideo) —
  // этот маршрут отвечает JSON (актуальный likeCount), поэтому нужен
  // `deleteWithBody`, не `delete`.
  return unwrap(
    await api.deleteWithBody<{ likeCount: number; likedByViewer: boolean }>(
      `/shared-video/${id}/like`
    ),
    'снятие лайка'
  );
}
