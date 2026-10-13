/**
 * AI Publisher — обогащение заявок и событий, задание `lead-enrich` (P-D,
 * проектный документ §11.4 «Обогащение», §15.1; ТЗ §6, §14, §21;
 * AT-CORE-05, AT-F11-01/02). Основная роль (не `publisher_public`).
 *
 * Для заявки (идемпотентно по `leadId`, строка заявки — `FOR UPDATE`):
 *  - `contentSlugRaw/placementCodeRaw → contentId/placementId/campaignId`
 *    (размещение — только по РЕЕСТРУ `pub_placements.placementCode`, в т. ч.
 *    из `utm_content`; материал — slug формы, иначе посадочный материал
 *    сессии);
 *  - атрибуция по истории сессии (`core/attribution.ts`):
 *    `last_non_direct_30d` и отдельно первый известный; без допустимой
 *    истории — `coverage='unknown'`, догадки нет (AT-F11-02). Касания —
 *    сессия, её события и событие успеха самой формы;
 *  - проспект: точное совпадение `matchHash` → существующий, иначе новый
 *    (+ строка `pub_lead_prospect_links`);
 *  - сроки: `contactDueAt` — конец следующего рабочего дня Kyiv
 *    (`contact_sla`), `reviewDueAt` — `reviewDueForOpen` (не позже t72,
 *    если t72 впереди) или `closedAt + 90`, если менеджер ещё не записал
 *    своё основание хранения;
 *  - `pub_notifications` получателям (`sales`, `product_owner`; нет —
 *    владелец кабинета); в продуктах `kind≠working` — `suppressed`.
 * Строка `pub_lead_outbox` → `done`. Сбой — `failed` с кодом (без текста
 * данных), повтор через 5 мин; сохранённая заявка от сбоя не страдает.
 *
 * События без заявки (`content_view`, `cta_click`) и сессии с
 * `enrichedAt IS NULL` получают `contentId/placementId/channelGroup` тем же
 * проходом (`paid_placement` — только по реестру размещений).
 *
 * Кабинет вызывает обогащение вне очереди (`LeadEnrichPort.enrichNow`) —
 * при открытии карточки, где `enrichedAt` ещё пуст.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SitesDb } from '../../../prisma/sites-db.service';
import type { BusinessCalendar } from '../contracts/parameters';
import { DEFAULT_PARAMETER_VALUES } from '../contracts/parameters';
import type { ChannelGroup } from '../contracts/states';
import {
  classifyChannel,
  leadAttribution,
  type Touch,
} from '../core/attribution';
import { PubContribution } from '../core/contributions';
import {
  nextBusinessDayEnd,
  reviewDueForClosed,
  reviewDueForOpen,
} from '../core/kyiv-time';
import { OPERATION_TX_OPTIONS } from '../core/operation';
import type {
  CronJob,
  CronResult,
  LeadEnrichPort,
  ProductRef,
  PubCronContext,
  PubTx,
} from '../core/ports';
import { PILOT_CAMPAIGN_CODE } from '../core/product.service';
import { ProspectsService } from './prospects.service';
import { leadRecipientIds } from './recipients';

export const ENRICH_ACTOR = 'system:lead-enrich';
const OUTBOX_BATCH = 50;
const EVENTS_BATCH = 500;
const LEASE_MS = 2 * 60 * 1000;
const OUTBOX_MAX_ATTEMPTS = 10;
const CLOSED = ['rejected', 'won', 'lost'];

type Utm = Partial<
  Record<'source' | 'medium' | 'campaign' | 'content', string>
>;

const utmOf = (v: unknown): Utm =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Utm) : {};

/** Календарь `contact_sla` из параметра (кривой — умолчание ТЗ). */
export function calendarOf(v: unknown): BusinessCalendar {
  const c = (v as { calendar?: BusinessCalendar } | null)?.calendar;
  if (
    c &&
    Array.isArray(c.workdays) &&
    c.workdays.length > 0 &&
    Array.isArray(c.holidays) &&
    typeof c.dayEnd === 'string' &&
    /^([01]\d|2[0-3]):[0-5]\d$/.test(c.dayEnd)
  ) {
    return c;
  }
  return DEFAULT_PARAMETER_VALUES.contact_sla.calendar;
}

