/**
 * `POST /widget/v1/chat` — сторона W2 стыка с конвейером W3 (контракт Э2 §5):
 * вопрос режется до maxQuestionChars (QUESTION_TOO_LONG), частота —
 * ДО вызова (10/мин и 60/ч на посетителя, 30/мин на ipHash+сайт), страница
 * и `context` — недоверенные данные (усечение, без query в URL, §6.6), затем
 * `SiteChatService.ask` и выдача событий SSE или одним JSON.
 *
 * Генерация НЕ обрывается при разрыве соединения (§4-бис.4): события
 * дочитываются до конца даже после закрытия ответа — W3 сам пишет текст в
 * базу, а прерванный посреди стрима клиент продолжит по
 * `GET /messages/:id/stream`. Повтор clientRequestId (meta.replay) с ещё
 * идущим ответом — W2 дочитывает текст из базы опросом (другой экземпляр
 * пишет его не реже 500 мс).
 *
 * В логах — только id, коды и время; ни вопроса, ни ответа (§6.6, п.6).
 *
 * Э3 (W): `openedBy` нового диалога (`user` | `proactive:<ключ>` |
 * `scenario:<ключ>`) — формат и ключ из ОПУБЛИКОВАННОЙ конфигурации
 * вовлечения (неверное — null, вопрос не отвергается); событие стрима
 * `handoff` (вопрос ушёл оператору) проходит как есть — его рисует iframe.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { WIDGET_DEFAULTS } from '../../config/assist-defaults';
import type {
  AskInput,
  SiteAction,
  SiteAnswerSource,
  WidgetChatEvent,
  WidgetStreamErrorCode,
} from '../assist-site-chat/chat-types';
import { SiteChatService } from '../assist-site-chat/site-chat.service';
import { AssistPublicDb } from '../../prisma/assist-public-db.service';
import { publishedWidgetConfig } from './site-access';
import {
  cleanOpenedBy,
  engagementKeys,
  openedByNeedsKeys,
  type EngagementKeys,
} from './widget-engagement';
import type { WidgetChatJsonResponse, WidgetErrorCode } from './api-types';
import { WidgetRateLimit } from './rate-limit';
import type { VisitorContext } from './widget-session.service';
import { WidgetStateService } from './widget-state.service';
import { widgetError } from './widget-errors';
import type { WidgetChatDto } from './widget.dto';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const MAX_CONTEXT_KEYS = 20;
const MAX_CONTEXT_KEY_CHARS = 40;
const MAX_PAGE_URL_CHARS = 2048;

/** Код стрима (нижний регистр) → код REST для JSON-пути (UPPER_SNAKE). */
const REST_CODE: Record<WidgetStreamErrorCode, WidgetErrorCode> = {
  disabled: 'WIDGET_DISABLED',
  site_quota: 'SITE_QUOTA',
  platform_budget: 'PLATFORM_BUDGET',
  rate_limited: 'RATE_LIMITED',
  upstream: 'UPSTREAM',
  origin_denied: 'ORIGIN_DENIED',
  bad_request: 'BAD_REQUEST',
};

