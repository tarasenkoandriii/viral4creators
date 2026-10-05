/**
 * Стенд приёмки Э7 «Админка: чтение» на НАСТОЯЩЕМ Postgres: приложение Nest
 * с настоящими гвардами (initData бота помощника, SiteAccountGuard, права
 * по продукту), модулями «Админки», настоящим pinnedFetch поверх локального
 * https-стенда (LocalSites — DNS и подключение подменены, проверка
 * блок-листа и IP-pin — настоящие), фейк-эмбеддером и фейк-моделью, которая
 * записывает КАЖДЫЙ промпт (проверка «секрет не попал в промпт»).
 */
import { randomBytes, randomUUID } from 'crypto';
import {
  DynamicModule,
  Global,
  INestApplication,
  Logger,
  LoggerService,
  Module,
  Type,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { configureApp } from '../../app.setup';
import { WIDGET_PK_LIVE_PREFIX } from '../../brand';
import { loadConfiguration } from '../../config/configuration';
import { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import { AssistAdminChatModule } from '../../modules/assist-admin-chat/assist-admin-chat.module';
import { AssistAdminCrawlModule } from '../../modules/assist-admin-crawl/assist-admin-crawl.module';
import { AdminKnowledgeService } from '../../modules/assist-admin-knowledge/admin-knowledge.service';
import { AssistAdminKnowledgeModule } from '../../modules/assist-admin-knowledge/assist-admin-knowledge.module';
import { AdminModeService } from '../../modules/assist-admin-mode/admin-mode.service';
import { AssistAdminModeModule } from '../../modules/assist-admin-mode/assist-admin-mode.module';
import { ConnectorsService } from '../../modules/assist-admin-mode/connectors.service';
import { setPlan } from '../../modules/assist-billing/testing/billing-fixtures.testing';
import { AssistKnowledgeCoreModule } from '../../modules/assist-knowledge-core/assist-knowledge-core.module';
import type { ExtractedBlock } from '../../modules/site-crawl/types';
import {
  fakeEmbedTransport,
  ownerPrisma,
} from '../../modules/assist-sandbox/testing/k3-stack.testing';
import { EMBED_TRANSPORT } from '../../modules/site-ai/embedder';
import { SiteAiModule } from '../../modules/site-ai/site-ai.module';
import {
  GeminiText,
  type GenerateRequest,
  type GenerateResult,
} from '../../modules/site-ai/text-model';
import { SiteCoreModule } from '../../modules/site-core/site-core.module';
import { PINNED_HTTP_DEPS } from '../../modules/site-crawl/net/pinned-fetch';
import { SiteCrawlModule } from '../../modules/site-crawl/site-crawl.module';
import { LocalSites } from '../../modules/site-crawl/testing/local-sites.testing';
import { SiteCredentialsModule } from '../../modules/site-credentials/site-credentials.module';
import { TelegramAuthModule } from '../../modules/telegram-auth/telegram-auth.module';
import {
  TEST_ASSIST_TOKEN,
  TEST_QA_TOKEN,
  signInitData,
} from '../../modules/telegram-auth/test-init-data';

export const RAW_URL = process.env.SITES_DIRECT_URL;
const IN_CI = process.env.CI === 'true';

export function describeE7(name: string, body: () => void): void {
  if (!RAW_URL) {
    describe(name, () => {
      (IN_CI ? it : it.skip)(
        'ПРОПУЩЕНО: нет SITES_DIRECT_URL (песочница без базы) — проверка идёт в CI, джоба sites-backend',
        () => {
          throw new Error(
            `CI=true, но SITES_DIRECT_URL не задана — «${name}» не выполнился`,
          );
        },
      );
    });
    return;
  }
  describe(name, body);
}

/**
 * Фейк-модель «Админки»: план — по правилу `planner` (по умолчанию: число
 * в вопросе про заказ → `<коннектор>.getOrder`), ответ — первое
 * предложение S1 и/или выжимка D1. Все промпты — в `calls`.
 */
export class FakeAdminText extends GeminiText {
  readonly calls: GenerateRequest[] = [];
  fail: Error | null = null;
  planner: (
    user: string,
  ) => Array<{ operation: string; args: Record<string, unknown> }> = (user) => {
    const q = /<question>\n([\s\S]*?)\n<\/question>/.exec(user)?.[1] ?? '';
    const ops = [...user.matchAll(/<operation name="([^"]+)"/g)].map(
      (m) => m[1],
    );
    const get = ops.find((o) => o.endsWith('.getOrder'));
    const n = /(?:замовлен|заказ|order)\D{0,20}(\d{2,8})/i.exec(q)?.[1];
    return get && n ? [{ operation: get, args: { id: n } }] : [];
  };

  override async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.calls.push(req);
    if (this.fail) throw this.fail;
    const usage = {
      model: 'gemini-3.6-flash',
      inputTokens: 900,
      cachedInputTokens: 0,
      outputTokens: 30,
    };
    if (/планувальник/.test(req.system)) {
      return {
        ...usage,
        text: JSON.stringify({ calls: this.planner(req.user) }),
      };
    }
    const s1 = /<source id="S1"[^>]*>\n([\s\S]*?)\n<\/source>/.exec(
      req.user,
    )?.[1];
    const d1 = /<data id="D1"[^>]*>\n([\s\S]*?)\n<\/data>/.exec(req.user)?.[1];
    if (!s1 && !d1) {
      return {
        ...usage,
        text: JSON.stringify({ answer: 'Не знаю', sources: [], refused: true }),
      };
    }
    const parts: string[] = [];
    if (d1)
      parts.push(
        `За даними системи: ${d1.replace(/[{}"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)}`,
      );
    if (s1) parts.push(`${s1.split(/(?<=[.!?])\s/)[0].slice(0, 300)} [S1]`);
    return {
      ...usage,
      text: JSON.stringify({
        answer: parts.join(' '),
        sources: s1 ? [1] : [],
        refused: false,
      }),
    };
  }
}