/** Контекст продукта для классификации касаний. */
export interface EnrichContext {
  ownHosts: string[];
  /** Код размещения → {id, campaignId}. */
  placements: Map<string, { id: string; campaignId: string }>;
  /** slug → id материала. */
  contents: Map<string, string>;
}

export async function enrichContextOf(
  tx: PubTx,
  product: ProductRef,
  siteId: string,
): Promise<EnrichContext> {
  const [hosts, placements, contents] = await Promise.all([
    tx.siteHost.findMany({
      where: { siteId },
      select: { host: true, port: true },
    }),
    tx.pubPlacement.findMany({
      where: { productId: product.id },
      select: { id: true, placementCode: true, campaignId: true },
    }),
    tx.pubContent.findMany({
      where: { productId: product.id, slug: { not: null } },
      select: { id: true, slug: true },
    }),
  ]);
  return {
    ownHosts: hosts.map((h) =>
      h.port === 443 ? h.host : `${h.host}:${h.port}`,
    ),
    placements: new Map(
      placements.map((p) => [
        p.placementCode,
        { id: p.id, campaignId: p.campaignId },
      ]),
    ),
    contents: new Map(
      contents.filter((c) => c.slug).map((c) => [c.slug as string, c.id]),
    ),
  };
}

/** Размещение по коду (поле формы/события или `utm_content`) — только из реестра. */
export function placementOf(
  ctx: EnrichContext,
  code: string | null,
  utm: Utm,
): { id: string; campaignId: string } | null {
  for (const c of [code, utm.content ?? null]) {
    if (c && ctx.placements.has(c)) return ctx.placements.get(c) ?? null;
  }
  return null;
}

/** Поля обогащения строки события/сессии. */
export function classifyTouch(
  ctx: EnrichContext,
  t: {
    placementCodeRaw: string | null;
    contentSlugRaw: string | null;
    utm: unknown;
    referrerHost: string | null;
  },
): {
  placementId: string | null;
  campaignId: string | null;
  contentId: string | null;
  channelGroup: ChannelGroup;
  source: string | null;
} {
  const utm = utmOf(t.utm);
  const placement = placementOf(ctx, t.placementCodeRaw, utm);
  const channelGroup = classifyChannel({
    placementId: placement?.id ?? null,
    utmMedium: utm.medium ?? null,
    referrerHost: t.referrerHost,
    ownHosts: ctx.ownHosts,
  });
  return {
    placementId: placement?.id ?? null,
    campaignId: placement?.campaignId ?? null,
    contentId: t.contentSlugRaw
      ? (ctx.contents.get(t.contentSlugRaw) ?? null)
      : null,
    channelGroup,
    source: utm.source ?? t.referrerHost ?? null,
  };
}

type LeadForEnrich = {
  id: string;
  sessionRef: string | null;
  contentSlugRaw: string | null;
  placementCodeRaw: string | null;
  receivedAt: Date;
  status: string;
  closedAt: Date | null;
  prospectId: string | null;
  erasedAt: Date | null;
  retentionBasis: string | null;
  contactDueAt: Date | null;
  enrichedAt: Date | null;
};

@Injectable()
export class LeadEnrichService implements LeadEnrichPort {
  constructor(
    private readonly db: SitesDb,
    private readonly prospects: ProspectsService,
  ) {}

  /** LeadEnrichPort: обогащение вне очереди (открытие карточки). */
  async enrichNow(product: ProductRef, leadId: string): Promise<void> {
    await this.db
      .forAccount(product.accountId)
      .$transaction(
        (tx) => this.enrichInTx(tx, product, leadId, new Date()),
        OPERATION_TX_OPTIONS,
      );
  }

