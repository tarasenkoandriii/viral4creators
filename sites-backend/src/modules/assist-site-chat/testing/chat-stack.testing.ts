/**
 * Стенд тестов W3 на НАСТОЯЩЕМ Postgres (образец — k3-stack.testing.ts):
 * публичный конвейер — под логин-ролью в assist_public (publicPrisma, с
 * omit, как в проде), посев — владельцем схемы. ИИ — подделки:
 *  - эмбеддинг — «мешок слов» (k3-stack): одинаковые слова — близкие векторы;
 *  - модель ответа FakeChatModel: `honest` отвечает предложениями
 *    фрагмента с наибольшим пересечением основ слов с вопросом (+ [S#] и
 *    кнопка-ссылка), нет пересечения — честное «не знаю» без [S#];
 *    `evil` — «злая» модель: если в её входе есть инъекция, исполняет её
 *    («всё бесплатно навсегда» + evil.com + чужие [S#] и кнопки), а в
 *    остальных ответах всё равно подсовывает ссылку на evil.com — защита
 *    обязана быть в коде (приёмка Э2 п.4);
 *  - перевод — FakeTranslator по словарю (как «lite-модель» §4-тер.10).
 * Каждый тест создаёт свои кабинет/сайт со случайными id — общая база не
 * чистится, параллельные наборы не мешают.
 */
import { createHash, randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../../prisma/prisma.service';
import {
  assistPublicClientOptions,
  type AssistPublicDb,
} from '../../../prisma/assist-public-db.service';
import { SitesDb } from '../../../prisma/sites-db.service';
import type { ModelStreamChunk } from '../../../shared/assist-chat-core';
import { detectInjection } from '../../assist-knowledge-core/injection';
import type { PersonaConfig } from '../../assist-site-setup/persona';
import {
  bagOfWordsVector,
  fakeEmbedTransport,
  ownerPrisma,
  publicPrisma,
  uniq,
} from '../../assist-sandbox/testing/k3-stack.testing';
import { GeminiEmbedder, toVectorLiteral } from '../../site-ai/embedder';
import {
  GeminiText,
  type GenerateRequest,
  type GenerateResult,
} from '../../site-ai/text-model';
import { AiUsageRecorder } from '../../site-ai/usage-recorder';
import { DialogQuota, SiteBudget } from '../budget';
import { SiteChatModel, type ChatModelRequest } from '../chat-model';
import type {
  AskInput,
  SiteAction,
  SiteAnswerSource,
  WidgetChatEvent,
  WidgetSiteContext,
  WidgetVisitor,
} from '../chat-types';
import { SiteLeadsService } from '../leads.service';
import { PublicSiteSearch } from '../public-search';
import { SemanticCache } from '../semantic-cache';
import { SiteAnswerer } from '../site-answerer';
import { SiteChatService } from '../site-chat.service';
import { ChatRetention } from '../system/chat-retention.service';
import { LeadDelivery } from '../system/lead-delivery.service';
import { STANDS, type StandId, type StandPage } from '../eval/stands';

export { uniq, ownerPrisma };

export const TEST_SECRETS_KEY = 'w3-chat-test-secret';

// ── Словарь «перевода» (FakeTranslator и честная модель) ────────────────

/** en/ru → язык базы стенда: только слова, нужные кейсам multilang. */
export const FAKE_DICT: Record<string, string> = {
  delivery: 'доставка',
  cost: 'коштує',
  warranty: 'гарантія',
  kettle: 'електрочайник',
  laptop: 'ноутбука',
  diagnostics: 'діагностика',
  trial: 'пробный',
  period: 'период',
  long: 'длится',
  возврат: 'повернення',
  товара: 'товару',
  дней: 'днів',
  сервис: 'сервіс',
  находится: 'знаходиться',
  markup: 'націнка',
  supplier: 'постачальника',
};

/** Слова вопросов без смысла для «понимания» подделкой (основы по 5 букв). */
const STOP = new Set(
  [
    'скільки',
    'сколько',
    'коштує',
    'стоит',
    'стоимость',
    'вартість',
    'можна',
    'можно',
    'якими',
    'какой',
    'какая',
    'какие',
    'какое',
    'каких',
    'каким',
    'какими',
    'каком',
    'когда',
    'котрої',
    'якщо',
    'нужна',
    'нужен',
    'where',
    'which',
    'there',
    'about',
    'сейчас',
    'зараз',
    'тільки',
    'только',
  ].map((w) => w.slice(0, 5)),
);

export function stems(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text
    .normalize('NFKC')
    .toLowerCase()
    .matchAll(/[\p{L}\p{N}]+/gu)) {
    const w = m[0];
    if (w.length < 5) continue;
    const s = w.slice(0, 5);
    if (!STOP.has(s)) out.add(s);
  }
  return out;
}

