/**
 * Визард обучалки по сайту заказчика (§11 ТЗ, этап 115) — отбор
 * элементов страницы.
 *
 * React здесь не поднимается (в проекте нет рендер-раннера), и это
 * нормально: то, что реально можно сломать правкой, — не разметка, а
 * правила отбора. Показать пользователю чекбокс как текстовое поле или
 * предложить нажать кнопку, которой на странице нет, — ошибки, которые
 * увидишь только на живом сайте заказчика.
 */
import assert from 'node:assert/strict';
import {
  clickCandidates,
  fieldLabel,
  fillableFields,
} from '../src/features/projects/client-site-elements';
import type { PageExploration } from '../src/types/client-site-tutorial';

let passed = 0;
function it(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log('  ✓', name);
}

const page = (elements: PageExploration['elements']): PageExploration => ({
  currentUrl: 'https://shop.example.com/cabinet',
  screenshotDataUrl: 'data:image/jpeg;base64,x',
  looksLikeLogin: false,
  elements,
});

console.log('client-site wizard (этап 115)');

it('в форму идут только поля, которые реально можно заполнить текстом', () => {
  // `fill` по чекбоксу не сработает, а в форме он выглядел бы как
  // обычное пустое поле — человек заполнил бы его и не понял, почему шаг
  // ничего не сделал.
  const result = fillableFields(
    page([
      { selector: '#a', tag: 'input', type: 'text' },
      { selector: '#b', tag: 'input', type: 'checkbox' },
      { selector: '#c', tag: 'input', type: 'file' },
      { selector: '#d', tag: 'textarea' },
      { selector: '#e', tag: 'select' },
      { selector: '#f', tag: 'button', visibleText: 'Войти' },
    ])
  );
  assert.deepEqual(
    result.map((e) => e.selector),
    ['#a', '#d', '#e']
  );
});

it('поле пароля остаётся в форме — без него нечем войти', () => {
  const result = fillableFields(
    page([{ selector: '#p', tag: 'input', type: 'password' }])
  );
  assert.equal(result.length, 1);
});

it('в кандидаты на нажатие идут только кнопки и ссылки с видимым текстом', () => {
  // Кнопка без надписи — это кнопка, которую человек не сможет узнать на
  // кадре, значит предлагать её бессмысленно.
  const result = clickCandidates(
    page([
      { selector: '#a', tag: 'button', visibleText: 'Продолжить' },
      { selector: '#b', tag: 'button' },
      { selector: '#c', tag: 'a', visibleText: 'Кабинет' },
      { selector: '#d', tag: 'input', type: 'text' },
    ])
  );
  assert.deepEqual(
    result.map((e) => e.selector),
    ['#a', '#c']
  );
});

it('опасная пометка доезжает до кандидата как есть', () => {
  // Она приходит РАУНДОМ РАНЬШЕ нажатия — на этом и держится «вы
  // уверены?» до того, как заказ оформлен.
  const [button] = clickCandidates(
    page([
      {
        selector: '#pay',
        tag: 'button',
        visibleText: 'Оплатить',
        danger: 'Похоже на необратимое действие',
      },
    ])
  );
  assert.equal(button.danger, 'Похоже на необратимое действие');
});

it('подпись поля: label → name → запасной вариант', () => {
  assert.equal(
    fieldLabel(
      { selector: '#a', tag: 'input', label: 'Почта', name: 'email' },
      'Поле 1'
    ),
    'Почта'
  );
  assert.equal(
    fieldLabel({ selector: '#a', tag: 'input', name: 'email' }, 'Поле 1'),
    'email'
  );
  assert.equal(
    fieldLabel({ selector: '#a', tag: 'input' }, 'Поле 1'),
    'Поле 1'
  );
});

it('пустая страница не роняет ни один из отборов', () => {
  assert.deepEqual(fillableFields(page([])), []);
  assert.deepEqual(clickCandidates(page([])), []);
});

console.log(`client-site wizard: ${passed} проверок пройдено`);