/** URL страницы посетителя: http(s), без логина, query и якоря (§6.6). */
export function cleanPageUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_PAGE_URL_CHARS) {
    return null;
  }
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password) return null;
    return `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}

/**
 * `V4CAssist('context')` — плоский объект строк/чисел; всего ≤ maxContextChars
 * (ключи + значения). Лишнее отрезается, а не отвергается: это подсказка
 * страницы, а не вход посетителя, и сломать вопрос из-за неё нельзя.
 */
export function cleanContext(
  raw: unknown,
): Record<string, string | number> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, string | number> = {};
  let budget = WIDGET_DEFAULTS.maxContextChars;
  let n = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= MAX_CONTEXT_KEYS || budget <= 0) break;
    if (!/^[A-Za-z0-9_.-]+$/.test(k) || k.length > MAX_CONTEXT_KEY_CHARS) {
      continue;
    }
    let val: string | number;
    if (typeof v === 'number' && Number.isFinite(v)) val = v;
    else if (typeof v === 'string') val = v;
    else continue;
    const s = String(val);
    const room = budget - k.length;
    if (room <= 0) break;
    if (s.length > room) {
      if (typeof val === 'number') break;
      val = s.slice(0, room);
    }
    out[k] = val;
    budget -= k.length + String(val).length;
    n++;
  }
  return n ? out : null;
}

export function cleanPage(raw: unknown): AskInput['page'] {
  const o =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const title =
    typeof o.title === 'string' && o.title.trim()
      ? o.title.slice(0, WIDGET_DEFAULTS.maxPageTitleChars)
      : null;
  return { url: cleanPageUrl(o.url), title };
}

interface Collected {
  conversationId: string | null;
  messageId: string | null;
  replay: boolean;
  text: string;
  sources: SiteAnswerSource[];
  actions: SiteAction[];
  done: boolean;
  error: { code: WidgetStreamErrorCode } | null;
  handoff: { state: 'waiting' | 'active'; relayed: boolean } | null;
}

function emptyCollected(): Collected {
  return {
    conversationId: null,
    messageId: null,
    replay: false,
    text: '',
    sources: [],
    actions: [],
    done: false,
    error: null,
    handoff: null,
  };
}

function collect(c: Collected, e: WidgetChatEvent): void {
  switch (e.type) {
    case 'meta':
      c.conversationId = e.conversationId;
      c.messageId = e.messageId;
      c.replay = e.replay;
      break;
    case 'token':
      c.text += e.t;
      break;
    case 'sources':
      c.sources = e.items;
      break;
    case 'actions':
      c.actions = e.items;
      break;
    case 'done':
      c.done = true;
      break;
    case 'error':
      c.error = { code: e.code };
      break;
    case 'handoff':
      c.handoff = { state: e.state, relayed: e.relayed };
      break;
  }
}

export function sseFrame(e: WidgetChatEvent): string {
  return `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
}

@Injectable()
export class WidgetChatService {
  private readonly logger = new Logger(WidgetChatService.name);

  constructor(
    private readonly chat: SiteChatService,
    private readonly rate: WidgetRateLimit,
    private readonly state: WidgetStateService,
    private readonly db: AssistPublicDb,
  ) {}

  /** Ключи вовлечения опубликованного вида (только когда openedBy их требует). */
  private async publishedKeys(ctx: VisitorContext): Promise<EngagementKeys> {
    const published = await publishedWidgetConfig(this.db, ctx.site);
    return engagementKeys(published);
  }

  /** Проверки W2 до конвейера: длина, частота, недоверенные данные. */
  async prepare(
    ctx: VisitorContext,
    dto: WidgetChatDto,
    now: Date = new Date(),
  ): Promise<AskInput> {
    const question = dto.question.trim();
    if (!question) throw widgetError('BAD_REQUEST');
    if (question.length > WIDGET_DEFAULTS.maxQuestionChars) {
      throw widgetError('QUESTION_TOO_LONG');
    }
    const visitorKey = `${ctx.site.siteId}:${ctx.visitor.visitorId}`;
    await this.rate.enforce(
      [
        {
          scope: 'widget-msg-visitor-min',
          key: visitorKey,
          limit: WIDGET_DEFAULTS.messagesPerVisitorPerMinute,
          windowMs: MINUTE,
        },
        {
          scope: 'widget-msg-visitor-hour',
          key: visitorKey,
          limit: WIDGET_DEFAULTS.messagesPerVisitorPerHour,
          windowMs: HOUR,
        },
        {
          scope: 'widget-msg-ip-site-min',
          key: `${ctx.site.siteId}:${ctx.visitor.ipHash}`,
          limit: WIDGET_DEFAULTS.messagesPerIpSitePerMinute,
          windowMs: MINUTE,
        },
      ],
      now,
    );
    const keys = openedByNeedsKeys(dto.openedBy)
      ? await this.publishedKeys(ctx)
      : null;
    const openedBy = cleanOpenedBy(
      dto.openedBy,
      () => keys ?? { triggers: new Set(), scenarios: new Set() },
    );
    return {
      site: ctx.site,
      visitor: ctx.visitor,
      ...(openedBy ? { openedBy } : {}),
      conversationId:
        typeof dto.conversationId === 'string' && dto.conversationId
          ? dto.conversationId
          : null,
      clientRequestId: dto.clientRequestId,
      question,
      page: cleanPage(dto.page),
      context: cleanContext(dto.context),
      uiLang: dto.uiLang ?? null,
    };
  }

