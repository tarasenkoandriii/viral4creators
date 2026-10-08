/**
 * Э6-тер (и) «Компенсации» — чистые правила (ТЗ §5-бис.15 п.6, п.8, п.13
 * п.2–4, 7 — серверная часть; Р-59, Р-64…Р-66): пара — только объявленная
 * (стандартная разметка или «Как отменить» карты), по тексту и из ответа
 * модели — никогда; обратная цель не из стоп-листа (исключение «удаление»
 * своей строки и отписка от бесплатной подписки); страница отмены — путь
 * подтверждённого хоста в разрешённой зоне; стек — в шагах плана;
 * исполнение по одной в обратном порядке, `dispatched` до действия, сбой —
 * стоп остальных, отданная без итога — `unknown`. Без базы и без модели.
 */
import {
  chainAfterUndo,
  compAtOk,
  compFor,
  compPairSafe,
  compRemoves,
  compRow,
  nextUndo,
  undoCandidates,
  undoClass,
  undoResults,
  type ChainStep,
} from './chain';
import { STANDARD_UNDO_PAGES, STANDARD_UNDO_PAIRS } from './decisions';
import { checkPlan, resolveAfterSteps, type MapHint } from './plan-checks';
import { defaultVoiceControlRules } from './rules';
import { MARKUP_UNDO_KINDS, cleanUndoMarkup, parseSnapshot } from './snapshot';
import type { UiSnapElement, UiSnapshot } from './types';
import { undoTargetsCheck, wizardVerdict } from './wizard';

const HOST = 'shop.example.com';
let n = 0;
function el(p: Partial<UiSnapElement> & { text: string }): UiSnapElement {
  n++;
  return {
    ref: `e${n}`,
    role: 'button',
    tag: 'button',
    hiddenLabel: null,
    assistId: null,
    inputType: null,
    href: null,
    disabled: false,
    checked: null,
    selected: null,
    options: [],
    heading: null,
    submit: false,
    inForm: false,
    confirmZone: false,
    pd: false,
    toggle: false,
    gesture: null,
    inView: true,
    ...p,
  };
}
const snap = (elements: UiSnapElement[], path = '/p/1'): UiSnapshot => ({
  url: `https://${HOST}${path}`,
  title: 'Стенд',
  elements,
});
const plan = (
  t: string,
  s: UiSnapshot,
  steps: unknown[],
  o: {
    hints?: Map<string, MapHint>;
    compensations?: boolean;
    rules?: ReturnType<typeof defaultVoiceControlRules>;
  } = {},
) =>
  checkPlan({
    transcript: t,
    snapshot: s,
    map: [],
    steps,
    rules: o.rules ?? defaultVoiceControlRules(),
    hosts: [HOST],
    state: 'on',
    ...(o.hints ? { mapHints: o.hints } : {}),
    compensations: o.compensations ?? true,
  });

