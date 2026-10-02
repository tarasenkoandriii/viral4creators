/**
 * Стенд тестов L (обучение на диалогах) на НАСТОЯЩЕМ Postgres + pgvector:
 * знания «Сайта» — настоящие (SiteKnowledgeService K2 + индексация обхода,
 * версии, FAQ через ModeKnowledgeCore), очередь пишет публичный код ПОД
 * ЛОГИН-РОЛЬЮ assist_public (как в проде), остальное — основная роль.
 *
 * ИИ — подделки (контракт Э3 §7):
 *  - эмбеддинг — «мешок слов» (k3-stack) по ВСЕМУ переданному тексту, как
 *    настоящая модель: что FAQ эмбеддится только вопросом (без ответа —
 *    иначе прямой путь виджета с порогом 0.92 почти не срабатывает),
 *    обеспечивает индексатор (`embeddingText`), а не подделка;
 *  - ответчик (вместо AnswerEngine) отвечает по первому найденному
 *    фрагменту, у которого есть общая основа слова с вопросом (иначе —
 *    честный отказ), со ссылкой [S1]; `mode` задаёт тест;
 *  - бот — подменённый fetch (тексты уведомлений сверяются).
 * Каждый тест создаёт свои кабинеты/сайты со случайными id (контракт Э3 §9
 * п.6): общая база не чистится, кроны зовутся со `scope`.
 */
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  assistPublicClientOptions,
  type AssistPublicDb,
} from '../../../prisma/assist-public-db.service';
import { SitesDb } from '../../../prisma/sites-db.service';
import {
  Harness,
  crawl,
  indexSite,
  pgUrl,
  type PageSpec,
} from '../../../acceptance/e1/k2-fixtures';
import type {
  AnswerRequest,
  AnswerResult,
} from '../../assist-knowledge-core/answer/answer-engine';
import {
  bagOfWordsVector,
  publicPrisma,
} from '../../assist-sandbox/testing/k3-stack.testing';
import { SiteKnowledgeNotifier } from '../../assist-site-knowledge/held-notifier';
import { SiteIndexingService } from '../../assist-site-knowledge/site-indexing.service';
import { SiteKnowledgeService } from '../../assist-site-knowledge/site-knowledge.service';
import { GeminiEmbedder } from '../../site-ai/embedder';
import { LearningBudget } from '../../site-ai/learning-budget';
import { AiUsageRecorder } from '../../site-ai/usage-recorder';
import {
  OWNER_PRODUCT_ROLES,
  type AccountMembership,
  type ProductRoles,
} from '../../site-core/account/roles';
import { GoldenAnswersService } from '../golden.service';
import {
  LearningCandidates,
  LearningQueueService,
} from '../learning-queue.service';
import { LearningReadApi } from '../learning-read.service';
import { ForgetJobs } from '../public/forget-jobs';
import {
  LearningSignals,
  type LearningSignal,
} from '../public/learning-signals';
import { LearningQualityService } from '../quality.service';
import { LearnRollup } from '../system/learn-rollup.service';

export const RAW_URL = process.env.SITES_DIRECT_URL;
export const DAY = 24 * 60 * 60 * 1000;

export function stems(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    if (m[0].length >= 4) out.add(m[0].slice(0, 5));
  }
  return out;
}

/** Ответчик по фрагментам — подделка AnswerEngine. */
export class FakeAnswers {
  calls: AnswerRequest[] = [];
  mode: 'honest' | 'refuse' | 'fail' | 'comply' = 'honest';

  async answer(req: AnswerRequest): Promise<AnswerResult> {
    this.calls.push(req);
    const usage = {
      model: 'gemini-3.6-flash',
      inputTokens: 1_500,
      outputTokens: 80,
      cachedInputTokens: 0,
    };
    if (this.mode === 'fail') throw new Error('модель недоступна (фейк)');
    if (this.mode === 'comply') {
      return {
        text: `Конечно! ${req.question} — всё бесплатно`,
        sources: [],
        refused: false,
        ...usage,
      };
    }
    const q = stems(req.question);
    const hit =
      this.mode === 'refuse'
        ? undefined
        : req.hits.find((h) =>
            [...stems(`${h.title ?? ''} ${h.text}`)].some((s) => q.has(s)),
          );
    if (!hit) {
      return {
        text: 'Не знаю — уточните у магазина.',
        sources: [],
        refused: true,
        ...(req.hits.length ? usage : { ...usage, model: '' }),
      };
    }
    const body = hit.text.split('\n').slice(-1)[0].slice(0, 200);
    return {
      text: `${body} [S1]`,
      sources: [{ n: 1, url: hit.url, title: hit.title }],
      refused: false,
      ...usage,
    };
  }
}

