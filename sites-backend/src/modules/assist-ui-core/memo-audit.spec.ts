/**
 * Хвосты аудита Э6-бис (е) «Мемо — ядро» (06.10.2026), чистая часть:
 *  (6) переход после клика в сборке мемо — как у `judgeStep` (раскрывашка
 *      в форме — не переход; иначе следующий шаг вычёркивался — обрыв);
 *  (3) ворота требуют текст в отпечатке `click`;
 *  (4) лимит тарифа после понижения — первые N опубликованных по номеру;
 *  (7) хеш IP плана из строки журнала `plan`;
 *  (2) мемо, затронутые голосовой картой (цель стала «никогда»/удалена) —
 *      по разметке и по ключу карты `mapKey`.
 */
import {
  compileMemo,
  memoClickNavigates,
  memoFromPlan,
  memoGates,
  memosWithinPlan,
  parseMemoContent,
  planIpOf,
} from './memo';
import { checkPlan } from './plan-checks';
import { defaultVoiceControlRules } from './rules';
import type { UiSnapElement, UiSnapshot } from './types';
import {
  applyMapOps,
  emptyVoiceMap,
  memoAffected,
  versionContent,
  voiceMapGates,
  type VoiceMapContent,
} from './voice-map';

const HOST = 'shop.example.com';
const rules = defaultVoiceControlRules();
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
const snap = (elements: UiSnapElement[]): UiSnapshot => ({
  url: `https://${HOST}/product/1`,
  title: 'Футболка',
  elements,
});

const goal = {
  text: { uk: 'Товар у кошику' },
  expect: [{ kind: 'text', text: 'Товар додано' }],
};

describe('аудит (е) (6): переход после клика — как в judgeStep', () => {
  it('раскрывашка в форме (`toggle`, не отправка) — не переход: следующий шаг той же страницы не вычёркивается', () => {
    const more = el({
      text: 'Характеристики',
      toggle: true,
      inForm: true,
    });
    const cart = el({ text: 'В кошик', assistId: 'add-to-cart' });
    const c = parseMemoContent({
      names: { uk: 'Характеристики і в кошик' },
      goal,
      steps: [
        {
          page: '/product/*',
          action: 'click',
          target: {
            pin: {
              role: 'button',
              text: 'Характеристики',
              inForm: true,
              toggle: true,
            },
          },
        },
        {
          page: '/product/*',
          action: 'click',
          target: {
            pin: { role: 'button', assistId: 'add-to-cart', text: 'В кошик' },
          },
        },
      ],
    }).content;
    const s = snap([more, cart]);
    const comp = compileMemo(c, {}, s);
    expect(comp.missingAt).toBeNull();
    // Второй шаг — по ref снимка (не описанием «после перехода»).
    expect(comp.raw.map((r) => r.target)).toEqual([
      more.ref,
      cart.ref,
      undefined,
    ]);
    const checked = checkPlan({
      transcript: 'характеристики і в кошик',
      snapshot: s,
      map: [],
      steps: comp.raw,
      rules,
      hosts: [HOST],
      state: 'on',
      pins: comp.pins,
      extraSteps: 2,
    });
    expect(checked.notes).toEqual([]);
    expect(checked.from).toEqual([0, 1, 2]);
    expect(memoClickNavigates(more)).toBe(false);
    // Отправка формы и кнопка формы — переход; ссылка с адресом — переход.
    expect(memoClickNavigates({ ...more, submit: true })).toBe(true);
    expect(memoClickNavigates({ ...more, toggle: false })).toBe(true);
    expect(
      memoClickNavigates(
        el({
          text: 'Кошик',
          role: 'link',
          tag: 'a',
          href: `https://${HOST}/c`,
        }),
      ),
    ).toBe(true);
  });

  it('обратимая разметка в форме (`add-to-cart`, команда её называет) — переход считает judgeStep той же командой', () => {
    const cart = el({ text: 'В кошик', assistId: 'add-to-cart', inForm: true });
    const fav = el({ text: 'В обране', assistId: 'add-to-wishlist' });
    const c = parseMemoContent({
      names: { uk: 'В кошик і в обране' },
      goal,
      steps: [
        {
          page: '/product/*',
          action: 'click',
          target: {
            pin: {
              role: 'button',
              assistId: 'add-to-cart',
              text: 'В кошик',
              inForm: true,
            },
          },
        },
        {
          page: '/product/*',
          action: 'click',
          target: {
            pin: {
              role: 'button',
              assistId: 'add-to-wishlist',
              text: 'В обране',
            },
          },
        },
      ],
    }).content;
    const s = snap([cart, fav]);
    const transcript = 'в кошик і в обране';
    const comp = compileMemo(c, {}, s, {
      transcript,
      rules,
      hosts: [HOST],
      pagePath: '/product/1',
      state: 'on',
      trusted: [],
    });
    const checked = checkPlan({
      transcript,
      snapshot: s,
      map: [],
      steps: comp.raw,
      rules,
      hosts: [HOST],
      state: 'on',
      pins: comp.pins,
      extraSteps: 2,
    });
    expect(checked.from).toEqual([0, 1, 2]);
    expect(checked.notes).toEqual([]);
  });
});

