import assert from 'node:assert/strict';
import type { Site, SiteHost } from '../src/kit';
import { verifyHostPlan } from '../src/lib/verify-host-view';

// Ш1-хвост: куда вести человека по ссылке «подтвердить этот хост».
const host = (over: Partial<SiteHost>): SiteHost => ({
  id: 'h1',
  siteId: 's1',
  scheme: 'https',
  host: 'shop.example.com',
  port: 443,
  status: 'pending',
  method: null,
  verifiedAt: null,
  expiresAt: null,
  revokedAt: null,
  publicPlatform: false,
  lastCheck: null,
  lastRecheckAt: null,
  reverifyBlocked: false,
  ...over,
});
const site = (id: string, hosts: SiteHost[], name = `Сайт ${id}`): Site => ({
  id,
  name,
  hosts,
});

// Хост заведён (pending) — экран подтверждения ЭТОГО хоста.
assert.deepEqual(
  verifyHostPlan(
    [
      site('s0', [host({ id: 'h0', siteId: 's0', host: 'other.example.com' })]),
      site('s1', [host({ id: 'h1' })]),
    ],
    'shop.example.com'
  ),
  { kind: 'open', siteId: 's1', hostId: 'h1', verified: false }
);
// Подтверждённый у одного из сайтов — он важнее неподтверждённого.
assert.deepEqual(
  verifyHostPlan(
    [
      site('s1', [host({ id: 'h1' })]),
      site('s2', [host({ id: 'h2', siteId: 's2', status: 'verified' })]),
    ],
    'shop.example.com'
  ),
  { kind: 'open', siteId: 's2', hostId: 'h2', verified: true }
);
// Точное совпадение: www, поддомен, другой порт, отозванный — не тот хост.
const near = [
  site('s1', [
    host({ id: 'a', host: 'www.shop.example.com' }),
    host({ id: 'b', host: 'example.com' }),
    host({ id: 'c', port: 8443 }),
    host({ id: 'd', revokedAt: '2026-10-01T00:00:00Z' }),
  ]),
];
assert.deepEqual(verifyHostPlan(near, 'shop.example.com'), {
  kind: 'add',
  sites: [{ id: 's1', name: 'Сайт s1' }],
});
// Сайтов нет — мастер нового сайта с этим хостом.
assert.deepEqual(verifyHostPlan([], 'shop.example.com'), { kind: 'create' });

console.log('verify-host: ok');
