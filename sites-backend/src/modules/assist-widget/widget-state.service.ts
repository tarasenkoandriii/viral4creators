/**
 * Состояние посетителя (ТЗ §4-бис.2, §4-бис.4, §4-бис.9, §6.3) — W2:
 * `GET state` (диалог < 7 дней, stateVersion для `since`), продолжение
 * стрима (опрос/длинный опрос БД — общей памяти у экземпляров нет),
 * 👍/👎 (👎 на ответ из кэша → SemanticCache.evict, W3), `forget`
 * (все диалоги ЭТОГО visitorId на ЭТОМ сайте + указатели; лиды остаются
 * без ссылки — FK SET NULL). Чужой messageId/conversationId → NOT_FOUND
 * (а не 403: не подтверждаем существование).
 *
 * Каждый запрос фильтрует по (siteId, visitorId) из ПРОВЕРЕННОГО токена —
 * id из URL сам по себе ничего не открывает (§6.4, §4-бис.10 п.9).
 *
 * Э3 (W): `state` несёт последнюю передачу человеку диалога
 * (`HandoffIntake.visitorView`, H) — iframe опрашивает раз в 3 с, пока она
 * waiting/active (решение 3); 👎 на ответ → сигнал очереди обучения
 * (`LearningSignals.record`, L: `wrong`, а у отказа/шаблона — `unhappy`);
 * `forget` → `ForgetJobs.enqueue` ДО удаления диалогов (хвост — дословные
 * варианты проверенных ответов, L) и отвязка `visitorId` у лидов
 * (ограничение Э2 «к Э3»: лид остаётся владельцу, но уже не связан с
 * посетителем).
 */
import { Injectable, Logger } from '@nestjs/common';
import { WIDGET_DEFAULTS } from '../../config/assist-defaults';
import { AssistPublicDb } from '../../prisma/assist-public-db.service';
import type {
  SiteAction,
  SiteAnswerSource,
} from '../assist-site-chat/chat-types';
import { SemanticCache } from '../assist-site-chat/semantic-cache';
import { HandoffIntake } from '../assist-site-handoff/public/handoff-intake.service';
import { ForgetJobs } from '../assist-site-learning/public/forget-jobs';
import { LearningSignals } from '../assist-site-learning/public/learning-signals';
import { maskForJournal } from '../assist-site-chat/answer-checks';
import type {
  WidgetForgetResponse,
  WidgetMessageView,
  WidgetStateView,
  WidgetStreamChunk,
} from './api-types';
import type { VisitorContext } from './widget-session.service';
import { widgetError } from './widget-errors';

/** Сколько последних сообщений диалога отдаёт `state` (лента iframe). */
export const STATE_MAX_MESSAGES = 100;
/** Длинный опрос продолжения стрима — не дольше (контракт api-types). */
export const STREAM_POLL_MAX_MS = 8_000;
const STREAM_POLL_STEP_MS = 250;

const STREAM_STATES = ['streaming', 'complete', 'partial', 'refused'] as const;
type StreamState = WidgetMessageView['streamState'];
const ROLES = ['visitor', 'assistant', 'operator', 'system'] as const;

const MESSAGE_SELECT = {
  id: true,
  role: true,
  text: true,
  sources: true,
  actions: true,
  streamState: true,
  rating: true,
  createdAt: true,
} as const;

function streamStateOf(v: string): StreamState {
  return (STREAM_STATES as readonly string[]).includes(v)
    ? (v as StreamState)
    : 'complete';
}

/** Источники из JSON базы — только форма {n, url, title}; прочее — мимо. */
export function sourcesOf(v: unknown): SiteAnswerSource[] {
  if (!Array.isArray(v)) return [];
  const out: SiteAnswerSource[] = [];
  for (const s of v) {
    if (!s || typeof s !== 'object') continue;
    const o = s as Record<string, unknown>;
    if (!Number.isInteger(o.n)) continue;
    out.push({
      n: o.n as number,
      url: typeof o.url === 'string' ? o.url : null,
      title: typeof o.title === 'string' ? o.title : null,
    });
  }
  return out;
}

