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
import { readFileSync } from 'node:fs';
import {
  clickCandidates,
  fieldLabel,
  fillableFields,
  liveLoginVisible,
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

/**
 * Живой вход на логинах без пароля.
 *
 * Дефект, который эти проверки закрывают: блок живого входа стоял
 * внутри ветки `exploration.looksLikeLogin`, а тот флаг на бэкенде
 * выставляется ровно одним признаком — видимым `<input
 * type="password">`. Значит на первом экране Google SSO, на Telegram
 * Login Widget (кроссдоменный iframe, в DOM верхнего фрейма его нет
 * вовсе) и на входе по magic link кнопка не появлялась НИКОГДА — то
 * есть ровно там, ради чего живой вход и сделан.
 */

const ssoPage = page([
  { selector: '#go', tag: 'button', visibleText: 'Continue with Google' },
]);
const passwordPage: PageExploration = {
  ...page([
    { selector: '#u', tag: 'input', type: 'text', name: 'login' },
    { selector: '#p', tag: 'input', type: 'password', name: 'password' },
  ]),
  looksLikeLogin: true,
};

it('живой вход виден на странице входа БЕЗ поля пароля', () => {
  assert.equal(ssoPage.looksLikeLogin, false);
  assert.equal(
    liveLoginVisible(ssoPage, { relayConfigured: true, editable: true }),
    true
  );
});

it('видимость живого входа не зависит от looksLikeLogin', () => {
  // Инвариант, а не совпадение: именно эта зависимость и была дефектом.
  const opts = { relayConfigured: true, editable: true };
  assert.equal(
    liveLoginVisible(ssoPage, opts),
    liveLoginVisible(passwordPage, opts)
  );
});

it('без настроенного реле живого входа нет нигде', () => {
  for (const p of [ssoPage, passwordPage]) {
    assert.equal(
      liveLoginVisible(p, { relayConfigured: false, editable: true }),
      false
    );
  }
});

it('черновик на проверке у оператора — живого входа нет', () => {
  // `editable === false` это статус не DRAFTING: редактировать нечего,
  // и живая сессия сожгла бы слот суточного лимита впустую.
  assert.equal(
    liveLoginVisible(passwordPage, { relayConfigured: true, editable: false }),
    false
  );
});

it('в разметке блок живого входа лежит ВНЕ ветки looksLikeLogin', () => {
  // Проверка по исходнику, потому что перенести блок обратно внутрь
  // ветки можно правкой JSX, не трогая `liveLoginVisible` — тогда все
  // проверки выше остались бы зелёными, а кнопка снова исчезла бы с
  // SSO-логинов. Тот же приём, что в backend/src/prisma/
  // schema-relations.spec.ts: читаем файл как текст, без React.
  //
  // Чего проверка НЕ гарантирует: что блок вообще отрисуется — этого
  // без рендер-раннера не увидеть.
  const src = readFileSync(
    new URL('../src/features/projects/ClientSiteWizard.tsx', import.meta.url),
    'utf8'
  );
  const ternaryStart = src.indexOf('{exploration.looksLikeLogin ? (');
  assert.ok(ternaryStart > 0, 'ветка looksLikeLogin не найдена');

  // Хвост else-ветки тернарника — обычная форма; следующий за ним
  // `)}` на отступе экрана и закрывает сам тернарник.
  const elseTail = src.indexOf('{t.plainValuesWarning}', ternaryStart);
  assert.ok(elseTail > ternaryStart, 'хвост else-ветки не найден');
  const ternaryEnd = src.indexOf('\n      )}', elseTail);
  assert.ok(ternaryEnd > elseTail, 'закрытие тернарника не найдено');

  const liveBlock = src.indexOf('{liveAvailable && (');
  assert.ok(liveBlock > 0, 'блок живого входа не найден');
  assert.ok(
    liveBlock > ternaryEnd,
    'блок живого входа снова внутри ветки looksLikeLogin — на SSO-логинах кнопка исчезнет'
  );
  assert.equal(
    src.split('{liveAvailable && (').length - 1,
    1,
    'блок живого входа должен быть один'
  );
});

console.log(`client-site wizard: ${passed} проверок пройдено`);
