/**
 * Конвейер ответа виджета «Сайта» — W3 (ТЗ §4.5–§4.9, §4-бис.4, §4-тер.7,
 * §4-тер.10, §4.13 п.5–6, §6.5). Вызывает W2 из `POST /widget/v1/chat`.
 *
 * Порядок (все потолки — ДО платного вызова):
 *  1. Идемпотентность: (conversationId, clientRequestId) уже есть → `meta`
 *     с replay=true и дальше — текст из базы (если streaming — W2 ведёт
 *     продолжение по `GET …/messages/:id/stream`), модели НЕТ (§4-бис.10 п.3).
 *  2. Рубильники (платформа env, оператор, владелец, assist_sites.enabled,
 *     widgetVersion > 0) → шаблон «оставьте заявку» + action lead, без модели.
 *  3. Сохранить вопрос МАСКИРОВАННЫМ (maskForJournal); сырой — только в памяти.
 *  4. Правила без модели: приветствие/спасибо/«позовите человека» → шаблон;
 *     проверенный ответ на ТОМ ЖЕ языке с сходством ≥ 0.92 → прямой ответ
 *     (§4.5 п.1, §4-тер.10); семантический кэш (только первое сообщение
 *     диалога, §4.5) → ответ из кэша. `suspicious` → только FAQ/кэш/шаблон.
 *  5. Квота диалогов (первый ответ модели в диалоге, атомарно) и резерв
 *     бюджета (сайт + платформа, атомарно, TTL) — отказ → `site_quota` /
 *     `platform_budget` + форма лида.
 *  6. Поиск под assist_public (PublicSiteSearch, + второй поиск по переводу,
 *     если язык вопроса не в языках базы), промпт (prompt.ts), стрим через
 *     runChatStream (shared/assist-chat-core) с разделителем действий.
 *     Текст сбрасывается в базу (маскированным) не реже streamFlushMs.
 *  7. После стрима: источники (только S# из промпта), действия (link — URL
 *     только из фрагментов/настроек и хост сайта), пост-фильтр (числа,
 *     стоп-фразы, запрещённые обещания) → флаги; запись в кэш по правилам
 *     §4-тер.7; учёт в site_ai_usage (assist-chat, assist-classify); списание
 *     факта и снятие резерва — тем же экземпляром (finally), иначе — TTL.
 *
 * Уточнения реализации (W3):
 *  - Повтор с тем же clientRequestId, пока ответ ещё `streaming`, НЕ
 *    обрывается на `meta`: этот же поток дочитывает текст из базы опросом
 *    (как маршрут продолжения W2), так что повтор после перезагрузки
 *    получает весь ответ без второго вызова модели.
 *  - Сообщение ответа создаётся ВМЕСТЕ с вопросом (пустым, `streaming`):
 *    пара (conversationId, clientRequestId) у вопроса и `<id>#a` у ответа —
 *    гонка двух одинаковых запросов решается уникальным индексом.
 *  - Вопрос с признаками инъекции (detectInjection, §4-тер.7) — вежливый
 *    отказ без модели; страница и контекст с признаками инъекции в промпт
 *    не идут (prompt.ts); ссылки на чужие хосты вырезаются из стрима
 *    (stream-guard.ts). Защита — в коде, а не в вере в промпт (приёмка п.4).
 *  - Порядок «шаблоны → кэш → резерв денег → прямой FAQ → suspicious →
 *    поиск → квота → модель»: кэш и шаблоны денег не стоят; эмбеддинг
 *    вопроса оплачивается из резерва; диалог засчитывается, только когда
 *    модель действительно будет вызвана (§4.5 уточнение 3).
 *  - Генерация идёт фоновой задачей (EventChannel): разрыв соединения её
 *    не останавливает (§4-бис.4). `AskInput.signal` поэтому не используется.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import {
  WIDGET_DEFAULTS,
  widgetSiteDailyCapMicroUsd,
} from '../../config/assist-defaults';
import { widgetPlatformEnabled } from '../../config/widget-env';
import { AssistPublicDb } from '../../prisma/assist-public-db.service';
import { runChatStream } from '../../shared/assist-chat-core';
import type { ChatUsageSummary } from '../../shared/assist-chat-core';
import { questionLang } from '../assist-knowledge-core/answer/prompt';
import { detectInjection } from '../assist-knowledge-core/injection';
import { semanticCacheKey } from '../assist-knowledge-core/semantic-cache-key';
import type { SearchHit } from '../assist-knowledge-core/types';
import { parsePersona, type PersonaConfig } from '../assist-site-setup/persona';
import { AiUsageRecorder } from '../site-ai/usage-recorder';
import {
  maskForJournal,
  postFilterAnswer,
  resolveCitations,
  validateSiteActions,
} from './answer-checks';
import { chatAvailability } from './availability';
import {
  DialogQuota,
  SiteBudget,
  answerEstimateMicroUsd,
  dialogWeightStep,
  type BudgetReservation,
} from './budget';
import { SiteChatModel } from './chat-model';
import type {
  AnswerPath,
  AskInput,
  SiteAction,
  SiteAnswerSource,
  WidgetChatEvent,
  WidgetStreamErrorCode,
} from './chat-types';
import { EventChannel } from './event-channel';
import {
  buildSitePrompt,
  personaBlock,
  safePageUrl,
  siteFrame,
  summaryBlock,
} from './prompt';
import { readPublishedConfig } from './published-config';
import { PublicSiteSearch } from './public-search';
import { SemanticCache } from './semantic-cache';
import { StreamTextGuard } from './stream-guard';
import {
  TEMPLATE_TEXT,
  answerLangOf,
  leadAction,
  preModelRule,
  type ChatLang,
  type TemplateKind,
} from './templates';
import { insertOnlyUsageDb, recordSiteChatUsage } from './usage';

type Emit = (ev: WidgetChatEvent) => void;

/** clientRequestId — UUID из iframe (или похожий токен), не длиннее 64. */
const CRID = /^[A-Za-z0-9_-]{8,64}$/;
/** Суффикс clientRequestId у сообщения ответа (пара уникальна в диалоге). */
export const ANSWER_CRID_SUFFIX = '#a';
/** Окно «одинаковые вопросы с разных visitorId одного ipHash» (§4.13 п.5). */
const SAME_QUESTION_WINDOW_MS = 10 * 60 * 1000;
const ZERO_USAGE: ChatUsageSummary = { in: 0, out: 0, cached: 0 };