/** Действия из JSON базы — только проверенные виды §4.9 (W3 их и пишет). */
export function actionsOf(v: unknown): SiteAction[] {
  if (!Array.isArray(v)) return [];
  const out: SiteAction[] = [];
  for (const a of v) {
    if (!a || typeof a !== 'object') continue;
    const o = a as Record<string, unknown>;
    if (typeof o.label !== 'string') continue;
    if (o.kind === 'link' && typeof o.url === 'string') {
      out.push({ kind: 'link', label: o.label, url: o.url });
    } else if (o.kind === 'lead' || o.kind === 'handoff') {
      out.push({ kind: o.kind, label: o.label });
    }
  }
  return out;
}

function toView(m: {
  id: string;
  role: string;
  text: string;
  sources: unknown;
  actions: unknown;
  streamState: string;
  rating: number | null;
  createdAt: Date;
}): WidgetMessageView {
  return {
    id: m.id,
    role: (ROLES as readonly string[]).includes(m.role)
      ? (m.role as WidgetMessageView['role'])
      : 'system',
    text: m.text,
    sources: sourcesOf(m.sources),
    actions: actionsOf(m.actions),
    streamState: streamStateOf(m.streamState),
    rating: m.rating === 1 || m.rating === -1 ? m.rating : null,
    createdAt: m.createdAt.toISOString(),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Injectable()
export class WidgetStateService {
  private readonly logger = new Logger(WidgetStateService.name);
  /** Длинный опрос: потолок ожидания и шаг (тесты укорачивают). */
  pollMaxMs = STREAM_POLL_MAX_MS;
  pollStepMs = STREAM_POLL_STEP_MS;

  constructor(
    private readonly db: AssistPublicDb,
    private readonly cache: SemanticCache,
    private readonly handoff: HandoffIntake,
    private readonly signals: LearningSignals,
    private readonly forgetJobs: ForgetJobs,
  ) {}

  async state(
    ctx: VisitorContext,
    since: number | null,
    now: Date = new Date(),
  ): Promise<WidgetStateView> {
    const last = await this.db.assistSiteConversation.findFirst({
      where: { siteId: ctx.site.siteId, visitorId: ctx.visitor.visitorId },
      orderBy: { lastMessageAt: 'desc' },
      select: { id: true, stateVersion: true, lastMessageAt: true },
    });
    if (!last) return { conversation: null, previousConversationId: null };
    // Старше 7 дней — чистое приветствие и ссылка «предыдущий разговор»
    // (§4-бис.1 «возврат через день»).
    if (
      now.getTime() - last.lastMessageAt.getTime() >
      WIDGET_DEFAULTS.resumeDialogMaxAgeMs
    ) {
      return { conversation: null, previousConversationId: last.id };
    }
    const unchanged = since !== null && since === last.stateVersion;
    const rows = unchanged
      ? []
      : await this.db.assistSiteMessage.findMany({
          where: { conversationId: last.id, siteId: ctx.site.siteId },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: STATE_MAX_MESSAGES,
          select: MESSAGE_SELECT,
        });
    rows.reverse();
    const streaming = await this.db.assistSiteMessage.findFirst({
      where: {
        conversationId: last.id,
        siteId: ctx.site.siteId,
        streamState: 'streaming',
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    // Передача — всегда (и при совпавшем since): «Взять» оператора может не
    // менять stateVersion, а iframe по ней решает, опрашивать ли дальше.
    const handoff = await this.handoff.visitorView(
      ctx.site,
      ctx.visitor,
      last.id,
    );
    return {
      conversation: {
        id: last.id,
        stateVersion: last.stateVersion,
        messages: rows.map(toView),
        streamingMessageId: streaming?.id ?? null,
        lastMessageAt: last.lastMessageAt.toISOString(),
        handoff,
      },
      previousConversationId: null,
    };
  }

  /** Сообщение этого посетителя на этом сайте — или null (чужое = нет). */
  private ownMessage(ctx: VisitorContext, messageId: string) {
    if (typeof messageId !== 'string' || messageId.length > 64) {
      return Promise.resolve(null);
    }
    return this.db.assistSiteMessage.findFirst({
      where: {
        id: messageId,
        siteId: ctx.site.siteId,
        conversation: { visitorId: ctx.visitor.visitorId },
      },
      select: {
        id: true,
        role: true,
        text: true,
        sources: true,
        actions: true,
        streamState: true,
        streamOffset: true,
        answerPath: true,
        cacheKey: true,
        conversationId: true,
        createdAt: true,
        lang: true,
      },
    });
  }

  /**
   * Продолжение стрима с позиции `from` (§4-бис.4). Пока ответ пишется и
   * нового текста нет — ждём (опрос БД), но не дольше pollMaxMs: функция
   * не должна висеть, iframe переспросит.
   */
  async streamChunk(
    ctx: VisitorContext,
    messageId: string,
    from: number,
  ): Promise<WidgetStreamChunk> {
    const start = Number.isSafeInteger(from) && from > 0 ? from : 0;
    const deadline = Date.now() + this.pollMaxMs;
    let m = await this.ownMessage(ctx, messageId);
    if (!m) throw widgetError('NOT_FOUND');
    while (
      m.streamState === 'streaming' &&
      m.text.length <= start &&
      Date.now() + this.pollStepMs <= deadline
    ) {
      await sleep(this.pollStepMs);
      m = await this.ownMessage(ctx, messageId);
      if (!m) throw widgetError('NOT_FOUND');
    }
    const offset = Math.min(start, m.text.length);
    const text = m.text.slice(offset);
    return {
      messageId: m.id,
      text,
      offset: offset + text.length,
      streamState: streamStateOf(m.streamState),
      sources: sourcesOf(m.sources),
      actions: actionsOf(m.actions),
    };
  }

  /** Диалог принадлежит этому посетителю на этом сайте. */
  async ownsConversation(
    ctx: VisitorContext,
    conversationId: string,
  ): Promise<boolean> {
    if (conversationId.length > 64) return false;
    const n = await this.db.assistSiteConversation.count({
      where: {
        id: conversationId,
        siteId: ctx.site.siteId,
        visitorId: ctx.visitor.visitorId,
      },
    });
    return n === 1;
  }

  /** Текущий вид сообщения (для JSON-ответа чата и дочитывания стрима). */
  async message(
    ctx: VisitorContext,
    messageId: string,
  ): Promise<(WidgetMessageView & { streamOffset: number }) | null> {
    const m = await this.ownMessage(ctx, messageId);
    if (!m) return null;
    return {
      ...toView({ ...m, rating: null, createdAt: new Date(0) }),
      streamOffset: m.streamOffset,
    };
  }

  async feedback(
    ctx: VisitorContext,
    messageId: string,
    rating: 1 | -1,
  ): Promise<{ ok: true }> {
    const m = await this.ownMessage(ctx, messageId);
    if (!m || m.role !== 'assistant') throw widgetError('NOT_FOUND');
    await this.db.assistSiteMessage.updateMany({
      where: { id: m.id, siteId: ctx.site.siteId },
      data: { rating },
    });
    await this.db.assistSiteConversation.updateMany({
      where: {
        id: m.conversationId,
        siteId: ctx.site.siteId,
        visitorId: ctx.visitor.visitorId,
      },
      data: { stateVersion: { increment: 1 } },
    });
    // 👎 на ответ из кэша — запись кэша удаляется (§4-тер.7, §4-тер.15 п.8).
    if (rating === -1 && m.answerPath === 'cache' && m.cacheKey) {
      await this.cache.evict({ siteId: ctx.site.siteId, key: m.cacheKey });
    }
    if (rating === -1) await this.thumbsDown(ctx, m);
    this.logger.log(
      `feedback site=${ctx.site.siteId} msg=${m.id} rating=${rating}`,
    );
    return { ok: true };
  }

  /**
   * 👎 → сигнал очереди обучения (L). Тексты уже маскированы конвейером
   * (журнал Э2); `maskForJournal` ещё раз — дешёвый второй замок: строку с
   * контактом L отвергнет целиком. Сбой сигнала не роняет оценку (в лог —
   * только id и имя ошибки).
   */
  private async thumbsDown(
    ctx: VisitorContext,
    m: {
      id: string;
      text: string;
      answerPath: string | null;
      conversationId: string;
      createdAt: Date;
      lang: string | null;
    },
  ): Promise<void> {
    try {
      const [question, conv] = await Promise.all([
        this.db.assistSiteMessage.findFirst({
          where: {
            conversationId: m.conversationId,
            siteId: ctx.site.siteId,
            role: 'visitor',
            createdAt: { lte: m.createdAt },
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { text: true, lang: true },
        }),
        this.db.assistSiteConversation.findFirst({
          where: { id: m.conversationId, siteId: ctx.site.siteId },
          select: { suspicious: true },
        }),
      ]);
      if (!question || !question.text.trim()) return;
      await this.signals.record({
        accountId: ctx.site.accountId,
        siteId: ctx.site.siteId,
        // Отказ/шаблон помощник и не утверждал — посетитель недоволен
        // (unhappy); ответ по знаниям/кэшу/модели — «неверно» (wrong).
        kind:
          m.answerPath === 'refusal' || m.answerPath === 'template'
            ? 'unhappy'
            : 'wrong',
        signal: 'thumbs_down',
        conversationId: m.conversationId,
        messageId: m.id,
        visitorId: ctx.visitor.visitorId,
        suspicious: conv?.suspicious === true,
        questionMasked: maskForJournal(question.text),
        answerMasked: m.text ? maskForJournal(m.text) : null,
        lang: question.lang ?? m.lang ?? null,
        embedding: null,
      });
    } catch (err) {
      this.logger.warn(
        `thumbs_down signal failed site=${ctx.site.siteId} msg=${m.id}: ${
          err instanceof Error ? err.name : typeof err
        }`,
      );
    }
  }

  /**
   * Право посетителя на удаление (§6.3): все диалоги этого visitorId на
   * этом сайте (сообщения, передачи, очередь обучения из диалога — каскадом
   * FK) и все его указатели resumeKey; лиды остаются владельцу, но
   * `visitorId` у них обнуляется (Э3). Хвост, который роль убрать не может
   * (дословные варианты проверенных ответов), — задание L, поставленное ДО
   * удаления (после него id диалогов уже не найти). Повтор — 0, не ошибка.
   */
  async forget(ctx: VisitorContext): Promise<WidgetForgetResponse> {
    const where = {
      siteId: ctx.site.siteId,
      visitorId: ctx.visitor.visitorId,
    };
    const ids = await this.db.assistSiteConversation.findMany({
      where,
      select: { id: true },
    });
    if (ids.length) {
      await this.forgetJobs.enqueue(
        ctx.site.siteId,
        ids.map((c) => c.id),
      );
    }
    // Э3-бис (§5-тер.15): связанный режим — единицы экспериментов этого
    // посетителя (хеш его ключа визита) удаляются вместе с диалогами (хеш
    // визита диалога уходит с диалогом). У событий целей хеш визита роль не
    // видит (SELECT на события закрыт) — без ключа в браузере (чанк удаляет
    // его при отзыве согласия) он ни с чем не связывается и обнуляется
    // ретенцией через 35 дней (assist-analytics-rollup).
    const visits = await this.db.assistSiteConversation.findMany({
      where: { ...where, visitHash: { not: null } },
      select: { visitHash: true },
      distinct: ['visitHash'],
    });
    const hashes = visits
      .map((v) => v.visitHash)
      .filter((h): h is string => typeof h === 'string');
    if (hashes.length) {
      await this.db.$executeRawUnsafe(
        `DELETE FROM "sites"."assist_site_experiment_units" u
          USING "sites"."assist_site_experiments" e
          WHERE e."id" = u."experimentId" AND e."siteId" = $1
            AND u."unitHash" = ANY($2::text[])`,
        ctx.site.siteId,
        hashes,
      );
    }
    const [, convs] = await this.db.$transaction([
      this.db.assistSiteLead.updateMany({
        where,
        data: { visitorId: null },
      }),
      this.db.assistSiteConversation.deleteMany({ where }),
      this.db.assistSiteVisitorResume.deleteMany({ where }),
    ]);
    this.logger.log(
      `forget site=${ctx.site.siteId} conversations=${convs.count}`,
    );
    return { conversationsDeleted: convs.count };
  }
}
