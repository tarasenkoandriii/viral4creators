/**
 * Э7: клиент «Админки» TMA — строгий разбор (неизвестное → умолчание,
 * секрета в виде нет) и адреса маршрутов (§4.16: admin-mode, connectors,
 * action-log, learning/admin, admin-chat).
 */
import assert from 'node:assert/strict';
import {
  createAdminModeApi,
  parseActionStats,
  parseAdminMode,
  parseConnector,
} from '../src/lib/admin-mode-api';
import { ADMIN_MODE_TEXTS } from '../src/i18n/admin-mode';

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
// Заход 9 — Р-З9-18: перевыпуск секрета с выпуском, который видит экран;
// аудит Э8 (5): язык карточек state; Э8-хвост (6): блок «Действия» строго.
calls.length = 0;
await api.issueIdentitySecret('s1', '2026-10-03T00:00:00.000Z');
await api.issueIdentitySecret('s1', null);
await api.issueIdentitySecret('s1');
await api.chatState('s1', 'ru');
await api.chatState('s1', 'ru&x=1');
await api.chatState('s1');
assert.deepEqual(
  calls.map(([mth, p, b]) => `${mth} ${p} ${JSON.stringify(b) ?? '-'}`),
  [
    'POST /assist/sites/s1/admin-mode/identity-secret {"expectedSetAt":"2026-10-03T00:00:00.000Z"}',
    'POST /assist/sites/s1/admin-mode/identity-secret {"expectedSetAt":null}',
    'POST /assist/sites/s1/admin-mode/identity-secret -',
    'GET /assist/sites/s1/admin-chat/state?lang=ru -',
    'GET /assist/sites/s1/admin-chat/state -',
    'GET /assist/sites/s1/admin-chat/state -',
  ]
);
const a = parseActionStats({
  proposed: 5,
  confirmed: 3,
  yesShare: 7,
  unknownShare: 0.25,
  compensations: { proposed: 2, successRate: -1, alert: 'yes' },
  byOperation: [
    { operation: 'shop.x', proposed: 2, confirmed: 1, done: 1, unknown: 0 },
    { proposed: 9 },
  ],
  secret: 'LEAK',
});
assert.equal(a.proposed, 5);
assert.equal(a.yesShare, null, 'доля вне 0..1 — null');
assert.equal(a.unknownShare, 0.25);
assert.equal(a.compensations.successRate, null);
assert.equal(a.compensations.alert, false, 'только true — тревога');
assert.deepEqual(
  a.byOperation.map((o) => o.operation),
  ['shop.x'],
  'строка без операции отброшена'
);
assert.equal(JSON.stringify(a).includes('LEAK'), false);
assert.equal(parseActionStats(undefined).proposed, 0);
// Тексты «Админки» — одинаковые ключи на трёх языках (вкл. новые).
const keysOf = (o: object): string[] =>
  Object.entries(o)
    .flatMap(([k, v]) =>
      v && typeof v === 'object' ? keysOf(v).map((x) => `${k}.${x}`) : [k]
    )
    .sort();
const ukKeys = keysOf(ADMIN_MODE_TEXTS.uk);
for (const l of ['ru', 'en'] as const)
  assert.deepEqual(keysOf(ADMIN_MODE_TEXTS[l]), ukKeys, l);
for (const l of ['uk', 'ru', 'en'] as const) {
  assert.ok(ADMIN_MODE_TEXTS[l].settings.secretChanged, l);
  assert.ok(
    /data-identity-endpoint/.test(ADMIN_MODE_TEXTS[l].settings.jwtAdvice),
    l
  );
  assert.ok(/X-V4C-Actor/.test(ADMIN_MODE_TEXTS[l].settings.jwtAdvice), l);
}
// Р-З9-14 / Р-З9-17: флаги — только true включает; PATCH коннектора.
assert.equal(parseAdminMode({}).testKeyConnectors, false);
assert.equal(
  parseAdminMode({ testKeyConnectors: 'yes' }).testKeyConnectors,
  false
);
assert.equal(
  parseAdminMode({ testKeyConnectors: true }).testKeyConnectors,
  true
);
assert.equal(parseConnector({ id: 'c1' }).maskPd, false);
assert.equal(parseConnector({ id: 'c1', maskPd: true }).maskPd, true);
calls.length = 0;
await api.patchConnector('s1', 'c1', { maskPd: true });
await api.patch('s1', { testKeyConnectors: true });
assert.deepEqual(
  calls.map(([mth, p, b]) => `${mth} ${p} ${JSON.stringify(b)}`),
  [
    'PATCH /assist/sites/s1/connectors/c1 {"maskPd":true}',
    'PATCH /assist/sites/s1/admin-mode {"testKeyConnectors":true}',
  ]
);
await assert.rejects(api.patchConnector('s1', 'c/1', { maskPd: false }));
await assert.rejects(api.get('a/b'));
await assert.rejects(api.patchOperation('s1', 'c1', '../x', {}));
console.log('admin-mode-api: ok');
