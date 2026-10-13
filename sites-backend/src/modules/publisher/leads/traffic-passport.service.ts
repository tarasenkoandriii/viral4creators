/**
 * AI Publisher — паспорт трафика F11 (P-D, проектный документ §11.3
 * `GET …/traffic/passport`, §9.3; ТЗ §14–15; AT-F11-01/02): цепочка
 * публикация/размещение → сессии → события → заявки (обезличенно),
 * покрытие технической связи и CPL рядом.
 *
 * Правила ТЗ:
 *  - тестовые сессии/события/заявки исключаются (`testFlag`), считаются
 *    отдельно для диагностики (AT-CORE-06);
 *  - неизвестные обращения не распределяются по каналам: связанные и
 *    неизвестные — отдельными числами, покрытие — `Computable`;
 *  - при `analytics_storage='none'` сессии не измеряются — `null`
 *    («не измеряется» ≠ 0).
 *
 * Квалифицированные проспекты, покрытие и CPL (аудит P-D S2-2) — НЕ свой
 * расчёт, а чистая `computeReport` отчётов P-E (`reports/metrics`, §9.3–9.4)
 * над входами того же вида, что `ReportsService.buildInputs`, за период
 * паспорта как снимок `ad_hoc` на «сейчас»:
 *  - один проспект — одна связь: первая квалифицированная заявка → её
 *    сессия в 30-дневном окне → размещение сессии (`primarySessionOfProspect`
 *    по основной модели); проспект с заявками из двух размещений засчитан
 *    один раз;
 *  - прямой CPL = `directCpl(Σ подтверждённых deliver + adjust, связанные
 *    проспекты размещения)`, округление вверх; нулевой знаменатель —
 *    `not_computable` с числителем;
 *  - продуктовый CPL = `productCpl(операционная стоимость, все внешние
 *    квалифицированные)` — как в отчёте P-E.
 * Сверка с отчётом P-E — `leads-traffic-passport.spec` (S2-2).
 */
import { Injectable } from '@nestjs/common';
import type { TrafficPassport } from '../contracts/leads-api';
import type { Computable, MinorJson } from '../contracts/common';
import type { LeadStatus } from '../contracts/states';
import {
  DEFAULT_PARAMETER_VALUES,
  type ParameterValues,
} from '../contracts/parameters';
import { validationError } from '../core/errors';
import type { ProductRef, PubTx } from '../core/ports';
import {
  computeReport,
  type ReportInputs,
} from '../reports/metrics/report-compute';
import {
  leadInSessionWindow,
  prospectAt,
  QUALIFIED_STATUSES,
  statusAt,
  uniqueQualifiedProspects,
} from '../reports/metrics/cohorts';
import { trapKey } from '../public/rate-limit';

const HOUR_MS = 60 * 60 * 1000;

/** Проспекты с основной технической связью (как `computeReport`): pid → заявка. */
export function primaryLinkedLeads(i: ReportInputs): Map<string, string> {
  const snap = i.snapshotAt;
  const sessions = new Map(
    i.sessions
      .filter(
        (s) =>
          !s.testFlag &&
          s.startedAt.getTime() >= i.periodStart.getTime() &&
          s.startedAt.getTime() < i.periodEnd.getTime() &&
          s.startedAt.getTime() <= snap.getTime(),
      )
      .map((s) => [s.sessionRef, s]),
  );
  const inPeriod = i.leads.filter(
    (l) =>
      !l.testFlag &&
      l.receivedAt.getTime() >= i.periodStart.getTime() &&
      l.receivedAt.getTime() < i.periodEnd.getTime() &&
      l.receivedAt.getTime() <= snap.getTime(),
  );
  const leadIds = new Set(inPeriod.map((l) => l.id));
  const qualified = uniqueQualifiedProspects(
    i.leads,
    i.decisions,
    i.links,
    i.prospects,
    snap,
    { externalOnly: true, leadIds },
  );
  const first = new Map<string, (typeof inPeriod)[number]>();
  for (const l of inPeriod) {
    if (!QUALIFIED_STATUSES.includes(statusAt(i.decisions, l.id, snap)))
      continue;
    const pid = prospectAt(i.links, l.id, snap);
    if (!pid || !qualified.has(pid)) continue;
    const prev = first.get(pid);
    if (
      !prev ||
      l.receivedAt.getTime() < prev.receivedAt.getTime() ||
      (l.receivedAt.getTime() === prev.receivedAt.getTime() && l.id < prev.id)
    ) {
      first.set(pid, l);
    }
  }
  const out = new Map<string, string>();
  for (const [pid, l] of first) {
    const s = l.sessionRef ? sessions.get(l.sessionRef) : undefined;
    if (s && leadInSessionWindow(l, s)) out.set(pid, l.id);
  }
  return out;
}

