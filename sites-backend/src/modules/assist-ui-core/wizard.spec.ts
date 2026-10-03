/**
 * Мастер проверки Т-2 — чистые правила (Э6-бис (г), ТЗ §5-бис.13; решение
 * владельца 03.10.2026 п.1): команды мастера, «запреты без звука» с
 * «худшей моделью», список 1, разбор списка 2, вердикт, годность отчёта,
 * фрагмент разметки, последний рубеж «нарушение запрета».
 */
import { defaultVoiceControlRules } from './rules';
import type { UiSnapElement, UiSnapshot } from './types';
import {
  forbiddenProbes,
  markupFragment,
  neverList,
  neverViolation,
  parseSuspicious,
  reportUsable,
  suggestCommands,
  wizardVerdict,
  WIZARD_LIMITS,
  type WizardVerdictInput,
} from './wizard';

const HOSTS = ['shop.example.com'];
const rules = defaultVoiceControlRules();

function el(
  o: Partial<UiSnapElement> & { ref: string; text: string },
): UiSnapElement {
  return {
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
    ...o,
  };
}

const snap = (
  elements: UiSnapElement[],
  title = 'Футболки магазин',
): UiSnapshot => ({
  url: 'https://shop.example.com/catalog',
  title,
  elements,
});

const page = snap([
  el({
    ref: 'e1',
    role: 'link',
    tag: 'a',
    text: 'Доставка',
    href: 'https://shop.example.com/delivery',
  }),
  el({
    ref: 'e2',
    role: 'link',
    tag: 'a',
    text: 'Партнер',
    href: 'https://evil.example.org/x',
  }),
  el({ ref: 'e3', text: 'Оплатити замовлення' }),
  el({ ref: 'e4', text: 'Видалити акаунт' }),
  el({ ref: 'e5', text: 'Оформити замовлення', submit: true, inForm: true }),
  el({
    ref: 'e6',
    role: 'textbox',
    tag: 'input',
    inputType: 'text',
    text: 'Пароль',
  }),
  el({
    ref: 'e7',
    role: 'searchbox',
    tag: 'input',
    inputType: 'search',
    text: 'Пошук',
  }),
  el({ ref: 'e8', role: 'tab', text: 'Відгуки', toggle: true }),
  el({ ref: 'e9', text: 'Купити', assistId: 'add-to-cart' }),
  el({
    ref: 'e10',
    role: 'link',
    tag: 'a',
    text: 'Новий файл',
    href: 'https://shop.example.com/f.pdf',
    gesture: 'download',
  }),
]);

describe('мастер Т-2: команды', () => {
  it('предлагает только безопасные: своя ссылка, вкладка, поиск; ни чужой ссылки, ни опасного', () => {
    const c = suggestCommands({
      snapshot: page,
      rules,
      hosts: HOSTS,
      lang: 'uk',
    });
    const texts = c.map((x) => x.text);
    expect(texts).toContain('відкрий «Доставка»');
    expect(texts).toContain('відкрий «Відгуки»');
    expect(texts).toContain('знайди Футболки');
    expect(texts.join(' ')).not.toMatch(
      /Партнер|Оплатити|Видалити|Оформити|Новий файл/,
    );
    expect(c.every((x) => x.safe)).toBe(true);
    expect(c.length).toBeLessThanOrEqual(WIZARD_LIMITS.dryCommands);
  });

  it('язык команды — язык мастера', () => {
    const c = suggestCommands({
      snapshot: page,
      rules,
      hosts: HOSTS,
      lang: 'en',
    });
    expect(c[0].text.startsWith('open «')).toBe(true);
  });
});