/** Логгер, который всё записывает: проверка «секрета нет в логах». */
export class CapturingLogger implements LoggerService {
  readonly lines: string[] = [];
  private push(level: string, args: unknown[]) {
    this.lines.push(
      `${level} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`,
    );
  }
  log(...a: unknown[]) {
    this.push('log', a);
  }
  error(...a: unknown[]) {
    this.push('error', a);
  }
  warn(...a: unknown[]) {
    this.push('warn', a);
  }
  debug(...a: unknown[]) {
    this.push('debug', a);
  }
  verbose(...a: unknown[]) {
    this.push('verbose', a);
  }
}

@Global()
@Module({})
class E7InfraModule {
  static with(p: { prisma: PrismaService; net: LocalSites }): DynamicModule {
    return {
      module: E7InfraModule,
      providers: [
        { provide: PrismaService, useValue: p.prisma },
        { provide: SitesDb, useValue: new SitesDb(p.prisma) },
        { provide: PINNED_HTTP_DEPS, useValue: p.net.deps() },
        { provide: EMBED_TRANSPORT, useValue: fakeEmbedTransport() },
      ],
      exports: [PrismaService, SitesDb, PINNED_HTTP_DEPS, EMBED_TRANSPORT],
    };
  }
}

const ENV_KEYS = [
  'ASSIST_BOT_TOKEN',
  'QA_BOT_TOKEN',
  'ALLOW_DEV_AUTH',
  'ASSIST_SECRETS_KEY',
  'ASSIST_ADMIN_WIDGET_ORIGIN',
  'CRON_SECRET',
] as const;

let tgSeq = BigInt(Date.now()) * BigInt(1000) + BigInt(907);

export interface E7Site {
  accountId: string;
  siteId: string;
  siteHostId: string;
  host: string;
  apiHost: string;
  apiHostId: string;
  adminHost: string;
  adminHostId: string;
  pk: string;
  ownerTg: bigint;
}

export class E7Stack {
  app!: INestApplication;
  prisma!: PrismaService;
  readonly net = new LocalSites();
  readonly text = new FakeAdminText();
  readonly logs = new CapturingLogger();
  readonly secretsKey = randomBytes(32).toString('base64');
  private saved: Record<string, string | undefined> = {};
  readonly accounts: string[] = [];

  /** Э6-бис (б): модули сверх «Админки» Э7/Э8 (стенд голосового управления). */
  protected extraModules(): Array<Type | DynamicModule> {
    return [];
  }

  async init(): Promise<this> {
    for (const k of ENV_KEYS) this.saved[k] = process.env[k];
    process.env.ASSIST_BOT_TOKEN = TEST_ASSIST_TOKEN;
    process.env.QA_BOT_TOKEN = TEST_QA_TOKEN;
    delete process.env.ALLOW_DEV_AUTH;
    process.env.ASSIST_SECRETS_KEY = this.secretsKey;
    process.env.ASSIST_ADMIN_WIDGET_ORIGIN = 'https://wa.e7.example.com';
    process.env.CRON_SECRET = 'e7-cron-secret';
    Logger.overrideLogger(this.logs);
    this.prisma = ownerPrisma();
    await this.net.start();
    const mod = await Test.createTestingModule({
      imports: [
        E7InfraModule.with({ prisma: this.prisma, net: this.net }),
        TelegramAuthModule,
        SiteCoreModule,
        SiteCrawlModule,
        SiteAiModule,
        AssistKnowledgeCoreModule,
        AssistAdminKnowledgeModule,
        AssistAdminModeModule,
        AssistAdminChatModule,
        SiteCredentialsModule,
        AssistAdminCrawlModule,
        ...this.extraModules(),
      ],
    })
      .overrideProvider(GeminiText)
      .useValue(this.text)
      .compile();
    mod.useLogger(this.logs);
    this.app = mod.createNestApplication({ logger: this.logs });
    configureApp(this.app, loadConfiguration({}));
    await this.app.init();
    this.app.get(ConnectorsService).retryPauseMs = 1;
    this.app.get(AdminModeService).env = process.env;
    return this;
  }

