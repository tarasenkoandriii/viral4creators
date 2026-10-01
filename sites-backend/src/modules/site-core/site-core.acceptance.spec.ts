/**
 * Приёмка Э0 по ядру (план помощника, Приложение А «Этап 0», «Приёмка
 * Э0») — на сервисах с поддельной базой (настоящая проверка тенанта) и
 * поддельной сетью (настоящие DoH-клиент и SSRF-хопы).
 */

import { HttpException } from '@nestjs/common';
import { AccountService } from './account/account.service';
import type { AccountMembership } from './account/roles';
import type { RequestIdentity } from '../telegram-auth/identity';
import { OwnershipService } from './ownership/ownership.service';
import { OwnershipRecheckService } from './ownership/ownership-recheck.service';
import { HostAccessService } from './ownership/host-access.service';
import { SitesService } from './sites/sites.service';
import { FakeNet } from './testing/fake-net.testing';
import { FakeStore } from './testing/fake-sites-db.testing';

const DAY = 24 * 60 * 60 * 1000;

function identity(telegramId: number, app: 'assist' | 'qa'): RequestIdentity {
  return {
    app,
    telegramId: BigInt(telegramId),
    username: null,
    firstName: null,
    languageCode: null,
  };
}

function codeOf(e: unknown): string | undefined {
  return e instanceof HttpException
    ? (e.getResponse() as { code?: string }).code
    : undefined;
}

async function rejectCode(p: Promise<unknown>): Promise<string | undefined> {
  return p.then(
    () => 'resolved',
    (e) => codeOf(e) ?? String(e),
  );
}

function setup() {
  const store = new FakeStore();
  // Монотонные часы базы: порядок «кто раньше создан» не зависит от
  // того, уложились ли вставки в одну миллисекунду.
  let tick = 0;
  store.now = () => new Date(Date.UTC(2026, 8, 1) + ++tick * 1000);
  const net = new FakeNet();
  const db = store.sitesDb();
  const checker = net.checker();
  const accounts = new AccountService(db);
  const sites = new SitesService(db, checker);
  const ownership = new OwnershipService(db, checker);
  const recheck = new OwnershipRecheckService(db, checker);
  const access = new HostAccessService(db);
  return { store, net, accounts, sites, ownership, recheck, access };
}

async function login(
  s: ReturnType<typeof setup>,
  id: number,
  app: 'assist' | 'qa' = 'assist',
) {
  const { membership, created } = await s.accounts.ensureAccount(
    identity(id, app),
  );
  const info = await s.accounts.accountInfo(membership, created);
  return { m: membership, token: info.account.verifyToken as string, info };
}

