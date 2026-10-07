/**
 * Раунд исследователя обучалки на воркере (Ш3-хвост (3)) — канал
 * генератора по HTTP на НАСТОЯЩЕМ Postgres: подпись обучалки, потолок тела
 * канала учётных данных (сессия-конверт ~150 КБ проходит), строгий разбор,
 * режим B без подтверждения (точные хосты черновика), режим A со входом
 * учёткой реестра только на подтверждённом хосте, статус/отмена только
 * своему человеку, результат и ссылки на кадры после сдачи.
 */
import {
  DynamicModule,
  INestApplication,
  Logger,
  Module,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomBytes, randomUUID } from 'crypto';
import * as request from 'supertest';
import { configureApp } from '../../app.setup';
import { loadConfiguration } from '../../config/configuration';
import type { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import {
  SITES_CALLER_TUTORIAL,
  sitesSignatureHeaders,
} from '../../shared/sites-internal-signature';
import { BrowserArtifactStorage } from '../browser-jobs/artifact-storage';
import { BrowserJobsService } from '../browser-jobs/browser-jobs.service';
import { FakeArtifactStorage } from '../browser-jobs/testing/fake-artifact-storage.testing';
import {
  browserJobRow,
  deleteJobsOf,
  serializeQueueTests,
} from '../browser-jobs/testing/jobs-db.testing';
import {
  sealFillForTests,
  sealSessionForTests,
  workerKeysForTests,
} from '../browser-jobs/testing/explore-seal.testing';
import { OwnershipChecker } from '../site-core/ownership/ownership-checker';
import {
  CabinetFixture,
  describeDb,
  dropCabinet,
  ownerPrisma,
  seedCabinet,
} from '../site-credentials/testing/credentials-db.testing';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import {
  TEST_ASSIST_TOKEN,
  TEST_QA_TOKEN,
} from '../telegram-auth/test-init-data';
import { InternalSitesModule } from './internal-sites.module';
import { InternalRequestLedger } from './request-ledger';
import { TutorialExploreService } from './tutorial-explore.service';
import { TutorialHmacGuard } from './tutorial-hmac.guard';

@Module({})
class RealDbModule {
  static with(db: SitesDb): DynamicModule {
    return {
      module: RealDbModule,
      global: true,
      providers: [{ provide: SitesDb, useValue: db }],
      exports: [SitesDb],
    };
  }
}

jest.setTimeout(120_000);

const SECRET = 'e'.repeat(48);
const BASE = '/internal/sites/credentials/tutorial-explore';
const keys = workerKeysForTests();
const reply = workerKeysForTests();
const ENV_KEYS = [
  'ASSIST_BOT_TOKEN',
  'QA_BOT_TOKEN',
  'ALLOW_DEV_AUTH',
] as const;

describeDb(
  'internal-sites: раунд обучалки на воркере по HTTP (Ш3-хвост (3))',
  () => {
    // claim здесь — глобальный: не параллельно с другими файлами очереди.
    serializeQueueTests();
    let app: INestApplication;
    let prisma: PrismaService;
    let jobs: BrowserJobsService;
    let f: CabinetFixture;
    const cabinets: CabinetFixture[] = [];
    const subjects: string[] = [];
    const saved: Record<string, string | undefined> = {};
    const env: NodeJS.ProcessEnv = {
      BROWSER_WORKER_ENABLED: 'true',
      SITES_WORKER_SEAL_PUBLIC_KEY: keys.publicKey,
    };

    beforeAll(async () => {
      Logger.overrideLogger(false);
      for (const k of ENV_KEYS) saved[k] = process.env[k];
      process.env.ASSIST_BOT_TOKEN = TEST_ASSIST_TOKEN;
      process.env.QA_BOT_TOKEN = TEST_QA_TOKEN;
      delete process.env.ALLOW_DEV_AUTH;
      prisma = ownerPrisma();
      const mod = await Test.createTestingModule({
        imports: [
          RealDbModule.with(new SitesDb(prisma)),
          TelegramAuthModule,
          InternalSitesModule,
        ],
      })
        .overrideProvider(OwnershipChecker)
        .useValue({})
        .overrideProvider(InternalRequestLedger)
        .useValue({ claim: () => Promise.resolve(true) })
        .overrideProvider(BrowserArtifactStorage)
        .useValue(new FakeArtifactStorage())
        .compile();
      mod.get(TutorialHmacGuard).env = { SITES_TUTORIAL_HMAC_SECRET: SECRET };
      jobs = mod.get(BrowserJobsService);
      jobs.env = env;
      mod.get(TutorialExploreService).env = env;
      app = mod.createNestApplication();
      configureApp(app, loadConfiguration({}));
      await app.init();
    });

    afterAll(async () => {
      await app.close();
      for (const c of cabinets) await dropCabinet(prisma, c);
      await deleteJobsOf(
        prisma,
        subjects.map((s) => `gen-${s}`),
      );
      await prisma.$disconnect();
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });

    beforeEach(async () => {
      env.BROWSER_WORKER_ENABLED = 'true';
      env.SITES_WORKER_SEAL_PUBLIC_KEY = keys.publicKey;
      f = await seedCabinet(prisma);
      cabinets.push(f);
    });

    function call(route: string, payload: unknown) {
      const path = route.startsWith('/') ? route : `${BASE}/${route}`;
      const body = JSON.stringify(payload);
      const headers = sitesSignatureHeaders(SECRET, {
        caller: SITES_CALLER_TUTORIAL,
        method: 'POST',
        path,
        body,
        unixSeconds: Math.floor(Date.now() / 1000),
        requestId: randomUUID(),
      });
      return request(app.getHttpServer())
        .post(path)
        .set('Content-Type', 'application/json')
        .set(headers)
        .send(body);
    }

    const subject = () => {
      const s = `tg-${randomUUID().slice(0, 8)}`;
      subjects.push(s);
      return s;
    };

    const body = (
      host: string,
      extra: Record<string, unknown> = {},
      sessionBytes = 64,
    ) => {
      const nonce = randomBytes(18).toString('base64url');
      return {
        subject: subject(),
        url: `https://${host}/cart`,
        allowedOrigin: `https://${host}`,
        clicks: ['#next'],
        session: sealSessionForTests(
          keys.publicKey,
          randomBytes(sessionBytes),
          {
            nonce,
            replyKey: reply.publicKey,
            allowedHosts: [host],
          },
        ),
        replyKey: reply.publicKey,
        nonce,
        videoFrame: true,
        ...extra,
      };
    };

    it('ключ конверта: воркер выключен или ключа нет — 409 BROWSER_WORKER_DISABLED', async () => {
      const ok = await call('seal-key', {}).expect(200);
      expect(ok.body.data).toEqual({ publicKey: keys.publicKey });
      env.SITES_WORKER_SEAL_PUBLIC_KEY = '';
      const no = await call('seal-key', {}).expect(409);
      expect(no.body.error.code).toBe('BROWSER_WORKER_DISABLED');
      env.SITES_WORKER_SEAL_PUBLIC_KEY = keys.publicKey;
      env.BROWSER_WORKER_ENABLED = 'false';
      const off = await call('request', body(`b.${f.domain}`)).expect(409);
      expect(off.body.error.code).toBe('BROWSER_WORKER_DISABLED');
    });

    it('режим B: неподтверждённый хост, сессия ~150 КБ — поставлено; статус — только своему; отмена ожидающего', async () => {
      const b = body(`b.${f.domain}`, {}, 110_000);
      expect(JSON.stringify(b).length).toBeGreaterThan(140_000);
      const res = await call('request', b).expect(200);
      expect(res.body.data).toMatchObject({ status: 'queued', mode: 'B' });
      const jobId = res.body.data.jobId as string;
      const st = await call('status', { subject: b.subject, jobId }).expect(
        200,
      );
      expect(st.body.data).toMatchObject({
        jobId,
        status: 'queued',
        result: null,
        artifacts: [],
      });
      const other = await call('status', {
        subject: subject(),
        jobId,
      }).expect(404);
      expect(other.body.error.code).toBe('TUTORIAL_EXPLORE_NOT_FOUND');
      const c = await call('cancel', { subject: b.subject, jobId }).expect(200);
      expect(c.body.data).toEqual({ jobId, status: 'cancelled' });
    });

    it('замок: адрес не того сайта, лишнее поле, клик движком Playwright — отказ', async () => {
      const off = await call('request', {
        ...body(`b.${f.domain}`),
        allowedOrigin: 'https://evil.example.org',
      }).expect(409);
      expect(off.body.error.code).toBe('TUTORIAL_EXPLORE_HOST');
      const extra = await call('request', {
        ...body(`b.${f.domain}`),
        cookies: [],
      }).expect(400);
      expect(extra.body.error.code).toBe('INTERNAL_BAD_BODY');
      const engine = await call(
        'request',
        body(`b.${f.domain}`, { clicks: ['text=Купити'] }),
      ).expect(400);
      expect(engine.body.error.code).toBe('INTERNAL_BAD_BODY');
    });

    it('вход учёткой реестра: только подтверждённый хост кабинета; статус — по telegramId', async () => {
      const registry = {
        telegramId: f.telegramId.toString(),
        testAccountId: 'ta-x',
        needUsername: true,
        pick: null,
      };
      const res = await call(
        'request',
        body(`shop.${f.domain}`, { clicks: [], registry }),
      ).expect(200);
      expect(res.body.data.mode).toBe('A');
      const jobId = res.body.data.jobId as string;
      const st = await call('status', {
        subject: subject(),
        jobId,
        telegramId: f.telegramId.toString(),
      }).expect(200);
      expect(st.body.data.status).toBe('queued');
      const row = await browserJobRow(prisma, jobId);
      expect(row).toMatchObject({
        accountId: f.accountId,
        origin: 'tutorial-explore',
        testAccountId: 'ta-x',
      });
      // Пароля в параметрах нет — только признак «вход учёткой».
      expect(JSON.stringify(row.params)).not.toMatch(/password"\s*:/);
      const pending = await call(
        'request',
        body(`admin.${f.domain}`, { clicks: [], registry }),
      ).expect(409);
      expect(pending.body.error.code).toBe('TUTORIAL_EXPLORE_HOST');
      await jobs.cancel(f.accountId, jobId);
    });

    it('после сдачи: результат и подписанные ссылки на предпросмотр и кадр', async () => {
      const b = body(`b.${f.domain}`);
      const res = await call('request', b).expect(200);
      const jobId = res.body.data.jobId as string;
      const claimed = await jobs.claim('bw-http', ['tutorial-explore'], 4);
      const c = claimed.find((j) => j.id === jobId)!;
      await jobs.putArtifact(c.id, c.leaseToken, {
        idx: 0,
        contentType: 'image/jpeg',
        width: 390,
        height: 844,
        data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]).toString('base64'),
      });
      await jobs.complete(c.id, c.leaseToken, {
        currentUrl: `https://b.${f.domain}/cart?step=2`,
        elements: [{ selector: '#next', tag: 'button', visibleText: 'Далі' }],
        looksLikeLogin: false,
        screenshot: 0,
        videoFrame: null,
        reply: null,
        sensitiveFill: false,
        autoLogin: null,
      });
      const st = await call('status', { subject: b.subject, jobId }).expect(
        200,
      );
      expect(st.body.data.status).toBe('done');
      expect(st.body.data.result.currentUrl).toBe(`https://b.${f.domain}/cart`);
      expect(st.body.data.artifacts).toEqual([
        expect.objectContaining({ idx: 0, contentType: 'image/jpeg' }),
      ]);
      expect(st.body.data.artifacts[0].url).toMatch(/^fake-blob:\/\//);
    });

    it('аудит захода 7: ввод и переигровка (режим B) — конвертами; замок — хосты переигровки одного сайта', async () => {
      const host = `b.${f.domain}`;
      const b = body(host, { clicks: [] });
      const parts = {
        nonce: b.nonce,
        replyKey: b.replyKey,
        allowedHosts: [host],
      };
      const res = await call('request', {
        ...b,
        fills: [
          {
            selector: '#pw',
            value: sealFillForTests(keys.publicKey, 'секрет', parts, 0),
          },
        ],
      }).expect(200);
      const row = await browserJobRow(prisma, res.body.data.jobId as string);
      expect(JSON.stringify(row.params)).not.toContain('секрет');
      const plain = await call('request', {
        ...body(host),
        fills: [{ selector: '#pw', value: 'секрет' }],
      }).expect(400);
      expect(plain.body.error.code).toBe('INTERNAL_BAD_BODY');
      const replayOf = (second: string) => {
        const rb = body(host, { clicks: [], session: null });
        return {
          ...rb,
          replay: [
            { kind: 'goto', url: rb.url },
            { kind: 'goto', url: second },
          ],
        };
      };
      const ok = await call(
        'request',
        replayOf(`https://accounts.${f.domain}/next`),
      ).expect(200);
      const rrow = await browserJobRow(prisma, ok.body.data.jobId as string);
      expect(
        [...(rrow.params as { allowedHosts: string[] }).allowedHosts].sort(),
      ).toEqual([`accounts.${f.domain}`, host].sort());
      const off = await call(
        'request',
        replayOf('https://evil.example.org/'),
      ).expect(409);
      expect(off.body.error.code).toBe('TUTORIAL_EXPLORE_HOST');
    });

    it('кадры (Ш3-хвост (3)): формат png2x доходит до задания; неизвестный — 400', async () => {
      const tg = f.telegramId.toString();
      const url = `https://shop.${f.domain}/`;
      const res = await call('/internal/sites/tutorial/frames/request', {
        telegramId: tg,
        url,
        frames: 1,
        image: 'png2x',
      }).expect(200);
      const row = await browserJobRow(prisma, res.body.data.jobId as string);
      expect(row.params).toMatchObject({ image: 'png2x', frames: 1 });
      const bad = await call('/internal/sites/tutorial/frames/request', {
        telegramId: tg,
        url,
        image: 'gif',
      }).expect(400);
      expect(bad.body.error.code).toBe('INTERNAL_BAD_BODY');
      await jobs.cancel(f.accountId, row.id);
    });
  },
);
