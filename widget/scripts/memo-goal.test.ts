/**
 * Э6-тер (к): проверка цели мемо «счётчик ±N» и «значение поля = слот» —
 * чанк undo.js (`src/undo/goal.ts`) на минимальном «DOM» (`fake-dom.ts`),
 * порт чтения счётчика и ключа подписи против сервера
 * (`assist-ui-core/memo-goal.ts`), разбор `ui-goal` и проверок шага iframe.
 * Мутанты, которые тест обязан убить: «чисел нет → null» вместо 0; цена
 * с дробью как счётчик; без повторов (счётчик обновился через 0,5 с);
 * пароль читается; пустой запрос = «да»; `ui-goal` без `ok`-булева.
 */
import assert from 'node:assert/strict';
import {
  FakeInput,
  FakeNode,
  FakeSelect,
  installFakeDom,
  type FakeDocument,
} from './fake-dom';
import type { ActHost } from '../src/act/index';
import { undo } from '../src/undo/index';
import { countIn, goal, labelKey } from '../src/undo/goal';
import { goalCheckOf } from '../src/shared/goal-check';
import { DICTS } from '../src/chat/i18n';
import {
  UiPlanController,
  parsePlanView,
  uiPlanOff,
  type UiPlanUi,
} from '../src/chat/ui-plan';
import { envelope, parseParentMessage } from '../src/shared/protocol';
import * as serverNs from '../../sites-backend/src/modules/assist-ui-core/memo-goal';

const server = ((serverNs as { default?: typeof serverNs }).default ??
  serverNs) as typeof serverNs;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mkHost() {
  const posts: Array<Record<string, unknown>> = [];
  const N = {
    later: (fn: () => void, ms: number) => {
      setTimeout(fn, Math.min(ms, 5));
      return 0;
    },
  };
  const host = {
    N,
    post: (m: unknown) => posts.push(m as Record<string, unknown>),
    min: () => undefined,
    mark: () => undefined,
  } as unknown as ActHost;
  return { host, posts };
}

