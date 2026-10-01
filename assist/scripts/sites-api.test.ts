import assert from 'node:assert/strict';
import { createApiClient } from '../src/kit/api-client';
import {
  createSitesApi,
  parseChallenge,
  parseHost,
  parseInstruction,
} from '../src/kit/sites-api';
import { pendingForBatch } from '../src/kit/verification';

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz012_-9';

// ── Хост: поля ядра Э0 ────────────────────────────────────────────────
const h = parseHost({
  id: 'h1',
  siteId: 's1',
  host: 'example.com',
  status: 'revoked',
  lastRecheckAt: '2026-10-01T00:00:00.000Z',
  reverifyBlocked: true,
  lastCheck: { ok: false, code: 'DNS_NOT_FOUND', message: 'm', at: 'x' },
});
assert.equal(h.lastRecheckAt, '2026-10-01T00:00:00.000Z');
assert.equal(h.reverifyBlocked, true);
assert.equal(h.lastCheck?.code, 'DNS_NOT_FOUND');
// Строго true — «1»/«yes» блокировкой не считаются.
assert.equal(parseHost({ reverifyBlocked: 'true' }).reverifyBlocked, false);
assert.equal(parseHost({}).lastRecheckAt, null);
// Заблокированный хост не попадает в «Проверить все» и TXT-пакет.
const now = new Date('2026-10-01T00:00:00Z');
assert.deepEqual(
  pendingForBatch(
    [
      { ...parseHost({ id: 'a', status: 'pending' }) },
      { ...parseHost({ id: 'b', status: 'expired', reverifyBlocked: true }) },
    ],
    now
  ).map((x) => x.id),
  ['a']
);

// ── challenge → { token, method, instruction } ────────────────────────
const dns = {
  method: 'dns',
  recordType: 'TXT',
  name: '_v4c-verify.example.com',
  value: `v4c-verify=${TOKEN}`,
};
assert.deepEqual(
  parseChallenge({ token: TOKEN, method: 'dns', instruction: dns }, 'dns'),
  {
    token: TOKEN,
    method: 'dns',
    instruction: dns,
  }
);
// Инструкция другого способа — не берём (экран построит свою).
assert.equal(
  parseChallenge({ token: TOKEN, instruction: dns }, 'file').instruction,
  null
);
// Токен вне формата — ни токена, ни инструкции.
assert.deepEqual(parseChallenge({ token: 'a"><b', instruction: dns }, 'dns'), {
  token: null,
  method: 'dns',
  instruction: null,
});
assert.deepEqual(
  parseInstruction(
    { method: 'file', url: 'https://e.com/f', content: TOKEN },
    'file'
  ),
  { method: 'file', url: 'https://e.com/f', content: TOKEN }
);
assert.equal(parseInstruction({ method: 'meta', tag: 'x' }, 'meta'), null);
assert.equal(parseInstruction({ ...dns, recordType: 'CNAME' }, 'dns'), null);

// ── Маршруты на подменённом fetch ─────────────────────────────────────
type Init = { method: string; body?: string };
const calls: Array<{ url: string; init: Init }> = [];
let data: unknown = null;
const api = createSitesApi(
  createApiClient({
    baseUrl: '/api',
    auth: () => ({ headers: {}, credentials: 'same-origin' }),
    locale: () => 'ru',
    fetchImpl: (async (url: string, init: Init) => {
      calls.push({ url, init });
      return {
        status: 200,
        text: async () => JSON.stringify({ success: true, data }),
      };
    }) as unknown as typeof fetch,
  })
);
const last = () => calls[calls.length - 1];

data = { deleted: true };
assert.deepEqual(await api.deleteHost('s1', 'h1'), { deleted: true });
assert.equal(last().url, '/api/sites/s1/hosts/h1');
assert.equal(last().init.method, 'DELETE');

data = { token: TOKEN, method: 'dns', instruction: dns };
assert.equal((await api.challenge('h1', 'dns')).instruction?.method, 'dns');
assert.equal(last().url, '/api/sites/hosts/h1/challenge');
assert.equal(last().init.body, '{"method":"dns"}');

// verify отдаёт message и при успехе.
data = {
  host: { id: 'h1', status: 'verified' },
  ok: true,
  message: 'Владение подтверждено',
};
const v = await api.verify('h1', 'meta');
assert.equal(v.ok, true);
assert.equal(v.message, 'Владение подтверждено');
assert.equal(last().url, '/api/sites/hosts/h1/verify');

data = { results: [{ host: { id: 'h1' }, ok: false, code: 'NETWORK_ERROR' }] };
assert.equal((await api.verifyAll('s1'))[0].code, 'NETWORK_ERROR');
assert.equal(last().url, '/api/sites/s1/verify-all');

data = { token: TOKEN, startParam: `inv_${TOKEN}`, expiresAt: null };
await api.createInvite('manager', { assist: 'manager' });
assert.equal(last().url, '/api/sites/account/invites');
assert.deepEqual(JSON.parse(last().init.body!), {
  role: 'manager',
  productRoles: { assist: 'manager' },
});
await api.createInvite('operator');
assert.deepEqual(JSON.parse(last().init.body!), { role: 'operator' });

data = { account: { id: 'a9' }, me: { role: 'operator' }, accounts: [] };
assert.equal((await api.acceptInvite(TOKEN)).account.id, 'a9');
assert.equal(last().url, '/api/sites/account/invites/accept');
assert.deepEqual(JSON.parse(last().init.body!), { token: TOKEN });

data = {
  host: { id: 'h1', status: 'verified' },
  others: [
    { hostId: 'x1', status: 'verified', method: 'dns', reverifyBlocked: false },
    { hostId: 'x2', status: 'weird', reverifyBlocked: true },
  ],
};
const auths = await api.authorizations('h1');
assert.equal(last().url, '/api/sites/hosts/h1/authorizations');
assert.equal(last().init.method, 'GET');
assert.equal(auths.others.length, 2);
assert.equal(auths.others[1].status, 'pending'); // неизвестный → не verified
assert.equal(auths.others[1].reverifyBlocked, true);

data = {
  revoked: 1,
  foreignMarkers: {
    dnsName: '_v4c-verify.example.com',
    dns: ['v4c-verify=OTHER', 5],
    file: null,
    hint: 'по-русски',
  },
};
const r = await api.revokeForeign('h1');
assert.equal(last().url, '/api/sites/hosts/h1/authorizations/revoke');
assert.equal(last().init.method, 'POST');
assert.deepEqual(r, {
  revoked: 1,
  foreignMarkers: {
    dnsName: '_v4c-verify.example.com',
    dns: ['v4c-verify=OTHER'],
    file: null,
  },
});

data = { unblocked: true };
assert.deepEqual(await api.unblockForeign('h1', 'x/2'), { unblocked: true });
assert.equal(last().url, '/api/sites/hosts/h1/authorizations/x%2F2/unblock');

console.log('sites-api: ok');
