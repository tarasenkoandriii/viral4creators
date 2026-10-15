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
 *  6. Р-З15-1: `getDictionary()` отдаёт строки с подставленным именем на
 *     языке страницы — ни `{brand}`, ни заглушки `<бренд>`; замены
 *     `brandFallback` указывают на существующие строки с `{brand}`.
 *  7. Падеж (uk/ru): родовое имя не склоняется, поэтому `{brand}` без замены
 *     в `brandFallback` допустим только там, где он в именительном падеже
 *     или имя сайта: в начале строки, после «— », после «© {year} » или в
 *     лапках «…». То же — в юр-черновиках и uk-документации (`%%brand%%`).
 */
import assert from 'node:assert/strict';
import uk from '../src/dictionaries/uk.json';
import en from '../src/dictionaries/en.json';
import ru from '../src/dictionaries/ru.json';
import { isClaimId } from '../src/lib/claims';
import { placeholders } from '../src/lib/format';
import { BRAND, BRAND_FALLBACK_NAMES, BRAND_IS_PLACEHOLDER, brandDisplayName } from '../src/brand';
import fs from 'node:fs';
import path from 'node:path';
import { applyBrandFallback, getDictionary, trimBrandSuffix, type Dictionary } from '../src/lib/get-dictionary';
import { locales } from '../src/lib/i18n';

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

