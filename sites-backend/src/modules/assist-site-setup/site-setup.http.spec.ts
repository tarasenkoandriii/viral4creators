/**
 * Кабинет виджета Э2 (W4) по HTTP: настоящие гварды (initData ботов,
 * SiteAccountGuard, права по продукту), конверт и фильтр приложения,
 * настоящая база (Postgres), настоящий pinnedFetch к https-стенду.
 *
 * Приёмка: 5а серверная (цвет-инъекция — отказ, SVG со script/onload —
 * ASSET_TYPE, имя-XSS хранится текстом и отдаётся данными — в т.ч. под
 * ролью assist_public), п.2 (проверка установки: CSP без директив →
 * csp_blocked с перечнем), публикация/откат (20 версий, гонка номеров),
 * права (operator — 403, чужой кабинет — 404), предпросмотр-токены.
 * Подделки: только PersonaGate (W3) и сеть (стенд K3).
 */
import { Global, INestApplication, Logger, Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash } from 'crypto';
import * as request from 'supertest';
import {
  WIDGET_LOADER_PATH,
  WIDGET_ORIGIN_DEFAULT,
  WIDGET_PK_LIVE_PREFIX,
  WIDGET_PK_TEST_PREFIX,
  WIDGET_PREVIEW_PARAM,
} from '../../brand';
import { configureApp } from '../../app.setup';
import { loadConfiguration } from '../../config/configuration';
import type { AssistPublicDb } from '../../prisma/assist-public-db.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import { PersonaGate } from '../assist-site-chat/persona-gate';
import { K3Sites } from '../assist-sandbox/testing/k3-sites.testing';
import {
  describeDb,
  ownerPrisma,
  publicPrisma,
} from '../assist-sandbox/testing/k3-stack.testing';
import {
  OWNER_PRODUCT_ROLES,
  type AccountMembership,
  type ProductRoles,
} from '../site-core/account/roles';
import { SiteCoreModule } from '../site-core/site-core.module';
import { PINNED_HTTP_DEPS } from '../site-crawl/net/pinned-fetch';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import {
  TEST_ASSIST_TOKEN,
  TEST_QA_TOKEN,
  signInitData,
} from '../telegram-auth/test-init-data';
import type { PersonaGateView } from './api-types';
import { setupCodeOf } from './errors';
import { InstallCheckService } from './install-check.service';
import { defaultPersona } from './persona';
import { PersonaService } from './persona.service';
import { SiteSetupController } from './site-setup.controller';
import { buildCspSnippet } from './snippet';
import { SVG_SCRIPT, jpegBytes, pngBytes } from './testing/images.testing';
import { defaultWidgetConfig, type WidgetConfig } from './widget-config';
import { WidgetSettingsService } from './widget-settings.service';
import { WidgetPublicConfigService } from '../assist-widget/widget-config.service';

const DAY = 24 * 60 * 60 * 1000;
/** Сертификат стенда выписан на *.k3sb40.com — свои поддомены у каждого фикстура. */
const ZONE = 'k3sb40.com';
const W = WIDGET_ORIGIN_DEFAULT;

@Global()
@Module({})
class W4Infra {
  static with(p: { prisma: PrismaService; net: K3Sites }): DynamicModule {
    return {
      module: W4Infra,
      providers: [
        { provide: PrismaService, useValue: p.prisma },
        { provide: SitesDb, useValue: new SitesDb(p.prisma) },
        { provide: PINNED_HTTP_DEPS, useValue: p.net.deps() },
      ],
      exports: [PrismaService, SitesDb, PINNED_HTTP_DEPS],
    };
  }
}

/** Ворота персоны W3 — подделка: решение задаёт тест. */
class FakeGate {
  next: PersonaGateView = {
    ran: true,
    invariantsPassed: true,
    blocked: false,
    notes: [],
  };
  calls = 0;
  check(): Promise<PersonaGateView> {
    this.calls++;
    return Promise.resolve(this.next);
  }
}

const ENV_KEYS = [
  'ASSIST_BOT_TOKEN',
  'QA_BOT_TOKEN',
  'ALLOW_DEV_AUTH',
  'ASSIST_WIDGET_ORIGIN',
] as const;

let labelNext = 0;
function label(): string {
  return `w4${process.pid.toString(36)}${Date.now().toString(36)}${labelNext++}`;
}

