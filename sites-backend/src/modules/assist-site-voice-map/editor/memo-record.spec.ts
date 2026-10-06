/**
 * Э6-тер (д) — ядро записи мемо кликами и «Прогнать» (без базы): клики →
 * шаги, поле/список → слот БЕЗ значения (имя — из `name`/подписи), цель
 * «никогда»/стоп-лист — остановка записи (оформление/оплата — подсветкой
 * «нажмите сами»), перепривязка — новая цель и отпечаток, прежний слот;
 * сохранение — перепроверка всех шагов; прогон — до первого сбоя или
 * перехода.
 */
import { parseMemoContent, type MemoStep } from '../../assist-ui-core/memo';
import { defaultVoiceControlRules } from '../../assist-ui-core/rules';
import type { UiSnapElement, UiSnapshot } from '../../assist-ui-core/types';
import type { VoiceMapTarget } from '../../assist-ui-core/voice-map';
import {
  memoTry,
  recordedDraft,
  recordStep,
  slotNameOf,
  type RecordStepInput,
} from './memo-record';

const HOST = 'shop.example.com';
const rules = defaultVoiceControlRules();

const btn = (text: string, extra: Record<string, unknown> = {}) => ({
  tag: 'button',
  role: 'button',
  text,
  unique: true,
  ...extra,
});

function input(
  descriptor: unknown,
  extra: Partial<RecordStepInput> = {},
): RecordStepInput {
  return {
    descriptor,
    path: '/product/1',
    page: '/product/*',
    hosts: [HOST],
    rules,
    mapTarget: null,
    uiElement: null,
    takenSlots: [],
    count: 0,
    ...extra,
  };
}

function stepOf(r: ReturnType<typeof recordStep>): MemoStep {
  if (r.kind !== 'step') throw new Error(`ожидался шаг: ${JSON.stringify(r)}`);
  return r.step;
}

