/**
 * Отбор элементов страницы заказчика для визарда (§11 ТЗ, этап 115).
 *
 * Отдельный файл рядом с экраном — тот же приём, что `format.ts`/
 * `json-object.ts` по соседству: правила отбора можно прогнать тестом
 * без React и без сети, а именно в них и живут ошибки, которые видно
 * только на живом сайте (показать чекбокс как текстовое поле,
 * предложить нажать кнопку без надписи).
 */

import type {
  PageElement,
  PageExploration,
} from '../../types/client-site-tutorial';

const FILLABLE: PageElement['tag'][] = ['input', 'select', 'textarea'];
const CLICKABLE: PageElement['tag'][] = ['button', 'a'];

/** Типы `input`, которые нельзя заполнить текстом. Показать их в форме
 * значит предложить человеку заполнить поле, по которому `fill` всё
 * равно не сработает. */
const UNFILLABLE_INPUT_TYPES = [
  'checkbox',
  'radio',
  'file',
  'submit',
  'button',
];

export function fillableFields(exploration: PageExploration): PageElement[] {
  return exploration.elements.filter(
    (e) =>
      FILLABLE.includes(e.tag) &&
      !(e.tag === 'input' && UNFILLABLE_INPUT_TYPES.includes(e.type ?? ''))
  );
}

/** Кандидаты «продолжить с…». Без видимого текста кнопку невозможно
 * узнать на кадре — предлагать её бессмысленно. */
export function clickCandidates(exploration: PageExploration): PageElement[] {
  return exploration.elements.filter(
    (e) => CLICKABLE.includes(e.tag) && Boolean(e.visibleText)
  );
}

export function fieldLabel(el: PageElement, fallback: string): string {
  return el.label ?? el.name ?? fallback;
}
