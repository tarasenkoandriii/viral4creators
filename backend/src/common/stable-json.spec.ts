import { stableStringify } from './stable-json';

describe('stableStringify', () => {
  it('порядок ключей не влияет на результат', () => {
    // Ровно этот случай и ломал сравнение: Postgres возвращает
    // `jsonb` в своём порядке (короткие ключи раньше длинных), а не
    // в том, в каком объект собрали.
    const fromCode = { kind: 'fill', selector: '#a', value: 'x' };
    const fromDb = { kind: 'fill', value: 'x', selector: '#a' };
    expect(stableStringify(fromCode)).toBe(stableStringify(fromDb));
    expect(JSON.stringify(fromCode)).not.toBe(JSON.stringify(fromDb));
  });

  it('порядок элементов массива ЗНАЧИМ и сохраняется', () => {
    // Шаги сценария — последовательность: переставить их значит
    // изменить сценарий.
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
    expect(stableStringify([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });

  it('вложенность тоже канонизируется', () => {
    expect(stableStringify({ x: { b: 1, a: 2 } })).toBe(
      stableStringify({ x: { a: 2, b: 1 } }),
    );
  });

  it('разные данные остаются разными', () => {
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ b: 1 }));
    expect(stableStringify(null)).not.toBe(stableStringify({}));
  });

  it('undefined в значении выбрасывается, как у JSON.stringify', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(
      stableStringify({ a: 1 }),
    );
  });
});
