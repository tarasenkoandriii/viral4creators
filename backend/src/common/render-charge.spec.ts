import { renderChargeOf, renderPathOf } from './render-charge';

describe('renderPathOf — порядок проверок assertCanRender', () => {
  it('рубильник выключен → кредит или лимит, кто бы ни был', () => {
    for (const signedIn of [true, false]) {
      for (const hasRight of [true, false]) {
        expect(renderPathOf({ wallEnabled: false, signedIn, hasRight })).toBe(
          'credit-or-limit',
        );
      }
    }
  });

  it('стена включена: анонимный → стена, право → лимит, иначе кредит или стена', () => {
    expect(
      renderPathOf({ wallEnabled: true, signedIn: false, hasRight: true }),
    ).toBe('wall');
    expect(
      renderPathOf({ wallEnabled: true, signedIn: true, hasRight: true }),
    ).toBe('limit');
    expect(
      renderPathOf({ wallEnabled: true, signedIn: true, hasRight: false }),
    ).toBe('credit-or-wall');
  });
});

describe('renderChargeOf — что спишет старт (эталон клиентского зеркала)', () => {
  it('нет данных → цену назвать нельзя', () => {
    expect(renderChargeOf(null)).toEqual({
      kind: 'unknown',
      reason: 'no-data',
    });
  });

  it('полный перебор', () => {
    const of = (
      wallEnabled: boolean,
      generationsAvailable: number,
      unlocked: boolean,
    ) => renderChargeOf({ wallEnabled, generationsAvailable, unlocked });
    expect(of(false, 3, false)).toEqual({ kind: 'credit', balance: 3 });
    expect(of(false, 3, true)).toEqual({ kind: 'credit', balance: 3 });
    expect(of(false, 0, false)).toEqual({ kind: 'included' });
    expect(of(true, 3, true)).toEqual({ kind: 'included' });
    expect(of(true, 0, true)).toEqual({ kind: 'included' });
    expect(of(true, 2, false)).toEqual({ kind: 'credit', balance: 2 });
    expect(of(true, 0, false)).toEqual({ kind: 'unknown', reason: 'locked' });
  });

  it('мусорный баланс: дробь вниз, минус — ноль', () => {
    expect(
      renderChargeOf({
        wallEnabled: true,
        generationsAvailable: 1.9,
        unlocked: false,
      }),
    ).toEqual({ kind: 'credit', balance: 1 });
    expect(
      renderChargeOf({
        wallEnabled: false,
        generationsAvailable: -4,
        unlocked: false,
      }),
    ).toEqual({ kind: 'included' });
  });
});