describe('мастер Т-2: запреты без звука («худшая модель»)', () => {
  it('все пять запрещённых команд заблокированы на странице с опасными целями', () => {
    const r = forbiddenProbes({
      snapshot: page,
      rules,
      hosts: HOSTS,
      lang: 'uk',
    });
    expect(r.map((x) => x.kind)).toEqual([
      'pay',
      'delete',
      'password',
      'checkout',
      'external',
    ]);
    for (const p of r) expect(p.blocked).toBe(true);
    // Худшая модель пробовала настоящие цели страницы.
    const by = Object.fromEntries(r.map((x) => [x.kind, x]));
    expect(by.pay.candidates).toBe(1);
    expect(by.delete.candidates).toBe(1);
    expect(by.password.candidates).toBe(1);
    expect(by.external.candidates).toBe(1);
    expect(by.external.reasons).toContain('offhost');
    expect(by.pay.reasons).toContain('payment');
  });

  it('целей нет на странице — блок тривиальный (candidates 0)', () => {
    const r = forbiddenProbes({
      snapshot: snap([]),
      rules,
      hosts: HOSTS,
      lang: 'ru',
    });
    expect(r.every((x) => x.blocked && x.candidates === 0)).toBe(true);
    expect(r[0].command).toBe('оплати заказ');
  });

  it('«Купити» с разметкой add-to-cart — «в кошик», не оформление: не кандидат «оформи»', () => {
    const r = forbiddenProbes({
      snapshot: snap([
        el({ ref: 'e1', text: 'Купити', assistId: 'add-to-cart' }),
      ]),
      rules,
      hosts: HOSTS,
      lang: 'uk',
    });
    const c = r.find((x) => x.kind === 'checkout')!;
    expect(c.candidates).toBe(0);
    expect(c.blocked).toBe(true);
    // Без разметки «Купити» — кандидат, и код её не нажимает.
    const r2 = forbiddenProbes({
      snapshot: snap([el({ ref: 'e1', text: 'Купити' })]),
      rules,
      hosts: HOSTS,
      lang: 'uk',
    });
    const c2 = r2.find((x) => x.kind === 'checkout')!;
    expect(c2.candidates).toBe(1);
    expect(c2.blocked).toBe(true);
  });
});

describe('мастер Т-2: списки опасного', () => {
  it('список 1 — стоп-лист и оплата по снимку', () => {
    const l = neverList({ snapshot: page, rules, hosts: HOSTS });
    const texts = l.map((x) => x.text);
    expect(texts).toEqual(
      expect.arrayContaining([
        'Оплатити замовлення',
        'Видалити акаунт',
        'Оформити замовлення',
      ]),
    );
    expect(texts).not.toContain('Доставка');
    expect(texts).not.toContain('Купити');
  });

  it('список 1 — запреты кабинета (слова) тоже «никогда»', () => {
    const l = neverList({
      snapshot: page,
      rules: { ...rules, denyWords: ['Відгуки'] },
      hosts: HOSTS,
    });
    expect(l.map((x) => x.text)).toContain('Відгуки');
  });

  it('список 2 — строгий разбор: ключ, причина, маска подписи, селектор', () => {
    const items = parseSuspicious([
      {
        key: 's1',
        why: 'icon_trash',
        tag: 'button',
        label: 'ivan@x.com',
        selector: 'form#o > button:nth-of-type(2)',
      },
      {
        key: 'bad key!',
        why: 'icon_trash',
        tag: 'button',
        label: '',
        selector: 'x',
      },
      { key: 's2', why: 'unknown', tag: 'button', label: '', selector: 'x' },
      {
        key: 's3',
        why: 'class_danger',
        tag: '<script>',
        label: '',
        selector: 'a<b',
      },
    ]);
    expect(items.map((i) => i.key)).toEqual(['s1', 's3']);
    expect(items[0].label).not.toContain('ivan@x.com');
    expect(items[1].tag).toBe('other');
    expect(items[1].selector).toBe('');
    expect(parseSuspicious('x')).toEqual([]);
  });
});

function input(o: Partial<WizardVerdictInput> = {}): WizardVerdictInput {
  return {
    env: {
      widget: true,
      chunks: true,
      csp: 0,
      tt: 0,
      micPolicy: 'allowed',
      release: null,
    },
    mic: 'ok',
    markup: {
      total: 10,
      withId: 2,
      unnamed: [],
      closedShadow: 0,
      extIframes: 0,
      duplicates: [],
      denied: 0,
    },
    suspicious: [
      {
        key: 's1',
        why: 'icon_trash',
        tag: 'button',
        label: '',
        selector: 'button.x',
      },
    ],
    reviewed: { s1: 'deny' },
    dry: [
      { planId: 'p1', command: 'a', steps: 2, ok: 2 },
      { planId: 'p2', command: 'b', steps: 1, ok: 1 },
    ],
    safe: [
      { planId: 'p3', command: 'c', done: true, status: 'done' },
      { planId: 'p4', command: 'd', done: true, status: 'done' },
      { planId: 'p5', command: 'e', done: false, status: 'failed' },
    ],
    forbidden: forbiddenProbes({
      snapshot: page,
      rules,
      hosts: HOSTS,
      lang: 'uk',
    }),
    ...o,
  };
}

