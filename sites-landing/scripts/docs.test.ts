/**
 * Документация `/docs/assistant` (Л5, §3.13): Markdown → блоки.
 *
 *  1. Каждый документ uk/en разбирается; после вводного абзаца — только
 *     блоки `:::claim` (ни одного тезиса без claimId, §3.0, §14 п.4);
 *     утверждения — из реестра; `soon`-блок начинается с заголовка (там
 *     метка) и не содержит ни ссылок, ни кода — неопубликованный пакет
 *     никто не скопирует.
 *  2. uk и en — одна структура: те же блоки утверждений в том же порядке,
 *     те же генерируемые блоки кода, те же таблицы (число строк) и ссылки.
 *  3. Внутренние ссылки ведут на существующие страницы этой локали.
 *  4. Мета: title и description 50–200 символов, без плейсхолдеров.
 *  5. Отрендеренный HTML соблюдает реестр (hidden нет, soon — с меткой
 *     и без ссылок), таблицы — с caption и th[scope].
 *  6. Разборщик отказывает: неизвестный генератор, непустой gen-блок,
 *     небезопасная ссылка, таблица без подписи, вложенный claim, h1 в
 *     тексте, неизвестный плейсхолдер.
 */
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

process.env.SITE_URL = 'https://assist.example.com';

import { DocsArticle } from '../src/components/DocsArticle';
import { CLAIMS, isClaimId, type ClaimId } from '../src/lib/claims';
import { DOC_FILES, docGenerators, loadDoc } from '../src/lib/docs';
import { parseDoc, substitute, walkBlocks, type DocBlock, type ParsedDoc } from '../src/lib/docs-markdown';
import { getDictionary } from '../src/lib/get-dictionary';
import { pathFor } from '../src/lib/alternates';
import { DOCS_LOCALES, PAGES, type DocsKey } from '../src/lib/pages';
import { claimViolations, elementsWith } from './lib/html';

(globalThis as { React?: typeof React }).React = React;
const env = { widgetOrigin: 'https://w.example.com', apiOrigin: 'https://api.example.com' };
const KEYS = Object.keys(DOC_FILES) as DocsKey[];
const problems: string[] = [];
const signature = (doc: ParsedDoc) => {
  const out: string[] = [];
  walkBlocks(doc.blocks, (b) => {
    if (b.kind === 'claim') out.push(`claim:${b.claim}`);
    if (b.kind === 'code') out.push(`code:${b.gen ?? b.lang}`);
    if (b.kind === 'table') out.push(`table:${b.rows.length}x${b.head.length}`);
    if (b.kind === 'h2') out.push('h2');
  });
  return out.join(' ');
};
const links = (blocks: readonly DocBlock[]) => {
  const out: string[] = [];
  walkBlocks(blocks, (b) => {
    const inl = b.kind === 'p' || b.kind === 'note' ? [b.inline] : b.kind === 'ul' || b.kind === 'ol' ? b.items : b.kind === 'table' ? b.rows.flat() : [];
    for (const i of inl) for (const x of i) if (x.kind === 'link') out.push(x.href);
  });
  return out;
};
const known = new Set(PAGES.flatMap((p) => (p.locales ?? ['uk', 'en', 'ru']).map((l) => pathFor(l, p.path))));

