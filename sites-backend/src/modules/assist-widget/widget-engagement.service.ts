/**
 * Публичная сторона Э3 виджета — W (ТЗ §3.7, §4.16, §5-тер.1, §5-тер.14):
 * передача человеку (стык с H), счётчики событий и цели (стык с A), режим
 * выбора цели (обмен `?v4c_goal=` и выбранный элемент). Только
 * AssistPublicDb; формат проверяет W (widget-engagement.ts), бизнес-правила
 * (кому слать карточку, дедуп и атрибуция целей) — владельцы стыков.
 *
 * Два вида допуска:
 *  - visitor-token (iframe, Origin виджета) — передача, цель из iframe;
 *  - Origin СТРАНИЦЫ + pk (загрузчик и чанк выбора цели на сайте
 *    заказчика): Origin — точный допущенный хост pk (`resolvePage`), для
 *    режима выбора — ровно хост, на который выдан токен (и он всё ещё
 *    verified). CORS этих путей отражает любой origin без cookie
 *    (common/cors.ts) — отказ по существу решается здесь, а не CORS.
 * Ответы целей — 204 на всё, кроме orderId-контакта (422): не оракул
 * существования ключей и целей. В лог — id и коды (§6.6): ни orderId, ни
 * сумм, ни текста элементов.
 */
import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { HANDOFF_DEFAULTS } from '../../config/assist-defaults';
import { AssistPublicDb } from '../../prisma/assist-public-db.service';
import { EventCounts } from '../assist-analytics/public/event-counts.service';
import { GoalIntake } from '../assist-analytics/public/goal-intake.service';
import type { WidgetSiteContext } from '../assist-site-chat/chat-types';
import { HandoffIntake } from '../assist-site-handoff/public/handoff-intake.service';
import type {
  WidgetGoalPickerSessionResponse,
  WidgetHandoffResponse,
} from './api-types';
import { WidgetOriginGuard } from './origin-guard';
import { WidgetRateLimit } from './rate-limit';
import {
  allowedOrigins,
  exactOrigin,
  findSiteByKey,
  isLocalOrigin,
  publishedWidgetConfig,
  sha256Hex,
  siteHostAccess,
  type WidgetSiteRow,
} from './site-access';
import { cleanPageUrl } from './widget-chat.service';
import {
  clickTime,
  cleanIdentity,
  countableEvents,
  engagementKeys,
  pageBody,
  parseEventBatch,
  parseGoalRequest,
  parsePick,
} from './widget-engagement';
import { widgetError } from './widget-errors';
import {
  WidgetSessionService,
  type VisitorContext,
} from './widget-session.service';
import { WidgetStateService } from './widget-state.service';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Пакетов счётчиков/целей/запросов выбора цели с одного адреса в минуту. */
export const EVENT_BATCHES_PER_IP_PER_MINUTE = 30;
export const GOALS_PER_IP_PER_MINUTE = 30;
export const PICKER_REQUESTS_PER_IP_PER_MINUTE = 20;
/** Сессия режима выбора цели — столько же, сколько живёт ссылка (§5-тер.1). */
export const PICKER_SESSION_TTL_MS = 30 * MINUTE;

/** Запрос со страницы: тело (как пришло), Origin, адрес и Content-Length. */
export interface PageRequest {
  body: unknown;
  origin: string | undefined;
  ip: string;
  contentLength: string | undefined;
}

@Injectable()
export class WidgetEngagementService {
  private readonly logger = new Logger(WidgetEngagementService.name);

  constructor(
    private readonly db: AssistPublicDb,
    private readonly guard: WidgetOriginGuard,
    private readonly sessions: WidgetSessionService,
    private readonly state: WidgetStateService,
    private readonly rate: WidgetRateLimit,
    private readonly handoffs: HandoffIntake,
    private readonly goals: GoalIntake,
    private readonly counts: EventCounts,
  ) {}

  // ── передача человеку (§3.7; стык W → H) ────────────────────────────────

