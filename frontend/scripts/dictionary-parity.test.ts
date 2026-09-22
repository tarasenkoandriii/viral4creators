/**
 * Пять словарей интерфейса должны описывать ОДИН И ТОТ ЖЕ набор
 * ключей.
 *
 * Почему это не ловится типами и потому нужен тест. `get-dictionary.ts`
 * приводит каждый словарь к `Dictionary` через `as`:
 *
 *     uk: uk as Dictionary,
 *
 * Приведение — осознанное (у ru/uk четыре числовые формы, у en/de/es
 * две, буквальный тип требовал бы от английского несуществующих форм),
 * но у него есть цена: `as` отключает структурную проверку целиком, а
 * не только для числовых форм. Ключ, забытый в одной локали, компилятор
 * пропускает молча — и на экране появляется пустое место там, где
 * должен быть текст. Проверено: удаление ключа из `de.json` не даёт ни
 * одной ошибки `tsc`.
 *
 * Расхождения ВНУТРИ числовых форм разрешены — это устройство языков, а
 * не расхождение данных. Узнаются они структурно (объект, все ключи
 * которого — категории `Intl.LDMLPluralRule`), а не списком путей:
 * список пришлось бы дописывать руками при каждом новом счётчике, а
 * забытая строчка в таком списке — это ровно та же молчаливая дыра,
 * которую тест закрывает.
 *
 * Проверено «обратным ходом»: с удалённым ключом `videoOpen` в de.json
 * тест падает и называет и локаль, и полный путь ключа.
 *
 * Запуск: `npm test` во frontend.
 */

import assert from 'node:assert/strict';
import ru from '../src/dictionaries/ru.json';
import uk from '../src/dictionaries/uk.json';
import en from '../src/dictionaries/en.json';
import de from '../src/dictionaries/de.json';
import es from '../src/dictionaries/es.json';

let passed = 0;
function it(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log('  ✓', name);
}

const PLURAL_CATEGORIES = new Set([
  'zero',
  'one',
  'two',
  'few',
  'many',
  'other',
]);

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

function isPlainObject(v: Json): v is { [k: string]: Json } {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Объект числовых форм: непустой и состоит ТОЛЬКО из категорий LDML. */
function isPluralForms(v: { [k: string]: Json }): boolean {
  const keys = Object.keys(v);
  return keys.length > 0 && keys.every((k) => PLURAL_CATEGORIES.has(k));
}

/** Все пути ключей словаря, кроме внутренностей числовых форм. */
function keyPaths(value: Json, prefix = ''): string[] {
  if (!isPlainObject(value)) return [];
  if (isPluralForms(value)) return [];
  const out: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    out.push(path);
    out.push(...keyPaths(child, path));
  }
  return out;
}

const reference = keyPaths(ru as unknown as Json);
const others: Array<[string, Json]> = [
  ['uk', uk as unknown as Json],
  ['en', en as unknown as Json],
  ['de', de as unknown as Json],
  ['es', es as unknown as Json],
];

console.log('dictionary-parity');

it('ru не пуст и разбирается — иначе тест ниже проверял бы пустоту', () => {
  assert.ok(
    reference.length > 500,
    `ожидались сотни ключей, найдено ${reference.length}`
  );
});

for (const [locale, dict] of others) {
  it(`${locale}: ни одного ключа не потеряно относительно ru`, () => {
    const present = new Set(keyPaths(dict));
    const missing = reference.filter((p) => !present.has(p));
    assert.deepEqual(
      missing,
      [],
      `в ${locale}.json нет ключей: ${missing.slice(0, 10).join(', ')}${
        missing.length > 10 ? ` … и ещё ${missing.length - 10}` : ''
      }`
    );
  });

  it(`${locale}: нет ключей, которых нет в ru — забытый мусор тоже расхождение`, () => {
    const referenceSet = new Set(reference);
    const extra = keyPaths(dict).filter((p) => !referenceSet.has(p));
    assert.deepEqual(
      extra,
      [],
      `в ${locale}.json лишние ключи: ${extra.slice(0, 10).join(', ')}`
    );
  });
}

console.log(`\n${passed} проверок пройдено`);
