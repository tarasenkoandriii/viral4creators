/**
 * Э4 по HTTP с настоящими гвардами: кабинет «Тариф и оплата» (initData бота
 * Помощника → участник кабинета; оплата — только владелец), вебхук
 * WayForPay (квитанция мимо конверта), крон по CRON_SECRET, внутренний API
 * админки платформы (секрет, журнал доступа, согласие DPA для eval),
 * маршрутизация вебхука бота: оплата Stars — до передачи человеку.
 */
import {
  DynamicModule,
  Global,
  INestApplication,
  Module,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { configureApp } from '../../app.setup';
import { loadConfiguration } from '../../config/configuration';
import { AssistPublicDb } from '../../prisma/assist-public-db.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import {
  describeDb,
  ownerPrisma,
} from '../../modules/assist-sandbox/testing/k3-stack.testing';
import { SiteCoreModule } from '../../modules/site-core/site-core.module';
import { TelegramAuthModule } from '../../modules/telegram-auth/telegram-auth.module';
import {
  TEST_ASSIST_TOKEN,
  TEST_QA_TOKEN,
  signInitData,
} from '../../modules/telegram-auth/test-init-data';
import { AssistBillingController } from '../../modules/assist-billing/billing.controller';
import { AssistBillingWebhookController } from '../../modules/assist-billing/billing-webhook.controller';
import { AssistBillingTickController } from '../../modules/assist-billing/billing-tick.controller';
import { AssistBillingTick } from '../../modules/assist-billing/billing-tick.service';
import { AssistBilling } from '../../modules/assist-billing/billing.service';
import { BillingNotices } from '../../modules/assist-billing/billing-notices';
import { AssistPayments } from '../../modules/assist-billing/payments.service';
import { AssistPaymentProviders } from '../../modules/assist-billing/providers';
import {
  FakeProviders,
  billingEnv,
  wfpCallback,
} from '../../modules/assist-billing/testing/billing-stack.testing';
import {
  createAccount,
  setPlan,
} from '../../modules/assist-billing/testing/billing-fixtures.testing';
import { PlatformAdminController } from '../../modules/platform-admin/platform-admin.controller';
import { PlatformAdmin } from '../../modules/platform-admin/platform-admin.service';
import { SonioxObservability } from '../../modules/soniox-observability/soniox-observability.service';
import { TelegramWebhookController } from '../../modules/telegram-webhook/telegram-webhook.controller';
import type { AssistBotUpdates } from '../../modules/assist-site-handoff/bot/assist-bot-updates.service';
import {
  readWidgetPlatformSettings,
  resetPlatformSettingsCache,
} from '../../common/platform-settings';

jest.setTimeout(120_000);

const INTERNAL = 'e4-internal-secret-0123456789';
const CRON = 'e4-cron-secret';
// Журнал доступа — общий для базы: актор уникален на прогон (повторные
// прогоны и мутации на той же базе не путают счёт).
const RUN = Date.now().toString(36);
const REVIEWER = `rev-${RUN}`;
const ADMIN7 = `adm-${RUN}`;

@Global()
@Module({})
class InfraModule {
  static with(owner: PrismaService): DynamicModule {
    return {
      module: InfraModule,
      providers: [
        { provide: PrismaService, useValue: owner },
        { provide: SitesDb, useValue: new SitesDb(owner) },
        { provide: AssistPublicDb, useValue: owner },
      ],
      exports: [PrismaService, SitesDb, AssistPublicDb],
    };
  }
}