  async handoff(
    ctx: VisitorContext,
    body: {
      conversationId?: string | null;
      uiLang?: 'uk' | 'ru' | 'en' | null;
      pageUrl?: string | null;
      scenarioKey?: string | null;
      identity?: Record<string, unknown> | null;
    },
    now: Date = new Date(),
  ): Promise<WidgetHandoffResponse> {
    // Частота — ДО вызова H (5/ч на посетителя, HANDOFF_DEFAULTS).
    await this.rate.enforce(
      [
        {
          scope: 'widget-handoff-visitor-hour',
          key: `${ctx.site.siteId}:${ctx.visitor.visitorId}`,
          limit: HANDOFF_DEFAULTS.requestsPerVisitorPerHour,
          windowMs: HOUR,
        },
      ],
      now,
    );
    // Диалог — только свой: чужой id передачу к чужому диалогу не создаёт.
    let conversationId: string | null = null;
    if (typeof body.conversationId === 'string' && body.conversationId) {
      const own = await this.state.ownsConversation(ctx, body.conversationId);
      conversationId = own ? body.conversationId : null;
    }
    let reason: 'visitor' | 'scenario' = 'visitor';
    if (body.scenarioKey) {
      const keys = engagementKeys(
        await publishedWidgetConfig(this.db, ctx.site),
      );
      if (keys.scenarios.has(body.scenarioKey)) reason = 'scenario';
    }
    const r = await this.handoffs.request({
      site: ctx.site,
      visitor: ctx.visitor,
      conversationId,
      reason,
      escalation: null,
      uiLang: body.uiLang ?? null,
      pageUrl: cleanPageUrl(body.pageUrl),
      identity: cleanIdentity(body.identity),
      now,
    });
    this.logger.log(
      `handoff site=${ctx.site.siteId} conv=${conversationId ?? '-'} mode=${r.mode} ${
        r.mode === 'human'
          ? `id=${r.handoff.id} existing=${r.existing}`
          : `reason=${r.reason}`
      }`,
    );
    return r.mode === 'human'
      ? {
          mode: 'human',
          handoff: r.handoff,
          etaMinutes: r.etaMinutes,
          existing: r.existing,
        }
      : { mode: 'lead', reason: r.reason };
  }

  /** Посетитель передумал ждать: только своя передача, только waiting (H). */
  async cancelHandoff(
    ctx: VisitorContext,
    conversationId: string,
    now: Date = new Date(),
  ): Promise<{ ok: true }> {
    const own = await this.state.ownsConversation(ctx, conversationId);
    if (!own) throw widgetError('NOT_FOUND');
    const done = await this.handoffs.cancel(
      ctx.site,
      ctx.visitor,
      conversationId,
      now,
    );
    this.logger.log(
      `handoff cancel site=${ctx.site.siteId} conv=${conversationId} cancelled=${done}`,
    );
    return { ok: true };
  }

  // ── запросы со страницы: общий допуск ──────────────────────────────────

  /** Origin страницы → сайт (или отказ тем же кодом, что у session). */
  private async pageSite(
    pk: string,
    origin: string | undefined,
    now: Date,
  ): Promise<{ row: WidgetSiteRow; site: WidgetSiteContext }> {
    const { decision, row } = await this.guard.resolvePage({
      pk,
      pageOrigin: origin,
      now,
    });
    if (!decision.ok || !row) {
      throw widgetError(decision.ok ? 'ORIGIN_DENIED' : decision.code);
    }
    return { row, site: decision.site };
  }

  private async limitIp(
    scope:
      'widget-event-ip-min' | 'widget-goal-ip-min' | 'widget-picker-ip-min',
    limit: number,
    row: { siteId: string; ipSalt: string | null },
    ip: string,
    now: Date,
  ): Promise<void> {
    const ipHash = this.sessions.ipHash(ip, row.ipSalt, now);
    await this.rate.enforce(
      [{ scope, key: `${row.siteId}:${ipHash}`, limit, windowMs: MINUTE }],
      now,
    );
  }

  // ── счётчики событий (§4.16; стык W → A) ───────────────────────────────

