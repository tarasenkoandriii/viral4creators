/**
 * Очередь браузерного воркера на НАСТОЯЩЕМ Postgres (аудит Ш3, P2/P3):
 *  - claim: оптимистичный замок (`queued` + та же попытка) — одно задание
 *    не выдаётся дважды; ожидающее с запросом отмены и просроченное — не
 *    выдаются; потолок идущих на кабинет — под замком кабинета;
 *  - уборка (`reap`) без проверки выключателя: истёкшая аренда при
 *    выключенном воркере — `failed: worker_disabled` с уведомлением
 *    продукта; ожидающее с отменой — `cancelled`; «сдано», но обработчик
 *    продукта оборвался — `failed: internal`; сверка продуктов;
 *  - артефакты: одновременная загрузка одного номера — 409, а не 500;
 *    старый Blob не удалился — 503 и строка цела;
 *  - ретенция: Blob не удалился — строка и задание ждут следующего прогона.
 *
 * Гонки воспроизводятся детерминированно: тест держит advisory-замок
 * кабинета (`browser-jobs:account:<id>`), claim читает кандидатов и ждёт
 * замка, а тест в это время меняет задание.
 */
import { randomUUID } from 'crypto';
import type { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import { RUNNING_PER_ACCOUNT } from './browser-job-rules';
import {
  BrowserJobsService,
  DONE_PENDING_GRACE_MS,
  WORKER_DISABLED_CODE,
} from './browser-jobs.service';
import { BrowserJobHandlers, type HandlerJob } from './job-handlers';
import { FakeArtifactStorage } from './testing/fake-artifact-storage.testing';
import {
  describeDb,
  ownerPrisma,
  serializeQueueTests,
} from './testing/jobs-db.testing';

jest.setTimeout(120_000);

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString(
  'base64',
);

class FlakyStorage extends FakeArtifactStorage {
  failRemove = false;
  /** Загрузки ждут, пока их не станет столько (одновременность). */
  barrier = 0;
  private waiting: Array<() => void> = [];

  override async put(pathname: string, body: Buffer, contentType: string) {
    if (this.barrier > 0) {
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
        if (this.waiting.length >= this.barrier) {
          for (const w of this.waiting.splice(0)) w();
        }
      });
    }
    return super.put(pathname, body, contentType);
  }

  override async remove(pathname: string) {
    if (this.failRemove) throw new Error('blob down');
    return super.remove(pathname);
  }
}

