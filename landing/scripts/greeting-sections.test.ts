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
 * Обратная сторона: константу нельзя включить «пустой». Включённая при
 * `persona: null` в таблице секций или без текстов в словаре, она
 * отрапортовала бы «секция есть», а человек не увидел бы ничего — или
 * увидел бы секцию без слов.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getDictionary } from '../src/lib/get-dictionary';
import { locales } from '../src/lib/i18n';
import {
  GREETING_SECTIONS,
  PERSONA_SECTION_ENABLED,
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

const personaRenderer = /^\s{4}persona: (.+),$/m.exec(pageSrc)?.[1];
assert.ok(personaRenderer, 'в таблице секций page.tsx нет строки persona');

if (PERSONA_SECTION_ENABLED) {
  assert.notEqual(
    personaRenderer,
    'null',
    'секция включена, а у страницы нет её отрисовки',
  );
  for (const locale of locales) {
    assert.ok(
      'persona' in getDictionary(locale).greetingsLanding,
      `${locale}: секция включена, а текстов greetingsLanding.persona нет`,
    );
  }
} else {
  assert.equal(
    personaRenderer,
    'null',
    'секция выключена, а отрисовка у неё есть — мёртвый код, который включат по ошибке',
  );
  // Текст о возможности — в том же релизе, что возможность (§5.4):
  // пока секции нет, и текстов для неё в словаре быть не должно.
  for (const locale of locales) {
    assert.ok(
      !('persona' in getDictionary(locale).greetingsLanding),
      `${locale}: у выключенной секции уже есть тексты в словаре`,
    );
  }
}

console.log(
  `greeting-sections: ok (секций ${greetingSectionOrder().length}; «Вы в кадре» ${
    PERSONA_SECTION_ENABLED ? 'включена' : 'выключена и отсутствует в разметке'
  })`,
);
