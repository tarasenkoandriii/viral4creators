/**
 * Чистые части чата и загрузчика: ограниченный markdown (§4.12 «ответ модели
 * — враждебный текст»), SSE по кускам, строгий разбор ответов API (стык W2),
 * паритет словарей uk/ru/en, data-* атрибуты тега (§3-бис.2).
 */
import assert from 'node:assert/strict';
import {
  parseMarkdown,
  safeHref,
  type Block,
  type Inline,
} from '../src/chat/markdown';
import { SseParser } from '../src/chat/sse';
import {
  ApiError,
  parseChatEvent,
  parseChunk,
  parseMessage,
  parseSession,
  parseState,
  streamCodeOfRest,
  unwrap,
} from '../src/chat/api';
import { DICTS } from '../src/chat/i18n';
import { readAttrs, uiLang, isTestKey } from '../src/loader/attrs';

const SITE = ['https://shop.ua', 'https://blog.shop.ua'];

// ── markdown ────────────────────────────────────────────────────────────
function flat(nodes: Inline[]): Inline[] {
  return nodes.flatMap((n) => ('c' in n ? [n, ...flat(n.c)] : [n]));
}
function allInline(blocks: Block[]): Inline[] {
  return blocks.flatMap((b) =>
    b.t === 'p' ? flat(b.c) : b.t === 'pre' ? [] : b.items.flatMap(flat)
  );
}
const links = (md: string) =>
  allInline(parseMarkdown(md, SITE))
    .filter((n): n is Extract<Inline, { t: 'a' }> => n.t === 'a')
    .map((n) => n.href);
const textOf = (md: string) =>
  allInline(parseMarkdown(md, SITE))
    .map((n) => (n.t === 'text' || n.t === 'code' ? n.v : ''))
    .join('');

assert.deepEqual(links('[Доставка](https://shop.ua/delivery)'), [
  'https://shop.ua/delivery',
]);
assert.deepEqual(links('[a](https://blog.shop.ua/x)'), [
  'https://blog.shop.ua/x',
]);
assert.deepEqual(
  links('[чужая](https://evil.example/x)'),
  [],
  'чужой хост — текст'
);
assert.deepEqual(
  links('[http](http://shop.ua/x)'),
  [],
  'http не на loopback — текст'
);
assert.deepEqual(links('[js](javascript:alert(1))'), []);
assert.deepEqual(links('[d](data:text/html,<script>)'), []);
assert.deepEqual(links('[u](https://user:pw@shop.ua/)'), [], 'логин в URL');
assert.deepEqual(links('[x](//shop.ua/x)'), [], 'протокол-относительная');
assert.equal(
  textOf('[чужая](https://evil.example/x)'),
  'чужая',
  'подпись сохранена'
);
const img = parseMarkdown('![пиксель](https://evil.example/p.png)', SITE);
assert.equal(
  JSON.stringify(img).includes('evil.example'),
  false,
  'адрес картинки не попадает в AST'
);
assert.equal(textOf('![пиксель](https://evil.example/p.png)'), 'пиксель');
assert.equal(
  textOf('<img src=x onerror=alert(1)>'),
  '<img src=x onerror=alert(1)>',
  'HTML — просто текст'
);
const b = parseMarkdown(
  '**жирный** и *курсив* и `код`\n\n- раз\n- два\n\n1. один\n\n```\n<b>x</b>\n```\n# Заголовок',
  SITE
);
assert.deepEqual(
  b.map((x) => x.t),
  ['p', 'ul', 'ol', 'pre', 'p']
);
assert.equal((b[0] as { c: Inline[] }).c[0].t, 'b');
assert.equal((b[3] as { v: string }).v, '<b>x</b>');
assert.equal(
  safeHref('http://example.localhost:5182/a', [
    'http://example.localhost:5182',
  ]),
  'http://example.localhost:5182/a',
  'loopback-стенд'
);
assert.equal(safeHref('not a url', SITE), null);

// ── SSE ─────────────────────────────────────────────────────────────────
const p = new SseParser();
const stream =
  'event: meta\ndata: {"conversationId":"c1","messageId":"m1","replay":false}\n\nevent: token\ndata: {"t":"При"}\n\n: ping\n\nevent: token\r\ndata: {"t":"вет"}\r\n\r\nevent: done\ndata: {}\n\n';
const evs: string[] = [];
for (let i = 0; i < stream.length; i += 7)
  for (const e of p.push(stream.slice(i, i + 7)))
    evs.push(`${e.event}:${e.data}`);
assert.deepEqual(evs, [
  'meta:{"conversationId":"c1","messageId":"m1","replay":false}',
  'token:{"t":"При"}',
  'token:{"t":"вет"}',
  'done:{}',
]);