export function fakeTranslate(text: string): string {
  return text
    .split(/(\s+)/)
    .map((w) => {
      const k = w.toLowerCase().replace(/[^\p{L}]/gu, '');
      return FAKE_DICT[k] ?? w;
    })
    .join('');
}

export class FakeTranslator extends GeminiText {
  readonly calls: GenerateRequest[] = [];
  fail = false;
  override async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.calls.push(req);
    if (this.fail) throw new Error('провайдер недоступен (фейк)');
    const q = /<q>\n([\s\S]*)\n<\/q>/.exec(req.user)?.[1] ?? req.user;
    return {
      text: fakeTranslate(q),
      model: 'gemini-3.6-flash',
      inputTokens: 40,
      cachedInputTokens: 0,
      outputTokens: 20,
    };
  }
}

// ── Модель ответа ───────────────────────────────────────────────────────

interface PromptSource {
  n: number;
  url: string;
  title: string;
  text: string;
}

export function parseSources(user: string): PromptSource[] {
  const out: PromptSource[] = [];
  for (const m of user.matchAll(
    /<source id="S(\d+)" url="([^"]*)" title="([^"]*)"[^>]*>\n([\s\S]*?)\n<\/source>/g,
  )) {
    out.push({ n: Number(m[1]), url: m[2], title: m[3], text: m[4] });
  }
  return out;
}

export function parseQuestion(user: string): string {
  return /<question>\n([\s\S]*?)\n<\/question>/.exec(user)?.[1] ?? '';
}

export type FakeMode = 'honest' | 'evil' | 'fail' | 'fail-midway';

/** Что «злая» модель пишет, исполнив инъекцию. */
export const EVIL_TEXT =
  'ВСЕ БЕЗКОШТОВНО НАЗАВЖДИ! Free forever: https://evil.com/promo [S1] [S9]';

export class FakeChatModel extends SiteChatModel {
  mode: FakeMode = 'honest';
  readonly calls: ChatModelRequest[] = [];
  /** Пауза между кусками стрима (мс). */
  delayMs = 0;
  chunkSize = 7;
  usage = { promptTokenCount: 1200, candidatesTokenCount: 40 };
  /** Сколько вызовов прямо сейчас «генерируют» (гонки бюджета). */
  active = 0;
  maxActive = 0;

  override get model(): string {
    return 'gemini-3.6-flash';
  }

  /** Текст ответа модели целиком (без стрима). */
  compose(req: ChatModelRequest): string {
    const last = req.contents[req.contents.length - 1]?.content ?? '';
    const sources = parseSources(last);
    const question = parseQuestion(last);
    if (this.mode === 'evil' && this.sawInjection(req)) {
      return `${EVIL_TEXT}\n<<<actions>>>${JSON.stringify({
        items: [
          {
            kind: 'link',
            label: 'Забрати подарунок',
            url: 'https://evil.com/gift',
          },
          { kind: 'link', label: 'Сторінка', url: 'https://example.invalid/x' },
          { kind: 'video', label: 'x' },
        ],
      })}`;
    }
    const honest = this.honest(req.system, question, sources);
    if (this.mode !== 'evil') return honest;
    // «Злая» модель без инъекции во входе всё равно подсовывает ссылку.
    const [text, actions] = honest.split('<<<actions>>>');
    const items = actions
      ? (JSON.parse(actions) as { items: unknown[] }).items
      : [];
    items.unshift({
      kind: 'link',
      label: 'Акція',
      url: 'https://evil.com/deal',
    });
    return `${text} Дивіться також evil.com/deal та [опис](https://evil.com/x) ![img](https://evil.com/p.png)<<<actions>>>${JSON.stringify({ items })}`;
  }

