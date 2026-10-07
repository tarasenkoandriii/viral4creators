/**
 * Раунд исследователя обучалки на воркере (Ш3-хвост (3)) — очередь на
 * НАСТОЯЩЕМ Postgres:
 *  - задание без кабинета (режим B, `tutorial-explore-open`): без сайта и
 *    хоста, ключ `gen-<subject>`, лимиты на человека и на хост; выдаётся без
 *    проверки хоста кабинета; без ключа конверта воркера — не выдаётся;
 *  - вход учёткой реестра (`tutorial-explore`, режим A): учётка нужна,
 *    аренда — продукта `tutorial`;
 *  - триггер базы: open — только без сайта/хоста и с ключом `gen-`, задание
 *    кабинета — только с ними; сессия в параметрах — только конвертом;
 *  - сдача: результат ссылается на съёмочный кадр — он должен быть загружен.
 */
import { randomUUID } from 'crypto';
import type { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import { OPEN_LIMITS } from './browser-job-rules';
import { BrowserJobsService } from './browser-jobs.service';
import { BrowserJobHandlers } from './job-handlers';
import { exploreFillAad, exploreSessionAad } from './protocol';
import { FakeArtifactStorage } from './testing/fake-artifact-storage.testing';
import {
  describeDb,
  ownerPrisma,
  serializeQueueTests,
} from './testing/jobs-db.testing';
import { generateWorkerSealKeys, sealForWorker } from './worker-seal';

jest.setTimeout(120_000);

const keys = generateWorkerSealKeys();
const reply = generateWorkerSealKeys();
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]).toString('base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]).toString('base64');

describeDb('очередь: раунд обучалки на воркере (Ш3-хвост (3))', () => {
  serializeQueueTests();
  let prisma: PrismaService;
  let svc: BrowserJobsService;
  const env: NodeJS.ProcessEnv = {
    BROWSER_WORKER_ENABLED: 'true',
    SITES_WORKER_SEAL_PUBLIC_KEY: keys.publicKey,
  };
  const subjects: string[] = [];
  const accounts: string[] = [];

  const params = (host: string, extra: Record<string, unknown> = {}) => {
    const nonce = randomUUID().replace(/-/g, '');
    return {
      url: `https://${host}/cart`,
      allowedHosts: [host],
      allowedOrigin: `https://${host}`,
      viewport: 'mobile',
      clicks: ['#next'],
      fills: [],
      replay: null,
      login: null,
      session: sealForWorker(
        keys.publicKey,
        Buffer.from('[]'),
        exploreSessionAad({
          nonce,
          replyKey: reply.publicKey,
          allowedHosts: [host],
        }),
      ),
      replyKey: reply.publicKey,
      nonce,
      videoFrame: true,
      ...extra,
    };
  };
  const subject = () => {
    const s = `tg-${randomUUID().slice(0, 8)}`;
    subjects.push(s);
    return s;
  };
  const host = () => `x.texp-${randomUUID().slice(0, 8)}.com`;

  beforeAll(() => {
    prisma = ownerPrisma();
    svc = new BrowserJobsService(
      new SitesDb(prisma),
      new FakeArtifactStorage(),
      new BrowserJobHandlers(),
    );
    svc.env = env;
  });

  beforeEach(async () => {
    env.BROWSER_WORKER_ENABLED = 'true';
    env.SITES_WORKER_SEAL_PUBLIC_KEY = keys.publicKey;
    await prisma.siteBrowserJob.updateMany({
      where: { status: { in: ['queued', 'running'] } },
      data: { status: 'cancelled' },
    });
  });

  afterAll(async () => {
    await prisma.siteBrowserJob.deleteMany({
      where: { accountId: { in: subjects.map((s) => `gen-${s}`) } },
    });
    await prisma.siteAccount.deleteMany({ where: { id: { in: accounts } } });
    await prisma.$disconnect();
  });

  it('режим B: без сайта и хоста, ключ gen-<subject>, выдаётся без проверки хоста; без ключа конверта — нет', async () => {
    const s = subject();
    const h = host();
    const view = await svc.enqueueOpen({
      subject: s,
      origin: 'tutorial-explore-open',
      params: params(h) as never,
      requestedBy: `generator:${s}`,
    });
    const row = await prisma.siteBrowserJob.findUniqueOrThrow({
      where: { id: view.id },
    });
    expect(row).toMatchObject({
      accountId: `gen-${s}`,
      siteId: null,
      hostId: null,
      // Аудит захода 7: лимит «на хост» — по регистрируемому домену.
      refId: h.slice('x.'.length),
      kind: 'tutorial-explore',
      maxAttempts: 1,
    });
    env.SITES_WORKER_SEAL_PUBLIC_KEY = '';
    expect(await svc.claim('bw-1', ['tutorial-explore'], 4)).toEqual([]);
    env.SITES_WORKER_SEAL_PUBLIC_KEY = keys.publicKey;
    const got = await svc.claim('bw-1', ['tutorial-explore'], 4);
    expect(got.map((j) => j.id)).toEqual([view.id]);
    expect(got[0].needsCredentials).toBe(false);
  });

  it('лимиты: на человека — активные; на хост — по всем людям', async () => {
    const s = subject();
    const h = host();
    for (let i = 0; i < OPEN_LIMITS.activePerSubject; i++) {
      await svc.enqueueOpen({
        subject: s,
        origin: 'tutorial-explore-open',
        params: params(h) as never,
        requestedBy: 'generator:t',
      });
    }
    await expect(
      svc.enqueueOpen({
        subject: s,
        origin: 'tutorial-explore-open',
        params: params(h) as never,
        requestedBy: 'generator:t',
      }),
    ).rejects.toMatchObject({ response: { code: 'BROWSER_JOB_BUSY' } });
    const h2 = host();
    for (let i = 0; i < OPEN_LIMITS.activePerHost; i++) {
      await svc.enqueueOpen({
        subject: subject(),
        origin: 'tutorial-explore-open',
        params: params(h2) as never,
        requestedBy: 'generator:t',
      });
    }
    await expect(
      svc.enqueueOpen({
        subject: subject(),
        origin: 'tutorial-explore-open',
        params: params(h2) as never,
        requestedBy: 'generator:t',
      }),
    ).rejects.toMatchObject({ response: { code: 'BROWSER_JOB_BUSY' } });
  });

  it('выключенный воркер — 409 BROWSER_WORKER_DISABLED; задание кабинета через enqueueOpen — нельзя', async () => {
    env.BROWSER_WORKER_ENABLED = 'false';
    await expect(
      svc.enqueueOpen({
        subject: subject(),
        origin: 'tutorial-explore-open',
        params: params(host()) as never,
        requestedBy: 'generator:t',
      }),
    ).rejects.toMatchObject({ response: { code: 'BROWSER_WORKER_DISABLED' } });
    env.BROWSER_WORKER_ENABLED = 'true';
    await expect(
      svc.enqueueOpen({
        subject: subject(),
        origin: 'tutorial-explore',
        params: params(host()) as never,
        requestedBy: 'generator:t',
      }),
    ).rejects.toThrow(/только задания без хоста/);
  });

  it('триггер: open с сайтом, кабинетное без сайта, сессия открытым текстом — отказ', async () => {
    const account = await prisma.siteAccount.create({
      data: { verifyToken: `texp-${randomUUID()}` },
    });
    accounts.push(account.id);
    const site = await prisma.site.create({
      data: { accountId: account.id, name: 'texp' },
    });
    const h = host();
    const base = {
      kind: 'tutorial-explore',
      params: params(h),
      expiresAt: new Date(Date.now() + 3600_000),
    };
    await expect(
      prisma.siteBrowserJob.create({
        data: {
          ...base,
          accountId: account.id,
          siteId: site.id,
          origin: 'tutorial-explore-open',
        },
      }),
    ).rejects.toThrow(/без кабинета/);
    await expect(
      prisma.siteBrowserJob.create({
        data: { ...base, accountId: 'gen-x', origin: 'tutorial-explore' },
      }),
    ).rejects.toThrow(/кабинета/);
    await expect(
      prisma.siteBrowserJob.create({
        data: {
          ...base,
          accountId: 'gen-y',
          origin: 'tutorial-explore-open',
          params: { ...params(h), session: '[{"name":"sid","value":"1"}]' },
        },
      }),
    ).rejects.toThrow(/конвертом/);
    await expect(
      prisma.siteBrowserJob.create({
        data: {
          ...base,
          accountId: 'gen-z',
          origin: 'tutorial-explore-open',
          params: { ...params(h), cookies: [] },
        },
      }),
    ).rejects.toThrow(/секреты/);
    // Аудит захода 7: сессия объектом/массивом, ввод и шаги переигровки
    // открытым текстом, источник раунда с чужим видом — отказ базы.
    const open = {
      ...base,
      accountId: 'gen-w',
      origin: 'tutorial-explore-open',
    };
    for (const [bad, re] of [
      [{ session: { name: 'sid' } }, /сессия/],
      [{ session: ['sid'] }, /сессия/],
      [{ fills: [{ selector: '#pw', value: 'секрет' }] }, /ввода/],
      [{ fills: { selector: '#pw' } }, /ввода/],
      [
        {
          session: null,
          replay: [
            { kind: 'goto', url: `https://${h}/` },
            {
              kind: 'fill',
              selector: '#pw',
              value: 'секрет',
              passwordOnly: true,
            },
          ],
        },
        /переигровки/,
      ],
      [{ session: null, replay: { kind: 'goto' } }, /переигровки/],
    ] as const) {
      await expect(
        prisma.siteBrowserJob.create({
          data: { ...open, params: { ...params(h), ...bad } },
        }),
      ).rejects.toThrow(re);
    }
    await expect(
      prisma.siteBrowserJob.create({
        data: { ...open, kind: 'ui-snapshot' },
      }),
    ).rejects.toThrow(/не для вида/);
    // Конверт значения — принимается.
    const okFill = sealForWorker(
      keys.publicKey,
      Buffer.from('x'),
      exploreFillAad(
        { nonce: 'n', replyKey: reply.publicKey, allowedHosts: [h] },
        0,
      ),
    );
    const ok = await prisma.siteBrowserJob.create({
      data: {
        ...open,
        params: { ...params(h), fills: [{ selector: '#pw', value: okFill }] },
      },
    });
    await prisma.siteBrowserJob.delete({ where: { id: ok.id } });
  });

  it('лимит на хост — общий для поддоменов одного сайта (регистрируемый домен)', async () => {
    const tag = randomUUID().slice(0, 8);
    for (let i = 0; i < OPEN_LIMITS.activePerHost; i++) {
      await svc.enqueueOpen({
        subject: subject(),
        origin: 'tutorial-explore-open',
        params: params(`s${i}.reg-${tag}.org`) as never,
        requestedBy: 'generator:t',
      });
    }
    await expect(
      svc.enqueueOpen({
        subject: subject(),
        origin: 'tutorial-explore-open',
        params: params(`other.reg-${tag}.org`) as never,
        requestedBy: 'generator:t',
      }),
    ).rejects.toMatchObject({ response: { code: 'BROWSER_JOB_BUSY' } });
  });

  it('вход учёткой реестра: учётка нужна, аренда — продукта tutorial', async () => {
    const account = await prisma.siteAccount.create({
      data: { verifyToken: `texp-${randomUUID()}` },
    });
    accounts.push(account.id);
    const site = await prisma.site.create({
      data: { accountId: account.id, name: 'texp-a' },
    });
    const h = host();
    const sh = await prisma.siteHost.create({
      data: {
        accountId: account.id,
        siteId: site.id,
        host: h,
        status: 'verified',
        method: 'dns',
        verifiedAt: new Date(Date.now() - 60_000),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const view = await svc.enqueue(account.id, {
      siteId: site.id,
      hostId: sh.id,
      origin: 'tutorial-explore',
      testAccountId: 'ta-1',
      requestedBy: 'generator:1',
      params: params(h, {
        clicks: [],
        login: { needUsername: true, pick: null },
      }) as never,
    });
    const [claimed] = await svc.claim('bw-2', ['tutorial-explore'], 1);
    expect(claimed.id).toBe(view.id);
    expect(claimed.needsCredentials).toBe(true);
    const ctx = await svc.markCredentialsIssued(view.id, claimed.leaseToken);
    expect(ctx).toMatchObject({
      product: 'tutorial',
      hostId: sh.id,
      testAccountId: 'ta-1',
    });
  });

  it('сдача: ссылка на незагруженный съёмочный кадр — отказ; загружен — принято', async () => {
    const s = subject();
    const h = host();
    const view = await svc.enqueueOpen({
      subject: s,
      origin: 'tutorial-explore-open',
      params: params(h) as never,
      requestedBy: 'generator:t',
    });
    const [c] = await svc.claim('bw-3', ['tutorial-explore'], 1);
    expect(c.id).toBe(view.id);
    const result = {
      currentUrl: `https://${h}/cart?step=2`,
      elements: [{ selector: '#next', tag: 'button', visibleText: 'Далі' }],
      looksLikeLogin: false,
      screenshot: 0,
      videoFrame: 1,
      reply: null,
      sensitiveFill: false,
      autoLogin: null,
    };
    await svc.putArtifact(c.id, c.leaseToken, {
      idx: 0,
      contentType: 'image/jpeg',
      width: 390,
      height: 844,
      data: JPEG,
    });
    await expect(
      svc.complete(c.id, c.leaseToken, result),
    ).rejects.toMatchObject({ response: { code: 'WORKER_BAD_RESULT' } });
    await svc.putArtifact(c.id, c.leaseToken, {
      idx: 1,
      contentType: 'image/png',
      width: 780,
      height: 1688,
      data: PNG,
    });
    await svc.complete(c.id, c.leaseToken, result);
    const done = await svc.view(`gen-${s}`, c.id);
    expect(done?.status).toBe('done');
    // Открытый адрес — без query (ПД — только в конверте ответа).
    expect((done?.result as { currentUrl: string }).currentUrl).toBe(
      `https://${h}/cart`,
    );
    const links = await svc.artifactLinks(`gen-${s}`, c.id);
    expect(links.map((l) => l.idx)).toEqual([0, 1]);
  });
});
