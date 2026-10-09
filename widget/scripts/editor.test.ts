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
import * as memoNs from '../../sites-backend/src/modules/assist-ui-core/memo';
import { EDITOR_MESSAGE_NS } from '../src/shared/brand';
import {
  editorEnvelope,
  isGeneratedToken,
  maskHrefPath,
  panelOrigin,
  parseDescriptor,
  parseToPanel,
  parseToPicker,
  phraseNorm,
  stabilityOf,
} from '../src/shared/editor-protocol';
import en from '../src/editor-panel/lang-en';
import ru from '../src/editor-panel/lang-ru';
import uk from '../src/editor-panel/lang-uk';

const cjs = <X>(ns: X): X => (ns as X & { default?: X }).default ?? ns;
const vm = cjs(vmNs);
const um = cjs(umNs);
const env = cjs(envNs);
const snap = cjs(snapNs);
const memoCore = cjs(memoNs);

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
// Заход 11 (№113): тепловые значки — строгий разбор (ключ, подпись ≤ 40, bad).
assert.deepEqual(
  parseToPicker(
    editorEnvelope({
      type: 'heat',
      items: [
        { key: 'cart', label: '🗣5 ✋3', bad: true, html: '<b>' },
        { key: 'menu', label: '🗣2', bad: 'yes' },
        { key: '', label: 'x' },
        { key: 'long', label: 'x'.repeat(41) },
        'мусор',
      ],
    })
  ),
  {
    type: 'heat',
    items: [
      { key: 'cart', label: '🗣5 ✋3', bad: true },
      { key: 'menu', label: '🗣2', bad: false },
    ],
  }
);
assert.equal(parseToPicker(editorEnvelope({ type: 'heat', items: 'x' })), null);
const many = parseToPicker(
  editorEnvelope({
    type: 'heat',
    items: Array.from({ length: 300 }, (_, i) => ({
      key: `k${i}`,
      label: 'x',
    })),
  })
);
assert.equal(many?.type === 'heat' && many.items.length, 200, '≤ 200 значков');
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

// 3-ter. Заход 11 (№117): карта «Админки» — панель `wa.` просит
// employee-JWT, пикер отвечает им (или null — сотрудник не вошёл);
// мусор вместо JWT, лишние поля и чужое пространство имён — мимо.
{
  const b64 = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString('base64url');
  const jwt = `${b64({ alg: 'HS256' })}.${b64({ sub: 'emp-1', exp: 9 })}.${'s'.repeat(43)}`;
  assert.deepEqual(parseToPicker(editorEnvelope({ type: 'need-identity' })), {
    type: 'need-identity',
  });
  assert.equal(parseToPicker({ type: 'need-identity' }), null, 'без ns');
  assert.deepEqual(
    parseToPanel(editorEnvelope({ type: 'identity', jwt, sub: 'x' })),
    { type: 'identity', jwt }
  );
  assert.deepEqual(
    parseToPanel(editorEnvelope({ type: 'identity', jwt: null })),
    { type: 'identity', jwt: null }
  );
  for (const bad of ['a.b', '<img>.x.y', 42, undefined, 'x'.repeat(5000)])
    assert.equal(
      parseToPanel(editorEnvelope({ type: 'identity', jwt: bad })),
      null,
      `identity: ${String(bad).slice(0, 20)}`
    );
  assert.equal(
    parseToPanel({ ns: 'v4c-admin', v: 1, type: 'identity', jwt }),
    null,
    'сообщение протокола «Админки» панель редактора не принимает'
  );
  // Обратного направления нет: панель не отдаёт JWT пикеру.
  assert.equal(parseToPicker(editorEnvelope({ type: 'identity', jwt })), null);
}

// 3-quater. Раунд исправлений захода 11 («Админка»): снимок «Сказать сейчас»
// с зонами владельца (селекторы ≤ 30, печатные, без `<`), номера строк;
// флаг строки таблицы у выбора; выход сотрудника — пикер → панель.
{
  const r = parseToPicker(
    editorEnvelope({
      type: 'snapshot-req',
      id: 7,
      rows: ['1042', '12', 'x', '1234567890123'],
      deny: ['#customer-card', '<img>', 5, '', 'a'.repeat(201)],
      allow: Array.from({ length: 40 }, (_, i) => `.z${i}`),
    })
  );
  assert.ok(r && r.type === 'snapshot-req');
  assert.deepEqual(r.rows, ['1042']);
  assert.deepEqual(r.deny, ['#customer-card']);
  assert.equal(r.allow?.length, 30, '≤ 30 зон');
  const plain = parseToPicker(editorEnvelope({ type: 'snapshot-req', id: 1 }));
  assert.deepEqual(plain, {
    type: 'snapshot-req',
    id: 1,
    rows: [],
    deny: [],
    allow: [],
  });
  const pr = parseToPanel(
    editorEnvelope({
      type: 'pick',
      descriptor: { tag: 'a', text: '' },
      row: true,
    })
  );
  assert.ok(pr && pr.type === 'pick' && pr.row === true);
  const pn = parseToPanel(
    editorEnvelope({ type: 'pick', descriptor: { tag: 'a' }, row: 'yes' })
  );
  assert.ok(pn && pn.type === 'pick' && pn.row === false);
  assert.deepEqual(parseToPanel(editorEnvelope({ type: 'logout' })), {
    type: 'logout',
  });
  assert.equal(parseToPicker(editorEnvelope({ type: 'logout' })), null);
}

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

// 3-тер. Заход 11 (аудит P2-3): норма фразы панели = `phraseNorm` сервера.
for (const p of [
  "обов'язково",
  'обовʼязково',
  'Обов’язково!',
  'Доставка,   будь ласка',
  'ДОСТАВКА — кур’єром',
  'Ёлка-палка',
  'відкрий «Нову Пошту»',
  'please open cart',
  'iPhone 15 Pro',
  '',
]) {
  assert.equal(phraseNorm(p), memoCore.phraseNorm(p), `норма «${p}»`);
}
assert.equal(phraseNorm("обов'язково"), phraseNorm('обовʼязково'));

// 4. Словари панели: одинаковые ключи на трёх языках.
// Заход 10: ru/en — ленивые чанки панели; ключи трёх словарей равны.
const T = { uk, ru, en };
const keys = (l: 'uk' | 'ru' | 'en') => Object.keys(T[l]).sort().join(',');
assert.equal(keys('ru'), keys('uk'));
assert.equal(keys('en'), keys('uk'));

console.log(
  'editor: порты = сервер, протокол строгий (тепловые значки, JWT «Админки»), словари совпадают'
);
