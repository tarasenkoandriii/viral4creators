/**
 * Сколько колонок отдать сегментам `Pills`.
 *
 * Отдельный файл без React — иначе правило нечем покрыть тестом:
 * рендер-раннера в проекте нет, а `Pills.tsx` тянет JSX.
 */

/** Ровно то, что нужно правилу, а не весь `PillOption`. */
export interface PillColumnsInput {
  sub?: unknown;
}

/**
 * До этой правки колонок было столько же, сколько вариантов —
 * `repeat(options.length, minmax(0, 1fr))`. На четырёх вариантах с
 * подписями это давало ~70 пикселей на карточку в телефонной ширине, и
 * текст вываливался за фон кнопки: у неё нет ни `overflow-hidden`, ни
 * разрыва длинных слов, а «поздравление» браузер по умолчанию не
 * переносит. На экране создания проекта это было видно глазом.
 *
 * Правило: подписи есть — не больше двух колонок. Оно намеренно узкое,
 * а не «четыре и больше → две»: короткие варианты без подписей (выбор
 * пола в карточке аудитории — «Женщины / Мужчины / Любая / —») в одну
 * строку помещаются прекрасно, и ломать их ради чужой беды незачем.
 * Явный `columns` у вызывающего всегда сильнее.
 */
export function pillColumns(
  options: PillColumnsInput[],
  explicit?: number
): number {
  if (explicit !== undefined && explicit > 0) return Math.floor(explicit);
  // `repeat(0, …)` — невалидный CSS, и вся сетка молча схлопнулась бы.
  if (options.length === 0) return 1;
  const hasSub = options.some((o) => o.sub !== undefined && o.sub !== null);
  if (!hasSub) return options.length;
  return Math.min(options.length, 2);
}

/**
 * Как погасить пилюлю. Два разных «нельзя» — и два разных способа.
 *
 * Вся группа выключена (`disabled` у `Pills`: форма сохраняется, шаг
 * занят) — нативный `disabled`: выбирать сейчас нечего, и фокусу в
 * группе делать нечего тоже.
 *
 * Выключен ОДИН вариант (закрыт тарифом, тон недоступен для повода) —
 * `aria-disabled` и клик вхолостую, а не нативный `disabled`. Нативно
 * выключенная кнопка выпадает из порядка Tab, и скринридер до неё не
 * доходит, — а у такого варианта подпись («недоступен для этого
 * повода», замок тарифа) и есть объяснение, которое человек должен
 * услышать. Показать и погасить честнее, чем убрать, только если
 * погашенное можно прочитать (аудит этапа D Greeting 2.0).
 */
export function pillDisabledState(
  groupDisabled: boolean | undefined,
  optionDisabled: boolean | undefined
): { native: boolean; aria: boolean; selectable: boolean } {
  if (groupDisabled) return { native: true, aria: false, selectable: false };
  if (optionDisabled) return { native: false, aria: true, selectable: false };
  return { native: false, aria: false, selectable: true };
}
