/**
 * Э6-тер (и) «Компенсации» — чанк comp.js (`src/undo/compensate.ts`) без
 * браузера, на мини-DOM (`scripts/fake-dom.ts`). ТЗ §5-бис.15 п.6, п.13
 * п.2–4, 7 (браузерная часть):
 *  - обратная цель — только по `data-assist-id` в строке ТОГО ЖЕ товара
 *    (описание + варианты); «Видалити» без разметки — 0 кликов; строка
 *    другого товара — 0 кликов; две одинаковые строки — 0 кликов;
 *  - те же запреты живой цели: стоп-лист (исключение «удаление» — только
 *    с `allow: remove` от сервера; «Оплатити» — никогда), `data-assist="never"`,
 *    denylist, чужой origin, страница оплаты, жест;
 *  - итог: строка исчезла — done; осталась — unknown; переход — только путь
 *    своего origin и флаг «план идёт»;
 *  - undo.js не трогает поля, когда в команде `comp`.
 */
import assert from 'node:assert/strict';
import { FakeNode, installFakeDom, type FakeDocument } from './fake-dom';
import type { ActHost } from '../src/act/index';
import {
  comp,
  compRefused,
  findReverse,
  rowOf,
  runComp,
} from '../src/undo/compensate';
import { undo } from '../src/undo/index';

const E = (n: FakeNode) => n as unknown as Element;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mkHost() {
  const posts: Array<Record<string, unknown>> = [];
  const marks: boolean[] = [];
  const host: ActHost = {
    N: {
      el: (tag: string) => new FakeNode(tag),
      on: () => undefined,
      off: () => undefined,
      later: (fn: () => void, ms: number) => {
        const t = setTimeout(fn, Math.min(ms, 2));
        if (ms >= 6000) t.unref();
        return 0;
      },
    } as unknown as ActHost['N'],
    post: (m) => posts.push(m as unknown as Record<string, unknown>),
    min: () => undefined,
    mark: (on) => marks.push(on),
  };
  return { host, posts, marks };
}

/** Строка корзины: `li` с описанием и кнопкой (разметка — по желанию). */
function row(
  doc: FakeDocument,
  list: FakeNode,
  text: string,
  btn: { id?: string | null; label?: string; tag?: string; href?: string } = {}
) {
  const li = new FakeNode('li');
  li.innerText = text;
  const b = new FakeNode(btn.tag ?? 'button');
  if (btn.id !== null)
    b.setAttribute('data-assist-id', btn.id ?? 'remove-from-cart');
  if (btn.href) b.setAttribute('href', btn.href);
  b.innerText = btn.label ?? 'Видалити';
  li.appendChild(b);
  list.appendChild(li);
  // Нажатие «прибирает» строку, как AJAX корзины.
  b.click = () => {
    FakeNode.prototype.click.call(b);
    li.remove();
  };
  void doc;
  return { li, b };
}

function cart() {
  const doc = installFakeDom();
  const ul = new FakeNode('ul');
  doc.body.appendChild(ul);
  return { doc, ul };
}

const C = (o: Record<string, unknown> = {}) => ({
  id: 'remove-from-cart',
  row: 'Футболка синя',
  variant: ['M'],
  allow: ['remove'],
  deny: [] as string[],
  zones: [] as string[],
  ...o,
});

