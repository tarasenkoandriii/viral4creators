import assert from 'node:assert/strict';
import { en } from '../src/kit/dictionaries/en';
import { ru } from '../src/kit/dictionaries/ru';
import { uk } from '../src/kit/dictionaries/uk';
import { fmt, localeFromTelegram, resolveLocale } from '../src/kit/i18n';
import { appEn } from '../src/i18n/en';
import { appRu } from '../src/i18n/ru';
import { appUk } from '../src/i18n/uk';

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
