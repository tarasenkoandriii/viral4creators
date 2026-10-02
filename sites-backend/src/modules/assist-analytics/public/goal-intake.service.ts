/**
 * Приём целей из ПУБЛИЧНОГО кода — A (ТЗ §5-тер.1–2; приёмка §5-тер.16
 * п.1, п.5, п.7). Только AssistPublicDb; маршруты — W (`POST /widget/v1/goal`).
 *
 *  - fromLoader: Origin = verified public-хост сайта (гвард W), без
 *    посетителя → attribution `unassisted`; trust `page`; дедуп
 *    clientEventId (`<docId>:<goalKey>:<detector>` — url раз на документ,
 *    click раз на цель за документ) и orderId (ON CONFLICT DO NOTHING);
 *  - fromIframe: visitor-token + conversationId ЭТОГО посетителя →
 *    decideAttribution (direct ≤ 30 мин после клика по действию помощника /
 *    assisted / unassisted);
 *  - recordBuiltinLead: заявка Помощника — цель шаблона `lead` с детектором
 *    builtin, trust `builtin`, attribution `direct` (зовёт leads.service).
 * Фильтры (§5-тер.1): CIDR офиса (сырой IP до хеширования), исключённые
 * пути, предпросмотр (preview = true), `webdriver` (загрузчик не шлёт),
 * suspicious-посетитель — событие не пишется. orderId, похожий на контакт,
 * — `GOAL_ORDER_ID_INVALID` (422, §5-тер.16 п.1). Неизвестный ключ/цель не
 * active — `GOAL_UNKNOWN` (тихий 204 у W — не оракул).
 *
 * Уточнения A:
 *  - у роли на события целей только INSERT (без SELECT): дедуп — createMany
 *    `skipDuplicates` (ON CONFLICT DO NOTHING по обоим уникальным ключам),
 *    «дубль» — count = 0. `lastFiredAt` цели роль не пишет — его ставит
 *    свёртка (AnalyticsRollup.run) по событиям;
 *  - цель `stale` продолжает приниматься (вёрстку починили — цель снова
 *    срабатывает, свёртка вернёт её в active); `paused` — GOAL_UNKNOWN;
 *  - вид детектора должен быть у цели (`js` — только у цели с детектором
 *    js: §5-тер.1 «key — из списка целей сайта с детектором js»);
 *  - orderId есть — дедуп по (цель, orderId), clientEventId не пишется
 *    (в одном документе SPA бывает два заказа); нет — раз на документ;
 *  - время события — серверное, если клиентское врёт больше чем на
 *    час назад/минуту вперёд (часы посетителя — недоверенные данные).
 * В лог — только id сайта и код (§6.6): ни orderId, ни сумм, ни пути.
 */
import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { AssistPublicDb } from '../../../prisma/assist-public-db.service';
import type {
  WidgetSiteContext,
  WidgetVisitor,
} from '../../assist-site-chat/chat-types';
import { effectiveAnalyticsConfig, ipInCidrs } from '../analytics-config';
import { decideAttribution } from '../attribution';
import {
  CURRENCY,
  GOAL_KEY,
  loaderDetectors,
  pathMatchesMask,
  storedDetectors,
  validGoalValue,
  validOrderId,
  type GoalAttribution,
  type GoalDetector,
  type GoalEventSource,
  type PublicGoal,
} from '../goal-types';

export interface GoalHit {
  goalKey: string;
  detector: 'url' | 'click' | 'form_submit' | 'js';
  /** Случайный id документа загрузчика (дедуп «раз на документ»). */
  docId: string;
  path: string | null;
  orderId: string | null;
  value: number | null;
  currency: string | null;
  occurredAt: Date;
}

export type GoalIntakeResult =
  | 'recorded'
  | 'duplicate'
  | 'ignored'
  | 'GOAL_UNKNOWN'
  | 'GOAL_ORDER_ID_INVALID';

/** docId загрузчика: случайная строка документа (не идентификатор посетителя). */
const DOC_ID = /^[A-Za-z0-9_-]{8,64}$/;
const HIT_PAST_MS = 60 * 60 * 1000;
const HIT_FUTURE_MS = 60 * 1000;
/** Путь события: без query и фрагмента (§6.6), ≤ 300 символов. */
const MAX_PATH = 300;

interface GoalRow {
  id: string;
  key: string;
  template: string;
  detectors: unknown;
  valueMode: string;
  fixedValue: Prisma.Decimal | null;
  currency: string | null;
  status: string;
}

