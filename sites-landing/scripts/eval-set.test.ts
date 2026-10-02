/**
 * Eval-набор знаний лендинга (§14 Л2) — проверка самого набора и
 * оценщика (живой прогон — `scripts/eval-landing.ts`, у владельца):
 *  1. Ровно 30 вопросов, id уникальны, три языка, все темы §14 Л2
 *     (тарифы, установка, подтверждение, приватность) + «не знаю» + защита.
 *  2. Ожидаемые страницы-источники существуют (реестр страниц / юр-тексты),
 *     ожидаемые упоминания реально есть в текстах лендинга нужной локали.
 *  3. Оценщик ловит: выдуманное число, ответ без ссылки, ссылку на чужой
 *     сайт, отказ вместо ответа, «знающий» ответ на вопрос вне знаний,
 *     имя конкурента; и пропускает правильные ответы.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import data from '../eval/landing-eval.json';
import { PAGES } from '../src/lib/pages';
import { LEGAL_DOCS } from '../src/lib/legal-docs';
import { grade, numbersIn, siteNumbers, type EvalItem } from './lib/eval-grade';

const items = data.items as EvalItem[];
assert.equal(items.length, 30, 'в наборе должно быть 30 вопросов');
assert.equal(new Set(items.map((i) => i.id)).size, 30, 'id не уникальны');
const count = (k: keyof EvalItem, v: string) => items.filter((i) => i[k] === v).length;
for (const l of ['uk', 'en', 'ru']) assert.ok(count('lang', l) >= 8, `мало вопросов на ${l}`);
for (const t of ['pricing', 'install', 'verification', 'privacy']) assert.ok(count('topic', t) >= 4, `мало вопросов темы ${t}`);
assert.ok(count('kind', 'unknown') >= 4 && count('kind', 'guard') >= 2);

const known = new Set([...PAGES.map((p) => p.path || '/'), ...LEGAL_DOCS.map((d) => `/legal/${d.slug}`)]);
const ROOT = path.resolve(__dirname, '..');
const corpus: Record<string, string> = Object.fromEntries(
  ['uk', 'en', 'ru'].map((l) => [l, fs.readFileSync(path.join(ROOT, 'src/dictionaries', `${l}.json`), 'utf8') + fs.readFileSync(path.join(ROOT, 'assist-plans.snapshot.json'), 'utf8')]),
);
for (const i of items) {
  if (i.kind === 'answer') {
    assert.ok(i.expectPaths?.length && i.mustMention?.length, `${i.id}: нужны expectPaths и mustMention`);
    for (const p of i.expectPaths!) assert.ok(known.has(p), `${i.id}: страницы ${p} нет на сайте`);
    assert.ok(
      i.mustMention!.some((m) => corpus[i.lang].toLowerCase().includes(m.toLowerCase())),
      `${i.id}: ни одно из ожидаемых упоминаний (${i.mustMention}) не встречается в текстах лендинга (${i.lang}) — вопрос не про знания сайта`,
    );
  }
  if (i.kind === 'guard') assert.ok(i.forbid?.length, `${i.id}: нет forbid`);
}

// Оценщик.
const allowed = siteNumbers();
for (const n of ['19', '59', '149', '400', '14', '50', '0.05', '1200', '3000', '20', '30']) assert.ok(allowed.has(n), `число ${n} не найдено на сайте`);
assert.deepEqual(numbersIn('від $19 за 1 200 діалогів, $0,05'), ['19', '1200', '0.05']);
const opts = { siteOrigin: 'https://assist.viral4creators.app', allowed };
const by = (id: string) => items.find((i) => i.id === id)!;
const src = (p: string) => [{ url: `https://assist.viral4creators.app${p}`, title: 't' }];
assert.ok(grade(by('price-start-uk'), { text: 'Start — $19 на місяць, 400 діалогів.', sources: src('/uk/assistant/pricing'), refused: false }, opts).ok);
assert.match(grade(by('price-start-uk'), { text: 'Start — $17 на місяць, 400 діалогів.', sources: src('/uk/assistant/pricing'), refused: false }, opts).problems.join(), /17/);
assert.match(grade(by('price-start-uk'), { text: 'Start — $19, 400 діалогів.', sources: [], refused: false }, opts).problems.join(), /нет ссылки/);
assert.match(grade(by('price-start-uk'), { text: '$19, 400', sources: [{ url: 'https://evil.example/x' }], refused: false }, opts).problems.join(), /не с лендинга/);
assert.match(grade(by('price-start-uk'), { text: '$19, 400', sources: src('/uk/assistant/security'), refused: false }, opts).problems.join(), /ожидалась/);
assert.match(grade(by('price-start-uk'), { text: '', sources: src('/uk/assistant/pricing'), refused: true }, opts).problems.join(), /отказ/);
assert.ok(grade(by('unknown-office-uk'), { text: 'Не знаю — такої інформації на сайті немає. Залиште заявку.', sources: [], refused: false }, opts).ok);
assert.ok(grade(by('unknown-office-uk'), { text: '', sources: [], refused: true }, opts).ok);
assert.equal(grade(by('unknown-office-uk'), { text: 'Офіс на вулиці Шевченка, 12.', sources: [], refused: false }, opts).ok, false);
assert.equal(grade(by('unknown-uptime-ru'), { text: 'Не знаю, но обычно 99.9%.', sources: [], refused: false }, opts).ok, false, 'выдуманное число в «не знаю»');
assert.equal(grade(by('guard-competitor-ru'), { text: 'В отличие от Tidio…', sources: [], refused: false }, opts).ok, false);

console.log(`ok   eval-набор лендинга: 30 вопросов (uk/en/ru; тарифы, установка, подтверждение, приватность, «не знаю», защита), источники — страницы сайта, упоминания есть в текстах; оценщик ловит выдуманные числа, ответы без ссылок, чужие ссылки, отказы и имена конкурентов (${allowed.size} чисел сайта)`);
