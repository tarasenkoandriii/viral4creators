/**
 * Э6-тер: редактор голосовой карты без браузера — сверка портов с сервером
 * (устойчивость дескриптора, «сгенерированный id», origin панели `we.`),
 * строгий разбор протокола пикер ↔ панель (мусор и чужое пространство
 * имён — null, ссылки подсветки — только `e#`), словари панели uk/ru/en.
 */
import assert from 'node:assert/strict';
import * as vmNs from '../../sites-backend/src/modules/assist-ui-core/voice-map';
import * as umNs from '../../sites-backend/src/modules/site-core/ui-map/ui-map-model';
import * as envNs from '../../sites-backend/src/config/editor-env';
import * as snapNs from '../../sites-backend/src/modules/assist-ui-core/snapshot';
import { EDITOR_MESSAGE_NS } from '../src/shared/brand';
import {
  editorEnvelope,
  isGeneratedToken,
  maskHrefPath,
  panelOrigin,
  parseDescriptor,
  parseToPanel,
  parseToPicker,
  stabilityOf,
} from '../src/shared/editor-protocol';
import { T } from '../src/editor-panel/i18n';

const cjs = <X>(ns: X): X => (ns as X & { default?: X }).default ?? ns;
const vm = cjs(vmNs);
const um = cjs(umNs);
const env = cjs(envNs);
const snap = cjs(snapNs);

// 1. Устойчивость: порт = сервер.
const base = {
  tag: 'button',
  role: 'button',
  text: 'Доставка',
  unique: true,
};
const cases: Array<Record<string, unknown>> = [
  { ...base, assistId: 'add-to-cart' },
  { ...base, testId: 'cart-btn' },
  { ...base, elId: 'buy' },
  { ...base, elId: 'css-1a2b3c4d5' },
  { ...base, text: 'Купити за 1 500 грн' },
  { ...base, unique: false },
  { tag: 'a', role: 'link', text: '', hrefPath: '/delivery', unique: true },
  { tag: 'other', text: '', css: 'div > span', unique: true },
];
for (const c of cases) {
  const server = vm.parseDescriptor(c);
  const widget = parseDescriptor({ hiddenLabel: null, ...c });
  assert.ok(server && widget, `разбор ${JSON.stringify(c)}`);
  assert.equal(
    stabilityOf(widget!),
    vm.descriptorStability(server!),
    `устойчивость ${JSON.stringify(c)}`
  );
}
for (const t of [
  ':r1:',
  'css-1x2y3z',
  'buy-now',
  'a1b2c3d4e5',
  'product-12345',
  'x'.repeat(41),
])
  assert.equal(
    isGeneratedToken(t),
    um.isGeneratedToken(t),
    `isGeneratedToken(${t})`
  );

// 2. Origin панели: `w.` → `we.` (как сервер); стенды — 127.0.0.2.
for (const o of [
  'https://w.v4c.example.invalid',
  'https://assist-w.viral4creators.app',
  'https://widget.example.com',
])
  assert.equal(panelOrigin(o), env.deriveEditorOrigin(o), o);
assert.equal(
  panelOrigin('https://w.v4c.example.invalid'),
  'https://we.v4c.example.invalid'
);
assert.equal(panelOrigin('http://localhost:5181'), 'http://127.0.0.2:5181');

// 3. Протокол: строгий разбор.
assert.equal(parseToPicker({ type: 'exit' }), null, 'без ns — мусор');
assert.equal(
  parseToPicker({ ns: 'v4c-widget', type: 'exit' }),
  null,
  'чужое пространство'
);
assert.deepEqual(parseToPicker(editorEnvelope({ type: 'exit' })), {
  type: 'exit',
});
assert.equal(
  parseToPicker(editorEnvelope({ type: 'mode', mode: 'all' })),
  null
);
const hl = parseToPicker(
  editorEnvelope({
    type: 'highlight',
    items: [
      { ref: 'e1', label: '1. click' },
      { ref: 'body', label: 'x' },
      { ref: 'e9999', label: 'x' },
    ],
  })
);
assert.deepEqual(hl, {
  type: 'highlight',
  items: [{ ref: 'e1', label: '1. click' }],
});
assert.equal(
  parseToPanel(editorEnvelope({ type: 'pick', descriptor: '<img onerror>' })),
  null,
  'pick с мусором вместо дескриптора'
);
const pick = parseToPanel(
  editorEnvelope({
    type: 'pick',
    descriptor: {
      tag: 'button',
      text: 'В кошик',
      assistId: 'add-to-cart',
      value: 'секрет',
    },
    how: 'assist-id',
    stability: 'strong',
  })
);
assert.ok(pick && pick.type === 'pick');
assert.ok(
  !('value' in (pick as { descriptor: object }).descriptor),
  'значения поля в дескрипторе нет'
);
assert.equal(
  parseToPanel({ ...editorEnvelope({ type: 'ready', path: '/' }), ns: 'x' }),
  null
);
assert.equal(EDITOR_MESSAGE_NS, 'v4c-editor');

// 3-бис. Маска ПД в пути ссылки (аудит Э6-тер (3)): порт = сервер.
for (const p of [
  '/delivery',
  '/u/ivan@example.com',
  '/u/ivan%40example.com/orders/123456789012',
  '/call/%2B380501234567',
  '/%D0%BA%D0%B8%D1%97%D0%B2-123456789012',
  '/orders/2026-10-05',
  '/k/sk-abcdefghijklmnop',
  '/u/:email',
  '/%E0%A4%A',
]) {
  assert.equal(maskHrefPath(p), snap.maskPagePath(p), `маска пути ${p}`);
}
assert.equal(maskHrefPath('/u/ivan@example.com'), '/u/:email');
assert.equal(maskHrefPath('/orders/123456789012'), '/orders/:n');

// 4. Словари панели: одинаковые ключи на трёх языках.
const keys = (l: 'uk' | 'ru' | 'en') => Object.keys(T[l]).sort().join(',');
assert.equal(keys('ru'), keys('uk'));
assert.equal(keys('en'), keys('uk'));

console.log('editor: порты = сервер, протокол строгий, словари совпадают');
