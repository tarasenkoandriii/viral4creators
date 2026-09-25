/**
 * Приёмы сцены — чистые правила карточек (этап 150, TODO §III п.11).
 *
 * Подписи живут в словарях, а не приходят с сервера: на сервере тексты
 * приёмов английские и уходят прямо в модель, и переводить их значило бы
 * править промпт. Здесь — сопоставление идентификатора подписи и то, что
 * из этого следует для экрана.
 */

import type { SceneTemplateRow } from '../services/scene-templates-api';

export type { SceneTemplateRow };

/** Ключи словаря по идентификатору приёма. */
const LABELS: Record<string, { label: string; hint: string }> = {
  unboxing: { label: 'unboxingLabel', hint: 'unboxingHint' },
  'before-after': { label: 'beforeAfterLabel', hint: 'beforeAfterHint' },
  testimonial: { label: 'testimonialLabel', hint: 'testimonialHint' },
  'vs-competitor': { label: 'vsCompetitorLabel', hint: 'vsCompetitorHint' },
};

export interface TemplateCard {
  id: string;
  label: string;
  hint: string;
  beats: number;
  /** Показать оговорку, что человек в кадре говорить не будет. */
  silent: boolean;
  chosen: boolean;
}

/**
 * Карточки для экрана.
 *
 * Приём, которого экран не знает по имени, пропускается МОЛЧА, а не
 * рисуется сырым идентификатором: бэкенд может уехать вперёд на деплой,
 * и «vs-competitor» в списке приёмов — это не подпись, а протечка. То
 * же правило и по той же причине, что у кодов сценариев тестового
 * доступа (этап 137).
 */
export function templateCards(
  rows: readonly SceneTemplateRow[],
  chosen: string | null,
  dict: Record<string, string>
): TemplateCard[] {
  const cards: TemplateCard[] = [];
  for (const row of rows) {
    const keys = LABELS[row.id];
    if (!keys) continue;
    const label = dict[keys.label];
    const hint = dict[keys.hint];
    if (!label || !hint) continue;
    cards.push({
      id: row.id,
      label,
      hint,
      beats: row.beats,
      // Оговорка нужна там, где человек в кадре ЕСТЬ, но говорить не
      // будет. Где лица нет вовсе, говорить некому и без нас — писать
      // об этом значит объяснять отсутствие того, чего не обещали.
      silent: row.presenter === 'face' && !row.speaksOnCamera,
      chosen: row.id === chosen,
    });
  }
  return cards;
}

/**
 * Можно ли сейчас выбирать приём.
 *
 * Разобранный референс закрывает выбор — и экран обязан сказать это
 * ДО нажатия, а не показать отказ после. Тот же порядок, что у
 * несовместимостей в остальных панелях.
 */
export function canChoose(view: { analysed: boolean } | null): boolean {
  return !!view && !view.analysed;
}

export type SourceMode =
  | 'library'
  | 'search'
  | 'youtube'
  | 'upload'
  | 'template';

/**
 * Какая вкладка источника открывается первой.
 *
 * Порядок важнее самих условий, и первым идёт УЖЕ СДЕЛАННЫЙ ВЫБОР
 * (аудит этапа 150, А-4). `stepFromSession` возвращает человека с
 * приёмом на «Товар», но по степперу он может вернуться и на «Видео», —
 * и открывать поверх его выбора вкладку файла значило бы прятать его
 * собственный ответ на тот же вопрос. Дальше подсказки: библиотека, если
 * сессия заведена от товара, потом поиск с готовым запросом, и в
 * последнюю очередь файл.
 */
export function initialSourceMode(input: {
  /** Приём уже выбран в этой сессии. */
  templateChosen: boolean;
  /** Вкладка приёмов вообще предлагается. */
  templatesOffered: boolean;
  /** Вкладка библиотеки вообще предлагается. */
  libraryOffered: boolean;
  /** Запрос для поиска заполнен из товара. */
  seeded: boolean;
}): SourceMode {
  if (input.templateChosen && input.templatesOffered) return 'template';
  if (input.libraryOffered && input.seeded) return 'library';
  if (input.seeded) return 'search';
  return 'upload';
}