describe('мастер Т-2: вердикт (§5-бис.13)', () => {
  it('все критерии — pass', () => {
    const v = wizardVerdict(input());
    expect(v.result).toBe('pass');
    expect(v.items.filter((i) => i.level === 'fail')).toEqual([]);
  });

  it('политика сайта запрещает микрофон — fail (а не предупреждение)', () => {
    expect(
      wizardVerdict(input({ env: { ...input().env, micPolicy: 'denied' } }))
        .result,
    ).toBe('fail');
    expect(wizardVerdict(input({ mic: 'denied_policy' })).result).toBe('fail');
  });

  it('микрофон владельца (отказ браузера, нет устройства) — предупреждение, pass', () => {
    const v = wizardVerdict(input({ mic: 'denied_user' }));
    expect(v.result).toBe('pass');
    expect(v.items.find((i) => i.step === 2)!.level).toBe('warn');
  });

  it('утечка запрета — fail', () => {
    const f = input().forbidden.map((x, i) =>
      i === 0 ? { ...x, blocked: false } : x,
    );
    expect(wizardVerdict(input({ forbidden: f })).result).toBe('fail');
    // Неполный набор запретов — тоже провал.
    expect(wizardVerdict(input({ forbidden: f.slice(1) })).result).toBe('fail');
  });

  it('сухой прогон < 3 «верно» — partial', () => {
    const v = wizardVerdict(
      input({ dry: [{ planId: 'p', command: 'a', steps: 5, ok: 2 }] }),
    );
    expect(v.result).toBe('partial');
    expect(v.items.find((i) => i.code === 'dry_low')).toBeTruthy();
  });

  it('«верно» больше шагов не засчитывается (ok ≤ steps)', () => {
    const v = wizardVerdict(
      input({ dry: [{ planId: 'p', command: 'a', steps: 1, ok: 9 }] }),
    );
    expect(v.result).toBe('partial');
  });

  it('с нажатием < 2 из 3 done — partial; ни одного — partial', () => {
    const one = input().safe.map((s, i) => ({ ...s, done: i === 0 }));
    expect(wizardVerdict(input({ safe: one })).result).toBe('partial');
    expect(wizardVerdict(input({ safe: [] })).result).toBe('partial');
  });

  it('список 2 просмотрен не целиком — partial', () => {
    expect(wizardVerdict(input({ reviewed: {} })).result).toBe('partial');
  });

  it('окружение: CSP/Trusted Types/чанки — провал шага 1, итог partial', () => {
    expect(
      wizardVerdict(input({ env: { ...input().env, csp: 2 } })).result,
    ).toBe('partial');
    expect(
      wizardVerdict(input({ env: { ...input().env, tt: 1 } })).result,
    ).toBe('partial');
    expect(
      wizardVerdict(input({ env: { ...input().env, chunks: false } })).result,
    ).toBe('partial');
  });

  it('кнопки без имени — предупреждение, итог не меняет', () => {
    const v = wizardVerdict(
      input({
        markup: {
          ...input().markup,
          unnamed: [{ key: 'u', tag: 'button', selector: 'button' }],
        },
      }),
    );
    expect(v.result).toBe('pass');
    expect(v.items.find((i) => i.code === 'unnamed_elements')!.level).toBe(
      'warn',
    );
  });
});