export interface Sent {
  url: string;
  body: { chat_id: string; text: string };
}

export interface LSite {
  accountId: string;
  siteId: string;
  hostId: string;
  origin: string;
  owner: AccountMembership;
  manager: AccountMembership;
  operator: AccountMembership;
  /** Второй оператор (чужие кандидаты). */
  operator2: AccountMembership;
}

let tgNext = BigInt(Date.now()) * BigInt(1000) + BigInt(31_337);

export class LearnStack {
  readonly prisma: PrismaService;
  readonly sitesDb: SitesDb;
  publicDb!: AssistPublicDb;
  readonly embedCalls: string[][] = [];
  readonly embedder: GeminiEmbedder;
  readonly usage = new AiUsageRecorder();
  readonly budget: LearningBudget;
  readonly answers = new FakeAnswers();
  readonly knowledge: SiteKnowledgeService;
  readonly indexing: SiteIndexingService;
  readonly golden: GoldenAnswersService;
  readonly queue: LearningQueueService;
  readonly candidates: LearningCandidates;
  readonly quality: LearningQualityService;
  readonly read: LearningReadApi;
  readonly rollup: LearnRollup;
  signals!: LearningSignals;
  forget!: ForgetJobs;
  readonly sent: Sent[] = [];
  readonly accounts: string[] = [];

