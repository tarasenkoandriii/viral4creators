/**
 * Режим A/B обучалки по статусу хоста (П-Т1) и регистрация хоста от имени
 * пользователя генератора (Ш1) — на поддельной базе с НАСТОЯЩЕЙ проверкой
 * тенанта и настоящими сервисами ядра.
 */
import { HttpException } from '@nestjs/common';
import { AccountService } from '../site-core/account/account.service';
import { HostAccessService } from '../site-core/ownership/host-access.service';
import type { OwnershipChecker } from '../site-core/ownership/ownership-checker';
import { SitesService } from '../site-core/sites/sites.service';
import { FakeStore } from '../site-core/testing/fake-sites-db.testing';
import {
  InternalSitesService,
  parseTelegramId,
} from './internal-sites.service';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-05T12:00:00Z');
const TG = 4242n;
const URL_ = 'https://shop.example.com/cabinet?x=1';

function codeOf(e: unknown): string | undefined {
  return e instanceof HttpException
    ? (e.getResponse() as { code?: string }).code
    : undefined;
}

function setup() {
  const store = new FakeStore();
  let tick = 0;
  store.now = () => new Date(NOW.getTime() - 3600_000 + ++tick * 1000);
  const db = store.sitesDb();
  const accounts = new AccountService(db);
  const sites = new SitesService(db, {} as OwnershipChecker);
  const svc = new InternalSitesService(
    db,
    accounts,
    new HostAccessService(db),
    sites,
  );
  /** Кабинет `acc` с участником TG в роли `role` и хостом в статусе. */
  const seed = (
    acc: string,
    role: 'owner' | 'manager' | 'operator' | null,
    host: Record<string, unknown> | null,
    telegramId = TG,
  ) => {
    store.insert('SiteAccount', { id: acc, verifyToken: `t-${acc}` });
    if (role) {
      store.insert('SiteAccountMember', {
        accountId: acc,
        telegramId,
        role,
        productRoles: {},
      });
    }
    store.insert('Site', { id: `s-${acc}`, accountId: acc, name: 'Магазин' });
    if (host) {
      store.insert('SiteHost', {
        id: `h-${acc}`,
        accountId: acc,
        siteId: `s-${acc}`,
        host: 'shop.example.com',
        ...host,
      });
    }
  };
  const verified = {
    status: 'verified',
    verifiedAt: new Date(NOW.getTime() - DAY),
    expiresAt: new Date(NOW.getTime() + 30 * DAY),
  };
  return { store, svc, seed, verified };
}

describe('InternalSitesService.hostStatus — режим A/B (П-Т1)', () => {
  it('нет кабинета — B, no_account; кабинет НЕ создаётся', async () => {
    const { store, svc } = setup();
    await expect(svc.hostStatus(TG, URL_, NOW)).resolves.toMatchObject({
      mode: 'B',
      host: 'shop.example.com',
      registrableDomain: 'example.com',
      hostId: null,
      status: 'none',
      reason: 'no_account',
    });
    expect(store.rows('SiteAccount')).toHaveLength(0);
  });

  it('хост подтверждён в кабинете, где человек владелец, — A', async () => {
    const { svc, seed, verified } = setup();
    seed('A1', 'owner', verified);
    await expect(svc.hostStatus(TG, URL_, NOW)).resolves.toMatchObject({
      mode: 'A',
      hostId: 'h-A1',
      status: 'verified',
      reason: null,
      optedOut: false,
    });
  });

  it('менеджер — тоже A', async () => {
    const { svc, seed, verified } = setup();
    seed('A1', 'manager', verified);
    expect((await svc.hostStatus(TG, URL_, NOW)).mode).toBe('A');
  });

  it('оператор кабинета — B (role): водить браузер от имени владельца ему не давали', async () => {
    const { svc, seed, verified } = setup();
    seed('A1', 'operator', verified);
    await expect(svc.hostStatus(TG, URL_, NOW)).resolves.toMatchObject({
      mode: 'B',
      reason: 'role',
    });
  });

  it.each([
    ['pending', { status: 'pending' }, 'not_verified'],
    [
      'истёк (verified с прошедшим сроком)',
      { status: 'verified', expiresAt: new Date(NOW.getTime() - 1) },
      'expired',
    ],
    [
      'отозван 1 ч назад — без льготы 72 ч',
      {
        status: 'revoked',
        revokedAt: new Date(NOW.getTime() - 3600_000),
        expiresAt: new Date(NOW.getTime() + DAY),
      },
      'revoked',
    ],
  ])('%s — B', async (_n, host, reason) => {
    const { svc, seed } = setup();
    seed('A1', 'owner', host);
    await expect(svc.hostStatus(TG, URL_, NOW)).resolves.toMatchObject({
      mode: 'B',
      hostId: 'h-A1',
      reason,
    });
  });

  it('подтверждение ЧУЖОГО кабинета не даёт A (и не светит его хост)', async () => {
    const { svc, seed, verified } = setup();
    seed('OTHER', 'owner', verified, 777n);
    seed('MINE', 'owner', null);
    await expect(svc.hostStatus(TG, URL_, NOW)).resolves.toMatchObject({
      mode: 'B',
      hostId: null,
      reason: 'not_registered',
    });
  });

  it('другой хост того же домена (www) не считается: подтверждается хост, не домен', async () => {
    const { svc, seed, verified } = setup();
    seed('A1', 'owner', verified);
    await expect(
      svc.hostStatus(TG, 'https://www.example.com', NOW),
    ).resolves.toMatchObject({ mode: 'B', reason: 'not_registered' });
  });

  it('opt-out домена — B даже у подтвердившего', async () => {
    const { store, svc, seed, verified } = setup();
    seed('A1', 'owner', verified);
    store.insert('SiteOptOutDomain', {
      domain: 'example.com',
      source: 'email',
    });
    await expect(svc.hostStatus(TG, URL_, NOW)).resolves.toMatchObject({
      mode: 'B',
      optedOut: true,
      reason: 'opted_out',
    });
  });

  it('из двух кабинетов A даёт тот, где подтверждено', async () => {
    const { svc, seed, verified } = setup();
    seed('P', 'owner', { status: 'pending' });
    seed('V', 'manager', verified);
    await expect(svc.hostStatus(TG, URL_, NOW)).resolves.toMatchObject({
      mode: 'A',
      hostId: 'h-V',
    });
  });

  it('http/порт/IP — 400 HOST_INVALID (MVP подтверждает только https:443)', async () => {
    const { svc } = setup();
    for (const u of ['http://shop.example.com', 'https://1.2.3.4']) {
      const e = await svc.hostStatus(TG, u, NOW).catch((x: unknown) => x);
      expect(codeOf(e)).toBe('HOST_INVALID');
    }
  });
});