describe('Э6-тер (и): пары компенсаций — только объявленные (§5-бис.15 п.6 п.1–3)', () => {
  it('обратная цель — не из стоп-листа: «удаление» своей строки — да; оплата/оформление/отмена заказа/возврат — никогда', () => {
    expect(compPairSafe('remove-from-cart')).toBe(true);
    expect(compPairSafe('remove-from-wishlist')).toBe(true);
    expect(compPairSafe('checkout')).toBe(false);
    expect(compPairSafe('pay-now')).toBe(false);
    expect(compPairSafe('cancel-order')).toBe(false);
    expect(compPairSafe('refund')).toBe(false);
    expect(compPairSafe('select-all')).toBe(false);
    expect(compPairSafe('bad id with spaces')).toBe(false);
    // Отписка — только от бесплатной подписки (флаг ставит код по прямой цели).
    expect(compPairSafe('unsubscribe-news')).toBe(false);
    expect(compPairSafe('unsubscribe-news', true)).toBe(true);
    expect(compRemoves('remove-from-cart')).toBe(true);
    expect(compRemoves('unsubscribe-news')).toBe(false);
  });

  it('страница отмены — путь того же хоста, без маски, не оплата', () => {
    expect(compAtOk('/cart/')).toBe(true);
    expect(compAtOk('//evil.example/cart')).toBe(false);
    expect(compAtOk('https://evil.example/cart')).toBe(false);
    expect(compAtOk('/cart*')).toBe(false);
    expect(compAtOk('/checkout/')).toBe(false);
    expect(compAtOk('/oplata')).toBe(false);
    expect(compAtOk(`/${'a'.repeat(300)}`)).toBe(false);
  });

  it('описание строки — заголовок карточки (≥ 3 букв, без «…»)', () => {
    expect(compRow('Футболка синя')).toBe('Футболка синя');
    // Одно обрезанное слово — строку не узнать.
    expect(compRow('Ф'.repeat(100))).toBeNull();
    // Обрезанный заголовок — без последнего неполного слова (сверка по словам).
    const long = `Футболка синя ${'бавовняна '.repeat(8)}з довгим рукавом`;
    const r = compRow(long)!;
    expect(r.length).toBeLessThan(80);
    expect(long.startsWith(r)).toBe(true);
    expect(long.charAt(r.length)).toBe(' ');
    expect(compRow('12')).toBeNull();
    expect(compRow(null)).toBeNull();
  });

  it('встроенная пара стандартной разметки; страница — ссылка `nav-cart` снимка; без заголовка «удалить» не ставится', () => {
    const nav = (id: string) => (id === 'nav-cart' ? '/cart/' : null);
    expect(
      compFor({
        facts: {
          assistId: 'add-to-cart',
          heading: 'Футболка',
          text: 'В кошик',
        },
        declared: null,
        navPath: nav,
      }),
    ).toEqual({
      assistId: 'remove-from-cart',
      at: '/cart/',
      row: 'Футболка',
      src: 'standard',
    });
    expect(
      compFor({
        facts: { assistId: 'add-to-cart', heading: null, text: 'В кошик' },
        declared: null,
        navPath: nav,
      }),
    ).toBeNull();
    // Пары не перепутаны: каждой прямой — своя обратная и своя страница
    // (ожидание — явной таблицей, не из тех же констант).
    const expected: Record<string, [string, string]> = {
      'add-to-cart': ['remove-from-cart', 'nav-cart'],
      'add-to-wishlist': ['remove-from-wishlist', 'nav-wishlist'],
      'add-to-compare': ['remove-from-compare', 'nav-compare'],
    };
    expect(Object.keys(STANDARD_UNDO_PAIRS).sort()).toEqual(
      Object.keys(expected).sort(),
    );
    for (const [fwd, [rev, nav]] of Object.entries(expected)) {
      expect(STANDARD_UNDO_PAGES[rev]).toBe(nav);
      const c = compFor({
        facts: { assistId: fwd, heading: 'Товар один', text: 'x' },
        declared: null,
        navPath: (id) => `/${id}/`,
      });
      expect(c).toMatchObject({ assistId: rev, at: `/${nav}/` });
    }
  });

  it('по тексту кнопки — никогда: «Додати в кошик» без разметки — пары нет', () => {
    expect(
      compFor({
        facts: { assistId: null, heading: 'Футболка', text: 'Додати в кошик' },
        declared: null,
        navPath: () => '/cart/',
      }),
    ).toBeNull();
  });

  it('«Как отменить» карты — объявленная пара владельца; обратная из стоп-листа — нет; плохая страница — нет', () => {
    const facts = {
      assistId: 'gift',
      heading: 'Подарунок',
      text: 'Додати подарунок',
    };
    expect(
      compFor({
        facts,
        declared: { assistId: 'remove-gift', at: null },
        navPath: () => null,
      }),
    ).toMatchObject({ assistId: 'remove-gift', at: null, src: 'map' });
    expect(
      compFor({
        facts,
        declared: { assistId: 'checkout', at: null },
        navPath: () => null,
      }),
    ).toBeNull();
    expect(
      compFor({
        facts,
        declared: { assistId: 'remove-gift', at: '/payment/' },
        navPath: () => null,
      }),
    ).toBeNull();
    // Бесплатная подписка — отписка разрешена (по разметке), платная — нет.
    expect(
      compFor({
        facts: { assistId: 'news', heading: 'Новини', text: 'Підписатися' },
        declared: { assistId: 'unsubscribe-news', at: null },
        navPath: () => null,
      }),
    ).toMatchObject({ assistId: 'unsubscribe-news', sub: true, row: 'Новини' });
    expect(
      compFor({
        facts: {
          assistId: 'news',
          heading: 'Преміум 99 грн/міс',
          text: 'Підписатися',
        },
        declared: { assistId: 'unsubscribe-news', at: null },
        navPath: () => null,
      }),
    ).toBeNull();
  });

  it('undoClass: объявленная пара делает кнопку ⇄ comp (не ТН); отправка формы — irrev и с парой', () => {
    const f = {
      role: 'button',
      tag: 'button',
      href: null,
      assistId: 'gift',
      submit: false,
      inForm: false,
      toggle: false,
    };
    expect(undoClass('click', f, false)).toBe('irrev');
    expect(undoClass('click', f, false, true)).toBe('comp');
    expect(undoClass('click', { ...f, submit: true }, true, true)).toBe(
      'irrev',
    );
  });
});