async function main() {
  // ── п.2/п.4: строка того же товара — исполняется, остальные — нет ─────
  {
    const { doc, ul } = cart();
    const other = row(doc, ul, 'Шапка зимова  Розмір: M  Видалити');
    const same = row(doc, ul, 'Футболка синя  Розмір: M  Видалити');
    const h = mkHost();
    assert.equal(rowOf(E(same.b), 'remove-from-cart'), E(same.li));
    assert.equal(await runComp(h.host, C() as never), 'done');
    assert.equal(same.b.clicks, 1, 'нажата обратная цель своей строки');
    assert.equal(other.b.clicks, 0, 'строку другого товара не трогаем');
  }
  {
    // Вариант другой (L вместо M) — это не та строка: 0 кликов.
    const { doc, ul } = cart();
    const l = row(doc, ul, 'Футболка синя  Розмір: L  Видалити');
    const h = mkHost();
    assert.equal(await runComp(h.host, C() as never), 'gone');
    assert.equal(l.b.clicks, 0);
    // «M» — целым словом, не буквой в «Medium».
    const { doc: d2, ul: u2 } = cart();
    const md = row(d2, u2, 'Футболка синя  Medium');
    assert.equal(await runComp(mkHost().host, C() as never), 'gone');
    assert.equal(md.b.clicks, 0);
  }
  {
    // «Видалити» без разметки — компенсации нет (по тексту — никогда).
    const { doc, ul } = cart();
    const bare = row(doc, ul, 'Футболка синя M', { id: null });
    assert.equal(await runComp(mkHost().host, C() as never), 'gone');
    assert.equal(bare.b.clicks, 0);
  }
  {
    // п.3: две строки с одинаковым описанием — «уберите сами», 0 кликов.
    const { doc, ul } = cart();
    const a = row(doc, ul, 'Футболка синя M');
    const b = row(doc, ul, 'Футболка синя M');
    assert.equal(await runComp(mkHost().host, C() as never), 'failed');
    assert.equal(a.b.clicks + b.b.clicks, 0);
  }
  {
    // Строки не определить (кнопка вне li/tr/[role=row]) — 0 кликов.
    const doc = installFakeDom();
    const div = new FakeNode('div');
    div.innerText = 'Футболка синя M';
    const b = new FakeNode('button');
    b.setAttribute('data-assist-id', 'remove-from-cart');
    div.appendChild(b);
    doc.body.appendChild(div);
    assert.equal(await runComp(mkHost().host, C() as never), 'gone');
    assert.equal(b.clicks, 0);
    // Своя разметка строки `data-assist-row` — строка есть.
    div.setAttribute('data-assist-row', '');
    assert.notEqual(rowOf(E(b), 'remove-from-cart'), null);
  }

  // ── запреты живой цели (тот же стоп-лист и liveRefusal) ────────────────
  {
    const { doc, ul } = cart();
    const pay = row(doc, ul, 'Футболка синя M', { label: 'Оплатити' });
    assert.equal(await runComp(mkHost().host, C() as never), 'failed');
    assert.equal(pay.b.clicks, 0, '«Оплатити» — никогда, даже с allow remove');
  }
  {
    const { doc, ul } = cart();
    const del = row(doc, ul, 'Футболка синя M');
    // Без исключения от сервера «Видалити» — стоп-лист.
    assert.equal(
      await runComp(mkHost().host, C({ allow: [] }) as never),
      'failed'
    );
    assert.equal(del.b.clicks, 0);
    assert.equal(compRefused(E(del.b), ['remove'], [], []), false);
    assert.equal(compRefused(E(del.b), ['unsubscribe'], [], []), true);
    del.li.setAttribute('data-assist', 'never');
    assert.equal(compRefused(E(del.b), ['remove'], [], []), true, 'never-зона');
    del.li.attrs.delete('data-assist');
    del.li.setAttribute('class', 'mini-cart');
    assert.equal(
      compRefused(E(del.b), ['remove'], ['.mini-cart'], []),
      true,
      'denylist кабинета'
    );
    assert.equal(
      compRefused(E(del.b), ['remove'], [], ['.main']),
      true,
      'вне разрешённых зон'
    );
    del.b.disabled = true;
    assert.equal(compRefused(E(del.b), ['remove'], [], []), true, 'disabled');
  }
  {
    const { doc, ul } = cart();
    const off = row(doc, ul, 'Футболка синя M', {
      tag: 'a',
      href: 'https://evil.example/cart?remove=1',
    });
    assert.equal(
      compRefused(E(off.b), ['remove'], [], []),
      true,
      'чужой origin'
    );
    off.b.setAttribute('href', '/checkout/?remove=1');
    assert.equal(compRefused(E(off.b), ['remove'], [], []), true, 'оплата');
    off.b.setAttribute('href', '/cart/?remove_item=1');
    assert.equal(compRefused(E(off.b), ['remove'], [], []), false);
    off.b.setAttribute('target', '_blank');
    assert.equal(compRefused(E(off.b), ['remove'], [], []), true, 'жест');
    // Подмена текста скрытой подписью «Оплатити» — тоже отказ.
    off.b.attrs.delete('target');
    off.b.setAttribute('aria-label', 'Оплатити замовлення');
    assert.equal(compRefused(E(off.b), ['remove'], [], []), true);
    // …и через aria-labelledby.
    off.b.attrs.delete('aria-label');
    const lbl = new FakeNode('span');
    lbl.innerText = 'Оплатити';
    (
      off.b.getRootNode() as unknown as {
        getElementById: (id: string) => FakeNode | null;
      }
    ).getElementById = (id: string) => (id === 'l1' ? lbl : null);
    off.b.setAttribute('aria-labelledby', 'l1');
    assert.equal(compRefused(E(off.b), ['remove'], [], []), true);
  }

  // ── итог: строка не исчезла — unknown (не «прибрав») ───────────────────
  {
    const { doc, ul } = cart();
    const stuck = row(doc, ul, 'Футболка синя M');
    stuck.b.click = () => FakeNode.prototype.click.call(stuck.b);
    assert.equal(await runComp(mkHost().host, C() as never), 'unknown');
    assert.equal(stuck.b.clicks, 1, 'одно нажатие, повторов нет');
    assert.equal(
      findReverse('remove-from-cart', 'Футболка синя', ['M'], false, [], [])
        .length,
      1
    );
  }

  // ── команда: разбор строгий; итог по номеру шага; переход ──────────────
  {
    const { doc, ul } = cart();
    row(doc, ul, 'Футболка синя M');
    const h = mkHost();
    comp(
      {
        type: 'ui-undo',
        planId: 'p1',
        idx: [],
        comp: { ...C(), i: 1, nav: 1 },
      },
      h.host
    );
    await wait(80);
    assert.deepEqual(h.posts, [
      { type: 'ui-undone', planId: 'p1', results: [{ i: 1, result: 'done' }] },
    ]);
    assert.deepEqual(h.marks, [false], 'после перехода флаг «план идёт» снят');
    const bad = mkHost();
    for (const c of [
      { ...C(), i: 1, id: 'remove"],a[x' },
      { ...C(), i: 99 },
      { ...C(), i: 1, row: 'x'.repeat(200) },
    ])
      comp({ type: 'ui-undo', planId: 'p1', idx: [], comp: c }, bad.host);
    comp(
      { type: 'ui-undo', planId: '../x', idx: [], comp: { ...C(), i: 1 } },
      bad.host
    );
    await wait(40);
    assert.deepEqual(bad.posts, [], 'плохие команды — без действия');
    const g = mkHost();
    const went: string[] = [];
    (
      globalThis as unknown as { location: { assign: (u: string) => void } }
    ).location.assign = (u: string) => went.push(u);
    comp(
      { type: 'ui-undo', planId: 'p1', idx: [], comp: { go: '/cart/' } },
      g.host
    );
    comp(
      {
        type: 'ui-undo',
        planId: 'p1',
        idx: [],
        comp: { go: '//evil.example/x' },
      },
      g.host
    );
    comp(
      {
        type: 'ui-undo',
        planId: 'p1',
        idx: [],
        comp: { go: 'https://evil.example/' },
      },
      g.host
    );
    assert.deepEqual(went, ['/cart/'], 'переход — только путь своего origin');
    assert.deepEqual(g.marks, [true]);
  }
  {
    // Заход 9 (аудит P2-3): команда подсветки — цель в `sid`, без `id`.
    const { id: _id, allow: _a, ...rest } = C();
    void _id;
    void _a;
    const SHOW = { ...rest, i: 1, show: 1, sid: 'remove-from-cart' };
    // Старый comp.js из кеша (без ветки `show`) такую команду отвергает:
    // эмуляция — та же команда без `show` новым чанком: 0 кликов, 0 ответов.
    {
      const { doc, ul } = cart();
      const r = row(doc, ul, 'Футболка синя M');
      const h = mkHost();
      const { show: _s, ...old } = SHOW;
      void _s;
      comp({ type: 'ui-undo', planId: 'p1', idx: [], comp: old }, h.host);
      await wait(40);
      assert.equal(r.b.clicks, 0, 'старый чанк — без клика');
      assert.deepEqual(h.posts, []);
      // `show` с `id` и без `sid` — тоже ничего (ни клика, ни обводки).
      comp(
        {
          type: 'ui-undo',
          planId: 'p1',
          idx: [],
          comp: { ...C(), i: 1, show: 1 },
        },
        h.host
      );
      assert.equal(
        doc.body.children.filter((n) => n.hasAttribute('data-v4c-highlight'))
          .length,
        0
      );
      await wait(40);
      assert.equal(r.b.clicks, 0);
    }
    // Заход 9 (§5-бис.15 п.8): `show` в `degraded` — только обводка своей
    // строки, ни клика, ни ответа iframe; две одинаковые строки — без обводки.
    const { doc, ul } = cart();
    const other = row(doc, ul, 'Шапка зимова M');
    const same = row(doc, ul, 'Футболка синя M');
    const h = mkHost();
    comp(
      {
        type: 'ui-undo',
        planId: 'p1',
        idx: [],
        comp: SHOW,
      },
      h.host
    );
    // Обводка ставится сразу (снимается таймером через 6 с).
    const rings = doc.body.children.filter((n) =>
      n.hasAttribute('data-v4c-highlight')
    );
    assert.equal(rings.length, 1, 'обведена ровно одна обратная кнопка');
    await wait(40);
    assert.equal(same.b.clicks + other.b.clicks, 0, 'подсветка — без клика');
    assert.deepEqual(h.posts, [], 'без ответа iframe (итога нет)');
    assert.equal(ul.children.length, 2, 'строки на месте');
    const { doc: d2, ul: u2 } = cart();
    const a = row(d2, u2, 'Футболка синя M');
    const b = row(d2, u2, 'Футболка синя M');
    comp(
      {
        type: 'ui-undo',
        planId: 'p1',
        idx: [],
        comp: SHOW,
      },
      h.host
    );
    await wait(20);
    assert.equal(
      d2.body.children.filter((n) => n.hasAttribute('data-v4c-highlight'))
        .length,
      0,
      'неоднозначно — без обводки'
    );
    assert.equal(a.b.clicks + b.b.clicks, 0);
  }
  {
    // undo.js с полем `comp` поля не трогает (чанк comp.js — отдельно).
    const doc = installFakeDom();
    void doc;
    const h = mkHost();
    undo({ planId: 'p1', idx: [0], comp: { ...C(), i: 0 } }, [], h.host);
    await wait(20);
    assert.deepEqual(h.posts, []);
  }
  console.log(
    'comp: строка того же товара, варианты словом, «Видалити» без разметки — 0, две строки — 0, стоп-лист/never/denylist/origin/оплата/жест, done/unknown, разбор и переход — ok'
  );
}

let finished = false;
process.on('exit', (code) => {
  if (!finished && code === 0) {
    console.error('comp.test: не дошли до конца (повисшее ожидание)');
    process.exitCode = 1;
  }
});
main()
  .then(() => (finished = true))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
