/**
 * Автоэкспорт одного ролика под несколько площадок/форматов (TODO §III,
 * «Уровень 6», п.35; `doc/MULTI-FORMAT-EXPORT-SPEC.md`, этап 75) — тонкие
 * функции над общим `api` (services/api.ts), тем же приёмом, что
 * ab-test-api.ts/catalog-batch-api.ts.
 *
 * Два яруса — два разных маршрута (см. доккомментарий `ExportPanel.tsx`):
 * `POST /export` (ярус A, дешёвая обрезка, батч) и
 * `POST /export/rerender` (ярус B, второй платный рендер Veo, один формат).
 * Оба защищены тем же `SessionOwnerGuard`, что и `/generate`.
 */

import { api } from './api';
import type { GeneratedVideo, VideoQuality } from './api';

function unwrap<T>(res: { data?: T }, what: string): T {
  if (res.data === undefined) throw new Error(`Пустой ответ: ${what}`);
  return res.data;
}

export async function startExportBatch(
  sessionId: string,
  targets: string[]
): Promise<GeneratedVideo> {
  return unwrap(
    await api.post<GeneratedVideo>(`/sessions/${sessionId}/export`, {
      targets,
    }),
    'автоэкспорт'
  );
}

export async function startExportRerender(
  sessionId: string,
  targetAspectRatio: string,
  preset?: string,
  quality?: VideoQuality
): Promise<{ video: GeneratedVideo; childSessionId: string }> {
  return unwrap(
    await api.post<{ video: GeneratedVideo; childSessionId: string }>(
      `/sessions/${sessionId}/export/rerender`,
      { targetAspectRatio, preset, quality }
    ),
    'перерендер в другом формате'
  );
}

export async function getExportStatus(
  sessionId: string
): Promise<GeneratedVideo> {
  return unwrap(
    await api.get<GeneratedVideo>(`/sessions/${sessionId}/export/status`),
    'статус автоэкспорта'
  );
}
