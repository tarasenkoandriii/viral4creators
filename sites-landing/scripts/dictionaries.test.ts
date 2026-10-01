/**
 * Словари uk/en/ru: паритет формы и плейсхолдеров, утверждения — только
 * из реестра, в словарях нет цен и литерала бренда (§3.0, §3.8, §11).
 *
 *  1. Одинаковые ключи на всех уровнях и одинаковые длины массивов (JSON-
 *     импорт типизирует массивы объединением — пропуск поля в одном
 *     элементе тип не ловит).
 *  2. Поле `claim` совпадает по значению во всех локалях (иначе один язык
 *     обещал бы другое) и есть в `lib/claims.ts`.
 *  3. Набор плейсхолдеров `{x}` в каждой строке одинаков во всех локалях.
 *  4. Ни цен (`$19`, `19 USD`), ни имени бренда литералом — только `{brand}`.
 *  5. Пустые строки — только там, где это осмысленно (`hero.full.note`).
 */
import assert from 'node:assert/strict';
import uk from '../src/dictionaries/uk.json';
import en from '../src/dictionaries/en.json';
import ru from '../src/dictionaries/ru.json';
import { isClaimId } from '../src/lib/claims';
import { placeholders } from '../src/lib/format';
import { BRAND } from '../src/brand';

type Json = unknown;
const dicts: Record<string, Json> = { uk, en, ru };
const problems: string[] = [];
let strings = 0;
let claims = 0;

function walk(path: string, values: Record<string, Json>) {
  const [first, ...rest] = Object.values(values);
  const kinds = Object.entries(values).map(([l, v]) => [l, Array.isArray(v) ? 'array' : typeof v] as const);
  if (new Set(kinds.map((k) => k[1])).size > 1) {
    problems.push(`${path}: разные типы ${kinds.map((k) => k.join('=')).join(', ')}`);
    return;
  }
  void rest;
  if (Array.isArray(first)) {
    const lens = Object.entries(values).map(([l, v]) => [l, (v as Json[]).length] as const);
    if (new Set(lens.map((x) => x[1])).size > 1) {
      problems.push(`${path}: разная длина массива ${lens.map((x) => x.join('=')).join(', ')}`);
      return;
    }
    (first as Json[]).forEach((_, i) => walk(`${path}[${i}]`, Object.fromEntries(Object.entries(values).map(([l, v]) => [l, (v as Json[])[i]]))));
    return;
  }
  if (first && typeof first === 'object') {
    const keySets = Object.entries(values).map(([l, v]) => [l, Object.keys(v as object).sort().join(',')] as const);
    if (new Set(keySets.map((k) => k[1])).size > 1) {
      problems.push(`${path}: разные ключи — ${keySets.map((k) => `${k[0]}: ${k[1]}`).join(' | ')}`);
      return;
    }
    for (const key of Object.keys(first as object)) {
      walk(path ? `${path}.${key}` : key, Object.fromEntries(Object.entries(values).map(([l, v]) => [l, (v as Record<string, Json>)[key]])));
    }
    return;
  }
  if (typeof first === 'string') {
    strings++;
    const all = Object.entries(values) as Array<[string, string]>;
    if (path.endsWith('.claim')) {
      claims++;
      if (new Set(all.map((x) => x[1])).size > 1) problems.push(`${path}: claim расходится по локалям: ${all.map((x) => x.join('=')).join(', ')}`);
      if (!isClaimId(first)) problems.push(`${path}: «${first}» нет в реестре lib/claims.ts`);
      return;
    }
    const ph = all.map(([l, s]) => [l, placeholders(s).join(',')] as const);
    if (new Set(ph.map((x) => x[1])).size > 1) problems.push(`${path}: плейсхолдеры расходятся — ${ph.map((x) => `${x[0]}: {${x[1]}}`).join(' | ')}`);
    for (const [l, s] of all) {
      if (s.trim() === '' && path !== 'assistant.hero.full.note') problems.push(`${path} (${l}): пустая строка`);
      if (/\$\s?\d|\d\s?(USD|₴|грн|UAH|EUR|€)\b/.test(s)) problems.push(`${path} (${l}): цена в словаре — цены только из assist-plans.snapshot.json`);
      if (s.includes(BRAND.name)) problems.push(`${path} (${l}): имя бренда литералом — пишите {brand}`);
    }
  }
}

walk('', dicts as Record<string, Json>);
assert.deepEqual(problems, [], `словари:\n${problems.join('\n')}`);
assert.ok(strings > 300, `подозрительно мало строк: ${strings}`);
assert.ok(claims > 50, `подозрительно мало утверждений: ${claims}`);

// Самопроверка: обходчик действительно ловит расхождения (иначе «нарушений
// нет» могло бы значить «проверка сломана»).
problems.length = 0;
walk('', { uk: { a: 'x {n}', b: [{ claim: 'voice' }] }, en: { a: 'x', b: [{ claim: 'video' }, { claim: 'voice' }] } });
assert.equal(problems.length, 2, `самопроверка: ожидалось 2 нарушения, есть ${problems.join('; ')}`);
problems.length = 0;
walk('', { uk: { a: 'ціна $19' }, en: { a: 'price $19' } });
assert.equal(problems.length, 2, 'самопроверка: цена в словаре не поймана');

console.log(`ok   словари: ${strings} строк × 3 локали, ${claims} утверждений — ключи, плейсхолдеры, claim совпадают; цен и бренда литералом нет`);
