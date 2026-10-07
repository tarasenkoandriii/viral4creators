/**
 * Секция «Сравнение» на странице поздравлений (§5.5 и В-8 ТЗ
 * `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md`; обзор рынка —
 * `docs-tz/OBZOR-Konkurentov-Greetings.md`).
 *
 * Четыре группы проверок:
 *
 *  1. Выключатель. `COMPARE_SECTION_ENABLED` — `false` (факты о рынке
 *     подтверждает владелец); при `false` секции нет в
 *     `greetingSectionOrder()`, страница читает тексты раздела только в
 *     своей строке таблицы секций, а клиентский словарь (он
 *     сериализуется в HTML каждой страницы) раздела не содержит.
 *  2. Ключи: раздел `greetingsLanding.compare` одной формы во всех пяти
 *     локалях, ни одной пустой строки, у каждой строки таблицы — все
 *     четыре колонки.
 *  3. Правила сравнения: ни одного названия компании из обзора и ни
 *     одной цены — сравниваем с КАТЕГОРИЯМИ; о себе — только то, что
 *     сверено с кодом бэкенда (15 секунд, до 4 сцен, пять языков,
 *     свой голос с Standard).
 *  4. Включить есть что: при `true` секция встаёт перед «Ценой», а
 *     настоящий компонент рисует все тексты раздела во всех локалях.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { clientDictionary, getDictionary } from '../src/lib/get-dictionary';
import { locales } from '../src/lib/i18n';
import {
  COMPARE_SECTION_ENABLED,
  GREETING_SECTIONS,
  greetingSectionOrder,
} from '../src/lib/greeting-sections';

const greetingsDir = path.join(
  __dirname,
  '..',
  'src',
  'app',
  '[locale]',
  'greetings',
);
const pageSrc = fs.readFileSync(path.join(greetingsDir, 'page.tsx'), 'utf8');
const componentSrc = fs.readFileSync(
  path.join(greetingsDir, 'CompareSection.tsx'),
  'utf8',
);

// ── 1. Выключатель ──
assert.equal(
  COMPARE_SECTION_ENABLED,
  false,
  'COMPARE_SECTION_ENABLED включена. Включать — после того, как владелец подтвердил факты обзора docs-tz/OBZOR-Konkurentov-Greetings.md; тогда поменяйте и этот assert',
);
assert.ok(
  GREETING_SECTIONS.includes('compare'),
  'идентификатора compare нет в GREETING_SECTIONS',
);
for (const persona of [false, true]) {
  assert.ok(
    !greetingSectionOrder(persona, false).includes('compare'),
    'выключенное «Сравнение» осталось в списке секций',
  );
  const on = greetingSectionOrder(persona, true);
  assert.equal(
    on[on.indexOf('compare') + 1],
    'price',
    'включённое «Сравнение» должно стоять прямо перед «Ценой»',
  );
  assert.deepEqual(
    greetingSectionOrder(persona, false),
    on.filter((id) => id !== 'compare'),
    'выключенное «Сравнение» должно просто выпадать, не меняя порядок остальных',
  );
}
assert.equal(
  greetingSectionOrder().includes('compare'),
  COMPARE_SECTION_ENABLED,
  'greetingSectionOrder() по умолчанию не следует COMPARE_SECTION_ENABLED',
);

// Страница: строка секции — настоящий компонент с текстами раздела, и
// это единственное место, где страница их читает.
const compareRenderer = /^\s{4}compare: (.+),$/m.exec(pageSrc)?.[1];
assert.equal(
  compareRenderer,
  '() => <CompareSection texts={g.compare} />',
  'в таблице секций page.tsx строка compare — не CompareSection с текстами раздела',
);
assert.deepEqual(
  pageSrc.match(/\bg\.compare\b[.\w]*/g),
  ['g.compare'],
  'page.tsx читает greetingsLanding.compare мимо строки секции — выключатель не сработает',
);
const pageCode = pageSrc
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
assert.doesNotMatch(
  pageCode,
  /greetingsLanding\s*(\??\.\s*compare|\[\s*['"`]compare)/,
  'page.tsx читает greetingsLanding.compare напрямую',
);
assert.doesNotMatch(
  pageSrc,
  /id="compare"|id=\{?['"]compare|className="compare-table/,
  'разметка «Сравнения» прописана в странице напрямую, мимо компонента',
);
const metaSrc = /export function generateMetadata[\s\S]*?\n\}\n/.exec(
  pageSrc,
)?.[0];
assert.ok(metaSrc, 'в page.tsx не нашёлся generateMetadata');
assert.doesNotMatch(metaSrc, /compare/, 'метаданные читают тексты «Сравнения»');
assert.doesNotMatch(
  componentSrc,
  /^\s*['"]use client['"]/m,
  'CompareSection — серверный компонент: клиентский унёс бы тексты в данные страницы',
);

/** Все строки значения. */
function strings(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap(strings);
  if (v && typeof v === 'object') return Object.values(v).flatMap(strings);
  return [];
}

/** Форма значения: строки → 's', массивы — с длиной. */
function shape(v: unknown): unknown {
  if (typeof v === 'string') return 's';
  if (Array.isArray(v)) return v.map(shape);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, shape((v as Record<string, unknown>)[k])]),
    );
  }
  return typeof v;
}

// ── 3. Факты о нас — из кода бэкенда ──
const backend = (rel: string) =>
  fs.readFileSync(
    path.join(__dirname, '..', '..', 'backend', 'src', ...rel.split('/')),
    'utf8',
  );
function numberOf(src: string, re: RegExp, what: string): number {
  const m = re.exec(src);
  assert.ok(m, `в коде бэкенда не нашлось: ${what}`);
  return Number(m[1]);
}
const DURATION = numberOf(
  backend('modules/greeting-video/greeting-video.service.ts'),
  /const GREETING_VIDEO_DURATION_SECONDS = (\d+);/,
  'GREETING_VIDEO_DURATION_SECONDS',
);
const SCENES = numberOf(
  backend('common/greeting-scenes.ts'),
  /export const MAX_GREETING_SCENES = (\d+);/,
  'MAX_GREETING_SCENES',
);
assert.match(
  backend('common/locale.ts'),
  /export const SUPPORTED_LOCALES = \['ru', 'uk', 'en', 'de', 'es'\] as const;/,
  'языки поздравления больше не ru/uk/en/de/es — поправьте строку «Язык» в таблице',
);
assert.match(
  backend('common/greeting-language.ts'),
  /export const GREETING_SCRIPT_LANGUAGES = SUPPORTED_LOCALES;/,
  'языки сценария поздравления больше не SUPPORTED_LOCALES',
);
assert.match(
  backend('common/plans.ts'),
  /LITE: \{[\s\S]*?voiceCloning: false,[\s\S]*?STANDARD: \{/,
  'voiceCloning больше не закрыт на LITE — поправьте «Standard» в строке голоса',
);

/** Названия языков в строке «Язык» нашей колонки — по локалям. */
const LANGUAGE_NAMES: Record<string, RegExp[]> = {
  ru: [/русск/i, /украинск/i, /английск/i, /немецк/i, /испанск/i],
  uk: [/російськ/i, /українськ/i, /англійськ/i, /німецьк/i, /іспанськ/i],
  en: [/russian/i, /ukrainian/i, /english/i, /german/i, /spanish/i],
  de: [/russisch/i, /ukrainisch/i, /englisch/i, /deutsch/i, /spanisch/i],
  es: [/ruso/i, /ucraniano/i, /inglés/i, /alemán/i, /español/i],
};

/**
 * Названия из обзора — на странице их быть не должно ни в одной
 * локали: сравнение только с категориями (решение ТЗ образца §8 и этого
 * захода — юридическое ревью прямого сравнения не проводилось).
 */
const COMPANY_NAMES =
  /cameo|memmo|heygen|synthesia|hedra|vidday|portable north pole|\bpnp\b|santacard|pippit|capcut|slide-?life|selebrus|поздравус|pozdravus|tribute|jacquie|smilebox|animoto/i;
/** Цены и валюты: «$5», «890 ₽», «€10», «20 грн», «USD». */
const PRICE =
  /[$€₽£₴]|\b(usd|eur|rub|uah)\b|\d\s*(грн|руб|долл|евро|dollar|euro)/i;

// Номера строк таблицы, на которые опираются проверки фактов.
const ROW = {
  language: 2,
  voice: 4,
  format: 5,
  price: 6,
  delivery: 7,
} as const;

const ru = getDictionary('ru').greetingsLanding.compare;
const reference = shape(ru);

for (const locale of locales) {
  const dict = getDictionary(locale);
  const t = dict.greetingsLanding.compare;

  // ── 2. Ключи ──
  assert.deepEqual(
    shape(t),
    reference,
    `${locale}: форма compare разошлась с ru`,
  );
  assert.equal(t.rows.length, 8, `${locale}: строк сравнения не 8`);
  assert.deepEqual(
    Object.keys(t.columns).sort(),
    ['generic', 'person', 'template', 'us'],
    `${locale}: колонки — мы и три категории`,
  );
  for (const row of t.rows) {
    assert.deepEqual(
      Object.keys(row).sort(),
      ['feature', 'generic', 'person', 'template', 'us'],
      `${locale}: в строке «${row.feature}» не все колонки`,
    );
  }
  for (const text of strings(t)) {
    assert.ok(text.trim().length > 0, `${locale}: пустая строка в compare`);
    assert.doesNotMatch(
      text,
      COMPANY_NAMES,
      `${locale}: название компании в «Сравнении» — сравнение только с категориями\n  «${text}»`,
    );
    assert.doesNotMatch(
      text,
      PRICE,
      `${locale}: цена в «Сравнении» — чужие цены на страницу не выносим\n  «${text}»`,
    );
  }

  // ── 3. Факты о нас ──
  const us = (i: number) => t.rows[i].us;
  assert.ok(
    new RegExp(`(^|\\D)${DURATION}(\\D|$)`).test(us(ROW.format)),
    `${locale}: строка «Формат» не называет ${DURATION} с — GREETING_VIDEO_DURATION_SECONDS`,
  );
  assert.ok(
    new RegExp(`(^|\\D)${SCENES}(\\D|$)`).test(us(ROW.format)),
    `${locale}: строка «Формат» не называет ${SCENES} сцены — MAX_GREETING_SCENES`,
  );
  for (const name of LANGUAGE_NAMES[locale]) {
    assert.match(
      us(ROW.language),
      name,
      `${locale}: строка «Язык» без ${name}`,
    );
  }
  assert.match(
    us(ROW.voice),
    /Standard/,
    `${locale}: свой голос — с режима Standard`,
  );
  // Цена «сейчас»: режимы бесплатны, пока выключен PLANS_BILLING_ENABLED.
  // Без «сейчас» строка станет неправдой в день включения биллинга.
  assert.match(
    us(ROW.price),
    /сейчас|зараз|for now|derzeit|por ahora/i,
    `${locale}: строка «Цена» без оговорки «сейчас»`,
  );
  // Наш проигрыш должен остаться видимым: отложенной доставки нет.
  assert.match(
    us(ROW.delivery),
    /пока нет|поки немає|not yet|noch nicht|aún no/i,
    `${locale}: строка «Доставка» — наш проигрыш, его нельзя переписать в «да»`,
  );

  // ── 1. Клиентский словарь без раздела ──
  const client = clientDictionary(dict);
  assert.ok(
    !('compare' in client.greetingsLanding),
    `${locale}: clientDictionary оставил greetingsLanding.compare`,
  );
  const clientJson = JSON.stringify(client);
  for (const text of strings(t).filter((x) => x.length >= 40)) {
    assert.ok(
      !clientJson.includes(text),
      `${locale}: текст «Сравнения» попал в клиентский словарь\n  «${text}»`,
    );
  }
}

/** Экранирование текста так, как его выводит React. */
function html(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// ── 4. Рендер настоящего компонента (глобальный React — см. тест секций) ──
(globalThis as { React?: typeof React }).React = React;

async function checkRender(): Promise<void> {
  const { CompareSection } = await import(
    '../src/app/[locale]/greetings/CompareSection'
  );
  for (const locale of locales) {
    const t = getDictionary(locale).greetingsLanding.compare;
    const markup = renderToStaticMarkup(
      React.createElement(CompareSection, { texts: t }),
    );
    assert.match(
      markup,
      /^<section class="compare" id="compare">/,
      `${locale}: секция «Сравнение» не отрисовалась`,
    );
    assert.equal(
      markup.match(/<th scope="col">/g)?.length,
      4,
      `${locale}: в шапке не четыре колонки`,
    );
    assert.equal(
      markup.match(/<td data-label=/g)?.length,
      t.rows.length * 4,
      `${locale}: не у каждой ячейки есть data-label (карточная раскладка на телефоне)`,
    );
    for (const text of strings(t)) {
      assert.ok(
        markup.includes(html(text)),
        `${locale}: секция не вывела текст раздела\n  «${text}»`,
      );
    }
  }
}

checkRender()
  .then(() =>
    console.log(
      `greeting-compare: ok (${locales.length} локалей одной формы; ` +
        `строк ${ru.rows.length}; «Сравнение» ${
          COMPARE_SECTION_ENABLED
            ? 'включено'
            : 'выключено и отсутствует в разметке'
        })`,
    ),
  )
  .catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
