/**
 * Приёмы сцены вместо референса (этап 150, TODO §III п.11).
 *
 * Каталог отдаёт сервер, подписи для человека живут в словарях: на
 * сервере тексты приёмов — английские и уходят в модель, и переводить
 * их значило бы править промпт.
 */

import { api } from './api';

export interface SceneTemplateRow {
  id: string;
  frame: string;
  presenter: string;
  beats: number;
  /** Заговорит ли человек в кадре при текущем режиме озвучки сессии. */
  speaksOnCamera: boolean;
}

export interface SceneTemplateView {
  templates: SceneTemplateRow[];
  chosen: string | null;
  /** Референс уже разобран — приём выбрать нельзя. */
  analysed: boolean;
}

export async function getSceneTemplates(
  sessionId: string
): Promise<SceneTemplateView> {
  const res = await api.get<SceneTemplateView>(
    `/sessions/${encodeURIComponent(sessionId)}/scene-template`
  );
  if (!res.data) throw new Error('Пустой ответ: приёмы сцены');
  return res.data;
}

export async function chooseSceneTemplate(
  sessionId: string,
  templateId: string | null
): Promise<SceneTemplateView> {
  const res = await api.putJson<SceneTemplateView>(
    `/sessions/${encodeURIComponent(sessionId)}/scene-template`,
    { templateId }
  );
  if (!res.data) throw new Error('Пустой ответ: выбор приёма');
  return res.data;
}