function dateParam(v: unknown, field: string): Date | null {
  if (v === undefined || v === '') return null;
  if (typeof v !== 'string') throw validationError([{ field, code: 'type' }]);
  const d = new Date(v);
  if (Number.isNaN(d.getTime()))
    throw validationError([{ field, code: 'format' }]);
  return d;
}

/** Значение параметра или умолчание (как `ReportsService.buildInputs`). */
type ParamRow = { key: string; value: unknown; status: string };

@Injectable()
export class TrafficPassportService {
  /**
   * Входы `computeReport` (вид `ad_hoc`, без эксперимента) — те же поля и
   * отборы, что `ReportsService.buildInputs` P-E, кроме не влияющих на
   * паспорт (оплаты, импорт метрик, интеграции).
   */
  async reportInputs(
    tx: PubTx,
    productId: string,
    periodStart: Date,
    periodEnd: Date,
    now: Date,
  ): Promise<ReportInputs> {
    const params = (await tx.pubParameter.findMany({
      where: {
        productId,
        key: {
          in: [
            'analytics_storage',
            'rates_by_role',
            'ai_fx_rate',
            'allowed_cpl_inputs',
            'cac_payment_window',
            'budget_total',
          ],
        },
      },
      select: { key: true, value: true, status: true },
    })) as ParamRow[];
    const p = new Map(params.map((r) => [r.key, r]));
    const val = <K extends keyof ParameterValues>(k: K): ParameterValues[K] =>
      (p.get(k)?.value ?? DEFAULT_PARAMETER_VALUES[k]) as ParameterValues[K];
    const approved = (k: string) => p.get(k)?.status === 'approved';
    const [
      sessions,
      leads,
      decisions,
      links,
      prospects,
      placements,
      expenses,
      aiMonths,
      entries,
      time,
      ai,
    ] = await Promise.all([
      tx.pubSession.findMany({
        where: { productId },
        select: {
          sessionRef: true,
          startedAt: true,
          testFlag: true,
          placementId: true,
          channelGroup: true,
        },
      }),
      tx.pubLead.findMany({
        where: { productId },
        select: {
          id: true,
          receivedAt: true,
          testFlag: true,
          sessionRef: true,
          campaignId: true,
          placementId: true,
        },
      }),
      tx.pubLeadDecision.findMany({
        where: { productId },
        select: { id: true, leadId: true, toStatus: true, decidedAt: true },
        orderBy: [{ decidedAt: 'asc' }, { createdAt: 'asc' }],
      }),
      tx.pubLeadProspectLink.findMany({
        where: { productId },
        select: { leadId: true, prospectId: true, validFrom: true },
        orderBy: [{ validFrom: 'asc' }, { createdAt: 'asc' }],
      }),
      tx.pubProspect.findMany({
        where: { productId },
        select: { id: true, isExternal: true, isTeamOrPartner: true },
      }),
      tx.pubPlacement.findMany({
        where: { productId },
        select: { id: true, placementCode: true, publishedAt: true },
      }),
      tx.pubExpense.findMany({
        where: { productId },
        select: { id: true, category: true, placementId: true },
      }),
      tx.pubAiBudgetMonth.findMany({
        where: { productId, expenseId: { not: null } },
        select: { expenseId: true },
      }),
      tx.pubExpenseEntry.findMany({
        where: { productId },
        select: {
          expenseId: true,
          kind: true,
          status: true,
          amountMinor: true,
          occurredAt: true,
          confirmedAt: true,
        },
      }),
      tx.pubTimeEntry.findMany({
        where: { productId },
        select: {
          minutes: true,
          role: true,
          rateMinorPerHour: true,
          isInvestment: true,
          workDate: true,
        },
      }),
      tx.pubAiCall.findMany({
        where: { productId },
        select: { costMicroUsd: true, costStatus: true, requestedAt: true },
      }),
    ]);
    type I = ReportInputs;
    const aiMonthExpenses = new Set(aiMonths.map((m) => m.expenseId as string));
    const rates = val('rates_by_role');
    const fx = val('ai_fx_rate');
    return {
      kind: 'ad_hoc',
      periodStart,
      periodEnd,
      snapshotAt: now,
      currency: val('budget_total').currency,
      experiment: null,
      sessionMode:
        val('analytics_storage') === 'session'
          ? 'session_ref'
          : 'imported_aggregate',
      sessions: sessions.map((s) => ({
        ...s,
        channelGroup: s.channelGroup as I['sessions'][number]['channelGroup'],
      })),
      aggregates: [],
      leads,
      decisions: decisions.map((d) => ({
        ...d,
        toStatus: d.toStatus as LeadStatus,
      })),
      links,
      prospects,
      payments: [],
      placements,
      expenses: expenses.map((e) => ({
        id: e.id,
        category: e.category as I['expenses'][number]['category'],
        placementId: e.placementId,
        aiMonth: aiMonthExpenses.has(e.id),
      })),
      expenseEntries: entries.map((e) => ({
        ...e,
        kind: e.kind as I['expenseEntries'][number]['kind'],
        status: e.status as I['expenseEntries'][number]['status'],
      })),
      timeEntries: time.map((t) => ({
        minutes: t.minutes,
        role: t.role,
        rateMinorPerHour: t.rateMinorPerHour,
        isInvestment: t.isInvestment,
        workDate: t.workDate.toISOString().slice(0, 10),
      })),
      aiCalls: ai.map((c) => ({
        costMicroUsd: c.costMicroUsd,
        costStatus: c.costStatus as I['aiCalls'][number]['costStatus'],
        requestedAt: c.requestedAt,
      })),
      rates: {
        approved: approved('rates_by_role'),
        rates: rates.rates as Record<string, number | null>,
      },
      aiFxRate: approved('ai_fx_rate') ? fx.rate : null,
      allowedCplInputs: {
        ...val('allowed_cpl_inputs'),
        approved: approved('allowed_cpl_inputs'),
      },
      cacWindow: val('cac_payment_window'),
      searchDays: [],
      integrations: [],
    };
  }