  async events(p: PageRequest, now: Date = new Date()): Promise<void> {
    const raw = pageBody(p.body, p.contentLength);
    const batch = raw ? parseEventBatch(raw) : null;
    if (!batch) throw widgetError('EVENT_INVALID');
    const { row } = await this.pageSite(batch.pk, p.origin, now);
    await this.limitIp(
      'widget-event-ip-min',
      EVENT_BATCHES_PER_IP_PER_MINUTE,
      row,
      p.ip,
      now,
    );
    const keys = engagementKeys(await publishedWidgetConfig(this.db, row));
    const events = countableEvents(batch.events, keys);
    if (events.length) {
      await this.counts.record({ siteId: row.siteId, events, now });
    }
    this.logger.log(
      `events site=${row.siteId} got=${batch.events.length} kept=${events.length}`,
    );
  }

  // ── цели (§5-тер.1; стык W → A) ────────────────────────────────────────

  /** Цель из iframe (visitor-token): с диалогом и кликом по действию помощника. */
  async goalFromIframe(
    ctx: VisitorContext,
    p: PageRequest,
    now: Date = new Date(),
  ): Promise<void> {
    const raw = pageBody(p.body, p.contentLength);
    const g = parseGoalRequest(raw, true);
    if (!g.ok) throw widgetError(g.code);
    await this.rate.enforce(
      [
        {
          scope: 'widget-goal-ip-min',
          key: `${ctx.site.siteId}:${ctx.visitor.ipHash}`,
          limit: GOALS_PER_IP_PER_MINUTE,
          windowMs: MINUTE,
        },
      ],
      now,
    );
    let conversationId: string | null = null;
    if (g.conversationId) {
      const own = await this.state.ownsConversation(ctx, g.conversationId);
      conversationId = own ? g.conversationId : null;
    }
    const r = await this.goals.fromIframe({
      site: ctx.site,
      visitor: ctx.visitor,
      conversationId,
      lastAssistClickAt: clickTime(g.lastAssistClickAt, now),
      assist: g.assist ?? { proactive: null, scenario: null, link: false },
      hit: {
        goalKey: g.goalKey,
        detector: g.detector,
        docId: g.docId,
        path: g.path,
        orderId: g.orderId,
        value: g.value,
        currency: g.currency,
        occurredAt: now,
        visit: g.visit,
      },
      rawIp: p.ip,
    });
    this.logger.log(`goal iframe site=${ctx.site.siteId} result=${r}`);
    if (r === 'GOAL_ORDER_ID_INVALID')
      throw widgetError('GOAL_ORDER_ID_INVALID');
  }

  /** Цель из загрузчика (страница, pk): attribution unassisted (A). */
  async goalFromPage(p: PageRequest, now: Date = new Date()): Promise<void> {
    const raw = pageBody(p.body, p.contentLength);
    const g = parseGoalRequest(raw, false);
    if (!g.ok) throw widgetError(g.code);
    const { row, site } = await this.pageSite(g.pk as string, p.origin, now);
    await this.limitIp(
      'widget-goal-ip-min',
      GOALS_PER_IP_PER_MINUTE,
      row,
      p.ip,
      now,
    );
    const r = await this.goals.fromLoader({
      site,
      hit: {
        goalKey: g.goalKey,
        detector: g.detector,
        docId: g.docId,
        path: g.path,
        orderId: g.orderId,
        value: g.value,
        currency: g.currency,
        occurredAt: now,
        visit: g.visit,
      },
      rawIp: p.ip,
    });
    this.logger.log(`goal page site=${row.siteId} result=${r}`);
    if (r === 'GOAL_ORDER_ID_INVALID')
      throw widgetError('GOAL_ORDER_ID_INVALID');
  }

  // ── режим выбора цели (§5-тер.1 «WYSIWYG»; токен — A) ──────────────────

