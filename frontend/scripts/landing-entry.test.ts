/**
 * Ссылка с лендинга → готовая форма мастера (находка Б-1 аудита
 * `docs-tz/AUDIT-Client-Site-Tutorial-Landing.md`).
 *
 * До этой правки метка источника `?entry=` во всём монорепозитории
 * только ПИСАЛАСЬ — лендингом — и не читалась нигде. Для поздравлений
 * это было незаметно: тип проекта выводился из второго параметра
 * (`?occasion=`). У лендинга обучалки по сайту второго параметра нет, и
 * его главная кнопка открывала бы мастер на плитке товарного ролика.
 *
 * Проверено «обратным ходом»: с пустой таблицей `ENTRY_PROJECT_TYPES`
 * падают обе проверки типа, с `occasion` слабее `entry` — проверка
 * приоритета.
 *
 * Запуск: `npm test` во frontend.
 */
import assert from 'node:assert/strict';
import {
  ENTRY_PROJECT_TYPES,
  ENTRY_SECTION_ROUTES,
  LANDING_ENTRIES,
  PROJECT_NEW_ROUTE,
  entryHashRoute,
  entryLaunchUrl,
  projectTypeFromSearch,
  siteUrlFromSearch,
} from '../src/features/projects/landing-entry';
import { readFileSync } from 'node:fs';
import { parseRoute, routes } from '../src/lib/router';

let passed = 0;
function it(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log('  ✓', name);
}

console.log('landing-entry');

it('ссылка лендинга обучалки открывает мастер на «сайте заказчика»', () => {
  assert.equal(projectTypeFromSearch('?entry=site-tutorial'), 'CLIENT_SITE');
});

it('ссылка лендинга поздравлений открывает мастер на поздравлении', () => {
  assert.equal(projectTypeFromSearch('?entry=greetings'), 'GREETING_VIDEO');
});

it('повод сильнее метки источника — плитка конкретнее, чем «пришёл с лендинга»', () => {
  // Такой ссылки сегодня никто не формирует, но параметры приходят
  // снаружи, и приоритет должен быть определён, а не случаен.
  assert.equal(
    projectTypeFromSearch('?entry=site-tutorial&occasion=WEDDING'),
    'GREETING_VIDEO'
  );
});

it('без параметров тип не навязывается — мастер откроется на умолчании', () => {
  assert.equal(projectTypeFromSearch(''), null);
  assert.equal(projectTypeFromSearch('?utm_source=telegram'), null);
});

it('незнакомая метка источника игнорируется, а не ломает форму', () => {
  assert.equal(projectTypeFromSearch('?entry=нечто'), null);
});

it('метка главной (ads) открывает форму товарного ролика', () => {
  // Тот же тип, что и умолчание формы, но метка нужна входу из
  // Telegram (`startapp=e_ads`, `lib/start-param.ts`).
  assert.equal(projectTypeFromSearch('?entry=ads'), 'SINGLE');
});

it('имя свойства Object.prototype — не метка', () => {
  // До закрытого списка `ENTRY_PROJECT_TYPES[entry]` отдавал на
  // `?entry=toString` функцию, и она становилась «типом проекта».
  for (const key of [
    'toString',
    'constructor',
    '__proto__',
    'hasOwnProperty',
  ]) {
    assert.equal(projectTypeFromSearch(`?entry=${key}`), null, key);
  }
});

it('каждая метка в таблице ведёт на существующий тип проекта', () => {
  // Таблица — единственное место, где строка из чужого репозитория
  // (`landing/`) превращается в тип проекта; опечатка здесь молча
  // вернула бы мастер на умолчание.
  for (const [entry, type] of Object.entries(ENTRY_PROJECT_TYPES)) {
    assert.equal(projectTypeFromSearch(`?entry=${entry}`), type);
  }
});

it('метка Story‑Tales (stories) не выбирает тип проекта', () => {
  // Р-STL-10: мастера сказки нет, ссылка лендинга ведёт в раздел
  // `#/stories`. Если форму всё-таки открыли с этой меткой — умолчание,
  // а не поздравление или товарный ролик под видом сказки.
  assert.equal(projectTypeFromSearch('?entry=stories'), null);
  assert.equal(
    Object.prototype.hasOwnProperty.call(ENTRY_PROJECT_TYPES, 'stories'),
    false
  );
});

it('метка stories открывает информационный раздел TMA #/stories', () => {
  assert.equal(entryHashRoute('stories'), '/stories');
  assert.deepEqual(parseRoute(`#${entryHashRoute('stories')}`), {
    name: 'stories',
  });
  assert.equal(entryLaunchUrl('/', '', 'stories'), '/?entry=stories#/stories');
});

it('каждая метка — либо тип проекта, либо раздел, ровно одно', () => {
  for (const entry of LANDING_ENTRIES) {
    const hasType = Object.prototype.hasOwnProperty.call(
      ENTRY_PROJECT_TYPES,
      entry
    );
    const hasSection = Object.prototype.hasOwnProperty.call(
      ENTRY_SECTION_ROUTES,
      entry
    );
    assert.notEqual(hasType, hasSection, entry);
    const route = parseRoute(`#${entryHashRoute(entry)}`);
    assert.equal(
      route.name,
      hasSection ? entry : 'project-new',
      `${entry}: ${JSON.stringify(route)}`
    );
  }
});

it('литералы маршрутов меток совпадают с routes из lib/router', () => {
  assert.equal(PROJECT_NEW_ROUTE, routes.projectNew());
  assert.equal(ENTRY_SECTION_ROUTES.stories, routes.product('stories'));
});

it('landing-entry.ts без React: его исполняет проверка лендинга без зависимостей frontend', () => {
  const src = readFileSync(
    new URL('../src/features/projects/landing-entry.ts', import.meta.url),
    'utf8'
  );
  for (const m of src.matchAll(/from\s+'([^']+)'/g)) {
    assert.ok(
      m[1].startsWith('.') && !m[1].endsWith('/router'),
      `landing-entry.ts импортирует ${m[1]}`
    );
  }
});

it('?site= пропускает только абсолютный http(s)-адрес', () => {
  assert.equal(
    siteUrlFromSearch('?site=https://shop.example.com/cabinet'),
    'https://shop.example.com/cabinet'
  );
  assert.equal(
    siteUrlFromSearch('?site=http://example.com/'),
    'http://example.com/'
  );
});

it('?site= с чужой схемой не попадает в поле ввода', () => {
  // Не про безопасность сервера (он проверяет адрес сам), а про то,
  // что человек получил бы непонятный отказ из-за чужой ссылки.
  assert.equal(siteUrlFromSearch('?site=javascript:alert(1)'), null);
  assert.equal(siteUrlFromSearch('?site=file:///etc/passwd'), null);
  assert.equal(
    siteUrlFromSearch('?site=shop.example.com'),
    null,
    'без схемы — не адрес'
  );
  assert.equal(
    siteUrlFromSearch('?entry=site-tutorial'),
    null,
    'параметра нет вовсе'
  );
});

console.log(`\n${passed} проверок пройдено`);