async function main() {
  // ── порт: счётчик и ключ подписи как на сервере ──
  const samples = [
    'Кошик 2',
    '₴0.00 0 items',
    '₴1 200,50 3 товари',
    '2 товари 300 грн',
    'Кошик',
    '₴0.00',
    '(12)',
    'Корзина 1234567',
    'Cart\u00a07',
    'Кошик (2) — Оформити',
  ];
  for (const t of samples) {
    assert.equal(countIn(t), server.goalCountIn(t), `счётчик «${t}»`);
    assert.equal(labelKey(t), server.goalLabelKey(t), `ключ «${t}»`);
  }
  assert.equal(countIn('Кошик'), 0, 'чисел нет — 0 (пустой значок)');
  assert.equal(countIn('₴0.00'), null, 'только цена — проверить нечем');
  assert.equal(countIn('₴0.00 0 items'), 0, 'цена с дробью — не счётчик');
  assert.equal(countIn('₴1 200,50 3 товари'), 3, 'тысячи — часть цены');
  assert.equal(countIn('2 товари 300 грн'), null, 'два целых — неоднозначно');
  assert.equal(labelKey('Кошик (2)'), 'кошик');

  // ── iframe: проверки шага и `ui-goal` ──
  assert.deepEqual(
    goalCheckOf(
      {
        kind: 'wait',
        expect: {
          path: '/cart*',
          count: { id: 'nav-cart', t: '', eq: 3 },
          field: { id: null, t: 'пошук', eq: 'футболка' },
        },
      },
      4
    ),
    {
      i: 4,
      count: { id: 'nav-cart', t: '', eq: 3 },
      field: { id: null, t: 'пошук', eq: 'футболка' },
    }
  );
  assert.equal(
    goalCheckOf(
      { kind: 'click', expect: { count: { id: 'nav-cart', t: '', eq: 1 } } },
      0
    ),
    null
  );
  assert.equal(
    goalCheckOf({ kind: 'wait', expect: { count: { id: 'x', eq: -1 } } }, 0),
    null,
    'отрицательный счётчик — мусор'
  );
  assert.equal(
    goalCheckOf({ kind: 'wait', expect: { field: { t: '<b>', eq: 'x' } } }, 0),
    null,
    'разметка в подписи — мусор'
  );
  assert.deepEqual(
    parseParentMessage(
      envelope({ type: 'ui-goal', planId: 'p1', i: 2, ok: true })
    ),
    { type: 'ui-goal', planId: 'p1', i: 2, ok: true }
  );
  assert.equal(
    parseParentMessage(
      envelope({ type: 'ui-goal', planId: 'p1', i: 2, ok: 'yes' })
    ),
    null
  );
  // Заход 9: «элемента нет» — только вместе с ok=false и только `true`.
  assert.deepEqual(
    parseParentMessage(
      envelope({
        type: 'ui-goal',
        planId: 'p1',
        i: 2,
        ok: false,
        missing: true,
      })
    ),
    { type: 'ui-goal', planId: 'p1', i: 2, ok: false, missing: true }
  );
  assert.deepEqual(
    parseParentMessage(
      envelope({ type: 'ui-goal', planId: 'p1', i: 2, ok: true, missing: true })
    ),
    { type: 'ui-goal', planId: 'p1', i: 2, ok: true }
  );
  assert.deepEqual(
    parseParentMessage(
      envelope({ type: 'ui-goal', planId: 'p1', i: 2, ok: false, missing: 1 })
    ),
    { type: 'ui-goal', planId: 'p1', i: 2, ok: false }
  );
  assert.equal(
    parseParentMessage(
      envelope({ type: 'ui-goal', planId: 'p/1', i: 2, ok: true })
    ),
    null
  );

  // ── чанк: счётчик по разметке, с повторами (AJAX-фрагменты) ──
  {
    const doc: FakeDocument = installFakeDom();
    const cart = new FakeNode('a');
    cart.setAttribute('data-assist-id', 'nav-cart');
    cart.innerText = '₴100.00 1 item';
    doc.body.appendChild(cart);
    const { host, posts } = mkHost();
    undo(
      {
        type: 'ui-undo',
        planId: 'p1',
        idx: [],
        goal: { i: 3, count: { id: 'nav-cart', t: '', eq: 2 } },
      },
      [],
      host
    );
    await wait(20);
    assert.equal(posts.length, 0, 'ещё не обновился — ждём, не отвечаем');
    cart.innerText = '₴200.00 2 items';
    await wait(30);
    assert.deepEqual(posts, [
      { type: 'ui-goal', planId: 'p1', i: 3, ok: true },
    ]);
  }
  // Не дождались — «нет»; по подписи (без чисел) — та же логика.
  {
    const doc = installFakeDom();
    const cart = new FakeNode('a');
    cart.innerText = 'Кошик (1)';
    doc.body.appendChild(cart);
    const { host, posts } = mkHost();
    goal(
      { planId: 'p2', goal: { i: 1, count: { id: null, t: 'кошик', eq: 2 } } },
      host
    );
    await wait(200);
    assert.deepEqual(posts, [
      { type: 'ui-goal', planId: 'p2', i: 1, ok: false },
    ]);
    posts.length = 0;
    goal(
      { planId: 'p2', goal: { i: 1, count: { id: null, t: 'кошик', eq: 1 } } },
      host
    );
    await wait(20);
    assert.deepEqual(posts, [
      { type: 'ui-goal', planId: 'p2', i: 1, ok: true },
    ]);
  }
  // Заход 9: элемента цели нет вовсе (ни разметки, ни подписи) — `missing`.
  {
    installFakeDom();
    const { host, posts } = mkHost();
    goal(
      { planId: 'p6', goal: { i: 1, count: { id: 'nav-cart', t: '', eq: 1 } } },
      host
    );
    await wait(200);
    assert.deepEqual(posts, [
      { type: 'ui-goal', planId: 'p6', i: 1, ok: false, missing: true },
    ]);
  }
  // Заход 9 (P3-6): ждём 0, значка по разметке нет (тема прячет пустой) —
  // «да»; по подписи без значка — «нечем проверить» (missing), не «да».
  {
    installFakeDom();
    const { host, posts } = mkHost();
    goal(
      { planId: 'p7', goal: { i: 1, count: { id: 'nav-cart', t: '', eq: 0 } } },
      host
    );
    goal(
      { planId: 'p7', goal: { i: 2, count: { id: null, t: 'кошик', eq: 0 } } },
      host
    );
    await wait(200);
    assert.deepEqual(
      posts.map((p) => [p.i, p.ok, p.missing ?? false]),
      [
        [1, true, false],
        [2, false, true],
      ]
    );
  }
  // ── поле = слот: по подписи и по разметке; список; пароль не читаем ──
  {
    const doc = installFakeDom();
    const q = new FakeInput('search');
    q.placeholder = 'Пошук товарів';
    q.value = '  Футболка ';
    doc.body.appendChild(q);
    const size = new FakeSelect(['S', 'M']);
    size.setAttribute('data-assist-id', 'size');
    size.value = 'M';
    doc.body.appendChild(size);
    const pw = new FakeInput('password');
    pw.placeholder = 'Пароль';
    pw.value = 'secret';
    doc.body.appendChild(pw);
    const { host, posts } = mkHost();
    goal(
      {
        planId: 'p3',
        goal: { i: 2, field: { id: null, t: 'пошук товарів', eq: 'футболка' } },
      },
      host
    );
    goal(
      { planId: 'p3', goal: { i: 3, field: { id: 'size', t: '', eq: 'm' } } },
      host
    );
    goal(
      {
        planId: 'p3',
        goal: { i: 4, field: { id: null, t: 'пароль', eq: 'secret' } },
      },
      host
    );
    await wait(200);
    assert.deepEqual(
      posts.map((p) => [p.i, p.ok]),
      [
        [2, true],
        [3, true],
        [4, false],
      ],
      'поле поиска и список — да; пароль — никогда'
    );
  }
  // ── битый или пустой запрос — «нет» сразу, мусор — без ответа ──
  {
    installFakeDom();
    const { host, posts } = mkHost();
    goal({ planId: 'p4', goal: { i: 0 } }, host);
    goal({ planId: 'p4', goal: { i: 0, count: { id: 'x', eq: 1.5 } } }, host);
    goal({ planId: 'bad/id', goal: { i: 0, count: { id: 'x', eq: 1 } } }, host);
    goal({ planId: 'p4', goal: { i: 99, count: { id: 'x', eq: 1 } } }, host);
    await wait(20);
    assert.deepEqual(
      posts.map((p) => p.ok),
      [false, false],
      'пустой/битый — «нет»; чужой номер/план — тишина'
    );
  }
  // Возврат полей (без `goal`) работает как раньше.
  {
    const doc = installFakeDom();
    const inp = new FakeInput('text');
    inp.value = 'Київ';
    doc.body.appendChild(inp);
    const { host, posts } = mkHost();
    undo(
      { planId: 'p5', idx: [0] },
      [
        [
          'p5',
          0,
          inp as unknown as Element,
          'Львів',
          false,
          null,
          '#', // name#id поля (fieldKey) в момент действия
          'Київ',
          false,
        ],
      ],
      host
    );
    await wait(400);
    assert.equal(inp.value, 'Львів');
    assert.equal(posts[0].type, 'ui-undone');
  }
  // ── iframe: «готово» шага цели — только после `ui-goal` ok ──
  await iframeFlow(true);
  await iframeFlow(false);
  await iframeFlow('missing');
  console.log(
    'memo-goal: порт счётчика/подписи, ui-goal, повторы до обновления, поле/список, пароль не читается, iframe ждёт проверку — ok'
  );
}

