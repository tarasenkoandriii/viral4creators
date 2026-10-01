/**
 * Маршруты ядра по HTTP: настоящий глобальный `TelegramIdentityGuard`
 * (initData двух ботов, агент C), `SiteAccountGuard` с ролями, конверт и
 * фильтр приложения (configureApp). База и сеть — поддельные.
 */

import {
  Controller,
  DynamicModule,
  Get,
  INestApplication,
  Logger,
  Module,
  UseGuards,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { configureApp } from '../../app.setup';
import { loadConfiguration } from '../../config/configuration';
import { SitesDb } from '../../prisma/sites-db.service';
import { AllowApps } from '../telegram-auth/allow-apps.decorator';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import {
  TEST_ASSIST_TOKEN,
  TEST_QA_TOKEN,
  signInitData,
} from '../telegram-auth/test-init-data';
import { REQUIRE_ASSIST_ADMIN_OWNER } from './account/roles';
import {
  RequireProductRoles,
  SiteAccountGuard,
} from './account/site-account.guard';
import { OwnershipChecker } from './ownership/ownership-checker';
import { SiteCoreModule } from './site-core.module';
import { FakeNet } from './testing/fake-net.testing';
import { FakeStore } from './testing/fake-sites-db.testing';

/**
 * Маршрут-проба режима «Админка» (`…/knowledge/admin/*`): самих маршрутов
 * в Э0 нет, но правило К-9 проверяется на том же гварде и декораторе,
 * которыми их закроет Э1.
 */
@Controller('assist/sites/:id/knowledge/admin')
@AllowApps('assist')
@UseGuards(SiteAccountGuard)
class AdminKnowledgeProbeController {
  @Get('sources')
  @RequireProductRoles(REQUIRE_ASSIST_ADMIN_OWNER)
  sources() {
    return { sources: [] };
  }
}

/** Глобальный `SitesDb` на поддельной базе — как PrismaModule в проде. */
@Module({})
class FakeDbModule {
  static with(store: FakeStore): DynamicModule {
    return {
      module: FakeDbModule,
      global: true,
      providers: [{ provide: SitesDb, useValue: store.sitesDb() }],
      exports: [SitesDb],
    };
  }
}

const ENV_KEYS = [
  'ASSIST_BOT_TOKEN',
  'QA_BOT_TOKEN',
  'CRON_SECRET',
  'ALLOW_DEV_AUTH',
] as const;

describe('site-core по HTTP', () => {
  let app: INestApplication;
  let store: FakeStore;
  let net: FakeNet;
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    Logger.overrideLogger(false);
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.ASSIST_BOT_TOKEN = TEST_ASSIST_TOKEN;
    process.env.QA_BOT_TOKEN = TEST_QA_TOKEN;
    process.env.CRON_SECRET = 'cron-secret-for-test';
    delete process.env.ALLOW_DEV_AUTH;
  });
  afterAll(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  beforeEach(async () => {
    store = new FakeStore();
    net = new FakeNet();
    const mod = await Test.createTestingModule({
      imports: [FakeDbModule.with(store), TelegramAuthModule, SiteCoreModule],
      controllers: [AdminKnowledgeProbeController],
    })
      .overrideProvider(OwnershipChecker)
      .useValue(net.checker())
      .compile();
    app = mod.createNestApplication();
    configureApp(app, loadConfiguration({}));
    await app.init();
  });
  afterEach(async () => {
    await app.close();
  });

  function as(
    userId: number,
    bot: 'assist' | 'qa' = 'assist',
  ): Record<string, string> {
    return {
      'X-Telegram-App': bot,
      'X-Telegram-Init-Data': signInitData({
        botToken: bot === 'assist' ? TEST_ASSIST_TOKEN : TEST_QA_TOKEN,
        userId,
      }),
    };
  }

  const srv = () => app.getHttpServer();

  it('кабинет при первом входе — форма, которую ждёт site-tma-kit', async () => {
    const res = await request(srv()).get('/sites/account').set(as(42));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      account: {
        id: expect.any(String),
        type: 'owner',
        region: 'other',
        verifyToken: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/),
      },
      me: {
        telegramId: '42',
        role: 'owner',
        productRoles: { qa: 'admin', assist: 'manager', assistAdmin: 'owner' },
      },
      members: [expect.objectContaining({ telegramId: '42' })],
      created: true,
    });
  });

  it('вход через бот QA — тот же кабинет, те же сайты и статусы', async () => {
    const acc = await request(srv()).get('/sites/account').set(as(42));
    const token = acc.body.data.account.verifyToken as string;
    const created = await request(srv())
      .post('/sites')
      .set(as(42))
      .send({ name: 'Магазин', url: 'https://example.com' });
    expect(created.status).toBe(201);
    const hostId = created.body.data.hosts[0].id as string;
    net.txt('_v4c-verify.example.com', `v4c-verify=${token}`);
    const v = await request(srv())
      .post(`/sites/hosts/${hostId}/verify`)
      .set(as(42))
      .send({ method: 'dns' });
    expect(v.status).toBe(200);
    expect(v.body.data).toMatchObject({
      ok: true,
      host: { id: hostId, status: 'verified', method: 'dns' },
    });

    const viaQa = await request(srv()).get('/sites/account').set(as(42, 'qa'));
    expect(viaQa.body.data).toMatchObject({
      account: { id: acc.body.data.account.id },
      created: false,
    });
    const sites = await request(srv()).get('/sites').set(as(42, 'qa'));
    expect(sites.body.data).toEqual([
      {
        id: created.body.data.id,
        name: 'Магазин',
        hosts: [
          expect.objectContaining({
            id: hostId,
            siteId: created.body.data.id,
            host: 'example.com',
            port: 443,
            status: 'verified',
            publicPlatform: false,
            lastCheck: expect.objectContaining({ ok: true }),
          }),
        ],
      },
    ]);
  });

  it('дубль — 409 с машинным кодом в error.code', async () => {
    await request(srv()).get('/sites/account').set(as(1));
    const site = await request(srv())
      .post('/sites')
      .set(as(1))
      .send({ name: 'X', url: 'example.com' });
    const dup = await request(srv())
      .post(`/sites/${site.body.data.id}/hosts`)
      .set(as(1))
      .send({ url: 'https://example.com/path' });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatchObject({
      code: 'HOST_DUPLICATE',
      details: { code: 'HOST_DUPLICATE' },
    });
  });

  it('без initData — 401; лишнее поле в теле — 400', async () => {
    expect((await request(srv()).get('/sites')).status).toBe(401);
    await request(srv()).get('/sites/account').set(as(1));
    const bad = await request(srv())
      .post('/sites')
      .set(as(1))
      .send({ name: 'X', url: 'example.com', accountId: 'чужой' });
    expect(bad.status).toBe(400);
  });

  it('пакетная проверка, подсказка, challenge, удаление — маршруты по §4.16', async () => {
    const acc = await request(srv()).get('/sites/account').set(as(7));
    const token = acc.body.data.account.verifyToken as string;
    const site = await request(srv())
      .post('/sites')
      .set(as(7))
      .send({ name: 'X', url: 'example.com' });
    const siteId = site.body.data.id as string;
    const hostId = site.body.data.hosts[0].id as string;

    const ch = await request(srv())
      .post(`/sites/hosts/${hostId}/challenge`)
      .set(as(7))
      .send({ method: 'file' });
    expect(ch.status).toBe(200);
    expect(ch.body.data).toMatchObject({
      token,
      instruction: {
        method: 'file',
        url: 'https://example.com/.well-known/v4c-verify.txt',
        content: token,
      },
    });

    net.page('https://example.com/', {
      status: 200,
      body: '<a href="https://shop.example.com/x">Магазин</a><a href="https://evil-example.com/">x</a>',
    });
    const sug = await request(srv())
      .get(`/sites/${siteId}/hosts/suggest`)
      .set(as(7));
    expect(sug.body.data).toEqual({
      hosts: ['www.example.com', 'shop.example.com'],
    });

    const all = await request(srv())
      .post(`/sites/${siteId}/verify-all`)
      .set(as(7));
    expect(all.status).toBe(200);
    expect(all.body.data.results).toEqual([
      expect.objectContaining({ ok: false, code: 'FILE_NOT_FOUND' }),
    ]);

    const del = await request(srv())
      .delete(`/sites/${siteId}/hosts/${hostId}`)
      .set(as(7));
    expect(del.body.data).toEqual({ deleted: true });
  });

  describe('роли', () => {
    async function withOperator() {
      await request(srv()).get('/sites/account').set(as(1));
      const inv = await request(srv())
        .post('/sites/account/invites')
        .set(as(1))
        .send({ role: 'operator', productRoles: { assist: 'operator' } });
      expect(inv.status).toBe(201);
      const acc = await request(srv())
        .post('/sites/account/invites/accept')
        .set(as(2, 'qa'))
        .send({ token: inv.body.data.startParam });
      expect(acc.status).toBe(200);
      return acc.body.data;
    }

    it('участник с assist=operator получает 403 на …/knowledge/admin/*', async () => {
      await withOperator();
      const res = await request(srv())
        .get('/assist/sites/s1/knowledge/admin/sources')
        .set(as(2));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PRODUCT_ROLE_REQUIRED');
    });

    it('владелец кабинета на том же маршруте — 200', async () => {
      await withOperator();
      const res = await request(srv())
        .get('/assist/sites/s1/knowledge/admin/sources')
        .set(as(1));
      expect(res.status).toBe(200);
    });

    it('маршрут помощника из бота QA — 403 (initData не того бота)', async () => {
      await request(srv()).get('/sites/account').set(as(1));
      const res = await request(srv())
        .get('/assist/sites/s1/knowledge/admin/sources')
        .set(as(1, 'qa'));
      expect(res.status).toBe(403);
    });

    it('оператор не добавляет сайты и не приглашает; видит кабинет без токена', async () => {
      const info = await withOperator();
      expect(info).toMatchObject({
        account: { verifyToken: null },
        me: { role: 'operator', productRoles: { assist: 'operator' } },
      });
      const add = await request(srv())
        .post('/sites')
        .set(as(2))
        .send({ name: 'X', url: 'example.com' });
      expect(add.status).toBe(403);
      expect(add.body.error.code).toBe('ACCOUNT_ROLE_REQUIRED');
      const inv = await request(srv())
        .post('/sites/account/invites')
        .set(as(2))
        .send({ role: 'operator' });
      expect(inv.status).toBe(403);
      expect((await request(srv()).get('/sites').set(as(2))).status).toBe(200);
    });

    it('без кабинета кабинетный маршрут — 403 ACCOUNT_REQUIRED', async () => {
      const res = await request(srv()).get('/sites').set(as(99));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ACCOUNT_REQUIRED');
    });
  });

  describe('GET /cron/site-ownership-recheck', () => {
    it('без секрета — 401, с секретом — прогон без пользователя', async () => {
      expect(
        (await request(srv()).get('/cron/site-ownership-recheck')).status,
      ).toBe(401);
      expect(
        (
          await request(srv())
            .get('/cron/site-ownership-recheck')
            .set('Authorization', 'Bearer wrong-secret')
        ).status,
      ).toBe(401);
      const ok = await request(srv())
        .get('/cron/site-ownership-recheck')
        .set('Authorization', 'Bearer cron-secret-for-test');
      expect(ok.status).toBe(200);
      expect(ok.body.data).toMatchObject({ checked: 0, revoked: 0 });
    });

    it('CRON_SECRET не задан — 503 (закрыто), а не открыто', async () => {
      const prev = process.env.CRON_SECRET;
      delete process.env.CRON_SECRET;
      try {
        const res = await request(srv()).get('/cron/site-ownership-recheck');
        expect(res.status).toBe(503);
      } finally {
        process.env.CRON_SECRET = prev;
      }
    });
  });
});