/** Путь страницы → только pathname (на случай, если пришёл URL или query). */
export function cleanGoalPath(raw: string | null): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  let p = raw;
  if (!p.startsWith('/')) {
    try {
      p = new URL(p).pathname;
    } catch {
      return null;
    }
  }
  p = p.replace(/[?#].*$/, '');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s]/.test(p)) return null;
  return p.slice(0, MAX_PATH) || '/';
}

@Injectable()
export class GoalIntake {
  private readonly logger = new Logger(GoalIntake.name);
  now: () => Date = () => new Date();

  constructor(readonly db: AssistPublicDb) {}

  /** Активные цели сайта для загрузчика (WidgetPublicConfig.goals, W). */
  async publicGoals(siteId: string): Promise<PublicGoal[]> {
    const rows = await this.db.assistSiteGoal.findMany({
      where: { siteId, status: { in: ['active', 'stale'] } },
      select: { key: true, template: true, detectors: true, valueMode: true },
      orderBy: { key: 'asc' },
    });
    const out: PublicGoal[] = [];
    for (const r of rows) {
      const detectors = loaderDetectors(
        storedDetectors(r.detectors, r.template),
      );
      if (!detectors.length) continue;
      out.push({
        key: r.key,
        detectors,
        valueMode:
          r.valueMode === 'fixed' || r.valueMode === 'event'
            ? r.valueMode
            : 'none',
      });
    }
    return out;
  }

  fromLoader(p: {
    site: WidgetSiteContext;
    hit: GoalHit;
    rawIp: string | null;
  }): Promise<GoalIntakeResult> {
    return this.accept({
      site: p.site,
      hit: p.hit,
      rawIp: p.rawIp,
      source: 'loader',
      visitor: null,
      conversationId: null,
      lastAssistClickAt: null,
      assist: null,
    });
  }

  fromIframe(p: {
    site: WidgetSiteContext;
    visitor: WidgetVisitor;
    conversationId: string | null;
    lastAssistClickAt: Date | null;
    assist: {
      proactive: string | null;
      scenario: string | null;
      link: boolean;
    };
    hit: GoalHit;
    rawIp: string | null;
  }): Promise<GoalIntakeResult> {
    return this.accept({ ...p, source: 'iframe' });
  }

  async recordBuiltinLead(p: {
    accountId: string;
    siteId: string;
    leadId: string;
    conversationId: string | null;
    preview: boolean;
    pageUrl: string | null;
    occurredAt: Date;
  }): Promise<void> {
    // Предпросмотр/мастер по токену — не статистика (§5-тер.1).
    if (p.preview) return;
    const goals = await this.db.assistSiteGoal.findMany({
      where: { siteId: p.siteId, status: { in: ['active', 'stale'] } },
      select: {
        id: true,
        template: true,
        detectors: true,
        valueMode: true,
        fixedValue: true,
        currency: true,
      },
    });
    const builtin = goals.filter((g) =>
      storedDetectors(g.detectors, g.template).some(
        (d) => d.kind === 'builtin',
      ),
    );
    if (!builtin.length) return;
    // Посетитель-«бот» (suspicious) — не статистика.
    if (p.conversationId) {
      const conv = await this.db.assistSiteConversation.findFirst({
        where: { id: p.conversationId, siteId: p.siteId },
        select: { suspicious: true },
      });
      if (conv?.suspicious) return;
    }
    const data = builtin.map((g) => ({
      id: randomUUID(),
      accountId: p.accountId,
      siteId: p.siteId,
      goalId: g.id,
      occurredAt: p.occurredAt,
      receivedAt: this.now(),
      source: 'builtin',
      trust: 'builtin',
      // Одна заявка — одно событие цели, даже при повторном вызове.
      clientEventId: `lead:${p.leadId}:${g.id}`,
      orderId: null,
      value:
        g.valueMode === 'fixed' && g.fixedValue !== null ? g.fixedValue : null,
      currency: g.valueMode === 'fixed' ? g.currency : null,
      status: 'completed',
      path: cleanGoalPath(p.pageUrl),
      attribution: decideAttribution({
        source: 'builtin',
        occurredAt: p.occurredAt,
        lastAssistClickAt: null,
        conversationHasAnswer: false,
        conversationId: p.conversationId,
      }),
      assist: Prisma.DbNull,
      conversationId: p.conversationId,
    }));
    await this.db.assistSiteGoalEvent.createMany({
      data,
      skipDuplicates: true,
    });
    this.logger.log(`цель builtin записана (site ${p.siteId})`);
  }

  private async accept(p: {
    site: WidgetSiteContext;
    hit: GoalHit;
    rawIp: string | null;
    source: Extract<GoalEventSource, 'loader' | 'iframe'>;
    visitor: WidgetVisitor | null;
    conversationId: string | null;
    lastAssistClickAt: Date | null;
    assist: {
      proactive: string | null;
      scenario: string | null;
      link: boolean;
    } | null;
  }): Promise<GoalIntakeResult> {
    const { site, hit } = p;
    // Формат — сначала orderId: контакт в orderId — 422 (§5-тер.16 п.1),
    // даже если цель потом окажется неизвестной.
    if (hit.orderId !== null && hit.orderId !== undefined) {
      if (!validOrderId(hit.orderId)) return 'GOAL_ORDER_ID_INVALID';
    }
    if (
      typeof hit.goalKey !== 'string' ||
      !GOAL_KEY.test(hit.goalKey) ||
      typeof hit.docId !== 'string' ||
      !DOC_ID.test(hit.docId) ||
      !['url', 'click', 'form_submit', 'js'].includes(hit.detector)
    ) {
      return 'ignored';
    }
    if (site.preview) return 'ignored';
    const row = await this.db.assistSite.findUnique({
      where: { siteId: site.siteId },
      select: { analytics: true },
    });
    if (!row) return 'ignored';
    const cfg = effectiveAnalyticsConfig(row.analytics);
    // IP офиса заказчика — сырой IP, до хеширования; в событие не пишется.
    if (ipInCidrs(p.rawIp, cfg.officeCidrs)) return 'ignored';
    const path = cleanGoalPath(hit.path);
    if (path && cfg.excludedPaths.some((m) => pathMatchesMask(path, m))) {
      return 'ignored';
    }
    const goal = (await this.db.assistSiteGoal.findFirst({
      where: { siteId: site.siteId, key: hit.goalKey },
      select: {
        id: true,
        key: true,
        template: true,
        detectors: true,
        valueMode: true,
        fixedValue: true,
        currency: true,
        status: true,
      },
    })) as GoalRow | null;
    if (!goal || (goal.status !== 'active' && goal.status !== 'stale')) {
      return 'GOAL_UNKNOWN';
    }
    const detectors: GoalDetector[] = storedDetectors(
      goal.detectors,
      goal.template,
    );
    if (!detectors.some((d) => d.kind === hit.detector)) return 'GOAL_UNKNOWN';

    let conversationId: string | null = null;
    let hasAnswer = false;
    if (p.source === 'iframe' && p.visitor && p.conversationId) {
      const conv = await this.db.assistSiteConversation.findFirst({
        where: {
          id: p.conversationId,
          siteId: site.siteId,
          visitorId: p.visitor.visitorId,
        },
        select: { id: true, suspicious: true },
      });
      // Посетитель-«бот» — не статистика (§5-тер.1, §4.13 п.5).
      if (conv?.suspicious) return 'ignored';
      if (conv) {
        conversationId = conv.id;
        const answer = await this.db.assistSiteMessage.findFirst({
          where: {
            conversationId: conv.id,
            role: 'assistant',
            answerPath: { in: ['model', 'faq', 'cache'] },
            streamState: { in: ['complete', 'partial'] },
          },
          select: { id: true },
        });
        hasAnswer = answer !== null;
      }
    }

    const now = this.now();
    let occurredAt =
      hit.occurredAt instanceof Date && !Number.isNaN(hit.occurredAt.getTime())
        ? hit.occurredAt
        : now;
    if (
      occurredAt.getTime() < now.getTime() - HIT_PAST_MS ||
      occurredAt.getTime() > now.getTime() + HIT_FUTURE_MS
    ) {
      occurredAt = now;
    }
    const attribution: GoalAttribution = decideAttribution({
      source: p.source,
      occurredAt,
      lastAssistClickAt: p.lastAssistClickAt,
      conversationHasAnswer: hasAnswer,
      conversationId,
    });

    let value: Prisma.Decimal | number | null = null;
    let currency: string | null = null;
    if (goal.valueMode === 'fixed' && goal.fixedValue !== null) {
      value = goal.fixedValue;
      currency = goal.currency;
    } else if (goal.valueMode === 'event' && validGoalValue(hit.value)) {
      value = hit.value;
      currency =
        typeof hit.currency === 'string' && CURRENCY.test(hit.currency)
          ? hit.currency
          : goal.currency;
    }
    const orderId = hit.orderId ?? null;
    const assist = p.assist
      ? {
          proactive: shortKey(p.assist.proactive),
          scenario: shortKey(p.assist.scenario),
          link: p.assist.link === true,
        }
      : null;
    const r = await this.db.assistSiteGoalEvent.createMany({
      data: [
        {
          id: randomUUID(),
          accountId: site.accountId,
          siteId: site.siteId,
          goalId: goal.id,
          occurredAt,
          receivedAt: now,
          source: p.source,
          trust: 'page',
          clientEventId: orderId
            ? null
            : `${hit.docId}:${goal.key}:${hit.detector}`,
          orderId,
          value,
          currency,
          status: 'completed',
          path,
          attribution,
          assist: assist ?? Prisma.DbNull,
          conversationId,
        },
      ],
      skipDuplicates: true,
    });
    return r.count === 1 ? 'recorded' : 'duplicate';
  }
}

/** Ключ триггера/сценария из iframe — короткий идентификатор или null. */
function shortKey(v: unknown): string | null {
  return typeof v === 'string' && /^[A-Za-z0-9_:.-]{1,64}$/.test(v) ? v : null;
}
