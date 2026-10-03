/**
 * Приёмка Э3 (A) — маршруты кабинета целей/статистики/интеграций/экспорта по
 * HTTP (настоящие гварды: initData бота, SiteAccountGuard, права по продукту;
 * конверт приложения): оператор помощника — 403 на КАЖДОМ маршруте A;
 * менеджер — цели, статистика, экспорт без текста; владелец — секреты,
 * удаление событий по заказу, экспорт с текстом; чужой кабинет — 404; кроны
 * A закрыты без CRON_SECRET (сами проходы — со scope в других спеках).
 */
import { Global, INestApplication, Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { configureApp } from '../../app.setup';
import { loadConfiguration } from '../../config/configuration';
import { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import { AnalyticsController } from '../../modules/assist-analytics/analytics.controller';
import { AnalyticsSettingsService } from '../../modules/assist-analytics/analytics-settings.service';
import { AssistAnalyticsCronController } from '../../modules/assist-analytics/cron/analytics-cron.controller';
import { ExportStorage } from '../../modules/assist-analytics/export-storage';
import { ExportsService } from '../../modules/assist-analytics/exports.service';
import { GoalsService } from '../../modules/assist-analytics/goals.service';
import { IntegrationsService } from '../../modules/assist-analytics/integrations.service';
import { StatsService } from '../../modules/assist-analytics/stats.service';
import { AnalyticsRollup } from '../../modules/assist-analytics/system/analytics-rollup.service';
import {
  FakeExportStorage,
  FakeLearningRead,
} from '../../modules/assist-analytics/testing/analytics-stack.testing';
import { AssistDigestController } from '../../modules/assist-digest/cron/assist-digest.controller';
import { AssistDigestService } from '../../modules/assist-digest/digest.service';
import {
  describeDb,
  ownerPrisma,
} from '../../modules/assist-sandbox/testing/k3-stack.testing';
import { LearningReadApi } from '../../modules/assist-site-learning/learning-read.service';
import { VoiceMonitorService } from '../../modules/assist-site-voice-control/system/voice-monitor.service';
import { AiAnalyticsRunner } from '../../modules/assist-analytics/ai/ai-runner.service';
import { OWNER_PRODUCT_ROLES } from '../../modules/site-core/account/roles';
import { SiteCoreModule } from '../../modules/site-core/site-core.module';
import { TelegramAuthModule } from '../../modules/telegram-auth/telegram-auth.module';
import {
  TEST_ASSIST_TOKEN,
  TEST_QA_TOKEN,
  signInitData,
} from '../../modules/telegram-auth/test-init-data';

jest.setTimeout(90_000);

@Global()
@Module({})
class A3HttpInfra {
  static with(prisma: PrismaService): DynamicModule {
    return {
      module: A3HttpInfra,
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
  'ASSIST_SECRETS_KEY',
  'CRON_SECRET',
] as const;

describeDb(
  'Приёмка Э3 (A): маршруты кабинета по HTTP — права, конверт, 404',
  () => {
    let app: INestApplication;
    let prisma: PrismaService;
    const saved: Record<string, string | undefined> = {};
    const accounts: string[] = [];
    let tgNext = 7_700_000_000 + Math.floor(Math.random() * 1_000_000) * 10;

    beforeAll(async () => {
      for (const k of ENV_KEYS) saved[k] = process.env[k];
      process.env.ASSIST_BOT_TOKEN = TEST_ASSIST_TOKEN;
      process.env.QA_BOT_TOKEN = TEST_QA_TOKEN;
      process.env.ASSIST_SECRETS_KEY = 'a3-http-secrets';
      process.env.CRON_SECRET = 'a3-cron-secret';
      delete process.env.ALLOW_DEV_AUTH;
      prisma = ownerPrisma();
      const mod = await Test.createTestingModule({
        imports: [A3HttpInfra.with(prisma), TelegramAuthModule, SiteCoreModule],
        controllers: [
          AnalyticsController,
          AssistAnalyticsCronController,
          AssistDigestController,
        ],
        providers: [
          GoalsService,
          StatsService,
          IntegrationsService,
          ExportsService,
          AnalyticsSettingsService,
          AnalyticsRollup,
          { provide: ExportStorage, useValue: new FakeExportStorage() },
          { provide: LearningReadApi, useValue: new FakeLearningRead() },
          {
            provide: AssistDigestService,
            useValue: { now: () => new Date(), run: jest.fn() },
          },
          // Э6-бис (г): монитор голосового управления — в том же кроне.
          { provide: VoiceMonitorService, useValue: { run: jest.fn() } },
          // Э3-бис: аналитика с ИИ — в тех же кронах (свои спеки — e3b/).
          {
            provide: AiAnalyticsRunner,
            useValue: { run: jest.fn(), daily: jest.fn() },
          },
        ],
      }).compile();
      app = mod.createNestApplication();
      configureApp(app, loadConfiguration({}));
      await app.init();
    });

    afterAll(async () => {
      await app?.close();
      if (accounts.length) {
        await prisma.siteAccount.deleteMany({
          where: { id: { in: accounts } },
        });
      }
      await prisma?.$disconnect();
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });

    const srv = () => app.getHttpServer();
    const as = (tg: bigint) => ({
      'X-Telegram-App': 'assist',
      'X-Telegram-Init-Data': signInitData({
        botToken: TEST_ASSIST_TOKEN,
        userId: Number(tg),
      }),
    });

    async function fixture() {
      const acc = await prisma.siteAccount.create({
        data: { verifyToken: `a3h-${Date.now()}-${tgNext}` },
      });
      accounts.push(acc.id);
      const owner = BigInt(tgNext++);
      await prisma.siteAccountMember.create({
        data: {
          accountId: acc.id,
          telegramId: owner,
          role: 'owner',
          productRoles: OWNER_PRODUCT_ROLES,
        },
      });
      const site = await prisma.site.create({
        data: { accountId: acc.id, name: 'Магазин' },
      });
      await prisma.assistSite.create({
        data: { accountId: acc.id, siteId: site.id },
      });
      const add = async (
        role: 'manager' | 'operator',
        assist: 'manager' | 'operator',
      ) => {
        const tg = BigInt(tgNext++);
        await prisma.siteAccountMember.create({
          data: {
            accountId: acc.id,
            telegramId: tg,
            role,
            productRoles: { qa: 'none', assist, assistAdmin: 'none' },
          },
        });
        return tg;
      };
      return {
        siteId: site.id,
        owner,
        manager: await add('manager', 'manager'),
        operator: await add('operator', 'operator'),
      };
    }

    const q = 'from=2026-09-01&to=2026-09-07';
    const routes = (
      id: string,
    ): Array<['get' | 'post' | 'patch' | 'delete', string, object?]> => [
      ['get', `/assist/sites/${id}/goals`],
      ['post', `/assist/sites/${id}/goals`, { key: 'x' }],
      ['patch', `/assist/sites/${id}/goals/g1`, { name: 'x' }],
      ['delete', `/assist/sites/${id}/goals/g1`],
      ['post', `/assist/sites/${id}/goals/picker-token`, { hostId: 'h' }],
      ['get', `/assist/sites/${id}/goals/picker/t1`],
      ['get', `/assist/sites/${id}/goals/g1/recent`],
      ['delete', `/assist/sites/${id}/goal-events?orderId=A-1`],
      ['get', `/assist/sites/${id}/stats/overview?${q}`],
      ['get', `/assist/sites/${id}/stats/conversions?${q}`],
      ['get', `/assist/sites/${id}/stats/topics?${q}`],
      ['get', `/assist/stats/sites?${q}`],
      ['get', `/assist/sites/${id}/analytics-settings`],
      ['patch', `/assist/sites/${id}/analytics-settings`, { currency: 'EUR' }],
      ['get', `/assist/sites/${id}/integrations`],
      ['post', `/assist/sites/${id}/integrations/goal-webhook/secret`],
      ['post', `/assist/sites/${id}/integrations/identity/secret`],
      ['delete', `/assist/sites/${id}/integrations/identity`],
      [
        'post',
        `/assist/sites/${id}/exports`,
        { kind: 'daily', from: '2026-09-01', to: '2026-09-02' },
      ],
      ['get', `/assist/sites/${id}/exports`],
      ['get', `/assist/sites/${id}/exports/x1`],
      ['get', `/assist/sites/${id}/reports/subscription`],
      ['patch', `/assist/sites/${id}/reports/subscription`, { weekly: false }],
    ];

    it('оператор помощника — 403 на КАЖДОМ маршруте A, ничего не меняя', async () => {
      const f = await fixture();
      for (const [method, path, body] of routes(f.siteId)) {
        const r = await request(srv())
          [method](path)
          .set(as(f.operator))
          .send(body);
        expect([method, path, r.status]).toEqual([method, path, 403]);
      }
      expect(
        await prisma.assistSiteGoal.count({ where: { siteId: f.siteId } }),
      ).toBe(0);
      expect(
        await prisma.assistSiteIntegration.count({
          where: { siteId: f.siteId },
        }),
      ).toBe(0);
    });

    it('чужой кабинет — 404 на маршрутах сайта', async () => {
      const f = await fixture();
      const other = await fixture();
      for (const [method, path, body] of routes(f.siteId)) {
        if (path.startsWith('/assist/stats/')) continue;
        const r = await request(srv())
          [method](path)
          .set(as(other.owner))
          .send(body);
        expect([method, path, r.status]).toEqual([method, path, 404]);
      }
    });

    it('менеджер: цели и статистика — да; секреты, удаление по заказу, экспорт с текстом — 403; владелец — да, секрет показан один раз', async () => {
      const f = await fixture();
      const goals = await request(srv())
        .get(`/assist/sites/${f.siteId}/goals`)
        .set(as(f.manager));
      expect(goals.status).toBe(200);
      expect(goals.body.success).toBe(true);
      expect(goals.body.data.map((g: { key: string }) => g.key)).toEqual([
        'lead',
        'call',
        'messenger',
      ]);
      const ov = await request(srv())
        .get(`/assist/sites/${f.siteId}/stats/overview?${q}`)
        .set(as(f.manager));
      expect(ov.status).toBe(200);
      expect(ov.body.data.dialogs.value).toBe(0);
      const bad = await request(srv())
        .get(
          `/assist/sites/${f.siteId}/stats/overview?from=2026-09-07&to=2026-09-01`,
        )
        .set(as(f.manager));
      expect([bad.status, bad.body.error.code]).toEqual([
        400,
        'STATS_RANGE_INVALID',
      ]);
      for (const [method, path, body] of [
        [
          'post',
          `/assist/sites/${f.siteId}/integrations/goal-webhook/secret`,
          undefined,
        ],
        [
          'delete',
          `/assist/sites/${f.siteId}/goal-events?orderId=A-1`,
          undefined,
        ],
        [
          'post',
          `/assist/sites/${f.siteId}/exports`,
          {
            kind: 'dialogs',
            from: '2026-09-01',
            to: '2026-09-01',
            withText: true,
          },
        ],
      ] as const) {
        const r = await request(srv())
          [method](path)
          .set(as(f.manager))
          .send(body);
        expect([path, r.status]).toEqual([path, 403]);
      }
      const sec = await request(srv())
        .post(`/assist/sites/${f.siteId}/integrations/goal-webhook/secret`)
        .set(as(f.owner));
      expect(sec.status).toBe(201);
      expect(sec.body.data.secret).toMatch(/^whsec_[A-Za-z0-9_-]{40,}$/);
      const view = await request(srv())
        .get(`/assist/sites/${f.siteId}/integrations`)
        .set(as(f.manager));
      expect(view.body.data.goalWebhook).toMatchObject({
        active: true,
        endpoint: `/assist/v1/sites/${f.siteId}/goal-events`,
      });
      expect(JSON.stringify(view.body)).not.toContain(sec.body.data.secret);
      const row = await prisma.assistSiteIntegration.findFirstOrThrow({
        where: { siteId: f.siteId },
      });
      expect(row.secretEnc).not.toContain(sec.body.data.secret.slice(6));
      const gone = await request(srv())
        .delete(`/assist/sites/${f.siteId}/integrations/goal-webhook`)
        .set(as(f.owner));
      expect(gone.status).toBe(200);
      const again = await request(srv())
        .delete(`/assist/sites/${f.siteId}/integrations/goal-webhook`)
        .set(as(f.owner));
      expect([again.status, again.body.error.code]).toEqual([
        404,
        'INTEGRATION_NOT_FOUND',
      ]);
      const ex = await request(srv())
        .post(`/assist/sites/${f.siteId}/exports`)
        .set(as(f.manager))
        .send({ kind: 'daily', from: '2026-09-01', to: '2026-09-02' });
      expect([ex.status, ex.body.data.status]).toEqual([202, 'queued']);
    });

    it('кроны A без CRON_SECRET — 401 (проходы не запускаются)', async () => {
      for (const path of [
        '/cron/assist-analytics-run',
        '/cron/assist-analytics-rollup',
        '/cron/assist-digest',
      ]) {
        const r = await request(srv()).get(path);
        expect([path, r.status]).toEqual([path, 401]);
        const w = await request(srv())
          .get(path)
          .set('Authorization', 'Bearer wrong');
        expect([path, w.status]).toEqual([path, 401]);
      }
    });
  },
);
