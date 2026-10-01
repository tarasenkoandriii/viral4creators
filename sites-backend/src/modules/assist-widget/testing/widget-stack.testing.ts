/**
 * Стенд тестов W2 на НАСТОЯЩЕМ Postgres: приложение Nest с теми же
 * глобальными настройками (configureApp), публичный клиент — под
 * логин-ролью в assist_public (publicPrisma, с omit), владелец схемы — для
 * посева данных. Конвейер ответа W3 (`SiteChatService`), приём лида и кэш
 * подменяются здесь подделками: W2 проверяет СВОЮ сторону стыка (токен,
 * гвард, лимиты, SSE/JSON, состояние); сам конвейер — тесты W3.
 *
 * Подделка конвейера пишет диалог и сообщения ПОД РОЛЬЮ виджета (как W3) —
 * так тесты state/stream/forget видят настоящие строки и права роли.
 */
import {
  DynamicModule,
  Global,
  INestApplication,
  Module,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { configureApp } from '../../../app.setup';
import { loadConfiguration } from '../../../config/configuration';
import { AssistPublicDb } from '../../../prisma/assist-public-db.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { SitesDb } from '../../../prisma/sites-db.service';
import type {
  AskInput,
  WidgetChatEvent,
} from '../../assist-site-chat/chat-types';
import {
  SiteLeadsService,
  type LeadSubmitInput,
} from '../../assist-site-chat/leads.service';
import { SemanticCache } from '../../assist-site-chat/semantic-cache';
import { SiteChatService } from '../../assist-site-chat/site-chat.service';
import { generatePublicKey } from '../../assist-site-setup/keys';
import { defaultWidgetConfig } from '../../assist-site-setup/widget-config';
import {
  fakeEmbedTransport,
  ownerPrisma,
  publicPrisma,
  uniq,
} from '../../assist-sandbox/testing/k3-stack.testing';
import { EMBED_TRANSPORT } from '../../site-ai/embedder';
import { OWNER_PRODUCT_ROLES } from '../../site-core/account/roles';
import { TelegramAuthModule } from '../../telegram-auth/telegram-auth.module';
import { TEST_ASSIST_TOKEN } from '../../telegram-auth/test-init-data';
import { AssistWidgetModule } from '../assist-widget.module';
import { WIDGET_ORIGIN_DEFAULT } from '../../../brand';

export const DAY = 24 * 60 * 60 * 1000;
export const HOUR = 60 * 60 * 1000;
export const W_ORIGIN = WIDGET_ORIGIN_DEFAULT;
export const TEST_SECRETS_KEY = 'w2-widget-test-secret';
export const TMA_ORIGIN = 'https://tma.w2.example.com';
export const LANDING_ORIGIN = 'https://landing.w2.example.com';

@Global()
@Module({})
class WidgetTestInfra {
  static with(p: {
    prisma: PrismaService;
    publicDb: AssistPublicDb;
  }): DynamicModule {
    return {
      module: WidgetTestInfra,
      providers: [
        { provide: PrismaService, useValue: p.prisma },
        { provide: SitesDb, useValue: new SitesDb(p.prisma) },
        { provide: AssistPublicDb, useValue: p.publicDb },
        { provide: EMBED_TRANSPORT, useValue: fakeEmbedTransport() },
      ],
      exports: [PrismaService, SitesDb, AssistPublicDb, EMBED_TRANSPORT],
    };
  }
}

/**
 * Подделка конвейера W3 с его контрактом идемпотентности (шапка
 * site-chat.service.ts п.1): (conversationId, clientRequestId) уже есть —
 * meta с replay=true и текст из базы, модели нет; чужой conversationId —
 * новый диалог. `modelCalls` — сколько раз «звали модель».
 */
export class FakeSiteChat {
  readonly inputs: AskInput[] = [];
  modelCalls = 0;
  /** Ответ модели (по умолчанию — фиксированный текст). */
  answer = 'Доставка по Киеву стоит 150 грн [S1]';
  /** Оставить ответ в состоянии streaming (имитация обрыва функции). */
  leaveStreaming = false;
  /** Бросить исключение посреди ответа. */
  failWith: Error | null = null;

  constructor(private readonly db: AssistPublicDb) {}

  async *ask(input: AskInput): AsyncIterable<WidgetChatEvent> {
    this.inputs.push(input);
    const { siteId, accountId } = input.site;
    let conversationId: string | null = null;
    if (input.conversationId) {
      const own = await this.db.assistSiteConversation.findFirst({
        where: {
          id: input.conversationId,
          siteId,
          visitorId: input.visitor.visitorId,
        },
        select: { id: true },
      });
      conversationId = own?.id ?? null;
    }
    if (conversationId) {
      const prev = await this.db.assistSiteMessage.findFirst({
        where: { conversationId, clientRequestId: input.clientRequestId },
        select: { id: true, text: true, streamState: true },
      });
      if (prev) {
        yield {
          type: 'meta',
          conversationId,
          messageId: prev.id,
          replay: true,
        };
        if (prev.streamState !== 'streaming') {
          if (prev.text) yield { type: 'token', t: prev.text };
          yield { type: 'done', usage: { in: 0, out: 0, cached: 0 } };
        } else if (prev.text) {
          yield { type: 'token', t: prev.text };
        }
        return;
      }
    } else {
      const c = await this.db.assistSiteConversation.create({
        data: {
          accountId,
          siteId,
          visitorId: input.visitor.visitorId,
          ipHash: input.visitor.ipHash,
          parentOrigin: input.site.parentOrigin,
        },
        select: { id: true },
      });
      conversationId = c.id;
    }
    await this.db.assistSiteMessage.create({
      data: {
        accountId,
        siteId,
        conversationId,
        role: 'visitor',
        text: '[вопрос маскирован]',
        flags: [],
      },
      select: { id: true },
    });
    const msg = await this.db.assistSiteMessage.create({
      data: {
        accountId,
        siteId,
        conversationId,
        role: 'assistant',
        text: '',
        flags: [],
        clientRequestId: input.clientRequestId,
        streamState: 'streaming',
        answerPath: 'model',
      },
      select: { id: true },
    });
    yield { type: 'meta', conversationId, messageId: msg.id, replay: false };
    this.modelCalls++;
    if (this.failWith) throw this.failWith;
    const half = this.answer.slice(0, 10);
    yield { type: 'token', t: half };
    await this.db.assistSiteMessage.update({
      where: { id: msg.id },
      data: { text: half, streamOffset: half.length },
      select: { id: true },
    });
    if (this.leaveStreaming) return;
    const rest = this.answer.slice(10);
    yield { type: 'token', t: rest };
    const sources = [
      { n: 1, url: 'https://example.com/delivery', title: 'Доставка' },
    ];
    yield { type: 'sources', items: sources };
    await this.db.assistSiteMessage.update({
      where: { id: msg.id },
      data: {
        text: this.answer,
        streamOffset: this.answer.length,
        streamState: 'complete',
        sources,
      },
      select: { id: true },
    });
    await this.db.assistSiteConversation.update({
      where: { id: conversationId },
      data: { stateVersion: { increment: 1 }, lastMessageAt: new Date() },
      select: { id: true },
    });
    yield { type: 'done', usage: { in: 10, out: 5, cached: 0 } };
  }
}

/** Приём лида W3 — подделка: записывает вход (что W2 передал). */
export class FakeLeads {
  readonly inputs: LeadSubmitInput[] = [];
  async submit(input: LeadSubmitInput): Promise<{ leadId: string }> {
    this.inputs.push(input);
    return { leadId: `lead_${this.inputs.length}` };
  }
}

/** Семантический кэш W3 — подделка: только evict (из feedback W2). */
export class FakeCache {
  readonly evicted: Array<{ siteId: string; key: string }> = [];
  async get() {
    return null;
  }
  async put() {
    return false;
  }
  async evict(p: { siteId: string; key: string }): Promise<void> {
    this.evicted.push(p);
  }
}

export interface WidgetStack {
  app: INestApplication;
  prisma: PrismaService;
  publicDb: AssistPublicDb;
  chat: FakeSiteChat;
  leads: FakeLeads;
  cache: FakeCache;
  accounts: string[];
  close(): Promise<void>;
}

const ENV_KEYS = [
  'ASSIST_SECRETS_KEY',
  'ASSIST_WIDGET_ORIGIN',
  'ASSIST_WIDGET_ENABLED',
  'ASSIST_PREVIEW_FRAME_ANCESTORS',
  'ASSIST_LANDING_ORIGINS',
  'ASSIST_BOT_TOKEN',
  'ALLOW_DEV_AUTH',
] as const;

export async function startWidgetStack(): Promise<WidgetStack> {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.ASSIST_SECRETS_KEY = TEST_SECRETS_KEY;
  delete process.env.ASSIST_WIDGET_ORIGIN;
  delete process.env.ASSIST_WIDGET_ENABLED;
  process.env.ASSIST_PREVIEW_FRAME_ANCESTORS = TMA_ORIGIN;
  process.env.ASSIST_LANDING_ORIGINS = LANDING_ORIGIN;
  process.env.ASSIST_BOT_TOKEN = TEST_ASSIST_TOKEN;
  delete process.env.ALLOW_DEV_AUTH;

  const prisma = ownerPrisma();
  const publicDb = await publicPrisma(prisma);
  const chat = new FakeSiteChat(publicDb);
  const leads = new FakeLeads();
  const cache = new FakeCache();
  const mod = await Test.createTestingModule({
    imports: [
      WidgetTestInfra.with({ prisma, publicDb }),
      TelegramAuthModule,
      AssistWidgetModule,
    ],
  })
    .overrideProvider(SiteChatService)
    .useValue(chat)
    .overrideProvider(SiteLeadsService)
    .useValue(leads)
    .overrideProvider(SemanticCache)
    .useValue(cache)
    .compile();
  const app = mod.createNestApplication();
  // Лендинг — в общем списке CORS (как в проде: /public/* идёт по CORS_ORIGIN).
  configureApp(app, loadConfiguration({ CORS_ORIGIN: LANDING_ORIGIN }));
  await app.init();
  const accounts: string[] = [];
  return {
    app,
    prisma,
    publicDb,
    chat,
    leads,
    cache,
    accounts,
    async close() {
      await app.close();
      if (accounts.length) {
        await prisma.siteAccount.deleteMany({
          where: { id: { in: accounts } },
        });
      }
      await publicDb.$disconnect();
      await prisma.$disconnect();
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    },
  };
}

export interface HostSpec {
  host: string;
  /** verified (по умолчанию) | pending | revoked | expired */
  status?: string;
  /** Включён в опубликованном виде (по умолчанию — да). */
  enabled?: boolean;
  revokedAt?: Date | null;
  expiresAt?: Date | null;
}

export interface WidgetFixture {
  accountId: string;
  siteId: string;
  pk: string;
  testPk: string;
  owner: bigint;
  hosts: Array<{ id: string; host: string; origin: string }>;
}

let tgNext = 7_300_000_000 + Math.floor(Math.random() * 1_000_000) * 10;

/**
 * Кабинет + сайт + AssistSite (ключи, соль, опубликованный вид v1 с
 * hosts[]) + хосты. Возвращает id для запросов.
 */
export async function widgetFixture(
  stack: WidgetStack,
  hosts: HostSpec[],
  opts: { publish?: boolean; enabled?: boolean } = {},
): Promise<WidgetFixture> {
  const { prisma } = stack;
  const acc = await prisma.siteAccount.create({
    data: { verifyToken: uniq('vt') },
  });
  stack.accounts.push(acc.id);
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
  const now = Date.now();
  const rows: WidgetFixture['hosts'] = [];
  const rules: Array<{
    hostId: string;
    enabled: boolean;
    pathMasks: string[];
    hideOn: string[];
  }> = [];
  for (const h of hosts) {
    const status = h.status ?? 'verified';
    const row = await prisma.siteHost.create({
      data: {
        accountId: acc.id,
        siteId: site.id,
        host: h.host,
        status,
        method: status === 'pending' ? null : 'dns',
        verifiedAt: status === 'pending' ? null : new Date(now - DAY),
        expiresAt:
          h.expiresAt !== undefined
            ? h.expiresAt
            : status === 'pending'
              ? null
              : new Date(now + 90 * DAY),
        revokedAt: h.revokedAt ?? null,
      },
    });
    rows.push({ id: row.id, host: h.host, origin: `https://${h.host}` });
    rules.push({
      hostId: row.id,
      enabled: h.enabled ?? true,
      pathMasks: [],
      hideOn: ['/checkout*'],
    });
  }
  const pk = generatePublicKey('live');
  const testPk = generatePublicKey('test');
  const publish = opts.publish ?? true;
  await prisma.assistSite.create({
    data: {
      accountId: acc.id,
      siteId: site.id,
      enabled: opts.enabled ?? true,
      publicKey: pk,
      testKey: testPk,
      ipSalt: uniq('salt'),
      widgetVersion: publish ? 1 : 0,
    },
  });
  if (publish) {
    await prisma.assistSiteConfigVersion.create({
      data: {
        accountId: acc.id,
        siteId: site.id,
        kind: 'widget',
        version: 1,
        config: { ...defaultWidgetConfig('Магазин'), hosts: rules } as object,
      },
    });
  }
  return { accountId: acc.id, siteId: site.id, pk, testPk, owner, hosts: rows };
}

/** Уникальный домен для теста (eTLD+1 = `<метка>.com`). */
export function domain(prefix = 'w2'): string {
  return `${uniq(prefix)}.com`;
}

export function newRequestId(): string {
  return randomUUID();
}