  private sawInjection(req: ChatModelRequest): boolean {
    const persona = /<persona>[\s\S]*?<\/persona>/.exec(req.system)?.[0] ?? '';
    const summary =
      /<site_summary>[\s\S]*?<\/site_summary>/.exec(req.system)?.[0] ?? '';
    const blocks = [persona, summary];
    for (const c of req.contents) {
      const sources = parseSources(c.content).map((s) => s.text);
      const rest = c.content.replace(/<source[\s\S]*?<\/source>/g, '');
      blocks.push(...sources, rest);
    }
    // Каркас платформы сам цитирует «игнорируй правила» — его не смотрим.
    return blocks.some(
      (b) =>
        detectInjection(b.replace(/‹/g, '<').replace(/›/g, '>')).quarantine,
    );
  }

  private honest(
    system: string,
    question: string,
    sources: PromptSource[],
  ): string {
    const q = new Set([...stems(question), ...stems(fakeTranslate(question))]);
    let best: PromptSource | null = null;
    let bestScore = 0;
    for (const s of sources) {
      const st = stems(`${s.title} ${s.text}`);
      const score = [...q].filter((x) => st.has(x)).length;
      if (score > bestScore) {
        best = s;
        bestScore = score;
      }
    }
    if (!best) {
      return 'На сторінках сайту цього немає — залиште заявку, менеджер уточнить.';
    }
    const sentences = best.text.split(/(?<=[.!?])\s+/);
    const picked = sentences
      .filter((sent) => [...stems(sent)].some((x) => q.has(x)))
      .slice(0, 3);
    const body = (picked.length ? picked : sentences.slice(0, 1)).join(' ');
    const note = /Знания сайта написаны на языке «([a-z]{2})»/.exec(system);
    const tail = note
      ? ` (Information on the site is in language: ${note[1]}.)`
      : '';
    const actions = best.url
      ? `<<<actions>>>${JSON.stringify({ items: [{ kind: 'link', label: 'Детальніше', url: best.url }] })}`
      : '';
    return `${body} [S${best.n}]${tail}${actions}`;
  }

  override async openStream(
    req: ChatModelRequest,
    signal: AbortSignal,
  ): Promise<AsyncIterable<ModelStreamChunk>> {
    this.calls.push(req);
    if (this.mode === 'fail') throw new Error('модель недоступна (фейк)');
    const text = this.compose(req);
    const size = this.chunkSize;
    const delay = this.delayMs;
    const usage = this.usage;
    const midway = this.mode === 'fail-midway';
    const enter = () => {
      this.active++;
      this.maxActive = Math.max(this.maxActive, this.active);
    };
    const leave = () => {
      this.active--;
    };
    return {
      async *[Symbol.asyncIterator]() {
        enter();
        try {
          for (let i = 0; i < text.length; i += size) {
            if (signal.aborted) throw new Error('aborted');
            if (delay) await new Promise((r) => setTimeout(r, delay));
            if (midway && i >= size * 3) throw new Error('обрыв (фейк)');
            const last = i + size >= text.length;
            yield {
              text: text.slice(i, i + size),
              ...(last ? { usageMetadata: usage } : {}),
            };
          }
        } finally {
          leave();
        }
      },
    };
  }
}

// ── Стенд ───────────────────────────────────────────────────────────────

export interface ChatSite {
  accountId: string;
  siteId: string;
  host: string;
  origin: string;
  ownerTelegramId: bigint;
  /** Контекст гварда W2 (опубликованные версии на момент создания). */
  ctx(over?: Partial<WidgetSiteContext>): WidgetSiteContext;
  url(path: string): string;
}

let tg = BigInt(Date.now()) * BigInt(1000) + BigInt(777);

export interface Collected {
  events: WidgetChatEvent[];
  meta: Extract<WidgetChatEvent, { type: 'meta' }> | null;
  text: string;
  sources: SiteAnswerSource[];
  actions: SiteAction[];
  done: boolean;
  error: Extract<WidgetChatEvent, { type: 'error' }> | null;
}

