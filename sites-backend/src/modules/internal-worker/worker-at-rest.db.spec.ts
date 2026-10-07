/**
 * Ш3-хвост (7) на НАСТОЯЩЕМ Postgres: секреты учётки «только для воркера»
 * (продукт — ровно `assist-admin`) запечатываются под открытый ключ воркера
 * ПРИ ЗАПИСИ — в базе конверт `v1.…` и `keyVersion = worker:<kid>`, KEK не
 * нужен ни при записи, ни при выдаче; канал воркера отдаёт конверт как есть
 * внутри конверта задания, и открыть его может только закрытый ключ воркера
 * (AAD — кабинет, сайт, учётка, назначение). Записи под KEK (до правки)
 * выдаются по-старому. Открыть учётку другим продуктам без нового пароля
 * нельзя (409), с паролем — пароль под KEK, прочие конверты стёрты. Ротация
 * KEK конверты воркера не трогает и считает их по ключам.
 *
 * Спек — в канале воркера: только он вправе импортировать и хранилище, и
 * `browser-jobs/worker-seal` (правило графа `worker-seal-private`).
 */
import { randomUUID } from 'crypto';
import type { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import { BrowserJobsService } from '../browser-jobs/browser-jobs.service';
import { BrowserJobHandlers } from '../browser-jobs/job-handlers';
import { FakeArtifactStorage } from '../browser-jobs/testing/fake-artifact-storage.testing';
import {
  cancelActiveJobs,
  serializeQueueTests,
} from '../browser-jobs/testing/jobs-db.testing';
import {
  generateWorkerSealKeys,
  openSealed,
  sealAad,
} from '../browser-jobs/worker-seal';
import {
  CabinetFixture,
  CredStack,
  credStack,
  credentialRows,
  describeDb,
  dropCabinet,
  ownerPrisma,
  seedCabinet,
  testKey,
} from '../site-credentials/testing/credentials-db.testing';
import { workerKeyVersion } from '../site-credentials/worker-at-rest';
import { InternalWorkerService } from './internal-worker.service';

jest.setTimeout(120_000);

const keys = generateWorkerSealKeys();
const KEK = { SITE_CREDENTIALS_KEYS: `v1:${testKey()}` };
const PASSWORD = 'Pw-at-rest-марка-2f9c41';

describeDb(
  'учётки «Админки»: запечатывание под ключ воркера при записи (Ш3-хвост (7))',
  () => {
    serializeQueueTests();
    let prisma: PrismaService;
    let s: CredStack;
    let jobs: BrowserJobsService;
    let worker: InternalWorkerService;
    let f: CabinetFixture;
    const cabinets: CabinetFixture[] = [];
    const env: NodeJS.ProcessEnv = {
      BROWSER_WORKER_ENABLED: 'true',
      SITES_WORKER_SEAL_PUBLIC_KEY: keys.publicKey,
    };

    beforeAll(() => {
      prisma = ownerPrisma();
      s = credStack(prisma, KEK);
      jobs = new BrowserJobsService(
        new SitesDb(prisma),
        new FakeArtifactStorage(),
        new BrowserJobHandlers(),
      );
      jobs.env = env;
      worker = new InternalWorkerService(jobs, s.svc);
      worker.env = env;
      worker.onModuleInit();
    });
    beforeEach(async () => {
      s.svc.env = KEK;
      env.SITES_WORKER_SEAL_PUBLIC_KEY = keys.publicKey;
      await cancelActiveJobs(prisma);
      f = await seedCabinet(prisma);
      cabinets.push(f);
    });
    afterAll(async () => {
      for (const c of cabinets) await dropCabinet(prisma, c);
      await prisma.$disconnect();
    });

    const actor = () => `tma:${f.telegramId}`;

    async function adminAccount(products = ['assist-admin']) {
      return s.svc.create(
        f.accountId,
        f.siteId,
        {
          label: 'Менеджер',
          username: 'manager',
          password: PASSWORD,
          hostIds: [f.verifiedHostId],
          products: products as never,
        },
        actor(),
      );
    }

    /** Обход «Админки» под арендой воркера → то, что получит воркер. */
    async function issued(testAccountId: string) {
      const host = await prisma.siteHost.findUniqueOrThrow({
        where: { id: f.verifiedHostId },
      });
      const view = await jobs.enqueue(f.accountId, {
        siteId: f.siteId,
        hostId: f.verifiedHostId,
        origin: 'assist-admin-crawl',
        testAccountId,
        requestedBy: 'system',
        idempotencyKey: `t-${randomUUID()}`,
        params: {
          startUrl: `https://${host.host}/admin`,
          allowedHosts: [host.host],
          viewport: 'desktop',
          maxPages: 1,
          maxDepth: 0,
          loginMethod: 'password',
        },
      });
      const claimed = await jobs.claim('bw-rest', ['admin-crawl'], 4);
      const c = claimed.find((j) => j.id === view.id)!;
      const res = await worker.credentials(c.id, c.leaseToken);
      const outer = JSON.parse(
        openSealed(
          keys.privateKey,
          res.sealed,
          sealAad(c.id, c.attempt),
        ).toString('utf8'),
      ) as {
        username: string | null;
        password: string | null;
        stored: Array<{ purpose: string; sealed: string; aad: string }>;
      };
      return outer;
    }

    it('запись: конверт под ключ воркера, KEK не нужен; выдача — как есть, открывает только воркер', async () => {
      s.svc.env = {}; // KEK не настроен вовсе
      const acc = await adminAccount();
      const row = (await credentialRows(prisma, acc.id)).find(
        (r) => r.purpose === 'password',
      )!;
      expect(row.keyVersion).toBe(workerKeyVersion(keys.publicKey));
      expect(row.ciphertext.startsWith('v1.')).toBe(true);
      expect(row.ciphertext).not.toContain(PASSWORD);
      expect(acc.secrets.password).toBe(true);
      const outer = await issued(acc.id);
      expect(outer.password).toBeNull();
      expect(outer.username).toBe('manager');
      expect(outer.stored).toHaveLength(1);
      const inner = outer.stored[0];
      expect(inner.purpose).toBe('password');
      // Конверт в выдаче — ровно тот, что в базе (sites-backend его не открывал).
      expect(inner.sealed).toBe(row.ciphertext);
      expect(
        openSealed(keys.privateKey, inner.sealed, inner.aad).toString('utf8'),
      ).toBe(PASSWORD);
      // Переставленный в чужую учётку конверт не открывается.
      expect(() =>
        openSealed(
          keys.privateKey,
          inner.sealed,
          inner.aad.replace(acc.id, 'other'),
        ),
      ).toThrow();
    });

    it('учётка с другими продуктами — под KEK, как раньше; старые записи под KEK выдаются по-старому', async () => {
      const mixed = await adminAccount(['assist-admin', 'tutorial']);
      const mrow = (await credentialRows(prisma, mixed.id))[0];
      expect(mrow.keyVersion).toBe('v1');
      // «До правки»: канал воркера не подключён — запись под KEK.
      s.svc.useWorkerSealer(null);
      const legacy = await adminAccount();
      worker.onModuleInit();
      const lrow = (await credentialRows(prisma, legacy.id))[0];
      expect(lrow.keyVersion).toBe('v1');
      const outer = await issued(legacy.id);
      expect(outer.password).toBe(PASSWORD);
      expect(outer.stored).toEqual([]);
    });

    it('открыть другим продуктам — только с новым паролем (409), прочие конверты стёрты', async () => {
      const acc = await adminAccount();
      await s.svc.putSecret(
        f.accountId,
        acc.id,
        'session-cookies',
        '[{"name":"sid","value":"x"}]',
        actor(),
      );
      const sealedCookies = (await credentialRows(prisma, acc.id)).find(
        (r) => r.purpose === 'session-cookies',
      )!;
      expect(sealedCookies.keyVersion.startsWith('worker:')).toBe(true);
      await expect(
        s.svc.update(
          f.accountId,
          f.siteId,
          acc.id,
          { products: ['assist-admin', 'qa'] as never },
          actor(),
        ),
      ).rejects.toMatchObject({
        response: { code: 'TEST_ACCOUNT_WORKER_SEALED' },
      });
      const after = await s.svc.update(
        f.accountId,
        f.siteId,
        acc.id,
        { products: ['assist-admin', 'qa'] as never, password: PASSWORD },
        actor(),
      );
      expect(after.products).toEqual(['assist-admin', 'qa']);
      const rows = await credentialRows(prisma, acc.id);
      expect(rows.map((r) => [r.purpose, r.keyVersion])).toEqual([
        ['password', 'v1'],
      ]);
    });

    it('ротация KEK: конверты воркера не трогаются и считаются по ключу', async () => {
      const acc = await adminAccount();
      const before = (await credentialRows(prisma, acc.id))[0];
      const k2 = testKey();
      s.svc.env = {
        SITE_CREDENTIALS_KEYS: `${KEK.SITE_CREDENTIALS_KEYS},v2:${k2}`,
        SITE_CREDENTIALS_KEY_CURRENT: 'v2',
      };
      const rep = await s.svc.rotateKeys({ apply: true });
      expect(rep.byVersion[workerKeyVersion(keys.publicKey)]).toBeGreaterThan(
        0,
      );
      expect(rep.failed).toBe(0);
      const after = (await credentialRows(prisma, acc.id))[0];
      expect(after.ciphertext).toBe(before.ciphertext);
      expect(after.keyVersion).toBe(before.keyVersion);
    });
  },
);
