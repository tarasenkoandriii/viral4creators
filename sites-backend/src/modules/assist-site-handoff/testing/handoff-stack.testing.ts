/**
 * Стенд тестов передачи человеку (H) на НАСТОЯЩЕМ Postgres — поверх стенда
 * конвейера Э2 (ChatStack): публичная часть (HandoffIntake, конвейер) — под
 * логин-ролью assist_public, системная (рассылка, «Взять», ответы, бот) —
 * основной ролью. Telegram — подменённый fetch (TgFake: тела запросов
 * сверяются, message_id выдаётся по порядку); модель — FakeHandoffText
 * (сводка с «телефоном» — проверка маскирования, перевод — пометкой языка);
 * поиск «Сайта» для черновика — FakeSiteSearch + AnswerEngine на FakeText.
 * Очередь обучения (L) и сверка identify (A) — записывающие подделки:
 * стыки проверяются по вызовам, а не по чужой реализации.
 * Каждый тест — свои кабинет/сайт (uniq), общая база не чистится.
 */
import { randomUUID } from 'crypto';
import { SitesDb } from '../../../prisma/sites-db.service';
import { AnswerEngine } from '../../assist-knowledge-core/answer/answer-engine';
import type { IntegrationsService } from '../../assist-analytics/integrations.service';
import {
  FakeSiteSearch,
  FakeText,
} from '../../assist-sandbox/testing/k3-stack.testing';
import type {
  WidgetSiteContext,
  WidgetVisitor,
} from '../../assist-site-chat/chat-types';
import { SiteChatService } from '../../assist-site-chat/site-chat.service';
import {
  ChatStack,
  type ChatSite,
} from '../../assist-site-chat/testing/chat-stack.testing';
import type { SiteKnowledgeService } from '../../assist-site-knowledge/site-knowledge.service';
import type { LearningCandidates } from '../../assist-site-learning/learning-queue.service';
import {
  LearningSignals,
  type LearningSignal,
} from '../../assist-site-learning/public/learning-signals';
import {
  GeminiText,
  type GenerateRequest,
  type GenerateResult,
} from '../../site-ai/text-model';
import { AssistBotUpdates } from '../bot/assist-bot-updates.service';
import {
  ConversationsService,
  HandoffSettingsService,
} from '../cabinet/conversations.service';
import {
  defaultHandoffConfig,
  type HandoffConfig,
} from '../public/handoff-config';
import { HandoffIntake } from '../public/handoff-intake.service';
import { HandoffAi } from '../system/handoff-ai';
import { HandoffDispatcher } from '../system/handoff-dispatcher.service';
import { HandoffOperatorActions } from '../system/handoff-operator.service';

// ── Telegram ────────────────────────────────────────────────────────────

export interface TgRequest {
  method: string;
  body: Record<string, unknown>;
  /** message_id, который «выдал» Telegram (sendMessage). */
  messageId: number | null;
  status: number;
}

/** Подменённый Bot API: записывает запросы, статус — по правилу теста. */
export class TgFake {
  readonly requests: TgRequest[] = [];
  /** Статус ответа: число или правило по запросу (403 — «бот заблокирован»). */
  status: number | ((r: { method: string; chatId: string | null }) => number) =
    200;
  private seq = 1000;

  readonly fetchImpl = async (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ) => {
    const method = /\/bot[^/]+\/(\w+)$/.exec(url)?.[1] ?? '?';
    const body = JSON.parse(init.body) as Record<string, unknown>;
    const chatId = typeof body.chat_id === 'string' ? body.chat_id : null;
    const status =
      typeof this.status === 'number'
        ? this.status
        : this.status({ method, chatId });
    const messageId =
      status < 300 && method === 'sendMessage' ? ++this.seq : null;
    this.requests.push({ method, body, messageId, status });
    return {
      ok: status < 300,
      status,
      json: async () => ({
        ok: status < 300,
        result:
          messageId !== null
            ? { message_id: messageId }
            : method === 'editMessageText'
              ? { message_id: body.message_id }
              : true,
      }),
    };
  };

  sent(chatId?: bigint): TgRequest[] {
    return this.requests.filter(
      (r) =>
        r.method === 'sendMessage' &&
        r.status < 300 &&
        (chatId === undefined || r.body.chat_id === chatId.toString()),
    );
  }

  /** Карточки передачи, отправленные человеку. */
  cards(chatId?: bigint): TgRequest[] {
    return this.sent(chatId).filter((r) =>
      String(r.body.text).startsWith('🙋'),
    );
  }

  edits(chatId?: bigint): TgRequest[] {
    return this.requests.filter(
      (r) =>
        r.method === 'editMessageText' &&
        (chatId === undefined || r.body.chat_id === chatId.toString()),
    );
  }

  /** Все callback_data во всех запросах. */
  callbacks(): string[] {
    const out: string[] = [];
    for (const r of this.requests) {
      const kb = (r.body.reply_markup as { inline_keyboard?: unknown[][] })
        ?.inline_keyboard;
      for (const row of kb ?? []) {
        for (const b of row as Array<{ callback_data?: string }>) {
          if (b.callback_data) out.push(b.callback_data);
        }
      }
    }
    return out;
  }

