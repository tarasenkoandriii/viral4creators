/**
 * Э6-тер (и) «Компенсации» — сторона iframe (`chat/ui-plan.ts`) без DOM:
 *  - «Повернути» → сервер даёт работу по одной в обратном порядке: сначала
 *    компенсация — отметка `dispatched` ДО команды загрузчику, затем итог,
 *    затем поле;
 *  - страница отмены другая — переход (`go`), продолжение на ней (`next`),
 *    круга нет (второй раз — «не смог», 0 кликов);
 *  - нет записи `dispatched` — нет команды загрузчику;
 *  - загрузчик молчит — `unknown` («перевірте самі»), не «прибрав»;
 *  - тексты без «откатил/отменил»; протокол сообщения `ui-undo` + `comp`
 *    разбирает comp.js (сверка ключей).
 */
import assert from 'node:assert/strict';
import { DICTS } from '../src/chat/i18n';
import {
  parseCompView,
  uiPlanOff,
  UiPlanController,
  type UiPlanUi,
} from '../src/chat/ui-plan';

type Call = { path: string; body: Record<string, unknown> };

const COMP = {
  i: 1,
  text: 'В кошик',
  row: 'Футболка синя',
  assistId: 'remove-from-cart',
  at: null as string | null,
  variant: ['M'],
  allow: ['remove'],
  dispatched: false,
};

