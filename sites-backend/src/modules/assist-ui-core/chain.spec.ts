/**
 * Э6-бис (д) «Цепочки действий и откат» — чистые правила (ТЗ §5-бис.15,
 * приёмка п.13 п.1, 5, 6, 10 — серверная часть; Р-59, Р-60, Р-63…Р-67):
 * класс обратимости КОДОМ (мнение модели игнорируется), точка невозврата и
 * обрезка плана после неё, второе «Да» перед ней, статус цепочки, что можно
 * вернуть. Без базы и без модели.
 */
import {
  chainAfterUndo,
  chainStatusOf,
  needsSecondYes,
  pointOfNoReturn,
  provisionalUndo,
  undoCandidates,
  undoClass,
  type ChainStep,
} from './chain';
import { CHAIN_DECISIONS, MEMO_DECISIONS } from './decisions';
import { checkPlan, resolveAfterSteps, type RawStep } from './plan-checks';
import { defaultVoiceControlRules } from './rules';
import type { UiSnapElement, UiSnapshot } from './types';

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
const snap = (elements: UiSnapElement[], path = '/'): UiSnapshot => ({
  url: `https://${HOST}${path}`,
  title: 'Стенд',
  elements,
});
const check = (t: string, s: UiSnapshot, steps: RawStep[]) =>
  checkPlan({
    transcript: t,
    snapshot: s,
    map: [],
    steps,
    rules: defaultVoiceControlRules(),
    hosts: [HOST],
    state: 'on',
  });

