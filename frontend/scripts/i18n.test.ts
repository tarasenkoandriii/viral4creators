/**
 * Мультиязычность фронта (этап 55) — определение и валидация локали.
 * Хранилище (localStorage) и Telegram WebApp здесь не подделываются
 * через DOM-моки: проверяются чистые функции (`isLocale`,
 * `detectTelegramLocale`, `initialLocale` без сохранённого выбора) —
 * ровно то, что можно сломать правкой без браузера под рукой.
 */
import assert from 'node:assert/strict';
import {
  defaultLocale,
  detectTelegramLocale,
  isLocale,
  locales,
} from '../src/lib/i18n';

let passed = 0;
function it(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log('  ✓', name);
}

console.log('i18n (этап 55)');

it('locales — ровно пять языков, включая дефолтный', () => {
  assert.deepEqual([...locales], ['ru', 'uk', 'en', 'de', 'es']);
  assert.equal(defaultLocale, 'ru');
});

it('isLocale — принимает только поддерживаемые коды', () => {
  assert.equal(isLocale('ru'), true);
  assert.equal(isLocale('es'), true);
  assert.equal(isLocale('fr'), false);
  assert.equal(isLocale(''), false);
  assert.equal(isLocale(null), false);
  assert.equal(isLocale(undefined), false);
});

it('detectTelegramLocale — берёт язык из language_code Telegram, если он у нас есть', () => {
  assert.equal(detectTelegramLocale('en'), 'en');
  assert.equal(detectTelegramLocale('de'), 'de');
});

it('detectTelegramLocale — региональный вариант ("en-US") сводится к базовому коду', () => {
  // Telegram иногда передаёт code с регионом (en-US, es-MX) — нам
  // достаточно первых двух букв, полное совпадение не требуется.
  assert.equal(detectTelegramLocale('en-US'), 'en');
  assert.equal(detectTelegramLocale('ES-MX'), 'es');
});

it('detectTelegramLocale — язык, которого нет в списке, не подставляется молча', () => {
  // Например, польский или французский Telegram-клиент — честный null,
  // а не подмена на дефолт внутри самой функции определения (о дефолте
  // заботится initialLocale(), это разные ответственности).
  assert.equal(detectTelegramLocale('fr'), null);
  assert.equal(detectTelegramLocale('pl-PL'), null);
});

it('detectTelegramLocale — без language_code вообще (undefined) — null, не бросает', () => {
  assert.equal(detectTelegramLocale(undefined), null);
});

console.log(`i18n: ${passed} проверок пройдено`);
