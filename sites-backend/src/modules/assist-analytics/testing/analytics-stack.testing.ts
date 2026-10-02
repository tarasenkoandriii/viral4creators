/**
 * Стенд тестов A (Э3) на НАСТОЯЩЕМ Postgres: публичный приём целей и
 * счётчиков — под логин-ролью assist_public (как в проде, с omit), кабинет и
 * свёртки — основной ролью. Сайты/кабинеты — свои у каждого теста (uniq),
 * кроны зовутся только со `scope` своих сайтов (контракт Э3 §9 п.6).
 * Telegram — подменённый fetch; Blob выгрузок — в памяти.
 */
import { randomUUID } from 'crypto';
import { Logger } from '@nestjs/common';
import { SitesDb } from '../../../prisma/sites-db.service';
import { LeadDelivery } from '../../assist-site-chat/system/lead-delivery.service';
import { SiteLeadsService } from '../../assist-site-chat/leads.service';
import {
  ChatStack,
  type ChatSite,
} from '../../assist-site-chat/testing/chat-stack.testing';
import type {
  LearningDigestFacts,
  LearningReadApi,
  TopicFact,
} from '../../assist-site-learning/learning-read.service';
import {
  OWNER_PRODUCT_ROLES,
  type AccountMembership,
  type ProductRoles,
} from '../../site-core/account/roles';
import { AnalyticsSettingsService } from '../analytics-settings.service';
import { ExportStorage } from '../export-storage';
import { ExportsService } from '../exports.service';
import { GoalWebhookService } from '../goal-webhook.service';
import { GoalsService } from '../goals.service';
import { IntegrationsService } from '../integrations.service';
import { EventCounts } from '../public/event-counts.service';
import { GoalIntake } from '../public/goal-intake.service';
import { StatsService } from '../stats.service';
import { AnalyticsRollup } from '../system/analytics-rollup.service';

/** Blob выгрузок в памяти: put/подписанная ссылка/удаление. */
export class FakeExportStorage extends ExportStorage {
  readonly files = new Map<string, string>();
  readonly removed: string[] = [];
  protected override token(): string {
    return 'fake';
  }
  override async put(pathname: string, body: string): Promise<void> {
    this.files.set(pathname, body);
  }
  override async signedUrl(
    pathname: string,
    validUntil: Date,
  ): Promise<string> {
    return `https://blob.test/${pathname}?until=${validUntil.getTime()}`;
  }
  override async remove(pathname: string): Promise<void> {
    this.removed.push(pathname);
    this.files.delete(pathname);
  }
}

/** Очередь обучения L — подделка (A берёт только факты через LearningReadApi). */
export class FakeLearningRead {
  topicsOut: TopicFact[] = [];
  facts: LearningDigestFacts = {
    newClusters: 0,
    openClusters: 0,
    goldenNeedsReview: 0,
    goldenConflicts: 0,
    candidates: 0,
    evalDeferred: false,
  };
  async topics(): Promise<TopicFact[]> {
    return this.topicsOut;
  }
  async digestFacts(): Promise<LearningDigestFacts> {
    return this.facts;
  }
}

/** Перехват Logger: в логах A не должно быть orderId, сумм, текста, секретов. */
export class LogCapture {
  readonly lines: string[] = [];
  install(): void {
    const push = (...a: unknown[]) => {
      this.lines.push(a.map((x) => String(x)).join(' '));
    };
    for (const lvl of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest
        .spyOn(Logger.prototype, lvl)
        .mockImplementation((...a: unknown[]) => push(...a));
    }
  }
  text(): string {
    return this.lines.join('\n');
  }
}

export const TEST_SECRETS_ENV = 'w3-chat-test-secret';

export class AnalyticsStack {
  readonly chat = new ChatStack();
  sitesDb!: SitesDb;
  intake!: GoalIntake;
  counts!: EventCounts;
  goals!: GoalsService;
  integrations!: IntegrationsService;
  webhook!: GoalWebhookService;
  rollup!: AnalyticsRollup;
  exports!: ExportsService;
  stats!: StatsService;
  settings!: AnalyticsSettingsService;
  leads!: SiteLeadsService;
  delivery!: LeadDelivery;
  readonly storage = new FakeExportStorage();
  readonly learning = new FakeLearningRead();