  clear(): void {
    this.requests.length = 0;
  }
}

// ── Модель передачи ─────────────────────────────────────────────────────

const LANG_BY_NAME: Array<[RegExp, string]> = [
  [/українською/, 'uk'],
  [/по-русски/, 'ru'],
  [/in English/, 'en'],
];

/** Подделка «lite-модели»: сводка (с телефоном — проверка маски), перевод с пометкой. */
export class FakeHandoffText extends GeminiText {
  readonly calls: GenerateRequest[] = [];
  fail = false;
  summary =
    'Посетитель спрашивает про доставку, помощник ответил по сайту. Его телефон +380 67 123 45 67.';

  override async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.calls.push(req);
    if (this.fail) throw new Error('модель недоступна (фейк)');
    const usage = {
      model: 'gemini-3.6-flash',
      inputTokens: 300,
      cachedInputTokens: 0,
      outputTokens: 60,
    };
    const q = /<q>\n([\s\S]*)\n<\/q>/.exec(req.user);
    if (q) {
      const to = LANG_BY_NAME.find(([re]) => re.test(req.system))?.[1] ?? '??';
      return { ...usage, text: `[${to}] ${q[1]}` };
    }
    return { ...usage, text: this.summary };
  }

  translations(): GenerateRequest[] {
    return this.calls.filter((c) => c.user.startsWith('<q>'));
  }
  summaries(): GenerateRequest[] {
    return this.calls.filter((c) => c.user.startsWith('<dialog>'));
  }
}

// ── Подделки стыков L и A ───────────────────────────────────────────────

export class RecordingSignals extends LearningSignals {
  readonly calls: LearningSignal[] = [];
  override async record(signal: LearningSignal): Promise<void> {
    this.calls.push(signal);
  }
}

export function fakeCandidates() {
  const c = {
    fixes: [] as Array<{
      accountId: string;
      siteId: string;
      conversationId: string;
      operatorMessageId: string;
    }>,
    proposals: [] as Array<{ telegramId: bigint; messageId: string }>,
    async proposeFromOperator(p: { telegramId: bigint; messageId: string }) {
      c.proposals.push(p);
      return 'proposed' as const;
    },
    async recordOperatorFix(p: {
      accountId: string;
      siteId: string;
      conversationId: string;
      operatorMessageId: string;
    }) {
      c.fixes.push(p);
    },
  };
  return c;
}

/** userHash «good» — проверен, иное — нет (сверка — A; здесь стык). */
export function fakeIntegrations() {
  return {
    calls: [] as Array<[string, string, string]>,
    async verifyUserHash(siteId: string, externalId: string, hash: string) {
      this.calls.push([siteId, externalId, hash]);
      return hash === 'good';
    },
  };
}

// ── Стенд ───────────────────────────────────────────────────────────────

export interface HandoffSite extends ChatSite {
  /** Участники: [0] — владелец, дальше — операторы. */
  members: Array<{ memberId: string; telegramId: bigint; role: string }>;
  operators: Array<{ memberId: string; telegramId: bigint }>;
}

let updateSeq = 1;
let userMsgSeq = 50_000;

export class HandoffStack extends ChatStack {
  readonly tg = new TgFake();
  readonly htext = new FakeHandoffText();
  readonly knowledge = new FakeSiteSearch();
  readonly answerText = new FakeText();
  readonly candidates = fakeCandidates();
  readonly integrations = fakeIntegrations();
  signals!: RecordingSignals;
  ai!: HandoffAi;
  dispatcher!: HandoffDispatcher;
  actions!: HandoffOperatorActions;
  bot!: AssistBotUpdates;
  intake!: HandoffIntake;
  conversations!: ConversationsService;
  settings!: HandoffSettingsService;

  override async init(): Promise<this> {
    await super.init();
    const p = this.owner;
    this.ai = new HandoffAi(
      p,
      this.budget,
      this.htext,
      this.usage,
      this.knowledge as unknown as SiteKnowledgeService,
      new AnswerEngine(this.answerText),
    );
    this.dispatcher = new HandoffDispatcher(
      p,
      this.ai,
      this.integrations as unknown as IntegrationsService,
      this.candidates as unknown as LearningCandidates,
    );
    this.dispatcher.env = this.env;
    this.dispatcher.fetchImpl = this.tg.fetchImpl;
    this.actions = new HandoffOperatorActions(p, this.ai, this.dispatcher);
    this.bot = new AssistBotUpdates(
      p,
      this.actions,
      this.dispatcher,
      this.candidates as unknown as LearningCandidates,
    );
    this.signals = new RecordingSignals(this.publicDb);
    this.intake = new HandoffIntake(
      this.publicDb,
      this.dispatcher,
      this.signals,
    );
    this.intake.env = this.env;
    this.chat = new SiteChatService(
      this.publicDb,
      this.search,
      this.budget,
      this.quota,
      this.cache,
      this.model,
      this.usage,
      this.intake,
      this.signals,
    );
    this.chat.env = this.env;
    this.chat.sleep = async () => undefined;
    this.chat.replayPollMs = 20;
    const sitesDb = new SitesDb(p);
    this.conversations = new ConversationsService(sitesDb);
    this.settings = new HandoffSettingsService(sitesDb, p, this.dispatcher);
    return this;
  }

