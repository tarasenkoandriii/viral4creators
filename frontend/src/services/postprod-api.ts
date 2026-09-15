/**
 * Переозвучка готового ролика без повторной генерации (доп. запрос
 * владельца продукта, этап 87) — тонкая функция над общим `api`
 * (services/api.ts), тем же приёмом, что export-api.ts/ab-test-api.ts.
 *
 * Голос (ttsVoiceId/провайдер) меняется отдельным, уже существующим
 * вызовом — `updateBrandSnapshot` (services/projects-api.ts,
 * PATCH /sessions/:id/brand-manifest) ДО вызова этой функции; здесь —
 * только запуск самой переозвучки, с необязательным новым текстом
 * реплик.
 *
 * `listPostprodVideos` (этап 88 — вкладка «Постпрод») — список ВСЕХ
 * готовых роликов пользователя (`GET /postprod/videos`, требует
 * личность — тот же `TelegramIdentityGuard`, что у `/projects`).
 * Пагинация страницами (`page`/`pageSize` → `{items,total,page,
 * pageSize}`), не курсором, как у `getFeed`: список — «мои ролики», а
 * не бесконечная общая лента, и бэкенд уже считает `total` тем же
 * способом, что и постранично админский список сессий.
 *
 * `deletePostprodVideo` (этап 88.2) — штатное удаление своего ролика
 * (`DELETE /sessions/:id`, новый маршрут в `sessions.controller.ts`);
 * владение проверяет глобальный `SessionOwnerGuard` на бэкенде, здесь —
 * просто вызов.
 */

import { api } from './api';
import type { GeneratedVideo } from './api';
import type { VoiceMode } from '../types';

function unwrap<T>(res: { data?: T }, what: string): T {
  if (res.data === undefined) throw new Error(`Пустой ответ: ${what}`);
  return res.data;
}

export async function reVoiceVideo(
  sessionId: string,
  voiceoverScript?: string
): Promise<GeneratedVideo> {
  return unwrap(
    await api.post<GeneratedVideo>(`/sessions/${sessionId}/postprod/revoice`, {
      voiceoverScript,
    }),
    'переозвучка'
  );
}

export interface PostprodVideoSummary {
  sessionId: string;
  createdAt: string;
  productName: string | null;
  generatedVideoId: string | null;
  downloadUrl: string | null;
  renderedUrl: string | null;
  postStatus: 'pending' | 'complete' | 'failed' | 'skipped' | null;
  voiceMode: VoiceMode | null;
  aspectRatio: string | null;
  quality: string | null;
  provider: string | null;
  resolution: string | null;
  /** У Veo-озвучки своей дорожки нет — кнопка «Переозвучить» скрыта. */
  canRevoice: boolean;
}

export interface PostprodVideoListResult {
  items: PostprodVideoSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listPostprodVideos(
  page = 1,
  pageSize = 20,
  // `offset` (найдено доп. аудитом, HIGH) — явный сдвиг для «Показать
  // ещё» после локального удаления строки на экране (см.
  // PostprodScreen.tsx's loadMore и доккомментарий бэкендового
  // PostprodVideosService.listFinishedVideos): без него следующая
  // порция считалась бы по номинальному номеру страницы и пропускала
  // бы один ролик на границе.
  offset?: number
): Promise<PostprodVideoListResult> {
  const params = new URLSearchParams();
  params.set('page', String(page));
  params.set('pageSize', String(pageSize));
  if (offset !== undefined) params.set('offset', String(offset));
  return unwrap(
    await api.get<PostprodVideoListResult>(`/postprod/videos?${params}`),
    'список роликов'
  );
}

export async function deletePostprodVideo(sessionId: string): Promise<void> {
  await api.delete(`/sessions/${sessionId}`);
}
