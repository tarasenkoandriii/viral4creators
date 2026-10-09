/**
 * `<html lang>` в СЕРВЕРНОМ HTML — язык страницы, а не `ru` на всех
 * локалях.
 *
 * Было: `<html lang="ru">` рисовал корневой `app/layout.tsx`, который
 * локали не знает, а язык правил клиентский эффект `SetHtmlLang` после
 * гидратации. Поисковик, переводчик браузера и скринридер до скриптов
 * видели русский документ на `/uk`, `/en`, `/de`, `/es`, на поддоменах
 * поздравлений и обучалки и в блоге.
 *
 * Стало: корень только пропускает детей, `<html>` рисует
 * `components/HtmlDocument` из тех layout'ов, что язык знают на сборке.
 * Проверки:
 *
 *  1. Рендер настоящего `app/[locale]/layout.tsx` на каждой из пяти
 *     локалей — `<html lang="<locale>" dir="ltr">` первым тегом.
 *  2. Корневой layout `<html>` не рисует (иначе вложенный документ), а
 *     корневой 404 — рисует, с `lang="ru"`.
 *  3. Структура: у КАЖДОЙ страницы `app/**\/page.tsx` есть layout-предок
 *     с `HtmlDocument` — новая страница вне `[locale]` без него осталась бы
 *     вовсе без `<html>`; `<html` пишется только в `HtmlDocument.tsx`;
 *     клиентской правки `lang` больше нигде нет.
 *
 * Серверный HTML собранного сайта (все локали, поддомены, блог, 404)
 * этим тестом не покрыт — его проверяют `npm run build` + `next start`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LOCALE_DIR, locales } from '../src/lib/i18n';
import LocaleLayout from '../src/app/[locale]/layout';
import RootNotFound from '../src/app/not-found';
import LegalLayout from '../src/app/legal/layout';
import QaLayout from '../src/app/qa/layout';

// Компоненты собраны с `jsx: preserve` — tsx переводит их JSX в
// `React.createElement`, и `React` должен быть глобальным (тот же приём,
// что в greeting-sections.test.ts).
(globalThis as { React?: typeof React }).React = React;

const APP = path.join(__dirname, '..', 'src', 'app');
const SRC = path.join(__dirname, '..', 'src');

// ── 1. Пять локалей — пять разных `lang` ──
// С Next 15 layout асинхронный (`params` — Promise), а `react-dom/server`
// async-компоненты не рендерит (это умеет только RSC-рендер Next), —
// поэтому layout вызывается как функция, и рендерится уже его результат.
async function renderLocaleLayout(locale: string): Promise<string> {
  const tree = await LocaleLayout({
    params: Promise.resolve({ locale }),
    children: React.createElement('main', null, 'x'),
  });
  return renderToStaticMarkup(tree);
}

async function checkLocaleLayouts() {
  for (const locale of locales) {
    const html = await renderLocaleLayout(locale);
    const open = /^<html\b[^>]*>/.exec(html)?.[0];
    assert.ok(
      open,
      `[locale]/layout на ${locale}: первым тегом не <html>: ${html.slice(0, 80)}`,
    );
    assert.match(
      open,
      new RegExp(`\\blang="${locale}"`),
      `[locale]/layout на ${locale}: ${open}`,
    );
    assert.match(
      open,
      new RegExp(`\\bdir="${LOCALE_DIR[locale]}"`),
      `[locale]/layout на ${locale}: нет dir="${LOCALE_DIR[locale]}": ${open}`,
    );
    assert.match(
      open,
      /\bdata-scroll-behavior="smooth"/,
      `[locale]/layout на ${locale}: нет data-scroll-behavior (плавная прокрутка в globals.css): ${open}`,
    );
    assert.match(
      html,
      /<body><main>x<\/main><\/body><\/html>$/,
      `[locale]/layout на ${locale}: дети не в <body>`,
    );
  }
}

// ── 2. Корень пропускает детей, корневой 404 и вне-локальные разделы — `ru` ──
// Корневой layout импортирует globals.css — отрендерить его вне Next
// нечем, поэтому сверяем исходник: тело — ровно `return children;`.
const rootSrc = fs.readFileSync(path.join(APP, 'layout.tsx'), 'utf8');
assert.match(
  rootSrc,
  /export default function RootLayout\([^)]*\)[^{]*\{\s*return children;\s*\}/,
  'корневой app/layout.tsx снова рисует обёртку — под ним окажется второй <html>',
);
for (const [name, html] of [
  [
    'app/not-found.tsx',
    renderToStaticMarkup(React.createElement(RootNotFound)),
  ],
  [
    'app/legal/layout.tsx',
    renderToStaticMarkup(React.createElement(LegalLayout, null, 'x')),
  ],
  [
    'app/qa/layout.tsx',
    renderToStaticMarkup(React.createElement(QaLayout, null, 'x')),
  ],
] as const) {
  // `<head></head>` — его дописывает сам `react-dom/server` React 19
  // (место для поднятых в `<head>` ресурсов); в Next его наполняют метаданные.
  assert.match(
    html,
    /^<html lang="ru" dir="ltr" data-scroll-behavior="smooth">(<head><\/head>)?<body>/,
    `${name}: ${html.slice(0, 80)}`,
  );
}

// ── 3. Структура: у каждой страницы есть документ ──
function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : [full];
  });
}
// Только код: комментарии вправе объяснять, почему `<html>` живёт там,
// где живёт, и как было раньше.
const codeOf = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const rendersDocument = (file: string) =>
  fs.existsSync(file) &&
  /<HtmlDocument\b/.test(codeOf(fs.readFileSync(file, 'utf8')));

const pages = walk(APP).filter((f) => path.basename(f) === 'page.tsx');
assert.ok(
  pages.length > 5,
  `нашлось подозрительно мало страниц: ${pages.length}`,
);
for (const page of pages) {
  let dir = path.dirname(page);
  let covered = false;
  // Корень не в счёт: он `<html>` не рисует по построению (п. 2).
  while (dir !== APP && !covered) {
    covered = rendersDocument(path.join(dir, 'layout.tsx'));
    dir = path.dirname(dir);
  }
  assert.ok(
    covered,
    `${path.relative(APP, page)}: ни один layout над страницей не рисует <HtmlDocument> — в HTML не будет <html>`,
  );
}
assert.ok(
  rendersDocument(path.join(APP, 'not-found.tsx')),
  'app/not-found.tsx без <HtmlDocument>',
);

for (const file of walk(SRC).filter((f) => /\.tsx?$/.test(f))) {
  const src = codeOf(fs.readFileSync(file, 'utf8'));
  const rel = path.relative(SRC, file);
  if (rel !== path.join('components', 'HtmlDocument.tsx')) {
    assert.doesNotMatch(
      src,
      /<html\b/,
      `${rel}: <html> рисуется мимо HtmlDocument`,
    );
  }
  assert.doesNotMatch(
    src,
    /documentElement\.lang|SetHtmlLang/,
    `${rel}: язык документа снова правится на клиенте — он должен приходить с сервера`,
  );
}

checkLocaleLayouts().then(
  () =>
    console.log(
      `html-lang: ${locales.length} локалей, ${pages.length} страниц — <html lang> серверный`,
    ),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
