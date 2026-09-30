/**
 * Секция «Вы в кадре» на странице поздравлений: пока константа
 * `PERSONA_SECTION_ENABLED` выключена, секции нет в разметке (этап H ТЗ
 * `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md` §5.2 п.5, §8.4).
 *
 * Страница рисует секции только из `greetingSectionOrder()`, поэтому
 * «нет в разметке» проверяется в двух местах: список не содержит
 * `persona`, и страница не рисует ничего мимо этого списка (разметку
 * секции нельзя вписать в `<main>` рядом с циклом, обойдя константу).
 *
 * Этап J: секция построена заранее (`PersonaSection.tsx`, тексты
 * `greetingsLanding.persona` в пяти словарях, схема `greet-persona.svg`),
 * но константа выключена. Отсюда три группы проверок:
 *
 *  1. Выключено — значит нигде: секции нет в списке, «Данные» — ровно
 *     `privacy.items`, клиентский словарь (он сериализуется в HTML каждой
 *     страницы) — без раздела `persona`, метаданные раздел не читают.
 *  2. Сама константа — `false`. Включающий меняет этот assert руками, в
 *     том же коммите, что и `PERSONA_ENABLED` на проде: случайный флип
 *     константы тест не пропустит.
 *  3. Включить есть что: при `true` список даёт `persona`, а секция
 *     рисуется во всех пяти локалях со всеми текстами раздела — рендер
 *     настоящего компонента, не сверка исходника.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { clientDictionary, getDictionary } from '../src/lib/get-dictionary';
import { locales } from '../src/lib/i18n';
import {
  GREETING_SECTIONS,
  PERSONA_SECTION_ENABLED,
  greetingPrivacyItems,
  greetingSectionOrder,
} from '../src/lib/greeting-sections';

const pageSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'app', '[locale]', 'greetings', 'page.tsx'),
  'utf8',
);

// Порядок §5.2: hero, витрина, как это работает, поводы, [вы в кадре],
// возможности, для кого, данные, цена, FAQ, финальный CTA.
assert.deepEqual(
  [...GREETING_SECTIONS],
  [
    'hero',
    'samples',
    'how',
    'occasions',
    'persona',
    'features',
    'audience',
    'privacy',
    'price',
    'faq',
    'finalCta',
  ],
  'порядок секций разошёлся с §5.2 ТЗ',
);
assert.ok(greetingSectionOrder(true).includes('persona'));
assert.ok(!greetingSectionOrder(false).includes('persona'));
assert.deepEqual(
  greetingSectionOrder(false),
  GREETING_SECTIONS.filter((id) => id !== 'persona'),
  'выключенная секция должна просто выпадать, не меняя порядок остальных',
);

// Страница строит <main> только циклом по списку секций.
const main = /<main id="top" className="greeting-page">([\s\S]*?)<\/main>/.exec(
  pageSrc,
)?.[1];
assert.ok(
  main,
  'в page.tsx не нашёлся <main className="greeting-page"> — поправьте регулярку теста',
);
assert.match(
  main,
  /greetingSectionOrder\(\)\.map\(/,
  '<main> должен строиться из greetingSectionOrder()',
);
assert.doesNotMatch(
  main.replace(
    /\{greetingSectionOrder\(\)\.map\(\(id\) => \([\s\S]*?\)\)\}/,
    '',
  ),
  /<section|<[A-Z]/,
  'в <main> есть разметка мимо списка секций — её не выключит константа',
);
assert.doesNotMatch(
  pageSrc,
  /id="persona"|id=\{?['"]persona/,
  'разметка секции persona прописана в странице напрямую',
);

// Группы поводов — `div role="group"`, не `<section>`: общий
// `section:not(.hero)` в globals.css даёт каждой секции отступ 64px и
// линейку сверху, и группы внутри секции «Поводы» разъезжались бы на
// сотни пикселей, заодно став лишними ориентирами `region`.
const groupsSrc = fs.readFileSync(
  path.join(
    __dirname,
    '..',
    'src',
    'app',
    '[locale]',
    'greetings',
    'OccasionGroups.tsx',
  ),
  'utf8',
);
assert.doesNotMatch(
  groupsSrc,
  /<section\b/,
  'OccasionGroups.tsx: группа поводов стала <section> — унаследует отступы секции страницы',
);

// ── 2. Константа выключена: юридический шлюз §4.10 не пройден ──
assert.equal(
  PERSONA_SECTION_ENABLED,
  false,
  'PERSONA_SECTION_ENABLED включена. Включать — только после юридического шлюза и вместе с PERSONA_ENABLED на проде (§5.2 п.5, §5.4); тогда поменяйте и этот assert',
);

// ── Строка секции в таблице page.tsx — настоящая отрисовка ──
const personaRenderer = /^\s{4}persona: (.+),$/m.exec(pageSrc)?.[1];
assert.equal(
  personaRenderer,
  '() => <PersonaSection texts={g.persona} />',
  'в таблице секций page.tsx строка persona — не PersonaSection с текстами раздела',
);

// Тексты раздела страница читает в двух местах, и оба за константой:
// строка секции (её вызывает только greetingSectionOrder) и дополнения
// к «Данным» через greetingPrivacyItems.
assert.deepEqual(
  pageSrc.match(/\bg\.persona\b[.\w]*/g),
  ['g.persona', 'g.persona.privacy'],
  'page.tsx читает greetingsLanding.persona мимо двух выключаемых мест',
);
// Прямой доступ мимо `g` (`dict.greetingsLanding.persona`,
// `getDictionary(l).greetingsLanding['persona']`) — тоже обход.
// Комментарии вырезаются: в них имя раздела упоминается законно.
const pageCode = pageSrc
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
assert.doesNotMatch(
  pageCode,
  /greetingsLanding\s*(\??\.\s*persona|\[\s*['"`]persona)/,
  'page.tsx читает greetingsLanding.persona напрямую, мимо выключаемых мест',
);
assert.match(
  pageSrc,
  /greetingPrivacyItems\(g\.privacy\.items, g\.persona\.privacy\)/,
  'дополнения «Лицо» / «Голос» должны идти через greetingPrivacyItems',
);
assert.doesNotMatch(
  pageSrc,
  /g\.privacy\.items\.map/,
  '«Данные» рисуются мимо greetingPrivacyItems — выключатель не сработает',
);
const metaSrc = /export function generateMetadata[\s\S]*?\n\}\n/.exec(
  pageSrc,
)?.[0];
assert.ok(metaSrc, 'в page.tsx не нашёлся generateMetadata');
assert.doesNotMatch(
  metaSrc,
  /persona/,
  'метаданные (title, description, OG) читают тексты «Вы в кадре»',
);

const personaSrc = fs.readFileSync(
  path.join(
    __dirname,
    '..',
    'src',
    'app',
    '[locale]',
    'greetings',
    'PersonaSection.tsx',
  ),
  'utf8',
);
assert.doesNotMatch(
  personaSrc,
  /^\s*['"]use client['"]/m,
  'PersonaSection — серверный компонент: клиентский унёс бы тексты в данные страницы',
);

// ── 1. Клиентский словарь без раздела persona ──
// Провайдер словаря в layout — клиентский компонент: всё, что ему
// передано, лежит в HTML каждой страницы (RSC-данные).
const layoutSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'app', '[locale]', 'layout.tsx'),
  'utf8',
);
assert.match(
  layoutSrc,
  /<DictionaryProvider dict=\{clientDictionary\(dict\)\}/,
  'layout.tsx отдаёт клиентскому провайдеру словарь целиком — тексты «Вы в кадре» уйдут в HTML',
);

/** Все строки значения — для поиска утечек. */
function strings(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap(strings);
  if (v && typeof v === 'object') return Object.values(v).flatMap(strings);
  return [];
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

for (const locale of locales) {
  const dict = getDictionary(locale);
  const g = dict.greetingsLanding;
  const client = clientDictionary(dict);
  assert.ok(
    !('persona' in client.greetingsLanding),
    `${locale}: clientDictionary оставил greetingsLanding.persona`,
  );
  const clientJson = JSON.stringify(client);
  for (const text of strings(g.persona).filter((t) => t.length >= 40)) {
    assert.ok(
      !clientJson.includes(text),
      `${locale}: текст «Вы в кадре» попал в клиентский словарь\n  «${text}»`,
    );
  }
  // Остальной словарь клиент получает целиком — вырезка ничего не задела.
  assert.deepEqual(
    {
      ...client,
      greetingsLanding: { ...client.greetingsLanding, persona: g.persona },
    },
    dict,
    `${locale}: clientDictionary изменил что-то кроме раздела persona`,
  );

  // «Данные»: выключено — ровно свои пункты; включено — плюс лицо и голос.
  assert.deepEqual(
    greetingPrivacyItems(g.privacy.items, g.persona.privacy, false),
    g.privacy.items,
    `${locale}: при выключенной секции в «Данных» есть лишние пункты`,
  );
  assert.deepEqual(
    greetingPrivacyItems(g.privacy.items, g.persona.privacy, true),
    [...g.privacy.items, ...g.persona.privacy],
    `${locale}: при включённой секции «Лицо» и «Голос» не дописались в конец`,
  );
  assert.deepEqual(
    greetingPrivacyItems(g.privacy.items, g.persona.privacy),
    PERSONA_SECTION_ENABLED
      ? [...g.privacy.items, ...g.persona.privacy]
      : g.privacy.items,
    `${locale}: greetingPrivacyItems по умолчанию не следует константе`,
  );
}

// ── 3. Флип: при включённой константе секция рисуется во всех локалях ──
// Список: `persona` встаёт ровно после «Поводов» (§5.2 п.5).
{
  const on = greetingSectionOrder(true);
  assert.equal(on[on.indexOf('occasions') + 1], 'persona');
}

// Рендер настоящего компонента. tsx собирает JSX классическим
// преобразованием (`React.createElement`), а компонент, как принято в
// Next, `React` не импортирует — отсюда глобальный `React` и импорт
// компонента ПОСЛЕ него.
(globalThis as { React?: typeof React }).React = React;

async function checkRender(): Promise<void> {
  const { PersonaSection } =
    await import('../src/app/[locale]/greetings/PersonaSection');
  for (const locale of locales) {
    const t = getDictionary(locale).greetingsLanding.persona;
    const markup = renderToStaticMarkup(
      React.createElement(PersonaSection, { texts: t }),
    );
    assert.match(
      markup,
      /^<section class="persona" id="persona">/,
      `${locale}: секция «Вы в кадре» не отрисовалась`,
    );
    assert.ok(
      markup.includes('src="/illustrations/greet-persona.svg"'),
      `${locale}: в секции нет схемы greet-persona.svg`,
    );
    // Всё, кроме дополнений к «Данным», — в самой секции; дополнения —
    // только в «Данных».
    const { privacy, ...own } = t;
    for (const text of strings(own)) {
      assert.ok(
        markup.includes(html(text)),
        `${locale}: секция не вывела текст раздела\n  «${text}»`,
      );
    }
    for (const text of strings(privacy).filter((x) => x.length >= 40)) {
      assert.ok(
        !markup.includes(html(text)),
        `${locale}: дополнение к «Данным» выведено в секции «Вы в кадре»`,
      );
    }
  }
}

checkRender()
  .then(() =>
    console.log(
      `greeting-sections: ok (секций ${greetingSectionOrder().length}; «Вы в кадре» ${
        PERSONA_SECTION_ENABLED
          ? 'включена'
          : 'выключена и отсутствует в разметке'
      })`,
    ),
  )
  .catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
