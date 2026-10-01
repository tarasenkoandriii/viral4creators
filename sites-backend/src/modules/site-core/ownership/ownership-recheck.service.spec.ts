import { Logger } from '@nestjs/common';
import { FakeNet } from '../testing/fake-net.testing';
import { FakeStore } from '../testing/fake-sites-db.testing';
import { OwnershipRecheckService } from './ownership-recheck.service';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-01T04:17:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const ahead = (ms: number) => new Date(NOW.getTime() + ms);

interface HostRow {
  id: string;
  status: string;
  revokedAt: Date | null;
  lastRecheckAt: Date | null;
  expiresAt: Date | null;
  lastCheck: { ok: boolean; code: string } | null;
}

beforeAll(() => Logger.overrideLogger(false));

function setup() {
  const store = new FakeStore();
  const net = new FakeNet();
  store.insert('SiteAccount', { id: 'A', verifyToken: 'tokA' });
  store.insert('SiteAccount', { id: 'B', verifyToken: 'tokB' });
  store.insert('Site', { id: 'sa', accountId: 'A', name: 'A' });
  store.insert('Site', { id: 'sb', accountId: 'B', name: 'B' });
  const host = (id: string, acc: 'A' | 'B', host: string, extra = {}) =>
    store.insert('SiteHost', {
      id,
      accountId: acc,
      siteId: acc === 'A' ? 'sa' : 'sb',
      host,
      status: 'verified',
      method: 'dns',
      verifiedAt: ago(10 * DAY),
      expiresAt: ahead(80 * DAY),
      ...extra,
    });
  host('ok', 'A', 'ok.example.com');
  host('gone', 'A', 'gone.example.com');
  host('flaky', 'B', 'flaky.example.com');
  host('old', 'B', 'old.example.com', { expiresAt: ago(1) });
  host('file', 'B', 'file.example.com', { method: 'file' });
  host('pending', 'A', 'pending.example.com', {
    status: 'pending',
    method: null,
    expiresAt: null,
  });
  net.txt('_v4c-verify.ok.example.com', 'v4c-verify=tokA');
  // У «gone» запись пропала у обоих резолверов; у «flaky» — разошлись.
  net.zones.r1.set('_v4c-verify.flaky.example.com', ['v4c-verify=tokB']);
  net.zones.r2.set('_v4c-verify.flaky.example.com', []);
  // Файл хоста B на месте, но с токеном кабинета A — не его.
  net.page('https://file.example.com/.well-known/v4c-verify.txt', {
    status: 200,
    body: 'tokA',
  });
  const svc = new OwnershipRecheckService(store.sitesDb(), net.checker());
  const byId = (id: string) =>
    store.rows<HostRow>('SiteHost').find((h) => h.id === id) as HostRow;
  return { store, net, svc, byId };
}

describe('крон site-ownership-recheck', () => {
  it('обновляет статусы: expired по сроку, revoked при пропаже, остальное не трогает', async () => {
    const { svc, byId } = setup();
    const r = await svc.run(NOW);
    expect(r).toMatchObject({
      expired: 1,
      checked: 4,
      stillVerified: 1,
      revoked: 2,
      inconclusive: 1,
      deferred: 0,
    });
    expect(r.revokedHostIds.sort()).toEqual(['file', 'gone']);
    expect(byId('ok')).toMatchObject({
      status: 'verified',
      lastRecheckAt: NOW,
    });
    expect(byId('gone')).toMatchObject({ status: 'revoked', revokedAt: NOW });
    expect(byId('file')).toMatchObject({
      status: 'revoked',
      lastCheck: { ok: false, code: 'TOKEN_MISMATCH' },
    });
    expect(byId('flaky')).toMatchObject({
      status: 'verified',
      lastCheck: { ok: false, code: 'DNS_RESOLVERS_DISAGREE' },
    });
    expect(byId('old').status).toBe('expired');
    expect(byId('pending').status).toBe('pending');
  });

  it('перепроверка не продлевает 90 дней', async () => {
    const { svc, byId } = setup();
    const before = byId('ok').expiresAt;
    await svc.run(NOW);
    expect(byId('ok').expiresAt).toEqual(before);
  });

  it('не требует контекста пользователя: только SitesDb.system(причина)', async () => {
    const { store, svc } = setup();
    await svc.run(NOW);
    const modes = new Set(store.calls.map((c) => c.mode));
    expect([...modes]).toEqual(['system']);
    expect(
      store.calls.every((c) => /site-ownership-recheck/.test(c.reason ?? '')),
    ).toBe(true);
  });

  it('проверяет токеном кабинета-ВЛАДЕЛЬЦА строки, а не чьим-то ещё', async () => {
    const { net, svc, byId } = setup();
    // Хост A, запись с токеном B — у A подтверждения нет.
    net.txt('_v4c-verify.ok.example.com', 'v4c-verify=tokB');
    await svc.run(NOW);
    expect(byId('ok').status).toBe('revoked');
  });

  it('бюджет времени: остаток откладывается, статус не меняется', async () => {
    const { svc, byId } = setup();
    let t = 0;
    const r = await svc.run(NOW, () => (t += 1000), 1500);
    expect(r.deferred).toBeGreaterThan(0);
    expect(r.checked + r.deferred).toBe(4);
    expect(['verified', 'revoked']).toContain(byId('ok').status);
  });

  it('давно не проверенные — первыми', async () => {
    const { store, svc } = setup();
    store.rows<HostRow>('SiteHost').forEach((h) => {
      h.lastRecheckAt = h.id === 'gone' ? null : ago(DAY);
    });
    const seen: string[] = [];
    const exec = store.exec.bind(store);
    store.exec = (model, op, args) => {
      const out = exec(model, op, args);
      if (model === 'SiteHost' && op === 'findMany') {
        seen.push(...(out as HostRow[]).map((h) => h.id));
      }
      return out;
    };
    await svc.run(NOW);
    expect(seen[0]).toBe('gone');
  });
});
