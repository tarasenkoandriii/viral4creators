/**
 * Дескриптор элемента цели (Э3, ТЗ §5-тер.1): одна и та же нормализация
 * роли и видимого текста у режима выбора цели (picker.js — записывает) и
 * у загрузчика (детектор click/form_submit — сравнивает). Иначе выбранная
 * кнопка не узнавалась бы на той же странице.
 */

/** Видимый текст: пробелы схлопнуты, ≤ 80, без регистра (значения полей — нет). */
export function textOf(el: Element): string {
  const t = el.tagName;
  // Поле ввода — никогда его значение (§5-тер.8); кнопка-input — её надпись.
  const v =
    t === 'INPUT'
      ? /^(submit|button)$/i.test((el as HTMLInputElement).type)
        ? (el as HTMLInputElement).value
        : ''
      : el.textContent;
  return (v || '').replace(/\s+/g, ' ').trim().slice(0, 80).toLowerCase();
}

/** ARIA-роль или роль по тегу (a → link, form → form, иначе имя тега). */
export function roleOf(el: Element): string {
  const t = el.tagName;
  return (
    el.getAttribute('role') ||
    (t === 'A' ? 'link' : t === 'FORM' ? 'form' : t.toLowerCase())
  );
}
