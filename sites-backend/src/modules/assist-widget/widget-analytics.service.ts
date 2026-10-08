/**
 * Публичные маршруты Э3-бис виджета (ТЗ §5-тер.2, §5-тер.8–9, §5-тер.14):
 *   POST /widget/v1/exp    Origin страницы + pk  { pk, x, v }  → 204
 *   POST /widget/v1/pv     Origin страницы + pk  итог просмотра → 204 | 400
 *   POST /widget/v1/ref    Origin страницы + pk  { pk, v }     → { ref }
 *   POST /widget/v1/visit  visitor-token (iframe) { conversationId, v } → 204
 * Все — ТОЛЬКО для посетителя, давшего согласие на аналитику (у чанка
 * загрузчика без согласия нет ключа визита, без ключа сервер ничего не
 * принимает); бизнес-правила — AiIntake (A, только AssistPublicDb).
 * Тела `exp`/`pv`/`ref` приходят и text/plain (sendBeacon) — строгий
 * разбор, неизвестное поле итога — 400 (вторая линия К-11). В лог — id
 * сайта и коды (§6.6).
 */
import { Injectable, Logger } from '@nestjs/common';
import { AssistPublicDb } from '../../prisma/assist-public-db.service';
import {
  AiIntake,
  PV_PER_IP_PER_MINUTE,
  issueRef,
  validVisitKey,
  visitHashOf,
} from '../assist-analytics/public/ai-intake.service';
import { parsePageView } from '../assist-analytics/public/page-view';
import { WidgetOriginGuard } from './origin-guard';
import { WidgetRateLimit } from './rate-limit';
import type { PageRequest } from './widget-engagement.service';
import { pageBody } from './widget-engagement';
import { widgetError } from './widget-errors';
import {
  WidgetSessionService,
  type VisitorContext,
} from './widget-session.service';
import { WidgetStateService } from './widget-state.service';

const MINUTE = 60_000;
/** Запросов связанного режима с адреса на сайт в минуту (exp/ref/visit). */
export const ANA_REQUESTS_PER_IP_PER_MINUTE = 30;
/**
 * Итогов просмотра с адреса на сайт в минуту (аудит Э3-бис; заход 9,
 * Р-З9-27): окно — в Postgres (`assist_rate_buckets`, общее для всех
 * экземпляров функции; `AiIntake.pvRateOk`), счётчик в памяти экземпляра
 * остаётся первой линией (тот же потолок, без записи в базу на каждый
 * лишний маяк). Без лимита один адрес за минуты выбирал месячную квоту
 * поведения чужого сайта и рисовал ему ложные ярость-клики/ошибки в
 * выводах. Сверх — молча 204 (маяку ответ не нужен), в базу ничего.
 */
export { PV_PER_IP_PER_MINUTE };
const PV_LIMITER_MAX_KEYS = 20_000;

@Injectable()
export class WidgetAnalyticsService {
  private readonly logger = new Logger(WidgetAnalyticsService.name);
  private readonly pvHits = new Map<string, { win: number; n: number }>();

  constructor(
    private readonly db: AssistPublicDb,
    private readonly guard: WidgetOriginGuard,
    private readonly sessions: WidgetSessionService,
    private readonly state: WidgetStateService,
    private readonly rate: WidgetRateLimit,
    private readonly ai: AiIntake,
  ) {}

  private async page(pk: unknown, origin: string | undefined, now: Date) {
    if (typeof pk !== 'string') throw widgetError('BAD_REQUEST');
    const { decision, row } = await this.guard.resolvePage({
      pk,
      pageOrigin: origin,
      now,
    });
    if (!decision.ok || !row) {
      throw widgetError(decision.ok ? 'ORIGIN_DENIED' : decision.code);
    }
    const a = await this.db.assistSite.findUnique({
      where: { siteId: row.siteId },
      select: { analytics: true },
    });
    return {
      siteId: row.siteId,
      accountId: row.accountId,
      ipSalt: row.ipSalt,
      analytics: a?.analytics ?? null,
    };
  }

  private async limit(
    site: { siteId: string; ipSalt: string | null },
    ip: string,
    now: Date,
  ): Promise<void> {
    const ipHash = this.sessions.ipHash(ip, site.ipSalt, now);
    await this.rate.enforce(
      [
        {
          scope: 'widget-ana-ip-min',
          key: `${site.siteId}:${ipHash}`,
          limit: ANA_REQUESTS_PER_IP_PER_MINUTE,
          windowMs: MINUTE,
        },
      ],
      now,
    );
  }

