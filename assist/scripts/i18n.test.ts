import assert from 'node:assert/strict';
import { en } from '../src/kit/dictionaries/en';
import { ru } from '../src/kit/dictionaries/ru';
import { uk } from '../src/kit/dictionaries/uk';
import { fmt, localeFromTelegram, resolveLocale } from '../src/kit/i18n';
import { appEn } from '../src/i18n/en';
import { appRu } from '../src/i18n/ru';
import { appUk } from '../src/i18n/uk';
import { pubEn } from '../src/i18n/publisher-en';
import { pubRu } from '../src/i18n/publisher-ru';
import { pubUk } from '../src/i18n/publisher-uk';
import { pubContentEn } from '../src/i18n/publisher-content-en';
import { pubContentRu } from '../src/i18n/publisher-content-ru';
import { pubContentUk } from '../src/i18n/publisher-content-uk';

/** Пути ко всем строкам словаря + число элементов массивов. */
function shape(v: unknown, prefix = ''): string[] {
  if (typeof v === 'string') {
    assert.ok(v.trim().length > 0, `пустая строка: ${prefix}`);
    return [prefix];
  }
  if (Array.isArray(v)) {
    return [
      `${prefix}[${v.length}]`,
      ...v.flatMap((x, i) => shape(x, `${prefix}[${i}]`)),
    ];
  }
  assert.ok(v !== null && typeof v === 'object', `не объект: ${prefix}`);
  return Object.keys(v as object)
    .sort()
    .flatMap((k) =>
      shape((v as Record<string, unknown>)[k], prefix ? `${prefix}.${k}` : k)
    );
}

// tsc проверяет ключи типом, но не пустые строки и не длину массивов.
assert.deepEqual(shape(uk), shape(ru));
assert.deepEqual(shape(en), shape(ru));
assert.deepEqual(shape(appUk), shape(appRu));
assert.deepEqual(shape(appEn), shape(appRu));
// AI Publisher (P-G1): оболочка и экраны контента/AI (P-G2 — свои словари).
assert.deepEqual(shape(pubUk), shape(pubRu));
assert.deepEqual(shape(pubEn), shape(pubRu));
assert.deepEqual(shape(pubContentUk), shape(pubContentRu));
assert.deepEqual(shape(pubContentEn), shape(pubContentRu));

// Плейсхолдеры одинаковы во всех языках.
function placeholders(v: unknown): string[] {
  return shape(v).map((p) => {
    const val = p
      .split(/\.|\[(\d+)\]/)
      .filter((x) => x)
      .reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], v);
    return typeof val === 'string'
      ? `${p}:${(val.match(/\{\w+\}/g) ?? []).sort().join(',')}`
      : p;
  });
}
assert.deepEqual(placeholders(uk), placeholders(ru));
assert.deepEqual(placeholders(en), placeholders(ru));
assert.deepEqual(placeholders(appUk), placeholders(appRu));
assert.deepEqual(placeholders(appEn), placeholders(appRu));
assert.deepEqual(placeholders(pubUk), placeholders(pubRu));
assert.deepEqual(placeholders(pubEn), placeholders(pubRu));
// Плейсхолдеры словарей контента (ключи с точками: `pub.helper.answer`) —
// в `publisher-view.test.ts` (там путь не разбирается по точкам).

// Язык по умолчанию — язык Telegram; явный выбор важнее.
assert.equal(resolveLocale(null, 'uk'), 'uk');
assert.equal(resolveLocale(null, 'ru-RU'), 'ru');
assert.equal(resolveLocale(null, 'EN'), 'en');
assert.equal(resolveLocale('ru', 'uk'), 'ru');
assert.equal(resolveLocale('de', 'uk'), 'uk'); // мусор в хранилище игнорируется
assert.equal(resolveLocale(null, 'pl'), 'en'); // язык не из трёх → английский
assert.equal(resolveLocale(null, undefined), 'uk'); // Telegram молчит → украинский
assert.equal(localeFromTelegram(''), null);

assert.equal(fmt('{v} из {n}', { v: 1, n: 3 }), '1 из 3');
assert.equal(fmt('{x} и {y}', { x: 'a' }), 'a и {y}');

console.log('i18n: ok');