describe('InternalSitesService.registerHost (Ш1)', () => {
  it('нет кабинета — создаётся (как вход в TMA помощника), хост pending, режим B', async () => {
    const { store, svc } = setup();
    const r = await svc.registerHost(TG, URL_, NOW);
    expect(r).toMatchObject({
      mode: 'B',
      status: 'pending',
      reason: 'not_verified',
      created: true,
      accountCreated: true,
    });
    expect(store.rows('SiteAccount')).toHaveLength(1);
    expect(store.rows('SiteAccountMember')).toEqual([
      expect.objectContaining({ telegramId: TG, role: 'owner' }),
    ]);
    expect(store.rows('Site')).toEqual([
      expect.objectContaining({ name: 'example.com' }),
    ]);
    expect(store.rows('SiteHost')).toEqual([
      expect.objectContaining({
        id: r.hostId,
        host: 'shop.example.com',
        status: 'pending',
      }),
    ]);
  });

  it('повтор — тот же хост, без второго сайта и кабинета', async () => {
    const { store, svc } = setup();
    const a = await svc.registerHost(TG, URL_, NOW);
    const b = await svc.registerHost(TG, 'https://shop.example.com/', NOW);
    expect(b).toMatchObject({ hostId: a.hostId, created: false });
    expect(store.rows('SiteHost')).toHaveLength(1);
    expect(store.rows('SiteAccount')).toHaveLength(1);
  });

  it('уже подтверждённый хост — сразу A, ничего не создаётся', async () => {
    const { store, svc, seed, verified } = setup();
    seed('A1', 'owner', verified);
    await expect(svc.registerHost(TG, URL_, NOW)).resolves.toMatchObject({
      mode: 'A',
      hostId: 'h-A1',
      created: false,
    });
    expect(store.rows('SiteHost')).toHaveLength(1);
  });

  it('хост того же регистрируемого домена — в существующий сайт', async () => {
    const { store, svc, seed, verified } = setup();
    seed('A1', 'owner', verified);
    const r = await svc.registerHost(TG, 'https://admin.example.com', NOW);
    expect(r).toMatchObject({ siteId: 's-A1', created: true, mode: 'B' });
    expect(store.rows('Site')).toHaveLength(1);
  });

  it('свой кабинет и менеджер в чужом: хост — в СВОЙ, даже если в чужой добавили позже', async () => {
    const { store, svc, seed } = setup();
    seed('OWN', 'owner', null);
    // Приглашение менеджером пришло позже — в списке членств оно первое.
    seed('CLIENT', 'manager', null);
    const r = await svc.registerHost(TG, URL_, NOW);
    expect(r).toMatchObject({ created: true, accountCreated: false });
    expect(store.rows('SiteHost')).toEqual([
      expect.objectContaining({ accountId: 'OWN', host: 'shop.example.com' }),
    ]);
  });

  it('только менеджер (своего кабинета нет) — в кабинет, где менеджер; новый не создаётся', async () => {
    const { store, svc, seed } = setup();
    seed('CLIENT', 'manager', null);
    const r = await svc.registerHost(TG, URL_, NOW);
    expect(r).toMatchObject({ created: true, accountCreated: false });
    expect(store.rows('SiteAccount')).toHaveLength(1);
    expect(store.rows('SiteHost')[0]).toMatchObject({ accountId: 'CLIENT' });
  });

  it('кабинет, где человек только оператор, — 403 ACCOUNT_ROLE_REQUIRED', async () => {
    const { svc, seed } = setup();
    seed('A1', 'operator', null);
    const e = await svc.registerHost(TG, URL_, NOW).catch((x: unknown) => x);
    expect(codeOf(e)).toBe('ACCOUNT_ROLE_REQUIRED');
  });

  it('домен в opt-out — 403 HOST_OPTED_OUT, хоста нет', async () => {
    const { store, svc } = setup();
    store.insert('SiteOptOutDomain', {
      domain: 'example.com',
      source: 'email',
    });
    const e = await svc.registerHost(TG, URL_, NOW).catch((x: unknown) => x);
    expect(codeOf(e)).toBe('HOST_OPTED_OUT');
    expect(store.rows('SiteHost')).toHaveLength(0);
  });
});

describe('parseTelegramId', () => {
  it('только положительное целое строкой', () => {
    expect(parseTelegramId('123456789')).toBe(123456789n);
    for (const bad of ['dev-123', '0', '-5', '', 123, '1e5', '01']) {
      expect(() => parseTelegramId(bad)).toThrow(HttpException);
    }
  });
});