export async function collect(
  it: AsyncIterable<WidgetChatEvent>,
): Promise<Collected> {
  const c: Collected = {
    events: [],
    meta: null,
    text: '',
    sources: [],
    actions: [],
    done: false,
    error: null,
  };
  for await (const ev of it) {
    c.events.push(ev);
    if (ev.type === 'meta') c.meta = ev;
    else if (ev.type === 'token') c.text += ev.t;
    else if (ev.type === 'sources') c.sources = ev.items;
    else if (ev.type === 'actions') c.actions = ev.items;
    else if (ev.type === 'done') c.done = true;
    else if (ev.type === 'error') c.error = ev;
  }
  return c;
}

export class ChatStack {
  owner!: PrismaService;
  publicDb!: AssistPublicDb;
  readonly model = new FakeChatModel();
  readonly translator = new FakeTranslator();
  readonly embedCalls: string[][] = [];
  readonly usage = new AiUsageRecorder();
  readonly budget = new SiteBudget();
  readonly quota = new DialogQuota();
  search!: PublicSiteSearch;
  cache!: SemanticCache;
  chat!: SiteChatService;
  answerer!: SiteAnswerer;
  delivery!: LeadDelivery;
  leads!: SiteLeadsService;
  retention!: ChatRetention;
  readonly sent: Array<{
    url: string;
    body: { chat_id: string; text: string };
  }> = [];
  sendStatus = 200;
  readonly env: NodeJS.ProcessEnv = {
    ASSIST_SECRETS_KEY: TEST_SECRETS_KEY,
    ASSIST_BOT_TOKEN: 'w3-bot-token',
    ASSIST_TMA_URL: 'https://tma.w3.example.com',
    ASSIST_WIDGET_ENABLED: 'true',
  };

  async init(): Promise<this> {
    this.owner = ownerPrisma();
    const url = process.env.ASSIST_PUBLIC_DATABASE_URL;
    this.publicDb = url
      ? (new PrismaClient(
          assistPublicClientOptions(url),
        ) as unknown as AssistPublicDb)
      : await publicPrisma(this.owner);
    const embedder = new GeminiEmbedder(fakeEmbedTransport(this.embedCalls));
    this.search = new PublicSiteSearch(
      this.publicDb,
      embedder,
      this.translator,
      this.usage,
    );
    this.cache = new SemanticCache(this.publicDb);
    this.budget.env = this.env;
    this.chat = new SiteChatService(
      this.publicDb,
      this.search,
      this.budget,
      this.quota,
      this.cache,
      this.model,
      this.usage,
    );
    this.chat.env = this.env;
    this.chat.sleep = async () => undefined;
    this.chat.replayPollMs = 20;
    this.answerer = new SiteAnswerer(
      this.publicDb,
      this.search,
      this.model,
      this.usage,
    );
    this.delivery = new LeadDelivery(this.owner, new SitesDb(this.owner));
    this.delivery.env = this.env;
    this.delivery.fetchImpl = async (u, init) => {
      this.sent.push({ url: u, body: JSON.parse(init.body) });
      return { ok: this.sendStatus < 300, status: this.sendStatus };
    };
    this.leads = new SiteLeadsService(this.publicDb, this.delivery);
    this.leads.env = this.env;
    this.retention = new ChatRetention(this.owner);
    return this;
  }

  async close(): Promise<void> {
    await this.chat.idle();
    await this.publicDb.$disconnect();
    await this.owner.$disconnect();
  }