describe('Э6-бис (д): класс обратимости и точка невозврата (§5-бис.15 п.3–4)', () => {
  const size = el({
    text: 'Розмір',
    role: 'combobox',
    tag: 'select',
    inForm: true,
    options: ['S', 'M', 'L'],
  });
  const city = el({
    text: 'Місто',
    role: 'textbox',
    tag: 'input',
    inForm: true,
  });
  const cart = el({ text: 'В кошик', assistId: 'add-to-cart' });
  const send = el({
    text: 'Надіслати заявку',
    submit: true,
    inForm: true,
  });
  const send2 = el({ text: 'Підписатися', submit: true, inForm: true });
  const link = el({
    text: 'Доставка',
    role: 'link',
    tag: 'a',
    href: `https://${HOST}/delivery`,
  });
  const menu = el({ text: 'Меню', toggle: true });
  const qty = el({ text: 'Кількість', role: 'textbox', tag: 'input' });
  const s = snap([size, city, cart, send, send2, link, menu, qty]);

  it('классы — кодом: поле в форме ↺ local, «В кошик» ⇄ comp, поле вне формы comp, ссылка nav, меню local, отправка ⚠ irrev', () => {
    const p = check(
      'вибери розмір M, місто Київ, додай в кошик і відкрий меню, кількість 2, доставка',
      s,
      [
        { kind: 'select', target: size.ref, value: 'M' },
        { kind: 'fill', target: city.ref, value: 'Київ' },
        { kind: 'click', target: cart.ref },
        { kind: 'click', target: menu.ref },
        { kind: 'fill', target: qty.ref, value: '2' },
        { kind: 'click', target: link.ref },
      ],
    );
    expect(p.steps.map((x) => x.undo)).toEqual([
      'local',
      'local',
      'comp',
      'local',
      'comp',
      'nav',
    ]);
    expect(p.pnr).toBeNull();
  });

  it('«В корзину» остаётся «сразу», не точка невозврата (п.3 п.1, аудит з-16)', () => {
    const p = check('додай в кошик', s, [{ kind: 'click', target: cart.ref }]);
    expect(p.steps[0]).toMatchObject({ undo: 'comp', risk: 'auto' });
    expect(p.pnr).toBeNull();
  });

  it('поле `undo`/риск «сразу» от модели игнорируются: отправка — irrev и «с подтверждением»', () => {
    const p = check('надішли заявку', s, [
      {
        kind: 'click',
        target: send.ref,
        risk: 'auto',
        undo: 'none',
      } as RawStep,
    ]);
    expect(p.steps[0]).toMatchObject({ undo: 'irrev', risk: 'confirm' });
    expect(p.pnr).toBe(0);
  });

  it('необратимый шаг поднимается до «с подтверждением», даже если правила риска сказали «сразу» (ссылка-отправка)', () => {
    const go = el({
      text: 'Далі',
      role: 'link',
      tag: 'a',
      href: 'https://shop.example.com/step-2',
      submit: true,
    });
    const p = check('далі', snap([go]), [{ kind: 'click', target: go.ref }]);
    expect(p.steps[0]).toMatchObject({ undo: 'irrev', risk: 'confirm' });
    expect(p.needsConfirm).toBe(true);
    expect(p.pnr).toBe(0);
  });

  it('Р-60: не больше одной ТН — вторая отправка в той же команде обрезается (заметка second_pnr)', () => {
    const p = check('надішли заявку і підпишись', s, [
      { kind: 'click', target: send.ref },
      // После отправки страница меняется — цель по описанию («после перехода»).
      { kind: 'click', target: { text: 'Підписатися', role: 'button' } },
    ]);
    expect(p.steps).toHaveLength(1);
    expect(p.notes).toEqual([{ code: 'second_pnr', target: 'Підписатися' }]);
  });

  it('после ТН — только без эффекта и переходы; эффект после ТН обрезается', () => {
    const p = check('надішли заявку, заповни місто Київ', s, [
      { kind: 'click', target: send.ref },
      {
        kind: 'fill',
        target: { text: 'Місто', role: 'textbox' },
        value: 'Київ',
      },
    ]);
    expect(p.steps).toHaveLength(1);
    expect(p.notes[0].code).toBe('second_pnr');
  });

  it('шаги «после перехода»: предварительный класс по описанию, окончательный — по новому снимку (только хуже)', () => {
    expect(provisionalUndo('click', { role: 'link', assistId: null })).toBe(
      'nav',
    );
    expect(
      provisionalUndo('click', { role: 'button', assistId: 'add-to-cart' }),
    ).toBe('comp');
    expect(provisionalUndo('fill', { role: 'textbox', assistId: null })).toBe(
      'local',
    );
    const p = check('відкрий доставку і натисни Оформити заявку', s, [
      { kind: 'click', target: link.ref },
      { kind: 'click', target: { text: 'Відправити', role: 'button' } },
    ]);
    expect(p.steps[1]).toMatchObject({ undo: 'irrev', risk: 'confirm' });
    // На новой странице кнопка оказалась отправкой формы, и до неё уже была ТН.
    const steps = [
      { ...p.steps[0] },
      { ...p.steps[1] },
      {
        ...p.steps[1],
        i: 2,
        target: { ...p.steps[1].target!, text: 'Ще одна' },
      },
    ];
    const r = resolveAfterSteps({
      steps,
      from: 1,
      snapshot: snap(
        [
          el({ text: 'Відправити', submit: true, inForm: true }),
          el({ text: 'Ще одна', submit: true, inForm: true }),
        ],
        '/delivery',
      ),
      transcript: 'натисни відправити',
      rules: defaultVoiceControlRules(),
      hosts: [HOST],
      state: 'on',
    });
    expect(r.steps[1].undo).toBe('irrev');
  });

  it('undoClass без цели и для отправки — irrev (умолчание для эффекта)', () => {
    expect(undoClass('click', null, false)).toBe('irrev');
    expect(undoClass('scroll', null, false)).toBe('none');
  });
});

describe('Р-60/В-65: второе «Да» прямо перед ТН', () => {
  const base = {
    steps: [{ nav: false }, { nav: true }, { nav: false }],
    pnr: 2,
    cardFrom: 0,
    confirmBefore: new Date(2026, 9, 3, 12, 1),
    now: new Date(2026, 9, 3, 12, 0, 30),
    pnrConfirmed: false,
  };
  it('переход между карточкой и ТН — второе «Да»', () => {
    expect(needsSecondYes(base)).toBe(true);
  });
  it('та же страница, окно не истекло — одной карточки достаточно', () => {
    expect(
      needsSecondYes({
        ...base,
        steps: [{ nav: false }, { nav: false }, { nav: false }],
      }),
    ).toBe(false);
  });
  it('окно 60 с истекло — второе «Да» и на той же странице', () => {
    expect(
      needsSecondYes({
        ...base,
        steps: [{ nav: false }, { nav: false }, { nav: false }],
        now: new Date(2026, 9, 3, 12, 2),
      }),
    ).toBe(true);
  });
  it('карточка показана уже на странице ТН (после перехода) — не нужно; ТН уже подтверждена — не нужно', () => {
    expect(needsSecondYes({ ...base, cardFrom: 2 })).toBe(false);
    expect(needsSecondYes({ ...base, pnrConfirmed: true })).toBe(false);
  });
  it('решения владельца — в одном месте (В-65…В-74 → константы)', () => {
    expect(CHAIN_DECISIONS).toMatchObject({
      oneCardPerChain: true,
      maxPointsOfNoReturn: 1,
      secondYesWindowMs: 60_000,
      offerTimeoutMs: 60_000,
      undoWindowMs: 600_000,
      maxUndoSteps: 3,
      undoSpendsUnits: false,
      standardUndoPairsByDefault: true,
      undoByButtonText: false,
      risksReacceptRequired: false,
    });
    expect(MEMO_DECISIONS.limitByPlan).toEqual({
      trial: 0,
      start: 0,
      business: 20,
      pro: 100,
    });
    expect(MEMO_DECISIONS).toMatchObject({
      numberCallOnSite: false,
      directMemoSpendsUnits: false,
      candidateMinVisitors: 3,
      skillsMax: 5,
      skillsMinGoalRate: 0.8,
    });
  });
});

