import { parseGenerated } from './generated-contract';
import { generatedFixture } from './generated-fixture.testing';
import { mockTransition, planStand, checkStand } from './stand-contract';
describe('generated UI and entity mock contract', () => {
  const description = 'Кабинет заказов и клиентов с суммой и email';
  it('accepts only bounded declarative data and roundtrips persisted contract', () => {
    const c = parseGenerated(
      { ...generatedFixture(), code: 'fetch(secret)' },
      description,
    );
    expect(c).not.toHaveProperty('code');
    expect(planStand(c)).toEqual(c);
    expect(checkStand(c).checks.every((c) => c.passed)).toBe(true);
  });
  it('rejects dangling transitions, unknown kinds, duplicate IDs and excess entities', () => {
    const f = generatedFixture();
    f.screens[0].nextScreenId = 'missing';
    expect(() => parseGenerated(f, description)).toThrow();
    expect(() =>
      parseGenerated(
        {
          ...generatedFixture(),
          entities: Array(6).fill(generatedFixture().entities[0]),
        },
        description,
      ),
    ).toThrow();
    expect(() =>
      parseGenerated(
        {
          ...generatedFixture(),
          screens: [{ ...generatedFixture().screens[0], kind: 'script' }],
        },
        description,
      ),
    ).toThrow();
  });
  it('validates types and isolates entity data and deletion', () => {
    const c = parseGenerated(generatedFixture(), description);
    expect(
      mockTransition(c, [], {
        method: 'POST',
        role: 'editor',
        entityId: 'orders',
        values: ['Order', 'bad-number'],
      }).status,
    ).toBe(422);
    const created = mockTransition(c, [], {
      method: 'POST',
      role: 'editor',
      entityId: 'orders',
      values: ['Order', '42.5'],
    });
    expect(created.status).toBe(201);
    expect(
      mockTransition(c, created.records, {
        method: 'GET',
        role: 'viewer',
        entityId: 'clients',
      }).data,
    ).toEqual({ items: [] });
    expect(
      mockTransition(c, created.records, {
        method: 'DELETE',
        role: 'admin',
        entityId: 'clients',
        id: created.records[0].id,
      }).status,
    ).toBe(404);
    expect(() =>
      mockTransition(c, [], {
        method: 'GET',
        role: 'viewer',
        entityId: 'unknown',
      }),
    ).toThrow();
  });
  it('validates select enums and mandatory email', () => {
    const f = generatedFixture();
    f.entities[1].fields = [
      { name: 'Email', type: 'email', required: true, options: [] },
    ];
    const c = parseGenerated(f, description);
    expect(
      mockTransition(c, [], {
        method: 'POST',
        role: 'editor',
        entityId: 'clients',
        values: ['invalid'],
      }).status,
    ).toBe(422);
  });
});
