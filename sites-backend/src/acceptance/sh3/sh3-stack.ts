/**
 * Стенд приёмки Э-С Ш3 (браузерный воркер) на НАСТОЯЩЕМ Postgres:
 * приложение Nest с настоящими гвардами (initData бота помощника,
 * SiteAccountGuard, права по продукту, HMAC канала воркера), очередью
 * `browser-jobs`, каналом воркера `internal-worker`, обходом «Админки»,
 * голосовой картой, каналом генератора (кадры) и реестром учёток Ш2.
 * Приватный Blob артефактов подменён (`FakeArtifactStorage`).
 *
 * «Воркер» здесь — подписанный HTTP-клиент тем же кодом, что у настоящего
 * (`shared/sites-internal-signature.ts`, вызывающий `browser-worker`):
 * проверяются сервер, база и связки продуктов. Настоящий воркер с
 * Chromium против этого же стенда — `browser-worker.real.spec.ts`
 * (локально, по флагу).
 */
import { randomBytes, randomUUID } from 'crypto';
import {
  DynamicModule,
  Global,
  INestApplication,
  Logger,
  Module,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { configureApp } from '../../app.setup';
import { WIDGET_PK_LIVE_PREFIX } from '../../brand';
import { loadConfiguration } from '../../config/configuration';
import { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import { ownerPrisma } from '../../modules/assist-sandbox/testing/k3-stack.testing';
import { AssistAdminCrawlModule } from '../../modules/assist-admin-crawl/assist-admin-crawl.module';
import { AssistSiteVoiceMapModule } from '../../modules/assist-site-voice-map/assist-site-voice-map.module';
import { BrowserArtifactStorage } from '../../modules/browser-jobs/artifact-storage';
import { BrowserJobsModule } from '../../modules/browser-jobs/browser-jobs.module';
import { BrowserJobsService } from '../../modules/browser-jobs/browser-jobs.service';
import { WORKER_CALLER } from '../../modules/browser-jobs/protocol';
import { FakeArtifactStorage } from '../../modules/browser-jobs/testing/fake-artifact-storage.testing';
import { InternalSitesModule } from '../../modules/internal-sites/internal-sites.module';
import { TutorialHmacGuard } from '../../modules/internal-sites/tutorial-hmac.guard';
import { InternalWorkerModule } from '../../modules/internal-worker/internal-worker.module';
import { InternalWorkerService } from '../../modules/internal-worker/internal-worker.service';
import { WorkerHmacGuard } from '../../modules/internal-worker/worker-hmac.guard';
import { SiteCoreModule } from '../../modules/site-core/site-core.module';
import { SiteCredentialsModule } from '../../modules/site-credentials/site-credentials.module';
import { SiteCredentialsService } from '../../modules/site-credentials/site-credentials.service';
import { TelegramAuthModule } from '../../modules/telegram-auth/telegram-auth.module';
import {
  TEST_ASSIST_TOKEN,
  TEST_QA_TOKEN,
  signInitData,
} from '../../modules/telegram-auth/test-init-data';
import {
  SITES_CALLER_TUTORIAL,
  sitesSignatureHeaders,
} from '../../shared/sites-internal-signature';
import { generateWorkerSealKeys } from '../../modules/browser-jobs/worker-seal';

@Global()
@Module({})
class Sh3InfraModule {
  static with(prisma: PrismaService): DynamicModule {
    return {
      module: Sh3InfraModule,
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: SitesDb, useValue: new SitesDb(prisma) },
      ],
      exports: [PrismaService, SitesDb],
    };
  }
}

const ENV_KEYS = [
  'ASSIST_BOT_TOKEN',
  'QA_BOT_TOKEN',
  'ALLOW_DEV_AUTH',
  'CRON_SECRET',
] as const;

let tgSeq = BigInt(Date.now()) * BigInt(1000) + BigInt(313);

export interface Sh3Site {
  accountId: string;
  siteId: string;
  shopHost: string;
  shopHostId: string;
  adminHost: string;
  adminHostId: string;
  ownerTg: bigint;
}

export class Sh3Stack {
  app!: INestApplication;
  prisma!: PrismaService;
  readonly storage = new FakeArtifactStorage();
  readonly keys = generateWorkerSealKeys();
  readonly workerSecret = randomBytes(32).toString('hex');
  readonly tutorialSecret = randomBytes(32).toString('hex');
  readonly credKey = randomBytes(32).toString('base64');
  /** Env сервисов Ш3 (выключатель и ключи — меняются тестами). */
  readonly env: NodeJS.ProcessEnv = {};
  private saved: Record<string, string | undefined> = {};
  readonly accounts: string[] = [];