describe('Э6-тер (и): компенсация в плане — кодом (§5-бис.15 п.6 п.1, п.8)', () => {
  const title = el({
    text: 'Футболка синя',
    role: 'link',
    tag: 'a',
    href: `https://${HOST}/p/1`,
  });
  const add = el({
    text: 'В кошик',
    assistId: 'add-to-cart',
    heading: 'Футболка синя',
  });
  const cartLink = el({
    text: 'Кошик',
    role: 'link',
    tag: 'a',
    assistId: 'nav-cart',
    href: `https://${HOST}/cart/`,
  });
  const gift = el({
    text: 'Додати подарунок',
    assistId: 'gift',
    heading: 'Футболка синя',
  });
  const send = el({ text: 'Надіслати заявку', submit: true, inForm: true });
  const s = snap([title, add, cartLink, gift, send]);

  it('«В кошик» со стандартной разметкой — `comp` с обратной целью, страницей и строкой; без флага «Сайта» — нет', () => {
    const p = plan('додай в кошик', s, [{ kind: 'click', target: add.ref }]);
    expect(p.steps[0]).toMatchObject({
      undo: 'comp',
      risk: 'auto',
      comp: {
        assistId: 'remove-from-cart',
        at: '/cart/',
        row: 'Футболка синя',
        src: 'standard',
      },
    });
    const admin = plan(
      'додай в кошик',
      s,
      [{ kind: 'click', target: add.ref }],
      {
        compensations: false,
      },
    );
    expect(admin.steps[0].comp).toBeUndefined();
  });

  it('модель не задаёт компенсацию: поле `comp`/`undo` ответа модели игнорируется', () => {
    const p = plan('надішли заявку', s, [
      {
        kind: 'click',
        target: send.ref,
        undo: 'comp',
        comp: {
          assistId: 'remove-from-cart',
          at: '/cart/',
          row: 'x',
          src: 'map',
        },
      },
    ]);
    expect(p.steps[0].undo).toBe('irrev');
    expect(p.steps[0].comp).toBeUndefined();
  });

  it('пара из карты («Как отменить») — кнопка без стандартной разметки становится ⇄, не ТН; риск — прежний (с подтверждением)', () => {
    const before = plan('додай подарунок', s, [
      { kind: 'click', target: gift.ref },
    ]);
    expect(before.steps[0].undo).toBe('irrev');
    expect(before.pnr).toBe(0);
    const hints = new Map<string, MapHint>([
      [
        gift.ref,
        {
          key: 'gift',
          names: ['додай подарунок'],
          floor: 'auto',
          undo: { assistId: 'remove-gift', at: null },
        },
      ],
    ]);
    const after = plan(
      'додай подарунок',
      s,
      [{ kind: 'click', target: gift.ref }],
      {
        hints,
      },
    );
    expect(after.steps[0]).toMatchObject({
      undo: 'comp',
      comp: { assistId: 'remove-gift', at: null, src: 'map' },
    });
    expect(after.pnr).toBeNull();
    expect(after.steps[0].risk).toBe(before.steps[0].risk);
    // Обратная цель карты из стоп-листа («оплатить») — пары нет, шаг — ТН.
    const bad = plan(
      'додай подарунок',
      s,
      [{ kind: 'click', target: gift.ref }],
      {
        hints: new Map([
          [
            gift.ref,
            {
              key: 'gift',
              names: ['додай подарунок'],
              floor: 'auto',
              undo: { assistId: 'pay-now', at: null },
            },
          ],
        ]),
      },
    );
    expect(bad.steps[0].undo).toBe('irrev');
    expect(bad.steps[0].comp).toBeUndefined();
  });

  it('страница отмены вне зоны/под запретом кабинета — компенсации нет («уберите сами»)', () => {
    const rules = { ...defaultVoiceControlRules(), denyPaths: ['/cart*'] };
    const p = plan('додай в кошик', s, [{ kind: 'click', target: add.ref }], {
      rules,
    });
    expect(p.steps[0].undo).toBe('comp');
    expect(p.steps[0].comp).toBeUndefined();
  });

  it('ссылка `nav-cart` на чужой хост — страница отмены не берётся (ищем на этой странице)', () => {
    const evil = el({
      text: 'Кошик',
      role: 'link',
      tag: 'a',
      assistId: 'nav-cart',
      href: 'https://evil.example/cart/',
    });
    const p = plan('додай в кошик', snap([add, evil]), [
      { kind: 'click', target: add.ref },
    ]);
    expect(p.steps[0].comp).toMatchObject({ at: null });
  });

  it('после перехода: компенсация ставится по новому снимку, класс — только хуже', () => {
    const link = el({
      text: 'Каталог',
      role: 'link',
      tag: 'a',
      href: `https://${HOST}/catalog`,
    });
    const p = plan('відкрий каталог і додай в кошик', snap([link]), [
      { kind: 'click', target: link.ref },
      { kind: 'click', target: { assistId: 'add-to-cart', text: 'В кошик' } },
    ]);
    expect(p.steps[1]).toMatchObject({ undo: 'comp' });
    expect(p.steps[1].comp).toBeUndefined();
    const r = resolveAfterSteps({
      steps: p.steps,
      from: 1,
      snapshot: snap([add, cartLink], '/catalog'),
      transcript: 'відкрий каталог і додай в кошик',
      rules: defaultVoiceControlRules(),
      hosts: [HOST],
      state: 'on',
      compensations: true,
    });
    expect(r.steps[1].comp).toMatchObject({
      assistId: 'remove-from-cart',
      at: '/cart/',
      row: 'Футболка синя',
    });
  });
});