describe('аудит (е) (3): ворота — текст в отпечатке клика', () => {
  it('клик только по разметке (без текста) — held с путём; с текстом — проходит', () => {
    const mk = (text: string) =>
      parseMemoContent({
        names: { uk: 'В кошик' },
        goal,
        steps: [
          {
            page: '/product/*',
            action: 'click',
            target: { pin: { role: 'button', assistId: 'add-to-cart', text } },
          },
        ],
      }).content;
    const bad = memoGates(mk(''), { rules, host: HOST });
    expect(bad.ok).toBe(false);
    expect(bad.problems).toContainEqual({
      code: 'text',
      path: 'steps[0].target.pin.text',
    });
    expect(memoGates(mk('В кошик'), { rules, host: HOST }).ok).toBe(true);
  });
});

describe('аудит (е) (4), (7): лимит после понижения тарифа, хеш IP плана', () => {
  it('исполняются первые N опубликованных по номеру', () => {
    const rows = [{ number: 7 }, { number: 2 }, { number: 5 }];
    expect(memosWithinPlan(rows, 2).map((r) => r.number)).toEqual([2, 5]);
    expect(memosWithinPlan(rows, 0)).toEqual([]);
    expect(memosWithinPlan(rows, 100)).toHaveLength(3);
  });

  it('хеш IP — только строка из `target.ip` строки `plan`', () => {
    expect(planIpOf({ memo: 1, via: 'direct', ip: 'abc' })).toBe('abc');
    expect(planIpOf({ memo: 1 })).toBeNull();
    expect(planIpOf(null)).toBeNull();
    expect(planIpOf({ ip: 5 })).toBeNull();
    expect(planIpOf({ ip: 'x'.repeat(129) })).toBeNull();
  });
});

describe('аудит (е) (2): мемо, затронутые голосовой картой', () => {
  const cart = {
    tag: 'button',
    role: 'button',
    text: 'В кошик',
    assistId: 'add-to-cart',
    unique: true,
  };
  const delivery = {
    tag: 'a',
    role: 'link',
    text: 'Доставка',
    hrefPath: '/delivery',
    hrefHost: HOST,
    unique: true,
  };
  const base = { scope: 'page', pagePath: '/product/1' };
  const map = (targets: Array<Record<string, unknown>>): VoiceMapContent => {
    let k = 0;
    const r = applyMapOps(
      emptyVoiceMap(),
      targets.map((t) => ({ op: 'upsert-target', target: t })),
      { hosts: [HOST], newId: () => `t-${++k}`, source: 'editor' },
    );
    expect(r.issues).toEqual([]);
    return versionContent(r.content);
  };

  it('цель стала denylist — мемо по разметке; цель удалена — мемо по ключу карты; ключ, которого нет нигде, — тоже', () => {
    const prev = map([
      { ...base, key: 'cart', descriptor: cart },
      { ...base, key: 'delivery', descriptor: delivery },
    ]);
    const next = map([
      { ...base, key: 'cart', descriptor: cart, denylisted: true },
    ]);
    const ctx = {
      memoAssistIds: new Map([['add-to-cart', [3]]]),
      memoMapKeys: new Map([
        ['delivery', [4]],
        ['gone', [5]],
        ['cart', [3]],
      ]),
      previous: prev,
    };
    const out = memoAffected(next, ctx);
    expect(out).toEqual(
      expect.arrayContaining([
        { code: 'memo_affected', key: 'cart', memo: 3 },
        { code: 'memo_affected', key: 'delivery', memo: 4 },
        { code: 'memo_affected', key: 'gone', memo: 5 },
      ]),
    );
    // Мемо 3 по разметке и по ключу — одна строка.
    expect(out.filter((w) => w.memo === 3)).toHaveLength(1);
    // То же — в предупреждениях ворот (публикация переводит в needs_review).
    expect(
      voiceMapGates(next, ctx).warnings.filter(
        (w) => w.code === 'memo_affected',
      ),
    ).toHaveLength(3);
    // Цель жива и не «никогда» — не затронута.
    expect(memoAffected(prev, { ...ctx, previous: prev })).toEqual([
      { code: 'memo_affected', key: 'gone', memo: 5 },
    ]);
  });

  it('«сохранить как мемо»: ключ цели карты шага плана переходит в цель шага мемо', () => {
    const c = memoFromPlan({
      steps: [
        {
          kind: 'click',
          target: {
            assistId: 'add-to-cart',
            role: 'button',
            text: 'В кошик',
            href: null,
          },
          value: null,
          expect: null,
          nav: false,
          mapKey: 'cart',
          state: 'done',
        },
        {
          kind: 'click',
          target: {
            assistId: null,
            role: 'link',
            text: 'Кошик',
            href: '/cart',
          },
          value: null,
          expect: { path: '/cart' },
          nav: true,
          mapKey: 'BAD KEY',
          state: 'done',
        },
      ],
      pageUrl: `https://${HOST}/product/1`,
      utteranceMasked: 'в кошик',
      lang: 'uk',
    });
    expect(c.steps.map((s) => s.target?.mapKey)).toEqual(['cart', null]);
    // Разбор сохраняет ключ (и отбрасывает мусор).
    expect(
      parseMemoContent(JSON.parse(JSON.stringify(c))).content.steps.map(
        (s) => s.target?.mapKey,
      ),
    ).toEqual(['cart', null]);
  });
});