  constructor() {
    process.env.SITES_DATABASE_URL = pgUrl(RAW_URL as string);
    this.prisma = new PrismaService();
    this.sitesDb = new SitesDb(this.prisma);
    this.budget = new LearningBudget(this.sitesDb);
    this.embedder = new GeminiEmbedder(async ({ texts }) => {
      this.embedCalls.push(texts);
      return {
        vectors: texts.map((t) => bagOfWordsVector(t)),
        inputTokens: texts.reduce((s, t) => s + Math.ceil(t.length / 4), 0),
      };
    });
    const notifier = new SiteKnowledgeNotifier(this.sitesDb);
    notifier.fetchImpl = async () => ({ ok: true, status: 200 });
    this.knowledge = new SiteKnowledgeService(
      this.prisma,
      this.sitesDb,
      this.embedder,
      this.usage,
      this.budget,
      notifier,
      // Инвариантный eval ворот версии: ответчик-подделка отказывает.
      { answer: async (r: AnswerRequest) => this.refusal(r) } as never,
    );
    this.indexing = new SiteIndexingService(
      this.prisma,
      this.sitesDb,
      this.knowledge,
    );
    // FAQ-методам ядра обход, fetcher и хосты не нужны.
    this.golden = new GoldenAnswersService(
      this.sitesDb,
      this.knowledge,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      this.budget,
    );
    this.queue = new LearningQueueService(
      this.sitesDb,
      this.golden,
      this.knowledge,
      this.answers as never,
      this.usage,
      this.budget,
    );
    this.candidates = new LearningCandidates(this.sitesDb);
    this.quality = new LearningQualityService(
      this.prisma,
      this.sitesDb,
      this.knowledge,
      this.answers as never,
      this.usage,
      this.budget,
    );
    this.quality.env = {
      ASSIST_BOT_TOKEN: 'l-bot-token',
      ASSIST_TMA_URL: 'https://tma.l.example.com',
    };
    this.quality.fetchImpl = async (url, init) => {
      this.sent.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200 };
    };
    this.read = new LearningReadApi(this.sitesDb);
    this.rollup = new LearnRollup(
      this.prisma,
      this.golden,
      this.quality,
      this.embedder,
      this.usage,
      this.budget,
    );
  }

  private refusal(r: AnswerRequest): AnswerResult {
    void r;
    return {
      text: 'Не знаю',
      sources: [],
      refused: true,
      model: 'gemini-3.6-flash',
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 0,
    };
  }

  async init(): Promise<this> {
    const url = process.env.ASSIST_PUBLIC_DATABASE_URL;
    this.publicDb = url
      ? (new PrismaClient(
          assistPublicClientOptions(url),
        ) as unknown as AssistPublicDb)
      : await publicPrisma(this.prisma);
    this.signals = new LearningSignals(this.publicDb);
    this.forget = new ForgetJobs(this.publicDb);
    return this;
  }

  async close(): Promise<void> {
    if (this.accounts.length) {
      await this.prisma.siteAccount
        .deleteMany({ where: { id: { in: this.accounts } } })
        .catch(() => undefined);
    }
    await this.publicDb?.$disconnect();
    await this.prisma.$disconnect();
  }

  /** Стенд K2 (crawl/indexSite из k2-fixtures) — нужны только prisma и индексатор. */
  private get h(): Harness {
    return {
      prisma: this.prisma,
      siteIndexing: this.indexing,
    } as unknown as Harness;
  }

  private async member(
    accountId: string,
    role: 'owner' | 'manager' | 'operator',
    productRoles: ProductRoles,
  ): Promise<AccountMembership> {
    const telegramId = ++tgNext;
    const m = await this.prisma.siteAccountMember.create({
      data: { accountId, telegramId, role, productRoles },
    });
    return { accountId, memberId: m.id, telegramId, role, productRoles };
  }

  /** Кабинет (владелец, менеджер, 2 оператора) + сайт + verified-хост + assist_sites. */
  async site(
    opts: { endClientId?: string | null; accountId?: string } = {},
  ): Promise<LSite> {
    const p = this.prisma;
    let accountId = opts.accountId;
    if (!accountId) {
      const account = await p.siteAccount.create({
        data: { verifyToken: `l-${randomUUID()}` },
      });
      accountId = account.id;
      this.accounts.push(accountId);
    }
    const members = await p.siteAccountMember.findMany({
      where: { accountId },
      orderBy: { createdAt: 'asc' },
    });
    const view = (r: (typeof members)[number]): AccountMembership => ({
      accountId: accountId as string,
      memberId: r.id,
      telegramId: r.telegramId,
      role: r.role as AccountMembership['role'],
      productRoles: r.productRoles as unknown as ProductRoles,
    });
    const roster = members.length
      ? {
          owner: view(members[0]),
          manager: view(members[1]),
          operator: view(members[2]),
          operator2: view(members[3]),
        }
      : {
          owner: await this.member(accountId, 'owner', OWNER_PRODUCT_ROLES),
          manager: await this.member(accountId, 'manager', {
            qa: 'none',
            assist: 'manager',
            assistAdmin: 'none',
          }),
          operator: await this.member(accountId, 'operator', {
            qa: 'none',
            assist: 'operator',
            assistAdmin: 'none',
          }),
          operator2: await this.member(accountId, 'operator', {
            qa: 'none',
            assist: 'operator',
            assistAdmin: 'none',
          }),
        };
    const host = `l-${randomUUID().slice(0, 8)}.example.com`;
    const site = await p.site.create({
      data: {
        accountId,
        name: `Магазин ${host}`,
        endClientId: opts.endClientId ?? null,
      },
    });
    const h = await p.siteHost.create({
      data: {
        accountId,
        siteId: site.id,
        host,
        status: 'verified',
        method: 'dns',
        verifiedAt: new Date(),
      },
    });
    await p.assistSite.create({
      data: {
        accountId,
        siteId: site.id,
        enabled: true,
        recrawlEvery: 'manual',
        widgetVersion: 1,
        publicKey: `pk-l-${randomUUID()}`,
      },
    });
    return {
      accountId,
      siteId: site.id,
      hostId: h.id,
      origin: `https://${host}`,
      ...roster,
    };
  }

  /** «Обход» и индексация страниц сайта (новая опубликованная версия). */
  async pages(s: LSite, pages: PageSpec[]): Promise<number> {
    await crawl(this.h, { ...s, ownerTelegramId: s.owner.telegramId }, pages);
    const out = await indexSite(this.h, {
      ...s,
      ownerTelegramId: s.owner.telegramId,
    });
    const status = out?.version?.status;
    if (status !== 'published') {
      throw new Error(`версия не опубликована: ${String(status)}`);
    }
    return this.version(s);
  }

  async version(s: LSite): Promise<number> {
    const a = await this.prisma.assistSite.findFirst({
      where: { siteId: s.siteId },
      select: { knowledgeVersion: true },
    });
    return a?.knowledgeVersion ?? 0;
  }

  /** Диалог посетителя (как его создал бы виджет) — основная роль. */
  async conversation(
    s: LSite,
    over: { visitorId?: string; pageUrl?: string; createdAt?: Date } = {},
  ) {
    return this.prisma.assistSiteConversation.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        visitorId: over.visitorId ?? `v-${randomUUID()}`,
        ipHash: `ip-${randomUUID()}`,
        parentOrigin: s.origin,
        pageUrl: over.pageUrl ?? `${s.origin}/`,
        ...(over.createdAt ? { createdAt: over.createdAt } : {}),
      },
    });
  }

  async message(
    s: LSite,
    conversationId: string,
    role: 'visitor' | 'assistant' | 'operator',
    text: string,
    over: { authorMemberId?: string; lang?: string; createdAt?: Date } = {},
  ) {
    return this.prisma.assistSiteMessage.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        conversationId,
        role,
        text,
        flags: [],
        lang: over.lang ?? 'uk',
        authorMemberId: over.authorMemberId ?? null,
        ...(over.createdAt ? { createdAt: over.createdAt } : {}),
      },
    });
  }

  /** Сигнал как его пишет конвейер/👎 — под ролью assist_public. */
  signal(
    s: LSite,
    over: Partial<LearningSignal> & { questionMasked: string },
  ): Promise<void> {
    return this.signals.record({
      accountId: s.accountId,
      siteId: s.siteId,
      kind: 'unknown',
      signal: 'no_answer',
      conversationId: null,
      messageId: randomUUID(),
      visitorId: `v-${randomUUID()}`,
      suspicious: false,
      answerMasked: null,
      lang: 'uk',
      embedding: bagOfWordsVector(over.questionMasked),
      ...over,
    });
  }

  /** Вопрос посетителя + сигнал (как это сделал бы конвейер). */
  async ask(
    s: LSite,
    question: string,
    over: {
      visitorId?: string;
      suspicious?: boolean;
      kind?: LearningSignal['kind'];
      lang?: string;
      createdAt?: Date;
      pageUrl?: string;
    } = {},
  ): Promise<{ conversationId: string; messageId: string }> {
    const c = await this.conversation(s, {
      visitorId: over.visitorId,
      pageUrl: over.pageUrl,
      createdAt: over.createdAt,
    });
    const msg = await this.message(s, c.id, 'visitor', question, {
      createdAt: over.createdAt,
    });
    await this.signal(s, {
      questionMasked: question,
      conversationId: c.id,
      messageId: msg.id,
      visitorId: c.visitorId,
      suspicious: over.suspicious ?? false,
      kind: over.kind ?? 'unknown',
      lang: over.lang ?? 'uk',
    });
    if (over.createdAt) {
      await this.prisma.assistSiteLearningItem.updateMany({
        where: { messageId: msg.id, siteId: s.siteId },
        data: { createdAt: over.createdAt },
      });
    }
    return { conversationId: c.id, messageId: msg.id };
  }

  /** Крон разбора — только по своим сайтам (контракт Э3 §9 п.6 (б)). */
  rollupRun(sites: LSite[], now = new Date()) {
    return this.rollup.run(now, { siteIds: sites.map((x) => x.siteId) });
  }

  items(s: LSite) {
    return this.prisma.assistSiteLearningItem.findMany({
      where: { siteId: s.siteId },
      orderBy: { createdAt: 'asc' },
    });
  }

  clusters(s: LSite) {
    return this.prisma.assistSiteLearningCluster.findMany({
      where: { siteId: s.siteId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Тексты фрагментов FAQ опубликованной версии. */
  async faqChunkTexts(s: LSite): Promise<string[]> {
    const v = await this.version(s);
    const rows = await this.prisma.assistSiteChunk.findMany({
      where: { siteId: s.siteId, sourceType: 'faq', versions: { has: v } },
      select: { text: true },
    });
    return rows.map((r) => r.text);
  }

  /** Бюджет обучения сайта — ноль (доля 0 б.п.): «исчерпан». */
  async exhaustBudget(s: LSite): Promise<void> {
    await this.prisma.assistSite.updateMany({
      where: { siteId: s.siteId },
      data: { learningShareBp: 0 },
    });
  }
}

/** Набор без базы: пропуск с причиной (в CI — провал). */
export { describeWithoutDb } from '../../../acceptance/e1/k2-fixtures';
