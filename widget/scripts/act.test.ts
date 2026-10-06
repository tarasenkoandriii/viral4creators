/**
 * Исполнитель голосового плана (act.js) и возврат полей (undo.js) — без
 * браузера, на минимальном «DOM» (`scripts/fake-dom.ts`; jsdom в виджете
 * нет). Аудит 06.10 и выжившие мутанты:
 *  - M13: шаг с побочным эффектом — `dispatched` и ожидание `ui-ack`, клик
 *    только после ack;
 *  - гонка двух `ui-run`: повтор того же плана игнорируется, остановленный
 *    раннер не снимает флаг «план идёт» нового; bfcache (`pagehide`
 *    persisted) — стоп без отчёта, флаг остаётся;
 *  - Н-4: `select` на опцию из стоп-листа — отказ `danger`;
 *  - снимок: contenteditable/role=textbox|combobox — только подпись, не
 *    ввод; M12: пароль и `cc-*` у списка — чувствительные поля;
 *  - возврат: только если поле держит поставленное помощником; радио —
 *    отметкой прежней кнопки группы.
 */
import assert from 'node:assert/strict';
import {
  FakeInput,
  FakeNode,
  FakeSelect,
  installFakeDom,
  type FakeDocument,
} from './fake-dom';
import { start, type ActHost } from '../src/act/index';
import { mem, Runner, type Prior, type RunHost } from '../src/act/exec';
import { sensitiveField, takeSnapshot, visibleText } from '../src/act/snapshot';
import { undo } from '../src/undo/index';
import { parseStep, type UiStep } from '../src/shared/ui-plan';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const E = (n: FakeNode) => n as unknown as Element;

type Posted = Record<string, unknown>;

function mkHost() {
  const posts: Posted[] = [];
  const marks: boolean[] = [];
  const listeners: Array<[string, (e: unknown) => void]> = [];
  const N = {
    el: (tag: string) => new FakeNode(tag),
    on: (_t: unknown, type: string, fn: (e: unknown) => void) => {
      listeners.push([type, fn]);
    },
    off: () => undefined,
    // Ожидания ускорены; таймаут ack (8 с) — «никогда» в рамках теста.
    later: (fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms >= 8000 ? 60_000 : Math.min(ms, 5));
      if (ms >= 8000) t.unref();
      return 0;
    },
  };
  const host: ActHost = {
    N: N as unknown as ActHost['N'],
    post: (m) => posts.push(m as unknown as Posted),
    min: () => undefined,
    mark: (on) => marks.push(on),
  };
  return { host, posts, marks, listeners };
}

const RAW = (over: Record<string, unknown> = {}) => ({
  i: 0,
  kind: 'click',
  risk: 'auto',
  target: {
    ref: 'e1',
    role: 'button',
    text: 'Додати в кошик',
    assistId: null,
    href: null,
    selector: null,
  },
  value: null,
  expect: null,
  nav: false,
  say: null,
  state: 'pending',
  ...over,
});
const STEP = (over: Record<string, unknown> = {}): UiStep =>
  parseStep(RAW(over)) as UiStep;

function page(): { doc: FakeDocument; btn: FakeNode } {
  const doc = installFakeDom();
  const btn = new FakeNode('button');
  btn.innerText = 'Додати в кошик';
  doc.body.appendChild(btn);
  return { doc, btn };
}

const results = (posts: Posted[], planId?: string) =>
  posts
    .filter((p) => p.type === 'ui-step' && (!planId || p.planId === planId))
    .map((p) => p.result);