  /**
   * Обогатить заявку в транзакции кабинета. Повтор безопасен: проспект и
   * уведомления создаются один раз, сроки ретенции с основанием менеджера
   * не перетираются. false — заявки нет.
   */
  async enrichInTx(
    tx: PubTx,
    product: ProductRef,
    leadId: string,
    now: Date,
  ): Promise<boolean> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "sites"."pub_leads"
       WHERE "id" = ${leadId} AND "productId" = ${product.id}
         AND "accountId" = ${product.accountId}
       FOR UPDATE`;
    if (!locked.length) return false;
    const lead = (await tx.pubLead.findFirst({
      where: { id: leadId, productId: product.id },
      select: {
        id: true,
        sessionRef: true,
        contentSlugRaw: true,
        placementCodeRaw: true,
        receivedAt: true,
        status: true,
        closedAt: true,
        prospectId: true,
        erasedAt: true,
        retentionBasis: true,
        contactDueAt: true,
        enrichedAt: true,
      },
    })) as LeadForEnrich | null;
    if (!lead) return false;
    const prod = await tx.pubProduct.findFirst({
      where: { id: product.id },
      select: { siteId: true, kind: true },
    });
    if (!prod) return false;
    const ctx = await enrichContextOf(tx, product, prod.siteId);
    const params = await tx.pubParameter.findMany({
      where: { productId: product.id, key: { in: ['contact_sla'] } },
      select: { key: true, value: true },
    });
    const sla = params.find((p) => p.key === 'contact_sla')?.value;
    const pilot = await tx.pubExperiment.findFirst({
      where: { productId: product.id, kind: 'pilot' },
      orderBy: { version: 'desc' },
      select: { t72: true },
    });

    // Касания: сессия, её события и событие успеха формы.
    const session = lead.sessionRef
      ? await tx.pubSession.findFirst({
          where: { productId: product.id, sessionRef: lead.sessionRef },
          select: {
            id: true,
            startedAt: true,
            utm: true,
            placementCodeRaw: true,
            contentSlugRaw: true,
            enrichedAt: true,
          },
        })
      : null;
    const events = await tx.pubEvent.findMany({
      where: {
        productId: product.id,
        OR: [
          { leadId: lead.id },
          ...(lead.sessionRef ? [{ sessionRef: lead.sessionRef }] : []),
        ],
      },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        name: true,
        occurredAt: true,
        utm: true,
        placementCodeRaw: true,
        contentSlugRaw: true,
        referrerHost: true,
        enrichedAt: true,
      },
    });
    const touches: Touch[] = [];
    if (session) {
      const firstRef = events.find((e) => e.referrerHost)?.referrerHost ?? null;
      const c = classifyTouch(ctx, {
        placementCodeRaw: session.placementCodeRaw,
        contentSlugRaw: session.contentSlugRaw,
        utm: session.utm,
        referrerHost: firstRef,
      });
      touches.push({
        at: session.startedAt,
        channelGroup: c.channelGroup,
        source: c.source,
        placementId: c.placementId,
      });
      if (!session.enrichedAt) {
        await tx.pubSession.update({
          where: { id: session.id },
          data: {
            landingContentId: c.contentId,
            placementId: c.placementId,
            channelGroup: c.channelGroup,
            enrichedAt: now,
          },
        });
      }
    }
    let sessionContentId: string | null = null;
    for (const e of events) {
      const c = classifyTouch(ctx, e);
      if (
        !sessionContentId &&
        c.contentId &&
        e.name !== 'lead_submit_success'
      ) {
        sessionContentId = c.contentId;
      }
      touches.push({
        at: e.occurredAt,
        channelGroup: c.channelGroup,
        source: c.source,
        placementId: c.placementId,
      });
      if (!e.enrichedAt) {
        await tx.pubEvent.update({
          where: { id: e.id },
          data: {
            contentId: c.contentId,
            placementId: c.placementId,
            channelGroup: c.channelGroup,
            enrichedAt: now,
            updatedAt: now,
          },
        });
      }
    }
    const attribution = leadAttribution(touches, lead.receivedAt);
    const own = classifyTouch(ctx, {
      placementCodeRaw: lead.placementCodeRaw,
      contentSlugRaw: lead.contentSlugRaw,
      utm: null,
      referrerHost: null,
    });
    const placementId =
      attribution.last?.placementId ?? own.placementId ?? null;
    const placement = placementId
      ? ([...ctx.placements.values()].find((p) => p.id === placementId) ?? null)
      : null;
    const contentId =
      own.contentId ??
      (session?.contentSlugRaw
        ? (ctx.contents.get(session.contentSlugRaw) ?? null)
        : null) ??
      sessionContentId;
    let campaignId = placement?.campaignId ?? null;
    if (!campaignId) {
      const lastUtm = [...events]
        .reverse()
        .map((e) => utmOf(e.utm))
        .find((u) => u.campaign);
      const code = lastUtm?.campaign ?? PILOT_CAMPAIGN_CODE;
      const camp =
        (await tx.pubCampaign.findFirst({
          where: { productId: product.id, code },
          select: { id: true },
        })) ??
        (await tx.pubCampaign.findFirst({
          where: { productId: product.id, code: PILOT_CAMPAIGN_CODE },
          select: { id: true },
        }));
      campaignId = camp?.id ?? null;
    }

    if (!lead.prospectId && !lead.erasedAt) {
      const r = await this.prospects.resolveForIntake(
        tx,
        product,
        lead.id,
        ENRICH_ACTOR,
      );
      await this.prospects.link(
        tx,
        product,
        lead.id,
        r.prospectId,
        r.reason,
        ENRICH_ACTOR,
        now,
      );
    }

    const scalar: Record<string, unknown> = {
      attribution: attribution as unknown as Prisma.InputJsonValue,
      campaignId,
      contentId,
      placementId,
      enrichedAt: now,
    };
    if (!lead.contactDueAt) {
      scalar.contactDueAt = nextBusinessDayEnd(
        lead.receivedAt,
        calendarOf(sla),
      );
    }
    if (!lead.retentionBasis && !lead.erasedAt) {
      scalar.reviewDueAt =
        CLOSED.includes(lead.status) && lead.closedAt
          ? reviewDueForClosed(lead.closedAt)
          : reviewDueForOpen(lead.receivedAt, pilot?.t72 ?? null, null);
    }
    await tx.pubLead.updateMany({
      where: { id: lead.id, productId: product.id },
      data: scalar,
    });

    // Уведомления (один раз на получателя; не рабочий продукт — подавлены).
    if (!lead.enrichedAt) {
      const recipients = await leadRecipientIds(tx, product);
      if (recipients.length) {
        await tx.pubNotification.createMany({
          data: recipients.map((memberId) => ({
            accountId: product.accountId,
            productId: product.id,
            leadId: lead.id,
            kind: 'new_lead',
            recipientMemberId: memberId,
            status: prod.kind === 'working' ? 'pending' : 'suppressed',
            nextAttemptAt: now,
            createdBy: ENRICH_ACTOR,
          })),
          skipDuplicates: true,
        });
      }
    }
    await tx.pubLeadOutbox.updateMany({
      where: {
        leadId: lead.id,
        productId: product.id,
        status: { not: 'done' },
      },
      data: { status: 'done', leaseUntil: null, lastErrorCode: null },
    });
    return true;
  }

  /** События и сессии без заявки, ещё не обогащённые (партия продукта). */
  async enrichPendingEvents(
    tx: PubTx,
    product: ProductRef,
    siteId: string,
    now: Date,
    limit = EVENTS_BATCH,
  ): Promise<number> {
    const events = await tx.pubEvent.findMany({
      where: { productId: product.id, enrichedAt: null },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: {
        id: true,
        utm: true,
        placementCodeRaw: true,
        contentSlugRaw: true,
        referrerHost: true,
      },
    });
    const sessions = await tx.pubSession.findMany({
      where: { productId: product.id, enrichedAt: null },
      orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: {
        id: true,
        sessionRef: true,
        utm: true,
        placementCodeRaw: true,
        contentSlugRaw: true,
      },
    });
    if (!events.length && !sessions.length) return 0;
    const ctx = await enrichContextOf(tx, product, siteId);
    for (const e of events) {
      const c = classifyTouch(ctx, e);
      await tx.pubEvent.update({
        where: { id: e.id },
        data: {
          contentId: c.contentId,
          placementId: c.placementId,
          channelGroup: c.channelGroup,
          enrichedAt: now,
          updatedAt: now,
        },
      });
    }
    for (const s of sessions) {
      const first = await tx.pubEvent.findFirst({
        where: {
          productId: product.id,
          sessionRef: s.sessionRef,
          referrerHost: { not: null },
        },
        orderBy: { occurredAt: 'asc' },
        select: { referrerHost: true },
      });
      const c = classifyTouch(ctx, {
        ...s,
        referrerHost: first?.referrerHost ?? null,
      });
      await tx.pubSession.update({
        where: { id: s.id },
        data: {
          landingContentId: c.contentId,
          placementId: c.placementId,
          channelGroup: c.channelGroup,
          enrichedAt: now,
        },
      });
    }
    return events.length + sessions.length;
  }
  /**
   * Поздняя регистрация размещения (аудит P-D S3-11): события и сессии,
   * обогащённые ДО внесения кода в реестр (`placementId` пуст, а сырой код
   * или `utm_content` теперь в реестре), переклассифицируются в
   * `paid_placement`; заявки этих сессий (и с таким же своим кодом)
   * переобогащаются — атрибуция, размещение и кампания пересчитываются.
   * Возвращает число исправленных строк событий и сессий.
   */
  async reclassifyLate(
    tx: PubTx,
    product: ProductRef,
    siteId: string,
    now: Date,
    limit = EVENTS_BATCH,
  ): Promise<number> {
    const ctx = await enrichContextOf(tx, product, siteId);
    const codes = [...ctx.placements.keys()];
    if (!codes.length) return 0;
    const events = await tx.$queryRaw<
      Array<{
        id: string;
        sessionRef: string | null;
        utm: unknown;
        placementCodeRaw: string | null;
        contentSlugRaw: string | null;
        referrerHost: string | null;
      }>
    >`
      SELECT "id", "sessionRef", "utm", "placementCodeRaw", "contentSlugRaw", "referrerHost"
        FROM "sites"."pub_events"
       WHERE "productId" = ${product.id} AND "enrichedAt" IS NOT NULL
         AND "placementId" IS NULL
         AND ("placementCodeRaw" = ANY(${codes}::text[])
              OR "utm" ->> 'content' = ANY(${codes}::text[]))
       ORDER BY "occurredAt", "id"
       LIMIT ${limit}`;
    const sessions = await tx.$queryRaw<
      Array<{
        id: string;
        sessionRef: string;
        utm: unknown;
        placementCodeRaw: string | null;
        contentSlugRaw: string | null;
      }>
    >`
      SELECT "id", "sessionRef", "utm", "placementCodeRaw", "contentSlugRaw"
        FROM "sites"."pub_sessions"
       WHERE "productId" = ${product.id} AND "enrichedAt" IS NOT NULL
         AND "placementId" IS NULL
         AND ("placementCodeRaw" = ANY(${codes}::text[])
              OR "utm" ->> 'content' = ANY(${codes}::text[]))
       ORDER BY "startedAt", "id"
       LIMIT ${limit}`;
    const refs = new Set<string>();
    for (const e of events) {
      const c = classifyTouch(ctx, e);
      if (!c.placementId) continue;
      await tx.pubEvent.update({
        where: { id: e.id },
        data: {
          placementId: c.placementId,
          channelGroup: c.channelGroup,
          enrichedAt: now,
          updatedAt: now,
        },
      });
      if (e.sessionRef) refs.add(e.sessionRef);
    }
    for (const s of sessions) {
      const first = await tx.pubEvent.findFirst({
        where: {
          productId: product.id,
          sessionRef: s.sessionRef,
          referrerHost: { not: null },
        },
        orderBy: { occurredAt: 'asc' },
        select: { referrerHost: true },
      });
      const c = classifyTouch(ctx, {
        ...s,
        referrerHost: first?.referrerHost ?? null,
      });
      if (!c.placementId) continue;
      await tx.pubSession.update({
        where: { id: s.id },
        data: {
          placementId: c.placementId,
          channelGroup: c.channelGroup,
          enrichedAt: now,
        },
      });
      refs.add(s.sessionRef);
    }
    const leads = await tx.pubLead.findMany({
      where: {
        productId: product.id,
        erasedAt: null,
        enrichedAt: { not: null },
        OR: [
          ...(refs.size ? [{ sessionRef: { in: [...refs] } }] : []),
          { placementId: null, placementCodeRaw: { in: codes } },
        ],
      },
      select: { id: true },
      take: limit,
    });
    for (const l of leads) await this.enrichInTx(tx, product, l.id, now);
    return events.length + sessions.length;
  }
}

type LeasedOutbox = {
  id: string;
  accountId: string;
  productId: string;
  leadId: string;
  createdAt: Date;
};

@Injectable()
@PubContribution('cron-job')
export class LeadEnrichJob implements CronJob {
  readonly key = 'lead-enrich';
  readonly schedule = 'tick' as const;
  private readonly logger = new Logger('PublisherLeadEnrich');

  constructor(
    private readonly db: SitesDb,
    private readonly enrich: LeadEnrichService,
  ) {}

  async run(ctx: PubCronContext): Promise<CronResult> {
    const system = this.db.system(
      'крон publisher lead-enrich: исходящая очередь заявок всех кабинетов',
    );
    const scope = ctx.scope
      ? Prisma.sql`AND p."siteId" = ANY(${ctx.scope.siteIds}::text[])`
      : Prisma.empty;
    let done = 0;
    let failed = 0;
    for (;;) {
      if (Date.now() > ctx.deadline.getTime()) break;
      const leased = await system.$queryRaw<LeasedOutbox[]>`
        UPDATE "sites"."pub_lead_outbox" o
           SET "status" = 'processing', "leaseUntil" = ${new Date(ctx.now.getTime() + LEASE_MS)},
               "attempts" = o."attempts" + 1, "updatedAt" = ${ctx.now}
         WHERE o."id" IN (
           SELECT o2."id" FROM "sites"."pub_lead_outbox" o2
             JOIN "sites"."pub_products" p ON p."id" = o2."productId"
            WHERE p."kind" IN ('working', 'test') AND p."status" = 'active' ${scope}
              AND (o2."status" = 'pending'
                   OR (o2."status" = 'processing' AND o2."leaseUntil" < ${ctx.now})
                   OR (o2."status" = 'failed' AND o2."attempts" < ${OUTBOX_MAX_ATTEMPTS}
                       AND o2."updatedAt" < ${new Date(ctx.now.getTime() - 5 * 60 * 1000)}))
            ORDER BY o2."createdAt"
            LIMIT ${OUTBOX_BATCH}
            FOR UPDATE OF o2 SKIP LOCKED)
        RETURNING o."id", o."accountId", o."productId", o."leadId", o."createdAt"`;
      if (!leased.length) break;
      // RETURNING порядок не держит: заявки — в порядке поступления (первая
      // заявка человека создаёт проспект, следующие к нему присоединяются).
      leased.sort(
        (a, b) =>
          a.createdAt.getTime() - b.createdAt.getTime() ||
          a.id.localeCompare(b.id),
      );
      for (const row of leased) {
        const product = { id: row.productId, accountId: row.accountId };
        try {
          await this.db
            .forAccount(row.accountId)
            .$transaction(
              (tx) => this.enrich.enrichInTx(tx, product, row.leadId, ctx.now),
              OPERATION_TX_OPTIONS,
            );
          done++;
        } catch (e) {
          failed++;
          const code = errorCodeOf(e);
          this.logger.warn(`lead-enrich: заявка ${row.leadId} — ${code}`);
          await system.pubLeadOutbox.updateMany({
            where: { id: row.id },
            data: { status: 'failed', leaseUntil: null, lastErrorCode: code },
          });
        }
      }
      if (leased.length < OUTBOX_BATCH) break;
    }
    // События и сессии без заявок.
    let events = 0;
    const products = await system.$queryRaw<
      Array<{ id: string; accountId: string; siteId: string }>
    >`
      SELECT DISTINCT p."id", p."accountId", p."siteId"
        FROM "sites"."pub_products" p
       WHERE p."kind" IN ('working', 'test') AND p."status" = 'active' ${scope}
         AND (EXISTS (SELECT 1 FROM "sites"."pub_events" e
                       WHERE e."productId" = p."id" AND e."enrichedAt" IS NULL)
              OR EXISTS (SELECT 1 FROM "sites"."pub_sessions" s
                          WHERE s."productId" = p."id" AND s."enrichedAt" IS NULL))
       LIMIT 50`;
    for (const p of products) {
      if (Date.now() > ctx.deadline.getTime()) break;
      events += await this.db
        .forAccount(p.accountId)
        .$transaction(
          (tx) =>
            this.enrich.enrichPendingEvents(
              tx,
              { id: p.id, accountId: p.accountId },
              p.siteId,
              ctx.now,
            ),
          OPERATION_TX_OPTIONS,
        );
    }
    // Позднее размещение: строки, классифицированные до внесения кода.
    let reclassified = 0;
    const late = await system.$queryRaw<
      Array<{ id: string; accountId: string; siteId: string }>
    >`
      SELECT DISTINCT p."id", p."accountId", p."siteId"
        FROM "sites"."pub_products" p
        JOIN "sites"."pub_placements" pl ON pl."productId" = p."id"
       WHERE p."kind" IN ('working', 'test') AND p."status" = 'active' ${scope}
         AND (EXISTS (SELECT 1 FROM "sites"."pub_events" e
                       WHERE e."productId" = p."id" AND e."placementId" IS NULL
                         AND e."enrichedAt" IS NOT NULL
                         AND (e."placementCodeRaw" = pl."placementCode"
                              OR e."utm" ->> 'content' = pl."placementCode"))
              OR EXISTS (SELECT 1 FROM "sites"."pub_sessions" s
                          WHERE s."productId" = p."id" AND s."placementId" IS NULL
                            AND s."enrichedAt" IS NOT NULL
                            AND (s."placementCodeRaw" = pl."placementCode"
                                 OR s."utm" ->> 'content' = pl."placementCode")))
       LIMIT 50`;
    for (const p of late) {
      if (Date.now() > ctx.deadline.getTime()) break;
      reclassified += await this.db
        .forAccount(p.accountId)
        .$transaction(
          (tx) =>
            this.enrich.reclassifyLate(
              tx,
              { id: p.id, accountId: p.accountId },
              p.siteId,
              ctx.now,
            ),
          OPERATION_TX_OPTIONS,
        );
    }
    return {
      processed: done + events + reclassified,
      details: {
        leadsEnriched: done,
        leadsFailed: failed,
        eventsEnriched: events,
        reclassified,
      },
    };
  }
}

/** Код ошибки для `lastErrorCode` (без текста — там могут быть данные). */
export function errorCodeOf(e: unknown): string {
  const o = (e ?? {}) as { code?: unknown; name?: unknown };
  const code = typeof o.code === 'string' ? o.code : null;
  const name = typeof o.name === 'string' ? o.name : 'Error';
  return (code ?? name).slice(0, 100);
}
