/**
 * Маршруты знаний Э1 по HTTP (K3; контракт Э1 §6, приёмка D2 и http-части
 * B1/B4): настоящие гварды (initData двух ботов, SiteAccountGuard, права по
 * продукту), конверт и фильтр приложения, настоящая база, НАСТОЯЩИЕ
 * сервисы K1/K2 (обход, индексация, версии) — вызовы K2 записываются шпионом,
 * чтобы проверить форму стыка «K3 → K2» (контракт §4). Подделки: Blob (в
 * памяти, токен настоящий), сеть (https-стенд K3), ИИ (детерминированный).
 */
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
import { loadConfiguration } from '../../config/configuration';
import { AssistPublicDb } from '../../prisma/assist-public-db.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import { AdminKnowledgeService } from '../../modules/assist-admin-knowledge/admin-knowledge.service';
import { AdminSourcesService } from '../../modules/assist-admin-knowledge/admin-sources.service';
import { AssistAdminKnowledgeModule } from '../../modules/assist-admin-knowledge/assist-admin-knowledge.module';
import { KnowledgeBlobStorage } from '../../modules/assist-knowledge-core/documents/blob-storage';
import { FakeBlobStorage } from '../../modules/assist-knowledge-core/documents/testing/fake-blob.testing';
import { AssistKnowledgeCoreModule } from '../../modules/assist-knowledge-core/assist-knowledge-core.module';
import { AssistSandboxModule } from '../../modules/assist-sandbox/assist-sandbox.module';
import { SandboxService } from '../../modules/assist-sandbox/sandbox.service';
import {
  FakeText,
  describeDb,
  fakeEmbedTransport,
  ownerPrisma,
  publicPrisma,
  randomV6Prefix,
  uniq,
} from '../../modules/assist-sandbox/testing/k3-stack.testing';
import { K3Sites } from '../../modules/assist-sandbox/testing/k3-sites.testing';
import { K3_DOMAINS } from '../../modules/assist-sandbox/testing/k3-tls.testing';
import { AssistSiteKnowledgeModule } from '../../modules/assist-site-knowledge/assist-site-knowledge.module';
import { AssistCrawlScheduler } from '../../modules/assist-site-knowledge/crawl-scheduler.service';
import { SiteKnowledgeService } from '../../modules/assist-site-knowledge/site-knowledge.service';
import { SiteSourcesService } from '../../modules/assist-site-knowledge/site-sources.service';
import { EMBED_TRANSPORT } from '../../modules/site-ai/embedder';
import { SiteAiModule } from '../../modules/site-ai/site-ai.module';
import { GeminiText } from '../../modules/site-ai/text-model';
import { OWNER_PRODUCT_ROLES } from '../../modules/site-core/account/roles';
import type { ProductRoles } from '../../modules/site-core/account/roles';
import { SiteCoreModule } from '../../modules/site-core/site-core.module';
import { PINNED_HTTP_DEPS } from '../../modules/site-crawl/net/pinned-fetch';
import { SiteCrawlModule } from '../../modules/site-crawl/site-crawl.module';
import { TelegramAuthModule } from '../../modules/telegram-auth/telegram-auth.module';
import {
  TEST_ASSIST_TOKEN,
  TEST_QA_TOKEN,
  signInitData,
} from '../../modules/telegram-auth/test-init-data';

// Поднятие стенда и HTTP-серии под нагрузкой CI дольше 5 с по умолчанию.
jest.setTimeout(30_000);

/** Домены http-спека (у sandbox-acceptance — 1–28). */
const POOL = K3_DOMAINS.slice(28);
const DAY = 24 * 60 * 60 * 1000;

@Global()
@Module({})
class TestInfraModule {
  static with(p: {
    prisma: PrismaService;
    publicDb: AssistPublicDb;
    net: K3Sites;
  }): DynamicModule {
    return {
      module: TestInfraModule,
      providers: [
        { provide: PrismaService, useValue: p.prisma },
        { provide: SitesDb, useValue: new SitesDb(p.prisma) },
        { provide: AssistPublicDb, useValue: p.publicDb },
        { provide: PINNED_HTTP_DEPS, useValue: p.net.deps() },
        { provide: EMBED_TRANSPORT, useValue: fakeEmbedTransport() },
      ],
      exports: [
        PrismaService,
        SitesDb,
        AssistPublicDb,
        PINNED_HTTP_DEPS,
        EMBED_TRANSPORT,
      ],
    };
  }
}

const ENV_KEYS = [
  'ASSIST_BOT_TOKEN',
  'QA_BOT_TOKEN',
  'CRON_SECRET',
  'ALLOW_DEV_AUTH',
  'ASSIST_TMA_URL',
  'ASSIST_SANDBOX_PUBLIC_ENABLED',
  'ASSIST_SECRETS_KEY',
] as const;