async function main() {
  // ── M13: клик только после ui-ack; повтор ui-run того же плана — игнор ──
  {
    const { btn } = page();
    const h = mkHost();
    const api = start(h.host);
    api.on({ type: 'ui-snap', rid: 'abcdefgh12', deny: [], allow: [] });
    const snap = h.posts.find((p) => p.type === 'ui-snapshot') as {
      snapshot: { elements: Array<{ ref: string; text: string }> };
    };
    assert.equal(snap.snapshot.elements[0].ref, 'e1');
    assert.equal(snap.snapshot.elements[0].text, 'Додати в кошик');
    const run = {
      type: 'ui-run',
      planId: 'p1',
      steps: [RAW()],
      from: 0,
      lang: 'uk',
    };
    api.on(run);
    await wait(80);
    assert.deepEqual(results(h.posts), ['dispatched']);
    assert.equal(btn.clicks, 0, 'M13: до ui-ack — ни одного клика');
    api.on(run);
    await wait(80);
    assert.deepEqual(
      results(h.posts),
      ['dispatched'],
      'повтор ui-run того же плана, пока раннер жив, — не второй исполнитель'
    );
    api.on({ type: 'ui-ack', planId: 'p1', index: 1 });
    await wait(30);
    assert.equal(btn.clicks, 0, 'ack чужого шага — не нажимаем');
    api.on({ type: 'ui-ack', planId: 'p1', index: 0 });
    await wait(500);
    assert.equal(btn.clicks, 1, 'после ack — ровно один клик');
    assert.deepEqual(results(h.posts), ['dispatched', 'done']);
    assert.equal(h.marks.at(-1), false, 'план кончился — флаг снят');
  }

  // ── гонка: новый план останавливает старый, флаг «план идёт» остаётся ──
  {
    const { btn, doc } = page();
    const h = mkHost();
    const api = start(h.host);
    api.on({ type: 'ui-snap', rid: 'abcdefgh12', deny: [], allow: [] });
    const run = (planId: string) => ({
      type: 'ui-run',
      planId,
      steps: [RAW()],
      from: 0,
      lang: 'uk',
    });
    api.on(run('p1'));
    await wait(80);
    api.on(run('p2'));
    await wait(80);
    assert.deepEqual(results(h.posts, 'p2'), ['dispatched']);
    assert.equal(
      h.marks.at(-1),
      true,
      'остановленный stop() раннер не снимает флаг нового (finish после stop)'
    );
    assert.equal(
      doc.body.querySelectorAll('[data-v4c-act]').length,
      1,
      'одна панель «Стоп» — нового плана'
    );
    // bfcache: pagehide без persisted — ничего; с persisted — стоп без отчёта.
    const ph = h.listeners.find(([t]) => t === 'pagehide');
    assert.ok(ph, 'act.js слушает pagehide');
    const n0 = h.posts.length;
    ph[1]({ persisted: false });
    await wait(10);
    assert.equal(doc.body.querySelectorAll('[data-v4c-act]').length, 1);
    ph[1]({ persisted: true });
    await wait(20);
    assert.equal(
      h.posts.length,
      n0,
      'bfcache: без ui-stopped/ui-step (страница уходит)'
    );
    assert.equal(
      h.marks.at(-1),
      true,
      'bfcache: флаг «план идёт» — для следующей страницы'
    );
    assert.equal(doc.body.querySelectorAll('[data-v4c-act]').length, 0);
    api.on({ type: 'ui-ack', planId: 'p2', index: 0 });
    await wait(50);
    assert.equal(btn.clicks, 0, 'остановленный раннер не нажимает');
  }

  // ── Н-4: select на опцию из стоп-листа — отказ ──────────────────────────
  {
    const doc = installFakeDom();
    const sel = new FakeSelect(['M', 'L', 'Скасувати замовлення']);
    doc.body.appendChild(sel);
    const rh: RunHost = {
      N: mkHost().host.N,
      report: () => undefined,
      stopped: () => undefined,
      need: () => undefined,
      min: () => undefined,
      mark: () => undefined,
      refs: new Map(),
      deny: [],
      allow: [],
    };
    const r = new Runner(rh, 'p1', [], 0, 'uk');
    const t = { ref: 'e1', role: 'combobox', text: '' };
    assert.equal(
      r.liveRefusal(
        STEP({ kind: 'select', value: 'Скасувати замовлення', target: t }),
        E(sel)
      ),
      'danger',
      'Н-4: опция «Скасувати замовлення» — стоп-лист'
    );
    assert.equal(
      r.liveRefusal(STEP({ kind: 'select', value: 'L', target: t }), E(sel)),
      null
    );
    // (д) act() помнит прежнее и поставленное: и для радио — прежнюю кнопку.
    const a = new FakeInput('radio');
    a.name = 'size';
    a.checked = true;
    const b = new FakeInput('radio');
    b.name = 'size';
    doc.body.appendChild(a);
    doc.body.appendChild(b);
    mem.length = 0;
    const act = (
      r as unknown as { act: (s: UiStep, el: Element) => boolean }
    ).act.bind(r);
    assert.equal(
      act(
        STEP({
          kind: 'check',
          i: 2,
          target: { ref: 'e2', role: 'radio', text: '' },
        }),
        E(b)
      ),
      true
    );
    assert.equal(b.checked, true);
    assert.equal(mem.length, 1);
    assert.equal(mem[0][5], a, 'прежняя отмеченная кнопка группы');
    assert.equal(mem[0][7], true, 'поставленный флажок');
    assert.equal(
      act(
        STEP({
          kind: 'select',
          i: 3,
          value: 'L',
          target: { ref: 'e1', role: 'combobox', text: '' },
        }),
        E(sel)
      ),
      true
    );
    assert.equal(sel.value, 'L');
    assert.deepEqual(mem[1].slice(3, 4), ['M']);
    assert.equal(mem[1][6], 'L', 'поставленное значение списка');
  }

  // ── снимок: ввод человека в contenteditable/role=textbox не уходит ─────
  {
    const doc = installFakeDom();
    const ce = new FakeNode('div');
    ce.isContentEditable = true;
    ce.innerText = 'мій секрет ivan@example.com';
    ce.setAttribute('aria-label', 'Повідомлення');
    const tb = new FakeNode('div');
    tb.setAttribute('role', 'textbox');
    tb.setAttribute('placeholder', 'Пошук');
    tb.innerText = 'секретний запит';
    const cb = new FakeNode('div');
    cb.setAttribute('role', 'combobox');
    cb.setAttribute('data-assist-id', 'city');
    cb.innerText = 'вул. Хрещатик, 1';
    const ok = new FakeNode('button');
    ok.innerText = 'Каталог';
    for (const n of [ce, tb, cb, ok]) doc.body.appendChild(n);
    assert.equal(visibleText(E(ce)), 'Повідомлення');
    assert.equal(visibleText(E(tb)), 'Пошук');
    assert.equal(visibleText(E(cb)), '');
    assert.equal(visibleText(E(ok)), 'Каталог');
    const s = JSON.stringify(takeSnapshot([], []).snapshot);
    assert.ok(!/секрет|Хрещатик/.test(s), `снимок без ввода: ${s}`);
    assert.ok(s.includes('Каталог') && s.includes('Пошук'));
    // M12: пароль, файл, cc-* — чувствительные; список с cc-* — тоже.
    const pw = new FakeInput('password');
    assert.equal(sensitiveField(E(pw)), true, 'M12: password');
    const txt = new FakeInput('text');
    assert.equal(sensitiveField(E(txt)), false);
    txt.setAttribute('autocomplete', 'cc-number');
    assert.equal(sensitiveField(E(txt)), true);
    const exp = new FakeSelect(['01', '02']);
    assert.equal(sensitiveField(E(exp)), false);
    exp.setAttribute('autocomplete', 'cc-exp-month');
    assert.equal(sensitiveField(E(exp)), true, 'список срока карты');
  }

  // ── возврат: только поставленное помощником; радио — прежней кнопкой ───
  {
    const doc = installFakeDom();
    const h = mkHost();
    const inp = new FakeInput('text');
    doc.body.appendChild(inp);
    inp.value = 'Київ';
    const p1: Prior = ['p1', 0, E(inp), 'Львів', false, null, 'Київ', false];
    undo({ planId: 'p1', idx: [0] }, [p1], h.host);
    await wait(30);
    assert.equal(inp.value, 'Львів', 'поле держит поставленное — вернули');
    assert.deepEqual((h.posts.at(-1) as { results: unknown }).results, [
      { i: 0, result: 'done' },
    ]);
    inp.value = 'Одеса'; // человек исправил после шага
    const p2: Prior = ['p2', 0, E(inp), 'Львів', false, null, 'Київ', false];
    undo({ planId: 'p2', idx: [0] }, [p2], h.host);
    await wait(30);
    assert.equal(inp.value, 'Одеса', 'чужой ввод не перетираем');
    assert.deepEqual((h.posts.at(-1) as { results: unknown }).results, [
      { i: 0, result: 'unknown' },
    ]);
    // Радио: помощник отметил b — возврат отмечает прежнюю a.
    const a = new FakeInput('radio');
    a.name = 'size';
    const b = new FakeInput('radio');
    b.name = 'size';
    b.checked = true;
    doc.body.appendChild(a);
    doc.body.appendChild(b);
    const p3: Prior = ['p3', 1, E(b), 'on', false, E(a), 'on', true];
    undo({ planId: 'p3', idx: [1] }, [p3], h.host);
    await wait(30);
    assert.equal(a.checked, true, 'прежняя кнопка группы снова отмечена');
    assert.equal(b.checked, false);
    assert.deepEqual((h.posts.at(-1) as { results: unknown }).results, [
      { i: 1, result: 'done' },
    ]);
  }

  console.log(
    'act: ack перед действием, гонка ui-run, bfcache, стоп-лист опций, снимок без ввода, чувствительные поля, возврат только своего — ok'
  );
}

// Тест на таймерах: «повисшее» ожидание опустошит цикл событий, и Node
// выйдет с кодом 0, не дойдя до конца, — такой выход считаем провалом.
let finished = false;
process.on('exit', (code) => {
  if (!finished && code === 0) {
    console.error('act.test: не дошли до конца (повисшее ожидание)');
    process.exitCode = 1;
  }
});
main()
  .then(() => (finished = true))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