describe('статус цепочки и возврат (§5-бис.15 п.6, п.11; В-66, В-67)', () => {
  const t = (text: string) => ({ text });
  const st = (p: Partial<ChainStep>): ChainStep => ({
    kind: 'click',
    undo: 'irrev',
    risk: 'confirm',
    state: 'pending',
    target: t('x'),
    ...p,
  });
  it('сбой до первого эффекта — clean; done — committed', () => {
    expect(chainStatusOf([st({ state: 'failed' })], 'failed')).toBe('clean');
    expect(
      chainStatusOf(
        [st({ kind: 'fill', undo: 'local', state: 'done', fx: true })],
        'done',
      ),
    ).toBe('committed');
  });
  it('сбой со следами — kept (до ответа «Вернуть/Оставить»); шаг без результата — unknown', () => {
    const steps = [
      st({ kind: 'fill', undo: 'local', state: 'done', fx: true }),
      st({ kind: 'click', undo: 'comp', state: 'done', fx: true }),
      st({ state: 'failed' }),
    ];
    expect(chainStatusOf(steps, 'failed')).toBe('kept');
    expect(
      chainStatusOf(
        [st({ kind: 'click', undo: 'comp', state: 'skipped', fx: true })],
        'failed',
      ),
    ).toBe('unknown');
  });
  it('возврат — обратный порядок, ≤ 3, только done; поля — загрузчику, корзина — «уберите сами»', () => {
    const steps = [
      st({
        kind: 'fill',
        undo: 'local',
        state: 'done',
        fx: true,
        target: t('Ім’я'),
      }),
      st({ kind: 'fill', undo: 'local', state: 'done', fx: true }),
      st({ kind: 'click', undo: 'comp', state: 'done', fx: true }),
      st({ kind: 'select', undo: 'local', state: 'done', fx: true }),
      st({ kind: 'fill', undo: 'local', state: 'dispatched', fx: true }),
    ];
    const c = undoCandidates(steps);
    expect(c.refused).toBeNull();
    expect(c.fields).toEqual([3, 1]);
    expect(c.manual).toEqual([2]);
  });
  it('после выполненной ТН (форма отправлена) — ничего не возвращаем', () => {
    const c = undoCandidates([
      st({ kind: 'fill', undo: 'local', state: 'done', fx: true }),
      st({ undo: 'irrev', state: 'done', fx: true }),
    ]);
    expect(c).toEqual({ fields: [], manual: [], refused: 'after_pnr' });
  });
  it('итог возврата: все следы — compensated; часть — partially; непроверяемо — unknown', () => {
    const steps = [
      st({ kind: 'fill', undo: 'local', state: 'done', fx: true }),
      st({ kind: 'click', undo: 'comp', state: 'done', fx: true }),
    ];
    expect(chainAfterUndo(steps, [{ i: 0, result: 'done' }])).toBe(
      'partially_compensated',
    );
    expect(chainAfterUndo([steps[0]], [{ i: 0, result: 'done' }])).toBe(
      'compensated',
    );
    expect(chainAfterUndo(steps, [{ i: 0, result: 'unknown' }])).toBe(
      'unknown',
    );
    expect(chainAfterUndo(steps, [{ i: 0, result: 'failed' }])).toBe(
      'partially_compensated',
    );
  });
  it('ТН — первый исполнимый irrev', () => {
    expect(
      pointOfNoReturn([
        { undo: 'local', risk: 'auto' },
        { undo: 'irrev', risk: 'manual' },
        { undo: 'irrev', risk: 'confirm' },
      ]),
    ).toBe(2);
  });
});