// 6. Имя на языке страницы (Р-З15-1).
const allStrings = (o: unknown, out: string[] = []): string[] => {
  if (typeof o === 'string') out.push(o);
  else if (Array.isArray(o)) o.forEach((v) => allStrings(v, out));
  else if (o && typeof o === 'object') Object.values(o).forEach((v) => allStrings(v, out));
  return out;
};
assert.deepEqual(Object.keys(BRAND_FALLBACK_NAMES).sort(), [...locales].sort(), 'родовое имя — на каждую локаль');
let fallbacks = 0;
for (const locale of locales) {
  const name = brandDisplayName(locale);
  assert.ok(name && name !== '<бренд>' && !name.includes('<'), `${locale}: публичное имя — заглушка`);
  if (BRAND_IS_PLACEHOLDER) assert.equal(name, BRAND_FALLBACK_NAMES[locale]);
  const dict = getDictionary(locale);
  const texts = allStrings(dict);
  const leaks = texts.filter((t) => t.includes('{brand}') || t.includes('<бренд>'));
  assert.deepEqual(leaks, [], `${locale}: после getDictionary остались {brand}/<бренд>`);
  assert.ok(dict.common.nav.home.startsWith(name), `${locale}: имя не подставлено (nav.home)`);
  // Замены не устарели (applyBrandFallback бросает на пропавшем пути и строке без {brand}).
  applyBrandFallback(({ uk, en, ru } as Record<string, Dictionary>)[locale], locale);
  fallbacks = Object.keys(dict.brandFallback).length;
  // Тавтологии «ШІ-помічника ШІ-помічник для сайту» нет: родовое имя не стоит сразу после слова «помічник/помощник/assistant».
  if (BRAND_IS_PLACEHOLDER) {
    const tautology = texts.filter((t) => new RegExp(`(помічника?|помощника?|assistant)\\s+«?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(t));
    assert.deepEqual(tautology, [], `${locale}: родовое имя сразу после «помічник/помощник/assistant»`);
  }
}
const brandProblems: string[] = [];
// Заголовок страницы, который уже называет помощника, не повторяет имя суффиксом.
if (BRAND_IS_PLACEHOLDER) {
  for (const locale of locales) {
    const name = brandDisplayName(locale);
    for (const [k, v] of Object.entries(getDictionary(locale).pages)) {
      if (v.title.endsWith(` — ${name}`) && /помічник|помощник|assistant/i.test(v.title.slice(0, -name.length - 3))) {
        brandProblems.push(`pages.${k}.title (${locale}): тавтология «${v.title}»`);
      }
    }
  }
}
assert.equal(trimBrandSuffix('Пілот ШІ-помічника — {brand}'), 'Пілот ШІ-помічника');
assert.equal(trimBrandSuffix('Безпека і приватність — {brand}'), 'Безпека і приватність — {brand}');

// 7. Падеж: где может стоять несклоняемое имя.
const nominativeSlot = (s: string, token: string): boolean => {
  let i = s.indexOf(token);
  while (i >= 0) {
    const pre = s.slice(0, i);
    const post = s.slice(i + token.length);
    const ok = i === 0 || pre.endsWith('— ') || pre.endsWith('© {year} ') || (pre.endsWith('«') && post.startsWith('»'));
    if (!ok) return false;
    i = s.indexOf(token, i + token.length);
  }
  return true;
};
const caseIssues = (dict: Record<string, unknown>, locale: string): string[] => {
  const out: string[] = [];
  const fb = dict.brandFallback as Record<string, string>;
  const walkCase = (o: unknown, p: string) => {
    if (typeof o === 'string') {
      if (o.includes('{brand}') && !(p in fb) && !nominativeSlot(o, '{brand}')) out.push(`${p} (${locale}): «${o.slice(0, 70)}…» — {brand} в косвенном падеже, нужна строка в brandFallback`);
    } else if (Array.isArray(o)) o.forEach((v, i) => walkCase(v, `${p}.${i}`));
    else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) if (!(p === '' && k === 'brandFallback')) walkCase(v, p ? `${p}.${k}` : k);
  };
  walkCase(dict, '');
  for (const [p, v] of Object.entries(fb)) if (!nominativeSlot(v, '{brand}')) out.push(`brandFallback.${p} (${locale}): {brand} в косвенном падеже`);
  return out;
};
for (const [locale, dict] of [['uk', uk], ['ru', ru]] as const) brandProblems.push(...caseIssues(dict as unknown as Record<string, unknown>, locale));
const ROOT = path.join(__dirname, '..');
for (const f of fs.readdirSync(path.join(ROOT, 'legal'))) {
  if (!nominativeSlot(fs.readFileSync(path.join(ROOT, 'legal', f), 'utf8'), '{brand}')) brandProblems.push(`legal/${f}: {brand} в косвенном падеже`);
}
for (const f of fs.readdirSync(path.join(ROOT, 'docs', 'assistant', 'uk'))) {
  if (!nominativeSlot(fs.readFileSync(path.join(ROOT, 'docs', 'assistant', 'uk', f), 'utf8'), '%%brand%%')) brandProblems.push(`docs/assistant/uk/${f}: %%brand%% в косвенном падеже`);
}
assert.deepEqual(brandProblems, [], `имя бренда:\n${brandProblems.join('\n')}`);
// Самопроверка эвристики падежа.
assert.equal(caseIssues({ a: 'Бот обходу {brand}', b: '{brand} — ок', c: 'X — {brand}', d: 'на «{brand}»', e: '© {year} {brand}', brandFallback: {} }, 'uk').length, 1);
assert.equal(caseIssues({ a: 'Бот обходу {brand}', brandFallback: { a: 'Бот обходу помічника' } }, 'uk').length, 0);

// Самопроверка: устаревшая замена — ошибка, а не тихая правка чужого текста.
assert.throws(() => applyBrandFallback({ ...uk, brandFallback: { 'common.skipLink': 'x' } } as unknown as Dictionary, 'uk'), /нет \{brand\}/);
assert.throws(() => applyBrandFallback({ ...uk, brandFallback: { 'no.such.path': 'x' } } as unknown as Dictionary, 'uk'), /нет строки/);

console.log(`ok   словари: ${strings} строк × 3 локали, ${claims} утверждений — ключи, плейсхолдеры, claim совпадают; цен и бренда литералом нет; имя на языке страницы без {brand}/<бренд> (${fallbacks} замен brandFallback × 3)`);
