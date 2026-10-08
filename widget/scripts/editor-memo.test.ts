/**
 * Э6-тер (д): вкладка «Мемо» панели редактора без браузера (мини-DOM) —
 * запись кликами: клик пикера → запрос шага на сервер (дескриптор БЕЗ
 * значений, имя поля и подписи вариантов — да), «исполнить по-настоящему»
 * только по слову сервера; остановка на опасном; перепривязка (`prev`,
 * шаг заменяется); перестановка/удаление; сохранение; «Прогнать» —
 * подсветка ✓/✗ и стоп на первом сбое; состояние записи переживает
 * переход страницы (`sessionStorage` origin `we.`). Протокол: `perform`,
 * `fieldName`/`options` в `pick` — строго.
 * Заход 9: список всех мемо (клик — открыть), «Чекати це» (ожидание, не
 * шаг: появление у шага / лічильник цели, снять — `goalCounter: null`),
 * «Як скасувати» шага (↶ — карточка цели), протокол `multi`/`picks`/`search`.
 */
import assert from 'node:assert/strict';
import { FakeNode } from './fake-dom';
import {
  editorEnvelope,
  parseToPanel,
  parseToPicker,
  type ToPanel,
  type ToPicker,
} from '../src/shared/editor-protocol';
import { T } from '../src/editor-panel/i18n';
import { createMemo } from '../src/editor-panel/memo';

// ── мини-DOM панели: узлы с обработчиками и детьми ──
class N extends FakeNode {
  on = new Map<string, Array<(e: Event) => void>>();
  value = '';
  kids: Array<N | string> = [];
  addEventListener(t: string, f: (e: Event) => void) {
    this.on.set(t, [...(this.on.get(t) ?? []), f]);
  }
  append(...k: Array<N | string>) {
    this.kids.push(...k);
  }
  text(): string {
    return this.kids
      .map((k) => (typeof k === 'string' ? k : k.text()))
      .join(' ');
  }
  all(tag: string): N[] {
    const out: N[] = [];
    for (const k of this.kids)
      if (typeof k !== 'string') {
        if (k.tagName === tag.toUpperCase()) out.push(k);
        out.push(...k.all(tag));
      }
    return out;
  }
  fire(t: string, isTrusted = true) {
    for (const f of this.on.get(t) ?? []) f({ isTrusted } as unknown as Event);
  }
}
function h(
  tag: string,
  attrs: Record<string, string | boolean | ((e: Event) => void)> = {},
  ...kids: Array<N | string | null | false>
): N {
  const e = new N(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') e.addEventListener(k, v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false) e.setAttribute(k, v);
    if (k === 'value' && typeof v === 'string') e.value = v;
  }
  for (const c of kids) if (c !== null && c !== false) e.append(c);
  return e;
}
const human =
  (fn: () => void) =>
  (e: Event): void => {
    if (!e.isTrusted) return;
    fn();
  };

// ── sessionStorage origin `we.` (переход MPA — новый экземпляр панели) ──
const storage = new Map<string, string>();
(globalThis as unknown as { sessionStorage: Storage }).sessionStorage = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
} as unknown as Storage;

// ── сервер: ответы по маршруту, журнал запросов ──
const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
const replies: Record<string, Array<unknown>> = {};
const reply = (path: string, v: unknown) =>
  (replies[path] = [...(replies[path] ?? []), v]);
const sent: ToPicker[] = [];
let note = '';
let renders = 0;
const edited: string[] = [];

function panel() {
  return createMemo({
    h: h as never,
    human,
    api: async <X>(path: string, init: RequestInit = {}) => {
      const body = JSON.parse(String(init.body ?? '{}'));
      calls.push({ path, body });
      const q = replies[path] ?? [];
      const v = q.shift();
      if (v instanceof Error) throw v;
      return v as X;
    },
    toPicker: (m) => void sent.push(m),
    snapshot: async () => ({
      url: 'https://shop.example.com/p/1',
      elements: [],
    }),
    L: () => T.uk,
    lang: () => 'uk',
    path: () => '/p/1',
    note: (s) => (note = s),
    fail: (e) => (note = `fail:${(e as Error).message}`),
    render: () => void renders++,
    store: 'v4c_ed:pk',
    edit: (k) => void edited.push(k),
  });
}
const tick = () => new Promise((r) => setTimeout(r, 0));