describe('Приёмка Э0: кабинет, сайт с двумя хостами, подтверждение', () => {
  it('сквозной сценарий: DNS для apex, файл для поддомена; QA-бот видит то же', async () => {
    const s = setup();
    const { m, token, info } = await login(s, 1001, 'assist');
    expect(info.created).toBe(true);
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(info.me).toMatchObject({ role: 'owner', telegramId: '1001' });

    const site = await s.sites.createSite(m, {
      name: 'Магазин X',
      url: 'https://example.com',
    });
    const shop = await s.sites.addHost(m, site.id, 'shop.example.com');
    const apexId = site.hosts[0].id;

    const ch = await s.ownership.challenge(m, apexId, 'dns');
    expect(ch.instruction).toEqual({
      method: 'dns',
      recordType: 'TXT',
      name: '_v4c-verify.example.com',
      value: `v4c-verify=${token}`,
    });
    s.net.txt('_v4c-verify.example.com', `v4c-verify=${token}`);
    const v1 = await s.ownership.verify(m, apexId, 'dns');
    expect(v1).toMatchObject({ ok: true, host: { status: 'verified' } });

    // Поддомен НЕ подтверждён от подтверждения apex.
    const listed = await s.sites.listSites(m);
    const shopRow = listed[0].hosts.find((h) => h.id === shop.id);
    expect(shopRow?.status).toBe('pending');
    const viaDns = await s.ownership.verify(m, shop.id, 'dns');
    expect(viaDns.ok).toBe(false);

    s.net.page('https://shop.example.com/.well-known/v4c-verify.txt', {
      status: 200,
      body: token,
    });
    const v2 = await s.ownership.verify(m, shop.id, 'file');
    expect(v2).toMatchObject({ ok: true, host: { method: 'file' } });

    // Тот же человек через бот QA — тот же кабинет, те же статусы.
    const qa = await login(s, 1001, 'qa');
    expect(qa.info.created).toBe(false);
    expect(qa.m.accountId).toBe(m.accountId);
    const viaQa = await s.sites.listSites(qa.m);
    expect(viaQa[0].hosts.map((h) => h.status)).toEqual([
      'verified',
      'verified',
    ]);
    expect(s.store.rows('SiteAccount')).toHaveLength(1);
  });

  it('apex и www — разные хосты: подтверждение apex не покрывает www', async () => {
    const s = setup();
    const { m, token } = await login(s, 1);
    const site = await s.sites.createSite(m, { name: 'X', url: 'example.com' });
    const www = await s.sites.addHost(m, site.id, 'www.example.com');
    s.net.txt('_v4c-verify.example.com', `v4c-verify=${token}`);
    await s.ownership.verify(m, site.hosts[0].id, 'dns');
    const r = await s.ownership.verify(m, www.id, 'dns');
    expect(r).toMatchObject({ ok: false, host: { status: 'pending' } });
  });

  it('дубль хоста в кабинете отклоняется (и в другом сайте того же кабинета); другой кабинет — можно', async () => {
    const s = setup();
    const a = await login(s, 1);
    const site1 = await s.sites.createSite(a.m, {
      name: 'X',
      url: 'example.com',
    });
    expect(
      await rejectCode(s.sites.addHost(a.m, site1.id, 'https://EXAMPLE.com/a')),
    ).toBe('HOST_DUPLICATE');
    expect(
      await rejectCode(
        s.sites.createSite(a.m, { name: 'Y', url: 'example.com' }),
      ),
    ).toBe('HOST_DUPLICATE');
    // Сайт «Y» не остался пустым мусором после отказа.
    expect(await s.sites.listSites(a.m)).toHaveLength(1);

    const b = await login(s, 2);
    await expect(
      s.sites.createSite(b.m, { name: 'Z', url: 'example.com' }),
    ).resolves.toMatchObject({ hosts: [{ host: 'example.com' }] });
  });

  it('гонка: уникальный индекс ловит дубль, даже если предпроверка его не увидела', async () => {
    const s = setup();
    const { m } = await login(s, 1);
    const site = await s.sites.createSite(m, {
      name: 'X',
      url: 'a.example.com',
    });
    // Вставка «параллельного запроса» между предпроверкой и insert.
    const realFindFirst = s.store.exec.bind(s.store);
    let injected = false;
    s.store.exec = (model, op, args) => {
      if (!injected && model === 'SiteHost' && op === 'create') {
        injected = true;
        s.store.insert('SiteHost', {
          accountId: m.accountId,
          siteId: site.id,
          host: 'b.example.com',
        });
      }
      return realFindFirst(model, op, args);
    };
    expect(await rejectCode(s.sites.addHost(m, site.id, 'b.example.com'))).toBe(
      'HOST_DUPLICATE',
    );
  });

  it('токен чужого кабинета не подтверждает', async () => {
    const s = setup();
    const a = await login(s, 1);
    const b = await login(s, 2);
    const site = await s.sites.createSite(a.m, {
      name: 'X',
      url: 'example.com',
    });
    s.net.txt('_v4c-verify.example.com', `v4c-verify=${b.token}`);
    s.net.page('https://example.com/.well-known/v4c-verify.txt', {
      status: 200,
      body: b.token,
    });
    for (const method of ['dns', 'file'] as const) {
      const r = await s.ownership.verify(a.m, site.hosts[0].id, method);
      expect(r.ok).toBe(false);
    }
  });

  it('подтверждение кабинета B того же хоста ничего не даёт кабинету A', async () => {
    const s = setup();
    const a = await login(s, 1);
    const b = await login(s, 2);
    const sa = await s.sites.createSite(a.m, { name: 'A', url: 'example.com' });
    const sb = await s.sites.createSite(b.m, { name: 'B', url: 'example.com' });
    s.net.txt('_v4c-verify.example.com', `v4c-verify=${b.token}`);
    await s.ownership.verify(b.m, sb.hosts[0].id, 'dns');
    const aHost = (await s.sites.listSites(a.m))[0].hosts[0];
    expect(aHost.status).toBe('pending');
    expect(
      await rejectCode(
        s.access.assertHostVerified(sa.hosts[0].id, 'assist-crawl'),
      ),
    ).toBe('HOST_NOT_VERIFIED');
  });

  it('хост чужого кабинета по id — «не найден», а не проверка чужого', async () => {
    const s = setup();
    const a = await login(s, 1);
    const b = await login(s, 2);
    const sb = await s.sites.createSite(b.m, { name: 'B', url: 'example.com' });
    expect(
      await rejectCode(s.ownership.verify(a.m, sb.hosts[0].id, 'dns')),
    ).toBe('HOST_NOT_FOUND');
  });

  it('через 90 дней — expired (и в ответе, и кроном)', async () => {
    const s = setup();
    const { m, token } = await login(s, 1);
    const site = await s.sites.createSite(m, { name: 'X', url: 'example.com' });
    const t0 = new Date('2026-10-01T00:00:00Z');
    s.net.txt('_v4c-verify.example.com', `v4c-verify=${token}`);
    const v = await s.ownership.verify(m, site.hosts[0].id, 'dns', t0);
    expect(v.host.expiresAt).toEqual(new Date(t0.getTime() + 90 * DAY));

    const later = new Date(t0.getTime() + 90 * DAY + 1);
    expect((await s.sites.listSites(m, later))[0].hosts[0].status).toBe(
      'expired',
    );
    const res = await s.recheck.run(later);
    expect(res.expired).toBe(1);
    expect(s.store.rows<{ status: string }>('SiteHost')[0].status).toBe(
      'expired',
    );
  });

  it('публичная платформа — только DNS', async () => {
    const s = setup();
    const { m } = await login(s, 1);
    const site = await s.sites.createSite(m, {
      name: 'X',
      url: 'shop.myshopify.com',
    });
    expect(site.hosts[0].publicPlatform).toBe(true);
    expect(
      await rejectCode(s.ownership.challenge(m, site.hosts[0].id, 'file')),
    ).toBe('METHOD_NOT_ALLOWED');
    expect(
      await rejectCode(s.ownership.verify(m, site.hosts[0].id, 'meta')),
    ).toBe('METHOD_NOT_ALLOWED');
    await expect(
      s.ownership.challenge(m, site.hosts[0].id, 'dns'),
    ).resolves.toMatchObject({ method: 'dns' });
  });

  it('opt-out домена: добавить хост нельзя', async () => {
    const s = setup();
    const { m } = await login(s, 1);
    s.store.insert('SiteOptOutDomain', {
      domain: 'example.com',
      source: 'email',
    });
    expect(
      await rejectCode(
        s.sites.createSite(m, { name: 'X', url: 'shop.example.com' }),
      ),
    ).toBe('HOST_OPTED_OUT');
  });

  it('пакетная проверка: все неподтверждённые хосты сайта, своим способом', async () => {
    const s = setup();
    const { m, token } = await login(s, 1);
    const site = await s.sites.createSite(m, { name: 'X', url: 'example.com' });
    const shop = await s.sites.addHost(m, site.id, 'shop.example.com');
    const blog = await s.sites.addHost(m, site.id, 'blog.example.com');
    await s.ownership.challenge(m, shop.id, 'meta');
    s.net.txt('_v4c-verify.example.com', `v4c-verify=${token}`);
    s.net.page('https://shop.example.com/', {
      status: 200,
      body: `<meta name="v4c-verify" content="${token}">`,
    });
    const { results } = await s.ownership.verifyAll(m, site.id);
    expect(results.map((r) => [r.host.host, r.ok, r.host.method])).toEqual([
      ['example.com', true, 'dns'],
      ['shop.example.com', true, 'meta'],
      ['blog.example.com', false, null],
    ]);
    expect(results[2].code).toBe('DNS_NOT_FOUND');
    // Повторный прогон не трогает уже подтверждённые.
    const again = await s.ownership.verifyAll(m, site.id);
    expect(again.results.map((r) => r.host.id)).toEqual([blog.id]);
  });

  it('неудачная ручная проверка не снимает подтверждение и пишет lastCheck', async () => {
    const s = setup();
    const { m, token } = await login(s, 1);
    const site = await s.sites.createSite(m, { name: 'X', url: 'example.com' });
    s.net.txt('_v4c-verify.example.com', `v4c-verify=${token}`);
    await s.ownership.verify(m, site.hosts[0].id, 'dns');
    s.net.down.add('r2');
    const r = await s.ownership.verify(m, site.hosts[0].id, 'dns');
    expect(r).toMatchObject({
      ok: false,
      code: 'DNS_UNAVAILABLE',
      host: {
        status: 'verified',
        lastCheck: { ok: false, code: 'DNS_UNAVAILABLE' },
      },
    });
  });
});

