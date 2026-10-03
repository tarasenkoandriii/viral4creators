/**
 * Э7: клиент «Админки» TMA — строгий разбор (неизвестное → умолчание,
 * секрета в виде нет) и адреса маршрутов (§4.16: admin-mode, connectors,
 * action-log, learning/admin, admin-chat).
 */
import assert from 'node:assert/strict';
import {
  createAdminModeApi,
  parseAdminMode,
  parseConnector,
} from '../src/lib/admin-mode-api';

const m = parseAdminMode({
  enabled: true,
  access: 'evil',
  roleMap: { manager: 'orders', x: 5 },
  identitySecret: { set: true, setAt: '2026-10-03T00:00:00Z', secret: 'leak' },
  snippet: {
    tag: '<script>',
    origin: 'https://wa.x',
    csp: 'script-src https://wa.x',
  },
});
assert.equal(m.access, 'tma');
assert.deepEqual(m.roleMap, { manager: 'orders' });
assert.deepEqual(m.identitySecret, {
  set: true,
  setAt: '2026-10-03T00:00:00Z',
});
assert.equal(JSON.stringify(m).includes('leak'), false);

const c = parseConnector({
  id: 'c1',
  operations: [
    {
      id: 'o1',
      kind: 'nope',
      autoKind: 'danger',
      params: [{ name: 'id', in: 'path' }],
    },
  ],
  secret: { set: true, tail: '1a2b', value: 'SECRET' },
});
assert.equal(c.operations[0].kind, 'read');
assert.equal(c.operations[0].autoKind, 'danger');
assert.equal(JSON.stringify(c).includes('SECRET'), false);

const calls: Array<[string, string, unknown]> = [];
const api = createAdminModeApi({
  request: async <T>(method: string, path: string, body?: unknown) => {
    calls.push([method, path, body]);
    return (
      path.endsWith('/connectors') ||
      path.endsWith('/action-log') ||
      path.endsWith('/queue')
        ? []
        : {}
    ) as T;
  },
});
await api.get('s1');
await api.connectors('s1');
await api.patchOperation('s1', 'c1', 'getOrder', { enabled: true });
await api.actionLog('s1');
await api.learning('s1');
await api.chatAsk('s1', 'q', 'rid12345');
assert.deepEqual(
  calls.map(([mth, p]) => `${mth} ${p}`),
  [
    'GET /assist/sites/s1/admin-mode',
    'GET /assist/sites/s1/connectors',
    'PATCH /assist/sites/s1/connectors/c1/operations/getOrder',
    'GET /assist/sites/s1/action-log',
    'GET /assist/sites/s1/learning/admin/queue',
    'POST /assist/sites/s1/admin-chat',
  ]
);
await assert.rejects(api.get('a/b'));
await assert.rejects(api.patchOperation('s1', 'c1', '../x', {}));
console.log('admin-mode-api: ok');