describeDb(
  'Маршруты знаний Э1 по HTTP (права, стыки K3→K2, изоляция режимов)',
  () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let publicDb: AssistPublicDb;
    let net: K3Sites;
    let blob: FakeBlobStorage;
    let siteApi: SiteKnowledgeService;
    let adminApi: AdminKnowledgeService;
    const saved: Record<string, string | undefined> = {};
    const accounts: string[] = [];
    let poolNext = 0;

    beforeAll(async () => {
      Logger.overrideLogger(false);
      for (const k of ENV_KEYS) saved[k] = process.env[k];
      process.env.ASSIST_BOT_TOKEN = TEST_ASSIST_TOKEN;
      process.env.QA_BOT_TOKEN = TEST_QA_TOKEN;
      process.env.CRON_SECRET = 'cron-secret-for-test';
      delete process.env.ALLOW_DEV_AUTH;
      delete process.env.ASSIST_TMA_URL;
      process.env.ASSIST_SANDBOX_PUBLIC_ENABLED = 'true';
      process.env.ASSIST_SECRETS_KEY = 'k3-http-secret';

      prisma = ownerPrisma();
      publicDb = await publicPrisma(prisma);
      net = await new K3Sites().start();
      await prisma.assistSandbox.deleteMany({
        where: { registrableDomain: { in: [...POOL] } },
      });
      await prisma.assistDailyCounter.deleteMany({
        where: { scope: 'sandbox-domain', key: { in: [...POOL] } },
      });
      blob = new FakeBlobStorage();
      const mod = await Test.createTestingModule({
        imports: [
          TestInfraModule.with({ prisma, publicDb, net }),
          TelegramAuthModule,
          SiteCoreModule,
          SiteCrawlModule,
          SiteAiModule,
          AssistKnowledgeCoreModule,
          AssistSiteKnowledgeModule,
          AssistAdminKnowledgeModule,
          AssistSandboxModule,
        ],
      })
        .overrideProvider(KnowledgeBlobStorage)
        .useValue(blob)
        .overrideProvider(GeminiText)
        .useValue(new FakeText())
        .compile();
      app = mod.createNestApplication();
      configureApp(app, loadConfiguration({}));
      await app.init();
      siteApi = app.get(SiteKnowledgeService);
      adminApi = app.get(AdminKnowledgeService);
      const sandbox = app.get(SandboxService);
      sandbox.minDelayMs = { public: 0, cabinet: 0 };
    });

    afterAll(async () => {
      await app?.close();
      if (accounts.length) {
        await prisma.siteAccount.deleteMany({
          where: { id: { in: accounts } },
        });
      }
      await prisma.assistSandbox.deleteMany({
        where: { registrableDomain: { in: [...POOL] } },
      });
      await net.stop();
      await publicDb.$disconnect();
      await prisma.$disconnect();
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });

    afterEach(() => jest.restoreAllMocks());

    const srv = () => app.getHttpServer();

    function as(
      tg: bigint,
      bot: 'assist' | 'qa' = 'assist',
    ): Record<string, string> {
      return {
        'X-Telegram-App': bot,
        'X-Telegram-Init-Data': signInitData({
          botToken: bot === 'assist' ? TEST_ASSIST_TOKEN : TEST_QA_TOKEN,
          userId: Number(tg),
        }),
      };
    }

    let tgNext = 7_100_000_000 + Math.floor(Math.random() * 1_000_000) * 10;
    interface Fixture {
      accountId: string;
      siteId: string;
      host: string;
      owner: bigint;
    }

    /**
     * Кабинет (владелец) + сайт + хост (verified по умолчанию). Домен из пула
     * сертификата стенда — только тестам, которые ходят в сеть (`withNet`).
     */
    async function fixture(verified = true, withNet = false): Promise<Fixture> {
      const domain = withNet ? POOL[poolNext++] : `${uniq('k3h')}.com`;
      if (!domain) throw new Error('пул доменов http-спека исчерпан');
      const host = `www.${domain}`;
      const acc = await prisma.siteAccount.create({
        data: { verifyToken: uniq('vt') },
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
      await prisma.siteHost.create({
        data: {
          accountId: acc.id,
          siteId: site.id,
          host,
          status: verified ? 'verified' : 'pending',
          method: verified ? 'dns' : null,
          verifiedAt: verified ? new Date() : null,
          expiresAt: verified ? new Date(Date.now() + 90 * DAY) : null,
        },
      });
      net.site(host, {
        '/robots.txt': {
          status: 200,
          headers: { 'content-type': 'text/plain' },
          body: 'User-agent: *\nAllow: /\n',
        },
        '/': net.html(
          '<html lang="ru"><head><title>Магазин</title></head><body><main><h1>Магазин</h1><p>Чайник ABC-1234 стоит 1200 грн, доставка по Киеву 150 грн.</p></main></body></html>',
        ),
        '/delivery': net.html(
          '<html lang="ru"><head><title>Доставка</title></head><body><main><h1>Доставка</h1><p>Доставка по Украине занимает два дня.</p></main></body></html>',
        ),
      });
      return { accountId: acc.id, siteId: site.id, host, owner };
    }

    async function addMember(
      f: Fixture,
      role: 'manager' | 'operator',
      productRoles: Partial<ProductRoles>,
    ): Promise<bigint> {
      const tg = BigInt(tgNext++);
      await prisma.siteAccountMember.create({
        data: {
          accountId: f.accountId,
          telegramId: tg,
          role,
          productRoles: {
            qa: 'none',
            assist: 'none',
            assistAdmin: 'none',
            ...productRoles,
          },
        },
      });
      return tg;
    }

    // ── D2: права ─────────────────────────────────────────────────────────

    describe('D2: права по продукту', () => {
      let f: Fixture;
      let manager: bigint;
      let operator: bigint;
      let adminOnly: bigint;

      beforeAll(async () => {
        f = await fixture();
        manager = await addMember(f, 'manager', { assist: 'manager' });
        operator = await addMember(f, 'operator', { assist: 'operator' });
        adminOnly = await addMember(f, 'manager', { assistAdmin: 'owner' });
      });

      const siteRoutes = (id: string): Array<[string, string]> => [
        ['get', `/assist/sites/${id}/knowledge/site/summary`],
        ['get', `/assist/sites/${id}/knowledge/site/sources`],
        ['get', `/assist/sites/${id}/knowledge/site/faq`],
        ['get', `/assist/sites/${id}/knowledge/site/documents`],
        ['get', `/assist/sites/${id}/knowledge/site/settings`],
        ['get', `/assist/sites/${id}/learning/site/versions`],
        ['get', `/assist/sites/${id}/learning/site/exclusions`],
        ['get', `/assist/sites/${id}/learning/site/quarantine`],
      ];
      const adminRoutes = (id: string): Array<[string, string]> => [
        ['get', `/assist/sites/${id}/knowledge/admin/summary`],
        ['get', `/assist/sites/${id}/knowledge/admin/sources`],
        ['get', `/assist/sites/${id}/knowledge/admin/faq`],
        ['get', `/assist/sites/${id}/knowledge/admin/documents`],
        ['get', `/assist/sites/${id}/knowledge/admin/settings`],
        ['get', `/assist/sites/${id}/learning/admin/versions`],
        ['get', `/assist/sites/${id}/learning/admin/exclusions`],
        ['get', `/assist/sites/${id}/learning/admin/quarantine`],
      ];

      async function statuses(
        tg: bigint,
        routes: Array<[string, string]>,
        bot: 'assist' | 'qa' = 'assist',
      ) {
        const out: number[] = [];
        for (const [, path] of routes) {
          const r = await request(srv()).get(path).set(as(tg, bot));
          out.push(r.status);
        }
        return out;
      }

      it('владелец: «Сайт» и «Админка» — 200', async () => {
        expect(new Set(await statuses(f.owner, siteRoutes(f.siteId)))).toEqual(
          new Set([200]),
        );
        expect(new Set(await statuses(f.owner, adminRoutes(f.siteId)))).toEqual(
          new Set([200]),
        );
      });

      it('manager «Сайта» без assistAdmin → 403 на каждом …/admin/*, «Сайт» — 200', async () => {
        expect(new Set(await statuses(manager, siteRoutes(f.siteId)))).toEqual(
          new Set([200]),
        );
        for (const [, path] of adminRoutes(f.siteId)) {
          const r = await request(srv()).get(path).set(as(manager));
          expect(r.status).toBe(403);
          expect(r.body.error.code).toBe('PRODUCT_ROLE_REQUIRED');
        }
        // Запись в «Админку» — тоже нет.
        const w = await request(srv())
          .post(`/assist/sites/${f.siteId}/knowledge/admin/faq`)
          .set(as(manager))
          .send({ question: 'Скидка сотрудникам?', answer: '37%' });
        expect(w.status).toBe(403);
        expect(
          await prisma.assistAdminFaq.count({ where: { siteId: f.siteId } }),
        ).toBe(0);
      });

      it('оператор → 403 на знания «Сайта» и «Админки», в т.ч. на запись', async () => {
        expect(new Set(await statuses(operator, siteRoutes(f.siteId)))).toEqual(
          new Set([403]),
        );
        expect(
          new Set(await statuses(operator, adminRoutes(f.siteId))),
        ).toEqual(new Set([403]));
        const w = await request(srv())
          .post(`/assist/sites/${f.siteId}/learning/site/exclusions`)
          .set(as(operator))
          .send({ kind: 'url', value: `https://${f.host}/` });
        expect(w.status).toBe(403);
        const sb = await request(srv())
          .post(`/assist/sites/${f.siteId}/sandbox`)
          .set(as(operator));
        expect(sb.status).toBe(403);
      });

      it('assistAdmin: owner без assist → «Админка» 200, «Сайт» 403', async () => {
        expect(
          new Set(await statuses(adminOnly, adminRoutes(f.siteId))),
        ).toEqual(new Set([200]));
        expect(
          new Set(await statuses(adminOnly, siteRoutes(f.siteId))),
        ).toEqual(new Set([403]));
      });

      it('initData бота QA на маршрутах помощника — 403; без initData — 401', async () => {
        const r = await request(srv())
          .get(`/assist/sites/${f.siteId}/knowledge/site/summary`)
          .set(as(f.owner, 'qa'));
        expect(r.status).toBe(403);
        const anon = await request(srv()).get(
          `/assist/sites/${f.siteId}/knowledge/site/summary`,
        );
        expect(anon.status).toBe(401);
      });

      it('чужой сайт — 404 SITE_NOT_FOUND (не 403: существование не раскрываем)', async () => {
        const g = await fixture();
        for (const [, path] of [
          ...siteRoutes(g.siteId),
          ...adminRoutes(g.siteId),
        ]) {
          const r = await request(srv()).get(path).set(as(f.owner));
          expect(r.status).toBe(404);
          expect(r.body.error.code).toBe('SITE_NOT_FOUND');
        }
      });

      it('режим нельзя выбрать телом: лишнее поле mode → 400', async () => {
        const r = await request(srv())
          .post(`/assist/sites/${f.siteId}/knowledge/site/faq`)
          .set(as(f.owner))
          .send({ question: 'Вопрос?', answer: 'Ответ', mode: 'admin' });
        expect(r.status).toBe(400);
      });
    });

    // ── Включение, настройки, переобход ───────────────────────────────────

    describe('enable / settings / hot-pages / recrawl', () => {
      it('enable: строка помощника, источник crawl, первый обход по verified-хосту', async () => {
        const f = await fixture();
        const spy = jest.spyOn(app.get(AssistCrawlScheduler), 'requestNow');
        const r = await request(srv())
          .post(`/assist/sites/${f.siteId}/enable`)
          .set(as(f.owner));
        expect(r.status).toBe(200);
        expect(r.body.data).toMatchObject({
          siteId: f.siteId,
          enabled: true,
          knowledgeVersion: 0,
          recrawlEvery: 'weekly',
          hotPages: [],
          adminAvailable: true,
          hasVerifiedHost: true,
          lastCrawl: expect.objectContaining({
            status: 'queued',
            trigger: 'initial',
          }),
        });
        expect(spy).toHaveBeenCalledWith(
          expect.objectContaining({
            accountId: f.accountId,
            siteId: f.siteId,
            trigger: 'initial',
          }),
        );
        const sources = await request(srv())
          .get(`/assist/sites/${f.siteId}/knowledge/site/sources`)
          .set(as(f.owner));
        expect(sources.body.data).toEqual([
          expect.objectContaining({
            kind: 'crawl',
            status: 'active',
            documentsCount: 0,
          }),
        ]);
        // Повторно — идемпотентно (второго crawl-источника нет).
        await request(srv())
          .post(`/assist/sites/${f.siteId}/enable`)
          .set(as(f.owner));
        expect(
          await prisma.assistSiteSource.count({
            where: { siteId: f.siteId, kind: 'crawl' },
          }),
        ).toBe(1);
      });

      it('без verified-хоста: enable без обхода, recrawl → 409 HOST_NOT_VERIFIED', async () => {
        const f = await fixture(false);
        const e = await request(srv())
          .post(`/assist/sites/${f.siteId}/enable`)
          .set(as(f.owner));
        expect(e.body.data).toMatchObject({
          hasVerifiedHost: false,
          lastCrawl: null,
        });
        const r = await request(srv())
          .post(`/assist/sites/${f.siteId}/knowledge/site/recrawl`)
          .set(as(f.owner));
        expect(r.status).toBe(409);
        expect(r.body.error.code).toBe('HOST_NOT_VERIFIED');
      });

      it('settings (частота) и hot-pages (≤ 10, только хосты сайта)', async () => {
        const f = await fixture();
        await request(srv())
          .post(`/assist/sites/${f.siteId}/enable`)
          .set(as(f.owner));
        const s = await request(srv())
          .patch(`/assist/sites/${f.siteId}/knowledge/site/settings`)
          .set(as(f.owner))
          .send({ recrawlEvery: 'manual' });
        expect(s.body.data).toMatchObject({
          recrawlEvery: 'manual',
          nextCrawlAt: null,
        });
        const bad = await request(srv())
          .patch(`/assist/sites/${f.siteId}/knowledge/site/settings`)
          .set(as(f.owner))
          .send({ recrawlEvery: 'hourly' });
        expect(bad.status).toBe(400);

        const tooMany = await request(srv())
          .put(`/assist/sites/${f.siteId}/knowledge/site/hot-pages`)
          .set(as(f.owner))
          .send({
            urls: Array.from(
              { length: 11 },
              (_, i) => `https://${f.host}/p${i}`,
            ),
          });
        expect(tooMany.status).toBe(400);
        expect(tooMany.body.error.code).toBe('HOT_PAGES_LIMIT');
        const foreign = await request(srv())
          .put(`/assist/sites/${f.siteId}/knowledge/site/hot-pages`)
          .set(as(f.owner))
          .send({ urls: ['https://evil.example.com/prices'] });
        expect(foreign.body.error.code).toBe('URL_INVALID');
        const ok = await request(srv())
          .put(`/assist/sites/${f.siteId}/knowledge/site/hot-pages`)
          .set(as(f.owner))
          .send({
            urls: [`https://${f.host}/prices#x`, `https://${f.host}/prices`],
          });
        expect(ok.status).toBe(200);
        expect(ok.body.data.hotPages).toEqual([`https://${f.host}/prices`]);
      });

      it('recrawl по verified-хосту → CrawlRunView', async () => {
        const f = await fixture();
        await request(srv())
          .post(`/assist/sites/${f.siteId}/enable`)
          .set(as(f.owner));
        const r = await request(srv())
          .post(`/assist/sites/${f.siteId}/knowledge/site/recrawl`)
          .set(as(f.owner));
        expect(r.status).toBe(200);
        expect(r.body.data).toMatchObject({
          id: expect.any(String),
          status: expect.stringMatching(/queued|running/),
          skippedByReason: expect.any(Object),
        });
      });
    });

    // ── FAQ: стык K3 → K2 и изоляция режимов маршрутом ────────────────────

    describe('FAQ', () => {
      it('«Сайт»: строка в assist_site_faq, индексация через indexDocuments (форма стыка)', async () => {
        const f = await fixture();
        const spy = jest.spyOn(siteApi, 'indexDocuments');
        const adminSpy = jest.spyOn(adminApi, 'indexDocuments');
        const r = await request(srv())
          .post(`/assist/sites/${f.siteId}/knowledge/site/faq`)
          .set(as(f.owner))
          .send({
            question: 'Есть ли самовывоз?',
            answer: 'Да, бесплатно, ул. Шевченко 1.',
            variants: ['Самовывоз?'],
            lang: 'ru',
          });
        expect(r.status).toBe(201);
        const faq = r.body.data;
        expect(faq).toEqual({
          id: expect.any(String),
          question: 'Есть ли самовывоз?',
          answer: 'Да, бесплатно, ул. Шевченко 1.',
          variants: ['Самовывоз?'],
          lang: 'ru',
          origin: 'owner',
          status: 'active',
          updatedAt: expect.any(String),
        });
        const src = await prisma.assistSiteSource.findFirst({
          where: { siteId: f.siteId, kind: 'faq' },
        });
        expect(spy).toHaveBeenCalledWith(
          { accountId: f.accountId, siteId: f.siteId },
          src?.id,
          [
            expect.objectContaining({
              ref: `faq:${faq.id}`,
              kind: 'faq',
              blocks: [],
              faq: {
                question: 'Есть ли самовывоз?',
                answer: 'Да, бесплатно, ул. Шевченко 1.',
                variants: ['Самовывоз?'],
              },
            }),
          ],
          { trigger: 'faq', byTelegramId: f.owner },
        );
        expect(adminSpy).not.toHaveBeenCalled();
        // Опубликовано сразу (действие человека), документ связан со строкой FAQ.
        const row = await prisma.assistSiteFaq.findUnique({
          where: { id: faq.id },
        });
        expect(row?.documentId).toEqual(expect.any(String));
        const settings = await prisma.assistSite.findFirst({
          where: { siteId: f.siteId },
        });
        expect(settings?.knowledgeVersion).toBeGreaterThan(0);
        // «Админка» этого FAQ не видит.
        const adminList = await request(srv())
          .get(`/assist/sites/${f.siteId}/knowledge/admin/faq`)
          .set(as(f.owner));
        expect(adminList.body.data).toEqual([]);

        // Архив → removeDocuments; удаление → строки нет.
        const rm = jest.spyOn(siteApi, 'removeDocuments');
        const p = await request(srv())
          .patch(`/assist/sites/${f.siteId}/knowledge/site/faq/${faq.id}`)
          .set(as(f.owner))
          .send({ status: 'archived' });
        expect(p.body.data.status).toBe('archived');
        expect(rm).toHaveBeenCalledWith(
          { accountId: f.accountId, siteId: f.siteId },
          src?.id,
          [`faq:${faq.id}`],
          f.owner,
        );
        const d = await request(srv())
          .delete(`/assist/sites/${f.siteId}/knowledge/site/faq/${faq.id}`)
          .set(as(f.owner));
        expect(d.body.data).toEqual({ ok: true });
        expect(
          await prisma.assistSiteFaq.count({ where: { siteId: f.siteId } }),
        ).toBe(0);
      });

      it('«Админка»: своя таблица и свой API; «Сайт» её FAQ не видит', async () => {
        const f = await fixture();
        const siteSpy = jest.spyOn(siteApi, 'indexDocuments');
        const r = await request(srv())
          .post(`/assist/sites/${f.siteId}/knowledge/admin/faq`)
          .set(as(f.owner))
          .send({
            question: 'Скидка сотрудникам?',
            answer: 'Внутренняя скидка 37%',
          });
        expect(r.status).toBe(201);
        expect(siteSpy).not.toHaveBeenCalled();
        expect(
          await prisma.assistAdminFaq.count({ where: { siteId: f.siteId } }),
        ).toBe(1);
        expect(
          await prisma.assistSiteFaq.count({ where: { siteId: f.siteId } }),
        ).toBe(0);
        const siteList = await request(srv())
          .get(`/assist/sites/${f.siteId}/knowledge/site/faq`)
          .set(as(f.owner));
        expect(siteList.body.data).toEqual([]);
      });
    });

    // ── Документы: токен Blob, проверка типа/размера, разбор кроном ───────

    describe('документы', () => {
      it('«Сайт»: без «увидят все» — 400; тип/размер — до токена', async () => {
        const f = await fixture();
        const base = {
          kind: 'file',
          fileName: 'price.csv',
          mimeType: 'text/csv',
          bytes: 100,
        };
        const noConfirm = await request(srv())
          .post(`/assist/sites/${f.siteId}/knowledge/site/sources`)
          .set(as(f.owner))
          .send(base);
        expect(noConfirm.body.error.code).toBe('PUBLIC_CONFIRM_REQUIRED');
        const badType = await request(srv())
          .post(`/assist/sites/${f.siteId}/knowledge/site/sources`)
          .set(as(f.owner))
          .send({
            ...base,
            fileName: 'a.exe',
            mimeType: 'application/octet-stream',
            confirmPublic: true,
          });
        expect(badType.body.error.code).toBe('DOCUMENT_TYPE');
        const big = await request(srv())
          .post(`/assist/sites/${f.siteId}/knowledge/site/sources`)
          .set(as(f.owner))
          .send({ ...base, bytes: 20 * 1024 * 1024 + 1, confirmPublic: true });
        expect(big.body.error.code).toBe('DOCUMENT_TOO_LARGE');
        expect(
          await prisma.assistSiteSource.count({
            where: { siteId: f.siteId, kind: 'file' },
          }),
        ).toBe(0);
      });

      it('CSV: токен → загрузка → uploaded → крон разбора → indexDocuments → документ', async () => {
        const f = await fixture();
        const csv = Buffer.from('Артикул;Назва;Ціна\nABC-1234;Чайник;1200\n');
        const r = await request(srv())
          .post(`/assist/sites/${f.siteId}/knowledge/site/sources`)
          .set(as(f.owner))
          .send({
            kind: 'file',
            fileName: 'Прайс.csv',
            mimeType: 'text/csv',
            bytes: csv.length,
            confirmPublic: true,
          });
        expect(r.status).toBe(201);
        const { source, upload } = r.body.data;
        expect(source).toMatchObject({
          kind: 'file',
          status: 'pending_upload',
          fileName: 'Прайс.csv',
          bytes: csv.length,
        });
        expect(upload).toEqual({
          pathname: `assist/${f.accountId}/${f.siteId}/site/${source.id}/Прайс.csv`,
          clientToken: expect.stringMatching(/^vercel_blob_client_/),
          maxBytes: csv.length,
          contentType: 'text/csv',
          expiresAt: expect.any(String),
        });

        const early = await request(srv())
          .post(
            `/assist/sites/${f.siteId}/knowledge/site/sources/${source.id}/uploaded`,
          )
          .set(as(f.owner));
        expect(early.status).toBe(409);
        expect(early.body.error.code).toBe('DOCUMENT_NOT_UPLOADED');

        blob.put(upload.pathname, csv, 'text/csv');
        const up = await request(srv())
          .post(
            `/assist/sites/${f.siteId}/knowledge/site/sources/${source.id}/uploaded`,
          )
          .set(as(f.owner));
        expect(up.body.data).toMatchObject({
          id: source.id,
          status: 'processing',
        });

        const spy = jest.spyOn(siteApi, 'indexDocuments');
        const done = await app
          .get(SiteSourcesService)
          .processPendingFiles(30_000);
        expect(done.processed).toBeGreaterThanOrEqual(1);
        expect(spy).toHaveBeenCalledWith(
          { accountId: f.accountId, siteId: f.siteId },
          source.id,
          [
            expect.objectContaining({
              ref: upload.pathname,
              kind: 'file',
              title: 'Прайс',
              blocks: [
                {
                  t: 'tr',
                  text: 'Артикул: ABC-1234; Назва: Чайник; Ціна: 1200',
                  path: [],
                },
              ],
            }),
          ],
          { trigger: 'document', byTelegramId: f.owner, replaceAll: true },
        );
        const list = await request(srv())
          .get(`/assist/sites/${f.siteId}/knowledge/site/sources`)
          .set(as(f.owner));
        expect(
          list.body.data.find((s: { id: string }) => s.id === source.id),
        ).toMatchObject({
          status: 'active',
          documentsCount: 1,
          error: null,
        });
        const docs = await request(srv())
          .get(
            `/assist/sites/${f.siteId}/knowledge/site/documents?sourceId=${source.id}`,
          )
          .set(as(f.owner));
        expect(docs.body.data).toEqual({
          items: [
            expect.objectContaining({
              sourceId: source.id,
              kind: 'file',
              status: 'active',
              chunks: expect.any(Number),
            }),
          ],
          nextCursor: null,
        });

        // Удаление: новая версия без документов, файл — из Blob, строки нет.
        const rm = jest.spyOn(siteApi, 'removeDocuments');
        const del = await request(srv())
          .delete(
            `/assist/sites/${f.siteId}/knowledge/site/sources/${source.id}`,
          )
          .set(as(f.owner));
        expect(del.body.data).toEqual({ ok: true });
        expect(rm).toHaveBeenCalledWith(
          { accountId: f.accountId, siteId: f.siteId },
          source.id,
          'all',
          f.owner,
        );
        expect(blob.removed).toContain(upload.pathname);
        expect(
          await prisma.assistSiteSource.count({ where: { id: source.id } }),
        ).toBe(0);
      });

      it('содержимое не совпало с типом — failed с понятной причиной; «Админка» — свой путь Blob', async () => {
        const f = await fixture();
        const body = Buffer.from([0x00, 0x01, 0x02, 0xff]);
        const r = await request(srv())
          .post(`/assist/sites/${f.siteId}/knowledge/admin/sources`)
          .set(as(f.owner))
          .send({
            kind: 'file',
            fileName: 'notes.txt',
            mimeType: 'text/plain',
            bytes: body.length,
          });
        expect(r.status).toBe(201);
        expect(r.body.data.upload.pathname).toMatch(
          new RegExp(`^assist/${f.accountId}/${f.siteId}/admin/`),
        );
        blob.put(r.body.data.upload.pathname, body, 'text/plain');
        await request(srv())
          .post(
            `/assist/sites/${f.siteId}/knowledge/admin/sources/${r.body.data.source.id}/uploaded`,
          )
          .set(as(f.owner));
        await app.get(AdminSourcesService).processPendingFiles(30_000);
        const row = await prisma.assistAdminSource.findUnique({
          where: { id: r.body.data.source.id },
        });
        expect(row).toMatchObject({ status: 'failed' });
        expect(row?.error).toMatch(/не совпадает с его типом/);
        // Файл «Админки» в таблицы «Сайта» не попал.
        expect(
          await prisma.assistSiteSource.count({ where: { siteId: f.siteId } }),
        ).toBe(0);
      });

      it('url-источник: только хосты сайта; страница — через fetcher K1 → документ', async () => {
        const f = await fixture(true, true);
        const bad = await request(srv())
          .post(`/assist/sites/${f.siteId}/knowledge/site/sources`)
          .set(as(f.owner))
          .send({ kind: 'url', urls: ['https://other.example.com/x'] });
        expect(bad.body.error.code).toBe('URL_INVALID');
        const http = await request(srv())
          .post(`/assist/sites/${f.siteId}/knowledge/site/sources`)
          .set(as(f.owner))
          .send({ kind: 'url', urls: [`http://${f.host}/delivery`] });
        expect(http.body.error.code).toBe('URL_INVALID');
        const r = await request(srv())
          .post(`/assist/sites/${f.siteId}/knowledge/site/sources`)
          .set(as(f.owner))
          .send({
            kind: 'url',
            urls: [`https://${f.host}/delivery`, `https://${f.host}/missing`],
          });
        expect(r.body.data.source).toMatchObject({
          kind: 'url',
          status: 'processing',
        });
        await app.get(SiteSourcesService).processPendingFiles(30_000);
        const row = await prisma.assistSiteSource.findUnique({
          where: { id: r.body.data.source.id },
        });
        expect(row).toMatchObject({
          status: 'active',
          documentsCount: 1,
          error: 'Пропущено страниц: 1',
        });
        expect(row?.config).toMatchObject({
          skipped: [{ url: `https://${f.host}/missing`, reason: 'http_4xx' }],
        });
        expect(net.hits).toContain(`${f.host}/delivery`);
      });
    });

    // ── Исключения (B4, http) и версии (B1, http) ─────────────────────────

    describe('исключения и версии', () => {
      it('POST exclusions → applyExclusion (сразу), дубль 409, DELETE → liftExclusion', async () => {
        const f = await fixture();
        const apply = jest.spyOn(siteApi, 'applyExclusion');
        const r = await request(srv())
          .post(`/assist/sites/${f.siteId}/learning/site/exclusions`)
          .set(as(f.owner))
          .send({
            kind: 'urlPrefix',
            value: `https://${f.host}/blog/?utm=1#x`,
            reason: 'устарело',
          });
        expect(r.status).toBe(201);
        expect(r.body.data).toEqual({
          id: expect.any(String),
          kind: 'urlPrefix',
          value: `https://${f.host}/blog/`,
          reason: 'устарело',
          chunksDeleted: expect.any(Number),
          createdAt: expect.any(String),
        });
        expect(apply).toHaveBeenCalledWith(
          { accountId: f.accountId, siteId: f.siteId },
          {
            kind: 'urlPrefix',
            value: `https://${f.host}/blog/`,
            reason: 'устарело',
          },
          f.owner,
        );
        const dup = await request(srv())
          .post(`/assist/sites/${f.siteId}/learning/site/exclusions`)
          .set(as(f.owner))
          .send({ kind: 'urlPrefix', value: `https://${f.host}/blog/` });
        expect(dup.status).toBe(409);
        expect(dup.body.error.code).toBe('EXCLUSION_DUPLICATE');
        const bad = await request(srv())
          .post(`/assist/sites/${f.siteId}/learning/site/exclusions`)
          .set(as(f.owner))
          .send({ kind: 'chunkHash', value: 'abc' });
        expect(bad.body.error.code).toBe('EXCLUSION_INVALID');

        const lift = jest.spyOn(siteApi, 'liftExclusion');
        const d = await request(srv())
          .delete(
            `/assist/sites/${f.siteId}/learning/site/exclusions/${r.body.data.id}`,
          )
          .set(as(f.owner));
        expect(d.body.data).toEqual({ ok: true });
        expect(lift).toHaveBeenCalledWith(
          { accountId: f.accountId, siteId: f.siteId },
          r.body.data.id,
        );
        const list = await request(srv())
          .get(`/assist/sites/${f.siteId}/learning/site/exclusions`)
          .set(as(f.owner));
        expect(list.body.data).toEqual([]);
      });

      it('publish удержанной версии → VersionView; не held → 409; откат вне окна → 409', async () => {
        const f = await fixture();
        await request(srv())
          .post(`/assist/sites/${f.siteId}/enable`)
          .set(as(f.owner));
        const now = Date.now();
        await prisma.assistSiteKnowledgeVersion.createMany({
          data: [
            {
              accountId: f.accountId,
              siteId: f.siteId,
              number: 1,
              trigger: 'crawl',
              status: 'published',
              publishedAt: new Date(now - 10 * DAY),
            },
            {
              accountId: f.accountId,
              siteId: f.siteId,
              number: 2,
              trigger: 'crawl',
              status: 'published',
              publishedAt: new Date(now - DAY),
            },
            {
              accountId: f.accountId,
              siteId: f.siteId,
              number: 3,
              trigger: 'crawl',
              status: 'held',
              heldReason: '50% страниц отвечают 503',
              gateReport: {
                checks: [
                  {
                    check: 'gone_or_error_share',
                    value: 0.5,
                    threshold: 0.3,
                    held: true,
                  },
                ],
                held: true,
                coldStart: false,
              },
            },
          ],
        });
        await prisma.assistSite.updateMany({
          where: { siteId: f.siteId },
          data: { knowledgeVersion: 2, versionSeq: 3 },
        });

        const list = await request(srv())
          .get(`/assist/sites/${f.siteId}/learning/site/versions`)
          .set(as(f.owner));
        expect(
          list.body.data.map(
            (v: {
              number: number;
              isPublished: boolean;
              canRollback: boolean;
            }) => [v.number, v.isPublished, v.canRollback],
          ),
        ).toEqual([
          [3, false, false],
          [2, true, false],
          [1, false, false],
        ]);
        expect(list.body.data[0]).toMatchObject({
          status: 'held',
          heldReason: '50% страниц отвечают 503',
          gateReport: { held: true },
        });
        const summary = await request(srv())
          .get(`/assist/sites/${f.siteId}/knowledge/site/summary`)
          .set(as(f.owner));
        expect(summary.body.data.heldVersion).toMatchObject({
          number: 3,
          status: 'held',
        });

        const notHeld = await request(srv())
          .post(`/assist/sites/${f.siteId}/learning/site/versions/2/publish`)
          .set(as(f.owner));
        expect(notHeld.status).toBe(409);
        expect(notHeld.body.error.code).toBe('VERSION_NOT_HELD');
        const old = await request(srv())
          .post(`/assist/sites/${f.siteId}/learning/site/versions/1/rollback`)
          .set(as(f.owner));
        expect(old.status).toBe(409);
        expect(old.body.error.code).toBe('VERSION_NOT_ROLLBACKABLE');

        const publish = jest
          .spyOn(siteApi, 'publishHeld')
          .mockImplementation(async (ctx, n, by) => {
            await prisma.assistSiteKnowledgeVersion.updateMany({
              where: { siteId: ctx.siteId, number: n },
              data: {
                status: 'published',
                publishedAt: new Date(),
                publishedByTelegramId: by,
              },
            });
            await prisma.assistSite.updateMany({
              where: { siteId: ctx.siteId },
              data: { knowledgeVersion: n },
            });
            return { number: n, status: 'published', gateReport: null };
          });
        const p = await request(srv())
          .post(`/assist/sites/${f.siteId}/learning/site/versions/3/publish`)
          .set(as(f.owner));
        expect(p.status).toBe(200);
        expect(publish).toHaveBeenCalledWith(
          { accountId: f.accountId, siteId: f.siteId },
          3,
          f.owner,
        );
        expect(p.body.data).toMatchObject({
          number: 3,
          status: 'published',
          isPublished: true,
          canRollback: false,
        });
        const missing = await request(srv())
          .post(`/assist/sites/${f.siteId}/learning/site/versions/99/discard`)
          .set(as(f.owner));
        expect(missing.status).toBe(404);
        expect(missing.body.error.code).toBe('VERSION_NOT_FOUND');
      });
    });

    // ── «Админка»: переключатель копии публичного обхода ──────────────────

    describe('«Админка»: настройки и сводка', () => {
      it('PATCH settings → AdminKnowledgeService.updateSettings; сводка несёт settings', async () => {
        const f = await fixture();
        const g = await request(srv())
          .get(`/assist/sites/${f.siteId}/knowledge/admin/settings`)
          .set(as(f.owner));
        expect(g.body.data).toEqual({
          includePublicInAdmin: true,
          includeUgcInAdmin: false,
        });
        const spy = jest.spyOn(adminApi, 'updateSettings');
        const p = await request(srv())
          .patch(`/assist/sites/${f.siteId}/knowledge/admin/settings`)
          .set(as(f.owner))
          .send({ includePublicInAdmin: false });
        expect(p.status).toBe(200);
        expect(p.body.data).toEqual({
          includePublicInAdmin: false,
          includeUgcInAdmin: false,
        });
        expect(spy).toHaveBeenCalledWith(
          { accountId: f.accountId, siteId: f.siteId },
          { includePublicInAdmin: false },
          f.owner,
        );
        const s = await request(srv())
          .get(`/assist/sites/${f.siteId}/knowledge/admin/summary`)
          .set(as(f.owner));
        expect(s.body.data).toMatchObject({
          mode: 'admin',
          publishedVersion: expect.any(Number),
          pages: { read: 0, skipped: 0, skippedByReason: {} },
          suggestedQuestions: [],
          learningBudget: {
            period: expect.stringMatching(/^\d{4}-\d{2}$/),
            capMicroUsd: 500000,
            spentMicroUsd: expect.any(Number),
          },
          settings: { includePublicInAdmin: false, includeUgcInAdmin: false },
        });
        const bad = await request(srv())
          .patch(`/assist/sites/${f.siteId}/knowledge/admin/settings`)
          .set(as(f.owner))
          .send({ includePublicInAdmin: 'нет' });
        expect(bad.status).toBe(400);
      });
    });

    // ── Песочница по HTTP ─────────────────────────────────────────────────

    describe('песочница по HTTP', () => {
      it('публичная: POST → ключ один раз; GET без X-Sandbox-Key — 404; с ключом — вид', async () => {
        const f = await fixture(false, true);
        const c = await request(srv())
          .post('/public/assist/sandbox')
          .set('X-Forwarded-For', `${randomV6Prefix()}::5`)
          .send({ url: `https://${f.host}/` });
        expect(c.status).toBe(201);
        expect(c.body.data).toEqual({
          id: expect.any(String),
          sandboxKey: expect.any(String),
          status: 'queued',
        });
        const noKey = await request(srv()).get(
          `/public/assist/sandbox/${c.body.data.id}`,
        );
        expect(noKey.status).toBe(404);
        expect(noKey.body.error.code).toBe('SANDBOX_NOT_FOUND');
        let v = await request(srv())
          .get(`/public/assist/sandbox/${c.body.data.id}`)
          .set('X-Sandbox-Key', c.body.data.sandboxKey);
        for (
          let i = 0;
          i < 20 &&
          ['queued', 'crawling', 'indexing'].includes(v.body.data.status);
          i++
        ) {
          v = await request(srv())
            .get(`/public/assist/sandbox/${c.body.data.id}`)
            .set('X-Sandbox-Key', c.body.data.sandboxKey);
        }
        expect(v.body.data).toMatchObject({
          status: 'ready',
          kind: 'public',
          answersFrom: 'sandbox',
        });
        const long = await request(srv())
          .post(`/public/assist/sandbox/${c.body.data.id}/chat`)
          .set('X-Sandbox-Key', c.body.data.sandboxKey)
          .send({ question: 'х'.repeat(501) });
        expect(long.status).toBe(400);
        const a = await request(srv())
          .post(`/public/assist/sandbox/${c.body.data.id}/chat`)
          .set('X-Sandbox-Key', c.body.data.sandboxKey)
          .send({ question: 'Сколько стоит ABC-1234?' });
        expect(a.status).toBe(200);
        expect(a.body.data).toMatchObject({
          refused: false,
          questionsLeft: 9,
          sources: [expect.objectContaining({ n: 1 })],
        });

        // Перенос sb_<id> по HTTP — владелец/менеджер кабинета.
        const m = await fixture();
        const t = await request(srv())
          .post(`/assist/sandbox/${c.body.data.id}/transfer`)
          .set(as(m.owner));
        expect(t.status).toBe(200);
        expect(t.body.data).toEqual({
          siteId: expect.any(String),
          hostId: expect.any(String),
        });
        const cab = await request(srv())
          .get(`/assist/sites/${t.body.data.siteId}/sandbox`)
          .set(as(m.owner));
        expect(cab.body.data).toMatchObject({
          id: c.body.data.id,
          questionsLimit: 20,
        });
      });

      it('рубильник выключен — 503 SANDBOX_DISABLED в конверте ошибки', async () => {
        const sandbox = app.get(SandboxService);
        const env = sandbox.env;
        sandbox.env = { ...env, ASSIST_SANDBOX_PUBLIC_ENABLED: 'false' };
        try {
          const r = await request(srv())
            .post('/public/assist/sandbox')
            .send({ url: 'https://example.com' });
          expect(r.status).toBe(503);
          expect(r.body).toMatchObject({
            success: false,
            error: { code: 'SANDBOX_DISABLED' },
          });
        } finally {
          sandbox.env = env;
        }
      });

      it('url-preview (шаг 2): без записи; http:// — 400 URL_REJECTED', async () => {
        const f = await fixture(false, true);
        // Счёт — по хосту и кабинету фикстуры: песочницы параллельных файлов
        // (e1/sandbox-acceptance и др.) меняют общий count() в любой момент.
        const mine = {
          OR: [
            { host: f.host },
            { accountId: f.accountId },
            { siteId: f.siteId },
          ],
        };
        const before = await prisma.assistSandbox.count({ where: mine });
        const r = await request(srv())
          .post('/assist/url-preview')
          .set(as(f.owner))
          .send({ url: `${f.host}` });
        expect(r.status).toBe(200);
        expect(r.body.data).toEqual({
          url: `https://${f.host}/`,
          host: f.host,
          title: 'Магазин',
          lang: 'ru',
          sitemapFound: false,
          themeColor: null,
        });
        expect(await prisma.assistSandbox.count({ where: mine })).toBe(before);
        const bad = await request(srv())
          .post('/assist/url-preview')
          .set(as(f.owner))
          .send({ url: `http://${f.host}` });
        expect(bad.status).toBe(400);
        expect(bad.body.error.code).toBe('URL_REJECTED');
      });

      it('крон assist-retention: без секрета — 401; с секретом — отчёт', async () => {
        const no = await request(srv()).get('/cron/assist-retention');
        expect(no.status).toBe(401);
        const ok = await request(srv())
          .get('/cron/assist-retention')
          .set('Authorization', 'Bearer cron-secret-for-test');
        expect(ok.status).toBe(200);
        expect(ok.body.data).toMatchObject({
          ran: true,
          sandboxesDeleted: expect.any(Number),
          countersDeleted: expect.any(Number),
          crawlQueueDeleted: expect.any(Number),
        });
      });
    });
  },
);
