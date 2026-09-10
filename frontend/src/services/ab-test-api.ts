/**
 * A/B-варианты одного ролика (TODO §III.6, этап 66) — тонкие функции над
 * общим `api` (services/api.ts), тем же приёмом, что catalog-batch-api.ts.
 *
 * Оба маршрута за `TelegramIdentityGuard` на бэкенде (запуск принадлежит
 * владельцу проекта) — анонимный путь ловит 401, экран показывает
 * `isUnauthorized()` (см. projects-api.ts).
 */

import { api } from './api';
import type { AbTestStatusView, StartAbTestResult } from '../types';

function unwrap<T>(res: { data?: T }, what: string): T {
  if (res.data === undefined) throw new Error(`Пустой ответ: ${what}`);
  return res.data;
}

export async function startAbTest(
  projectId: string,
  sourceSessionId: string
): Promise<StartAbTestResult> {
  return unwrap(
    await api.post<StartAbTestResult>(`/projects/${projectId}/ab-test`, {
      sourceSessionId,
    }),
    'ab test'
  );
}

export async function getAbTest(
  projectId: string,
  runId: string
): Promise<AbTestStatusView> {
  return unwrap(
    await api.get<AbTestStatusView>(`/projects/${projectId}/ab-test/${runId}`),
    'ab test status'
  );
}