describeDb(
  'Кабинет виджета Э2 (W4): маршруты, права, публикация, установка',
  () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let publicDb: AssistPublicDb;
    let net: K3Sites;
    let widget: WidgetSettingsService;
    let install: InstallCheckService;
    const gate = new FakeGate();
    const saved: Record<string, string | undefined> = {};
    const accounts: string[] = [];
    let tgNext = 7_400_000_000 + Math.floor(Math.random() * 1_000_000) * 10;

    beforeAll(async () => {
      Logger.overrideLogger(false);
      for (const k of ENV_KEYS) saved[k] = process.env[k];
      process.env.ASSIST_BOT_TOKEN = TEST_ASSIST_TOKEN;
      process.env.QA_BOT_TOKEN = TEST_QA_TOKEN;
      delete process.env.ALLOW_DEV_AUTH;
      delete process.env.ASSIST_WIDGET_ORIGIN;
      prisma = ownerPrisma();
      publicDb = await publicPrisma(prisma);
      net = await new K3Sites().start();
      const mod = await Test.createTestingModule({
        imports: [
          W4Infra.with({ prisma, net }),
          TelegramAuthModule,
          SiteCoreModule,
        ],
        controllers: [SiteSetupController],
        providers: [
          WidgetSettingsService,
          PersonaService,
          InstallCheckService,
          { provide: PersonaGate, useValue: gate },
        ],
      }).compile();
      app = mod.createNestApplication();
      configureApp(app, loadConfiguration({}));
      await app.init();
      widget = app.get(WidgetSettingsService);
      install = app.get(InstallCheckService);
    });

    afterAll(async () => {
      await app?.close();
      if (accounts.length) {
        await prisma.siteAccount.deleteMany({
          where: { id: { in: accounts } },
        });
      }
      await net?.stop();
      await publicDb?.$disconnect();
      await prisma?.$disconnect();
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });

    const srv = () => app.getHttpServer();

    function as(tg: bigint, bot: 'assist' | 'qa' = 'assist') {
      return {
        'X-Telegram-App': bot,
        'X-Telegram-Init-Data': signInitData({
          botToken: bot === 'assist' ? TEST_ASSIST_TOKEN : TEST_QA_TOKEN,
          userId: Number(tg),
        }),
      };
    }

    interface Fx {
      accountId: string;
      siteId: string;
      owner: bigint;
      m: AccountMembership;
      verified: { id: string; host: string };
      pending: { id: string; host: string };
      grace: { id: string; host: string };
    }

    async function fixture(): Promise<Fx> {
      const acc = await prisma.siteAccount.create({
        data: { verifyToken: label() },
      });
      accounts.push(acc.id);
      const owner = BigInt(tgNext++);
      const member = await prisma.siteAccountMember.create({
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
      const now = Date.now();
      const mk = async (
        status: 'verified' | 'pending' | 'revoked',
      ): Promise<{ id: string; host: string }> => {
        const host = `${label()}.${ZONE}`;
        const h = await prisma.siteHost.create({
          data: {
            accountId: acc.id,
            siteId: site.id,
            host,
            status,
            method: status === 'pending' ? null : 'dns',
            verifiedAt: status === 'pending' ? null : new Date(now - DAY),
            expiresAt: status === 'pending' ? null : new Date(now + 90 * DAY),
            revokedAt:
              status === 'revoked' ? new Date(now - 60 * 60 * 1000) : null,
          },
        });
        return { id: h.id, host };
      };
      const verified = await mk('verified');
      const pending = await mk('pending');
      const grace = await mk('revoked');
      return {
        accountId: acc.id,
        siteId: site.id,
        owner,
        m: {
          accountId: acc.id,
          memberId: member.id,
          telegramId: owner,
          role: 'owner',
          productRoles: OWNER_PRODUCT_ROLES,
        },
        verified,
        pending,
        grace,
      };
    }

    async function addMember(
      f: Fx,
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

    async function expectCode(p: Promise<unknown>, code: string) {
      let err: unknown = null;
      try {
        await p;
      } catch (e) {
        err = e;
      }
      expect(setupCodeOf(err)).toBe(code);
    }

    // ── Права ────────────────────────────────────────────────────────────

    describe('права: assist manager; оператор — 403; чужой кабинет — 404', () => {
      let f: Fx;
      let manager: bigint;
      let operator: bigint;
      let stranger: Fx;

      beforeAll(async () => {
        f = await fixture();
        stranger = await fixture();
        manager = await addMember(f, 'manager', { assist: 'manager' });
        operator = await addMember(f, 'operator', { assist: 'operator' });
      });

      const routes = (
        id: string,
      ): Array<['get' | 'post' | 'patch', string, object?]> => [
        ['get', `/assist/sites/${id}/widget`],
        ['post', `/assist/sites/${id}/widget/keys`],
        ['patch', `/assist/sites/${id}/widget/draft`, { config: {} }],
        ['post', `/assist/sites/${id}/widget/publish`],
        ['post', `/assist/sites/${id}/widget/rollback/1`],
        [
          'post',
          `/assist/sites/${id}/widget/preview-token`,
          { purpose: 'tma' },
        ],
        ['post', `/assist/sites/${id}/widget/check-install`],
        ['patch', `/assist/sites/${id}/widget/controls`, { chatPaused: true }],
        ['post', `/assist/sites/${id}/widget/assets`, {}],
        ['get', `/assist/sites/${id}/persona`],
        ['patch', `/assist/sites/${id}/persona`, { persona: {} }],
        ['post', `/assist/sites/${id}/persona/publish`],
        ['post', `/assist/sites/${id}/persona/rollback/1`],
        ['get', `/assist/sites/${id}/leads-config`],
        ['patch', `/assist/sites/${id}/leads-config`, { config: {} }],
      ];

      it('оператор помощника получает 403 на КАЖДОМ маршруте, ничего не меняя', async () => {
        for (const [method, path, body] of routes(f.siteId)) {
          const r = await request(srv())
            [method](path)
            .set(as(operator))
            .send(body);
          expect([method, path, r.status]).toEqual([method, path, 403]);
        }
        const row = await prisma.assistSite.findFirst({
          where: { siteId: f.siteId },
        });
        expect(row?.publicKey ?? null).toBeNull();
        expect(row?.chatPaused ?? false).toBe(false);
      });

      it('менеджер помощника — 200; бот QA — 403', async () => {
        const ok = await request(srv())
          .get(`/assist/sites/${f.siteId}/widget`)
          .set(as(manager));
        expect(ok.status).toBe(200);
        expect(ok.body.success).toBe(true);
        expect(ok.body.data.siteId).toBe(f.siteId);
        const qa = await request(srv())
          .get(`/assist/sites/${f.siteId}/widget`)
          .set(as(f.owner, 'qa'));
        expect(qa.status).toBe(403);
      });

      it('сайт чужого кабинета — 404 SITE_NOT_FOUND (не 403: не оракул)', async () => {
        for (const [method, path, body] of routes(stranger.siteId)) {
          const r = await request(srv())
            [method](path)
            .set(as(f.owner))
            .send(body);
          expect([path, r.status]).toEqual([path, 404]);
        }
        const row = await prisma.assistSite.findFirst({
          where: { siteId: stranger.siteId },
        });
        expect(row).toBeNull();
      });
    });

    // ── Вид: черновик, ключи, публикация, откат ──────────────────────────

    describe('вид виджета', () => {
      let f: Fx;
      beforeAll(async () => {
        f = await fixture();
      });

      it('новый сайт: умолчание, включены только подтверждённые хосты, «не опубликован»', async () => {
        const r = await request(srv())
          .get(`/assist/sites/${f.siteId}/widget`)
          .set(as(f.owner));
        expect(r.status).toBe(200);
        const v = r.body.data;
        expect(v.publicKey).toBeNull();
        expect(v.snippet).toBe('');
        expect(v.cspSnippet).toBe(buildCspSnippet(W));
        expect(v.widgetOrigin).toBe(W);
        expect(v.publishedVersion).toBe(0);
        expect(v.draft.brand.name).toBe('Помощник Магазин');
        expect(v.draft.hosts).toEqual([
          { hostId: f.verified.id, enabled: true, pathMasks: [], hideOn: [] },
        ]);
        expect(v.warnings).toContainEqual({ code: 'not_published' });
        const hosts = Object.fromEntries(
          v.hosts.map((h: { hostId: string }) => [h.hostId, h]),
        );
        expect(hosts[f.verified.id]).toMatchObject({
          origin: `https://${f.verified.host}`,
          widgetAllowed: true,
          graceUntil: null,
        });
        expect(hosts[f.pending.id].widgetAllowed).toBe(false);
        expect(hosts[f.grace.id].widgetAllowed).toBe(true);
        expect(hosts[f.grace.id].graceUntil).not.toBeNull();
      });

      it('ключи: параллельные нажатия выдают ОДНУ пару; соль ipHash — одна', async () => {
        const rs = await Promise.all(
          Array.from({ length: 5 }, () =>
            request(srv())
              .post(`/assist/sites/${f.siteId}/widget/keys`)
              .set(as(f.owner)),
          ),
        );
        const keys = new Set(rs.map((r) => r.body.data.publicKey));
        expect(rs.every((r) => r.status === 200)).toBe(true);
        expect(keys.size).toBe(1);
        const v = rs[0].body.data;
        expect(v.publicKey).toMatch(
          new RegExp(`^${WIDGET_PK_LIVE_PREFIX}[0-9A-Za-z]{24}$`),
        );
        expect(v.testKey).toMatch(
          new RegExp(`^${WIDGET_PK_TEST_PREFIX}[0-9A-Za-z]{24}$`),
        );
        expect(v.snippet).toBe(
          `<script async src="${W}${WIDGET_LOADER_PATH}" data-site="${v.publicKey}"></script>`,
        );
        const row = await prisma.assistSite.findFirstOrThrow({
          where: { siteId: f.siteId },
        });
        expect(row.ipSalt).toMatch(/^[0-9a-f]{64}$/);
        const again = await request(srv())
          .post(`/assist/sites/${f.siteId}/widget/keys`)
          .set(as(f.owner));
        expect(again.body.data.publicKey).toBe(v.publicKey);
      });

      it('5а: цвет `red;background:url(//x)` — 400 WIDGET_CONFIG_INVALID, черновик не меняется', async () => {
        const before = await prisma.assistSite.findFirstOrThrow({
          where: { siteId: f.siteId },
        });
        const config = defaultWidgetConfig('x');
        (config.brand as { primaryColor: string }).primaryColor =
          'red;background:url(//x)';
        const r = await request(srv())
          .patch(`/assist/sites/${f.siteId}/widget/draft`)
          .set(as(f.owner))
          .send({ config });
        expect(r.status).toBe(400);
        expect(r.body.error.code).toBe('WIDGET_CONFIG_INVALID');
        const after = await prisma.assistSite.findFirstOrThrow({
          where: { siteId: f.siteId },
        });
        expect(after.widgetDraft).toEqual(before.widgetDraft);
        // В сервисе — перечень полей (наружу его пропустит фильтр — запрос координатору).
        let err: unknown;
        try {
          await widget.saveDraft(f.m, f.siteId, config);
        } catch (e) {
          err = e;
        }
        expect(
          (err as { getResponse(): { errors: unknown } }).getResponse().errors,
        ).toContainEqual({
          path: 'brand.primaryColor',
          code: 'color',
        });
      });

      it('хост чужого кабинета и чужая картинка — отказ по ссылке', async () => {
        const other = await fixture();
        const config = defaultWidgetConfig('x');
        config.hosts = [
          {
            hostId: other.verified.id,
            enabled: true,
            pathMasks: [],
            hideOn: [],
          },
        ];
        await expectCode(
          widget.saveDraft(f.m, f.siteId, config),
          'WIDGET_CONFIG_INVALID',
        );
        const asset = await widget.uploadAsset(other.m, other.siteId, {
          kind: 'logo',
          mime: 'image/png',
          dataBase64: pngBytes(64, 64).toString('base64'),
        });
        const c2 = defaultWidgetConfig('x');
        c2.brand.logoAssetId = asset.id;
        let err: unknown;
        try {
          await widget.saveDraft(f.m, f.siteId, c2);
        } catch (e) {
          err = e;
        }
        expect(
          (err as { getResponse(): { errors: unknown } }).getResponse().errors,
        ).toEqual([{ path: 'brand.logoAssetId', code: 'asset_unknown' }]);
      });

      it('5а: имя `<img src=x onerror=…>` — хранится текстом и отдаётся ДАННЫМИ (и роли assist_public)', async () => {
        const name = '<img src=x onerror=alert(1)>';
        const config = defaultWidgetConfig('x');
        config.brand.name = name;
        config.brand.primaryColor = '#FFFF00';
        config.hosts = [
          {
            hostId: f.verified.id,
            enabled: true,
            pathMasks: ['/catalog/*'],
            hideOn: [],
          },
          { hostId: f.pending.id, enabled: true, pathMasks: [], hideOn: [] },
          { hostId: f.grace.id, enabled: true, pathMasks: [], hideOn: [] },
        ];
        const r = await request(srv())
          .patch(`/assist/sites/${f.siteId}/widget/draft`)
          .set(as(f.owner))
          .send({ config });
        expect(r.status).toBe(200);
        const v = r.body.data;
        expect(v.draft.brand.name).toBe(name);
        expect(v.draft.brand.primaryColor).not.toBe('#FFFF00');
        expect(v.adjustments).toContainEqual(
          expect.objectContaining({
            path: 'brand.primaryColor',
            reason: 'contrast_darkened',
          }),
        );
        expect(v.warnings).toEqual(
          expect.arrayContaining([
            { code: 'low_contrast' },
            { code: 'host_not_verified', hostId: f.pending.id },
            expect.objectContaining({ code: 'host_grace', hostId: f.grace.id }),
          ]),
        );

        const pub = await request(srv())
          .post(`/assist/sites/${f.siteId}/widget/publish`)
          .set(as(f.owner));
        expect(pub.status).toBe(200);
        const pv = pub.body.data;
        expect(pv.publishedVersion).toBe(1);
        // Только подтверждённые СЕЙЧАС: pending и льготный хост не публикуются.
        expect(
          pv.published.hosts.map((h: { hostId: string }) => h.hostId),
        ).toEqual([f.verified.id]);
        expect(
          pv.adjustments.filter(
            (a: { reason: string }) => a.reason === 'host_not_verified',
          ),
        ).toHaveLength(2);
        expect(pv.draftChanged).toBe(true);
        expect(pv.history).toEqual([
          expect.objectContaining({
            version: 1,
            rolledBackFrom: null,
            publishedByTelegramId: String(f.owner),
          }),
        ]);
        // Prisma всегда добавляет в SELECT первичный ключ `id`, а у роли
        // виджета на эту таблицу — только (siteId, kind, version, config):
        // читаем сырым SQL, как и придётся W2/W3 (запрос координатору).
        const [row] = await publicDb.$queryRawUnsafe<
          Array<{ config: WidgetConfig }>
        >(
          `SELECT "config" FROM "sites"."assist_site_config_versions" WHERE "siteId" = $1 AND "kind" = 'widget' AND "version" = 1`,
          f.siteId,
        );
        expect(row.config.brand.name).toBe(name);
        const site = await prisma.assistSite.findFirstOrThrow({
          where: { siteId: f.siteId },
        });
        expect(site.widgetVersion).toBe(1);
        expect(site.configVersion).toBe(0);
      });

      it('гонка: 6 параллельных публикаций — 6 разных номеров подряд', async () => {
        const rs = await Promise.all(
          Array.from({ length: 6 }, () => widget.publish(f.m, f.siteId)),
        );
        expect(rs.every((r) => r.publishedVersion >= 2)).toBe(true);
        const versions = await prisma.assistSiteConfigVersion.findMany({
          where: { siteId: f.siteId, kind: 'widget' },
          select: { version: true },
          orderBy: { version: 'asc' },
        });
        expect(versions.map((v) => v.version)).toEqual([1, 2, 3, 4, 5, 6, 7]);
        const site = await prisma.assistSite.findFirstOrThrow({
          where: { siteId: f.siteId },
        });
        expect(site.widgetVersion).toBe(7);
      });

      it('история — 20 последних; откат N — новая версия с содержимым N', async () => {
        for (let i = 0; i < 15; i++) await widget.publish(f.m, f.siteId); // до 22
        const versions = await prisma.assistSiteConfigVersion.findMany({
          where: { siteId: f.siteId, kind: 'widget' },
          select: { version: true },
          orderBy: { version: 'asc' },
        });
        expect(versions).toHaveLength(20);
        expect(versions[0].version).toBe(3);
        await expectCode(
          widget.rollback(f.m, f.siteId, 1),
          'VERSION_NOT_FOUND',
        );
        const nf = await request(srv())
          .post(`/assist/sites/${f.siteId}/widget/rollback/999`)
          .set(as(f.owner));
        expect(nf.status).toBe(404);
        expect(nf.body.error.code).toBe('VERSION_NOT_FOUND');

        // Новый черновик → публикация 23 → откат к 22.
        const v22 = await prisma.assistSiteConfigVersion.findFirstOrThrow({
          where: { siteId: f.siteId, kind: 'widget', version: 22 },
        });
        const c = defaultWidgetConfig('Другое');
        c.hosts = [
          { hostId: f.verified.id, enabled: false, pathMasks: [], hideOn: [] },
        ];
        await widget.saveDraft(f.m, f.siteId, c);
        const p23 = await widget.publish(f.m, f.siteId);
        expect(p23.published?.brand.name).toBe('Помощник Другое');
        const rb = await request(srv())
          .post(`/assist/sites/${f.siteId}/widget/rollback/22`)
          .set(as(f.owner));
        expect(rb.status).toBe(200);
        expect(rb.body.data.publishedVersion).toBe(24);
        expect(rb.body.data.published).toEqual(v22.config);
        expect(rb.body.data.history[0]).toMatchObject({
          version: 24,
          rolledBackFrom: 22,
        });
        expect(rb.body.data.history).toHaveLength(20);
      });

      it('рубильник владельца', async () => {
        const r = await request(srv())
          .patch(`/assist/sites/${f.siteId}/widget/controls`)
          .set(as(f.owner))
          .send({ chatPaused: true });
        expect(r.status).toBe(200);
        expect(r.body.data.chatPaused).toBe(true);
        const off = await request(srv())
          .patch(`/assist/sites/${f.siteId}/widget/controls`)
          .set(as(f.owner))
          .send({ chatPaused: 'yes' });
        expect(off.body.data.chatPaused).toBe(false);
      });
    });

    // ── Предпросмотр ─────────────────────────────────────────────────────

    describe('токены предпросмотра', () => {
      let f: Fx;
      beforeAll(async () => {
        f = await fixture();
      });

      it('без ключей — KEYS_MISSING', async () => {
        const r = await request(srv())
          .post(`/assist/sites/${f.siteId}/widget/preview-token`)
          .set(as(f.owner))
          .send({ purpose: 'tma' });
        expect(r.status).toBe(400);
        expect(r.body.error.code).toBe('KEYS_MISSING');
      });

      it('tma: в базе только SHA-256, 30 минут, без origin', async () => {
        await widget.ensureKeys(f.m, f.siteId);
        const t0 = Date.now();
        const r = await request(srv())
          .post(`/assist/sites/${f.siteId}/widget/preview-token`)
          .set(as(f.owner))
          .send({ purpose: 'tma' });
        expect(r.status).toBe(200);
        const { token, url, expiresAt } = r.body.data;
        expect(url).toBeNull();
        expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        const exp = Date.parse(expiresAt) - t0;
        expect(exp).toBeGreaterThan(29 * 60 * 1000);
        expect(exp).toBeLessThanOrEqual(31 * 60 * 1000);
        const rows = await prisma.assistSitePreviewToken.findMany({
          where: { siteId: f.siteId },
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          tokenHash: createHash('sha256').update(token).digest('hex'),
          purpose: 'tma',
          origin: null,
          usedAt: null,
          createdByTelegramId: f.owner,
        });
        expect(
          JSON.stringify(rows[0], (_k, v) =>
            typeof v === 'bigint' ? String(v) : v,
          ),
        ).not.toContain(token);
      });

      it('site: только подтверждённый хост (не pending, не льгота); ссылка с одноразовым токеном', async () => {
        for (const hostId of [f.pending.id, f.grace.id, 'nope']) {
          const r = await request(srv())
            .post(`/assist/sites/${f.siteId}/widget/preview-token`)
            .set(as(f.owner))
            .send({ purpose: 'site', hostId });
          expect([hostId, r.body.error?.code]).toEqual([
            hostId,
            'HOST_NOT_VERIFIED',
          ]);
        }
        const bad = await request(srv())
          .post(`/assist/sites/${f.siteId}/widget/preview-token`)
          .set(as(f.owner))
          .send({ purpose: 'admin' });
        expect(bad.body.error.code).toBe('BAD_REQUEST');
        const r = await request(srv())
          .post(`/assist/sites/${f.siteId}/widget/preview-token`)
          .set(as(f.owner))
          .send({ purpose: 'site', hostId: f.verified.id });
        expect(r.status).toBe(200);
        const { token, url } = r.body.data;
        expect(url).toBe(
          `https://${f.verified.host}/?${WIDGET_PREVIEW_PARAM}=${token}`,
        );
        const row = await prisma.assistSitePreviewToken.findFirstOrThrow({
          where: {
            tokenHash: createHash('sha256').update(token).digest('hex'),
          },
        });
        expect(row.origin).toBe(`https://${f.verified.host}`);
        expect((row.draft as unknown as WidgetConfig).schema).toBe(1);
      });

      it('аудит Э2: tma — снимок ЧЕРНОВИКА; обмен под assist_public отдаёт его и до первой публикации', async () => {
        const g = await fixture();
        await widget.ensureKeys(g.m, g.siteId);
        const config = defaultWidgetConfig('Черновий магазин');
        config.brand.name = 'Черновик TMA';
        const d = await request(srv())
          .patch(`/assist/sites/${g.siteId}/widget/draft`)
          .set(as(g.owner))
          .send({ config });
        expect(d.status).toBe(200);
        const r = await request(srv())
          .post(`/assist/sites/${g.siteId}/widget/preview-token`)
          .set(as(g.owner))
          .send({ purpose: 'tma' });
        expect(r.status).toBe(200);
        const row = await prisma.assistSite.findUniqueOrThrow({
          where: { siteId: g.siteId },
          select: { publicKey: true, widgetVersion: true },
        });
        expect(row.widgetVersion).toBe(0); // вид ещё не опубликован
        const ex = await new WidgetPublicConfigService(
          publicDb,
        ).exchangePreview(
          {
            pk: row.publicKey as string,
            token: r.body.data.token,
            parentOrigin: 'https://web.telegram.org',
          },
          W,
        );
        expect(ex.config.brand.name).toBe('Черновик TMA');
        expect((ex.config as { hosts?: unknown }).hosts).toBeUndefined();
      });
    });

    // ── Картинки ─────────────────────────────────────────────────────────

    describe('картинки бренда (5а: SVG — отказ ASSET_TYPE)', () => {
      let f: Fx;
      beforeAll(async () => {
        f = await fixture();
      });

      const up = (body: object) =>
        request(srv())
          .post(`/assist/sites/${f.siteId}/widget/assets`)
          .set(as(f.owner))
          .send(body);

      it('PNG-логотип принимается; повтор тех же байтов — та же запись', async () => {
        const data = pngBytes(240, 80).toString('base64');
        const a = await up({
          kind: 'logo',
          mime: 'image/png',
          dataBase64: data,
        });
        expect(a.status).toBe(200);
        expect(a.body.data).toEqual({
          id: expect.any(String),
          kind: 'logo',
          mime: 'image/png',
          width: 240,
          height: 80,
          path: `/widget/v1/asset/${a.body.data.id}`,
        });
        const b = await up({
          kind: 'logo',
          mime: 'image/png',
          dataBase64: data,
        });
        expect(b.body.data.id).toBe(a.body.data.id);
        // Заявленный тип не решает: JPEG под видом PNG хранится как JPEG.
        const j = await up({
          kind: 'avatar',
          mime: 'image/png',
          dataBase64: jpegBytes(128, 128).toString('base64'),
        });
        expect(j.body.data.mime).toBe('image/jpeg');
        // Логотип можно сослать из черновика.
        const c = defaultWidgetConfig('x');
        c.brand.logoAssetId = a.body.data.id;
        c.brand.launcherIcon = 'logo';
        c.brand.avatar = { kind: 'asset', assetId: j.body.data.id };
        const d = await widget.saveDraft(f.m, f.siteId, c);
        expect(d.draft.brand.logoAssetId).toBe(a.body.data.id);
        expect(d.assets?.map((x) => x.id).sort()).toEqual(
          [a.body.data.id, j.body.data.id].sort(),
        );
      });

      it('SVG со <script>/onload — ASSET_TYPE (и под видом PNG тоже)', async () => {
        const svg = Buffer.from(SVG_SCRIPT).toString('base64');
        for (const mime of ['image/svg+xml', 'image/png', 'text/html']) {
          const r = await up({ kind: 'logo', mime, dataBase64: svg });
          expect([mime, r.status, r.body.error.code]).toEqual([
            mime,
            400,
            'ASSET_TYPE',
          ]);
        }
        const n = await prisma.assistSiteAsset.count({
          where: { siteId: f.siteId },
        });
        expect(n).toBe(2);
      });

      it('аватар не квадрат ≥ 128 — ASSET_TYPE (reason dimensions); > 200 КБ — ASSET_TOO_LARGE', async () => {
        const r = await up({
          kind: 'avatar',
          mime: 'image/png',
          dataBase64: pngBytes(100, 100).toString('base64'),
        });
        expect(r.body.error).toMatchObject({
          code: 'ASSET_TYPE',
          details: { reason: 'dimensions' },
        });
        // Тело > 100 КБ режет body-parser Express до маршрута (запрос
        // координатору) — лимит 200 КБ проверяем сервисом.
        const big = Buffer.concat([pngBytes(10, 10), Buffer.alloc(200 * 1024)]);
        await expectCode(
          widget.uploadAsset(f.m, f.siteId, {
            kind: 'logo',
            mime: 'image/png',
            dataBase64: big.toString('base64'),
          }),
          'ASSET_TOO_LARGE',
        );
        const max = Buffer.concat([
          pngBytes(10, 10),
          Buffer.alloc(200 * 1024 - 33),
        ]);
        const ok = await widget.uploadAsset(f.m, f.siteId, {
          kind: 'logo',
          mime: 'image/png',
          dataBase64: max.toString('base64'),
        });
        expect(ok.width).toBe(10);
      });
    });

    // ── Персона и лиды ───────────────────────────────────────────────────

    describe('персона (ворота W3) и форма лида', () => {
      let f: Fx;
      beforeAll(async () => {
        f = await fixture();
      });

      it('черновик → ворота → публикация поднимает configVersion; провал ворот — 409 без публикации', async () => {
        const g = await request(srv())
          .get(`/assist/sites/${f.siteId}/persona`)
          .set(as(f.owner));
        expect(g.body.data).toMatchObject({
          configVersion: 0,
          published: null,
          lastGate: null,
        });
        expect(g.body.data.draft).toEqual(defaultPersona('uk'));

        const bad = await request(srv())
          .patch(`/assist/sites/${f.siteId}/persona`)
          .set(as(f.owner))
          .send({ persona: { ...defaultPersona('uk'), tone: 'rude' } });
        expect(bad.status).toBe(400);
        expect(bad.body.error.code).toBe('PERSONA_INVALID');

        const persona = {
          ...defaultPersona('uk'),
          tone: 'business',
          stopPhrases: ['Скидка'],
          forbiddenTopics: ['политика'],
        };
        const s = await request(srv())
          .patch(`/assist/sites/${f.siteId}/persona`)
          .set(as(f.owner))
          .send({ persona });
        expect(s.status).toBe(200);
        expect(s.body.data.draft.stopPhrases).toEqual(['скидка']);

        gate.next = {
          ran: true,
          invariantsPassed: false,
          blocked: true,
          notes: ['инвариант 3'],
        };
        const blocked = await request(srv())
          .post(`/assist/sites/${f.siteId}/persona/publish`)
          .set(as(f.owner));
        expect(blocked.status).toBe(409);
        expect(blocked.body.error).toMatchObject({
          code: 'PERSONA_GATE_FAILED',
          details: { reason: 'инвариант 3' },
        });
        let row = await prisma.assistSite.findFirstOrThrow({
          where: { siteId: f.siteId },
        });
        expect(row.configVersion).toBe(0);

        gate.next = {
          ran: true,
          invariantsPassed: true,
          blocked: false,
          notes: ['доля верных −12 п.п.'],
        };
        const pub = await request(srv())
          .post(`/assist/sites/${f.siteId}/persona/publish`)
          .set(as(f.owner));
        expect(pub.status).toBe(200);
        expect(pub.body.data).toMatchObject({
          configVersion: 1,
          lastGate: { blocked: false, notes: ['доля верных −12 п.п.'] },
        });
        expect(pub.body.data.published.tone).toBe('business');
        row = await prisma.assistSite.findFirstOrThrow({
          where: { siteId: f.siteId },
        });
        expect(row.configVersion).toBe(1);
        expect(row.widgetVersion).toBe(0);
        // W3 читает опубликованную персону под ролью виджета.
        const [pubRow] = await publicDb.$queryRawUnsafe<
          Array<{ config: unknown }>
        >(
          `SELECT "config" FROM "sites"."assist_site_config_versions" WHERE "siteId" = $1 AND "kind" = 'persona' AND "version" = 1`,
          f.siteId,
        );
        expect(pubRow.config).toEqual(pub.body.data.published);
      });

      it('откат персоны — без ворот, новая версия', async () => {
        await widget.ensureKeys(f.m, f.siteId);
        gate.next = {
          ran: true,
          invariantsPassed: true,
          blocked: false,
          notes: [],
        };
        await request(srv())
          .patch(`/assist/sites/${f.siteId}/persona`)
          .set(as(f.owner))
          .send({ persona: { ...defaultPersona('uk'), tone: 'brief' } });
        await request(srv())
          .post(`/assist/sites/${f.siteId}/persona/publish`)
          .set(as(f.owner));
        const calls = gate.calls;
        const rb = await request(srv())
          .post(`/assist/sites/${f.siteId}/persona/rollback/1`)
          .set(as(f.owner));
        expect(rb.status).toBe(200);
        expect(rb.body.data.configVersion).toBe(3);
        expect(rb.body.data.published.tone).toBe('business');
        expect(rb.body.data.history[0]).toMatchObject({
          version: 3,
          rolledBackFrom: 1,
        });
        expect(gate.calls).toBe(calls);
      });

      it('форма лида: умолчание; мусор — LEADS_CONFIG_INVALID; правка действует сразу (видна роли виджета)', async () => {
        const g = await request(srv())
          .get(`/assist/sites/${f.siteId}/leads-config`)
          .set(as(f.owner));
        expect(g.body.data.config.channels).toEqual(['telegram']);
        const bad = await request(srv())
          .patch(`/assist/sites/${f.siteId}/leads-config`)
          .set(as(f.owner))
          .send({
            config: {
              ...g.body.data.config,
              fields: [{ field: 'name', required: true }],
            },
          });
        expect(bad.body.error.code).toBe('LEADS_CONFIG_INVALID');
        const config = {
          ...g.body.data.config,
          fields: [{ field: 'phone', required: true }],
          consentText: { uk: 'Згоден на дзвінок' },
        };
        const s = await request(srv())
          .patch(`/assist/sites/${f.siteId}/leads-config`)
          .set(as(f.owner))
          .send({ config });
        expect(s.status).toBe(200);
        const row = await publicDb.assistSite.findFirstOrThrow({
          where: { siteId: f.siteId },
          select: { leadsConfig: true },
        });
        expect(row.leadsConfig).toEqual({
          schema: 1,
          channels: ['telegram'],
          ...config,
        });
      });
    });

    // ── Проверка установки (приёмка п.2) ─────────────────────────────────

    describe('проверка установки: CSP без директив → csp_blocked с перечнем', () => {
      let f: Fx;
      let pk: string;
      const tag = () =>
        `<script async src="${W}${WIDGET_LOADER_PATH}" data-site="${pk}"></script>`;
      const page = (body: string, csp?: string) => ({
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          ...(csp ? { 'content-security-policy': csp } : {}),
        },
        body: `<html><head><title>x</title></head><body><p>Магазин</p>${body}</body></html>`,
      });

      beforeAll(async () => {
        f = await fixture();
        pk = (await widget.ensureKeys(f.m, f.siteId)).publicKey!;
      });

      async function check() {
        const r = await request(srv())
          .post(`/assist/sites/${f.siteId}/widget/check-install`)
          .set(as(f.owner));
        expect(r.status).toBe(200);
        return Object.fromEntries(
          r.body.data.hosts.map((h: { hostId: string }) => [h.hostId, h]),
        ) as Record<
          string,
          {
            result: string;
            missingCsp: string[];
            tagFound: boolean;
            lastPingAt: string | null;
          }
        >;
      }

      it('тег есть, CSP сайта без наших директив → csp_blocked + все 4 директивы', async () => {
        net.site(f.verified.host, {
          '/': page(tag(), "default-src 'self'; style-src 'unsafe-inline'"),
        });
        net.site(f.grace.host, { '/': page('') });
        const hits = net.hits.length;
        const res = await check();
        expect(res[f.verified.id]).toMatchObject({
          result: 'csp_blocked',
          tagFound: true,
          missingCsp: ['script-src', 'frame-src', 'img-src', 'connect-src'],
          lastPingAt: null,
        });
        // Неподтверждённый хост — не запрашивается вовсе.
        expect(res[f.pending.id].result).toBe('unverified_host');
        expect(
          net.hits.slice(hits).some((h) => h.startsWith(f.pending.host)),
        ).toBe(false);
        // Льготный хост — запрашивается; тега нет и пинга нет.
        expect(res[f.grace.id].result).toBe('not_found');
      });

      it('CSP из инструкции + пинг → ok; без пинга при годном CSP — «вероятно, CSP»', async () => {
        const csp = `default-src 'self'; ${buildCspSnippet(W).replace(/\n/g, ' ')}`;
        net.site(f.verified.host, { '/': page(tag(), csp) });
        let res = await check();
        expect(res[f.verified.id]).toMatchObject({
          result: 'csp_blocked',
          missingCsp: [],
        });
        const seen = new Date();
        await prisma.assistSiteInstallPing.create({
          data: {
            siteId: f.siteId,
            origin: `https://${f.verified.host}`,
            allowed: true,
            configFetchOk: true,
            lastSeenAt: seen,
          },
        });
        res = await check();
        expect(res[f.verified.id]).toMatchObject({
          result: 'ok',
          tagFound: true,
          missingCsp: [],
          lastPingAt: seen.toISOString(),
        });
      });

      it('пинг без конфига (connect-src) → csp_blocked с connect-src; CSP из <meta> учитывается', async () => {
        await prisma.assistSiteInstallPing.update({
          where: {
            siteId_origin: {
              siteId: f.siteId,
              origin: `https://${f.verified.host}`,
            },
          },
          data: { configFetchOk: false },
        });
        net.site(f.verified.host, { '/': page(tag()) });
        let res = await check();
        expect(res[f.verified.id]).toMatchObject({
          result: 'csp_blocked',
          missingCsp: ['connect-src'],
        });
        net.site(f.verified.host, {
          '/': page(
            `<meta http-equiv="Content-Security-Policy" content="img-src 'self'">${tag()}`,
          ),
        });
        res = await check();
        expect(res[f.verified.id].missingCsp).toEqual([
          'img-src',
          'connect-src',
        ]);
      });

      it('тег с чужим ключом — not_found; сайт не отвечает — fetch_failed', async () => {
        await prisma.assistSiteInstallPing.deleteMany({
          where: { siteId: f.siteId },
        });
        net.site(f.verified.host, {
          '/': page(
            `<script async src="${W}${WIDGET_LOADER_PATH}" data-site="${WIDGET_PK_LIVE_PREFIX}someoneelse0000000000000"></script>`,
          ),
        });
        let res = await check();
        expect(res[f.verified.id].result).toBe('not_found');
        net.site(f.verified.host, { '/': { status: 503, body: 'down' } });
        res = await check();
        expect(res[f.verified.id].result).toBe('fetch_failed');
        expect(install).toBeDefined();
      });
    });
  },
);