describeDb('очередь браузерного воркера на Postgres (аудит Ш3)', () => {
  serializeQueueTests();
  let prisma: PrismaService;
  let svc: BrowserJobsService;
  let storage: FlakyStorage;
  let handlers: BrowserJobHandlers;
  const failed: Array<[string, string]> = [];
  const accounts: string[] = [];
  const env: NodeJS.ProcessEnv = { BROWSER_WORKER_ENABLED: 'true' };

  interface Site {
    accountId: string;
    siteId: string;
    hostId: string;
    host: string;
  }

  async function site(): Promise<Site> {
    const tag = randomUUID().slice(0, 8);
    const host = `q-${tag}.bj.example.com`;
    const account = await prisma.siteAccount.create({
      data: { verifyToken: `bj-${randomUUID()}` },
    });
    accounts.push(account.id);
    const s = await prisma.site.create({
      data: { accountId: account.id, name: `bj ${tag}` },
    });
    const h = await prisma.siteHost.create({
      data: {
        accountId: account.id,
        siteId: s.id,
        host,
        status: 'verified',
        method: 'dns',
        verifiedAt: new Date(Date.now() - 60_000),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    return { accountId: account.id, siteId: s.id, hostId: h.id, host };
  }

  async function job(
    s: Site,
    over: Record<string, unknown> = {},
  ): Promise<string> {
    const row = await prisma.siteBrowserJob.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        hostId: s.hostId,
        kind: 'ui-snapshot',
        origin: 'voice-map-snapshot',
        params: {
          url: `https://${s.host}/`,
          allowedHosts: [s.host],
          viewport: 'mobile',
          screenshot: false,
          mapElements: false,
        },
        availableAt: new Date(Date.now() - 1000),
        expiresAt: new Date(Date.now() + 86_400_000),
        ...over,
      },
    });
    return row.id;
  }

  const status = async (id: string) =>
    prisma.siteBrowserJob.findUniqueOrThrow({ where: { id } });

  /** Очередь базы fix_sb — только этого спека: всё ждущее — убрать. */
  async function drain() {
    await prisma.siteBrowserJob.updateMany({
      where: { status: { in: ['queued', 'running'] } },
      data: { status: 'cancelled' },
    });
  }

  /**
   * Держать замок кабинета, пока `during` не выполнится; `during` зовётся,
   * когда кто-то другой ЖДЁТ этот замок (claim прочёл кандидатов).
   */
  async function withAccountLock(
    accountId: string,
    claimCall: () => Promise<unknown>,
    during: () => Promise<void>,
  ) {
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`browser-jobs:account:${accountId}`}))`;
        locked();
        await released;
      },
      { timeout: 60_000 },
    );
    await isLocked;
    const pending = claimCall();
    for (let i = 0; i < 200; i++) {
      const w = await prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*)::bigint AS n FROM pg_locks
         WHERE locktype = 'advisory' AND NOT granted`;
      if (Number(w[0].n) > 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    await during();
    release();
    await holder;
    return pending;
  }

  beforeAll(() => {
    prisma = ownerPrisma();
    storage = new FlakyStorage();
    handlers = new BrowserJobHandlers();
    handlers.register('voice-map-snapshot', {
      onFailed: (j: HandlerJob, code: string) => {
        failed.push([j.id, code]);
        return Promise.resolve();
      },
    });
    svc = new BrowserJobsService(new SitesDb(prisma), storage, handlers);
    svc.env = env;
  });

  beforeEach(async () => {
    env.BROWSER_WORKER_ENABLED = 'true';
    storage.failRemove = false;
    storage.barrier = 0;
    failed.length = 0;
    svc.now = () => new Date();
    await drain();
  });

  afterAll(async () => {
    if (accounts.length)
      await prisma.siteAccount.deleteMany({ where: { id: { in: accounts } } });
    await prisma.$disconnect();
  });

  const claim = (worker = 'w1', max = 4) =>
    svc.claim(worker, ['ui-snapshot'], max);

  // ── claim ──────────────────────────────────────────────────────────────

  it('двойная выдача: задание, отменённое между чтением кандидатов и переходом, не выдаётся (условие status: queued)', async () => {
    const s = await site();
    const id = await job(s);
    const out = (await withAccountLock(s.accountId, claim, async () => {
      // Та же попытка (attempts 0), но уже не `queued`.
      await prisma.siteBrowserJob.update({
        where: { id },
        data: { status: 'cancelled' },
      });
    })) as Awaited<ReturnType<typeof claim>>;
    expect(out).toEqual([]);
    expect((await status(id)).status).toBe('cancelled');
  });

  it('двойная выдача: задание, переотданное другим воркером (попытка сменилась), не выдаётся второй раз (условие attempts)', async () => {
    const s = await site();
    const id = await job(s);
    const out = (await withAccountLock(s.accountId, claim, async () => {
      // Другой воркер взял и вернул в очередь — снова `queued`, попытка 1.
      await prisma.siteBrowserJob.update({
        where: { id },
        data: { attempts: 1 },
      });
    })) as Awaited<ReturnType<typeof claim>>;
    expect(out).toEqual([]);
    expect(await status(id)).toMatchObject({ status: 'queued', attempts: 1 });
  });

  it('два воркера разом: одно задание — одному', async () => {
    const s = await site();
    const id = await job(s);
    const [a, b] = await Promise.all([claim('w1', 1), claim('w2', 1)]);
    expect([...a, ...b].filter((j) => j.id === id)).toHaveLength(1);
    expect(await status(id)).toMatchObject({ status: 'running', attempts: 1 });
  });

  it('ожидающее с запросом отмены не выдаётся (даже если отмену запросили после чтения); уборка закрывает его cancelled', async () => {
    const s = await site();
    const id = await job(s);
    const out = (await withAccountLock(s.accountId, claim, async () => {
      await prisma.siteBrowserJob.update({
        where: { id },
        data: { cancelRequestedAt: new Date() },
      });
    })) as Awaited<ReturnType<typeof claim>>;
    expect(out).toEqual([]);
    expect((await status(id)).status).toBe('queued');
    const r = await svc.reap(new Date(), { accountIds: [s.accountId] });
    expect(r.cancelledQueued).toBe(1);
    expect(await status(id)).toMatchObject({
      status: 'cancelled',
      errorCode: 'cancelled',
    });
    expect(failed).toEqual([[id, 'cancelled']]);
  });

  it('срок истёк между чтением кандидатов и выдачей — не выдаётся (условие expiresAt в переходе)', async () => {
    const s = await site();
    const id = await job(s);
    const out = (await withAccountLock(s.accountId, claim, async () => {
      await prisma.siteBrowserJob.update({
        where: { id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
    })) as Awaited<ReturnType<typeof claim>>;
    expect(out).toEqual([]);
    expect((await status(id)).status).toBe('queued');
  });

  it('просроченное ожидающее (expiresAt ≤ now) не выдаётся', async () => {
    const s = await site();
    const id = await job(s, { expiresAt: new Date(Date.now() - 1000) });
    expect(await claim()).toEqual([]);
    expect((await status(id)).status).toBe('queued');
  });

  it(`потолок идущих на кабинет (${RUNNING_PER_ACCOUNT}) — пересчёт под замком: задание, ставшее идущим параллельно, учитывается`, async () => {
    const s = await site();
    // Уже идёт RUNNING_PER_ACCOUNT − 1: claim видит свободное место.
    for (let i = 1; i < RUNNING_PER_ACCOUNT; i++)
      await job(s, {
        status: 'running',
        leaseUntil: new Date(Date.now() + 60_000),
        attempts: 1,
      });
    const id = await job(s);
    const other = await job(s, {
      availableAt: new Date(Date.now() + 3600_000),
    });
    const out = (await withAccountLock(s.accountId, claim, async () => {
      // Другой воркер в это время запустил ещё одно задание кабинета.
      await prisma.siteBrowserJob.update({
        where: { id: other },
        data: {
          status: 'running',
          attempts: 1,
          leaseUntil: new Date(Date.now() + 60_000),
        },
      });
    })) as Awaited<ReturnType<typeof claim>>;
    expect(out).toEqual([]);
    expect((await status(id)).status).toBe('queued');
    expect(
      await prisma.siteBrowserJob.count({
        where: { accountId: s.accountId, status: 'running' },
      }),
    ).toBe(RUNNING_PER_ACCOUNT);
  });

  // ── уборка ─────────────────────────────────────────────────────────────

  it('воркер выключен: идущее с истёкшей арендой — failed worker_disabled + уведомление продукта; с живой арендой — не трогается; claim пуст', async () => {
    const s = await site();
    const dead = await job(s, {
      status: 'running',
      attempts: 1,
      leaseUntil: new Date(Date.now() - 1000),
      leaseTokenHash: 'x'.repeat(64),
    });
    const alive = await job(s, {
      status: 'running',
      attempts: 1,
      leaseUntil: new Date(Date.now() + 60_000),
    });
    env.BROWSER_WORKER_ENABLED = 'false';
    expect(await claim()).toEqual([]);
    expect((await status(dead)).status).toBe('running');
    const r = await svc.reap(new Date(), { accountIds: [s.accountId] });
    expect(r).toMatchObject({ failed: 1, requeued: 0 });
    expect(await status(dead)).toMatchObject({
      status: 'failed',
      errorCode: WORKER_DISABLED_CODE,
      leaseTokenHash: null,
    });
    expect((await status(alive)).status).toBe('running');
    expect(failed).toEqual([[dead, WORKER_DISABLED_CODE]]);
  });

  it('воркер включён: истёкшая аренда с попытками — назад в очередь; без попыток — job_timeout', async () => {
    const s = await site();
    const retry = await job(s, {
      status: 'running',
      attempts: 1,
      maxAttempts: 2,
      leaseUntil: new Date(Date.now() - 1000),
    });
    const last = await job(s, {
      status: 'running',
      attempts: 2,
      maxAttempts: 2,
      leaseUntil: new Date(Date.now() - 1000),
    });
    const r = await svc.reap(new Date(), { accountIds: [s.accountId] });
    expect(r).toMatchObject({ requeued: 1, failed: 1 });
    expect((await status(retry)).status).toBe('queued');
    expect(await status(last)).toMatchObject({
      status: 'failed',
      errorCode: 'job_timeout',
    });
  });

  it('«сдано», а обработчик продукта оборвался (result.pending дольше окна) — failed internal + уведомление; свежее — не трогается', async () => {
    const s = await site();
    const old = await job(s, {
      status: 'done',
      result: { pending: true },
      finishedAt: new Date(Date.now() - DONE_PENDING_GRACE_MS - 1000),
    });
    const fresh = await job(s, {
      status: 'done',
      result: { pending: true },
      finishedAt: new Date(Date.now() - 1000),
    });
    const real = await job(s, {
      status: 'done',
      result: { pages: 3 },
      finishedAt: new Date(Date.now() - DONE_PENDING_GRACE_MS - 1000),
    });
    const r = await svc.reap(new Date(), { accountIds: [s.accountId] });
    expect(r.pendingFailed).toBe(1);
    expect(await status(old)).toMatchObject({
      status: 'failed',
      errorCode: 'internal',
      result: null,
    });
    expect((await status(fresh)).status).toBe('done');
    expect((await status(real)).status).toBe('done');
    expect(failed).toEqual([[old, 'internal']]);
  });

  it('сверка продуктов: reconcile обработчиков зовётся, сбой одного не мешает', async () => {
    const calls: string[] = [];
    handlers.register('tutorial-frames', {
      reconcile: () => Promise.reject(new Error('boom')),
    });
    handlers.register('voice-map-check', {
      reconcile: () => {
        calls.push('check');
        return Promise.resolve(2);
      },
    });
    const r = await svc.reap(new Date());
    expect(calls).toEqual(['check']);
    expect(r.reconciled).toBe(2);
  });

  // ── артефакты ──────────────────────────────────────────────────────────

  async function leasedJob(s: Site) {
    await job(s);
    const [j] = await claim();
    return j;
  }
  const art = (idx = 0) => ({
    idx,
    contentType: 'image/jpeg',
    data: JPEG,
    width: null,
    height: null,
  });

  it('одновременная загрузка одного номера (новый) — одна 200, другая 409 WORKER_ARTIFACT_CONFLICT; сирот в Blob нет', async () => {
    const s = await site();
    const j = await leasedJob(s);
    storage.barrier = 2;
    const rs = await Promise.allSettled([
      svc.putArtifact(j.id, j.leaseToken, art()),
      svc.putArtifact(j.id, j.leaseToken, art()),
    ]);
    storage.barrier = 0;
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rej = rs.find(
      (r) => r.status === 'rejected',
    ) as PromiseRejectedResult;
    expect(rej.reason.getStatus()).toBe(409);
    expect(rej.reason.getResponse()).toMatchObject({
      code: 'WORKER_ARTIFACT_CONFLICT',
    });
    const rows = await prisma.siteBrowserArtifact.findMany({
      where: { jobId: j.id },
    });
    expect(rows).toHaveLength(1);
    const mine = [...storage.files.keys()].filter((k) => k.includes(j.id));
    expect(mine).toEqual([rows[0].pathname]);
  });

  it('замена номера: старый Blob не удалился — 503, строка указывает на прежний Blob; потом — замена', async () => {
    const s = await site();
    const j = await leasedJob(s);
    await svc.putArtifact(j.id, j.leaseToken, art());
    const before = await prisma.siteBrowserArtifact.findFirstOrThrow({
      where: { jobId: j.id },
    });
    storage.failRemove = true;
    await expect(
      svc.putArtifact(j.id, j.leaseToken, art()),
    ).rejects.toMatchObject({ status: 503 });
    storage.failRemove = false;
    expect(
      (
        await prisma.siteBrowserArtifact.findFirstOrThrow({
          where: { jobId: j.id },
        })
      ).pathname,
    ).toBe(before.pathname);
    expect(storage.files.has(before.pathname)).toBe(true);
    await svc.putArtifact(j.id, j.leaseToken, art());
    const after = await prisma.siteBrowserArtifact.findFirstOrThrow({
      where: { jobId: j.id },
    });
    expect(after.pathname).not.toBe(before.pathname);
    expect(storage.files.has(before.pathname)).toBe(false);
    expect(storage.files.has(after.pathname)).toBe(true);
  });

  // ── ретенция ───────────────────────────────────────────────────────────

  it('ретенция: Blob не удалился — строка артефакта и задание остаются до следующего прогона', async () => {
    const s = await site();
    const j = await leasedJob(s);
    await svc.putArtifact(j.id, j.leaseToken, art());
    await prisma.siteBrowserJob.update({
      where: { id: j.id },
      data: { status: 'done', leaseTokenHash: null, leaseUntil: null },
    });
    const later = new Date(Date.now() + 30 * 86_400_000);
    storage.failRemove = true;
    const r1 = await svc.runRetention(later, { accountIds: [s.accountId] });
    expect(r1.blobErrors).toBeGreaterThan(0);
    expect(r1.artifactsPurged).toBe(0);
    expect(
      await prisma.siteBrowserArtifact.count({ where: { jobId: j.id } }),
    ).toBe(1);
    expect(await prisma.siteBrowserJob.count({ where: { id: j.id } })).toBe(1);
    storage.failRemove = false;
    const r2 = await svc.runRetention(later, { accountIds: [s.accountId] });
    expect(r2.artifactsPurged).toBe(1);
    expect(await prisma.siteBrowserJob.count({ where: { id: j.id } })).toBe(0);
    expect([...storage.files.keys()].some((k) => k.includes(j.id))).toBe(false);
  });
});