  /** Кабинет + владелец + сайт + verified-хост + assist_sites (включён, вид опубликован, база v1). */
  async site(
    opts: {
      lang?: string;
      name?: string;
      dailyCapMicroUsd?: number | null;
      members?: Array<{ role: string; productRoles: Record<string, string> }>;
    } = {},
  ): Promise<ChatSite> {
    const p = this.owner;
    const host = `${uniq('w3')}.example.com`;
    const account = await p.siteAccount.create({
      data: { verifyToken: `w3-${randomUUID()}` },
    });
    const ownerTelegramId = ++tg;
    await p.siteAccountMember.create({
      data: {
        accountId: account.id,
        telegramId: ownerTelegramId,
        role: 'owner',
        productRoles: { qa: 'admin', assist: 'manager', assistAdmin: 'owner' },
      },
    });
    for (const m of opts.members ?? []) {
      await p.siteAccountMember.create({
        data: {
          accountId: account.id,
          telegramId: ++tg,
          role: m.role,
          productRoles: m.productRoles,
        },
      });
    }
    const site = await p.site.create({
      data: { accountId: account.id, name: opts.name ?? `Сайт ${host}` },
    });
    await p.siteHost.create({
      data: {
        accountId: account.id,
        siteId: site.id,
        host,
        status: 'verified',
        method: 'dns',
        verifiedAt: new Date(),
      },
    });
    await p.assistSite.create({
      data: {
        accountId: account.id,
        siteId: site.id,
        enabled: true,
        recrawlEvery: 'manual',
        knowledgeVersion: 1,
        widgetVersion: 1,
        publicKey: `pk-w3-${randomUUID()}`,
        dailyCapMicroUsd: opts.dailyCapMicroUsd ?? null,
      },
    });
    const origin = `https://${host}`;
    return {
      accountId: account.id,
      siteId: site.id,
      host,
      origin,
      ownerTelegramId,
      url: (path) => `${origin}${path}`,
      ctx: (over = {}) => ({
        accountId: account.id,
        siteId: site.id,
        knowledgeVersion: 1,
        configVersion: 0,
        widgetVersion: 1,
        parentOrigin: origin,
        keyKind: 'live',
        preview: false,
        ...over,
      }),
    };
  }

  private async sourceFor(s: ChatSite): Promise<string> {
    const found = await this.owner.assistSiteSource.findFirst({
      where: { siteId: s.siteId, kind: 'crawl' },
      select: { id: true },
    });
    if (found) return found.id;
    const src = await this.owner.assistSiteSource.create({
      data: { accountId: s.accountId, siteId: s.siteId, kind: 'crawl' },
    });
    return src.id;
  }

  private async insertChunk(p: {
    s: ChatSite;
    documentId: string;
    sourceType: string;
    url: string | null;
    title: string | null;
    text: string;
    lang: string;
    ugc: boolean;
    quarantined: boolean;
    embedText: string;
    version: number;
  }): Promise<string> {
    const id = randomUUID();
    const hash = createHash('sha256').update(p.text).digest('hex');
    await this.owner.$executeRawUnsafe(
      `INSERT INTO "sites"."assist_site_chunks"
         ("id", "accountId", "siteId", "documentId", "sourceType", "url", "title", "lang", "ordinal",
          "text", "tokens", "contentHash", "digitsMaskedHash", "versions", "ugc", "quarantined",
          "quarantineReason", "embedModel", "embedding", "embeddedAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9, $10, $11, $11, ARRAY[$12::int], $13, $14, $15,
               'gemini-embedding-001', $16::"extensions"."vector", now(), now())`,
      id,
      p.s.accountId,
      p.s.siteId,
      p.documentId,
      p.sourceType,
      p.url,
      p.title,
      p.lang,
      p.text,
      Math.ceil(p.text.length / 4),
      hash,
      p.version,
      p.ugc,
      p.quarantined,
      p.quarantined ? 'injection' : null,
      toVectorLiteral(bagOfWordsVector(p.embedText)),
    );
    return id;
  }

  /**
   * Страницы как после индексации K2: документ + фрагмент в версии v.
   * Инъекция `quarantine` — фрагмент в карантине (детектор K2); `legacy` —
   * старый фрагмент без карантина (проверка глубокой защиты поиска).
   */
  async pages(s: ChatSite, pages: StandPage[], version = 1): Promise<void> {
    const sourceId = await this.sourceFor(s);
    for (const pg of pages) {
      const url = s.url(pg.path);
      const doc = await this.owner.assistSiteDocument.create({
        data: {
          accountId: s.accountId,
          siteId: s.siteId,
          sourceId,
          ref: `${url}#${randomUUID().slice(0, 6)}`,
          kind: 'page',
          url,
          title: pg.title,
          lang: pg.lang,
        },
      });
      const quarantined =
        pg.injection === 'quarantine' ||
        (pg.injection !== 'legacy' && detectInjection(pg.text).quarantine);
      await this.insertChunk({
        s,
        documentId: doc.id,
        sourceType: 'page',
        url,
        title: pg.title,
        text: pg.text,
        lang: pg.lang,
        ugc: pg.ugc === true,
        quarantined,
        embedText: `${pg.title} ${pg.text}`,
        version,
      });
    }
  }