  async close(): Promise<void> {
    await this.app?.close();
    if (this.accounts.length) {
      await this.prisma.siteAccount.deleteMany({
        where: { id: { in: this.accounts } },
      });
    }
    await this.net.stop();
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

  /** Новый участник кабинета с правами по продукту. */
  async member(
    s: E7Site,
    role: 'owner' | 'manager' | 'operator',
    productRoles: Record<string, string>,
  ): Promise<bigint> {
    const tg = ++tgSeq;
    await this.prisma.siteAccountMember.create({
      data: { accountId: s.accountId, telegramId: tg, role, productRoles },
    });
    return tg;
  }

  /**
   * Кабинет (владелец), сайт, три verified-хоста (сайт, API, админка),
   * строка помощника с публичным ключом; тариф — `plan` (по умолчанию
   * business: «Админка: чтение»).
   */
  async site(
    opts: { plan?: 'trial' | 'start' | 'business' | 'pro' | null } = {},
  ): Promise<E7Site> {
    const p = this.prisma;
    const tag = randomUUID().slice(0, 8);
    const host = `shop-${tag}.polygon.example`;
    const apiHost = `api-${tag}.polygon.example`;
    const adminHost = `admin-${tag}.polygon.example`;
    const account = await p.siteAccount.create({
      data: { verifyToken: `e7-${randomUUID()}` },
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
    const sh = await verified(host);
    const ah = await verified(apiHost);
    const adm = await verified(adminHost);
    const pk = `${WIDGET_PK_LIVE_PREFIX}${randomBytes(18).toString('hex').slice(0, 32)}`;
    await p.assistSite.create({
      data: {
        accountId: account.id,
        siteId: site.id,
        enabled: true,
        recrawlEvery: 'manual',
        publicKey: pk,
      },
    });
    if (opts.plan !== null)
      await setPlan(p, account.id, opts.plan ?? 'business');
    for (const h of [host, apiHost, adminHost])
      this.net.dns.set(h, ['93.184.216.34']);
    return {
      accountId: account.id,
      siteId: site.id,
      siteHostId: sh.id,
      host,
      apiHost,
      apiHostId: ah.id,
      adminHost,
      adminHostId: adm.id,
      pk,
      ownerTg,
    };
  }

  /** Регламенты в базу «Админки» — настоящим индексатором (версия публикуется). */
  async adminDocument(
    s: E7Site,
    doc: { ref: string; title: string; paragraphs: string[] },
  ): Promise<void> {
    const admin = this.app.get(AdminKnowledgeService);
    const ctx = { accountId: s.accountId, siteId: s.siteId };
    await admin.ensureSettings(ctx);
    const src =
      (await this.prisma.assistAdminSource.findFirst({
        where: { siteId: s.siteId, kind: 'manual' },
      })) ??
      (await this.prisma.assistAdminSource.create({
        data: {
          accountId: s.accountId,
          siteId: s.siteId,
          kind: 'manual',
          title: 'Регламенты',
        },
      }));
    const blocks: ExtractedBlock[] = [
      { t: 'h', level: 1, text: doc.title, path: [] },
      ...doc.paragraphs.map((text) => ({
        t: 'p' as const,
        text,
        path: [doc.title],
      })),
    ];
    const r = await admin.indexDocuments(
      ctx,
      src.id,
      [{ ref: doc.ref, kind: 'manual', title: doc.title, lang: 'uk', blocks }],
      { trigger: 'document', byTelegramId: s.ownerTg },
    );
    if (r.status === 'held') await admin.publishHeld(ctx, r.number, s.ownerTg);
  }
}

/** OpenAPI стенда заказчика (JSON) — read/write/danger операции. */
export function shopSpec(apiHost: string): string {
  return JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'Shop admin API' },
    servers: [{ url: `https://${apiHost}/v1` }],
    paths: {
      '/orders': {
        get: {
          operationId: 'listOrders',
          summary: 'Список заказов',
          parameters: [
            {
              name: 'status',
              in: 'query',
              schema: { type: 'string', enum: ['new', 'paid'] },
            },
          ],
        },
        post: { operationId: 'createOrder', summary: 'Создать заказ' },
      },
      '/orders/{id}': {
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        get: {
          operationId: 'getOrder',
          summary: 'Заказ по номеру: статус, сумма, трек',
        },
        delete: { operationId: 'deleteOrder', summary: 'Удалить заказ' },
      },
      '/orders/{id}/refund': {
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        post: { operationId: 'refundOrder', summary: 'Возврат' },
      },
    },
  });
}
