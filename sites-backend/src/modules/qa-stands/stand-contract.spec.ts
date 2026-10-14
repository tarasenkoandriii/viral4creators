import {
  baseline,
  checkStand,
  mockTransition,
  planStand,
} from './stand-contract';
describe('mock stand contract', () => {
  const c = planStand({
    description: 'Кабинет заказов. Поля: Название, Статус',
  });
  it('derives editable fields without executing description', () => {
    expect(c.fields).toEqual(['Название', 'Статус']);
    expect(() => planStand({ description: 'short' })).toThrow();
  });
  it('rejects duplicate and oversized fields', () => {
    expect(() => planStand({ description: 'Поля: name, name' })).toThrow();
    expect(() =>
      planStand({ description: 'Поля: ' + 'x'.repeat(61) }),
    ).toThrow();
  });
  it('passes all independent contract checks', () =>
    expect(checkStand(c).checks.every((x) => x.passed)).toBe(true));
  it('does not mutate baseline on create', () => {
    const seed = baseline(c);
    mockTransition(c, seed, {
      method: 'POST',
      role: 'editor',
      values: ['a', 'b'],
    });
    expect(seed).toEqual(baseline(c));
  });
  it('blocks editor deletion', () =>
    expect(
      mockTransition(c, baseline(c), {
        method: 'DELETE',
        role: 'editor',
        id: 'demo-1',
      }).status,
    ).toBe(403));
  it('returns empty search and simulated rate limit without writes', () => {
    expect(
      mockTransition(c, baseline(c), {
        method: 'GET',
        role: 'viewer',
        query: 'absent',
      }).data,
    ).toEqual({ items: [] });
    expect(
      mockTransition(c, baseline(c), {
        method: 'POST',
        role: 'admin',
        scenario: '429',
      }).changed,
    ).toBe(false);
  });
  it('rejects invalid command and record limit', () => {
    expect(() =>
      mockTransition(c, [], { method: 'PATCH', role: 'admin' }),
    ).toThrow();
    expect(
      mockTransition(
        c,
        Array.from({ length: 100 }, () => baseline(c)[0]),
        { method: 'POST', role: 'admin', values: ['a', 'b'] },
      ).status,
    ).toBe(409);
  });
});
