/**
 * Протокол postMessage (ТЗ §4.12, контракт Э2 §3): строгий разбор с обеих
 * сторон. Ловит: чужой ns/версию, неизвестный тип, лишние поля (не
 * проходят дальше), длины, enum, origin в init, контекст не-строка/число.
 */
import assert from 'node:assert/strict';
import {
  envelope,
  parseFrameMessage,
  parseParentMessage,
  cleanContext,
  isPk,
} from '../src/shared/protocol';
import {
  WIDGET_MESSAGE_NS,
  WIDGET_PROTOCOL_VERSION,
} from '../src/shared/brand';

const NS = WIDGET_MESSAGE_NS;
const V = WIDGET_PROTOCOL_VERSION;
const PK = 'pk_live_abcdef1234';
const init = {
  ns: NS,
  v: V,
  type: 'init',
  pk: PK,
  parentOrigin: 'https://shop.ua',
  page: { url: 'https://shop.ua/a?x=1#frag', title: 'Магазин' },
  uiLang: 'ru',
  mode: 'float',
  siteFont: 'Georgia, "Times New Roman", serif',
  siteTheme: 'dark',
  previewToken: null,
  restoreOpen: true,
};

// конверт
assert.equal(parseParentMessage({ ...init, ns: 'other' }), null, 'чужой ns');
assert.equal(parseParentMessage({ ...init, v: 2 }), null, 'чужая версия');
assert.equal(
  parseParentMessage({ ...init, type: 'eval' }),
  null,
  'неизвестный тип'
);
assert.equal(parseParentMessage('строка'), null);
assert.equal(parseParentMessage(null), null);
assert.equal(parseFrameMessage({ type: 'ready' }), null, 'без ns — игнор');

// init
const pi = parseParentMessage({ ...init, evil: '<script>' });
assert.ok(pi && pi.type === 'init');
assert.equal(
  (pi as unknown as Record<string, unknown>).evil,
  undefined,
  'лишние поля отброшены'
);
assert.equal(pi.page.url, 'https://shop.ua/a?x=1', 'фрагмент URL отброшен');
assert.equal(pi.siteTheme, 'dark');
assert.equal(parseParentMessage({ ...init, pk: 'sk_live_x' }), null, 'не pk');
assert.equal(
  parseParentMessage({ ...init, parentOrigin: 'https://shop.ua/path' }),
  null,
  'origin с путём'
);
assert.equal(
  parseParentMessage({ ...init, parentOrigin: 'javascript:alert(1)' }),
  null
);
assert.equal(
  parseParentMessage({
    ...init,
    page: { url: 'javascript:alert(1)', title: '' },
  }),
  null
);
const badFont = parseParentMessage({
  ...init,
  siteFont: 'x;background:url(//evil)',
});
assert.ok(
  badFont && badFont.type === 'init' && badFont.siteFont === null,
  'шрифт с ; и () — отброшен'
);
const badTheme = parseParentMessage({ ...init, siteTheme: 'evil' });
assert.ok(badTheme && badTheme.type === 'init' && badTheme.siteTheme === null);
const badLang = parseParentMessage({ ...init, uiLang: 'de' });
assert.ok(badLang && badLang.type === 'init' && badLang.uiLang === 'uk');
const badPreview = parseParentMessage({ ...init, previewToken: 'a b<c>' });
assert.ok(
  badPreview && badPreview.type === 'init' && badPreview.previewToken === null
);

// ask / context / identify / position / preview
assert.deepEqual(
  parseParentMessage(envelope({ type: 'ask', question: '  Как вернуть?  ' })),
  {
    type: 'ask',
    question: 'Как вернуть?',
  }
);
assert.equal(
  parseParentMessage(envelope({ type: 'ask', question: 'x'.repeat(601) })),
  null,
  '> 600'
);
assert.equal(
  parseParentMessage(envelope({ type: 'ask', question: '   ' })),
  null,
  'пустой'
);
assert.equal(parseParentMessage(envelope({ type: 'ask', question: 42 })), null);
assert.deepEqual(cleanContext({ page: 'product', sku: 'A-12', price: 10 }), {
  page: 'product',
  sku: 'A-12',
  price: 10,
});
assert.equal(cleanContext({ fn: () => 1 }), null, 'функция');
assert.equal(cleanContext({ nested: { a: 1 } }), null, 'вложенный объект');
assert.equal(
  cleanContext({
    big: 'x'.repeat(199),
    big2: 'y'.repeat(199),
    big3: 'z'.repeat(199),
  }),
  null,
  '> 500'
);
assert.equal(cleanContext({ 'bad key<': 1 }), null);
assert.equal(
  cleanContext(
    Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 1]))
  ),
  null
);
const idm = parseParentMessage(
  envelope({ type: 'identify', name: 'Иван', email: 'a@b.c', extra: 1 })
);
assert.deepEqual(idm, { type: 'identify', name: 'Иван', email: 'a@b.c' });
assert.equal(
  parseParentMessage(envelope({ type: 'identify', name: {} })),
  null
);
assert.deepEqual(
  parseParentMessage(envelope({ type: 'position', position: 'top-left' })),
  {
    type: 'position',
    position: 'top-left',
  }
);
assert.equal(
  parseParentMessage(envelope({ type: 'position', position: 'middle' })),
  null
);
assert.equal(
  parseParentMessage(envelope({ type: 'preview', partialConfig: 'x' })),
  null
);
assert.equal(
  parseParentMessage(
    envelope({ type: 'preview', partialConfig: { a: 'x'.repeat(5000) } })
  ),
  null,
  'preview > 4 КБ'
);
assert.deepEqual(parseParentMessage(envelope({ type: 'open', junk: 1 })), {
  type: 'open',
});

// iframe → родитель: только размер/состояние/тип события
assert.deepEqual(parseFrameMessage(envelope({ type: 'ready' })), {
  type: 'ready',
});
assert.deepEqual(parseFrameMessage(envelope({ type: 'resize', height: 420 })), {
  type: 'resize',
  height: 420,
});
assert.equal(parseFrameMessage(envelope({ type: 'resize', height: -1 })), null);
assert.equal(
  parseFrameMessage(envelope({ type: 'resize', height: 1.5 })),
  null
);
assert.deepEqual(
  parseFrameMessage(envelope({ type: 'ui-state', state: 'min' })),
  { type: 'ui-state', state: 'min' }
);
assert.equal(
  parseFrameMessage(envelope({ type: 'ui-state', state: 'maximized' })),
  null
);
const ev = parseFrameMessage(
  envelope({ type: 'event', name: 'lead', fields: { phone: '+380' } })
);
assert.deepEqual(
  ev,
  { type: 'event', name: 'lead' },
  'поля лида не проходят наружу'
);
assert.equal(
  parseFrameMessage(envelope({ type: 'event', name: 'message' })),
  null
);
assert.deepEqual(
  parseFrameMessage(envelope({ type: 'unavailable', code: 'ORIGIN_DENIED' })),
  {
    type: 'unavailable',
    code: 'ORIGIN_DENIED',
  }
);
assert.equal(
  parseFrameMessage(envelope({ type: 'unavailable', code: '<b>' })),
  null
);
assert.equal(
  parseFrameMessage(envelope({ type: 'history', text: 'x' })),
  null,
  'команды «отдай историю» нет'
);

// pk
assert.ok(isPk('pk_test_abcdefgh'));
assert.ok(!isPk('pk_live_short'));
assert.ok(!isPk('pk_live_abc"def><gh'));

console.log('protocol: разбор сообщений обеих сторон — ок');
