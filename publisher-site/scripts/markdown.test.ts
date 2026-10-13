/**
 * Безопасный рендер markdown (§13.1, §16.8): без сырого HTML, ссылки только
 * `https:`/`mailto:`/внутренние, внешние — `rel="nofollow noopener"`,
 * внутренние — без `utm_*`; `#` материала → `<h2>` (h1 на странице один).
 */
import assert from 'node:assert/strict';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown, parseBlocks, safeHref, stripUtm } from '../src/lib/markdown';

// tsx собирает JSX классическим рантаймом (tsconfig `jsx: preserve` — для Next).
(globalThis as { React?: typeof React }).React = React;
const opts = { siteHost: 'ai-publisher.org' };
const html = (md: string) => renderToStaticMarkup(createElement(Markdown, { source: md, options: opts }));
let n = 0;
const check = (cond: boolean, msg: string) => {
  n++;
  assert.ok(cond, msg);
};

// Сырой HTML — только текстом.
const hostile = html(
  '<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n<a href="javascript:alert(1)">x</a>\n\n<iframe src="https://evil.example"></iframe>\n\n`<img src=x onerror=alert(2)>` **<b>жирний</b>** [<i>текст</i>](https://example.org) | <svg onload=alert(3)> |',
);
const ALLOWED_TAGS = new Set([
  'p',
  'code',
  'strong',
  'em',
  'a',
  'ul',
  'ol',
  'li',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'pre',
  'hr',
  'div',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
]);
const tagsIn = (h: string) => [...h.matchAll(/<([a-zA-Z][\w-]*)([^>]*)>/g)];
check(
  tagsIn(hostile).every((m) => ALLOWED_TAGS.has(m[1].toLowerCase())),
  `сырой HTML ожил: ${hostile}`,
);
check(
  tagsIn(hostile).every((m) => !/\son\w+=/i.test(m[2]) && !/javascript:/i.test(m[2])),
  `обработчики/javascript: в атрибутах: ${hostile}`,
);
check(hostile.includes('&lt;script&gt;'), 'сырой HTML должен остаться видимым текстом');

// Ссылки.
const links = html(
  [
    '[js](javascript:alert(1)) [data](data:text/html,x) [http](http://example.org) [rel](foo/bar) [proto](//evil.example/x)',
    '[ext](https://example.org/a?b=1) [mail](mailto:hi@example.org) [int](/materials/x?utm_source=tg&utm_medium=c&x=1#s) [abs](https://ai-publisher.org/contact?utm_campaign=p) [anchor](#part)',
    '[back](/\\evil.example) [cred](https://user:pw@example.org/)',
  ].join('\n'),
);
check(!/href="(javascript|data|http:|foo|\/\/)/i.test(links), `запрещённая схема стала ссылкой: ${links}`);
check(
  links.includes('<a href="https://example.org/a?b=1" rel="nofollow noopener">ext</a>'),
  'внешняя https-ссылка с rel',
);
check(links.includes('<a href="mailto:hi@example.org" rel="nofollow noopener">mail</a>'), 'mailto');
check(links.includes('<a href="/materials/x?x=1#s">int</a>'), `внутренняя без utm: ${links}`);
check(links.includes('<a href="/contact">abs</a>'), 'абсолютная на свой хост → внутренний путь без utm');
check(links.includes('<a href="#part">anchor</a>'), 'якорь');
check(!/href="[^"]*evil/.test(links), 'обратный слэш/протокол-относительная — не ссылка');
check(!/href="https:\/\/user/.test(links), 'ссылка с учёткой — не ссылка');
check(!/utm_/.test(links.replace(/>[^<]*</g, '><')), 'внутренние ссылки без utm_');
check(safeHref('https://AI-Publisher.org/x?utm_source=a', opts)?.external === false, 'хост без учёта регистра');
check(stripUtm('/a?utm_content=1&UTM_SOURCE=2&q=3') === '/a?q=3', 'stripUtm');

// Блоки.
const blocks = html(
  '# Заголовок\n\n## Розділ\n\n### Підрозділ\n\nАбзац\nпродовження *курсив* **жирний** `код` window.__xss=1 snake_case_name\n\n- один\n- два\n\n1. перший\n2. другий\n\n> цитата\n\n---\n\n| A | B |\n|---|:-:|\n| 1 | 2 |\n| 3 |\n\n```\n<b>не тег</b>\n```',
);
check(!blocks.includes('<h1'), 'h1 в теле материала запрещён');
check(
  blocks.includes('<h2>Заголовок</h2>') && blocks.includes('<h2>Розділ</h2>') && blocks.includes('<h3>Підрозділ</h3>'),
  `заголовки: ${blocks}`,
);
check(
  blocks.includes(
    '<p>Абзац продовження <em>курсив</em> <strong>жирний</strong> <code>код</code> window.__xss=1 snake_case_name</p>',
  ),
  `строчная разметка: ${blocks}`,
);
check(
  blocks.includes('<ul><li>один</li><li>два</li></ul>') && blocks.includes('<ol><li>перший</li><li>другий</li></ol>'),
  'списки',
);
check(blocks.includes('<blockquote>цитата</blockquote>') && blocks.includes('<hr/>'), 'цитата и линия');
check(blocks.includes('<th scope="col">A</th>') && blocks.includes('<td>3</td><td></td>'), `таблица: ${blocks}`);
check(blocks.includes('&lt;b&gt;не тег&lt;/b&gt;'), 'код экранирован');
check(parseBlocks('').length === 0, 'пусто');
check(parseBlocks('a|b\nне таблица').length === 1, 'строка с | без разделителя — абзац');
check(parseBlocks('```\nнезакрытий код').length === 1, 'незакрытый блок кода не роняет разбор');

console.log(
  `ok   markdown: ${n} проверок — без сырого HTML, политика ссылок (https/mailto/внутренние, nofollow, без utm), заголовки со сдвигом, списки/таблицы/код`,
);