  async experiment(p: PageRequest, now: Date = new Date()): Promise<void> {
    const b = pageBody(p.body, p.contentLength);
    if (
      !b ||
      Object.keys(b).some((k) => !['pk', 'x', 'v'].includes(k)) ||
      typeof b.x !== 'string' ||
      b.x.length > 40 ||
      !validVisitKey(b.v)
    ) {
      throw widgetError('BAD_REQUEST');
    }
    const site = await this.page(b.pk, p.origin, now);
    await this.limit(site, p.ip, now);
    const r = await this.ai.enroll({ site, experimentId: b.x, v: b.v, now });
    this.logger.log(`exp site=${site.siteId} result=${r}`);
  }

  /** Первая линия лимита итогов просмотра — в памяти (см. PV_PER_IP_PER_MINUTE). */
  pvAllowed(
    site: { siteId: string; ipSalt: string | null },
    ip: string,
    now: Date,
  ): boolean {
    const win = Math.floor(now.getTime() / MINUTE);
    const key = `${site.siteId}:${this.sessions.ipHash(ip, site.ipSalt, now)}`;
    const cur = this.pvHits.get(key);
    if (cur && cur.win === win) {
      cur.n++;
      // В лог — один раз за минуту на адрес, не на каждый отброшенный маяк.
      if (cur.n === PV_PER_IP_PER_MINUTE + 1) {
        this.logger.log(`pv site=${site.siteId} result=rate_limited`);
      }
      return cur.n <= PV_PER_IP_PER_MINUTE;
    }
    if (this.pvHits.size >= PV_LIMITER_MAX_KEYS) {
      for (const [k, v] of this.pvHits)
        if (v.win !== win) this.pvHits.delete(k);
      if (this.pvHits.size >= PV_LIMITER_MAX_KEYS) this.pvHits.clear();
    }
    this.pvHits.set(key, { win, n: 1 });
    return true;
  }

  async pageView(
    p: PageRequest & { userAgent: string | undefined },
    now: Date = new Date(),
  ): Promise<void> {
    const raw = pageBody(p.body, p.contentLength);
    const input = raw ? parsePageView(raw) : null;
    if (!input) throw widgetError('EVENT_INVALID');
    const site = await this.page(input.pk, p.origin, now);
    if (!this.pvAllowed(site, p.ip, now)) return;
    let ownHost: string | null = null;
    try {
      ownHost = p.origin ? new URL(p.origin).hostname : null;
    } catch {
      ownHost = null;
    }
    const r = await this.ai.pageView({
      site,
      ownHost,
      input,
      userAgent: p.userAgent,
      now,
      // Общий лимит всех экземпляров (Р-З9-27) — внутри, после дешёвых проверок.
      ipHash: this.sessions.ipHash(p.ip, site.ipSalt, now),
    });
    if (r !== 'updated' && r !== 'limited') {
      this.logger.log(`pv site=${site.siteId} result=${r}`);
    }
  }

  async ref(
    p: PageRequest,
    now: Date = new Date(),
  ): Promise<{ ref: string | null }> {
    const b = pageBody(p.body, p.contentLength);
    if (
      !b ||
      Object.keys(b).some((k) => !['pk', 'v'].includes(k)) ||
      !validVisitKey(b.v)
    ) {
      throw widgetError('BAD_REQUEST');
    }
    const site = await this.page(b.pk, p.origin, now);
    await this.limit(site, p.ip, now);
    const window = await this.ai.linkedWindow(site, now);
    if (window <= 0) return { ref: null };
    return {
      ref: issueRef(
        site.siteId,
        visitHashOf(site.siteId, site.ipSalt, b.v),
        now,
      ),
    };
  }

  async visit(
    ctx: VisitorContext,
    body: unknown,
    ip: string,
    now: Date = new Date(),
  ): Promise<void> {
    const b =
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;
    if (
      !b ||
      Object.keys(b).some((k) => !['conversationId', 'v'].includes(k)) ||
      typeof b.conversationId !== 'string' ||
      b.conversationId.length > 64 ||
      !validVisitKey(b.v)
    ) {
      throw widgetError('BAD_REQUEST');
    }
    const row = await this.db.assistSite.findUnique({
      where: { siteId: ctx.site.siteId },
      select: { ipSalt: true, analytics: true },
    });
    if (!row) throw widgetError('WIDGET_UNKNOWN_KEY');
    await this.limit({ siteId: ctx.site.siteId, ipSalt: row.ipSalt }, ip, now);
    if (!(await this.state.ownsConversation(ctx, b.conversationId))) {
      throw widgetError('NOT_FOUND');
    }
    const linked = await this.ai.linkVisit({
      site: {
        siteId: ctx.site.siteId,
        accountId: ctx.site.accountId,
        ipSalt: row.ipSalt,
        analytics: row.analytics,
      },
      conversationId: b.conversationId,
      visitorId: ctx.visitor.visitorId,
      v: b.v,
      now,
    });
    this.logger.log(
      `visit site=${ctx.site.siteId} conv=${b.conversationId} linked=${linked}`,
    );
  }
}
