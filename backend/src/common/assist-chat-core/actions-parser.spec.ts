import {
  ActionKindValidators,
  isAllowedAction,
  parseActionsBlock,
} from './actions-parser';

type Kind = 'go' | 'video' | 'free';
type Action = { kind: Kind; n?: number; key?: string };

const validators: ActionKindValidators<Kind> = {
  go: (v) => typeof v.n === 'number' && v.n >= 1 && v.n <= 5,
  video: (v) => typeof v.key === 'string' && v.key.length > 0,
  free: () => true,
};

const parse = (raw: string | null, extra: object = {}) =>
  parseActionsBlock<Action, Kind>(raw, {
    validators,
    maxItems: 3,
    ...extra,
  });
const json = (items: unknown) => JSON.stringify({ items });

describe('parseActionsBlock', () => {
  it('null, битый JSON, не массив — [] без исключения', () => {
    expect(parse(null)).toEqual([]);
    expect(parse('{oops')).toEqual([]);
    expect(parse('{"items":"нет"}')).toEqual([]);
    expect(parse('null')).toEqual([]);
  });

  it('kind вне белого списка отбрасывается, валидные остаются по порядку', () => {
    expect(
      parse(
        json([{ kind: 'delete-all' }, { kind: 'go', n: 2 }, { kind: 'free' }]),
      ),
    ).toEqual([{ kind: 'go', n: 2 }, { kind: 'free' }]);
  });

  it('унаследованные имена (toString, __proto__, constructor) — не «известный kind»', () => {
    expect(
      parse(
        '{"items":[{"kind":"toString"},{"kind":"__proto__"},{"kind":"constructor"}]}',
      ),
    ).toEqual([]);
  });

  it('поля проверяются валидатором своего kind', () => {
    expect(parse(json([{ kind: 'go', n: 99 }, { kind: 'go' }]))).toEqual([]);
  });

  it('не-объекты и kind не строкой отбрасываются', () => {
    expect(parse(json([1, 'go', null, { kind: 5 }]))).toEqual([]);
  });

  it('обрезает до maxItems', () => {
    const items = [1, 2, 3, 4, 5].map((n) => ({ kind: 'go', n }));
    expect(parse(json(items))).toHaveLength(3);
    expect(parse(json(items), { maxItems: 1 })).toEqual([{ kind: 'go', n: 1 }]);
  });

  it('maxPerKind: первые сохраняются, лишние отбрасываются; потолок — ПОСЛЕ обрезки', () => {
    const items = [
      { kind: 'video', key: 'a' },
      { kind: 'go', n: 1 },
      { kind: 'video', key: 'b' },
      { kind: 'go', n: 2 },
    ];
    // Обрезка до трёх, затем второй video отбрасывается — остаётся два,
    // а не «добирается» go:2 (так работал лендинг).
    expect(parse(json(items), { maxPerKind: { video: 1 } })).toEqual([
      { kind: 'video', key: 'a' },
      { kind: 'go', n: 1 },
    ]);
  });

  it('без maxPerKind повторы kind допустимы', () => {
    const items = [
      { kind: 'video', key: 'a' },
      { kind: 'video', key: 'b' },
    ];
    expect(parse(json(items))).toHaveLength(2);
  });

  it('потолок 2 пропускает ровно два', () => {
    const items = [1, 2, 3].map((n) => ({ kind: 'go', n }));
    expect(parse(json(items), { maxPerKind: { go: 2 } })).toEqual([
      { kind: 'go', n: 1 },
      { kind: 'go', n: 2 },
    ]);
  });
});

describe('isAllowedAction', () => {
  it('true только для kind из списка с валидными полями', () => {
    expect(isAllowedAction({ kind: 'free' }, validators)).toBe(true);
    expect(isAllowedAction({ kind: 'go', n: 0 }, validators)).toBe(false);
    expect(isAllowedAction(undefined, validators)).toBe(false);
  });
});
