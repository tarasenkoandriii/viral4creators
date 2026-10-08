/**
 * Хранилище учётных данных на НАСТОЯЩЕМ Postgres (Э-С Ш2): реестр учёток,
 * шифротексты в базе, аренда (срок, одноразовость, продукт, хост,
 * подтверждение), журнал (без секретов, цепочка, только дописывается),
 * удаление (crypto-shred), личные записи режима B, ротация ключа, сроки.
 */
import { randomUUID } from 'crypto';

/**
 * Открытый текст «утёк» в шифротекст: строкой ИЛИ байтами любого сегмента
 * конверта после base64url-декодирования. Маркер — длинный (≥ 16 символов):
 * короткая подстрока (`pw`) в случайном base64 встречается сама по себе
 * (≈ 1/4096 на позицию) и давала ложные падения.
 */
function leaksPlaintext(ciphertext: string, plain: string): boolean {
  if (plain.length < 16) throw new Error('маркер короче 16 символов');
  if (ciphertext.includes(plain)) return true;
  const needle = Buffer.from(plain, 'utf8');
  return ciphertext
    .split('.')
    .some((seg) => Buffer.from(seg, 'base64url').includes(needle));
}
import type { PrismaService } from '../../prisma/prisma.service';
import { verifyAuditChain, type AuditRow } from './credential-audit.service';
import { LEASE_TTL_MS } from './site-credentials.service';
import {
  CabinetFixture,
  CredStack,
  credStack,
  describeDb,
  dropCabinet,
  ownerPrisma,
  seedCabinet,
  testKey,
} from './testing/credentials-db.testing';

const K1 = testKey();
const K2 = testKey();
const ENV = { SITE_CREDENTIALS_KEYS: `v1:${K1}` };

async function status(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    const r = (e as { getResponse?: () => unknown }).getResponse?.() as
      { code?: string; reason?: string } | undefined;
    return r?.reason ? `${r.code}:${r.reason}` : (r?.code ?? String(e));
  }
}

