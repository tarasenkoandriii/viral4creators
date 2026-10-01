import assert from 'node:assert/strict';
import {
  expiresSoon,
  hostView,
  parseHostStatus,
  parseVerifyMethod,
  pendingForBatch,
} from '../src/kit/verification';
import { parseAccountInfo, parseHost, parseSite } from '../src/kit/sites-api';

const NOW = new Date('2026-10-01T12:00:00Z');
const base = { status: 'pending' as const, expiresAt: null, lastCheck: null };

// Строгий разбор статуса ядра: только четыре значения.
for (const s of ['pending', 'verified', 'expired', 'revoked']) {
  assert.equal(parseHostStatus(s), s);
}
assert.equal(parseHostStatus('VERIFIED'), null);
assert.equal(parseHostStatus('verified '), null);
assert.equal(parseHostStatus(undefined), null);
assert.equal(parseHostStatus(1), null);
assert.equal(parseVerifyMethod('dns'), 'dns');
assert.equal(parseVerifyMethod('txt'), null);

// Вид для человека.
assert.equal(hostView(base, NOW), 'pending');
assert.equal(hostView({ ...base, lastCheck: { ok: false } }, NOW), 'failed');
assert.equal(hostView({ ...base, lastCheck: { ok: true } }, NOW), 'pending');
assert.equal(
  hostView(
    { ...base, status: 'verified', expiresAt: '2026-12-30T00:00:00Z' },
    NOW
  ),
  'verified'
);
// verified без даты — verified (сервер не прислал срок; не выдумываем истечение).
assert.equal(hostView({ ...base, status: 'verified' }, NOW), 'verified');
// Истёкший по дате, но крон ещё не перевёл — уже «истёк», без зелёной галочки.
assert.equal(
  hostView(
    { ...base, status: 'verified', expiresAt: '2026-10-01T11:59:59Z' },
    NOW
  ),
  'expired'
);
assert.equal(
  hostView(
    { ...base, status: 'verified', expiresAt: '2026-10-01T12:00:00Z' },
    NOW
  ),
  'expired'
);
assert.equal(hostView({ ...base, status: 'expired' }, NOW), 'expired');
assert.equal(hostView({ ...base, status: 'revoked' }, NOW), 'revoked');
// revoked с «удачной» проверкой — всё равно revoked.
assert.equal(
  hostView({ ...base, status: 'revoked', lastCheck: { ok: true } }, NOW),
  'revoked'
);
// Неизвестный статус никогда не становится verified.
assert.equal(hostView({ ...base, status: null }, NOW), 'pending');

// «Истекает скоро» — 14 дней по умолчанию.
assert.equal(
  expiresSoon({ status: 'verified', expiresAt: '2026-10-10T00:00:00Z' }, NOW),
  true
);
assert.equal(
  expiresSoon({ status: 'verified', expiresAt: '2026-12-10T00:00:00Z' }, NOW),
  false
);
assert.equal(
  expiresSoon({ status: 'verified', expiresAt: '2026-09-10T00:00:00Z' }, NOW),
  false
);
assert.equal(
  expiresSoon({ status: 'pending', expiresAt: '2026-10-10T00:00:00Z' }, NOW),
  false
);
assert.equal(
  expiresSoon({ status: 'verified', expiresAt: 'мусор' }, NOW),
  false
);

// Пакет «Проверить все»: pending/failed/expired — да; verified/revoked — нет.
const hosts = [
  { id: 'a', ...base },
  { id: 'b', ...base, lastCheck: { ok: false } },
  { id: 'c', ...base, status: 'expired' as const },
  {
    id: 'd',
    ...base,
    status: 'verified' as const,
    expiresAt: '2026-12-01T00:00:00Z',
  },
  { id: 'e', ...base, status: 'revoked' as const },
  {
    id: 'f',
    ...base,
    status: 'verified' as const,
    expiresAt: '2026-09-01T00:00:00Z',
  },
];
assert.deepEqual(
  pendingForBatch(hosts, NOW).map((h) => h.id),
  ['a', 'b', 'c', 'f']
);

// Разбор ответа сервера: неизвестный статус → pending, порт по умолчанию 443.
const h = parseHost({
  id: 'h1',
  siteId: 's1',
  host: 'example.com',
  status: 'ok',
});
assert.equal(h.status, 'pending');
assert.equal(h.port, 443);
assert.equal(h.publicPlatform, false);
assert.equal(h.lastCheck, null);
const h2 = parseHost({
  id: 'h2',
  host: 'x.com',
  status: 'verified',
  method: 'file',
  expiresAt: '2026-12-30T00:00:00Z',
  publicPlatform: true,
  lastCheck: { ok: false, message: 'нет файла' },
});
assert.equal(h2.status, 'verified');
assert.equal(h2.method, 'file');
assert.equal(h2.publicPlatform, true);
assert.deepEqual(h2.lastCheck, {
  ok: false,
  code: undefined,
  message: 'нет файла',
  at: undefined,
});
assert.equal(
  parseSite({ id: 's', name: 'X', hosts: [{}, {}] }).hosts.length,
  2
);
assert.equal(parseSite({ id: 's', name: 'X' }).hosts.length, 0);

// Кабинет: роли — только из белого списка; members нет → `null` (сервер
// список не показал — экран покажет себя и пояснение), не «пусто».
const acc = parseAccountInfo({
  account: {
    id: 'a1',
    type: 'agency',
    region: 'UA',
    verifyToken: 'tok_12345678',
  },
  me: {
    telegramId: '42',
    role: 'owner',
    productRoles: { assist: 'manager', qa: 'root' },
  },
  created: true,
});
assert.equal(acc.account.type, 'agency');
assert.equal(acc.account.verifyToken, 'tok_12345678');
assert.equal(acc.me.role, 'owner');
assert.equal(acc.me.productRoles.assist, 'manager');
assert.equal(acc.me.productRoles.qa, 'none');
assert.equal(acc.me.productRoles.assistAdmin, 'none');
assert.equal(acc.members, null);
assert.equal(acc.created, true);
// Неизвестная роль кабинета — наименьшая (operator), не owner.
assert.equal(
  parseAccountInfo({ me: { role: 'superuser' } }).me.role,
  'operator'
);
assert.equal(parseAccountInfo({}).created, false);

console.log('host-status: ok');