describe('запись мемо кликами: клики → шаги', () => {
  it('«В кошик» с разметкой — click «сразу», исполняется по-настоящему; отпечаток и Ш4', () => {
    const r = recordStep(
      input(btn('В кошик', { assistId: 'add-to-cart' }), {
        uiElement: { id: 'cm1abc', key: 'a:add-to-cart', stability: 'strong' },
      }),
    );
    expect(r.kind).toBe('step');
    if (r.kind !== 'step') return;
    expect(r.step).toMatchObject({
      page: '/product/*',
      action: 'click',
      value: null,
      target: {
        uiElementId: 'cm1abc',
        key: 'a:add-to-cart',
        pin: { assistId: 'add-to-cart', text: 'В кошик', role: 'button' },
      },
    });
    expect(r.risk).toBe('auto');
    expect(r.exec).toBe(true);
    expect(r.slot).toBeNull();
  });

  it('ссылка своего сайта — переход (ожидание адреса), чужой хост — стоп с подсветкой «нажмите сами»', () => {
    const own = recordStep(
      input({
        tag: 'a',
        role: 'link',
        text: 'Кошик',
        hrefPath: '/cart',
        hrefHost: HOST,
        unique: true,
      }),
    );
    expect(stepOf(own)).toMatchObject({
      action: 'click',
      expect: { path: '/cart' },
      target: { pin: { href: '/cart', tag: 'a' } },
    });
    expect(own.kind === 'step' && own.exec).toBe(true);
    const off = recordStep(
      input({
        tag: 'a',
        role: 'link',
        text: 'Instagram',
        hrefPath: '/shop',
        hrefHost: 'instagram.com',
        unique: true,
      }),
    );
    expect(off).toMatchObject({ kind: 'stop', reason: 'offhost' });
    expect(off.kind === 'stop' && off.step?.action).toBe('highlight');
  });

  it('обычная кнопка — «после Да» и НЕ нажимается при записи (выбирается)', () => {
    const r = recordStep(
      input(btn('Надіслати', { inForm: true, submit: true })),
    );
    expect(r.kind).toBe('step');
    if (r.kind !== 'step') return;
    expect(r.risk).toBe('confirm');
    expect(r.exec).toBe(false);
  });

  it('поле → fill со СЛОТОМ без значения: имя из name, тип по полю, ПД — код', () => {
    const r = recordStep(
      input(
        {
          tag: 'input',
          role: 'textbox',
          text: 'Ваш e-mail',
          inputType: 'email',
          unique: true,
          // Подложенное «значение» — дескриптор его не несёт вовсе.
          value: 'owner.secret@example.com',
        },
        { fieldName: 'email' },
      ),
    );
    expect(r.kind).toBe('step');
    if (r.kind !== 'step') return;
    expect(r.step.action).toBe('fill');
    expect(r.step.value).toEqual({ slot: 'email' });
    expect(r.slot).toEqual({
      name: 'email',
      kind: 'email',
      pii: true,
      options: [],
    });
    expect(r.exec).toBe(false);
    expect(JSON.stringify(r)).not.toContain('owner.secret');
  });

  it('имя слота — из подписи (транслит), занятое — с номером; без подписи — по типу', () => {
    expect(slotNameOf([null, 'Розмір'], 'text', [])).toBe('rozmir');
    expect(slotNameOf(['Розмір'], 'text', ['rozmir'])).toBe('rozmir_2');
    expect(slotNameOf([null, '', null], 'phone', ['phone'])).toBe('phone_2');
    expect(slotNameOf(['123 поле'], 'text', [])).toBe('pole');
    const r = recordStep(
      input(
        { tag: 'input', role: 'textbox', text: 'Місто', unique: true },
        { takenSlots: ['misto'] },
      ),
    );
    expect(r.kind === 'step' && r.step.value).toEqual({ slot: 'misto_2' });
  });

  it('список → select со слотом option (варианты — подписи списка, маска ПД)', () => {
    const r = recordStep(
      input(
        { tag: 'select', role: 'combobox', text: 'Розмір', unique: true },
        { fieldName: 'size', options: ['S', 'M', 'M', 'x@y.com', 42] },
      ),
    );
    expect(r.kind).toBe('step');
    if (r.kind !== 'step') return;
    expect(r.step.action).toBe('select');
    expect(r.slot?.name).toBe('size');
    expect(r.slot?.kind).toBe('option');
    expect(r.slot?.options.map((o) => o.value)).toEqual(['S', 'M']);
    expect(r.exec).toBe(false);
  });

  it('флажок → check', () => {
    expect(
      stepOf(
        recordStep(
          input({
            tag: 'input',
            role: 'checkbox',
            inputType: 'checkbox',
            text: 'Тільки в наявності',
            unique: true,
          }),
        ),
      ).action,
    ).toBe('check');
  });
});

describe('запись мемо: опасное останавливает запись', () => {
  it('«Оплатити» — стоп `payment`, последним шагом — подсветка «нажмите сами», не клик', () => {
    const r = recordStep(input(btn('Оплатити')));
    expect(r).toMatchObject({ kind: 'stop', reason: 'payment' });
    expect(r.kind === 'stop' && r.step).toMatchObject({
      action: 'highlight',
      target: { pin: { text: 'Оплатити' } },
    });
  });

  it('«Оформити замовлення» под разметкой add-to-cart — всё равно стоп (стоп-лист по тексту)', () => {
    const r = recordStep(
      input(btn('Оформити замовлення', { assistId: 'add-to-cart' })),
    );
    expect(r.kind).toBe('stop');
  });

  it('«Видалити», «Скасувати замовлення» — стоп `danger`', () => {
    expect(recordStep(input(btn('Видалити')))).toMatchObject({
      kind: 'stop',
      reason: 'danger',
    });
    expect(recordStep(input(btn('Скасувати замовлення')))).toMatchObject({
      kind: 'stop',
    });
  });

  it('data-assist="never", пароль, поле карти, запрет кабинета, запрет карты — стоп без подсветки', () => {
    expect(
      recordStep(input(btn('В кошик', { neverAttr: true }))),
    ).toMatchObject({ kind: 'stop', reason: 'never_attr', step: null });
    expect(
      recordStep(
        input({
          tag: 'input',
          role: 'textbox',
          inputType: 'password',
          text: 'Пароль',
        }),
      ),
    ).toMatchObject({ kind: 'stop', reason: 'sensitive_field', step: null });
    expect(
      recordStep(
        input({
          tag: 'input',
          role: 'textbox',
          text: 'Номер картки',
          unique: true,
        }),
      ),
    ).toMatchObject({ kind: 'stop', reason: 'sensitive_field' });
    expect(
      recordStep(
        input(btn('Підписка VIP'), {
          rules: { ...rules, denyWords: ['vip'] },
        }),
      ),
    ).toMatchObject({ kind: 'stop', reason: 'denied' });
    const target = {
      key: 'cart',
      denylisted: true,
    } as unknown as VoiceMapTarget;
    expect(
      recordStep(input(btn('В кошик'), { mapTarget: target })),
    ).toMatchObject({ kind: 'stop', reason: 'denylist' });
  });

  it('шагов больше лимита режима — стоп `too_many_steps`; запрещённая зона — стоп `zone`', () => {
    expect(
      recordStep(input(btn('Далі'), { count: rules.maxSteps })),
    ).toMatchObject({ kind: 'stop', reason: 'too_many_steps' });
    expect(
      recordStep(
        input(btn('Далі'), { rules: { ...rules, denyPaths: ['/product/*'] } }),
      ),
    ).toMatchObject({ kind: 'stop', reason: 'zone' });
  });

  it('кнопка без видимой подписи — отказ шага (отпечаток не сверит подмену), запись не стоп', () => {
    expect(
      recordStep(
        input({ tag: 'button', role: 'button', text: '', elId: 'x1' }),
      ),
    ).toEqual({ kind: 'skip', code: 'unnamed' });
    expect(recordStep(input('мусор'))).toEqual({
      kind: 'skip',
      code: 'descriptor',
    });
  });
});