describe('отзыв чужих авторизаций и блокировка', () => {
  async function twoAccounts() {
    const s = setup();
    const a = await login(s, 1);
    const b = await login(s, 2);
    const sa = await s.sites.createSite(a.m, { name: 'A', url: 'example.com' });
    const sb = await s.sites.createSite(b.m, { name: 'B', url: 'example.com' });
    s.net.txt(
      '_v4c-verify.example.com',
      `v4c-verify=${a.token}`,
      `v4c-verify=${b.token}`,
    );
    await s.ownership.verify(a.m, sa.hosts[0].id, 'dns');
    await s.ownership.verify(b.m, sb.hosts[0].id, 'dns');
    return { s, a, b, aHost: sa.hosts[0].id, bHost: sb.hosts[0].id };
  }

  it('подтвердивший видит чужих и отзывает; чужой TXT показан; повтор заблокирован', async () => {
    const { s, a, b, aHost, bHost } = await twoAccounts();
    const auth = await s.ownership.authorizations(a.m, aHost);
    expect(auth.others).toEqual([
      expect.objectContaining({ hostId: bHost, status: 'verified' }),
    ]);

    const res = await s.ownership.revokeForeign(a.m, aHost);
    expect(res.revoked).toBe(1);
    expect(res.foreignMarkers.dns).toEqual([`v4c-verify=${b.token}`]);

    // Токен B всё ещё в DNS, но повторное подтверждение заблокировано.
    expect(await rejectCode(s.ownership.verify(b.m, bHost, 'dns'))).toBe(
      'REVERIFY_BLOCKED',
    );
    expect(await rejectCode(s.ownership.challenge(b.m, bHost, 'dns'))).toBe(
      'REVERIFY_BLOCKED',
    );
    // И удалить-добавить заново нельзя.
    const siteB = (await s.sites.listSites(b.m))[0];
    expect(await rejectCode(s.sites.deleteHost(b.m, siteB.id, bHost))).toBe(
      'HOST_BLOCKED',
    );
    // Виджету B льготы нет: его выдворил владелец.
    expect(
      await rejectCode(s.access.assertHostVerified(bHost, 'assist-widget')),
    ).toBe('HOST_NOT_VERIFIED');

    await s.ownership.unblockForeign(a.m, aHost, bHost);
    await expect(s.ownership.verify(b.m, bHost, 'dns')).resolves.toMatchObject({
      ok: true,
    });
  });

  it('отзыв, пришедший во время проверки, не перетирается её успехом (гонка)', async () => {
    // Аудит Э0: B жмёт «Проверить» (токен B ещё в DNS), проверка идёт по
    // сети, и в это время A отзывает чужих. Безусловный UPDATE в persist
    // вернул бы B `verified` поверх `revoked` + блокировки.
    const { s, a, b, aHost, bHost } = await twoAccounts();
    const base = s.net.checker();
    const racy = Object.create(base) as typeof base;
    racy.check = async (...args: Parameters<typeof base.check>) => {
      const r = await base.check(...args);
      await s.ownership.revokeForeign(a.m, aHost);
      return r;
    };
    const ownershipB = new OwnershipService(s.store.sitesDb(), racy);

    expect(await rejectCode(ownershipB.verify(b.m, bHost, 'dns'))).toBe(
      'REVERIFY_BLOCKED',
    );
    const siteB = (await s.sites.listSites(b.m))[0];
    expect(siteB.hosts[0]).toMatchObject({
      status: 'revoked',
      reverifyBlocked: true,
    });
    for (const p of ['assist-crawl', 'assist-admin', 'qa-l1'] as const) {
      expect(await rejectCode(s.access.assertHostVerified(bHost, p))).toBe(
        'HOST_NOT_VERIFIED',
      );
    }
  });

  it('пакетная проверка: хост, заблокированный во время проверки, выпадает, остальные — в итогах', async () => {
    const { s, a, b, aHost, bHost } = await twoAccounts();
    // У B второй хост — без чужих подтверждений.
    const siteB = (await s.sites.listSites(b.m))[0];
    const other = await s.sites.addHost(b.m, siteB.id, 'shop.b-only.com');
    s.net.txt('_v4c-verify.shop.b-only.com', `v4c-verify=${b.token}`);
    // bHost — снова не подтверждён (истёк), чтобы попасть в пакет.
    await s.store
      .sitesDb()
      .forAccount(b.m.accountId)
      .siteHost.update({ where: { id: bHost }, data: { status: 'expired' } });
    const base = s.net.checker();
    const racy = Object.create(base) as typeof base;
    let revoked = false;
    racy.check = async (...args: Parameters<typeof base.check>) => {
      const r = await base.check(...args);
      if (!revoked && args[1].host === 'example.com') {
        revoked = true;
        await s.ownership.revokeForeign(a.m, aHost);
      }
      return r;
    };
    const ownershipB = new OwnershipService(s.store.sitesDb(), racy);
    const { results } = await ownershipB.verifyAll(b.m, siteB.id);
    expect(results.map((r) => r.host.id)).toEqual([other.id]);
    expect(results[0].ok).toBe(true);
  });

  it('блокировка живёт, пока блокирующий сам подтверждает хост; потом не тупик', async () => {
    // Аудит Э0: снять блокировку может только кабинет с ДЕЙСТВУЮЩИМ
    // подтверждением. Если подтверждение A истекло, без этого правила B не
    // мог бы ни подтвердить хост, ни удалить его — навсегда.
    const { s, a, b, aHost, bHost } = await twoAccounts();
    await s.ownership.revokeForeign(a.m, aHost);
    const siteB = (await s.sites.listSites(b.m))[0];

    // Пока A подтверждён — блокировка держится (и удаление закрыто).
    expect(await rejectCode(s.ownership.verify(b.m, bHost, 'dns'))).toBe(
      'REVERIFY_BLOCKED',
    );

    // Подтверждение A истекло (90 дней без повтора).
    await s.store
      .sitesDb()
      .forAccount(a.m.accountId)
      .siteHost.update({
        where: { id: aHost },
        data: { expiresAt: new Date(Date.UTC(2020, 0, 1)) },
      });
    // Экран прячет «Проверить» у заблокированного — список уже без блокировки.
    expect((await s.sites.listSites(b.m))[0].hosts[0]).toMatchObject({
      id: bHost,
      reverifyBlocked: false,
    });
    await expect(s.ownership.verify(b.m, bHost, 'dns')).resolves.toMatchObject({
      ok: true,
      host: { status: 'verified', reverifyBlocked: false },
    });
    await expect(
      s.access.assertHostVerified(bHost, 'assist-crawl'),
    ).resolves.toBeDefined();

    // А A, вернувшись, подтверждает хост и снова может отозвать B.
    await s.ownership.verify(a.m, aHost, 'dns');
    expect((await s.ownership.revokeForeign(a.m, aHost)).revoked).toBe(1);
    expect(await rejectCode(s.sites.deleteHost(b.m, siteB.id, bHost))).toBe(
      'HOST_BLOCKED',
    );
    // A удалил свой хост — B может удалить и свой.
    const siteA = (await s.sites.listSites(a.m))[0];
    await s.sites.deleteHost(a.m, siteA.id, aHost);
    await expect(s.sites.deleteHost(b.m, siteB.id, bHost)).resolves.toEqual({
      deleted: true,
    });
  });

  it('блокировку держит именно блокирующий: чужое подтверждение третьего её не продлевает', async () => {
    const { s, a, b, aHost, bHost } = await twoAccounts();
    await s.ownership.revokeForeign(a.m, aHost);
    // C подтвердил хост уже после отзыва — его A не блокировал.
    const c = await login(s, 3);
    const sc = await s.sites.createSite(c.m, { name: 'C', url: 'example.com' });
    s.net.txt(
      '_v4c-verify.example.com',
      `v4c-verify=${b.token}`,
      `v4c-verify=${c.token}`,
    );
    await expect(
      s.ownership.verify(c.m, sc.hosts[0].id, 'dns'),
    ).resolves.toMatchObject({ ok: true });
    await s.store
      .sitesDb()
      .forAccount(a.m.accountId)
      .siteHost.update({ where: { id: aHost }, data: { status: 'revoked' } });
    await expect(s.ownership.verify(b.m, bHost, 'dns')).resolves.toMatchObject({
      ok: true,
    });
  });

  it('неподтвердивший кабинет чужих не видит и не отзывает', async () => {
    const { s, b, bHost } = await twoAccounts();
    const c = await login(s, 3);
    const sc = await s.sites.createSite(c.m, { name: 'C', url: 'example.com' });
    expect(
      await rejectCode(s.ownership.authorizations(c.m, sc.hosts[0].id)),
    ).toBe('HOST_NOT_VERIFIED');
    expect(
      await rejectCode(s.ownership.revokeForeign(c.m, sc.hosts[0].id)),
    ).toBe('HOST_NOT_VERIFIED');
    expect((await s.sites.listSites(b.m))[0].hosts[0].id).toBe(bHost);
  });
});