let docs = 0;
let soonBlocks = 0;
for (const key of KEYS) {
  const parsed: Partial<Record<string, ParsedDoc>> = {};
  for (const locale of DOCS_LOCALES) {
    const where = `${key}/${locale}`;
    const doc = loadDoc(key, locale, { env });
    parsed[locale] = doc;
    docs++;
    // 1.
    assert.ok(doc.lead.length > 0, `${where}: нет вводного абзаца`);
    for (const b of doc.blocks) if (b.kind !== 'claim') problems.push(`${where}: блок ${b.kind} вне :::claim`);
    walkBlocks(doc.blocks, (b, claim) => {
      if (b.kind === 'claim') {
        if (!isClaimId(b.claim)) problems.push(`${where}: неизвестное утверждение ${b.claim}`);
        else if (CLAIMS[b.claim as ClaimId].status === 'soon') {
          soonBlocks++;
          if (b.blocks[0]?.kind !== 'h2' && b.blocks[0]?.kind !== 'h3') problems.push(`${where}: soon-блок ${b.claim} не начинается с заголовка (метка «скоро»)`);
          if (links(b.blocks).length) problems.push(`${where}: в soon-блоке ${b.claim} есть ссылка`);
          walkBlocks(b.blocks, (x) => x.kind === 'code' && problems.push(`${where}: в soon-блоке ${b.claim} есть код`));
        }
      }
      void claim;
    });
    // 3.
    for (const href of links(doc.blocks)) {
      const p = href.split('#')[0];
      if (p.startsWith('/') && !known.has(p)) problems.push(`${where}: ссылка на несуществующую страницу ${href}`);
      if (p.startsWith('/') && !p.startsWith(`/${locale}/`)) problems.push(`${where}: ссылка ${href} — не на свою локаль`);
    }
    // 4.
    if (doc.title.length < 20 || doc.title.length > 120 || /%%|\{/.test(doc.title)) problems.push(`${where}: title «${doc.title}»`);
    if (doc.description.length < 50 || doc.description.length > 200 || /%%|\{/.test(doc.description)) problems.push(`${where}: description ${doc.description.length}`);
    // 5.
    const dict = getDictionary(locale);
    const html = renderToStaticMarkup(React.createElement(DocsArticle, { doc, dict }));
    problems.push(...claimViolations(html, CLAIMS, dict.common.soon, where));
    for (const t of elementsWith(html, /^<table\b/)) {
      if (!/<caption\b/.test(t.outer) || (t.outer.match(/<th\b[^>]*>/g) ?? []).some((th) => !/scope="(col|row)"/.test(th))) problems.push(`${where}: таблица без caption/scope`);
    }
    if (/<script|dangerouslySetInnerHTML|on[a-z]+="/i.test(html)) problems.push(`${where}: исполняемая разметка в документации`);
    if (/<h1\b/g.test(html) && (html.match(/<h1\b/g) ?? []).length !== 1) problems.push(`${where}: h1 не один`);
  }
  // 2.
  if (signature(parsed.uk!) !== signature(parsed.en!)) problems.push(`${key}: структура uk ≠ en\n  uk: ${signature(parsed.uk!)}\n  en: ${signature(parsed.en!)}`);
  const strip = (h: string) => h.replace(/^\/(uk|en)\//, '/');
  if (links(parsed.uk!.blocks).map(strip).join() !== links(parsed.en!.blocks).map(strip).join()) problems.push(`${key}: ссылки uk ≠ en`);
}
assert.deepEqual(problems, [], problems.join('\n'));
assert.ok(soonBlocks >= 4, `soon-блоков подозрительно мало: ${soonBlocks}`);

// 6. Разборщик отказывает.
const gen = docGenerators(env);
const head = '---\ntitle: T\ndescription: D\n---\nLead.\n\n';
const rejects: Array<[string, RegExp]> = [
  ['```gen:nope\n```', /неизвестный генератор/],
  ['```gen:embedTag\n<script src="https://evil.example/x.js"></script>\n```', /должен быть пустым/],
  ['[x](javascript:alert(1))', /небезопасная ссылка/],
  ['[x](http://evil.example)', /небезопасная ссылка/],
  ['[x](//evil.example)', /небезопасная ссылка/],
  ['| a | b |\n| 1 | 2 |', /без подписи/],
  [':::claim docs\n:::claim js-api\n:::\n:::', /вложенные/],
  [':::claim docs\nx', /незакрытый/],
  ['# H1', /h1/],
  ['```js\nx', /незакрытый блок кода/],
];
for (const [md, re] of rejects) assert.throws(() => parseDoc(head + md, gen), re, `не отвергнуто: ${md}`);
assert.throws(() => parseDoc('Lead', gen), /title\/description/);
assert.throws(() => substitute('%%nope%%', {}), /неизвестный плейсхолдер/);
assert.equal(substitute('%%a%% %%a%%', { a: '$&' }), '$& $&', 'подстановка без спецсимволов replace');
const ok = parseDoc(head + ':::claim docs\n## H\n\nTable: C\n| a | b |\n|---|---|\n| `x` | [y](/uk/assistant) |\n\n```gen:csp\n```\n:::', gen);
assert.equal(ok.blocks.length, 1);

console.log(`ok   документация: ${docs} страниц (uk/en) — всё содержание под утверждениями, ${soonBlocks} soon-блоков без ссылок и кода, uk/en одной структуры, ссылки на существующие страницы своей локали, мета, рендер по реестру; разборщик отказывает в ${rejects.length + 2} опасных случаях`);