describe('Э6-тер (и): разметка владельца `data-assist-undo`/`-at` из снимка (§5-бис.15 п.6 п.1)', () => {
  it('закрытый список видов — ровно обратные стандартной разметки (явной таблицей)', () => {
    expect([...MARKUP_UNDO_KINDS].sort()).toEqual([
      'remove-from-cart',
      'remove-from-compare',
      'remove-from-wishlist',
    ]);
  });

  it('строгая проверка: вид не из списка или плохая страница — пары нет вовсе', () => {
    expect(cleanUndoMarkup('remove-from-cart', '/cart/')).toEqual({
      assistId: 'remove-from-cart',
      at: '/cart/',
    });
    expect(cleanUndoMarkup('remove-from-wishlist', undefined)).toEqual({
      assistId: 'remove-from-wishlist',
      at: null,
    });
    expect(cleanUndoMarkup('remove-from-compare', null)).toMatchObject({
      at: null,
    });
    expect(
      cleanUndoMarkup('remove-from-cart', '/compare/%D0%BF'),
    ).toMatchObject({ at: '/compare/%D0%BF' });
    for (const kind of [
      'remove-gift',
      'del-x',
      'checkout',
      'remove-from-cart2',
      'REMOVE-FROM-CART',
      '',
      7,
      null,
      ['remove-from-cart'],
    ])
      expect(cleanUndoMarkup(kind, '/cart/')).toBeNull();
    for (const at of [
      '//evil.example/cart',
      '/\\evil.example/cart',
      'https://evil.example/cart',
      'cart/',
      '/cart?x=1',
      '/cart#a',
      '/cart*',
      '/checkout/',
      '/oplata/',
      '/u/ivan%40example.com/cart',
      '/orders/123456789012/cart',
      '/кошик/',
      '/c art',
      '',
      `/${'a'.repeat(200)}`,
      5,
      { at: '/cart/' },
    ])
      expect(cleanUndoMarkup('remove-from-cart', at)).toBeNull();
  });

  it('parseSnapshot несёт пару элемента (`undo`/`undoAt` загрузчика); без атрибутов — поля нет', () => {
    const base = {
      role: 'button',
      tag: 'button',
      text: 'В кошик',
      assistId: 'add-to-cart',
    };
    const s = parseSnapshot({
      url: `https://${HOST}/p/1`,
      title: 'x',
      elements: [
        { ...base, ref: 'e1', undo: 'remove-from-cart', undoAt: '/cart/' },
        { ...base, ref: 'e2', undo: 'remove-from-cart', undoAt: null },
        { ...base, ref: 'e3', undo: 'pay-now', undoAt: '/cart/' },
        { ...base, ref: 'e4', undo: 'remove-from-cart', undoAt: '//evil/x' },
        { ...base, ref: 'e5' },
      ],
    })!;
    expect(s.elements.map((e) => e.undo ?? null)).toEqual([
      { assistId: 'remove-from-cart', at: '/cart/' },
      { assistId: 'remove-from-cart', at: null },
      null,
      null,
      null,
    ]);
    expect('undo' in s.elements[4]).toBe(false);
  });

  const add = el({
    text: 'В кошик',
    assistId: 'add-to-cart',
    heading: 'Футболка синя',
  });
  const wcAdd = el({
    ...add,
    undo: { assistId: 'remove-from-cart', at: '/cart/' },
  });

  it('плагин WooCommerce: `add-to-cart` + `-at` корзины без ссылки `nav-cart` — компенсация с переходом, без голосовой карты', () => {
    const bare = plan('додай в кошик', snap([add]), [
      { kind: 'click', target: add.ref },
    ]);
    expect(bare.steps[0].comp).toMatchObject({ at: null, src: 'standard' });
    const p = plan('додай в кошик', snap([wcAdd]), [
      { kind: 'click', target: wcAdd.ref },
    ]);
    expect(p.steps[0]).toMatchObject({
      undo: 'comp',
      comp: {
        assistId: 'remove-from-cart',
        at: '/cart/',
        row: 'Футболка синя',
        src: 'markup',
      },
    });
    // Без флага «Сайта» («Админка») — нет.
    const admin = plan(
      'додай в кошик',
      snap([wcAdd]),
      [{ kind: 'click', target: wcAdd.ref }],
      { compensations: false },
    );
    expect(admin.steps[0].comp).toBeUndefined();
  });

  it('своя кнопка темы без стандартной разметки + `data-assist-undo` — ⇄ comp, не ТН; без пары — ТН', () => {
    const own = el({
      text: 'Додати подарунок',
      assistId: 'gift',
      heading: 'Футболка синя',
    });
    const before = plan('додай подарунок', snap([own]), [
      { kind: 'click', target: own.ref },
    ]);
    expect(before.steps[0].undo).toBe('irrev');
    expect(before.pnr).toBe(0);
    const marked = el({
      ...own,
      undo: { assistId: 'remove-from-cart', at: null },
    });
    const after = plan('додай подарунок', snap([marked]), [
      { kind: 'click', target: marked.ref },
    ]);
    expect(after.steps[0]).toMatchObject({
      undo: 'comp',
      comp: { assistId: 'remove-from-cart', at: null, src: 'markup' },
    });
    expect(after.pnr).toBeNull();
    expect(after.steps[0].risk).toBe(before.steps[0].risk);
  });

  it('«Как отменить» карты важнее разметки; страница разметки вне зоны — компенсации нет', () => {
    const hints = new Map<string, MapHint>([
      [
        wcAdd.ref,
        {
          key: 'add',
          names: ['додай в кошик'],
          floor: 'auto',
          undo: { assistId: 'remove-from-wishlist', at: null },
        },
      ],
    ]);
    const p = plan(
      'додай в кошик',
      snap([wcAdd]),
      [{ kind: 'click', target: wcAdd.ref }],
      { hints },
    );
    expect(p.steps[0].comp).toMatchObject({
      assistId: 'remove-from-wishlist',
      src: 'map',
    });
    const rules = { ...defaultVoiceControlRules(), denyPaths: ['/cart*'] };
    const denied = plan(
      'додай в кошик',
      snap([wcAdd]),
      [{ kind: 'click', target: wcAdd.ref }],
      { rules },
    );
    expect(denied.steps[0].comp).toBeUndefined();
  });

  it('после перехода: разметка нового снимка тоже даёт компенсацию', () => {
    const link = el({
      text: 'Каталог',
      role: 'link',
      tag: 'a',
      href: `https://${HOST}/catalog`,
    });
    const p = plan('відкрий каталог і додай в кошик', snap([link]), [
      { kind: 'click', target: link.ref },
      { kind: 'click', target: { assistId: 'add-to-cart', text: 'В кошик' } },
    ]);
    const r = resolveAfterSteps({
      steps: p.steps,
      from: 1,
      snapshot: snap([wcAdd], '/catalog'),
      transcript: 'відкрий каталог і додай в кошик',
      rules: defaultVoiceControlRules(),
      hosts: [HOST],
      state: 'on',
      compensations: true,
    });
    expect(r.steps[1].comp).toMatchObject({
      assistId: 'remove-from-cart',
      at: '/cart/',
      src: 'markup',
    });
  });
});

