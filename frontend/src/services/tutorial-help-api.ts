/**
 * Справка по теме мастера — `GET /tutorial-help/:subjectKey`.
 *
 * Отдельный файл, а не дополнение `greeting-api.ts`: справка не про
 * поздравление. Тем две семьи, и кнопка (i) появится и в мастере
 * товара — привязывать её маршрут к файлу одного типа проекта значило
 * бы переносить его при первом же расширении.
 */

import { api } from './api';
import { readStoredLocale, defaultLocale } from '../lib/i18n';

export interface TutorialHelpView {
  subjectKey: string;
  locale: string;
  title: string;
  text: string;
  /** `null` — ролика пока нет или он не вычитан; текст всё равно есть. */
  videoUrl: string | null;
  durationMs: number | null;
}

export async function getTutorialHelp(
  subjectKey: string,
  locale: string = readStoredLocale() ?? defaultLocale
): Promise<TutorialHelpView> {
  // Язык — в строке запроса, а не заголовком: ответ кешируется на пять
  // минут, и один кеш на все языки отдал бы русскую справку немцу.
  const res = await api.get<TutorialHelpView>(
    `/tutorial-help/${encodeURIComponent(subjectKey)}?locale=${encodeURIComponent(locale)}`
  );
  if (res.data === undefined) throw new Error('Пустой ответ: tutorial-help');
  return res.data;
}