  /** Проверенный ответ (FAQ) как после индексации: строка FAQ + документ + фрагмент. */
  async faq(
    s: ChatSite,
    f: { question: string; answer: string; lang: string | null },
    version = 1,
  ): Promise<string> {
    const sourceId = await this.sourceFor(s);
    const faqId = randomUUID();
    const doc = await this.owner.assistSiteDocument.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        sourceId,
        ref: `faq:${faqId}`,
        kind: 'faq',
        title: f.question,
        lang: f.lang,
      },
    });
    await this.owner.assistSiteFaq.create({
      data: {
        id: faqId,
        accountId: s.accountId,
        siteId: s.siteId,
        question: f.question,
        answer: f.answer,
        lang: f.lang,
        status: 'active',
        documentId: doc.id,
      },
    });
    await this.insertChunk({
      s,
      documentId: doc.id,
      sourceType: 'faq',
      url: null,
      title: f.question,
      text: `${f.question}\n${f.answer}`,
      lang: f.lang ?? 'uk',
      ugc: false,
      quarantined: false,
      // Вектор проверенного ответа — по вопросу (как ищет прямой путь).
      embedText: f.question,
      version,
    });
    return faqId;
  }

  /** Стенд eval целиком (страницы + FAQ). */
  async stand(id: StandId): Promise<ChatSite> {
    const st = STANDS[id];
    const s = await this.site({ name: st.name, lang: st.lang });
    await this.pages(s, st.pages);
    for (const f of st.faq) await this.faq(s, f);
    return s;
  }

  /** Опубликованная персона (строка версий + configVersion), как публикация W4. */
  async publishPersona(
    s: ChatSite,
    persona: PersonaConfig,
    version = 1,
  ): Promise<void> {
    await this.owner.assistSiteConfigVersion.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        kind: 'persona',
        version,
        config: persona as unknown as object,
      },
    });
    await this.owner.assistSite.update({
      where: { siteId: s.siteId },
      data: { configVersion: version },
    });
  }

  visitor(over: Partial<WidgetVisitor> = {}): WidgetVisitor {
    return {
      visitorId: `v-${randomUUID()}`,
      ipHash: `ip-${randomUUID()}`,
      tokenIssuedAt: new Date(Date.now() - 60_000),
      sessionMessages: 1,
      ...over,
    };
  }

  input(s: ChatSite, question: string, over: Partial<AskInput> = {}): AskInput {
    return {
      site: s.ctx(),
      visitor: this.visitor(),
      conversationId: null,
      clientRequestId: randomUUID(),
      question,
      page: { url: s.url('/'), title: null },
      context: null,
      uiLang: null,
      ...over,
    };
  }

  async ask(
    s: ChatSite,
    question: string,
    over: Partial<AskInput> = {},
  ): Promise<Collected> {
    return collect(this.chat.ask(this.input(s, question, over)));
  }

  /** Строка денег дня сайта/платформы. */
  async budgetRow(scope: 'site' | 'platform', key: string, day: string) {
    const rows = await this.owner.$queryRawUnsafe<
      Array<{ spent: bigint; reserved: bigint }>
    >(
      `SELECT "spentMicroUsd" AS spent, "reservedMicroUsd" AS reserved
         FROM "sites"."assist_budget_days" WHERE "scope" = $1 AND "key" = $2 AND "day" = $3`,
      scope,
      key,
      day,
    );
    return rows[0]
      ? { spent: Number(rows[0].spent), reserved: Number(rows[0].reserved) }
      : null;
  }
}