// ── API: строгий разбор ─────────────────────────────────────────────────
assert.deepEqual(
  parseChatEvent('meta', {
    conversationId: 'c1',
    messageId: 'm1',
    replay: true,
  }),
  {
    type: 'meta',
    conversationId: 'c1',
    messageId: 'm1',
    replay: true,
  }
);
assert.equal(
  parseChatEvent('meta', { conversationId: '../x', messageId: 'm' }),
  null
);
assert.equal(
  parseChatEvent('proposal', { x: 1 }),
  null,
  'неизвестное событие — игнор'
);
assert.deepEqual(
  parseChatEvent('error', { code: 'weird', message: 'provider said X' }),
  {
    type: 'error',
    code: 'upstream',
    message: 'provider said X',
  }
);
assert.deepEqual(
  parseChatEvent('actions', {
    items: [
      { kind: 'link', label: 'L', url: 'https://x' },
      { kind: 'highlight', label: 'H' },
      { kind: 'lead' },
    ],
  }),
  {
    type: 'actions',
    items: [{ kind: 'link', label: 'L', url: 'https://x' }],
  }
);
const s = parseSession({
  visitorToken: 't',
  expiresAt: '2026-10-02T00:00:00Z',
  resumeKey: 'short',
  resumed: 1,
  resumeLost: false,
  preview: false,
});
assert.equal(s.resumeKey, null, 'указатель не той формы — не сохраняем');
assert.equal(s.resumed, false, 'только true');
assert.throws(() => parseSession({}), ApiError);
assert.equal(parseMessage({ id: 'm1', role: 'admin', text: 'x' }), null);
const st = parseState({
  conversation: {
    id: 'c1',
    stateVersion: 3,
    messages: [
      { id: 'm1', role: 'assistant', text: 'ok', streamState: 'complete' },
      { bad: 1 },
    ],
    streamingMessageId: null,
    lastMessageAt: 'x',
  },
  previousConversationId: null,
});
assert.equal(st.conversation?.messages.length, 1);
assert.deepEqual(
  parseState({ conversation: null, previousConversationId: 'c0' }),
  { conversation: null, previousConversationId: 'c0' }
);
assert.equal(
  parseChunk({
    messageId: 'm1',
    text: 'abc',
    offset: 3,
    streamState: 'streaming',
  }).offset,
  3
);
assert.deepEqual(unwrap(200, { success: true, data: 5 }), 5);
assert.throws(
  () => unwrap(403, { success: false, error: { code: 'ORIGIN_DENIED' } }),
  (e: unknown) => e instanceof ApiError && e.code === 'ORIGIN_DENIED'
);
assert.throws(
  () => unwrap(500, '<html>'),
  (e: unknown) => e instanceof ApiError && e.code === 'HTTP_500'
);

// ── i18n: паритет ключей ────────────────────────────────────────────────
const keys = Object.keys(DICTS.uk).sort();
for (const l of ['ru', 'en'] as const)
  assert.deepEqual(Object.keys(DICTS[l]).sort(), keys, `словарь ${l}`);
for (const l of ['uk', 'ru', 'en'] as const)
  assert.ok(DICTS[l].ai && DICTS[l].mayErr, 'метка ИИ есть на всех языках');

// ── data-* тега ─────────────────────────────────────────────────────────
const tag = (a: Record<string, string>) => readAttrs((n) => a[n] ?? null);
const t1 = tag({
  'data-site': 'pk_live_abcdefgh',
  'data-position': 'top-left',
  'data-offset-x': '30',
  'data-offset-y': '999',
  'data-mobile': 'sheet',
  'data-launcher': 'none',
  'data-container': '#help',
  'data-lang': 'ru',
  'data-z-index': '100',
  'data-hide-on': '/checkout*, nope ,/cart',
  'data-theme': 'dark',
  'data-color': '#ff0000',
});
assert.equal(t1.pk, 'pk_live_abcdefgh');
assert.equal(t1.position, 'top-left');
assert.equal(t1.offsetX, 30);
assert.equal(t1.offsetY, null, 'отступ > 200 — игнор');
assert.equal(t1.mobile, 'sheet');
assert.equal(t1.launcher, 'none');
assert.equal(t1.container, '#help');
assert.equal(t1.lang, 'ru');
assert.equal(t1.zIndex, 100);
assert.deepEqual(t1.hideOn, ['/checkout*', '/cart']);
assert.equal(
  (t1 as unknown as Record<string, unknown>).color,
  undefined,
  'бренд атрибутами не меняется'
);
const t2 = tag({
  'data-site': '<script>',
  'data-position': 'center',
  'data-z-index': '-1',
  'data-offset-x': '1e3',
});
assert.equal(t2.pk, null);
assert.equal(t2.position, null);
assert.equal(t2.zIndex, null);
assert.equal(t2.offsetX, null);
assert.equal(uiLang(null, 'ru-RU'), 'ru');
assert.equal(uiLang(null, '', 'de-DE'), 'en');
assert.equal(uiLang('uk', 'ru'), 'uk');
assert.ok(isTestKey('pk_test_abcdefgh') && !isTestKey('pk_live_abcdefgh'));

console.log('chat: markdown, SSE, разбор API, словари, атрибуты тега — ок');

// ── коды REST → поведение стрима (интеграция Э2: UPSTREAM JSON-пути) ────
assert.equal(streamCodeOfRest('UPSTREAM'), 'upstream');
assert.equal(streamCodeOfRest('WIDGET_DISABLED'), 'disabled');
assert.equal(streamCodeOfRest('ORIGIN_DENIED'), 'origin_denied');
assert.equal(streamCodeOfRest('QUESTION_TOO_LONG'), null);
assert.equal(streamCodeOfRest('toString'), null);
console.log('ok: коды REST → стрим');