function mk(
  o: {
    page?: string;
    store?: Map<string, string>;
    reply?: (c: Call) => unknown;
  } = {}
) {
  let ui: UiPlanUi = uiPlanOff();
  const feed: string[] = [];
  const toParent: Array<Record<string, unknown>> = [];
  const calls: Call[] = [];
  const store = o.store ?? new Map<string, string>([['vcconsent', '1']]);
  const st = {
    reply: o.reply ?? ((_c: Call) => null as unknown),
  };
  const pc = new UiPlanController({
    ui: () => ui,
    setUi: (p) => (ui = { ...ui, ...p }),
    t: () => DICTS.uk,
    lang: () => 'uk',
    cfg: () => ({
      mode: 'on',
      denySelectors: ['.ads'],
      allowSelectors: [],
      maxSteps: 6,
      memos: false,
    }),
    api: async (_m, path, body) => {
      const c = { path, body: (body ?? {}) as Record<string, unknown> };
      calls.push(c);
      return st.reply(c);
    },
    toParent: (m) => toParent.push(m as unknown as Record<string, unknown>),
    conversationId: () => null,
    setConversation: () => undefined,
    feed: (_r, t) => feed.push(t),
    storage: (_k, n, v) => {
      if (v === undefined) return store.get(n) ?? null;
      if (v === null) store.delete(n);
      else store.set(n, v);
      return null;
    },
    pageUrl: () => o.page ?? 'https://shop.example.com/p/1',
    listen: () => undefined,
    random: () => 'r'.repeat(16),
  });
  return { pc, feed, toParent, calls, store, st };
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // Разбор строгий: чужой путь/разметка — компенсации нет.
  assert.equal(parseCompView({ ...COMP, at: '//evil.example/' }), null);
  assert.equal(parseCompView({ ...COMP, at: 'https://evil.example/' }), null);
  assert.equal(parseCompView({ ...COMP, assistId: 'a"]' }), null);
  assert.deepEqual(
    parseCompView({ ...COMP, allow: ['remove', 'pay'] })?.allow,
    ['remove']
  );

  // ── эта страница: dispatched → команда → итог → поле → итог ─────────────
  {
    const m = mk();
    m.store.set('last', 'p1');
    m.st.reply = (c) => {
      if (c.path.endsWith('/undo'))
        return { fields: [], manual: [], comp: COMP, refused: null };
      if (c.body.dispatch === 1) return { comp: { ...COMP, dispatched: true } };
      const r = c.body.results as Array<{ i: number }> | undefined;
      if (r && r[0].i === 1)
        return { fields: [{ i: 0, text: 'Розмір' }], comp: null };
      return { fields: [], comp: null, chainStatus: 'compensated' };
    };
    assert.equal(await m.pc.command('відміни останнє', 'typed', null), true);
    await tick();
    assert.deepEqual(
      m.calls.map((c) => [c.path.split('/').pop(), c.body]),
      [
        ['undo', { by: 'command' }],
        ['undo-report', { dispatch: 1 }],
      ]
    );
    const cmd = m.toParent.at(-1)!;
    assert.deepEqual(cmd, {
      type: 'ui-undo',
      planId: 'p1',
      idx: [],
      comp: {
        i: 1,
        id: 'remove-from-cart',
        row: 'Футболка синя',
        variant: ['M'],
        allow: ['remove'],
        deny: ['.ads'],
        zones: [],
        nav: 0,
      },
    });
    m.pc.onParent({
      type: 'ui-undone',
      planId: 'p1',
      results: [{ i: 1, result: 'done' }],
    });
    await tick();
    assert.match(m.feed.join('\n'), /Прибрав «Футболка синя»/);
    assert.deepEqual(m.toParent.at(-1), {
      type: 'ui-undo',
      planId: 'p1',
      idx: [0],
    });
    m.pc.onParent({
      type: 'ui-undone',
      planId: 'p1',
      results: [{ i: 0, result: 'done' }],
    });
    await tick();
    assert.deepEqual(
      m.calls.slice(2).map((c) => c.body),
      [
        { results: [{ i: 1, result: 'done' }] },
        { results: [{ i: 0, result: 'done' }] },
      ]
    );
    assert.match(m.feed.at(-1)!, /Повернув попереднє значення поля «Розмір»/);
  }

  // ── нет записи dispatched — нет команды загрузчику ──────────────────────
  {
    const m = mk();
    m.store.set('last', 'p2');
    m.st.reply = (c) =>
      c.path.endsWith('/undo')
        ? { fields: [], manual: [], comp: COMP, refused: null }
        : null;
    await m.pc.command('відміни останнє', 'typed', null);
    await tick();
    assert.equal(
      m.toParent.filter((x) => x.type === 'ui-undo').length,
      0,
      'без dispatched — ни одной команды'
    );
    assert.equal(m.feed.at(-1), DICTS.uk.vcUndoUnknown);
  }

  // ── другая страница: переход, продолжение на ней, без круга ─────────────
  {
    const store = new Map<string, string>([
      ['vcconsent', '1'],
      ['last', 'p3'],
    ]);
    const a = mk({ store });
    a.st.reply = () => ({
      fields: [],
      manual: [],
      comp: { ...COMP, at: '/cart/' },
      refused: null,
    });
    await a.pc.command('відміни останнє', 'typed', null);
    await tick();
    assert.deepEqual(a.toParent.at(-1), {
      type: 'ui-undo',
      planId: 'p3',
      idx: [],
      comp: { go: '/cart/' },
    });
    assert.equal(
      a.calls.some((c) => c.body.dispatch !== undefined),
      false,
      'до перехода «начат» не пишется'
    );
    assert.equal(store.get('comp'), 'p3');
    // Новая страница (та же вкладка): продолжение по `next`.
    const b = mk({ store, page: 'https://shop.example.com/cart/' });
    b.st.reply = (c) => {
      if (c.body.next) return { comp: { ...COMP, at: '/cart/' } };
      if (c.body.dispatch === 1)
        return { comp: { ...COMP, at: '/cart/', dispatched: true } };
      return { fields: [], comp: null, chainStatus: 'unknown' };
    };
    await b.pc.resume();
    await tick();
    assert.deepEqual(b.calls[0].body, { next: true });
    assert.deepEqual(b.calls[1].body, { dispatch: 1 });
    assert.equal((b.toParent.at(-1)!.comp as { nav: number }).nav, 1);
    // Загрузчик не ответил — unknown, не «прибрав».
    // (таймаут сокращён не будет — проверяем ответ «unknown» явно)
    b.pc.onParent({
      type: 'ui-undone',
      planId: 'p3',
      results: [{ i: 1, result: 'unknown' }],
    });
    await tick();
    assert.match(b.feed.join('\n'), /Не знаю, чи прибралося «Футболка синя»/);
    assert.equal(store.get('comp'), undefined, 'метка продолжения снята');
    // Редирект: страница отмены «не та» и после перехода — второй раз не идём.
    store.set('comp', 'p4');
    store.set('compgo', 'p4:1');
    const c = mk({ store, page: 'https://shop.example.com/login' });
    c.st.reply = (x) => {
      if (x.body.next) return { comp: { ...COMP, at: '/cart/' } };
      if (x.body.dispatch === 1)
        return { comp: { ...COMP, at: '/cart/', dispatched: true } };
      return { fields: [], comp: null, chainStatus: 'partially_compensated' };
    };
    await c.pc.resume();
    await tick();
    assert.deepEqual(
      c.calls.map((x) => x.body),
      [{ next: true }, { dispatch: 1 }, { results: [{ i: 1, result: 'gone' }] }]
    );
    assert.equal(
      c.toParent.filter((x) => x.type === 'ui-undo').length,
      0,
      '0 команд загрузчику'
    );
    assert.match(c.feed.at(-1)!, /Не зміг прибрати «Футболка синя»/);
  }

  // Тексты компенсаций — без «откатил/отменил/вернул как было» (п.10).
  const BAN =
    /(откат|відкот|rolled back|roll(ed)? back|отменил|скасував|всё вернул|все повернув|reverted)/iu;
  for (const d of Object.values(DICTS))
    for (const k of [
      'vcCompGo',
      'vcCompDone',
      'vcCompUnknown',
      'vcCompFailed',
    ] as const) {
      assert.ok(d[k].includes('{t}'), k);
      assert.doesNotMatch(d[k], BAN, k);
    }
  console.log(
    'ui-plan-comp: dispatched до команды, обратный порядок, переход и продолжение, без круга, unknown без «прибрав», тексты — ok'
  );
}

let finished = false;
process.on('exit', (code) => {
  if (!finished && code === 0) {
    console.error('ui-plan-comp.test: не дошли до конца');
    process.exitCode = 1;
  }
});
main()
  .then(() => (finished = true))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
