/**
 * Цели и детекторы (A): строгий разбор, orderId «не контакт» (§5-тер.16
 * п.1: `ivan@example.com` — отказ), поле ввода выбрать нельзя (§5-тер.8),
 * умолчания «Заявка» + tel + мессенджеры, маски путей.
 */
import {
  defaultGoals,
  loaderDetectors,
  parseGoalInput,
  pathMatchesMask,
  storedDetectors,
  validOrderId,
} from './goal-types';

const base = {
  key: 'purchase',
  template: 'purchase',
  name: 'Покупка',
  detectors: [{ kind: 'url', config: { pathMask: '/checkout/success*' } }],
  valueMode: 'event',
};

describe('goal-types (A)', () => {
  it('orderId: формат и «не похож на контакт» — e-mail и телефон отклоняются', () => {
    expect(validOrderId('A-1042')).toBe(true);
    expect(validOrderId('Z:9.9')).toBe(true);
    expect(validOrderId('wc_2024_17')).toBe(true);
    expect(validOrderId('ivan@example.com')).toBe(false);
    expect(validOrderId('380671234567')).toBe(false);
    expect(validOrderId('order-0671234567')).toBe(false);
    expect(validOrderId('')).toBe(false);
    expect(validOrderId('x'.repeat(65))).toBe(false);
    expect(validOrderId('A 1')).toBe(false);
  });

  it('разбор цели: валидная форма, умолчания полей, лишнее поле — unknown', () => {
    const r = parseGoalInput(base);
    expect(r).toEqual({
      ok: true,
      goal: {
        ...base,
        detectors: [
          {
            kind: 'url',
            config: { pathMask: '/checkout/success*', fromPathMask: null },
          },
        ],
        fixedValue: null,
        currency: null,
      },
    });
    const bad = parseGoalInput({ ...base, extra: 1 });
    expect(bad).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([{ path: 'extra', code: 'unknown' }]),
    });
  });

  it('поле ввода выбрать нельзя: input/textarea/select и роль textbox — отказ', () => {
    for (const tag of ['input', 'textarea', 'select']) {
      const r = parseGoalInput({
        ...base,
        detectors: [
          {
            kind: 'click',
            config: { descriptor: { text: 'Телефон', tag }, pathMask: null },
          },
        ],
      });
      expect(r).toMatchObject({
        ok: false,
        errors: expect.arrayContaining([
          {
            path: 'detectors.0.config.descriptor.tag',
            code: 'input_not_allowed',
          },
        ]),
      });
    }
    const role = parseGoalInput({
      ...base,
      detectors: [
        {
          kind: 'form_submit',
          config: {
            descriptor: { text: 'x', role: 'textbox' },
            pathMask: null,
          },
        },
      ],
    });
    expect(role.ok).toBe(false);
    const ok = parseGoalInput({
      ...base,
      detectors: [
        {
          kind: 'click',
          config: {
            descriptor: {
              text: 'Оформити замовлення',
              role: 'button',
              tag: 'BUTTON',
            },
            pathMask: '/product/*',
          },
        },
      ],
    });
    expect(ok.ok).toBe(true);
  });

  it('builtin — только у шаблона «Заявка»; fixed без суммы — ошибка; ≤ 5 детекторов', () => {
    expect(
      parseGoalInput({
        ...base,
        detectors: [{ kind: 'builtin', config: { event: 'lead' } }],
      }).ok,
    ).toBe(false);
    expect(parseGoalInput({ ...base, valueMode: 'fixed' }).ok).toBe(false);
    expect(
      parseGoalInput({
        ...base,
        valueMode: 'fixed',
        fixedValue: 300,
        currency: 'UAH',
      }).ok,
    ).toBe(true);
    expect(
      parseGoalInput({ ...base, detectors: Array(6).fill(base.detectors[0]) })
        .ok,
    ).toBe(false);
    expect(parseGoalInput({ ...base, key: 'Покупка' }).ok).toBe(false);
    expect(parseGoalInput({ ...base, currency: 'uah' }).ok).toBe(false);
  });

  it('умолчания: «Заявка» (builtin) + tel + мессенджеры; загрузчику — только его детекторы', () => {
    const d = defaultGoals();
    expect(d.map((g) => g.key)).toEqual(['lead', 'call', 'messenger']);
    for (const g of d) expect(parseGoalInput(g).ok).toBe(true);
    expect(loaderDetectors(d[0].detectors)).toEqual([]);
    expect(loaderDetectors(d[1].detectors)).toEqual([
      { kind: 'click', config: { auto: 'tel' } },
    ]);
    // Битый JSON базы — пропуск, а не исключение.
    expect(
      storedDetectors([{ kind: 'nope' }, d[1].detectors[0]], 'call'),
    ).toEqual(d[1].detectors);
  });

  it('маски путей: * — любая подстрока, остальное буквально', () => {
    expect(pathMatchesMask('/checkout/success', '/checkout/success*')).toBe(
      true,
    );
    expect(pathMatchesMask('/checkout/success/42', '/checkout/success*')).toBe(
      true,
    );
    expect(pathMatchesMask('/checkout', '/checkout/success*')).toBe(false);
    expect(pathMatchesMask('/a.b', '/a.b')).toBe(true);
    expect(pathMatchesMask('/axb', '/a.b')).toBe(false);
  });
});