describe('кабинет при входе', () => {
  it('создаётся один раз и под advisory-lock', async () => {
    const s = setup();
    const first = await s.accounts.ensureAccount(identity(5, 'assist'));
    const second = await s.accounts.ensureAccount(identity(5, 'qa'));
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.membership.accountId).toBe(first.membership.accountId);
    expect(s.store.rawCalls).toEqual([
      expect.stringContaining('pg_advisory_xact_lock'),
    ]);
  });

  it('оператор не видит токен кабинета и список участников', async () => {
    const s = setup();
    const owner = await login(s, 1);
    const inv = await s.accounts.createInvite(owner.m, {
      role: 'operator',
      productRoles: { assist: 'operator' },
    });
    expect(inv.startParam).toBe(`inv_${inv.token}`);
    const op = await s.accounts.acceptInvite(identity(2, 'qa'), inv.startParam);
    expect(op).toMatchObject({
      accountId: owner.m.accountId,
      role: 'operator',
      productRoles: { qa: 'none', assist: 'operator', assistAdmin: 'none' },
    });
    const info = await s.accounts.accountInfo(op, false);
    expect(info.account.verifyToken).toBeNull();
    expect(info.members).toBeUndefined();
    // Одноразовое.
    expect(
      await rejectCode(
        s.accounts.acceptInvite(identity(3, 'assist'), inv.token),
      ),
    ).toBe('INVITE_INVALID');
    // В базе — только хеш.
    expect(
      JSON.stringify(s.store.rows('SiteAccountInvite'), (_k, v) =>
        typeof v === 'bigint' ? v.toString() : v,
      ),
    ).not.toContain(inv.token);
  });

  it('приглашение: владельца выдать нельзя, просроченное — недействительно', async () => {
    const s = setup();
    const owner = await login(s, 1);
    expect(
      await rejectCode(s.accounts.createInvite(owner.m, { role: 'owner' })),
    ).toBe('INVITE_ROLE_INVALID');
    expect(
      await rejectCode(
        s.accounts.createInvite(owner.m, {
          role: 'manager',
          productRoles: { assistAdmin: 'superuser' },
        }),
      ),
    ).toBe('INVITE_ROLE_INVALID');
    const t0 = new Date('2026-10-01T00:00:00Z');
    const inv = await s.accounts.createInvite(owner.m, { role: 'manager' }, t0);
    expect(
      await rejectCode(
        s.accounts.acceptInvite(
          identity(2, 'assist'),
          inv.token,
          new Date(t0.getTime() + 7 * DAY),
        ),
      ),
    ).toBe('INVITE_INVALID');
  });

  it('принятое приглашение становится кабинетом по умолчанию', async () => {
    const s = setup();
    const owner = await login(s, 1);
    const other = await login(s, 2); // свой автосозданный кабинет
    const inv = await s.accounts.createInvite(owner.m, { role: 'manager' });
    await s.accounts.acceptInvite(identity(2, 'assist'), inv.token);
    const m = (await s.accounts.resolveMembership(2n)) as AccountMembership;
    expect(m.accountId).toBe(owner.m.accountId);
    // Явный выбор своего — работает; чужого, где не состоит, — нет.
    expect(
      (await s.accounts.resolveMembership(2n, other.m.accountId))?.accountId,
    ).toBe(other.m.accountId);
    expect(
      await s.accounts.resolveMembership(1n, other.m.accountId),
    ).toBeNull();
  });
});
