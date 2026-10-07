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
  FakeTextArea,
  installFakeDom,
  type FakeDocument,
} from './fake-dom';
import { start, type ActHost } from '../src/act/index';
import { start as adminStart } from '../src/admin-act/index';
import {
  fieldKey,
  mem,
  Runner,
  type Prior,
  type RunHost,
} from '../src/act/exec';
import {
  sensitiveField,
  takeSnapshot,
  UNDO_AT,
  UNDO_KIND,
  visibleText,
} from '../src/act/snapshot';
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
      _report: () => undefined,
      _stopped: () => undefined,
      _need: () => undefined,
      _min: () => undefined,
      _mark: () => undefined,
      _refs: new Map(),
      _deny: [],
      _allow: [],
    };
    const r = new Runner(rh, 'p1', [], 0, 'uk');
    const t = { ref: 'e1', role: 'combobox', text: '' };
    assert.equal(
      r._refusal(
        STEP({ kind: 'select', value: 'Скасувати замовлення', target: t }),
        E(sel)
      ),
      'danger',
      'Н-4: опция «Скасувати замовлення» — стоп-лист'
    );
    assert.equal(
      r._refusal(STEP({ kind: 'select', value: 'L', target: t }), E(sel)),
      null
    );
    // Отказ по живой цели — внутри `excluded`: `never`-зона и поле пароля
    // (раньше — отдельные проверки до него; результат тот же — `denied`).
    const zone = new FakeNode('div');
    zone.setAttribute('data-assist', 'never');
    const inZone = new FakeNode('button');
    inZone.innerText = 'Каталог';
    zone.appendChild(inZone);
    doc.body.appendChild(zone);
    const bt = { ref: 'e1', role: 'button', text: 'Каталог' };
    assert.equal(r._refusal(STEP({ target: bt }), E(inZone)), 'denied');
    const pw = new FakeInput('password');
    doc.body.appendChild(pw);
    assert.equal(
      r._refusal(
        STEP({ kind: 'fill', value: 'x', target: { ...bt, role: 'textbox' } }),
        E(pw)
      ),
      'denied',
      'поле пароля — отказ'
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
      r as unknown as { _act: (s: UiStep, el: Element) => boolean }
    )._act.bind(r);
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
    assert.equal(mem[0][6], 'size#', 'name/id поля в момент действия');
    assert.equal(mem[0][8], true, 'поставленный флажок');
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
    assert.equal(mem[1][7], 'L', 'поставленное значение списка');
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
    const K = fieldKey(E(inp));
    const p1: Prior = ['p1', 0, E(inp), 'Львів', false, null, K, 'Київ', false];
    undo({ planId: 'p1', idx: [0] }, [p1], h.host);
    await wait(30);
    assert.equal(inp.value, 'Львів', 'поле держит поставленное — вернули');
    assert.deepEqual((h.posts.at(-1) as { results: unknown }).results, [
      { i: 0, result: 'done' },
    ]);
    inp.value = 'Одеса'; // человек исправил после шага
    const p2: Prior = ['p2', 0, E(inp), 'Львів', false, null, K, 'Київ', false];
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
    const p3: Prior = ['p3', 1, E(b), 'on', false, E(a), 'size#', 'on', true];
    undo({ planId: 'p3', idx: [1] }, [p3], h.host);
    await wait(30);
    assert.equal(a.checked, true, 'прежняя кнопка группы снова отмечена');
    assert.equal(b.checked, false);
    assert.deepEqual((h.posts.at(-1) as { results: unknown }).results, [
      { i: 1, result: 'done' },
    ]);
    // Аудит (е) (2): узел прежней кнопки отдан другой группе (перерисовка
    // без ключей) — не кликаем, `unknown`; чужая группа не меняется.
    const c = new FakeInput('radio');
    c.name = 'size';
    const d = new FakeInput('radio');
    d.name = 'size';
    d.checked = true;
    doc.body.appendChild(c);
    doc.body.appendChild(d);
    const p4: Prior = ['p4', 2, E(d), 'on', false, E(c), 'size#', 'on', true];
    c.name = 'color';
    const clicks = c.clicks;
    undo({ planId: 'p4', idx: [2] }, [p4], h.host);
    await wait(30);
    assert.equal(c.clicks, clicks, 'кнопку другой группы не нажимаем');
    assert.equal(c.checked, false);
    assert.equal(d.checked, true);
    assert.deepEqual((h.posts.at(-1) as { results: unknown }).results, [
      { i: 2, result: 'unknown' },
    ]);
    // Прежняя кнопка ушла со страницы — тоже `unknown`.
    c.name = 'size';
    c.remove();
    undo({ planId: 'p4', idx: [2] }, [p4], h.host);
    await wait(30);
    assert.deepEqual((h.posts.at(-1) as { results: unknown }).results, [
      { i: 2, result: 'unknown' },
    ]);
  }

  // ── «Админка» (admin-act): повтор ui-run того же плана и bfcache ──────
  {
    const { btn, doc } = page();
    const h = mkHost();
    const api = adminStart(h.host);
    api.on({ type: 'ui-snap', rid: 'abcdefgh12', deny: [], allow: [] });
    const run = { type: 'ui-run', planId: 'a1', steps: [RAW()], from: 0 };
    api.on(run);
    await wait(80);
    assert.deepEqual(results(h.posts), ['dispatched']);
    api.on(run);
    await wait(80);
    assert.deepEqual(
      results(h.posts),
      ['dispatched'],
      'admin-act: повтор ui-run того же плана, пока раннер жив, — игнор'
    );
    assert.equal(doc.body.querySelectorAll('[data-v4c-act]').length, 1);
    // Другой план — старый стоп, новый идёт (как было).
    api.on({ ...run, planId: 'a2' });
    await wait(80);
    assert.deepEqual(results(h.posts, 'a2'), ['dispatched']);
    assert.equal(doc.body.querySelectorAll('[data-v4c-act]').length, 1);
    // bfcache: pagehide без persisted — ничего; с persisted — тихий стоп.
    const ph = h.listeners.find(([t]) => t === 'pagehide');
    assert.ok(ph, 'admin-act слушает pagehide');
    ph[1]({ persisted: false });
    await wait(10);
    assert.equal(doc.body.querySelectorAll('[data-v4c-act]').length, 1);
    const n0 = h.posts.length;
    ph[1]({ persisted: true });
    await wait(20);
    assert.equal(h.posts.length, n0, 'admin-act bfcache: без отчёта');
    assert.equal(h.marks.at(-1), true, 'admin-act bfcache: флаг остаётся');
    assert.equal(doc.body.querySelectorAll('[data-v4c-act]').length, 0);
    api.on({ type: 'ui-ack', planId: 'a2', index: 0 });
    await wait(50);
    assert.equal(btn.clicks, 0, 'остановленный раннер «Админки» не нажимает');
  }

  // ── мемо-хвост (е) (2): узел отдан другому полю — `unknown` без записи ──
  {
    const doc = installFakeDom();
    const h = mkHost();
    const rh: RunHost = {
      N: h.host.N,
      _report: () => undefined,
      _stopped: () => undefined,
      _need: () => undefined,
      _min: () => undefined,
      _mark: () => undefined,
      _refs: new Map(),
      _deny: [],
      _allow: [],
    };
    const r = new Runner(rh, 'k1', [], 0, 'uk');
    const act = (
      r as unknown as { _act: (s: UiStep, el: Element) => boolean }
    )._act.bind(r);
    const txt = new FakeInput('text');
    txt.name = 'city';
    txt.setAttribute('id', 'c1');
    txt.value = 'Львів';
    const area = new FakeTextArea();
    area.name = 'note';
    area.value = 'було';
    const flag = new FakeInput('checkbox');
    flag.name = 'agree';
    const sel = new FakeSelect(['S', 'M', 'L']);
    sel.name = 'size';
    for (const n of [txt, area, flag, sel]) doc.body.appendChild(n);
    mem.length = 0;
    const tgt = (role: string) => ({ ref: 'e1', role, text: '' });
    assert.ok(
      act(
        STEP({ kind: 'fill', i: 0, value: 'Київ', target: tgt('textbox') }),
        E(txt)
      )
    );
    assert.ok(
      act(
        STEP({ kind: 'fill', i: 1, value: 'стало', target: tgt('textbox') }),
        E(area)
      )
    );
    assert.ok(
      act(STEP({ kind: 'check', i: 2, target: tgt('checkbox') }), E(flag))
    );
    assert.ok(
      act(
        STEP({ kind: 'select', i: 3, value: 'L', target: tgt('combobox') }),
        E(sel)
      )
    );
    assert.deepEqual(
      mem.map((p) => p[6]),
      ['city#c1', 'note#', 'agree#', 'size#'],
      'name/id запомнены в момент действия'
    );
    assert.equal(flag.checked, true);
    // Перерисовка без ключей: узлы отданы другим полям (name или id другие).
    txt.name = 'phone';
    area.setAttribute('id', 'other');
    flag.name = 'subscribe';
    sel.name = 'color';
    const clicks = flag.clicks;
    undo({ planId: 'k1', idx: [0, 1, 2] }, mem, h.host);
    await wait(30);
    assert.deepEqual((h.posts.at(-1) as { results: unknown }).results, [
      { i: 0, result: 'unknown' },
      { i: 1, result: 'unknown' },
      { i: 2, result: 'unknown' },
    ]);
    assert.equal(txt.value, 'Київ', 'текст: чужое поле не перезаписано');
    assert.equal(area.value, 'стало', 'textarea: чужое поле не перезаписано');
    assert.equal(flag.checked, true, 'флажок: не кликнут');
    assert.equal(flag.clicks, clicks);
    undo({ planId: 'k1', idx: [3] }, mem, h.host);
    await wait(30);
    assert.deepEqual((h.posts.at(-1) as { results: unknown }).results, [
      { i: 3, result: 'unknown' },
    ]);
    assert.equal(sel.value, 'L', 'список: чужое поле не перезаписано');
    // Те же поля снова «свои» — возврат идёт.
    txt.name = 'city';
    area.attrs.delete('id');
    flag.name = 'agree';
    sel.name = 'size';
    undo({ planId: 'k1', idx: [0, 1, 2] }, mem, h.host);
    await wait(30);
    assert.deepEqual((h.posts.at(-1) as { results: unknown }).results, [
      { i: 0, result: 'done' },
      { i: 1, result: 'done' },
      { i: 2, result: 'done' },
    ]);
    assert.equal(txt.value, 'Львів');
    assert.equal(area.value, 'було');
    assert.equal(flag.checked, false);
    undo({ planId: 'k1', idx: [3] }, mem, h.host);
    await wait(30);
    assert.equal(sel.value, 'S');
    assert.deepEqual((h.posts.at(-1) as { results: unknown }).results, [
      { i: 3, result: 'done' },
    ]);
  }

  // ── Э6-тер (и): снимок несёт объявленную пару разметки (строгая сверка) ──
  {
    const doc = installFakeDom();
    const mk = (id: string, undoAttr: string | null, at: string | null) => {
      const b = new FakeNode('button');
      b.innerText = 'В кошик ' + id;
      b.setAttribute('data-assist-id', id);
      if (undoAttr !== null) b.setAttribute('data-assist-undo', undoAttr);
      if (at !== null) b.setAttribute('data-assist-undo-at', at);
      doc.body.appendChild(b);
    };
    mk('ok-at', 'remove-from-cart', '/cart/');
    mk('ok-here', 'remove-from-wishlist', null);
    mk('ok-cmp', 'remove-from-compare', '/compare/%D0%BF');
    const badKinds = [
      'del-x',
      'remove-from-cart2',
      'checkout',
      'remove-from-',
      '',
    ];
    badKinds.forEach((u, k) => mk('bad-kind-' + k, u, null));
    const badAt = [
      '//evil.example/cart',
      '/\\evil.example/cart',
      'https://evil.example/cart',
      'cart/',
      '/cart?x=1',
      '/cart#a',
      '/ca*rt',
      '/кошик/',
      '/c art',
      '/' + 'a'.repeat(200),
      '',
    ];
    badAt.forEach((at, k) => mk('bad-at-' + k, 'remove-from-cart', at));
    const els = takeSnapshot([], []).snapshot.elements as Array<{
      assistId: string | null;
      undo?: string;
      undoAt?: string | null;
    }>;
    const by = (id: string) => els.find((e) => e.assistId === id)!;
    assert.equal(by('ok-at').undo, 'remove-from-cart');
    assert.equal(by('ok-at').undoAt, '/cart/');
    assert.equal(by('ok-here').undo, 'remove-from-wishlist');
    assert.equal(by('ok-here').undoAt, null, 'без -at — эта страница');
    assert.equal(by('ok-cmp').undoAt, '/compare/%D0%BF');
    for (let k = 0; k < badKinds.length; k++)
      assert.ok(
        !('undo' in by('bad-kind-' + k)) && !('undoAt' in by('bad-kind-' + k)),
        `вид не из закрытого списка: «${badKinds[k]}»`
      );
    for (let k = 0; k < badAt.length; k++)
      assert.ok(
        !('undo' in by('bad-at-' + k)),
        `-at не путь своего origin — без пары: «${badAt[k]}»`
      );
    assert.ok(UNDO_KIND.test('remove-from-cart') && !UNDO_AT.test('//x'));
    // Без атрибутов — полей нет вовсе (снимок не растёт).
    const plain = new FakeNode('button');
    plain.innerText = 'Каталог';
    doc.body.appendChild(plain);
    const el = takeSnapshot([], []).snapshot.elements.find(
      (e) => e.text === 'Каталог'
    )!;
    assert.ok(!('undo' in el) && !('undoAt' in el));
  }

  console.log(
    'act: ack перед действием, гонка ui-run, bfcache (и «Админка»), стоп-лист опций, снимок без ввода, чувствительные поля, возврат только своего поля (name/id), пара разметки в снимке — ok'
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