  /**
   * Сайт с операторами: включённая передача (круглосуточно, если не задано),
   * Start у бота — у владельца и операторов (`start: false` — ни у кого).
   */
  async handoffSite(
    opts: {
      operators?: number;
      start?: boolean;
      config?: Partial<HandoffConfig>;
      dailyCapMicroUsd?: number | null;
      name?: string;
      /** Без страниц — поиск пуст («не нашёл»). */
      noPages?: boolean;
    } = {},
  ): Promise<HandoffSite> {
    const s = await this.site({
      name: opts.name,
      dailyCapMicroUsd: opts.dailyCapMicroUsd,
      members: Array.from({ length: opts.operators ?? 2 }, () => ({
        role: 'operator',
        productRoles: { assist: 'operator' },
      })),
    });
    if (!opts.noPages)
      await this.pages(s, [
        {
          path: '/delivery',
          title: 'Доставка',
          lang: 'uk',
          text: 'Доставка Новою поштою коштує 80 грн. Відправляємо щодня.',
        },
      ]);
    const rows = await this.owner.siteAccountMember.findMany({
      where: { accountId: s.accountId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, telegramId: true, role: true },
    });
    const members = rows.map((r) => ({
      memberId: r.id,
      telegramId: r.telegramId,
      role: r.role,
    }));
    await this.setConfig(s.siteId, { enabled: true, ...opts.config });
    if (opts.start !== false) {
      for (const m of members) await this.startBot(m.telegramId);
    }
    this.dispatcher.forgetRecipients();
    return {
      ...s,
      members,
      operators: members.filter((m) => m.role === 'operator'),
    };
  }

  async setConfig(siteId: string, over: Partial<HandoffConfig>): Promise<void> {
    await this.owner.assistSite.update({
      where: { siteId },
      data: {
        handoffConfig: { ...defaultHandoffConfig(), ...over } as object,
      },
    });
  }

  async startBot(telegramId: bigint): Promise<void> {
    await this.owner.assistBotUser.upsert({
      where: { telegramId },
      create: { telegramId, startedAt: new Date() },
      update: { startedAt: new Date(), blockedAt: null },
    });
  }

  /** Посетитель с диалогом: один вопрос модели (ответ по сайту). */
  async visitorWithDialog(
    s: HandoffSite,
    question = 'Скільки коштує доставка?',
  ): Promise<{ visitor: WidgetVisitor; conversationId: string }> {
    const visitor = this.visitor();
    const r = await this.ask(s, question, { visitor });
    if (!r.meta) throw new Error('нет meta');
    return { visitor, conversationId: r.meta.conversationId };
  }

  /** «Позвать человека» (как POST /widget/v1/handoff, W → H). */
  async requestHandoff(
    s: HandoffSite,
    v: { visitor: WidgetVisitor; conversationId: string },
    over: Partial<Parameters<HandoffIntake['request']>[0]> = {},
  ) {
    return this.intake.request({
      site: s.ctx(),
      visitor: v.visitor,
      conversationId: v.conversationId,
      reason: 'visitor',
      uiLang: 'uk',
      pageUrl: s.url('/delivery?utm=secret#x'),
      identity: null,
      ...over,
    });
  }

  ctxOf(s: HandoffSite): WidgetSiteContext {
    return s.ctx();
  }

  // ── Обновления бота ──────────────────────────────────────────────────

  async callback(
    telegramId: bigint,
    data: string,
    msg: { chatId?: bigint; messageId?: number } = {},
  ): Promise<void> {
    await this.bot.handle({
      update_id: updateSeq++,
      callback_query: {
        id: `cb-${randomUUID()}`,
        from: { id: Number(telegramId) },
        message: {
          message_id: msg.messageId ?? 1,
          chat: { id: Number(msg.chatId ?? telegramId), type: 'private' },
        },
        data,
      },
    });
  }

  async replyTo(
    telegramId: bigint,
    replyToMessageId: number,
    text: string | null,
  ): Promise<void> {
    await this.bot.handle({
      update_id: updateSeq++,
      message: {
        message_id: ++userMsgSeq,
        from: { id: Number(telegramId), language_code: 'uk' },
        chat: { id: Number(telegramId), type: 'private' },
        ...(text === null ? { photo: [{ file_id: 'x' }] } : { text }),
        reply_to_message: { message_id: replyToMessageId },
      },
    });
  }

  async botStart(telegramId: bigint): Promise<void> {
    await this.bot.handle({
      update_id: updateSeq++,
      message: {
        message_id: ++userMsgSeq,
        from: { id: Number(telegramId), language_code: 'ru' },
        chat: { id: Number(telegramId), type: 'private' },
        text: '/start',
      },
    });
  }

  async handoffRow(id: string) {
    return this.owner.assistSiteHandoff.findUniqueOrThrow({ where: { id } });
  }
}