describe('Э6-тер (и): стек и исполнение (§5-бис.15 п.6 п.4–7, п.8)', () => {
  const st = (p: Partial<ChainStep>): ChainStep => ({
    kind: 'click',
    undo: 'irrev',
    risk: 'confirm',
    state: 'pending',
    target: { text: 'x' },
    ...p,
  });
  const comp = {
    assistId: 'remove-from-cart',
    at: '/cart/',
    row: 'Футболка',
    src: 'standard' as const,
  };
  const chain = (): ChainStep[] => [
    st({ kind: 'select', undo: 'local', state: 'done', fx: true }),
    st({
      kind: 'click',
      undo: 'comp',
      risk: 'auto',
      state: 'done',
      fx: true,
      comp,
    }),
    st({ kind: 'fill', undo: 'comp', state: 'done', fx: true }),
    st({ state: 'failed' }),
  ];

  it('кандидаты: с парой — компенсация, без пары — «уберите сами»; порядок — обратный', () => {
    const c = undoCandidates(chain());
    expect(c.comp).toEqual([1]);
    expect(c.manual).toEqual([]);
    expect(c.order).toEqual([2, 1, 0]);
    const noPair = chain();
    delete noPair[1].comp;
    expect(undoCandidates(noPair)).toMatchObject({ manual: [1], comp: [] });
  });

  it('по одному шагу в обратном порядке: поле → компенсация (сначала dispatched) → поле; всё сделано — compensated', () => {
    const s = chain();
    expect(nextUndo(s)).toEqual({ kind: 'fields', idx: [2] });
    s[2].undone = 'done';
    expect(nextUndo(s)).toEqual({ kind: 'comp', i: 1 });
    s[1].undone = 'dispatched';
    expect(nextUndo(s)).toEqual({ kind: 'stale', i: 1 });
    s[1].undone = 'done';
    expect(nextUndo(s)).toEqual({ kind: 'fields', idx: [0] });
    s[0].undone = 'done';
    expect(nextUndo(s)).toEqual({ kind: 'end' });
    expect(chainAfterUndo(s, undoResults(s))).toBe('compensated');
  });

  it('сбой компенсации — стоп остальных (поле до неё не возвращается), partially_compensated; повторов нет', () => {
    const s = chain();
    s[2].undone = 'done';
    s[1].undone = 'gone';
    expect(nextUndo(s)).toEqual({ kind: 'end' });
    expect(chainAfterUndo(s, undoResults(s))).toBe('partially_compensated');
    s[1].undone = 'failed';
    expect(nextUndo(s)).toEqual({ kind: 'end' });
  });

  it('компенсация отдана без итога (перезагрузка) — unknown, без повтора', () => {
    const s = chain();
    s[2].undone = 'done';
    s[1].undone = 'dispatched';
    expect(undoResults(s)).toContainEqual({ i: 1, result: 'unknown' });
    expect(chainAfterUndo(s, undoResults(s))).toBe('unknown');
  });

  it('необратимое не компенсируется: после выполненной ТН — ничего, даже при паре', () => {
    const s = [
      st({
        kind: 'click',
        undo: 'comp',
        risk: 'auto',
        state: 'done',
        fx: true,
        comp,
      }),
      st({ undo: 'irrev', state: 'done', fx: true }),
    ];
    expect(undoCandidates(s).refused).toBe('after_pnr');
    expect(nextUndo(s)).toEqual({ kind: 'end' });
    // Шаг `dispatched` без результата («мог не выполниться») — не кандидат.
    const d = [
      st({
        kind: 'click',
        undo: 'comp',
        risk: 'auto',
        state: 'dispatched',
        fx: true,
        comp,
      }),
    ];
    expect(undoCandidates(d).comp).toEqual([]);
  });
});