export function answerCrid(crid: string): string {
  return `${crid}${ANSWER_CRID_SUFFIX}`;
}

interface SiteRow {
  enabled: boolean;
  chatPaused: boolean;
  operatorBlockedAt: Date | null;
  widgetVersion: number;
  dailyCapMicroUsd: number | null;
  siteSummary: Prisma.JsonValue | null;
}

interface ConvRow {
  id: string;
  answers: number;
  dialogCounted: boolean;
  lastMessageAt: Date;
}

interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

/** Опубликованная персона: строгий разбор W4; сбой разбора — без персоны (каркас и так первым). */
export function readPersona(raw: unknown): PersonaConfig | null {
  if (raw === null || raw === undefined) return null;
  try {
    const r = parsePersona(raw);
    return r.ok ? r.persona : null;
  } catch {
    return null;
  }
}

@Injectable()
export class SiteChatService {
  private readonly logger = new Logger(SiteChatService.name);
  /** Часы, env, пауза — подменяются тестами. */
  now: () => Date = () => new Date();
  env: NodeJS.ProcessEnv = process.env;
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms));
  random: () => number = Math.random;
  /** Опрос базы при повторе streaming-ответа (§4-бис.4). */
  replayPollMs = 500;
  private readonly inflight = new Set<Promise<void>>();

  constructor(
    private readonly db: AssistPublicDb,
    private readonly search: PublicSiteSearch,
    private readonly budget: SiteBudget,
    private readonly quota: DialogQuota,
    private readonly cache: SemanticCache,
    private readonly model: SiteChatModel,
    private readonly usage: AiUsageRecorder,
  ) {}

  /** Поток событий ответа. Генерация не обрывается при разрыве соединения (§4-бис.4). */
  ask(input: AskInput): AsyncIterable<WidgetChatEvent> {
    const ch = new EventChannel<WidgetChatEvent>();
    const ref: { ctx?: Finish } = {};
    const task = this.run(input, (ev) => ch.push(ev), ref)
      .catch(async (e: unknown) => {
        // Сообщение не должно остаться «streaming» навсегда: продолжение
        // стрима (W2) ждало бы его до таймаута.
        if (ref.ctx) await this.markPartial(ref.ctx).catch(() => undefined);
        // Только класс — без текста (в нём бывают куски SQL/запроса, §6.6).
        this.logger.error(
          `ask: сбой конвейера (site ${input.site.siteId}): ${(e as Error | null)?.name ?? 'Error'}`,
        );
        ch.push({
          type: 'error',
          code: 'upstream',
          message:
            TEMPLATE_TEXT.partial[answerLangOf(input.question, input.uiLang)],
        });
      })
      .finally(() => {
        ch.end();
        this.inflight.delete(task);
      });
    this.inflight.add(task);
    return ch;
  }

  /** Дождаться фоновых генераций (тесты; корректное завершение процесса). */
  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  /** Оценка резерва для этих входных (то же, что использует ask). */
  estimateFor(p: {
    siteName: string;
    persona: PersonaConfig | null;
    siteSummary: unknown;
    history: Turn[];
    question: string;
    answerLang: string;
  }): number {
    const systemChars =
      siteFrame({
        siteName: p.siteName,
        answerLang: p.answerLang,
        knowledgeLang: 'xx',
      }).length +
      personaBlock(p.persona).length +
      summaryBlock(p.siteSummary).length;
    return answerEstimateMicroUsd({
      systemChars,
      historyChars: p.history.reduce(
        (s, t) => s + Math.min(t.content.length, 2_000),
        0,
      ),
      questionChars: p.question.length,
    });
  }

  private async markPartial(ctx: Finish): Promise<void> {
    await this.db.assistSiteMessage.updateMany({
      where: { id: ctx.answerId, streamState: 'streaming' },
      data: { streamState: 'partial' },
    });
  }

  private async run(
    input: AskInput,
    emit: Emit,
    ref: { ctx?: Finish } = {},
  ): Promise<void> {
    const site = input.site;
    const question = (input.question ?? '')
      .trim()
      .slice(0, WIDGET_DEFAULTS.maxQuestionChars);
    const lang = answerLangOf(question, input.uiLang);
    if (!question || !CRID.test(input.clientRequestId ?? '')) {
      emit({ type: 'error', code: 'bad_request', message: 'bad request' });
      return;
    }
    const db = this.db;
    const now = this.now();

    // ── 1. Диалог этого посетителя и идемпотентность ──
    let conv: ConvRow | null = input.conversationId
      ? await db.assistSiteConversation.findFirst({
          where: {
            id: input.conversationId,
            siteId: site.siteId,
            visitorId: input.visitor.visitorId,
          },
          select: {
            id: true,
            answers: true,
            dialogCounted: true,
            lastMessageAt: true,
          },
        })
      : null;
    if (conv) {
      const existing = await this.answerByCrid(conv.id, input.clientRequestId);
      if (existing) return this.replay(conv.id, existing, emit);
    }

    // ── 2. Рубильники и лимиты посетителя ──
    const row = (await db.assistSite.findUnique({
      where: { siteId: site.siteId },
      select: {
        enabled: true,
        chatPaused: true,
        operatorBlockedAt: true,
        widgetVersion: true,
        dailyCapMicroUsd: true,
        siteSummary: true,
      },
    })) as SiteRow | null;
    if (!row) {
      emit({
        type: 'error',
        code: 'disabled',
        message: TEMPLATE_TEXT.disabled[lang],
      });
      return;
    }
    const [dayMessages, sameQuestion] = await Promise.all([
      this.visitorDayMessages(site.siteId, input.visitor.visitorId, now),
      this.sameQuestionOtherVisitors(input, question, now),
    ]);
    const avail = chatAvailability({
      platformEnabled: widgetPlatformEnabled(this.env),
      site: {
        enabled: row.enabled,
        chatPaused: row.chatPaused,
        operatorBlockedAt: row.operatorBlockedAt,
        // Предпросмотр конфигуратора работает и до первой публикации вида.
        widgetVersion: site.preview
          ? Math.max(1, row.widgetVersion)
          : row.widgetVersion,
      },
      visitor: {
        sessionMessages: input.visitor.sessionMessages,
        dayMessages,
        tokenAgeMs: now.getTime() - input.visitor.tokenIssuedAt.getTime(),
      },
      sameQuestionOtherVisitors: sameQuestion,
      random: this.random,
    });

    // ── 3. Диалог и сообщения (вопрос — маскированным) ──
    const hosts = await this.siteHosts(site.siteId, site.parentOrigin);
    const history = conv ? await this.history(conv.id) : [];
    if (
      conv &&
      now.getTime() - conv.lastMessageAt.getTime() >
        WIDGET_DEFAULTS.dialogIdleMs
    ) {
      // 30 мин тишины — новый диалог для квоты (§7.1).
      await db.assistSiteConversation.update({
        where: { id: conv.id },
        data: { answers: 0, dialogCounted: false },
        select: { id: true },
      });
      conv = { ...conv, answers: 0, dialogCounted: false };
    }
    if (!conv) {
      conv = await db.assistSiteConversation.create({
        data: {
          accountId: site.accountId,
          siteId: site.siteId,
          visitorId: input.visitor.visitorId,
          ipHash: input.visitor.ipHash,
          parentOrigin: site.parentOrigin,
          pageUrl: safePageUrl(input.page.url, hosts),
          locale: input.uiLang?.slice(0, 8) ?? null,
          suspicious: avail.ok ? avail.suspicious : false,
          lastMessageAt: now,
        },
        select: {
          id: true,
          answers: true,
          dialogCounted: true,
          lastMessageAt: true,
        },
      });
    }
    const convId = conv.id;
    const answerId = randomUUID();
    try {
      await db.assistSiteMessage.createMany({
        data: [
          {
            id: randomUUID(),
            accountId: site.accountId,
            siteId: site.siteId,
            conversationId: convId,
            role: 'visitor',
            text: maskForJournal(question),
            clientRequestId: input.clientRequestId,
            streamState: 'complete',
            createdAt: now,
          },
          {
            id: answerId,
            accountId: site.accountId,
            siteId: site.siteId,
            conversationId: convId,
            role: 'assistant',
            text: '',
            clientRequestId: answerCrid(input.clientRequestId),
            streamState: 'streaming',
            createdAt: new Date(now.getTime() + 1),
          },
        ],
      });
    } catch (e) {
      // Тот же clientRequestId параллельно (двойной клик) — повтор, не второй ответ.
      if ((e as { code?: string }).code === 'P2002') {
        const existing = await this.answerByCrid(convId, input.clientRequestId);
        if (existing) return this.replay(convId, existing, emit);
      }
      throw e;
    }
    await this.touch(convId, now);
    emit({
      type: 'meta',
      conversationId: convId,
      messageId: answerId,
      replay: false,
    });

    const ctx: Finish = {
      convId,
      answerId,
      emit,
      lang,
      started: now.getTime(),
    };
    ref.ctx = ctx;

    if (!avail.ok) {
      if (avail.reason === 'visitor_limit') {
        return this.finishStatic(ctx, {
          kind: 'visitor_limit',
          path: 'template',
          state: 'refused',
          error: 'rate_limited',
        });
      }
      return this.finishStatic(ctx, {
        kind: 'disabled',
        path: 'template',
        lead: true,
      });
    }

    // ── 4. Правила без модели ──
    const rule = preModelRule(question);
    if (rule === 'greeting' || rule === 'thanks') {
      return this.finishStatic(ctx, { kind: rule, path: 'template' });
    }
    if (rule === 'handoff') {
      // Э2: «позвать человека» = форма лида (контракт §1 п.12).
      await this.setOutcome(convId, 'handoff');
      return this.finishStatic(ctx, {
        kind: 'handoff',
        path: 'template',
        lead: true,
      });
    }
    if (detectInjection(question).quarantine) {
      return this.finishStatic(ctx, {
        kind: 'injection',
        path: 'refusal',
        flags: ['injection_suspect'],
      });
    }
    const firstMessage = !history.some((t) => t.role === 'user');
    // Контекст страницы (`V4CAssist('context')`) меняет ответ — такой вопрос
    // не берётся из кэша и не кладётся в него (ключ кэша о контексте не знает).
    const hasContext = !!input.context && Object.keys(input.context).length > 0;
    const cacheKey =
      site.knowledgeVersion > 0 && !hasContext
        ? semanticCacheKey({
            siteId: site.siteId,
            mode: 'site',
            knowledgeVersion: site.knowledgeVersion,
            configVersion: site.configVersion,
            question,
          })
        : null;
    if (cacheKey && firstMessage) {
      const cached = await this.cache.get({
        siteId: site.siteId,
        key: cacheKey,
      });
      if (cached) {
        return this.finishAnswer(ctx, {
          text: cached.text,
          sources: cached.sources,
          actions: cached.actions,
          path: 'cache',
          cacheKey,
          flags: [],
        });
      }
    }
    if (avail.slowdownMs > 0) await this.sleep(avail.slowdownMs);

    // ── 5. Деньги (резерв с TTL) ──
    const persona = await this.persona(site.siteId, site.configVersion);
    const siteName = await this.siteName(site.siteId);
    const est = this.estimateFor({
      siteName,
      persona,
      siteSummary: row.siteSummary,
      history,
      question,
      answerLang: lang,
    });
    const reserved = await this.budget.reserve(db, {
      siteId: site.siteId,
      siteCapMicroUsd: widgetSiteDailyCapMicroUsd(row),
      estMicroUsd: est,
      now,
    });
    if (!reserved.ok) {
      const code =
        reserved.denied === 'site_budget' ? 'site_quota' : 'platform_budget';
      this.logger.warn(`ask: ${code} (site ${site.siteId})`);
      return this.finishStatic(ctx, {
        kind: code,
        path: 'refusal',
        state: 'refused',
        lead: true,
        error: code,
      });
    }
    let actual = 0;
    try {
      // ── 6. Прямой FAQ, suspicious, поиск, квота, модель ──
      const qLang = questionLang(question, null);
      const emb = await this.search.embedQuestion(site, question);
      actual += emb.costMicroUsd;
      const faq = await this.search.findDirectFaq(
        site,
        question,
        qLang,
        emb.vector,
      );
      if (faq) {
        return await this.finishAnswer(ctx, {
          text: faq.answer,
          sources: [],
          actions: [],
          path: 'faq',
          cacheKey: null,
          flags: [],
        });
      }
      if (avail.suspicious) {
        await this.markSuspicious(convId);
        return await this.finishStatic(ctx, {
          kind: 'suspicious',
          path: 'refusal',
          lead: true,
        });
      }
      const found = await this.search.search(site, question, {
        vector: emb.vector,
      });
      actual += found.costMicroUsd;
      if (!found.hits.length) {
        return await this.finishStatic(ctx, {
          kind: 'no_knowledge',
          path: 'refusal',
          lead: true,
        });
      }
      if (
        !site.preview &&
        !(await this.claimDialog(site.siteId, site.accountId, convId, now))
      ) {
        this.logger.warn(`ask: site_quota (диалоги, site ${site.siteId})`);
        return await this.finishStatic(ctx, {
          kind: 'site_quota',
          path: 'refusal',
          state: 'refused',
          lead: true,
          error: 'site_quota',
        });
      }
      actual += await this.generate(ctx, {
        input,
        question,
        lang,
        persona,
        siteName,
        siteSummary: row.siteSummary,
        hits: found.hits,
        knowledgeLang: found.knowledgeLang,
        history,
        hosts,
        cacheKey: firstMessage ? cacheKey : null,
        firstMessage,
        suspicious: avail.suspicious,
      });
    } finally {
      await this.budget.settle(
        db,
        reserved.reservation as BudgetReservation,
        actual,
      );
    }
  }

  // ── Модель ─────────────────────────────────────────────────────────────

  private async generate(
    ctx: Finish,
    p: {
      input: AskInput;
      question: string;
      lang: ChatLang;
      persona: PersonaConfig | null;
      siteName: string;
      siteSummary: unknown;
      hits: SearchHit[];
      knowledgeLang: string | null;
      history: Turn[];
      hosts: string[];
      cacheKey: string | null;
      firstMessage: boolean;
      suspicious: boolean;
    },
  ): Promise<number> {
    const site = p.input.site;
    const prompt = buildSitePrompt({
      siteName: p.siteName,
      persona: p.persona,
      siteSummary: p.siteSummary,
      hits: p.hits,
      page: p.input.page,
      context: p.input.context,
      history: p.history,
      question: p.question,
      answerLang: p.lang,
      knowledgeLang: p.knowledgeLang,
      allowedLinkHosts: p.hosts,
    });
    const siteHosts = new Set(p.hosts);
    const linkUrls = new Set<string>([
      ...p.hits.map((h) => h.url).filter((u): u is string => !!u),
      ...p.hosts.map((h) => `https://${h}/`),
    ]);
    const guard = new StreamTextGuard({
      siteHosts,
      sourceNumbers: new Set(prompt.sourceMap.keys()),
    });
    const stream = runChatStream<SiteAction, WidgetStreamErrorCode>({
      openStream: (signal) =>
        this.model.openStream(
          {
            system: prompt.system,
            contents: prompt.contents,
            maxOutputTokens: WIDGET_DEFAULTS.maxOutputTokens,
          },
          signal,
        ),
      timeouts: {
        firstTokenMs: Math.min(30_000, WIDGET_DEFAULTS.answerTimeoutMs),
        totalMs: WIDGET_DEFAULTS.answerTimeoutMs,
      },
      resolveActions: async (raw) =>
        validateSiteActions(raw, { linkUrls, siteHosts }),
      upstreamError: (e) => {
        this.logger.warn(
          `ask: модель недоступна (site ${site.siteId}, msg ${ctx.answerId}): ${(e as Error | null)?.name ?? 'Error'}`,
        );
        return { code: 'upstream', message: TEMPLATE_TEXT.partial[ctx.lang] };
      },
    });

    let actions: SiteAction[] = [];
    let failed: { code: WidgetStreamErrorCode; message: string } | null = null;
    let lastFlush = Date.now();
    let flushed = 0;
    const flush = async (force = false) => {
      const text = maskForJournal(guard.text);
      if (
        !force &&
        (Date.now() - lastFlush < WIDGET_DEFAULTS.streamFlushMs ||
          text.length === flushed)
      ) {
        return;
      }
      lastFlush = Date.now();
      flushed = text.length;
      await this.db.assistSiteMessage.update({
        where: { id: ctx.answerId },
        data: { text, streamOffset: text.length },
        select: { id: true },
      });
    };
    const emitTail = () => {
      const t = guard.flush();
      if (t) ctx.emit({ type: 'token', t });
    };
    let outcome: Awaited<ReturnType<typeof stream.next>>;
    for (;;) {
      outcome = await stream.next();
      if (outcome.done) break;
      const ev = outcome.value;
      if (ev.type === 'token') {
        const safe = guard.push(ev.t);
        if (safe) ctx.emit({ type: 'token', t: safe });
        await flush();
      } else if (ev.type === 'actions') {
        actions = ev.items;
      } else if (ev.type === 'error') {
        failed = { code: ev.code, message: ev.message };
      }
    }
    emitTail();
    const result = outcome.value;
    const usage = result.usageMeta;
    const units = {
      inputTokens: usage?.promptTokenCount ?? 0,
      cachedInputTokens: usage?.cachedContentTokenCount ?? 0,
      outputTokens:
        (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
    };
    const cost =
      units.inputTokens || units.outputTokens
        ? await recordSiteChatUsage(this.usage, insertOnlyUsageDb(this.db), {
            accountId: site.accountId,
            siteId: site.siteId,
            operation: 'assist-chat',
            model: this.model.model,
            units,
          })
        : 0;
    const latencyMs = Date.now() - ctx.started;

    if (failed || !result.ok) {
      await this.db.assistSiteMessage.update({
        where: { id: ctx.answerId },
        data: {
          text: maskForJournal(guard.text),
          streamOffset: maskForJournal(guard.text).length,
          streamState: 'partial',
          answerPath: 'model',
          inTokens: units.inputTokens,
          outTokens: units.outputTokens,
          cachedTokens: units.cachedInputTokens,
          costMicroUsd: cost,
          model: this.model.model,
          latencyMs,
        },
        select: { id: true },
      });
      await this.touch(ctx.convId, this.now());
      ctx.emit({
        type: 'error',
        code: failed?.code ?? 'upstream',
        message: failed?.message ?? TEMPLATE_TEXT.partial[ctx.lang],
      });
      return cost;
    }

    const { text, sources } = resolveCitations(guard.text, prompt.sourceMap);
    const cited = sources
      .map((s) => prompt.sourceMap.get(s.n))
      .filter((h): h is SearchHit => !!h);
    const flags = postFilterAnswer({
      text,
      question: p.question,
      cited,
      stopPhrases: p.persona?.stopPhrases ?? [],
      siteHosts,
    });
    // Без источника — фактически «не знаю»: даём форму заявки (К-1).
    if (!sources.length && !actions.some((a) => a.kind === 'lead')) {
      actions = [...actions, leadAction(ctx.lang)].slice(
        0,
        WIDGET_DEFAULTS.maxActions,
      );
    }
    let storedCacheKey: string | null = null;
    if (p.cacheKey) {
      const put = await this.cache.put({
        siteId: site.siteId,
        key: p.cacheKey,
        question: p.question,
        answer: { text, sources, actions, lang: ctx.lang },
        knowledgeVersion: site.knowledgeVersion,
        configVersion: site.configVersion,
        firstMessage: p.firstMessage,
        flags,
        suspicious: p.suspicious,
      });
      if (put) storedCacheKey = p.cacheKey;
    }
    if (sources.length) ctx.emit({ type: 'sources', items: sources });
    if (actions.length) ctx.emit({ type: 'actions', items: actions });
    const masked = maskForJournal(text);
    await this.db.assistSiteMessage.update({
      where: { id: ctx.answerId },
      data: {
        text: masked,
        streamOffset: masked.length,
        streamState: 'complete',
        sources: sources as unknown as Prisma.InputJsonValue,
        actions: actions as unknown as Prisma.InputJsonValue,
        flags,
        answerPath: 'model',
        cacheKey: storedCacheKey,
        inTokens: units.inputTokens,
        outTokens: units.outputTokens,
        cachedTokens: units.cachedInputTokens,
        costMicroUsd: cost,
        model: this.model.model,
        latencyMs,
      },
      select: { id: true },
    });
    await this.db.assistSiteConversation.update({
      where: { id: ctx.convId },
      data: {
        stateVersion: { increment: 1 },
        lastMessageAt: this.now(),
        ...(flags.length ? { flagged: true } : {}),
      },
      select: { id: true },
    });
    ctx.emit({
      type: 'done',
      usage: {
        in: units.inputTokens,
        out: units.outputTokens,
        cached: units.cachedInputTokens,
      },
    });
    return cost;
  }

  // ── Ответы без модели ──────────────────────────────────────────────────

  private async finishStatic(
    ctx: Finish,
    p: {
      kind: TemplateKind;
      path: AnswerPath;
      lead?: boolean;
      flags?: string[];
      state?: 'complete' | 'refused';
      error?: WidgetStreamErrorCode;
    },
  ): Promise<void> {
    const text = TEMPLATE_TEXT[p.kind][ctx.lang];
    const actions = p.lead ? [leadAction(ctx.lang)] : [];
    if (!p.error) {
      return this.finishAnswer(ctx, {
        text,
        sources: [],
        actions,
        path: p.path,
        cacheKey: null,
        flags: p.flags ?? [],
        state: p.state,
      });
    }
    await this.storeFinal(ctx, {
      text,
      sources: [],
      actions,
      path: p.path,
      cacheKey: null,
      flags: p.flags ?? [],
      state: p.state ?? 'refused',
    });
    if (actions.length) ctx.emit({ type: 'actions', items: actions });
    ctx.emit({ type: 'error', code: p.error, message: text });
  }

  private async finishAnswer(
    ctx: Finish,
    a: {
      text: string;
      sources: SiteAnswerSource[];
      actions: SiteAction[];
      path: AnswerPath;
      cacheKey: string | null;
      flags: string[];
      state?: 'complete' | 'refused';
    },
  ): Promise<void> {
    await this.storeFinal(ctx, { ...a, state: a.state ?? 'complete' });
    ctx.emit({ type: 'token', t: a.text });
    if (a.sources.length) ctx.emit({ type: 'sources', items: a.sources });
    if (a.actions.length) ctx.emit({ type: 'actions', items: a.actions });
    ctx.emit({ type: 'done', usage: ZERO_USAGE });
  }

  private async storeFinal(
    ctx: Finish,
    a: {
      text: string;
      sources: SiteAnswerSource[];
      actions: SiteAction[];
      path: AnswerPath;
      cacheKey: string | null;
      flags: string[];
      state: 'complete' | 'refused';
    },
  ): Promise<void> {
    const masked = maskForJournal(a.text);
    await this.db.assistSiteMessage.update({
      where: { id: ctx.answerId },
      data: {
        text: masked,
        streamOffset: masked.length,
        streamState: a.state,
        sources: a.sources as unknown as Prisma.InputJsonValue,
        actions: a.actions as unknown as Prisma.InputJsonValue,
        flags: a.flags,
        answerPath: a.path,
        cacheKey: a.cacheKey,
        latencyMs: Date.now() - ctx.started,
      },
      select: { id: true },
    });
    await this.touch(ctx.convId, this.now());
  }

  // ── Повтор (идемпотентность, §4-бис.4) ────────────────────────────────

  private async answerByCrid(
    convId: string,
    crid: string,
  ): Promise<{ id: string } | null> {
    return this.db.assistSiteMessage.findFirst({
      where: { conversationId: convId, clientRequestId: answerCrid(crid) },
      select: { id: true },
    });
  }

  private async replay(
    convId: string,
    msg: { id: string },
    emit: Emit,
  ): Promise<void> {
    emit({
      type: 'meta',
      conversationId: convId,
      messageId: msg.id,
      replay: true,
    });
    let offset = 0;
    const deadline = Date.now() + WIDGET_DEFAULTS.answerTimeoutMs + 30_000;
    for (;;) {
      const m = await this.db.assistSiteMessage.findUnique({
        where: { id: msg.id },
        select: { text: true, streamState: true, sources: true, actions: true },
      });
      if (!m) {
        emit({ type: 'error', code: 'bad_request', message: 'not found' });
        return;
      }
      if (m.text.length > offset) {
        emit({ type: 'token', t: m.text.slice(offset) });
        offset = m.text.length;
      }
      if (m.streamState !== 'streaming') {
        const sources = Array.isArray(m.sources)
          ? (m.sources as unknown as SiteAnswerSource[])
          : [];
        const actions = Array.isArray(m.actions)
          ? (m.actions as unknown as SiteAction[])
          : [];
        if (sources.length) emit({ type: 'sources', items: sources });
        if (actions.length) emit({ type: 'actions', items: actions });
        if (m.streamState === 'partial') {
          emit({ type: 'error', code: 'upstream', message: 'partial' });
        } else {
          emit({ type: 'done', usage: ZERO_USAGE });
        }
        return;
      }
      if (Date.now() > deadline) {
        emit({ type: 'error', code: 'upstream', message: 'timeout' });
        return;
      }
      await this.sleep(this.replayPollMs);
    }
  }

  // ── Квота диалогов (§4.5 уточнение 3) ─────────────────────────────────

  /**
   * Засчитать ответ модели: первый в диалоге — диалог в квоту (одним
   * условным UPDATE флага: два параллельных вопроса одного диалога не
   * засчитают его дважды), 31-й и 61-й — ещё по единице (§7.1).
   */
  private async claimDialog(
    siteId: string,
    accountId: string,
    convId: string,
    now: Date,
  ): Promise<boolean> {
    const db = this.db;
    const won = await db.$queryRawUnsafe<Array<{ id: string }>>(
      `UPDATE "sites"."assist_site_conversations" SET "dialogCounted" = true
        WHERE "id" = $1 AND NOT "dialogCounted" RETURNING "id"`,
      convId,
    );
    const counted = await db.$queryRawUnsafe<Array<{ answers: number }>>(
      `UPDATE "sites"."assist_site_conversations" SET "answers" = "answers" + 1
        WHERE "id" = $1 RETURNING "answers"`,
      convId,
    );
    const n = counted[0]?.answers ?? 1;
    const weight = won.length ? 1 : dialogWeightStep(n) && n > 1 ? 1 : 0;
    if (!weight) return true;
    const ok = await this.quota.claim(db, { siteId, accountId, weight, now });
    if (!ok) {
      await db.$executeRawUnsafe(
        `UPDATE "sites"."assist_site_conversations"
            SET "answers" = GREATEST(0, "answers" - 1)${won.length ? ', "dialogCounted" = false' : ''}
          WHERE "id" = $1`,
        convId,
      );
    }
    return ok;
  }

  // ── Чтение контекста (всё — под assist_public) ─────────────────────────

  private async persona(
    siteId: string,
    configVersion: number,
  ): Promise<PersonaConfig | null> {
    // Сырой SQL (колоночный GRANT без id) — общий читатель W2/W3.
    return readPersona(
      await readPublishedConfig(this.db, siteId, 'persona', configVersion),
    );
  }

  private async siteName(siteId: string): Promise<string> {
    const s = await this.db.site.findUnique({
      where: { id: siteId },
      select: { name: true },
    });
    return s?.name ?? '';
  }

  /** Подтверждённые хосты сайта (+ origin родителя, уже проверенный гвардом W2). */
  private async siteHosts(
    siteId: string,
    parentOrigin: string,
  ): Promise<string[]> {
    const rows = await this.db.siteHost.findMany({
      where: { siteId, status: 'verified' },
      select: { host: true },
    });
    const out = new Set(rows.map((r) => r.host.toLowerCase()));
    try {
      out.add(new URL(parentOrigin).hostname.toLowerCase());
    } catch {
      /* origin уже проверен гвардом; мусор — просто без него */
    }
    return [...out];
  }

  /** Последние реплики СВОЕГО диалога (маскированные) — история промпта (§4.13 п.4). */
  private async history(convId: string): Promise<Turn[]> {
    const rows = await this.db.assistSiteMessage.findMany({
      where: {
        conversationId: convId,
        role: { in: ['visitor', 'assistant'] },
        streamState: 'complete',
        text: { not: '' },
      },
      orderBy: { createdAt: 'desc' },
      take: WIDGET_DEFAULTS.historyTurns,
      select: { role: true, text: true },
    });
    return rows.reverse().map((r) => ({
      role: r.role === 'visitor' ? 'user' : 'assistant',
      content: r.text,
    }));
  }

  private async visitorDayMessages(
    siteId: string,
    visitorId: string,
    now: Date,
  ): Promise<number> {
    const rows = await this.db.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*) AS n FROM "sites"."assist_site_messages" m
         JOIN "sites"."assist_site_conversations" c ON c."id" = m."conversationId"
        WHERE c."siteId" = $1 AND c."visitorId" = $2 AND m."role" = 'visitor'
          AND m."createdAt" > $3`,
      siteId,
      visitorId,
      new Date(now.getTime() - 86_400_000),
    );
    return Number(rows[0]?.n ?? 0);
  }

  /** Тот же (маскированный, нормализованный) вопрос с ДРУГИХ visitorId этого ipHash (§4.13 п.5). */
  private async sameQuestionOtherVisitors(
    input: AskInput,
    question: string,
    now: Date,
  ): Promise<number> {
    const rows = await this.db.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(DISTINCT c."visitorId") AS n FROM "sites"."assist_site_messages" m
         JOIN "sites"."assist_site_conversations" c ON c."id" = m."conversationId"
        WHERE c."siteId" = $1 AND c."ipHash" = $2 AND c."visitorId" <> $3
          AND m."role" = 'visitor' AND m."createdAt" > $4
          AND lower(btrim(m."text")) = lower(btrim($5))`,
      input.site.siteId,
      input.visitor.ipHash,
      input.visitor.visitorId,
      new Date(now.getTime() - SAME_QUESTION_WINDOW_MS),
      maskForJournal(question),
    );
    return Number(rows[0]?.n ?? 0);
  }

  private async touch(convId: string, at: Date): Promise<void> {
    await this.db.assistSiteConversation.update({
      where: { id: convId },
      data: { lastMessageAt: at, stateVersion: { increment: 1 } },
      select: { id: true },
    });
  }

  private async setOutcome(convId: string, outcome: string): Promise<void> {
    await this.db.assistSiteConversation.update({
      where: { id: convId },
      data: { outcome },
      select: { id: true },
    });
  }

  private async markSuspicious(convId: string): Promise<void> {
    await this.db.assistSiteConversation.update({
      where: { id: convId },
      data: { suspicious: true },
      select: { id: true },
    });
  }
}

interface Finish {
  convId: string;
  answerId: string;
  emit: Emit;
  lang: ChatLang;
  started: number;
}