  async init(): Promise<this> {
    for (const k of ENV_KEYS) this.saved[k] = process.env[k];
    process.env.ASSIST_BOT_TOKEN = TEST_ASSIST_TOKEN;
    process.env.QA_BOT_TOKEN = TEST_QA_TOKEN;
    delete process.env.ALLOW_DEV_AUTH;
    process.env.CRON_SECRET = 'sh3-cron-secret';
    Object.assign(this.env, {
      BROWSER_WORKER_ENABLED: 'true',
      SITES_WORKER_HMAC_SECRET: this.workerSecret,
      SITES_TUTORIAL_HMAC_SECRET: this.tutorialSecret,
      SITES_WORKER_SEAL_PUBLIC_KEY: this.keys.publicKey,
      SITE_CREDENTIALS_KEYS: `v1:${this.credKey}`,
    });
    Logger.overrideLogger(false);
    this.prisma = ownerPrisma();
    const mod = await Test.createTestingModule({
      imports: [
        Sh3InfraModule.with(this.prisma),
        TelegramAuthModule,
        SiteCoreModule,
        SiteCredentialsModule,
        BrowserJobsModule,
        InternalWorkerModule,
        AssistAdminCrawlModule,
        AssistSiteVoiceMapModule,
        InternalSitesModule,
      ],
    })
      .overrideProvider(BrowserArtifactStorage)
      .useValue(this.storage)
      .compile();
    this.app = mod.createNestApplication({ logger: false });
    configureApp(this.app, loadConfiguration({}));
    await this.app.init();
    this.jobs.env = this.env;
    this.app.get(InternalWorkerService).env = this.env;
    this.app.get(WorkerHmacGuard).env = this.env;
    this.app.get(TutorialHmacGuard).env = this.env;
    this.app.get(SiteCredentialsService).env = this.env;
    return this;
  }

  get jobs(): BrowserJobsService {
    return this.app.get(BrowserJobsService);
  }

  async close(): Promise<void> {
    await this.app?.close();
    if (this.accounts.length) {
      await this.prisma.siteAccount.deleteMany({
        where: { id: { in: this.accounts } },
      });
    }
    await this.prisma.$disconnect();
    for (const k of ENV_KEYS) {
      if (this.saved[k] === undefined) delete process.env[k];
      else process.env[k] = this.saved[k];
    }
  }

  srv() {
    return this.app.getHttpServer();
  }

  as(tg: bigint): Record<string, string> {
    return {
      'X-Telegram-App': 'assist',
      'X-Telegram-Init-Data': signInitData({
        botToken: TEST_ASSIST_TOKEN,
        userId: Number(tg),
      }),
    };
  }

  /** Подписанный запрос «воркера» (тот же код подписи, что у настоящего). */
  worker(
    path: string,
    body: unknown,
    opts: { secret?: string; caller?: string; at?: number } = {},
  ) {
    const raw = JSON.stringify(body);
    const headers = sitesSignatureHeaders(opts.secret ?? this.workerSecret, {
      caller: opts.caller ?? WORKER_CALLER,
      method: 'POST',
      path,
      body: raw,
      unixSeconds: opts.at ?? Math.floor(Date.now() / 1000),
      requestId: randomUUID(),
    });
    return request(this.srv())
      .post(path)
      .set(headers)
      .set('content-type', 'application/json')
      .send(raw);
  }

  /** Подписанный запрос генератора (канал обучалки). */
  tutorial(path: string, body: unknown) {
    const raw = JSON.stringify(body, (_k, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    const headers = sitesSignatureHeaders(this.tutorialSecret, {
      caller: SITES_CALLER_TUTORIAL,
      method: 'POST',
      path,
      body: raw,
      unixSeconds: Math.floor(Date.now() / 1000),
      requestId: randomUUID(),
    });
    return request(this.srv())
      .post(path)
      .set(headers)
      .set('content-type', 'application/json')
      .send(raw);
  }

  /** Кабинет, сайт, два verified-хоста (магазин и админка), помощник. */
  async site(): Promise<Sh3Site> {
    const p = this.prisma;
    const tag = randomUUID().slice(0, 8);
    const shopHost = `shop-${tag}.sh3.example.com`;
    const adminHost = `admin-${tag}.sh3.example.com`;
    const account = await p.siteAccount.create({
      data: { verifyToken: `sh3-${randomUUID()}` },
    });
    this.accounts.push(account.id);
    const ownerTg = ++tgSeq;
    await p.siteAccountMember.create({
      data: {
        accountId: account.id,
        telegramId: ownerTg,
        role: 'owner',
        productRoles: {},
      },
    });
    const site = await p.site.create({
      data: { accountId: account.id, name: `Магазин ${tag}` },
    });
    const verified = (h: string) =>
      p.siteHost.create({
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
    const sh = await verified(shopHost);
    const ah = await verified(adminHost);
    await p.assistSite.create({
      data: {
        accountId: account.id,
        siteId: site.id,
        enabled: true,
        recrawlEvery: 'manual',
        publicKey: `${WIDGET_PK_LIVE_PREFIX}${randomBytes(18).toString('hex').slice(0, 32)}`,
      },
    });
    await p.assistAdminSettings.create({
      data: { accountId: account.id, siteId: site.id, adminHostIds: [ah.id] },
    });
    return {
      accountId: account.id,
      siteId: site.id,
      shopHost,
      shopHostId: sh.id,
      adminHost,
      adminHostId: ah.id,
      ownerTg,
    };
  }

  async member(
    s: Sh3Site,
    role: 'owner' | 'manager' | 'operator',
    productRoles: Record<string, string>,
  ): Promise<bigint> {
    const tg = ++tgSeq;
    await this.prisma.siteAccountMember.create({
      data: { accountId: s.accountId, telegramId: tg, role, productRoles },
    });
    return tg;
  }
}

export const body = (r: { body: unknown }) =>
  (r.body as { data: Record<string, unknown> }).data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export const errCode = (r: { body: unknown }) =>
  (r.body as { error?: { code?: string } }).error?.code;