  async passport(
    tx: PubTx,
    product: ProductRef,
    q: {
      contentId?: unknown;
      placementId?: unknown;
      from?: unknown;
      to?: unknown;
    },
    now: Date = new Date(),
  ): Promise<TrafficPassport> {
    const productId = product.id;
    const contentId =
      typeof q.contentId === 'string' && q.contentId ? q.contentId : null;
    const placementId =
      typeof q.placementId === 'string' && q.placementId ? q.placementId : null;
    const from = dateParam(q.from, 'from');
    const to = dateParam(q.to, 'to');
    if (from && to && from.getTime() >= to.getTime()) {
      throw validationError([{ field: 'to', code: 'range' }]);
    }
    const period = (col: string) => ({
      ...(from || to
        ? {
            [col]: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lt: to } : {}),
            },
          }
        : {}),
    });
    const storage = await tx.pubParameter.findFirst({
      where: { productId, key: 'analytics_storage' },
      select: { value: true },
    });
    const sessionMode = storage?.value === 'session' ? 'session_ref' : 'none';

    const publications = contentId
      ? await tx.pubPublication.findMany({
          where: { productId, version: { contentId } },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            finalUrl: true,
            stage: true,
            status: true,
            publishedAt: true,
          },
        })
      : [];
    const placement = placementId
      ? await tx.pubPlacement.findFirst({
          where: { id: placementId, productId },
          select: {
            id: true,
            placementCode: true,
            status: true,
            publishedAt: true,
          },
        })
      : null;
    if (placementId && !placement)
      throw validationError([{ field: 'placementId', code: 'not_found' }]);

    const eventWhere = {
      productId,
      testFlag: false,
      ...(contentId ? { contentId } : {}),
      ...(placementId ? { placementId } : {}),
      ...period('occurredAt'),
    };
    const byName = await tx.pubEvent.groupBy({
      by: ['name'],
      where: eventWhere,
      _count: { _all: true },
    });
    const byGroup = await tx.pubEvent.groupBy({
      by: ['channelGroup'],
      where: eventWhere,
      _count: { _all: true },
    });
    const sessions =
      sessionMode === 'session_ref'
        ? await tx.pubSession.count({
            where: {
              productId,
              testFlag: false,
              ...(contentId ? { landingContentId: contentId } : {}),
              ...(placementId ? { placementId } : {}),
              ...period('startedAt'),
            },
          })
        : null;

    const leads = await tx.pubLead.findMany({
      where: { productId, ...period('receivedAt') },
      select: {
        id: true,
        testFlag: true,
        contentId: true,
        placementId: true,
        enrichedAt: true,
      },
    });
    const filtered = leads.filter(
      (l) =>
        (!contentId || l.contentId === contentId) &&
        (!placementId || l.placementId === placementId),
    );

    // ── Квалификация, покрытие, CPL — расчёт отчёта P-E (S2-2) ───────────
    const created = await tx.pubProduct.findFirst({
      where: { id: productId },
      select: { createdAt: true },
    });
    const periodStart = from ?? created?.createdAt ?? new Date(0);
    const periodEnd =
      to ?? new Date(Math.max(now.getTime(), periodStart.getTime()) + 1);
    const inputs = await this.reportInputs(
      tx,
      productId,
      periodStart,
      periodEnd,
      now,
    );
    const c = computeReport(inputs);
    const m = c.metrics as {
      leads: {
        qualifiedUnique: number;
        linkedQualified: number;
        unknownQualified: number;
        coverage: Computable<number>;
      };
      economics: {
        directCpl: Computable<MinorJson>;
        productCpl: Computable<MinorJson>;
      };
      placements: Array<{
        id: string;
        technicalQualified: number;
        directCpl: Computable<MinorJson>;
      }>;
    };
    const row = placementId
      ? (m.placements.find((r) => r.id === placementId) ?? null)
      : null;
    let linked = m.leads.linkedQualified;
    if (row) linked = row.technicalQualified;
    else if (contentId) {
      const primary = primaryLinkedLeads(inputs);
      const contentOf = new Map(leads.map((l) => [l.id, l.contentId]));
      linked = [...primary.values()].filter(
        (leadId) => contentOf.get(leadId) === contentId,
      ).length;
    }

    const traps = await tx.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS "n" FROM "sites"."pub_rate_hits"
       WHERE "key" = ${trapKey(productId)}
         AND "at" > ${new Date(now.getTime() - HOUR_MS)}`;
    const trapHitsLastHour = Number(traps[0]?.n ?? 0);

    const count = (n: string) =>
      byName.find((b) => b.name === n)?._count._all ?? 0;
    return {
      filter: {
        contentId,
        placementId,
        from: from?.toISOString() ?? null,
        to: to?.toISOString() ?? null,
      },
      publications: publications.map((p) => ({
        id: p.id,
        finalUrl: p.finalUrl,
        stage: p.stage,
        status: p.status,
        publishedAt: p.publishedAt?.toISOString() ?? null,
      })),
      placement: placement
        ? {
            id: placement.id,
            placementCode: placement.placementCode,
            status: placement.status,
            publishedAt: placement.publishedAt?.toISOString() ?? null,
          }
        : null,
      sessions,
      sessionMode,
      events: {
        content_view: count('content_view'),
        cta_click: count('cta_click'),
        lead_submit_success: count('lead_submit_success'),
      },
      byChannel: Object.fromEntries(
        byGroup
          .filter((g) => g.channelGroup)
          .map((g) => [g.channelGroup as string, g._count._all]),
      ),
      leads: {
        total: filtered.filter((l) => !l.testFlag).length,
        test: filtered.filter((l) => l.testFlag).length,
        pendingEnrichment: filtered.filter((l) => !l.enrichedAt).length,
        trapHitsLastHour,
      },
      qualified: {
        allExternal: m.leads.qualifiedUnique,
        linked,
        unknown: m.leads.unknownQualified,
      },
      coverage: m.leads.coverage,
      directCpl: row ? row.directCpl : m.economics.directCpl,
      productCpl: m.economics.productCpl,
      currency: inputs.currency,
    };
  }
}