describe('годность отчёта для `on` (решение владельца п.1)', () => {
  const now = new Date('2026-10-10T00:00:00Z');
  const base = {
    result: 'pass',
    reportedAt: new Date('2026-10-05T00:00:00Z'),
    validUntil: new Date('2026-11-04T00:00:00Z'),
    release: null as string | null,
    partialAck: false,
  };
  const ok = (o: Partial<Parameters<typeof reportUsable>[0]> = {}) =>
    reportUsable({
      report: base,
      now,
      currentRelease: null,
      markupChangedAt: null,
      stateChangedAt: null,
      needNewerThanState: false,
      ...o,
    });

  it('pass не старше 30 дней — годен', () => expect(ok()).toBeNull());
  it('нет отчёта — none', () => expect(ok({ report: null })).toBe('none'));
  it('fail — failed', () =>
    expect(ok({ report: { ...base, result: 'fail' } })).toBe('failed'));
  it('partial без подтверждения — partial_ack; с подтверждением — годен', () => {
    expect(ok({ report: { ...base, result: 'partial' } })).toBe('partial_ack');
    expect(
      ok({ report: { ...base, result: 'partial', partialAck: true } }),
    ).toBeNull();
  });
  it('старше 30 дней — expired', () =>
    expect(ok({ now: new Date('2026-11-05T00:00:00Z') })).toBe('expired'));
  it('смена загрузчика — loader_changed', () =>
    expect(ok({ currentRelease: '2026.10.09-1' })).toBe('loader_changed'));
  it('разметка проверенных страниц устарела ПОСЛЕ отчёта — markup_changed; до — нет', () => {
    expect(ok({ markupChangedAt: new Date('2026-10-06T00:00:00Z') })).toBe(
      'markup_changed',
    );
    expect(
      ok({ markupChangedAt: new Date('2026-10-04T00:00:00Z') }),
    ).toBeNull();
  });
  it('выход из деградации — только отчётом новее смены состояния', () => {
    expect(
      ok({
        needNewerThanState: true,
        stateChangedAt: new Date('2026-10-06T00:00:00Z'),
      }),
    ).toBe('older_than_state');
    expect(
      ok({
        needNewerThanState: true,
        stateChangedAt: new Date('2026-10-04T00:00:00Z'),
      }),
    ).toBeNull();
  });
});

describe('фрагмент разметки', () => {
  it('кнопки без имени и «запретить» из списка 2 — в фрагменте; «безопасно» — нет', () => {
    const f = markupFragment({
      unnamed: [{ tag: 'button', selector: 'header > button' }],
      suspicious: [
        {
          key: 'a',
          why: 'icon_trash',
          tag: 'button',
          label: '',
          selector: 'button.trash',
        },
        {
          key: 'b',
          why: 'class_danger',
          tag: 'a',
          label: '',
          selector: 'a.remove',
        },
      ],
      reviewed: { a: 'deny', b: 'safe' },
      lang: 'uk',
    });
    expect(f).toContain('header > button');
    expect(f).toContain('button.trash');
    expect(f).toContain('data-assist="never"');
    expect(f).not.toContain('a.remove');
    expect(f).toContain('data-assist-id="add-to-cart"');
  });
});

describe('последний рубеж: нарушение запрета (§5-бис.14)', () => {
  const ctx = { rules, hosts: HOSTS };
  const step = (text: string, o: Record<string, unknown> = {}) => ({
    kind: 'click' as const,
    target: {
      ref: 'e1',
      assistId: null,
      role: 'button' as const,
      text,
      selector: null,
      href: null,
    },
    value: null,
    risk: 'auto' as const,
    ...o,
  });

  it('исполнимый шаг по цели «никогда» — нарушение', () => {
    expect(neverViolation(step('Оплатити'), ctx)).toBe('payment');
    expect(neverViolation(step('Видалити акаунт'), ctx)).toBe('danger');
  });
  it('поле с подписью «пароль» — нарушение', () => {
    expect(
      neverViolation(step('Пароль', { kind: 'fill', value: '1234' }), ctx),
    ).toBe('sensitive_field');
  });
  it('обычные цели и «Купити» с add-to-cart — не нарушение', () => {
    expect(neverViolation(step('Доставка'), ctx)).toBeNull();
    expect(
      neverViolation(
        step('Купити', {
          target: {
            ref: 'e1',
            assistId: 'add-to-cart',
            role: 'button',
            text: 'Купити',
            selector: null,
            href: null,
          },
        }),
        ctx,
      ),
    ).toBeNull();
  });
  it('шаг «нажмите сами»/«никогда» не исполняется — не нарушение; подсветка — тоже', () => {
    expect(neverViolation(step('Оплатити', { risk: 'never' }), ctx)).toBeNull();
    expect(
      neverViolation(step('Оплатити', { kind: 'highlight' }), ctx),
    ).toBeNull();
  });
  it('запрет кабинета (слово) — нарушение', () => {
    expect(
      neverViolation(step('Акція'), {
        rules: { ...rules, denyWords: ['акція'] },
        hosts: HOSTS,
      }),
    ).toBe('denied');
  });
});
