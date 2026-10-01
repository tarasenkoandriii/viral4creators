import { rrfMerge } from './rrf';

describe('RRF', () => {
  it('документ в двух списках обгоняет лидера одного', () => {
    const r = rrfMerge(
      [
        [
          { id: 'a', rank: 1 },
          { id: 'b', rank: 2 },
        ],
        [
          { id: 'b', rank: 1 },
          { id: 'c', rank: 2 },
        ],
      ],
      { k: 60, limit: 10 },
    );
    expect(r[0].id).toBe('b');
    expect(r[0].score).toBeCloseTo(1 / 62 + 1 / 61, 10);
    expect(r.map((x) => x.id)).toEqual(['b', 'a', 'c']);
  });

  it('бонус FAQ поднимает, штраф опускает; limit режет', () => {
    const lists = [
      [
        { id: 'page', rank: 1 },
        { id: 'faq', rank: 2 },
      ],
    ];
    const r = rrfMerge(lists, {
      k: 60,
      limit: 1,
      bonus: (id) => (id === 'faq' ? 0.01 : 0),
    });
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe('faq');
  });

  it('равенство — детерминированно (лучший ранг, затем id); дубль в списке не удваивает', () => {
    const r = rrfMerge(
      [
        [{ id: 'z', rank: 1 }],
        [{ id: 'a', rank: 1 }],
        [
          { id: 'q', rank: 3 },
          { id: 'q', rank: 1 },
        ],
      ],
      { k: 60, limit: 10 },
    );
    expect(r.map((x) => x.id)).toEqual(['a', 'q', 'z']);
    expect(r.find((x) => x.id === 'q')!.score).toBeCloseTo(1 / 61, 10);
  });

  it('пустые списки и неверные ранги', () => {
    expect(rrfMerge([], { k: 60, limit: 5 })).toEqual([]);
    expect(rrfMerge([[{ id: 'x', rank: 0 }]], { k: 60, limit: 5 })).toEqual([]);
  });
});