describe('Э6-тер (и): мастер Т-2 проверяет обратные цели (§5-бис.15 п.16)', () => {
  const rules = defaultVoiceControlRules();
  it('пара с описанием и страницей — ок; без заголовка — no_row; без страницы и обратной на странице — no_reverse; зона запрещена — zone', () => {
    const add = el({
      text: 'В кошик',
      assistId: 'add-to-cart',
      heading: 'Футболка',
    });
    const bare = el({ text: 'В кошик', assistId: 'add-to-cart' });
    const cart = el({
      text: 'Кошик',
      role: 'link',
      tag: 'a',
      assistId: 'nav-cart',
      href: `https://${HOST}/cart/`,
    });
    expect(
      undoTargetsCheck({ snapshot: snap([add, cart]), hosts: [HOST], rules }),
    ).toEqual({ pairs: 1, unresolved: [] });
    expect(
      undoTargetsCheck({ snapshot: snap([bare, cart]), hosts: [HOST], rules })
        .unresolved,
    ).toEqual([
      { text: 'В кошик', reverse: 'remove-from-cart', problem: 'no_row' },
    ]);
    expect(
      undoTargetsCheck({
        snapshot: snap([add]),
        hosts: [HOST],
        rules,
      }).unresolved.map((u) => u.problem),
    ).toEqual(['no_reverse']);
    const rem = el({ text: 'Видалити', assistId: 'remove-from-cart' });
    expect(
      undoTargetsCheck({ snapshot: snap([add, rem]), hosts: [HOST], rules })
        .unresolved,
    ).toEqual([]);
    expect(
      undoTargetsCheck({
        snapshot: snap([add, cart]),
        hosts: [HOST],
        rules: { ...rules, denyPaths: ['/cart*'] },
      }).unresolved.map((u) => u.problem),
    ).toEqual(['zone']);
    const gift = el({
      text: 'Подарунок',
      assistId: 'gift',
      heading: 'Футболка',
    });
    expect(
      undoTargetsCheck({
        snapshot: snap([gift]),
        hosts: [HOST],
        rules,
        declared: new Map([[gift.ref, { assistId: 'checkout', at: null }]]),
      }).unresolved.map((u) => u.problem),
    ).toEqual(['unsafe']);
  });

  it('(заход 9) разметка `data-assist-undo` элемента — тоже пара: порядок как в бою (карта → разметка → стандартная)', () => {
    // Своя кнопка темы без стандартной разметки: пару даёт только разметка.
    const own = el({
      text: 'Хочу',
      assistId: 'buy-own',
      heading: 'Футболка',
      undo: { assistId: 'remove-from-cart', at: '/cart' },
    });
    expect(
      undoTargetsCheck({ snapshot: snap([own]), hosts: [HOST], rules }),
    ).toEqual({ pairs: 1, unresolved: [] });
    // Страница разметки под запретом кабинета — `zone` (как `compOfStep`).
    expect(
      undoTargetsCheck({
        snapshot: snap([own]),
        hosts: [HOST],
        rules: { ...rules, denyPaths: ['/cart*'] },
      }).unresolved.map((u) => u.problem),
    ).toEqual(['zone']);
    // Стандартная `add-to-cart` без ссылки `nav-cart` и без обратной на
    // странице: разметка `-at` даёт страницу отмены — разрешима.
    const woo = el({
      text: 'В кошик',
      assistId: 'add-to-cart',
      heading: 'Футболка',
      undo: { assistId: 'remove-from-cart', at: '/kosyk' },
    });
    expect(
      undoTargetsCheck({ snapshot: snap([woo]), hosts: [HOST], rules }),
    ).toEqual({ pairs: 1, unresolved: [] });
    // «Как отменить» карты важнее разметки (как `compOfStep`).
    expect(
      undoTargetsCheck({
        snapshot: snap([own]),
        hosts: [HOST],
        rules,
        declared: new Map([[own.ref, { assistId: 'checkout', at: null }]]),
      }).unresolved,
    ).toEqual([{ text: 'Хочу', reverse: 'checkout', problem: 'unsafe' }]);
    // Сверка с боем: та же кнопка в плане — компенсация из разметки.
    const r = plan('хочу футболку', snap([own]), [
      { kind: 'click', target: own.ref },
    ]);
    expect(r.steps[0]?.comp).toMatchObject({
      assistId: 'remove-from-cart',
      at: '/cart',
      src: 'markup',
    });
  });

  it('вердикт: неразрешимые обратные цели — предупреждение шага 3 (итог не меняет)', () => {
    const base = {
      env: {
        widget: true,
        chunks: true,
        csp: 0,
        tt: 0,
        micPolicy: 'allowed' as const,
        release: null,
        ua: '',
      },
      mic: 'ok' as const,
      markup: {
        total: 1,
        withId: 1,
        unnamed: [],
        closedShadow: 0,
        extIframes: 0,
        duplicates: [],
        denied: 0,
      },
      suspicious: [],
      reviewed: {},
      dry: [],
      safe: [],
      forbidden: [],
    };
    const v = wizardVerdict({
      ...base,
      undo: {
        pairs: 2,
        unresolved: [
          { text: 'В кошик', reverse: 'remove-from-cart', problem: 'no_row' },
        ],
      },
    } as Parameters<typeof wizardVerdict>[0]);
    expect(v.items).toContainEqual({
      step: 3,
      level: 'warn',
      code: 'undo_unresolved',
      data: { n: 1, of: 2 },
    });
    const v0 = wizardVerdict(base as Parameters<typeof wizardVerdict>[0]);
    expect(v0.items.some((i) => i.code === 'undo_unresolved')).toBe(false);
    expect(v.result).toBe(v0.result);
  });
});
