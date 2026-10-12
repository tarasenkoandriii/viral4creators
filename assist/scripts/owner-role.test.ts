/**
 * Заход 13 (Р-З13-Б1): «Роли» «Админки» — «моя роль → owner»: словари
 * трёх языков совпадают по ключам; что сделает кнопка для введённой роли
 * (мусор / уже owner / замена с подтверждением / новая пара); клиент ходит
 * в маршрут контроллера и мусорную роль не отправляет; роль заказчика — по
 * тому же правилу, что ключ карты ролей на сервере.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ApiClient } from '../src/kit';
import { OWNER_ROLE_TEXTS } from '../src/i18n/owner-role';
import {
  ROLE_KEY_RE,
  createAdminModeApi,
  ownerRoleAction,
  ownerRoleKeys,
  withOwnerLine,
} from '../src/lib/admin-mode-api';

// 1. Словари: ключи равны, тексты не пустые.
{
  const keys = (o: object) => Object.keys(o).sort();
  assert.deepEqual(keys(OWNER_ROLE_TEXTS.ru), keys(OWNER_ROLE_TEXTS.uk));
  assert.deepEqual(keys(OWNER_ROLE_TEXTS.en), keys(OWNER_ROLE_TEXTS.uk));
  for (const d of Object.values(OWNER_ROLE_TEXTS))
    for (const [k, v] of Object.entries(d))
      assert.ok(typeof v === 'string' && v.trim(), `пусто: ${k}`);
}

// 2. Правило роли — как на сервере (ROLE_KEY_RE в admin-mode.dto.ts).
{
  const dto = readFileSync(
    new URL(
      '../../sites-backend/src/modules/assist-admin-mode/admin-mode.dto.ts',
      import.meta.url
    ),
    'utf8'
  );
  const m = /export const ROLE_KEY_RE = (\/.+\/u);/.exec(dto);
  assert.ok(m, 'нет ROLE_KEY_RE на сервере');
  assert.equal(m![1], String(ROLE_KEY_RE));
}

// 3. Что сделает кнопка.
{
  const map = { manager: 'orders', director: 'owner', boss: 'owner' };
  assert.deepEqual(ownerRoleKeys(map), ['boss', 'director']);
  assert.deepEqual(ownerRoleKeys({}), []);
  // Аудит З13 P3-1: «__proto__» — не роль (как на сервере).
  for (const bad of ['', '   ', 'a b', 'x'.repeat(65), '<b>', '__proto__'])
    assert.equal(ownerRoleAction(map, bad).kind, 'invalid', bad);
  assert.deepEqual(ownerRoleAction(map, ' director '), {
    kind: 'already',
    current: 'owner',
  });
  assert.deepEqual(ownerRoleAction(map, 'manager'), {
    kind: 'replace',
    current: 'orders',
  });
  assert.deepEqual(ownerRoleAction(map, 'директор'), {
    kind: 'new',
    current: null,
  });
  // Унаследованное свойство — не пара карты.
  assert.equal(ownerRoleAction(map, 'constructor').kind, 'new');
  assert.equal(ownerRoleAction(map, '__proto__x').kind, 'new');
}

// 3а. Аудит P3-7: пара дописывается в несохранённый текст карты ролей.
{
  assert.equal(
    withOwnerLine('manager=orders\ndirector = readers\nintern=x', 'director'),
    'manager=orders\ndirector=owner\nintern=x'
  );
  assert.equal(
    withOwnerLine('manager=orders', 'boss'),
    'manager=orders\nboss=owner'
  );
  assert.equal(
    withOwnerLine('manager=orders\n', 'boss'),
    'manager=orders\nboss=owner'
  );
  assert.equal(withOwnerLine('', 'boss'), 'boss=owner');
}

// 4. Клиент: маршрут контроллера; мусор не уходит на сервер.
{
  const calls: Array<[string, string, unknown]> = [];
  const client = {
    request: async (method: string, path: string, body?: unknown) => {
      calls.push([method, path, body]);
      return {
        role: 'director',
        previous: 'orders',
        changed: true,
        view: { siteId: 's1', roleMap: { director: 'owner' } },
      };
    },
  } as unknown as ApiClient;
  const api = createAdminModeApi(client);
  const r = await api.mapOwnerRole('s1', 'director');
  assert.deepEqual(calls, [
    [
      'POST',
      '/assist/sites/s1/admin-mode/role-map/owner',
      { role: 'director' },
    ],
  ]);
  assert.equal(r.previous, 'orders');
  assert.equal(r.changed, true);
  assert.deepEqual(r.view.roleMap, { director: 'owner' });
  await assert.rejects(api.mapOwnerRole('s1', 'a b'));
  await assert.rejects(api.mapOwnerRole('../x', 'director'));
  assert.equal(calls.length, 1);
  // Аудит P3-6: значение пары, которое видел экран, уходит на сервер.
  await api.mapOwnerRole('s1', 'manager', 'orders');
  await api.mapOwnerRole('s1', 'boss', null);
  assert.deepEqual(
    calls.slice(1).map((c) => c[2]),
    [
      { role: 'manager', expectedPrevious: 'orders' },
      { role: 'boss', expectedPrevious: null },
    ]
  );
}

console.log('owner-role: ok');