describe('запись мемо: перепривязка шага мышкой', () => {
  it('новая цель и отпечаток; слот поля — прежний (новый не создаётся)', () => {
    const first = recordStep(
      input(
        {
          tag: 'input',
          role: 'textbox',
          text: 'Телефон',
          inputType: 'tel',
          unique: true,
        },
        { fieldName: 'phone' },
      ),
    );
    const prev = stepOf(first);
    const r = recordStep(
      input(
        {
          tag: 'input',
          role: 'textbox',
          text: 'Мобільний',
          elId: 'mob',
          unique: true,
        },
        { prev, takenSlots: ['phone'] },
      ),
    );
    expect(r.kind).toBe('step');
    if (r.kind !== 'step') return;
    expect(r.step.value).toEqual({ slot: 'phone' });
    expect(r.slot).toBeNull();
    expect(r.step.target?.pin.text).toBe('Мобільний');
    expect(r.step.target?.pin).not.toEqual(prev.target?.pin);
  });

  it('кнопка → другая кнопка: отпечаток меняется; мнение владельца о риске сохраняется', () => {
    const prev = {
      ...stepOf(recordStep(input(btn('Доставка')))),
      risk: 'confirm' as const,
    };
    const r = stepOf(
      recordStep(input(btn('Умови доставки'), { prev, count: 99 })),
    );
    expect(r.target?.pin.text).toBe('Умови доставки');
    expect(r.risk).toBe('confirm');
  });
});

describe('сохранение записи — перепроверка шагов', () => {
  const cart = () =>
    stepOf(recordStep(input(btn('В кошик', { assistId: 'add-to-cart' }))));
  const email = recordStep(
    input(
      {
        tag: 'input',
        role: 'textbox',
        text: 'E-mail',
        inputType: 'email',
        unique: true,
      },
      { fieldName: 'email' },
    ),
  );
  const ctx = { rules, host: HOST, endPage: '/cart', fresh: true };

  it('слоты без шагов — вон, цель по умолчанию — страница конца записи, ожидание адреса у перехода', () => {
    if (email.kind !== 'step') throw new Error('шаг');
    const r = recordedDraft(
      {
        names: { uk: 'Покласти в кошик' },
        steps: [cart(), { ...cart(), page: '/cart' }],
        slots: [email.slot, { name: 'zayvyi', kind: 'text' }],
      },
      ctx,
    );
    expect(r.issues).toEqual([]);
    expect(r.content.slots).toEqual([]);
    expect(r.content.goal.expect).toEqual([{ kind: 'url', path: '/cart' }]);
    expect(r.content.steps[0].expect).toEqual({ path: '/cart' });
  });

  it('значение вместо слота в новой записи — отказ; константа в поле ПД — отказ', () => {
    if (email.kind !== 'step') throw new Error('шаг');
    const withConst = { ...email.step, value: { const: 'Ivan' } };
    const r = recordedDraft(
      { names: { uk: 'Лист' }, steps: [withConst], slots: [] },
      ctx,
    );
    expect(r.issues.map((i) => i.code)).toContain('value_recorded');
    const edit = recordedDraft(
      {
        names: { uk: 'Лист' },
        steps: [{ ...email.step, value: { const: 'abc' } }],
      },
      { ...ctx, fresh: false },
    );
    expect(edit.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(['const_in_pii']),
    );
  });

  it('подложенный шаг-клик «Оплатити» (мимо записи) — `never_step`, черновика нет', () => {
    const fake = {
      ...cart(),
      target: {
        ...cart().target!,
        pin: { ...cart().target!.pin, assistId: null, text: 'Оплатити' },
      },
    };
    const r = recordedDraft({ names: { uk: 'Х' }, steps: [cart(), fake] }, ctx);
    expect(r.issues).toEqual(
      expect.arrayContaining([{ path: 'steps[1]', code: 'never_step' }]),
    );
  });
});

