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

/**
 * Показывать ли блок живого входа на стадии `page`.
 *
 * Сознательно НЕ зависит от `exploration.looksLikeLogin`, и параметр
 * `exploration` здесь именно для того, чтобы это было видно в
 * сигнатуре, а тест мог зафиксировать независимость.
 *
 * `looksLikeLogin` выставляется ровно одним признаком — видимым
 * `<input type="password">` (backend, `page-exploration.ts`). Живой
 * вход существует ради логинов, где пароля на странице нет: первый
 * экран Google SSO — кнопка «Continue with Google»; Telegram Login
 * Widget живёт в кроссдоменном iframe и в DOM верхнего фрейма не виден
 * вовсе; magic link по почте поля пароля не имеет никогда. Под старым
 * условием кнопка не появлялась ровно в тех случаях, ради которых
 * фича и сделана.
 *
 * Цена лишнего показа — одна живая сессия из суточного лимита
 * (`reserveLiveSession`, §15.7), и только если человек специально
 * нажмёт кнопку. Цена пропуска — неработающая фича.
 */
export function liveLoginVisible(
  // Подчёркивание обязательно, а не стилистика: в tsconfig включён
  // `noUnusedParameters`, и он флагует неиспользуемый параметр даже
  // когда следующий используется (проверено) — `npm run build` падал
  // бы на TS6133. Имена с `_` он пропускает. `eslint-disable` здесь
  // не нужен: `@typescript-eslint/no-unused-vars` при дефолтном
  // `args: 'after-used'` до этого параметра не доходит, и директива
  // сама стала бы ошибкой под `--report-unused-disable-directives`.
  _exploration: PageExploration,
  opts: { relayConfigured: boolean; editable: boolean }
): boolean {
  return opts.relayConfigured && opts.editable;
}