describeDb('site-credentials на реальной базе', () => {
  let prisma: PrismaService;
  let s: CredStack;
  let f: CabinetFixture;
  const cleanup: CabinetFixture[] = [];
  const ownerRefs: string[] = [];

  beforeAll(() => {
    prisma = ownerPrisma();
    s = credStack(prisma, ENV);
  });
  beforeEach(async () => {
    s.svc.env = ENV;
    f = await seedCabinet(prisma);
    cleanup.push(f);
  });
  afterAll(async () => {
    for (const c of cleanup) await dropCabinet(prisma, c);
    await prisma.userSiteSession.deleteMany({
      where: { ownerRef: { in: ownerRefs } },
    });
    await prisma.$disconnect();
  });

  const actor = () => `tma:${f.telegramId}`;

  async function account(extra: Record<string, unknown> = {}) {
    return s.svc.create(
      f.accountId,
      f.siteId,
      {
        label: 'Покупатель Pro',
        role: 'customer',
        plan: 'Pro',
        username: 'qa@example.com',
        password: 'S3cret-pass-0123456789',
        hostIds: [f.verifiedHostId],
        products: ['tutorial'],
        confirmedTestAccount: true,
        ...extra,
      },
      actor(),
    );
  }

  it('создание: в базе — только шифротекст; наружу — флаги без пароля', async () => {
    const a = await account();
    expect(a).toMatchObject({
      label: 'Покупатель Pro',
      username: 'qa@example.com',
      status: 'active',
      confirmedTestAccount: true,
      createdBy: 'tma',
      secrets: { password: true, loginFields: false, session: false },
    });
    expect(JSON.stringify(a)).not.toContain('S3cret');
    const rows = await prisma.siteCredential.findMany({
      where: { testAccountId: a.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ purpose: 'password', keyVersion: 'v1' });
    expect(rows[0].ciphertext).toMatch(/^sc1\.v1\./);
    expect(leaksPlaintext(rows[0].ciphertext, 'S3cret-pass-0123456789')).toBe(
      false,
    );
    const list = await s.svc.list(f.accountId, f.siteId);
    expect(list.map((x) => x.id)).toEqual([a.id]);
  });

  it('хосты учётки — только хосты этого сайта; чужой кабинет учётку не видит', async () => {
    // Другой сайт ТОГО ЖЕ кабинета — его хост тоже не годится.
    const site2 = await prisma.site.create({
      data: { accountId: f.accountId, name: 'second' },
    });
    const host2 = await prisma.siteHost.create({
      data: {
        accountId: f.accountId,
        siteId: site2.id,
        host: `other.${f.domain}`,
      },
    });
    await expect(status(account({ hostIds: [host2.id] }))).resolves.toBe(
      'TEST_ACCOUNT_INVALID',
    );
    const other = await seedCabinet(prisma);
    cleanup.push(other);
    await expect(
      status(account({ hostIds: [other.verifiedHostId] })),
    ).resolves.toBe('TEST_ACCOUNT_INVALID');
    const a = await account();
    await expect(
      status(
        s.svc.update(other.accountId, other.siteId, a.id, { label: 'x' }, 'x'),
      ),
    ).resolves.toBe('TEST_ACCOUNT_NOT_FOUND');
    await expect(s.svc.list(other.accountId, other.siteId)).resolves.toEqual(
      [],
    );
  });

  it('аренда → погашение отдаёт пароль ОДИН раз; повтор — used', async () => {
    const a = await account();
    const lease = await s.svc.lease(f.accountId, {
      testAccountId: a.id,
      product: 'tutorial',
      hostId: f.verifiedHostId,
      actor: 'generator:1',
      runRef: 'draft:abc',
    });
    const got = await s.svc.redeem(f.accountId, lease.leaseId, 'generator:1');
    expect(got.secrets).toEqual({ password: 'S3cret-pass-0123456789' });
    await expect(
      status(s.svc.redeem(f.accountId, lease.leaseId, 'generator:1')),
    ).resolves.toBe('CREDENTIAL_LEASE_INVALID:used');
  });

  it('гонка двух погашений — секрет получает ровно один', async () => {
    const a = await account();
    const lease = await s.svc.lease(f.accountId, {
      testAccountId: a.id,
      product: 'tutorial',
      hostId: f.verifiedHostId,
      actor: 'generator:1',
    });
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        status(s.svc.redeem(f.accountId, lease.leaseId, 'generator:1')),
      ),
    );
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
  });

  it('аренда: истёкшая, чужой вызывающий — отказ', async () => {
    const a = await account();
    const t0 = new Date();
    const lease = await s.svc.lease(
      f.accountId,
      {
        testAccountId: a.id,
        product: 'tutorial',
        hostId: f.verifiedHostId,
        actor: 'generator:1',
      },
      t0,
    );
    await expect(
      status(s.svc.redeem(f.accountId, lease.leaseId, 'generator:2')),
    ).resolves.toBe('CREDENTIAL_LEASE_INVALID:actor');
    await expect(
      status(
        s.svc.redeem(
          f.accountId,
          lease.leaseId,
          'generator:1',
          new Date(t0.getTime() + LEASE_TTL_MS + 1000),
        ),
      ),
    ).resolves.toBe('CREDENTIAL_LEASE_INVALID:expired');
  });

  it('аудит тестов: погашение ровно в момент expiresAt — уже истекла; за 1 мс до — ещё действует', async () => {
    const a = await account();
    const t0 = new Date();
    const req = {
      testAccountId: a.id,
      product: 'tutorial' as const,
      hostId: f.verifiedHostId,
      actor: 'generator:1',
    };
    const l1 = await s.svc.lease(f.accountId, req, t0);
    await expect(
      status(
        s.svc.redeem(f.accountId, l1.leaseId, 'generator:1', l1.expiresAt),
      ),
    ).resolves.toBe('CREDENTIAL_LEASE_INVALID:expired');
    const l2 = await s.svc.lease(f.accountId, req, t0);
    await expect(
      status(
        s.svc.redeem(
          f.accountId,
          l2.leaseId,
          'generator:1',
          new Date(l2.expiresAt.getTime() - 1),
        ),
      ),
    ).resolves.toBe('ok');
  });

  it('аренда: чужой продукт, чужой хост, неподтверждённый хост, заморожена, истекла — отказ с причиной', async () => {
    const a = await account({ hostIds: [f.verifiedHostId, f.pendingHostId] });
    const req = {
      testAccountId: a.id,
      product: 'tutorial' as const,
      hostId: f.verifiedHostId,
      actor: 'generator:1',
    };
    await expect(
      status(s.svc.lease(f.accountId, { ...req, product: 'qa' })),
    ).resolves.toBe('CREDENTIAL_LEASE_DENIED:product');
    const stranger = await seedCabinet(prisma);
    cleanup.push(stranger);
    await expect(
      status(
        s.svc.lease(f.accountId, { ...req, hostId: stranger.verifiedHostId }),
      ),
    ).resolves.toBe('CREDENTIAL_LEASE_DENIED:host');
    await expect(
      status(s.svc.lease(f.accountId, { ...req, hostId: f.pendingHostId })),
    ).resolves.toBe('CREDENTIAL_LEASE_DENIED:host_not_verified');
    // Отзыв владения замораживает учётку сразу (льготы нет).
    await prisma.siteHost.update({
      where: { id: f.verifiedHostId },
      data: { status: 'revoked', revokedAt: new Date() },
    });
    await expect(status(s.svc.lease(f.accountId, req))).resolves.toBe(
      'CREDENTIAL_LEASE_DENIED:host_not_verified',
    );
    await prisma.siteHost.update({
      where: { id: f.verifiedHostId },
      data: { status: 'verified', revokedAt: null },
    });
    await s.svc.update(
      f.accountId,
      f.siteId,
      a.id,
      { status: 'frozen' },
      actor(),
    );
    await expect(status(s.svc.lease(f.accountId, req))).resolves.toBe(
      'CREDENTIAL_LEASE_DENIED:frozen',
    );
    await s.svc.update(
      f.accountId,
      f.siteId,
      a.id,
      { status: 'active' },
      actor(),
    );
    await expect(
      status(
        s.svc.lease(f.accountId, req, new Date(Date.now() + 91 * 86_400_000)),
      ),
    ).resolves.toBe('CREDENTIAL_LEASE_DENIED:expired');
    await expect(status(s.svc.lease(f.accountId, req))).resolves.toBe('ok');
  });

  it('учётку заморозили между арендой и погашением — секрет не выдаётся', async () => {
    const a = await account();
    const lease = await s.svc.lease(f.accountId, {
      testAccountId: a.id,
      product: 'tutorial',
      hostId: f.verifiedHostId,
      actor: 'generator:1',
    });
    await s.svc.update(
      f.accountId,
      f.siteId,
      a.id,
      { status: 'frozen' },
      actor(),
    );
    await expect(
      status(s.svc.redeem(f.accountId, lease.leaseId, 'generator:1')),
    ).resolves.toBe('CREDENTIAL_LEASE_INVALID:account');
  });

  it('аудит Ш2: продукт или хост убрали, подтверждение отозвали между арендой и погашением — секрет не выдаётся', async () => {
    const a = await account({ products: ['tutorial', 'qa'] });
    const req = {
      testAccountId: a.id,
      product: 'tutorial' as const,
      hostId: f.verifiedHostId,
      actor: 'generator:1',
    };
    // Продукт убран из учётки.
    const l1 = await s.svc.lease(f.accountId, req);
    await s.svc.update(
      f.accountId,
      f.siteId,
      a.id,
      { products: ['qa'] },
      actor(),
    );
    await expect(
      status(s.svc.redeem(f.accountId, l1.leaseId, 'generator:1')),
    ).resolves.toBe('CREDENTIAL_LEASE_INVALID:revoked');
    await s.svc.update(
      f.accountId,
      f.siteId,
      a.id,
      { products: ['tutorial'] },
      actor(),
    );
    // Подтверждение хоста отозвано.
    const l2 = await s.svc.lease(f.accountId, req);
    await prisma.siteHost.update({
      where: { id: f.verifiedHostId },
      data: { status: 'revoked', revokedAt: new Date() },
    });
    await expect(
      status(s.svc.redeem(f.accountId, l2.leaseId, 'generator:1')),
    ).resolves.toBe('CREDENTIAL_LEASE_INVALID:revoked');
    await prisma.siteHost.update({
      where: { id: f.verifiedHostId },
      data: { status: 'verified', revokedAt: null },
    });
    // Хост убран из учётки.
    const l3 = await s.svc.lease(f.accountId, req);
    await s.svc.update(
      f.accountId,
      f.siteId,
      a.id,
      { hostIds: [f.pendingHostId] },
      actor(),
    );
    await expect(
      status(s.svc.redeem(f.accountId, l3.leaseId, 'generator:1')),
    ).resolves.toBe('CREDENTIAL_LEASE_INVALID:revoked');
  });

  it('аудит Ш2: канал обучалки не арендует для QA, даже если учётка разрешена QA', async () => {
    const a = await account({ products: ['tutorial', 'qa'] });
    const req = {
      testAccountId: a.id,
      hostId: f.verifiedHostId,
      actor: 'generator:1',
      channel: 'tutorial' as const,
    };
    await expect(
      status(s.svc.lease(f.accountId, { ...req, product: 'qa' })),
    ).resolves.toBe('CREDENTIAL_LEASE_DENIED:product');
    await expect(
      status(s.svc.lease(f.accountId, { ...req, product: 'tutorial' })),
    ).resolves.toBe('ok');
  });

  it('журнал: каждое действие и отказ записаны, секретов нет, цепочка цела', async () => {
    const a = await account();
    await status(
      s.svc.lease(f.accountId, {
        testAccountId: a.id,
        product: 'qa',
        hostId: f.verifiedHostId,
        actor: 'generator:9',
      }),
    );
    const lease = await s.svc.lease(f.accountId, {
      testAccountId: a.id,
      product: 'tutorial',
      hostId: f.verifiedHostId,
      actor: 'generator:9',
      runRef: 'draft:d1',
    });
    await s.svc.redeem(f.accountId, lease.leaseId, 'generator:9');
    const rows = await prisma.siteCredentialAudit.findMany({
      where: { accountId: f.accountId, subjectId: a.id },
      orderBy: { seq: 'asc' },
    });
    expect(rows.map((r) => `${r.action}:${r.result}`)).toEqual([
      'create:ok',
      'put-secret:ok',
      'lease:denied:product',
      'lease:ok',
      'redeem:ok',
    ]);
    expect(rows[4]).toMatchObject({
      actor: 'generator:9',
      product: 'tutorial',
      hostId: f.verifiedHostId,
      runRef: 'draft:d1',
    });
    expect(
      JSON.stringify(rows, (_k, v: unknown) =>
        typeof v === 'bigint' ? v.toString() : v,
      ),
    ).not.toContain('S3cret');
    // Цепочка от первой строки этого теста до конца таблицы (все строки
    // по порядку, включая параллельные наборы): каждая ссылается на хеш
    // предыдущей и сама хеширована верно.
    const all = await prisma.siteCredentialAudit.findMany({
      where: { seq: { gte: rows[0].seq } },
      orderBy: { seq: 'asc' },
    });
    expect(
      verifyAuditChain(
        all.map((r) => ({
          ...r,
          action: r.action as AuditRow['action'],
          scope: r.scope as 'A' | 'B',
        })),
      ),
    ).toEqual({ ok: true, firstBroken: null });
  });

  it('журнал только дописывается: UPDATE и DELETE запрещены триггером', async () => {
    await account();
    const last = await prisma.siteCredentialAudit.findFirst({
      orderBy: { seq: 'desc' },
    });
    await expect(
      prisma.siteCredentialAudit.update({
        where: { seq: last!.seq },
        data: { result: 'ok-forged' },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.siteCredentialAudit.delete({ where: { seq: last!.seq } }),
    ).rejects.toThrow();
  });

  it('«Забыть»: учётка, секреты и аренды удалены (crypto-shred), строка журнала осталась', async () => {
    const a = await account();
    await s.svc.lease(f.accountId, {
      testAccountId: a.id,
      product: 'tutorial',
      hostId: f.verifiedHostId,
      actor: 'generator:1',
    });
    await s.svc.remove(f.accountId, f.siteId, a.id, actor());
    await expect(
      prisma.siteCredential.count({ where: { testAccountId: a.id } }),
    ).resolves.toBe(0);
    await expect(
      prisma.siteCredentialLease.count({ where: { testAccountId: a.id } }),
    ).resolves.toBe(0);
    await expect(
      prisma.siteCredentialAudit.count({
        where: { subjectId: a.id, action: 'delete' },
      }),
    ).resolves.toBe(1);
  });

  it('удаление сайта/кабинета — каскад секретов', async () => {
    const a = await account();
    await prisma.site.delete({ where: { id: f.siteId } });
    await expect(
      prisma.siteCredential.count({ where: { testAccountId: a.id } }),
    ).resolves.toBe(0);
  });

  it('шифротекст, переставленный в чужую учётку, не расшифровывается (AAD)', async () => {
    const a = await account();
    const b = await account({ label: 'Админ', password: 'other-pass' });
    const ca = await prisma.siteCredential.findFirstOrThrow({
      where: { testAccountId: a.id },
    });
    await prisma.siteCredential.update({
      where: {
        testAccountId_purpose: { testAccountId: b.id, purpose: 'password' },
      },
      data: { ciphertext: ca.ciphertext },
    });
    const lease = await s.svc.lease(f.accountId, {
      testAccountId: b.id,
      product: 'tutorial',
      hostId: f.verifiedHostId,
      actor: 'generator:1',
    });
    await expect(
      status(s.svc.redeem(f.accountId, lease.leaseId, 'generator:1')),
    ).resolves.toBe('CREDENTIAL_UNREADABLE:tampered');
  });

  it('без ключей: метаданные работают, секреты — 503 CREDENTIALS_NOT_CONFIGURED', async () => {
    s.svc.env = {};
    expect(s.svc.status()).toEqual({
      configured: false,
      currentKeyVersion: null,
    });
    await expect(status(account())).resolves.toBe('CREDENTIALS_NOT_CONFIGURED');
    const a = await account({ password: undefined });
    expect(a.secrets.password).toBe(false);
    await expect(
      status(s.svc.putSecret(f.accountId, a.id, 'password', 'x', actor())),
    ).resolves.toBe('CREDENTIALS_NOT_CONFIGURED');
  });

  it('генератор: учётка по ключу черновика — идемпотентно, только где человек владелец/менеджер', async () => {
    const { m, siteId } = await s.svc.managedHost(
      f.telegramId,
      f.verifiedHostId,
    );
    expect(siteId).toBe(f.siteId);
    const ref = `project:${randomUUID().slice(0, 12)}`;
    const [x, y] = await Promise.all([
      s.svc.upsertByClientRef(
        m.accountId,
        siteId,
        ref,
        { label: 'T', hostIds: [f.verifiedHostId], products: ['tutorial'] },
        'generator:1',
      ),
      s.svc.upsertByClientRef(
        m.accountId,
        siteId,
        ref,
        { label: 'T', hostIds: [f.verifiedHostId], products: ['tutorial'] },
        'generator:1',
      ),
    ]);
    expect(x.id).toBe(y.id);
    const op = await seedCabinet(prisma, { role: 'operator' });
    cleanup.push(op);
    await expect(
      status(s.svc.managedHost(op.telegramId, op.verifiedHostId)),
    ).resolves.toBe('HOST_NOT_MANAGED');
    await expect(
      status(s.svc.managedHost(f.telegramId, op.verifiedHostId)),
    ).resolves.toBe('HOST_NOT_MANAGED');
  });

  describe('режим B: личные записи', () => {
    const PW_MARKER = 'pw-marker-7Qz2Lk9Xv4';
    const LOGIN_FIELDS = `[{"selector":"#p","value":"${PW_MARKER}"}]`;
    const owner = () => {
      const r = `gen:${randomUUID().slice(0, 12)}`;
      ownerRefs.push(r);
      return r;
    };

    it('запись, чтение владельцем, чужой владелец — отказ, удаление', async () => {
      const me = owner();
      const sess = await s.svc.upsertUserSession(me, {
        origin: 'https://shop.example.com',
        clientRef: 'project:p1',
      });
      expect(sess.products).toEqual(['tutorial']);
      await s.svc.putUserSecret(me, sess.id, 'login-fields', LOGIN_FIELDS);
      await s.svc.putUserSecret(
        me,
        sess.id,
        'session-cookies',
        '[{"name":"sid"}]',
      );
      const again = await s.svc.upsertUserSession(me, {
        origin: 'https://shop.example.com',
        clientRef: 'project:p1',
      });
      expect(again.id).toBe(sess.id);
      expect(again.secrets).toEqual({
        password: false,
        loginFields: true,
        session: true,
      });
      await expect(
        s.svc.readUserSecrets(me, sess.id, 'draft:d'),
      ).resolves.toEqual({
        secrets: {
          'login-fields': LOGIN_FIELDS,
          'session-cookies': '[{"name":"sid"}]',
        },
      });
      const stranger = owner();
      await expect(
        status(s.svc.readUserSecrets(stranger, sess.id, null)),
      ).resolves.toBe('USER_SESSION_NOT_FOUND');
      await expect(
        prisma.siteCredentialAudit.count({
          where: { subjectId: sess.id, result: 'denied:owner' },
        }),
      ).resolves.toBe(1);
      const rows = await prisma.userSiteSecret.findMany({
        where: { sessionId: sess.id },
      });
      expect(rows.every((r) => !leaksPlaintext(r.ciphertext, PW_MARKER))).toBe(
        true,
      );
      await expect(s.svc.deleteUserSession(stranger, sess.id)).resolves.toEqual(
        {
          deleted: false,
        },
      );
      await expect(s.svc.deleteUserSession(me, sess.id)).resolves.toEqual({
        deleted: true,
      });
      await expect(
        prisma.userSiteSecret.count({ where: { sessionId: sess.id } }),
      ).resolves.toBe(0);
    });

    it('личная запись не открывается как учётка реестра (AAD зоны)', async () => {
      const me = owner();
      const sess = await s.svc.upsertUserSession(me, {
        origin: 'https://shop.example.com',
        clientRef: null,
      });
      await s.svc.putUserSecret(me, sess.id, 'password', 'b-pass');
      const a = await account();
      const b = await prisma.userSiteSecret.findFirstOrThrow({
        where: { sessionId: sess.id },
      });
      await prisma.siteCredential.update({
        where: {
          testAccountId_purpose: { testAccountId: a.id, purpose: 'password' },
        },
        data: { ciphertext: b.ciphertext },
      });
      const lease = await s.svc.lease(f.accountId, {
        testAccountId: a.id,
        product: 'tutorial',
        hostId: f.verifiedHostId,
        actor: 'generator:1',
      });
      await expect(
        status(s.svc.redeem(f.accountId, lease.leaseId, 'generator:1')),
      ).resolves.toBe('CREDENTIAL_UNREADABLE:tampered');
    });

    it('истёкшая запись не читается; крон удаляет', async () => {
      const me = owner();
      const t0 = new Date();
      const sess = await s.svc.upsertUserSession(
        me,
        { origin: 'https://shop.example.com', clientRef: null },
        t0,
      );
      await s.svc.putUserSecret(me, sess.id, 'password', 'p', t0);
      const later = new Date(t0.getTime() + 31 * 86_400_000);
      await expect(
        status(s.svc.readUserSecrets(me, sess.id, null, later)),
      ).resolves.toBe('USER_SESSION_NOT_FOUND');
      // Крон — на «сейчас» с истёкшей строкой (а не «через месяц» для всех:
      // база общая с параллельными наборами).
      await prisma.userSiteSession.update({
        where: { id: sess.id },
        data: { expiresAt: new Date(t0.getTime() - 1000) },
      });
      await s.svc.runRetention();
      await expect(
        prisma.userSiteSession.count({ where: { id: sess.id } }),
      ).resolves.toBe(0);
    });
  });

  it('ротация: dry-run ничего не пишет; apply перешифровывает v1 → v2, старый ключ можно убрать', async () => {
    const a = await account();
    const me = `gen:${randomUUID().slice(0, 12)}`;
    ownerRefs.push(me);
    const sess = await s.svc.upsertUserSession(me, {
      origin: 'https://b.example.com',
      clientRef: null,
    });
    await s.svc.putUserSecret(me, sess.id, 'password', 'b-pass');
    s.svc.env = {
      SITE_CREDENTIALS_KEYS: `v1:${K1},v2:${K2}`,
      SITE_CREDENTIALS_KEY_CURRENT: 'v2',
    };
    const before = await prisma.siteCredential.findFirstOrThrow({
      where: { testAccountId: a.id },
    });
    const dry = await s.svc.rotateKeys({ apply: false });
    expect(dry.rotated).toBe(0);
    expect(dry.byVersion.v1).toBeGreaterThanOrEqual(2);
    await expect(
      prisma.siteCredential.findFirstOrThrow({ where: { id: before.id } }),
    ).resolves.toMatchObject({
      ciphertext: before.ciphertext,
      keyVersion: 'v1',
    });
    const done = await s.svc.rotateKeys({ apply: true });
    // В общей базе лежат и испорченные нарочно строки других тестов
    // (подмена AAD) — они честно попадают в `failed`, наши — перешифрованы.
    expect(done.rotated).toBeGreaterThanOrEqual(2);
    await expect(
      prisma.siteCredential.findFirstOrThrow({ where: { id: before.id } }),
    ).resolves.toMatchObject({ keyVersion: 'v2' });
    s.svc.env = { SITE_CREDENTIALS_KEYS: `v2:${K2}` };
    const lease = await s.svc.lease(f.accountId, {
      testAccountId: a.id,
      product: 'tutorial',
      hostId: f.verifiedHostId,
      actor: 'generator:1',
    });
    await expect(
      s.svc.redeem(f.accountId, lease.leaseId, 'generator:1'),
    ).resolves.toMatchObject({
      secrets: { password: 'S3cret-pass-0123456789' },
    });
    await expect(s.svc.readUserSecrets(me, sess.id, null)).resolves.toEqual({
      secrets: { password: 'b-pass' },
    });
    await expect(
      prisma.userSiteSecret.count({
        where: { sessionId: sess.id, keyVersion: 'v1' },
      }),
    ).resolves.toBe(0);
  });

  it('сроки: истёкшая учётка — секреты стёрты, статус expired; удалённый хост убран из учётки', async () => {
    const a = await account({
      lifetimeDays: 7,
      hostIds: [f.verifiedHostId, f.pendingHostId],
    });
    await prisma.siteHost.delete({ where: { id: f.pendingHostId } });
    await prisma.siteTestAccount.update({
      where: { id: a.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const r = await s.svc.runRetention();
    expect(r.accountsExpired).toBeGreaterThanOrEqual(1);
    expect(r.staleHostRefs).toBeGreaterThanOrEqual(1);
    const row = await prisma.siteTestAccount.findUniqueOrThrow({
      where: { id: a.id },
    });
    expect(row.status).toBe('expired');
    expect(row.hostIds).toEqual([f.verifiedHostId]);
    await expect(
      prisma.siteCredential.count({ where: { testAccountId: a.id } }),
    ).resolves.toBe(0);
    // Новый срок оживляет учётку (пароль — ввести заново).
    const revived = await s.svc.update(
      f.accountId,
      f.siteId,
      a.id,
      { lifetimeDays: 30 },
      actor(),
    );
    expect(revived.status).toBe('active');
    expect(revived.secrets.password).toBe(false);
  });
  describe('Ш2-хвост (6): QA — только учётка, отмеченная владельцем как тестовая', () => {
    const qaReq = (id: string) => ({
      testAccountId: id,
      product: 'qa' as const,
      hostId: f.verifiedHostId,
      actor: 'qa-flow:1',
      runRef: 'qarun:r1',
    });

    it('без отметки — 409 TEST_ACCOUNT_NOT_CONFIRMED, аренды нет, отказ в журнале', async () => {
      const a = await account({
        products: ['qa'],
        confirmedTestAccount: false,
      });
      await expect(status(s.svc.lease(f.accountId, qaReq(a.id)))).resolves.toBe(
        'TEST_ACCOUNT_NOT_CONFIRMED:not_confirmed',
      );
      let caught: unknown = null;
      await s.svc.lease(f.accountId, qaReq(a.id)).catch((e) => (caught = e));
      expect((caught as { getStatus(): number }).getStatus()).toBe(409);
      await expect(
        prisma.siteCredentialLease.count({ where: { testAccountId: a.id } }),
      ).resolves.toBe(0);
      const audit = await prisma.siteCredentialAudit.findMany({
        where: { subjectId: a.id, action: 'lease' },
      });
      expect(audit.map((r) => r.result)).toEqual([
        'denied:not_confirmed',
        'denied:not_confirmed',
      ]);
      expect(
        JSON.stringify(audit, (_k, v: unknown) =>
          typeof v === 'bigint' ? String(v) : v,
        ),
      ).not.toContain('S3cret');
    });

    it('с отметкой — аренда и погашение; обучалке отметка не нужна', async () => {
      const a = await account({ products: ['qa'] });
      const lease = await s.svc.lease(f.accountId, qaReq(a.id));
      const got = await s.svc.redeem(f.accountId, lease.leaseId, 'qa-flow:1');
      expect(got.secrets).toEqual({ password: 'S3cret-pass-0123456789' });
      const t = await account({ confirmedTestAccount: false });
      await expect(
        status(
          s.svc.lease(f.accountId, {
            ...qaReq(t.id),
            product: 'tutorial',
            actor: 'generator:1',
          }),
        ),
      ).resolves.toBe('ok');
    });

    it('отметку сняли между арендой и погашением — секрет не выдаётся (409)', async () => {
      const a = await account({ products: ['qa'] });
      const lease = await s.svc.lease(f.accountId, qaReq(a.id));
      await s.svc.update(
        f.accountId,
        f.siteId,
        a.id,
        { confirmedTestAccount: false },
        actor(),
      );
      await expect(
        status(s.svc.redeem(f.accountId, lease.leaseId, 'qa-flow:1')),
      ).resolves.toBe('TEST_ACCOUNT_NOT_CONFIRMED:not_confirmed');
      const last = await prisma.siteCredentialAudit.findFirst({
        where: { subjectId: a.id, action: 'redeem' },
        orderBy: { seq: 'desc' },
      });
      expect(last?.result).toBe('denied:not_confirmed');
    });
  });

  describe('Ш2 (8), Р-З10-1: аренда `assist-admin` — тоже только с отметкой «тестовая»', () => {
    const adminReq = (id: string) => ({
      testAccountId: id,
      product: 'assist-admin' as const,
      hostId: f.verifiedHostId,
      actor: 'browser-worker',
      runRef: 'bjob:r1',
    });

    it('без отметки — 409 TEST_ACCOUNT_NOT_CONFIRMED, аренды нет, отказ в журнале; с отметкой — аренда', async () => {
      const a = await account({
        products: ['assist-admin'],
        confirmedTestAccount: false,
      });
      await expect(
        status(s.svc.lease(f.accountId, adminReq(a.id))),
      ).resolves.toBe('TEST_ACCOUNT_NOT_CONFIRMED:not_confirmed');
      await expect(
        prisma.siteCredentialLease.count({ where: { testAccountId: a.id } }),
      ).resolves.toBe(0);
      const audit = await prisma.siteCredentialAudit.findMany({
        where: { subjectId: a.id, action: 'lease' },
      });
      expect(audit.map((r) => [r.product, r.result])).toEqual([
        ['assist-admin', 'denied:not_confirmed'],
      ]);
      const ok = await account({ products: ['assist-admin'] });
      await expect(
        status(s.svc.lease(f.accountId, adminReq(ok.id))),
      ).resolves.toBe('ok');
    });

    it('отметку сняли между арендой и погашением — секрет `assist-admin` не выдаётся (409)', async () => {
      const a = await account({ products: ['assist-admin'] });
      const lease = await s.svc.lease(f.accountId, adminReq(a.id));
      await s.svc.update(
        f.accountId,
        f.siteId,
        a.id,
        { confirmedTestAccount: false },
        actor(),
      );
      await expect(
        status(s.svc.redeem(f.accountId, lease.leaseId, 'browser-worker')),
      ).resolves.toBe('TEST_ACCOUNT_NOT_CONFIRMED:not_confirmed');
      const last = await prisma.siteCredentialAudit.findFirst({
        where: { subjectId: a.id, action: 'redeem' },
        orderBy: { seq: 'desc' },
      });
      expect(last?.result).toBe('denied:not_confirmed');
    });
  });

  describe('Ш2-хвост (7): forgetOwn — удаление учётки, заведённой этим черновиком', () => {
    const gen = () => `generator:${f.telegramId}`;
    async function draftAccount(clientRef: string, by = gen()) {
      const a = await s.svc.upsertByClientRef(
        f.accountId,
        f.siteId,
        clientRef,
        {
          label: 'Обучалка',
          hostIds: [f.verifiedHostId],
          products: ['tutorial'],
        },
        by,
      );
      await s.svc.putSecret(
        f.accountId,
        a.id,
        'login-fields',
        '[{"selector":"#pw","value":"Draft-secret-0123456789"}]',
        by,
      );
      return a;
    }

    it('своя: строка, секреты и аренды удалены (crypto-shred), журнал — delete ok', async () => {
      const a = await draftAccount('project:own1');
      await s.svc.lease(f.accountId, {
        testAccountId: a.id,
        product: 'tutorial',
        hostId: f.verifiedHostId,
        actor: gen(),
      });
      const r = await s.svc.forgetOwn(f.accountId, a.id, 'project:own1', gen());
      expect(r).toEqual({ deleted: true });
      await expect(
        prisma.siteTestAccount.count({ where: { id: a.id } }),
      ).resolves.toBe(0);
      await expect(
        prisma.siteCredential.count({ where: { testAccountId: a.id } }),
      ).resolves.toBe(0);
      await expect(
        prisma.siteCredentialLease.count({ where: { testAccountId: a.id } }),
      ).resolves.toBe(0);
      const audit = await prisma.siteCredentialAudit.findFirst({
        where: { subjectId: a.id, action: 'delete' },
        orderBy: { seq: 'desc' },
      });
      expect(audit).toMatchObject({
        actor: gen(),
        result: 'ok',
        runRef: 'project:own1',
      });
      expect(
        JSON.stringify(audit, (_k, v: unknown) =>
          typeof v === 'bigint' ? String(v) : v,
        ),
      ).not.toContain('Draft-secret');
    });

    it('чужая не забывается: заведена в кабинете, другим черновиком или другим человеком — 409, учётка цела', async () => {
      const manual = await account();
      const otherDraft = await draftAccount('project:own2');
      const otherUser = await draftAccount('project:own3', 'generator:999');
      const tries: Array<[string, string]> = [
        [manual.id, 'project:own2'],
        [otherDraft.id, 'project:zzz'],
        [otherUser.id, 'project:own3'],
      ];
      for (const [id, ref] of tries) {
        await expect(
          status(s.svc.forgetOwn(f.accountId, id, ref, gen())),
        ).resolves.toBe('TEST_ACCOUNT_NOT_OWN');
      }
      for (const id of [manual.id, otherDraft.id, otherUser.id]) {
        await expect(
          prisma.siteCredential.count({ where: { testAccountId: id } }),
        ).resolves.toBe(1);
      }
      const denied = await prisma.siteCredentialAudit.count({
        where: {
          subjectId: { in: [manual.id, otherDraft.id, otherUser.id] },
          action: 'delete',
          result: 'denied:not_own',
        },
      });
      expect(denied).toBe(3);
      // Чужой кабинет — даже не находит.
      const stranger = await seedCabinet(prisma);
      cleanup.push(stranger);
      await expect(
        status(
          s.svc.forgetOwn(
            stranger.accountId,
            otherDraft.id,
            'project:own2',
            gen(),
          ),
        ),
      ).resolves.toBe('TEST_ACCOUNT_NOT_FOUND');
    });
  });
});