  async init(): Promise<this> {
    await this.chat.init();
    const owner = this.chat.owner;
    this.sitesDb = new SitesDb(owner);
    this.intake = new GoalIntake(this.chat.publicDb);
    this.counts = new EventCounts(this.chat.publicDb);
    this.goals = new GoalsService(this.sitesDb);
    this.integrations = new IntegrationsService(this.sitesDb, owner);
    this.integrations.env = this.chat.env;
    this.webhook = new GoalWebhookService(owner, this.integrations);
    this.exports = new ExportsService(this.sitesDb, owner, this.storage);
    this.rollup = new AnalyticsRollup(owner, this.exports);
    this.stats = new StatsService(
      this.sitesDb,
      owner,
      this.learning as unknown as LearningReadApi,
    );
    this.settings = new AnalyticsSettingsService(this.sitesDb);
    this.delivery = new LeadDelivery(owner, this.sitesDb, this.integrations);
    this.delivery.env = this.chat.env;
    this.delivery.fetchImpl = async (u, init) => {
      this.chat.sent.push({ url: u, body: JSON.parse(init.body) });
      return { ok: true, status: 200 };
    };
    this.leads = new SiteLeadsService(
      this.chat.publicDb,
      this.delivery,
      this.intake,
    );
    this.leads.env = this.chat.env;
    return this;
  }

  async close(): Promise<void> {
    await this.chat.close();
  }

  get owner() {
    return this.chat.owner;
  }

  /** Сайт со своим кабинетом (ChatStack.site) + участники. */
  site(opts: Parameters<ChatStack['site']>[0] = {}): Promise<ChatSite> {
    return this.chat.site(opts);
  }

  /** Участник кабинета как AccountMembership (владелец — по ownerTelegramId). */
  async member(
    s: ChatSite,
    role: 'owner' | 'manager' | 'operator' = 'owner',
    productRoles?: Partial<ProductRoles>,
  ): Promise<AccountMembership> {
    if (role === 'owner') {
      const m = await this.owner.siteAccountMember.findFirstOrThrow({
        where: { accountId: s.accountId, telegramId: s.ownerTelegramId },
      });
      return {
        accountId: s.accountId,
        memberId: m.id,
        telegramId: m.telegramId,
        role: 'owner',
        productRoles: OWNER_PRODUCT_ROLES,
      };
    }
    const pr: ProductRoles = {
      qa: 'none',
      assist: role === 'manager' ? 'manager' : 'operator',
      assistAdmin: 'none',
      ...productRoles,
    };
    const tg =
      BigInt(Date.now()) * BigInt(1000) +
      BigInt(Math.floor(Math.random() * 1000));
    const m = await this.owner.siteAccountMember.create({
      data: { accountId: s.accountId, telegramId: tg, role, productRoles: pr },
    });
    return {
      accountId: s.accountId,
      memberId: m.id,
      telegramId: tg,
      role,
      productRoles: pr,
    };
  }

  /** Цель напрямую (основной ролью). */
  async goal(
    s: ChatSite,
    g: {
      key: string;
      template?: string;
      detectors: unknown[];
      valueMode?: 'none' | 'fixed' | 'event';
      fixedValue?: number | null;
      currency?: string | null;
      status?: string;
    },
  ): Promise<string> {
    const row = await this.owner.assistSiteGoal.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        key: g.key,
        template: g.template ?? 'custom',
        name: g.key,
        detectors: g.detectors as object,
        valueMode: g.valueMode ?? 'none',
        fixedValue: g.fixedValue ?? null,
        currency: g.currency ?? null,
        status: g.status ?? 'active',
      },
    });
    return row.id;
  }

  /** Диалог посетителя с вопросом и ответом модели (как после конвейера). */
  async conversation(
    s: ChatSite,
    p: {
      visitorId?: string;
      createdAt?: Date;
      lastMessageAt?: Date;
      question?: string;
      answer?: { sources: boolean } | null;
      rating?: 1 | -1 | null;
      suspicious?: boolean;
      openedBy?: string | null;
    } = {},
  ): Promise<{ id: string; visitorId: string }> {
    const visitorId = p.visitorId ?? `v-${randomUUID()}`;
    const createdAt = p.createdAt ?? new Date(Date.now() - 2 * 60 * 60 * 1000);
    const c = await this.owner.assistSiteConversation.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        visitorId,
        ipHash: `ip-${randomUUID()}`,
        parentOrigin: s.origin,
        createdAt,
        lastMessageAt:
          p.lastMessageAt ?? new Date(createdAt.getTime() + 60_000),
        suspicious: p.suspicious ?? false,
        openedBy: p.openedBy ?? null,
      },
    });
    await this.owner.assistSiteMessage.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        conversationId: c.id,
        role: 'visitor',
        text:
          p.question ?? `Скільки коштує доставка ${randomUUID().slice(0, 4)}?`,
        createdAt,
      },
    });
    if (p.answer !== null) {
      await this.owner.assistSiteMessage.create({
        data: {
          accountId: s.accountId,
          siteId: s.siteId,
          conversationId: c.id,
          role: 'assistant',
          text: 'Доставка — 70 грн [S1]',
          answerPath: 'model',
          sources:
            (p.answer?.sources ?? true)
              ? [{ n: 1, url: s.url('/delivery'), title: 'Доставка' }]
              : [],
          rating: p.rating ?? null,
          createdAt: new Date(createdAt.getTime() + 5_000),
        },
      });
    }
    return { id: c.id, visitorId };
  }
}