const pick = (descriptor: Record<string, unknown>, extra = {}) =>
  parseToPanel(
    editorEnvelope({
      type: 'pick',
      descriptor,
      how: 'text',
      stability: 'medium',
      never: false,
      crumbs: [],
      ...extra,
    })
  ) as Extract<ToPanel, { type: 'pick' }>;

const step = (action: string, text: string, slot?: string) => ({
  action,
  page: '/p/*',
  target: { pin: { text } },
  value: slot ? { slot } : null,
});

async function main() {
  // 0. Протокол: perform, поле для слота — строго; значения поля нет.
  assert.deepEqual(
    parseToPicker(editorEnvelope({ type: 'perform', pid: 'k1', ref: 'e1' })),
    { type: 'perform', pid: 'k1' }
  );
  assert.equal(
    parseToPicker(editorEnvelope({ type: 'perform' })),
    null,
    'perform без метки настоящего клика — мусор'
  );
  assert.equal(parseToPicker({ type: 'perform' }), null, 'без ns — мусор');
  const pf = pick(
    { tag: 'select', role: 'combobox', text: 'Розмір', value: 'M' },
    { fieldName: 'size', options: ['S', 'M', 7, 'x'.repeat(200)] }
  );
  assert.equal(pf.fieldName, 'size');
  assert.deepEqual(pf.options, ['S', 'M']);
  assert.ok(!('value' in pf.descriptor), 'значения поля в дескрипторе нет');

  let m = panel();
  assert.equal(m.active(), false);
  // Вкладка без записи (заход 9, №21): список всех мемо — один запрос.
  reply('/editor/v1/memo/list?lang=uk', {
    items: [
      { number: 3, name: 'Кошик', status: 'published', page: '/p/*' },
      { number: 5, name: null, status: 'draft', page: null },
    ],
  });
  let v = m.view() as unknown as N;
  m.view();
  await tick();
  assert.equal(calls.length, 1, 'список — один запрос');
  assert.equal(calls[0].path, '/editor/v1/memo/list?lang=uk');
  calls.length = 0;
  v = m.view() as unknown as N;
  const listed = v.all('li').map((x) => x.text());
  assert.deepEqual(listed, [
    'М-3 Кошик · опубліковано · /p/*',
    'М-5  · чернетка',
  ]);
  // Клик по мемо — открыть его (как «Открыть в редакторе»).
  reply('/editor/v1/memo/record/start', { memo: null });
  v.all('li')[0].all('button')[0].fire('click');
  await tick();
  assert.deepEqual(calls[0].body, { path: '/p/1', memo: 3, lang: 'uk' });
  calls.length = 0;
  sent.length = 0;
  m.reset();
  // «Записати» — только кликом человека.
  reply('/editor/v1/memo/list?lang=uk', { items: [] });
  v = m.view() as unknown as N;
  await tick();
  calls.length = 0;
  const rec = v.all('button').find((b) => b.text() === T.uk.mRec)!;
  rec.fire('click', false);
  assert.equal(calls.length, 0, 'скрипт страницы не начинает запись');
  reply('/editor/v1/memo/record/start', { memo: null, page: '/p/*' });
  rec.fire('click');
  await tick();
  assert.equal(calls[0].path, '/editor/v1/memo/record/start');
  assert.deepEqual(calls[0].body, { path: '/p/1', memo: null, lang: 'uk' });
  assert.equal(m.active(), true);
  assert.deepEqual(sent.pop(), { type: 'mode', mode: 'select' });

  // 1. Клик «В кошик» → шаг; сервер разрешил исполнить — perform.
  reply('/editor/v1/memo/record/step', {
    kind: 'step',
    step: step('click', 'В кошик'),
    slot: null,
    risk: 'auto',
    exec: true,
    undo: { assistId: 'remove-from-cart', key: 'cart' },
  });
  assert.equal(
    await m.onPick(
      pick(
        { tag: 'button', text: 'В кошик', assistId: 'add-to-cart' },
        { pid: 'k7' }
      )
    ),
    true
  );
  assert.deepEqual(sent.pop(), { type: 'perform', pid: 'k7' });

  // 2. Поле → слот без значения; не исполняется (exec: false).
  reply('/editor/v1/memo/record/step', {
    kind: 'step',
    step: step('fill', 'E-mail', 'email'),
    slot: { name: 'email', kind: 'email', pii: true, options: [] },
    risk: 'confirm',
    exec: false,
  });
  await m.onPick(
    pick(
      {
        tag: 'input',
        role: 'textbox',
        text: 'E-mail',
        value: 'owner.secret@example.com',
      },
      { fieldName: 'email' }
    )
  );
  assert.equal(sent.length, 0, 'поле не нажимается');
  const last = calls[calls.length - 1];
  assert.equal(last.body.fieldName, 'email');
  assert.equal(last.body.count, 1);
  assert.deepEqual(last.body.slots, []);
  assert.ok(
    !JSON.stringify(calls).includes('owner.secret'),
    'значение не уходит'
  );

  // 3. Переход MPA: новый экземпляр панели продолжает запись.
  m = panel();
  assert.equal(m.active(), true, 'запись пережила переход страницы');
  assert.equal(m.has(), true);

  // 4. «Оплатити» — стоп: подсветка последним шагом, запись выключена.
  reply('/editor/v1/memo/record/step', {
    kind: 'stop',
    reason: 'payment',
    step: step('highlight', 'Оплатити'),
  });
  await m.onPick(pick({ tag: 'button', text: 'Оплатити' }));
  assert.equal(m.active(), false);
  assert.ok(note.startsWith(T.uk.mNever) && note.includes('payment'), note);
  assert.equal(sent.length, 0, 'опасное не нажимается');
  // Дальше клики не записываются.
  assert.equal(await m.onPick(pick({ tag: 'button', text: 'Ще' })), false);

  // 5. Список шагов: перестановка и перепривязка (⌖ → клик по другому элементу).
  v = m.view() as unknown as N;
  let items = v.all('li');
  assert.equal(items.length, 3);
  assert.ok(items[1].text().includes('{email}'));
  assert.ok(items[1].text().includes('⚠'), 'fill «після Так»');
  // ↓ у первого шага: «В кошик» ↔ e-mail.
  items[0]
    .all('button')
    .find((b) => b.text() === '↓')!
    .fire('click');
  v = m.view() as unknown as N;
  items = v.all('li');
  assert.ok(items[0].text().includes('E-mail'));
  // ⌖ на шаге 2 («В кошик») → режим выбора, следующий клик — перепривязка.
  items[1]
    .all('button')
    .find((b) => b.text() === '⌖')!
    .fire('click');
  assert.deepEqual(sent.pop(), { type: 'mode', mode: 'select' });
  assert.equal(m.active(), true);
  reply('/editor/v1/memo/record/step', {
    kind: 'step',
    step: step('click', 'Додати в кошик'),
    slot: null,
    risk: 'auto',
    exec: true,
  });
  await m.onPick(pick({ tag: 'button', text: 'Додати в кошик' }));
  const rb = calls[calls.length - 1].body;
  assert.deepEqual(
    (rb.prev as { target: { pin: { text: string } } }).target.pin.text,
    'В кошик'
  );
  assert.equal(sent.length, 0, 'перепривязка не нажимает');
  v = m.view() as unknown as N;
  items = v.all('li');
  assert.ok(items[1].text().includes('Додати в кошик'));
  assert.equal(items.length, 3);
  // ✕ — удалить подсветку.
  items[2]
    .all('button')
    .find((b) => b.text() === '✕')!
    .fire('click');

  // 6. Сохранить черновик: имя, цель, шаги после правок.
  v = m.view() as unknown as N;
  const [name, goal] = v.all('input');
  name.value = 'Покласти в кошик';
  name.fire('change');
  goal.value = 'Товар у кошику';
  goal.fire('change');
  reply('/editor/v1/memo/record/stop', {
    number: 4,
    key: 'poklasty-v-koshyk',
    draftRevision: 0,
    gates: { ok: false, problems: [{}] },
  });
  v.all('button')
    .find((b) => b.text() === T.uk.mSave)!
    .fire('click');
  await new Promise((r) => setTimeout(r, 0));
  const saved = calls[calls.length - 1];
  assert.equal(saved.path, '/editor/v1/memo/record/stop');
  assert.equal(saved.body.name, 'Покласти в кошик');
  assert.equal(saved.body.goalText, 'Товар у кошику');
  assert.equal(saved.body.memo, null);
  assert.equal((saved.body.steps as unknown[]).length, 2);
  assert.deepEqual(saved.body.slots, [
    { name: 'email', kind: 'email', pii: true, options: [] },
  ]);
  assert.ok(note.includes('М-4'), note);

  // 6а (заход 9, №23). «Як скасувати» шага — из цели карты: ↶ → карточка.
  // (Шаг «В кошик» перепривязан выше — у нового шага пары нет; проверяем
  // на свежей записи ниже.)

  // 7. «Прогнати»: подсветка ✓/✗, стоп на первом сбое — шаг выбран.
  reply('/editor/v1/memo/poklasty-v-koshyk/try', {
    steps: [
      { i: 0, ok: true, problem: null, ref: 'e2', action: 'fill' },
      { i: 1, ok: false, problem: 'pin_mismatch', ref: 'e1', action: 'click' },
    ],
    stopAt: 1,
    problem: 'pin_mismatch',
    next: null,
    goal: null,
    done: false,
  });
  v = m.view() as unknown as N;
  v.all('button')
    .find((b) => b.text() === T.uk.mTry)!
    .fire('click');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(sent.pop(), {
    type: 'highlight',
    items: [
      { ref: 'e2', label: '1. fill ✓' },
      { ref: 'e1', label: '2. click ✗' },
    ],
  });
  v = m.view() as unknown as N;
  assert.ok(v.text().includes(T.uk.p_pin_mismatch), 'понятная причина');
  assert.equal(
    v.all('li')[1].getAttribute('class'),
    'on',
    'сломанный шаг выбран'
  );

  // 8. «Открыть в редакторе» мемо N на шаге K (ссылка focus).
  reply('/editor/v1/memo/record/start', {
    memo: {
      number: 7,
      key: 'm7',
      draftRevision: 3,
      name: 'М',
      goalText: null,
      steps: [step('click', 'A'), step('click', 'B')],
      slots: [],
    },
  });
  await m.open(7, 1);
  assert.deepEqual(calls[calls.length - 1].body, {
    path: '/p/1',
    memo: 7,
    lang: 'uk',
  });
  v = m.view() as unknown as N;
  assert.equal(v.all('li')[1].getAttribute('class'), 'on');
  assert.equal(m.active(), false, 'правка мемо не включает запись сама');
  m.reset();
  assert.equal(storage.size, 0);

  // 9. Поддельный `pick` скрипта страницы (без метки настоящего клика):
  // шаг виден владельцу в списке, но нажатия по нему нет.
  reply('/editor/v1/memo/record/start', { memo: null });
  await m.open(null);
  reply('/editor/v1/memo/record/step', {
    kind: 'step',
    step: step('click', 'В кошик'),
    slot: null,
    risk: 'auto',
    exec: true,
  });
  sent.length = 0;
  await m.onPick(pick({ tag: 'button', text: 'В кошик' }));
  assert.equal(
    sent.filter((x) => x.type === 'perform').length,
    0,
    'без метки клика — без нажатия'
  );
  // 10 (заход 9, №22/№23). «Чекати це» и «Як скасувати».
  reply('/editor/v1/memo/record/step', {
    kind: 'step',
    step: {
      ...step('click', 'В кошик'),
      target: { pin: { text: 'В кошик' }, mapKey: 'cart' },
    },
    slot: null,
    risk: 'auto',
    exec: false,
    undo: { assistId: 'remove-from-cart', key: 'cart' },
  });
  await m.onPick(pick({ tag: 'button', text: 'В кошик' }, { pid: 'k9' }));
  v = m.view() as unknown as N;
  const li = v.all('li').pop()!;
  assert.ok(li.text().includes('↶remove-from-cart'), li.text());
  li.all('button')
    .find((b) => b.text() === '↶')!
    .fire('click');
  assert.deepEqual(edited, ['cart'], '↶ — карточка цели карты');
  const nSteps = v.all('li').length;
  // «Чекати це»: следующий клик — ожидание (не шаг, не нажатие).
  v.all('button')
    .find((b) => b.text() === T.uk.mWait)!
    .fire('click');
  assert.equal(note, T.uk.mWaitHint);
  assert.deepEqual(sent.pop(), { type: 'mode', mode: 'select' });
  reply('/editor/v1/memo/record/wait', { kind: 'appear', text: 'Додано' });
  sent.length = 0;
  assert.equal(
    await m.onPick(
      pick({ tag: 'other', role: 'button', text: 'Додано' }, { pid: 'w1' })
    ),
    true
  );
  assert.equal(calls[calls.length - 1].path, '/editor/v1/memo/record/wait');
  assert.equal(sent.length, 0, 'ожидание не нажимает');
  v = m.view() as unknown as N;
  assert.equal(v.all('li').length, nSteps, 'ожидание — не шаг');
  assert.ok(v.all('li').pop()!.text().includes('→ «Додано»'));
  // Счётчик корзины — цель «лічильник +1»; ✕ — снять (goalCounter: null).
  v.all('button')
    .find((b) => b.text() === T.uk.mWait)!
    .fire('click');
  reply('/editor/v1/memo/record/wait', {
    kind: 'counter',
    target: { assistId: 'nav-cart', text: 'кошик' },
    delta: 1,
    now: 0,
  });
  await m.onPick(pick({ tag: 'a', role: 'link', text: 'Кошик (0)' }));
  v = m.view() as unknown as N;
  assert.ok(v.text().includes(`${T.uk.mCnt} «кошик» +1`), v.text());
  reply('/editor/v1/memo/record/stop', {
    number: 9,
    key: 'm9',
    draftRevision: 0,
    gates: { ok: true, problems: [] },
  });
  v.all('button')
    .find((b) => b.text() === T.uk.mSave)!
    .fire('click');
  await tick();
  const st1 = calls[calls.length - 1].body;
  assert.deepEqual(st1.goalCounter, {
    target: { assistId: 'nav-cart', text: 'кошик' },
    delta: 1,
  });
  const sentSteps = st1.steps as Array<{ expect?: { appear?: string } }>;
  assert.equal(sentSteps[sentSteps.length - 1].expect?.appear, 'Додано');
  v = m.view() as unknown as N;
  v.all('p')
    .find((p) => p.text().includes(T.uk.mCnt))!
    .all('button')[0]
    .fire('click');
  reply('/editor/v1/memo/record/stop', {
    number: 9,
    key: 'm9',
    draftRevision: 1,
    gates: { ok: true, problems: [] },
  });
  v = m.view() as unknown as N;
  v.all('button')
    .find((b) => b.text() === T.uk.mSave)!
    .fire('click');
  await tick();
  assert.equal(calls[calls.length - 1].body.goalCounter, null, 'снять счётчик');

  // 11 (заход 9). Протокол: Shift+клик (`multi`), рамка (`picks`), `/` (`search`).
  assert.equal(pick({ tag: 'button', text: 'A' }, { multi: true }).multi, true);
  assert.equal(
    pick({ tag: 'button', text: 'A' }, { multi: 'yes' }).multi,
    false
  );
  const picks = parseToPanel(
    editorEnvelope({
      type: 'picks',
      items: [
        { tag: 'button', text: 'A', value: 'secret' },
        { tag: 'script' },
        ...Array.from({ length: 60 }, (_, i) => ({ tag: 'a', text: `L${i}` })),
      ],
    })
  ) as Extract<ToPanel, { type: 'picks' }>;
  assert.equal(picks.items.length, 39, 'мусор вон, ≤ 40 разобранных');
  assert.ok(!JSON.stringify(picks).includes('secret'), 'значений нет');
  assert.deepEqual(parseToPanel(editorEnvelope({ type: 'search', x: 1 })), {
    type: 'search',
  });
  assert.equal(parseToPanel(editorEnvelope({ type: 'picks' })), null);

  m.reset();
  assert.ok(renders > 0);
  console.log(
    'editor-memo: запись кликами, стоп, перепривязка, сохранение, прогон'
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