  /**
   * SSE: события W3 как есть; разрыв соединения — писать перестаём, но
   * поток дочитываем (генерация идёт до конца, резерв снимает она же).
   */
  async streamSse(
    ctx: VisitorContext,
    input: AskInput,
    res: Response,
  ): Promise<void> {
    const started = Date.now();
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    const write = (e: WidgetChatEvent) => {
      if (!res.writableEnded && !res.destroyed) res.write(sseFrame(e));
    };
    const c = emptyCollected();
    try {
      for await (const e of this.chat.ask(input)) {
        collect(c, e);
        write(e);
      }
      if (c.replay && c.messageId && !c.done && !c.error) {
        await this.followFromDb(ctx, c, write);
      }
    } catch (err) {
      this.logger.error(
        `chat failed site=${ctx.site.siteId} msg=${c.messageId ?? '-'}: ${errName(err)}`,
      );
      if (!c.error) {
        write({
          type: 'error',
          code: 'upstream',
          message: 'Ответ прервался — повторите вопрос',
        });
        c.error = { code: 'upstream' };
      }
    } finally {
      this.logResult(ctx, c, started);
      if (!res.writableEnded) res.end();
    }
  }

  /** JSON-запасной путь (Accept: application/json). */
  async json(
    ctx: VisitorContext,
    input: AskInput,
  ): Promise<WidgetChatJsonResponse> {
    const started = Date.now();
    const c = emptyCollected();
    try {
      for await (const e of this.chat.ask(input)) collect(c, e);
    } catch (err) {
      this.logger.error(
        `chat failed site=${ctx.site.siteId} msg=${c.messageId ?? '-'}: ${errName(err)}`,
      );
      c.error = { code: 'upstream' };
    }
    this.logResult(ctx, c, started);
    if (c.error) {
      throw widgetError(REST_CODE[c.error.code] ?? 'UPSTREAM');
    }
    // Вопрос ушёл человеку (Э3): ответа модели нет — iframe опрашивает state.
    const conversationId = c.conversationId ?? input.conversationId;
    if (c.handoff && conversationId) {
      return {
        conversationId,
        messageId: c.messageId ?? '',
        text: '',
        sources: [],
        actions: [],
        refused: false,
        streaming: false,
        handoff: c.handoff,
      };
    }
    if (!c.conversationId || !c.messageId) throw widgetError('UPSTREAM');
    const stored = await this.state.message(ctx, c.messageId);
    const streaming = stored?.streamState === 'streaming';
    return {
      conversationId: c.conversationId,
      messageId: c.messageId,
      // Повтор с идущим ответом — то, что уже записано (дочитать стримом).
      text: c.replay && !c.done ? (stored?.text ?? c.text) : c.text,
      sources: c.sources.length ? c.sources : (stored?.sources ?? []),
      actions: c.actions.length ? c.actions : (stored?.actions ?? []),
      refused: stored?.streamState === 'refused',
      streaming,
    };
  }

  /** Повтор clientRequestId при идущем ответе: дочитать из базы опросом. */
  private async followFromDb(
    ctx: VisitorContext,
    c: Collected,
    write: (e: WidgetChatEvent) => void,
  ): Promise<void> {
    const deadline = Date.now() + WIDGET_DEFAULTS.answerTimeoutMs;
    let offset = c.text.length;
    while (Date.now() < deadline) {
      const chunk = await this.state.streamChunk(ctx, c.messageId!, offset);
      if (chunk.text) {
        write({ type: 'token', t: chunk.text });
        c.text += chunk.text;
      }
      offset = chunk.offset;
      if (chunk.streamState !== 'streaming') {
        if (chunk.sources.length) {
          write({ type: 'sources', items: chunk.sources });
        }
        if (chunk.actions.length) {
          write({ type: 'actions', items: chunk.actions });
        }
        write({ type: 'done', usage: { in: 0, out: 0, cached: 0 } });
        c.done = true;
        return;
      }
    }
  }

  private logResult(ctx: VisitorContext, c: Collected, started: number) {
    this.logger.log(
      `chat site=${ctx.site.siteId} conv=${c.conversationId ?? '-'} msg=${c.messageId ?? '-'} ` +
        `replay=${c.replay} done=${c.done} error=${c.error?.code ?? '-'} handoff=${c.handoff?.state ?? '-'} ms=${Date.now() - started}`,
    );
  }
}

/** Имя класса ошибки без текста: текст провайдера в лог не идёт (§6.6). */
function errName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}
