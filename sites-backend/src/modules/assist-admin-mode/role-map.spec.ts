/**
 * Заход 13 (Р-З13-Б2) — разница карт ролей для журнала «Админки»:
 * новые и изменённые пары, снятые ключи; порядок ключей не важен; без
 * изменений — null (строки журнала нет); «__proto__» — обычный ключ.
 */
import { parseRoleMap, roleMapDiff } from './admin-mode.service';

describe('roleMapDiff', () => {
  it('новые, изменённые и снятые пары; без изменений — null', () => {
    expect(
      roleMapDiff(
        { manager: 'orders', intern: 'readers', boss: 'owner' },
        { boss: 'owner', manager: 'owner', director: 'owner' },
      ),
    ).toEqual({
      set: { manager: 'owner', director: 'owner' },
      removed: ['intern'],
    });
    expect(roleMapDiff({ a: 'x', b: 'y' }, { b: 'y', a: 'x' })).toBeNull();
    expect(roleMapDiff({}, {})).toBeNull();
  });

  it('«__proto__» и «constructor» — обычные роли заказчика', () => {
    const before = JSON.parse('{"__proto__":"readers"}') as Record<
      string,
      string
    >;
    const after = JSON.parse(
      '{"__proto__":"owner","constructor":"owner"}',
    ) as Record<string, string>;
    expect(roleMapDiff(before, after)).toEqual(
      JSON.parse(
        '{"set":{"__proto__":"owner","constructor":"owner"},"removed":[]}',
      ),
    );
    expect(roleMapDiff(after, {})?.removed).toEqual([
      '__proto__',
      'constructor',
    ]);
  });
});

describe('parseRoleMap (аудит З13 P3-1)', () => {
  it('«__proto__» — не роль (null, а не тихо пустая карта); прочие ключи — собственные свойства', () => {
    expect(
      parseRoleMap(JSON.parse('{"__proto__":"owner","boss":"owner"}')),
    ).toBeNull();
    const m = parseRoleMap(JSON.parse('{"constructor":"owner","boss":"x"}'));
    expect(m).toEqual(JSON.parse('{"constructor":"owner","boss":"x"}'));
    expect(Object.prototype.hasOwnProperty.call(m, 'constructor')).toBe(true);
    expect(Object.keys(m!)).toEqual(['constructor', 'boss']);
  });
});