const RAWSTEP = (
  i: number,
  kind: string,
  over: Record<string, unknown> = {}
) => ({
  i,
  kind,
  target:
    kind === 'wait'
      ? null
      : {
          ref: 'e1',
          assistId: 'add-to-cart',
          role: 'button',
          text: 'В кошик',
          selector: null,
          href: null,
        },
  value: null,
  expect: null,
  risk: 'auto',
  reason: null,
  nav: false,
  say: null,
  state: 'pending',
  ...over,
});

/** Контроллер плана iframe: шаг цели со счётчиком → `ui-undo`+goal → итог. */
async function iframeFlow(ok: boolean | 'missing') {
  let ui: UiPlanUi = uiPlanOff();
  const feed: string[] = [];
  const toParent: Array<Record<string, unknown>> = [];
  const calls: Array<{ path: string; body: unknown }> = [];
  const steps = [
    RAWSTEP(0, 'click'),
    RAWSTEP(1, 'wait', {
      expect: { count: { id: 'nav-cart', t: '', eq: 2 } },
    }),
  ];
  const view = {
    kind: 'plan',
    planId: 'p1',
    status: 'confirmed',
    steps,
    marks: ['comp', 'none'],
    pnr: null,
    currentStep: 0,
    stepsHash: 'h1',
    memo: { name: 'Покласти в кошик', goal: 'Товар у кошику' },
  };
  // Разбор: проверки цели — только у шага ожидания.
  assert.deepEqual(parsePlanView(view)?.goals, [
    null,
    { i: 1, count: { id: 'nav-cart', t: '', eq: 2 } },
  ]);
  let reply: (path: string, body: unknown) => unknown = (path) =>
    path === '/widget/v1/ui-plan' ? view : null;
  const pc = new UiPlanController({
    ui: () => ui,
    setUi: (p) => (ui = { ...ui, ...p }),
    t: () => DICTS.uk,
    lang: () => 'uk',
    cfg: () => ({
      mode: 'on',
      denySelectors: [],
      allowSelectors: [],
      maxSteps: 6,
      memos: true,
    }),
    api: async (_m, path, body) => {
      calls.push({ path, body });
      return reply(path, body);
    },
    toParent: (m) => toParent.push(m as unknown as Record<string, unknown>),
    conversationId: () => null,
    setConversation: () => undefined,
    feed: (_r, t) => feed.push(t),
    storage: (_k, n) => (n === 'vcconsent' ? '1' : null),
    pageUrl: () => 'https://shop.example.com/product/1',
    listen: () => undefined,
    random: () => 'r'.repeat(16),
  });
  setTimeout(() => {
    const m = toParent.find((x) => x.type === 'ui-snap');
    if (m)
      pc.onParent({
        type: 'ui-snapshot',
        rid: m.rid as string,
        snapshot: {
          url: 'https://shop.example.com/product/1',
          title: '',
          elements: [],
        },
      });
  }, 0);
  assert.equal(await pc.command('поклади в кошик', 'typed', null), true);
  const state = (a: string, b: string, status: string, extra = {}) => ({
    ...view,
    status,
    steps: [
      { ...steps[0], state: a },
      { ...steps[1], state: b },
    ],
    ...extra,
  });
  reply = () => state('done', 'pending', 'running');
  pc.onParent({
    type: 'ui-step',
    planId: 'p1',
    index: 0,
    result: 'done',
    reason: null,
    url: null,
    ms: 1,
  });
  await wait(5);
  toParent.length = 0;
  calls.length = 0;
  reply = (_p, body) =>
    (body as { result: string }).result === 'done'
      ? state('done', 'done', 'done', { goalStatus: 'reached' })
      : state('done', 'failed', 'failed', { goalStatus: 'not_reached' });
  pc.onParent({
    type: 'ui-step',
    planId: 'p1',
    index: 1,
    result: 'done',
    reason: null,
    url: null,
    ms: 1,
  });
  await wait(5);
  // Сначала проверка страницы, отчёта серверу ещё нет.
  assert.deepEqual(toParent, [
    {
      type: 'ui-undo',
      planId: 'p1',
      idx: [],
      goal: { i: 1, count: { id: 'nav-cart', t: '', eq: 2 } },
    },
  ]);
  assert.equal(calls.length, 0, 'до ответа undo.js — без отчёта');
  // Чужой ответ (другой шаг/план) — мимо.
  pc.onParent({ type: 'ui-goal', planId: 'p2', i: 1, ok: true });
  pc.onParent({ type: 'ui-goal', planId: 'p1', i: 0, ok: true });
  await wait(5);
  assert.equal(calls.length, 0);
  pc.onParent(
    ok === 'missing'
      ? { type: 'ui-goal', planId: 'p1', i: 1, ok: false, missing: true }
      : { type: 'ui-goal', planId: 'p1', i: 1, ok }
  );
  await wait(10);
  assert.deepEqual(
    calls.map((c) => c.body),
    [
      ok === true
        ? { index: 1, result: 'done', reason: null, url: null, durationMs: 1 }
        : {
            index: 1,
            result: 'failed',
            // Заход 9: элемента цели нет — сервер ставит цели `unknown`.
            reason: ok === 'missing' ? 'goal_unseen' : 'expect',
            url: null,
            durationMs: 1,
          },
    ]
  );
  assert.ok(
    feed.includes(
      ok === true
        ? 'Готово: Товар у кошику.'
        : ok === 'missing'
          ? 'Кроки виконано — перевірте, чи вийшло: «Товар у кошику».'
          : 'Не дійшов до мети «Товар у кошику» — перевірте сторінку.'
    ),
    feed.join(' | ')
  );
  // Не «готово» при отказе проверки.
  if (ok !== true) assert.ok(!feed.some((x) => x.startsWith('Готово')));
}

let finished = false;
process.on('exit', (code) => {
  if (!finished && code === 0) {
    console.error('memo-goal.test: не дошли до конца');
    process.exitCode = 1;
  }
});
main().then(
  () => {
    finished = true;
  },
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