// ── «Прогнать» ────────────────────────────────────────────────────────────

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
const snap = (elements: UiSnapElement[], path = '/product/1'): UiSnapshot => ({
  url: `https://${HOST}${path}`,
  title: 'Футболка',
  elements,
});

describe('«Прогнать» черновик в редакторе', () => {
  const memo = parseMemoContent({
    names: { uk: 'Покласти в кошик і відкрити кошик' },
    goal: { text: { uk: 'Кошик' }, expect: [{ kind: 'url', path: '/cart' }] },
    steps: [
      {
        page: '/product/*',
        action: 'click',
        target: {
          pin: { assistId: 'add-to-cart', text: 'В кошик', role: 'button' },
        },
      },
      {
        page: '/product/*',
        action: 'click',
        target: {
          pin: { text: 'Кошик', role: 'link', tag: 'a', href: '/cart' },
        },
        expect: { path: '/cart' },
      },
      {
        page: '/cart',
        action: 'click',
        target: { pin: { text: 'Оновити', role: 'button' } },
      },
    ],
  }).content;
  const ctx = { rules, hosts: [HOST] };

  it('шаги страницы — найдены по отпечатку (подсветка по ref); после перехода — next', () => {
    const cartBtn = el({ text: 'В кошик', assistId: 'add-to-cart' });
    const link = el({
      text: 'Кошик',
      role: 'link',
      tag: 'a',
      href: `https://${HOST}/cart`,
    });
    const r = memoTry(memo, null, snap([cartBtn, link]), ctx);
    expect(r.steps.map((s) => [s.i, s.ok, s.ref])).toEqual([
      [0, true, cartBtn.ref],
      [1, true, link.ref],
    ]);
    expect(r.stopAt).toBeNull();
    expect(r.next).toEqual({ i: 2, page: '/cart' });
    expect(r.done).toBe(false);
  });

  it('подмена элемента (та же разметка, другой текст) — стоп на первом сбое с причиной', () => {
    const fake = el({ text: 'Купити в 1 клік', assistId: 'add-to-cart' });
    const link = el({
      text: 'Кошик',
      role: 'link',
      tag: 'a',
      href: `https://${HOST}/cart`,
    });
    const r = memoTry(memo, null, snap([fake, link]), ctx);
    expect(r.stopAt).toBe(0);
    expect(r.problem).toBe('pin_mismatch');
    // Дальше первого сбоя не идём.
    expect(r.steps).toHaveLength(1);
  });

  it('нет цели — `missing`; продолжение с `from` на другой странице; конец — цель', () => {
    expect(memoTry(memo, null, snap([]), ctx)).toMatchObject({
      stopAt: 0,
      problem: 'missing',
    });
    const away = memoTry(memo, null, snap([], '/about'), ctx, 0);
    expect(away).toMatchObject({
      next: { i: 0, page: '/product/*' },
      steps: [],
    });
    const end = memoTry(
      memo,
      null,
      snap([el({ text: 'Оновити' })], '/cart'),
      ctx,
      2,
    );
    expect(end).toMatchObject({ done: true, goal: 'ok', stopAt: null });
  });
});