describeDb(
  'Э4: HTTP кабинета оплаты, вебхуков, крона и внутреннего API',
  () => {
    let owner: PrismaService;
    let app: INestApplication;
    let providers: FakeProviders;
    const saved: Record<string, string | undefined> = {};
    const env = {
      ...billingEnv({ ASSIST_BOT_TOKEN: TEST_ASSIST_TOKEN }),
      QA_BOT_TOKEN: TEST_QA_TOKEN,
      SITES_INTERNAL_SECRET: INTERNAL,
      CRON_SECRET: CRON,
      ASSIST_WEBHOOK_SECRET: 'e4-webhook-secret',
      ASSIST_TERMS_URL: 'https://legal.example.com/terms',
      ASSIST_DPA_URL: 'https://legal.example.com/dpa',
    } as Record<string, string>;

    beforeAll(async () => {
      for (const k of [...Object.keys(env), 'ALLOW_DEV_AUTH'])
        saved[k] = process.env[k];
      Object.assign(process.env, env);
      delete process.env.ALLOW_DEV_AUTH;
      owner = ownerPrisma();
      providers = new FakeProviders();
      const mod = await Test.createTestingModule({
        imports: [InfraModule.with(owner), TelegramAuthModule, SiteCoreModule],
        controllers: [
          AssistBillingController,
          AssistBillingWebhookController,
          AssistBillingTickController,
          PlatformAdminController,
        ],
        providers: [
          { provide: AssistPaymentProviders, useValue: providers },
          AssistPayments,
          AssistBilling,
          AssistBillingTick,
          BillingNotices,
          PlatformAdmin,
          SonioxObservability,
        ],
      }).compile();
      const notices = mod.get(BillingNotices);
      notices.fetchImpl = async () => ({ ok: true, status: 200 });
      app = mod.createNestApplication({ logger: false });
      configureApp(app, loadConfiguration({}));
      await app.init();
    });

    afterAll(async () => {
      await app?.close();
      await owner.$disconnect();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
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
    const internal = (actor = 'admin-user-1') => ({
      'X-Sites-Internal-Secret': INTERNAL,
      'X-Admin-Actor': actor,
    });

    it('кабинет: сводку видят участники (платежи — только владелец); платить — только владелец; без initData — 401/403', async () => {
      const a = await createAccount(owner);
      await request(srv()).get('/assist/billing').expect(401);
      const asOwner = await request(srv())
        .get('/assist/billing')
        .set(as(a.ownerTelegramId))
        .expect(200);
      expect(asOwner.body.data).toMatchObject({
        plan: { id: 'trial', status: 'trial' },
        usage: { units: 0, limit: 50 },
        canPay: true,
        methods: { stars: true, wayforpay: true },
        legal: {
          terms: { accepted: false, url: 'https://legal.example.com/terms' },
        },
        dialogWeights: { text: 1, voice: 2, admin: 3 },
      });
      expect(asOwner.body.data.plans.map((p: { id: string }) => p.id)).toEqual([
        'trial',
        'start',
        'business',
        'pro',
      ]);
      const asManager = await request(srv())
        .get('/assist/billing')
        .set(as(a.managerTelegramId))
        .expect(200);
      expect(asManager.body.data).toMatchObject({
        canPay: false,
        payments: [],
      });
      const body = { kind: 'subscription', planId: 'start', method: 'stars' };
      const denied = await request(srv())
        .post('/assist/billing/checkout')
        .set(as(a.managerTelegramId))
        .send(body)
        .expect(403);
      expect(denied.body.error.code).toBe('ACCOUNT_ROLE_REQUIRED');
      const noLegal = await request(srv())
        .post('/assist/billing/checkout')
        .set(as(a.ownerTelegramId))
        .send(body)
        .expect(409);
      expect(noLegal.body.error.code).toBe('LEGAL_REQUIRED');
      await request(srv())
        .post('/assist/billing/legal')
        .set(as(a.ownerTelegramId))
        .send({ accept: ['terms', 'dpa'], evalConsent: true })
        .expect(200);
      const ok = await request(srv())
        .post('/assist/billing/checkout')
        .set(as(a.ownerTelegramId))
        .send(body)
        .expect(200);
      expect(ok.body.data.starsInvoiceUrl).toMatch(/^https:\/\/t\.me\//);
    });

    it('кабинет: строгая форма тела — лишнее поле, чужой тариф, сумма от клиента — 400', async () => {
      const a = await createAccount(owner);
      const post = (b: unknown) =>
        request(srv())
          .post('/assist/billing/checkout')
          .set(as(a.ownerTelegramId))
          .send(b as object);
      expect(
        (
          await post({
            kind: 'subscription',
            planId: 'trial',
            method: 'stars',
          }).expect(400)
        ).body.error.code,
      ).toBe('PLAN_INVALID');
      expect(
        (
          await post({
            kind: 'subscription',
            planId: 'start',
            method: 'stars',
            amount: 1,
          }).expect(400)
        ).body.error.code,
      ).toBe('BILLING_INVALID');
      await post({ kind: 'topup', packs: 0, method: 'wayforpay' }).expect(400);
      await post({ kind: 'topup', packs: 11, method: 'wayforpay' }).expect(400);
      await post({
        kind: 'subscription',
        planId: 'start',
        method: 'paypal',
      }).expect(400);
    });

    it('вебхук WayForPay: квитанция accept на верхнем уровне JSON (без конверта), подписана; тариф применён', async () => {
      const a = await createAccount(owner);
      const h = as(a.ownerTelegramId);
      await request(srv())
        .post('/assist/billing/legal')
        .set(h)
        .send({ accept: ['terms', 'dpa'] })
        .expect(200);
      const co = await request(srv())
        .post('/assist/billing/checkout')
        .set(h)
        .send({ kind: 'subscription', planId: 'business', method: 'wayforpay' })
        .expect(200);
      const { paymentId, wayforpay } = co.body.data;
      expect(wayforpay.fields.serviceUrl).toBe(
        'https://api.e4.example.com/assist/billing/webhook/wayforpay',
      );
      expect(wayforpay.fields.returnUrl).toBe(
        'https://tma.e4.example.com/#/billing',
      );
      const r = await request(srv())
        .post('/assist/billing/webhook/wayforpay')
        .send(wfpCallback(paymentId, wayforpay.fields.amount * 100))
        .expect(200);
      expect(r.body).toMatchObject({
        orderReference: paymentId,
        status: 'accept',
      });
      expect(typeof r.body.signature).toBe('string');
      expect(r.body.success).toBeUndefined();
      const st = await request(srv())
        .get(`/assist/billing/payments/${paymentId}`)
        .set(h)
        .expect(200);
      expect(st.body.data).toMatchObject({
        status: 'succeeded',
        planId: 'business',
      });
      const ov = await request(srv()).get('/assist/billing').set(h).expect(200);
      expect(ov.body.data.plan).toMatchObject({
        id: 'business',
        status: 'active',
        renews: true,
      });
    });

    it('крон assist-billing-tick: без секрета — 401, с секретом — проход', async () => {
      await request(srv()).get('/cron/assist-billing-tick').expect(401);
      const r = await request(srv())
        .get('/cron/assist-billing-tick')
        .set('Authorization', `Bearer ${CRON}`)
        .expect(200);
      expect(r.body.data).toHaveProperty('ran');
    });

    it('внутренний API: без секрета — 401, без X-Admin-Actor — 401; без env — 503', async () => {
      await request(srv()).get('/internal/admin/assist/summary').expect(401);
      await request(srv()).get('/internal/admin/assist/soniox').expect(401);
      await request(srv())
        .get('/internal/admin/assist/soniox')
        .set('X-Sites-Internal-Secret', INTERNAL)
        .expect(401);
      const soniox = await request(srv())
        .get('/internal/admin/assist/soniox')
        .set(internal())
        .expect(200);
      expect(soniox.body.data).toMatchObject({
        available: true,
        billingAvailable: true,
      });
      expect(Array.isArray(soniox.body.data.groups)).toBe(true);
      await request(srv())
        .get('/internal/admin/assist/summary')
        .set('X-Sites-Internal-Secret', INTERNAL)
        .expect(401);
      await request(srv())
        .get('/internal/admin/assist/summary')
        .set({
          ...internal(),
          'X-Sites-Internal-Secret': 'wrong-secret-0123456789',
        })
        .expect(401);
      process.env.SITES_INTERNAL_SECRET = '';
      try {
        await request(srv())
          .get('/internal/admin/assist/summary')
          .set(internal())
          .expect(503);
      } finally {
        process.env.SITES_INTERNAL_SECRET = INTERNAL;
      }
      // Кабинетный initData внутренний API не открывает.
      const a = await createAccount(owner);
      await request(srv())
        .get('/internal/admin/assist/summary')
        .set(as(a.ownerTelegramId))
        .expect(401);
    });

    it('внутренний API: поиск кабинета, ручной тариф, продление, блокировка сайта — с журналом доступа', async () => {
      const a = await createAccount(owner);
      const host = (
        await owner.siteHost.findFirstOrThrow({
          where: { accountId: a.accountId },
        })
      ).host;
      const found = await request(srv())
        .get(`/internal/admin/assist/accounts?q=${encodeURIComponent(host)}`)
        .set(internal())
        .expect(200);
      expect(
        found.body.data.map((x: { accountId: string }) => x.accountId),
      ).toEqual([a.accountId]);
      const byOwner = await request(srv())
        .get(`/internal/admin/assist/accounts?q=${a.ownerTelegramId}`)
        .set(internal())
        .expect(200);
      expect(byOwner.body.data[0]).toMatchObject({
        accountId: a.accountId,
        plan: 'trial',
        limit: 50,
      });
      const set = await request(srv())
        .post(`/internal/admin/assist/accounts/${a.accountId}/plan`)
        .set(internal(ADMIN7))
        .send({ planId: 'pro', days: 60, note: 'пилот' })
        .expect(200);
      expect(set.body.data.state).toMatchObject({
        planId: 'pro',
        method: 'manual',
      });
      expect(set.body.data.usage.limit).toBe(3000);
      await request(srv())
        .post(`/internal/admin/assist/accounts/${a.accountId}/extend`)
        .set(internal(ADMIN7))
        .send({ days: 10 })
        .expect(200);
      const blocked = await request(srv())
        .patch(`/internal/admin/assist/sites/${a.siteId}`)
        .set(internal(ADMIN7))
        .send({ blocked: true })
        .expect(200);
      expect(blocked.body.data.sites[0].blocked).toBe(true);
      const log = await owner.assistPlatformAccessLog.findMany({
        where: { actor: ADMIN7 },
        select: { action: true, target: true },
      });
      expect(log.map((l) => l.action)).toEqual(
        expect.arrayContaining([
          'account:set-plan:pro:60d',
          'account:extend:10d',
          'site:block',
        ]),
      );
      await request(srv())
        .post(`/internal/admin/assist/accounts/${a.accountId}/plan`)
        .set(internal())
        .send({ planId: 'gold', days: 1 })
        .expect(400);
    });

    it('ревью: «в eval платформы» — только при согласии кабинета в DPA', async () => {
      const yes = await createAccount(owner);
      const no = await createAccount(owner);
      await setPlan(owner, yes.accountId, 'start');
      for (const [a, consent] of [
        [yes, true],
        [no, false],
      ] as const) {
        await owner.assistLegalAcceptance.create({
          data: {
            accountId: a.accountId,
            document: 'dpa',
            version: '2026-10-04-draft',
            evalConsent: consent,
            acceptedByTelegramId: a.ownerTelegramId,
          },
        });
      }
      const msg = async (a: { accountId: string; siteId: string }) => {
        const conv = await owner.assistSiteConversation.create({
          data: {
            accountId: a.accountId,
            siteId: a.siteId,
            visitorId: 'v',
            ipHash: 'h',
            parentOrigin: 'https://x.example.com',
          },
        });
        await owner.assistSiteMessage.create({
          data: {
            accountId: a.accountId,
            siteId: a.siteId,
            conversationId: conv.id,
            role: 'visitor',
            text: 'Сколько стоит? [телефон скрыт]',
            flags: [],
          },
        });
        return owner.assistSiteMessage.create({
          data: {
            accountId: a.accountId,
            siteId: a.siteId,
            conversationId: conv.id,
            role: 'assistant',
            text: 'Стоит 999 грн',
            flags: ['unsupported_number'],
            createdAt: new Date(Date.now() + 1000),
          },
        });
      };
      const mYes = await msg(yes);
      const mNo = await msg(no);
      const list = await request(srv())
        .get('/internal/admin/assist/review?days=1&limit=200')
        .set(internal(REVIEWER))
        .expect(200);
      const mine = list.body.data.filter((r: { messageId: string }) =>
        [mYes.id, mNo.id].includes(r.messageId),
      );
      expect(mine).toHaveLength(2);
      expect(
        mine.find((r: { messageId: string }) => r.messageId === mYes.id),
      ).toMatchObject({
        question: 'Сколько стоит? [телефон скрыт]',
        evalConsent: true,
      });
      await request(srv())
        .post(`/internal/admin/assist/review/${mYes.id}/eval`)
        .set(internal(REVIEWER))
        .expect(200);
      const refused = await request(srv())
        .post(`/internal/admin/assist/review/${mNo.id}/eval`)
        .set(internal(REVIEWER))
        .expect(409);
      expect(refused.body.error.code).toBe('NO_CONSENT');
      expect(
        await owner.assistPlatformEvalCandidate.count({
          where: { messageId: { in: [mYes.id, mNo.id] } },
        }),
      ).toBe(1);
      expect(
        await owner.assistPlatformAccessLog.count({
          where: { actor: REVIEWER, action: { startsWith: 'review:list' } },
        }),
      ).toBe(1);
    });

    it('настройки платформы: env — верхняя граница; админка пишет и журналирует (значения без эффекта на соседние тесты)', async () => {
      const r = await request(srv())
        .patch('/internal/admin/assist/settings')
        .set(internal('admin-s'))
        .send({ enabled: true, dailyCapUsd: 100_000 })
        .expect(200);
      expect(r.body.data.widget).toEqual({
        enabled: true,
        dailyCapUsd: 100_000,
      });
      resetPlatformSettingsCache();
      expect(await readWidgetPlatformSettings(owner)).toEqual({
        enabled: true,
        dailyCapUsd: 100_000,
      });
      await request(srv())
        .patch('/internal/admin/assist/settings')
        .set(internal('admin-s'))
        .send({ dailyCapUsd: null })
        .expect(200);
      await request(srv())
        .patch('/internal/admin/assist/settings')
        .set(internal())
        .send({ enabled: 'no' })
        .expect(400);
      const sum = await request(srv())
        .get('/internal/admin/assist/summary?days=7')
        .set(internal())
        .expect(200);
      expect(sum.body.data).toHaveProperty('marginUsd');
      await request(srv())
        .get('/internal/admin/assist/costs?days=30')
        .set(internal())
        .expect(200);
      await request(srv())
        .get('/internal/admin/assist/abuse?days=7')
        .set(internal())
        .expect(200);
    });

    it('вебхук бота Помощника: оплата Stars — платежам (передача человеку её не видит); прочее — передаче', async () => {
      const seen: unknown[] = [];
      const updates = {
        handle: async (u: unknown) => void seen.push(u),
      } as unknown as AssistBotUpdates;
      const failing = {
        handleTelegramUpdate: async () => {
          throw new Error('db down');
        },
      } as unknown as AssistPayments;
      const ctl = new TelegramWebhookController(
        updates,
        app.get(AssistPayments),
      );
      await ctl.assist('e4-webhook-secret', {
        update_id: 1,
        pre_checkout_query: {
          id: 'q1',
          currency: 'XTR',
          total_amount: 1,
          invoice_payload: 'nope',
        },
      });
      expect(seen).toHaveLength(0);
      expect(providers.preCheckouts.at(-1)).toMatchObject({
        id: 'q1',
        ok: false,
      });
      await ctl.assist('e4-webhook-secret', {
        update_id: 2,
        message: { text: '/start' },
      });
      expect(seen).toHaveLength(1);
      // Сбой применения оплаты — не 200: Telegram повторит (деньги уже списаны).
      const ctl2 = new TelegramWebhookController(updates, failing);
      await expect(
        ctl2.assist('e4-webhook-secret', {
          message: { successful_payment: {} },
        }),
      ).rejects.toMatchObject({ status: 500 });
    });
  },
);