  /**
   * `?v4c_goal=<токен>` → сессия. Токен — строка assist_site_preview_tokens
   * с purpose = goal (выдаёт A, 30 мин): тот же сайт по pk, не использован,
   * не истёк, Origin страницы — ровно `origin` токена и этот хост сейчас
   * допущен ядром. Одноразовость — условием UPDATE (как preview/exchange).
   */
  async pickerSession(
    body: { pk: string; token: string },
    p: { origin: string | undefined; ip: string },
    now: Date = new Date(),
  ): Promise<WidgetGoalPickerSessionResponse> {
    const invalid = () => widgetError('PICKER_INVALID');
    const found = await findSiteByKey(this.db, body.pk);
    const origin = exactOrigin(p.origin);
    if (!found || !origin || !/^[A-Za-z0-9_-]{20,100}$/.test(body.token)) {
      throw invalid();
    }
    await this.limitIp(
      'widget-picker-ip-min',
      PICKER_REQUESTS_PER_IP_PER_MINUTE,
      found.site,
      p.ip,
      now,
    );
    const tokenHash = sha256Hex(body.token);
    const row = await this.db.assistSitePreviewToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        siteId: true,
        purpose: true,
        origin: true,
        expiresAt: true,
        usedAt: true,
      },
    });
    if (
      !row ||
      row.purpose !== 'goal' ||
      row.siteId !== found.site.siteId ||
      row.usedAt !== null ||
      row.expiresAt.getTime() <= now.getTime() ||
      row.origin !== origin
    ) {
      throw invalid();
    }
    if (!(await this.hostAllowed(found.site.siteId, found.kind, origin, now))) {
      throw invalid();
    }
    const session = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + PICKER_SESSION_TTL_MS);
    const used = await this.db.assistSitePreviewToken.updateMany({
      where: {
        id: row.id,
        tokenHash,
        siteId: found.site.siteId,
        purpose: 'goal',
        usedAt: null,
        expiresAt: { gt: now },
      },
      data: {
        usedAt: now,
        sessionHash: sha256Hex(session),
        sessionExpiresAt: expiresAt,
      },
    });
    if (used.count !== 1) throw invalid();
    this.logger.log(`picker session site=${found.site.siteId} token=${row.id}`);
    return { pickerSession: session, expiresAt: expiresAt.toISOString() };
  }

  /** Выбранный элемент → assist_site_preview_tokens.result (читает TMA, A). */
  async pick(
    body: unknown,
    p: { origin: string | undefined; ip: string },
    now: Date = new Date(),
  ): Promise<{ ok: true }> {
    const invalid = () => widgetError('PICKER_INVALID');
    const pick = parsePick(body);
    if (!pick) throw widgetError('BAD_REQUEST');
    const origin = exactOrigin(p.origin);
    if (!origin) throw invalid();
    const sessionHash = sha256Hex(pick.pickerSession);
    const row = await this.db.assistSitePreviewToken.findUnique({
      where: { sessionHash },
      select: {
        id: true,
        siteId: true,
        purpose: true,
        origin: true,
        sessionExpiresAt: true,
      },
    });
    if (
      !row ||
      row.purpose !== 'goal' ||
      row.origin !== origin ||
      !row.sessionExpiresAt ||
      row.sessionExpiresAt.getTime() <= now.getTime()
    ) {
      throw invalid();
    }
    const site = await this.db.assistSite.findUnique({
      where: { siteId: row.siteId },
      select: { siteId: true, ipSalt: true },
    });
    if (!site) throw invalid();
    await this.limitIp(
      'widget-picker-ip-min',
      PICKER_REQUESTS_PER_IP_PER_MINUTE,
      site,
      p.ip,
      now,
    );
    const done = await this.db.assistSitePreviewToken.updateMany({
      where: {
        id: row.id,
        sessionHash,
        purpose: 'goal',
        sessionExpiresAt: { gt: now },
      },
      data: {
        result: {
          descriptor: { ...pick.descriptor },
          path: pick.path,
          label: pick.label,
          kind: pick.kind,
          at: now.toISOString(),
        },
      },
    });
    if (done.count !== 1) throw invalid();
    this.logger.log(
      `picker pick site=${row.siteId} token=${row.id} kind=${pick.kind}`,
    );
    return { ok: true };
  }

  /** Хост сейчас допущен ядром для виджета (verified/льгота); test-ключ — localhost. */
  private async hostAllowed(
    siteId: string,
    kind: 'live' | 'test',
    origin: string,
    now: Date,
  ): Promise<boolean> {
    if (kind === 'test' && isLocalOrigin(origin)) return true;
    if (isLocalOrigin(origin)) return false;
    const access = await siteHostAccess(this.db, siteId, now);
    return allowedOrigins(access, [], false).some((h) => h.origin === origin);
  }
}
