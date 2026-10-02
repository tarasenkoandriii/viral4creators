/**
 * Участники (кит, Э3): `memberId` из ответа — только безопасный сегмент
 * пути; PATCH/DELETE `/sites/account/members/:memberId` — те пути и тела,
 * что ждёт сервер (контракт Э3 §6, маршруты H).
 */
import assert from 'node:assert/strict';
import type { ApiClient } from '../src/kit';
import { createSitesApi, parseAccountInfo } from '../src/kit/sites-api';

const info = parseAccountInfo({
  account: { id: 'a1', type: 'owner', region: 'ua', verifyToken: 't' },
  me: { memberId: 'm1', telegramId: '1', role: 'owner', productRoles: {} },
  members: [
    { memberId: 'm1', telegramId: '1', role: 'owner', productRoles: {} },
    {
      memberId: '../../x',
      telegramId: '2',
      role: 'operator',
      productRoles: {},
    },
    { telegramId: '3', role: 'manager', productRoles: { assist: 'manager' } },
  ],
  accounts: [],
});
assert.equal(info.me.memberId, 'm1');
assert.equal(info.members![1].memberId, '', 'небезопасный id отброшен');
assert.equal(
  info.members![2].memberId,
  '',
  'нет id — пустая строка (правок нет)'
);

const calls: Array<{ method: string; path: string; body?: unknown }> = [];
const client: ApiClient = {
  async request<T>(method: string, path: string, body?: unknown) {
    calls.push({ method, path, ...(body === undefined ? {} : { body }) });
    return { account: { id: 'a1' }, me: {}, accounts: [] } as T;
  },
};
const api = createSitesApi(client);
await api.patchMember('m2', {
  role: 'manager',
  productRoles: { assist: 'manager', assistAdmin: 'none' },
});
await api.removeMember('m2');
assert.deepEqual(calls, [
  {
    method: 'PATCH',
    path: '/sites/account/members/m2',
    body: {
      role: 'manager',
      productRoles: { assist: 'manager', assistAdmin: 'none' },
    },
  },
  { method: 'DELETE', path: '/sites/account/members/m2' },
]);
await assert.rejects(api.removeMember('a/b'));

console.log('members: ok');
