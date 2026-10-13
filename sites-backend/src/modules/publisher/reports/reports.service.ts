/**
 * AI Publisher — снимки отчётов (P-E, проектный документ §6.6, §9, §15.1;
 * ТЗ §14–16; AT-CORE-12, AT-CORE-18, AT-CORE-19, AT-CORE-24).
 *
 * Снимок = сбор входов (чтение таблиц всех пакетов через `SitesDb.forAccount`
 * — разрешено §16.0) → чистая `computeReport` → `inputsHash` → ОДНА
 * неизменяемая строка `pub_reports` (триггер append-only: UPDATE/DELETE —
 * 23514). Пересчёт (поздняя квалификация/оплата, смена идентификации,
 * вручную) и решение по отчёту — НОВАЯ строка-наследник со ссылкой на
 * прежнюю и причиной; прежняя не меняется.
 *
 * Правила периода (ТЗ §15): `d42|d72|d90` — когорта [t0, t42) версии
 * пилота, действовавшей на t0 (замороженные пороги — AT-CORE-23); снимок
 * `d42` — не раньше t42, `d72` — t72, `d90` — t90 (`PUB_WINDOW_OPEN`).
 * `late_cohort` — версия с явным `lateCohortEnd`. `weekly|ad_hoc` —
 * [periodStart, periodEnd).
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ProductRef, PubTx, AuditInput } from '../core/ports';
import { PubError, validationError } from '../core/errors';
import {
  isOneOf,
  REPORT_KINDS,
  REPORT_RECOMPUTE_REASONS,
} from '../contracts/states';
import {
  DEFAULT_PARAMETER_VALUES,
  type ParameterValues,
} from '../contracts/parameters';
import type { ListPage } from '../contracts/common';
import type {
  EconomicsPreview,
  ReportSummaryView,
  ReportView,
} from '../contracts/reports-api';
import { piiIssues } from '../core/pii-guard';
import { PILOT_EXPERIMENT_KEY } from './experiments.service';
import {
  computeReport,
  normPath,
  type ExperimentIn,
  type FrozenThresholds,
  type ReportComputation,
  type ReportInputs,
  type ReportKind,
} from './metrics/report-compute';
import type { LeadStatus } from '../contracts/states';
import { LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX } from '../contracts/common';

type ReportRow = Prisma.PubReportGetPayload<object>;
type ExperimentRow = Prisma.PubExperimentGetPayload<object>;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ATTRIBUTION_MODEL = 'last_non_direct_30d';

function isoDate(v: unknown, field: string): Date {
  if (typeof v !== 'string' || !/T/.test(v) || Number.isNaN(Date.parse(v))) {
    throw validationError([
      { field, code: v === undefined ? 'required' : 'format' },
    ]);
  }
  return new Date(v);
}

export function experimentIn(e: ExperimentRow): ExperimentIn {
  return {
    id: e.id,
    key: e.key,
    version: e.version,
    kind: e.kind as ExperimentIn['kind'],
    t0: e.t0,
    t42: e.t42,
    t72: e.t72,
    t90: e.t90,
    lateCohortEnd: e.lateCohortEnd,
    windowStart: e.windowStart,
    windowEnd: e.windowEnd,
    registeredAt: e.registeredAt,
    thresholds: e.thresholds as unknown as FrozenThresholds,
  };
}

export function reportSummary(
  r: ReportRow,
  superseded: boolean,
): ReportSummaryView {
  return {
    id: r.id,
    kind: r.kind as ReportSummaryView['kind'],
    periodStart: r.periodStart.toISOString(),
    periodEnd: r.periodEnd.toISOString(),
    snapshotAt: r.snapshotAt.toISOString(),
    experimentId: r.experimentId,
    inputsHash: r.inputsHash,
    supersedesReportId: r.supersedesReportId,
    recomputeReason: r.recomputeReason,
    decision: r.decision,
    superseded,
    createdAt: r.createdAt.toISOString(),
    createdBy: r.createdBy,
  };
}

export function reportView(r: ReportRow, superseded: boolean): ReportView {
  return {
    ...reportSummary(r, superseded),
    cohort: r.cohort,
    attributionModel: ATTRIBUTION_MODEL,
    sources: r.sources,
    metrics: r.metrics,
    costs: r.costs,
    assumptions: r.assumptions,
  };
}

/** Текст допущений снимка (язык пилота — uk): режим сессий и ограничения. */
function assumptionsOf(inputs: ReportInputs, c: ReportComputation): string {
  const lines = [
    `Модель атрибуції: останнє непряме джерело за 30 календарних днів (Europe/Kyiv); перше відоме — окремо, не сумується.`,
    inputs.sessionMode === 'session_ref'
      ? 'Сесії — власні записи session_ref; когортний зв’язок звернення з сесією — 30 днів від самої сесії.'
      : 'Сесії — добові агрегати імпорту веб-аналітики (Kyiv); зв’язку звернення з сесією немає — показник лише за період, технічний CPL може не розраховуватися.',
    'CPL/CAC — економічна вартість (надано, нараховано); касові витрати — поруч. «Не менше» — у чисельнику невідомі частини.',
    'Тестові дані, команда й партнери виключені з ділових сум; внутрішні та тестові оплати — не виручка.',
  ];
  const completeness = (
    c.sources as { completeness?: { state?: string; missing?: string[] } }
  ).completeness;
  if (completeness && completeness.state !== 'complete') {
    lines.push(
      `Дані неповні (${completeness.state}): ${(completeness.missing ?? []).join(', ') || 'неповні межові доби'}.`,
    );
  }
  return lines.join('\n');
}

@Injectable()
export class ReportsService {
  // ── Выбор эксперимента ─────────────────────────────────────────────────

  /**
   * Версия пилота, действовавшая на t0 (последняя, зарегистрированная не
   * позже t0): её гипотеза и пороги — единственные, по которым судится
   * основная когорта (AT-CORE-23); до t0 — текущая.
   */
  async pilotAtT0(
    tx: PubTx,
    product: ProductRef,
  ): Promise<ExperimentRow | null> {
    const pilots = await tx.pubExperiment.findMany({
      where: { productId: product.id, key: PILOT_EXPERIMENT_KEY },
      orderBy: [{ version: 'desc' }, { id: 'asc' }],
    });
    if (pilots.length === 0) return null;
    const t0 = pilots.find((p) => p.t0)?.t0 ?? null;
    if (t0) {
      const before = pilots.find(
        (p) => p.t0 && p.registeredAt.getTime() <= t0.getTime(),
      );
      if (before) return before;
    }
    return pilots[0];
  }

  /**
   * Эксперимент снимка. `d42|d72|d90` — ТОЛЬКО версия пилота на t0 (аудит
   * P-E S1-1): явный `experimentId` другой версии (новая гипотеза или
   * сниженный после старта порог) — 400 `not_pilot_at_t0`, задним числом
   * результат когорты не переоценивается. `late_cohort` — версия с явным
   * концом поздней когорты. Остальные виды — явный эксперимент этого
   * продукта или версия пилота на t0.
   */
  async experimentFor(
    tx: PubTx,
    product: ProductRef,
    kind: ReportKind,
    experimentId: unknown,
  ): Promise<ExperimentRow | null> {
    let explicit: ExperimentRow | null = null;
    if (experimentId !== undefined && experimentId !== null) {
      if (typeof experimentId !== 'string' || !ID_RE.test(experimentId)) {
        throw validationError([{ field: 'experimentId', code: 'format' }]);
      }
      explicit = await tx.pubExperiment.findFirst({
        where: { id: experimentId, productId: product.id },
      });
      if (!explicit) throw new PubError('PUB_NOT_FOUND');
    }
    if (kind === 'late_cohort') {
      if (explicit) return explicit;
      return tx.pubExperiment.findFirst({
        where: {
          productId: product.id,
          key: PILOT_EXPERIMENT_KEY,
          lateCohortEnd: { not: null },
        },
        orderBy: { version: 'desc' },
      });
    }
    if (kind === 'd42' || kind === 'd72' || kind === 'd90') {
      const canonical = await this.pilotAtT0(tx, product);
      if (explicit && explicit.id !== canonical?.id) {
        throw validationError([
          { field: 'experimentId', code: 'not_pilot_at_t0' },
        ]);
      }
      return canonical;
    }
    return explicit ?? (await this.pilotAtT0(tx, product));
  }

  /**
   * Цепочка снимка сериализуется (аудит P-E S2-1): два решения/пересчёта
   * одного снимка параллельно — второй ждёт и видит наследника (409).
   * Advisory-lock транзакции по id снимка (строка `pub_reports` неизменна).
   */
  async lockChain(tx: PubTx, reportId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pub_report:${reportId}`}, 0))`;
  }

  /** Страницы пилота: пути URL публикаций материалов эксперимента. */
  private async pilotPages(
    tx: PubTx,
    productId: string,
    experimentId: string | null,
  ): Promise<string[] | null> {
    if (!experimentId) return null;
    const contents = await tx.pubExperimentContent.findMany({
      where: { experimentId, productId },
      select: { contentId: true },
      orderBy: { contentId: 'asc' },
    });
    if (contents.length === 0) return null;
    const versions = await tx.pubContentVersion.findMany({
      where: { productId, contentId: { in: contents.map((c) => c.contentId) } },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    const pubs = await tx.pubPublication.findMany({
      where: {
        productId,
        versionId: { in: versions.map((v) => v.id) },
        publishedAt: { not: null },
      },
      select: { finalUrl: true },
      orderBy: { id: 'asc' },
    });
    const paths = new Set<string>();
    for (const p of pubs) {
      try {
        paths.add(normPath(new URL(p.finalUrl).pathname));
      } catch {
        // некорректный URL публикации — не страница пилота
      }
    }
    return [...paths].sort();
  }

  // ── Сбор входов ────────────────────────────────────────────────────────

  async buildInputs(
    tx: PubTx,
    product: ProductRef,
    spec: {
      kind: ReportKind;
      periodStart: Date;
      periodEnd: Date;
      snapshotAt: Date;
      experiment: ExperimentRow | null;
      focusPlacementId?: string | null;
    },
  ): Promise<ReportInputs> {
    const pid = product.id;
    const params = await tx.pubParameter.findMany({
      where: {
        productId: pid,
        key: {
          in: [
            'analytics_storage',
            'rates_by_role',
            'ai_fx_rate',
            'allowed_cpl_inputs',
            'cac_payment_window',
            'budget_total',
            'dev_investment',
          ],
        },
      },
      select: { key: true, value: true, status: true },
    });
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
      payments,
      placements,
      expenses,
      aiMonths,
      entries,
      time,
      ai,
      imports,
      integrations,
    ] = await Promise.all([
      tx.pubSession.findMany({
        where: { productId: pid },
        orderBy: { id: 'asc' },
        select: {
          sessionRef: true,
          startedAt: true,
          testFlag: true,
          placementId: true,
          channelGroup: true,
        },
      }),
      tx.pubLead.findMany({
        where: { productId: pid },
        orderBy: { id: 'asc' },
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
        where: { productId: pid },
        select: { id: true, leadId: true, toStatus: true, decidedAt: true },
        orderBy: [{ decidedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      }),
      tx.pubLeadProspectLink.findMany({
        where: { productId: pid },
        select: { leadId: true, prospectId: true, validFrom: true },
        orderBy: [{ validFrom: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      }),
      tx.pubProspect.findMany({
        where: { productId: pid },
        orderBy: { id: 'asc' },
        select: { id: true, isExternal: true, isTeamOrPartner: true },
      }),
      tx.pubPayment.findMany({
        where: { productId: pid },
        orderBy: { id: 'asc' },
      }),
      tx.pubPlacement.findMany({
        where: { productId: pid },
        orderBy: { id: 'asc' },
        select: { id: true, placementCode: true, publishedAt: true },
      }),
      tx.pubExpense.findMany({
        where: { productId: pid },
        orderBy: { id: 'asc' },
        select: { id: true, category: true, placementId: true },
      }),
      tx.pubAiBudgetMonth.findMany({
        where: { productId: pid, expenseId: { not: null } },
        orderBy: { id: 'asc' },
        select: { expenseId: true },
      }),
      tx.pubExpenseEntry.findMany({
        where: { productId: pid },
        orderBy: { id: 'asc' },
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
        where: { productId: pid },
        orderBy: { id: 'asc' },
        select: {
          minutes: true,
          role: true,
          rateMinorPerHour: true,
          isInvestment: true,
          workDate: true,
        },
      }),
      tx.pubAiCall.findMany({
        where: { productId: pid },
        orderBy: { id: 'asc' },
        select: { costMicroUsd: true, costStatus: true, requestedAt: true },
      }),
      tx.pubMetricImport.findMany({
        where: {
          productId: pid,
          source: { in: ['web_analytics', 'search_console'] },
        },
        select: { source: true, payload: true, importedAt: true },
        orderBy: [{ importedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      }),
      tx.pubIntegration.findMany({
        where: { productId: pid },
        orderBy: { kind: 'asc' },
        select: {
          kind: true,
          status: true,
          manual: true,
          lastSuccessAt: true,
          staleAfterHours: true,
        },
      }),
    ]);

    const aiMonthExpenses = new Set(aiMonths.map((m) => m.expenseId as string));
    const aggregates = new Map<
      string,
      { sessions: number | null; partial: boolean }
    >();
    const search = new Map<
      string,
      {
        date: string;
        page: string;
        clicks: number | null;
        indexed: boolean | null;
      }
    >();
    for (const imp of imports) {
      const days = ((imp.payload as { days?: unknown } | null)?.days ??
        []) as Array<Record<string, unknown>>;
      if (!Array.isArray(days)) continue;
      if (imp.source === 'web_analytics') {
        // Сессии суток — ТОЛЬКО строка итога дня (без `page`): строки
        // страниц — просмотры страниц, их сумма завышает сессии (аудит P-E
        // S2-5). Сутки без строки итога — неизвестны (не 0). Повторный
        // импорт тех же суток заменяет прежний (агрегаты не складываются).
        const perDate = new Map<
          string,
          { sessions: number | null; partial: boolean }
        >();
        for (const d of days) {
          const date = String(d.date);
          const total = typeof d.page !== 'string';
          const cur = perDate.get(date) ?? { sessions: null, partial: false };
          perDate.set(date, {
            sessions: total
              ? typeof d.sessions === 'number'
                ? d.sessions
                : null
              : cur.sessions,
            partial: cur.partial || d.partial === true,
          });
        }
        for (const [date, v] of perDate) aggregates.set(date, v);
      } else {
        for (const d of days) {
          if (typeof d.page !== 'string') continue;
          search.set(`${String(d.date)}|${d.page}`, {
            date: String(d.date),
            page: d.page,
            clicks: typeof d.clicks === 'number' ? d.clicks : null,
            indexed: typeof d.indexed === 'boolean' ? d.indexed : null,
          });
        }
      }
    }
    const allowedCpl = val('allowed_cpl_inputs');
    const rates = val('rates_by_role');
    const fx = val('ai_fx_rate');
    return {
      kind: spec.kind,
      periodStart: spec.periodStart,
      periodEnd: spec.periodEnd,
      snapshotAt: spec.snapshotAt,
      currency: val('budget_total').currency,
      experiment: spec.experiment ? experimentIn(spec.experiment) : null,
      sessionMode:
        val('analytics_storage') === 'session'
          ? 'session_ref'
          : 'imported_aggregate',
      sessions: sessions.map((s) => ({
        sessionRef: s.sessionRef,
        startedAt: s.startedAt,
        testFlag: s.testFlag,
        placementId: s.placementId,
        channelGroup:
          s.channelGroup as ReportInputs['sessions'][number]['channelGroup'],
      })),
      aggregates: [...aggregates.entries()].map(([date, v]) => ({
        date,
        sessions: v.sessions,
        partial: v.partial,
      })),
      leads,
      decisions: decisions.map((d) => ({
        ...d,
        toStatus: d.toStatus as LeadStatus,
      })),
      links,
      prospects,
      payments: payments.map((x) => ({
        id: x.id,
        prospectId: x.prospectId,
        leadId: x.leadId,
        recordType:
          x.recordType as ReportInputs['payments'][number]['recordType'],
        payerKind: x.payerKind as ReportInputs['payments'][number]['payerKind'],
        amountMinor: x.amountMinor,
        currency: x.currency,
        status: x.status as ReportInputs['payments'][number]['status'],
        occurredAt: x.occurredAt,
        confirmedAt: x.confirmedAt,
        isNewCustomer:
          x.isNewCustomer as ReportInputs['payments'][number]['isNewCustomer'],
        paymentRef: x.paymentRef,
      })),
      placements,
      expenses: expenses.map((e) => ({
        id: e.id,
        category: e.category as ReportInputs['expenses'][number]['category'],
        placementId: e.placementId,
        aiMonth: aiMonthExpenses.has(e.id),
      })),
      expenseEntries: entries.map((e) => ({
        expenseId: e.expenseId,
        kind: e.kind as ReportInputs['expenseEntries'][number]['kind'],
        status: e.status as ReportInputs['expenseEntries'][number]['status'],
        amountMinor: e.amountMinor,
        occurredAt: e.occurredAt,
        confirmedAt: e.confirmedAt,
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
        costStatus:
          c.costStatus as ReportInputs['aiCalls'][number]['costStatus'],
        requestedAt: c.requestedAt,
      })),
      rates: {
        approved: approved('rates_by_role'),
        rates: rates.rates as Record<string, number | null>,
      },
      aiFxRate: approved('ai_fx_rate') ? fx.rate : null,
      allowedCplInputs: {
        ...allowedCpl,
        approved: approved('allowed_cpl_inputs'),
      },
      cacWindow: val('cac_payment_window'),
      devInvestment: {
        approved: approved('dev_investment'),
        amountMinor: val('dev_investment').amountMinor,
      },
      searchDays: [...search.values()],
      integrations: integrations.map((g) => ({
        kind: g.kind,
        status: g.status as ReportInputs['integrations'][number]['status'],
        manual: g.manual,
        lastSuccessAt: g.lastSuccessAt,
        staleAfterHours: g.staleAfterHours,
      })),
      pilotPages: await this.pilotPages(
        tx,
        pid,
        spec.experiment?.kind === 'pilot' ? spec.experiment.id : null,
      ),
      ...(spec.focusPlacementId
        ? { focusPlacementId: spec.focusPlacementId }
        : {}),
    };
  }

  // ── Создание снимка ────────────────────────────────────────────────────

  /** Период и момент снимка по виду (проверки окна — `PUB_WINDOW_OPEN`). */
  resolvePeriod(
    kind: ReportKind,
    body: { periodStart?: unknown; periodEnd?: unknown; snapshotAt?: unknown },
    experiment: ExperimentRow | null,
    now: Date,
  ): { periodStart: Date; periodEnd: Date; snapshotAt: Date } {
    const snapshotAt =
      body.snapshotAt === undefined
        ? now
        : isoDate(body.snapshotAt, 'snapshotAt');
    if (snapshotAt.getTime() > now.getTime()) {
      throw validationError([{ field: 'snapshotAt', code: 'future' }]);
    }
    if (kind === 'd42' || kind === 'd72' || kind === 'd90') {
      if (
        !experiment?.t0 ||
        !experiment.t42 ||
        !experiment.t72 ||
        !experiment.t90
      ) {
        throw new PubError('PUB_WINDOW_OPEN', { reason: 't0_not_set' });
      }
      const due =
        kind === 'd42'
          ? experiment.t42
          : kind === 'd72'
            ? experiment.t72
            : experiment.t90;
      if (snapshotAt.getTime() < due.getTime()) {
        throw new PubError('PUB_WINDOW_OPEN', {
          reason: 'too_early',
          dueAt: due.toISOString(),
        });
      }
      return {
        periodStart: experiment.t0,
        periodEnd: kind === 'd90' ? experiment.t90 : experiment.t42,
        snapshotAt,
      };
    }
    if (kind === 'late_cohort') {
      if (!experiment?.lateCohortEnd || !experiment.t42) {
        throw validationError([
          { field: 'experimentId', code: 'late_cohort_end_required' },
        ]);
      }
      return {
        periodStart: experiment.t42,
        periodEnd: experiment.lateCohortEnd,
        snapshotAt,
      };
    }
    const periodStart = isoDate(body.periodStart, 'periodStart');
    const periodEnd = isoDate(body.periodEnd, 'periodEnd');
    if (periodEnd.getTime() <= periodStart.getTime()) {
      throw validationError([{ field: 'periodEnd', code: 'before_start' }]);
    }
    return { periodStart, periodEnd, snapshotAt };
  }

  private async insertSnapshot(
    tx: PubTx,
    product: ProductRef,
    data: {
      kind: ReportKind;
      periodStart: Date;
      periodEnd: Date;
      snapshotAt: Date;
      experimentId: string | null;
      inputs: ReportInputs;
      c: ReportComputation;
      actor: string;
      supersedesReportId?: string | null;
      recomputeReason?: string | null;
      decision?: string | null;
    },
  ): Promise<ReportRow> {
    return tx.pubReport.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        kind: data.kind,
        periodStart: data.periodStart,
        periodEnd: data.periodEnd,
        snapshotAt: data.snapshotAt,
        experimentId: data.experimentId,
        cohort: data.c.cohort as Prisma.InputJsonValue,
        attributionModel: ATTRIBUTION_MODEL,
        sources: data.c.sources as Prisma.InputJsonValue,
        metrics: data.c.metrics as Prisma.InputJsonValue,
        costs: data.c.costs as Prisma.InputJsonValue,
        assumptions: assumptionsOf(data.inputs, data.c),
        decision: data.decision ?? null,
        inputsHash: data.c.inputsHash,
        supersedesReportId: data.supersedesReportId ?? null,
        recomputeReason: data.recomputeReason ?? null,
        createdBy: data.actor,
      },
    });
  }

  async create(
    tx: PubTx,
    product: ProductRef,
    body: Record<string, unknown>,
    actor: string,
    now: Date,
  ): Promise<{ row: ReportRow; audit: AuditInput[] }> {
    if (!isOneOf(REPORT_KINDS, body.kind))
      throw validationError([{ field: 'kind', code: 'enum' }]);
    const kind = body.kind;
    const experiment = await this.experimentFor(
      tx,
      product,
      kind,
      body.experimentId,
    );
    const period = this.resolvePeriod(kind, body, experiment, now);
    const inputs = await this.buildInputs(tx, product, {
      kind,
      ...period,
      experiment,
    });
    const c = computeReport(inputs);
    const row = await this.insertSnapshot(tx, product, {
      kind,
      ...period,
      experimentId: experiment?.id ?? null,
      inputs,
      c,
      actor,
    });
    return {
      row,
      audit: [
        {
          objectType: 'report',
          objectId: row.id,
          action: 'create',
          meta: { kind, inputsHash: c.inputsHash },
        },
      ],
    };
  }

  async get(tx: PubTx, product: ProductRef, id: string): Promise<ReportRow> {
    const row = ID_RE.test(id)
      ? await tx.pubReport.findFirst({ where: { id, productId: product.id } })
      : null;
    if (!row) throw new PubError('PUB_NOT_FOUND');
    return row;
  }

  async isSuperseded(
    tx: PubTx,
    product: ProductRef,
    id: string,
  ): Promise<boolean> {
    return (
      (await tx.pubReport.count({
        where: { productId: product.id, supersedesReportId: id },
      })) > 0
    );
  }

  /**
   * Снимок-наследник с тем же определением на `snapshotAt = now`: поздняя
   * квалификация/оплата, смена идентификации, вручную (ТЗ §15). Исходный
   * снимок и принадлежность обращений к окну сохраняются.
   */
  async recompute(
    tx: PubTx,
    product: ProductRef,
    prev: ReportRow,
    reason: unknown,
    actor: string,
    now: Date,
  ): Promise<{ row: ReportRow; audit: AuditInput[] }> {
    if (!isOneOf(REPORT_RECOMPUTE_REASONS, reason))
      throw validationError([{ field: 'reason', code: 'enum' }]);
    await this.lockChain(tx, prev.id);
    if (await this.isSuperseded(tx, product, prev.id)) {
      throw new PubError('PUB_CONFLICT', { reason: 'report_superseded' });
    }
    const experiment = prev.experimentId
      ? await tx.pubExperiment.findFirst({
          where: { id: prev.experimentId, productId: product.id },
        })
      : null;
    const focus =
      (prev.cohort as { focusPlacementId?: string } | null)?.focusPlacementId ??
      null;
    const inputs = await this.buildInputs(tx, product, {
      kind: prev.kind as ReportKind,
      periodStart: prev.periodStart,
      periodEnd: prev.periodEnd,
      snapshotAt: now,
      experiment,
      focusPlacementId: focus,
    });
    const c = computeReport(inputs);
    const row = await this.insertSnapshot(tx, product, {
      kind: prev.kind as ReportKind,
      periodStart: prev.periodStart,
      periodEnd: prev.periodEnd,
      snapshotAt: now,
      experimentId: prev.experimentId,
      inputs,
      c,
      actor,
      supersedesReportId: prev.id,
      recomputeReason: reason,
      // Решение по отчёту переходит в наследника (голова цепочки его
      // сохраняет; аудит P-E S3-10).
      decision: prev.decision,
    });
    return {
      row,
      audit: [
        {
          objectType: 'report',
          objectId: row.id,
          action: 'create',
          meta: {
            supersedesReportId: prev.id,
            recomputeReason: reason,
            inputsHash: c.inputsHash,
          },
        },
      ],
    };
  }

  /**
   * Решение по отчёту — новая строка-копия снимка (те же snapshotAt,
   * метрики и inputsHash) с решением; исходная строка неизменна (§11.3
   * «новая версия-снимок с решением», Р-PUB-E-4).
   */
  async decide(
    tx: PubTx,
    product: ProductRef,
    prev: ReportRow,
    decision: unknown,
    actor: string,
  ): Promise<{ row: ReportRow; audit: AuditInput[] }> {
    if (
      typeof decision !== 'string' ||
      decision.trim().length < 3 ||
      [...decision].length > 4000
    ) {
      throw validationError([{ field: 'decision', code: 'length' }]);
    }
    const pii = piiIssues({ decision });
    if (pii.length) throw validationError(pii);
    await this.lockChain(tx, prev.id);
    if (await this.isSuperseded(tx, product, prev.id)) {
      throw new PubError('PUB_CONFLICT', { reason: 'report_superseded' });
    }
    const row = await tx.pubReport.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        kind: prev.kind,
        periodStart: prev.periodStart,
        periodEnd: prev.periodEnd,
        snapshotAt: prev.snapshotAt,
        experimentId: prev.experimentId,
        cohort: prev.cohort as Prisma.InputJsonValue,
        attributionModel: prev.attributionModel,
        sources: prev.sources as Prisma.InputJsonValue,
        metrics: prev.metrics as Prisma.InputJsonValue,
        costs: prev.costs as Prisma.InputJsonValue,
        assumptions: prev.assumptions,
        decision: decision.trim(),
        inputsHash: prev.inputsHash,
        supersedesReportId: prev.id,
        recomputeReason: 'decision',
        createdBy: actor,
      },
    });
    return {
      row,
      audit: [
        {
          objectType: 'report',
          objectId: row.id,
          action: 'approve',
          meta: { supersedesReportId: prev.id },
        },
      ],
    };
  }

  async list(
    tx: PubTx,
    product: ProductRef,
    q: { kind?: unknown; before?: unknown; limit?: unknown },
  ): Promise<ListPage<ReportSummaryView>> {
    const where: Prisma.PubReportWhereInput = { productId: product.id };
    if (q.kind !== undefined) {
      if (!isOneOf(REPORT_KINDS, q.kind))
        throw validationError([{ field: 'kind', code: 'enum' }]);
      where.kind = q.kind;
    }
    const limit = Math.min(
      Number(q.limit ?? LIST_LIMIT_DEFAULT) || LIST_LIMIT_DEFAULT,
      LIST_LIMIT_MAX,
    );
    if (typeof q.before === 'string' && ID_RE.test(q.before)) {
      const b = await tx.pubReport.findFirst({
        where: { id: q.before, productId: product.id },
        select: { createdAt: true },
      });
      if (b) where.createdAt = { lt: b.createdAt };
    }
    const rows = await tx.pubReport.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    const children = await tx.pubReport.findMany({
      where: {
        productId: product.id,
        supersedesReportId: { in: rows.map((r) => r.id) },
      },
      select: { supersedesReportId: true },
    });
    const sup = new Set(children.map((c) => c.supersedesReportId));
    return {
      items: rows.map((r) => reportSummary(r, sup.has(r.id))),
      nextBefore: rows.length === limit ? rows[rows.length - 1].id : null,
    };
  }

  /**
   * Диагностический снимок размещения +7/+14 дней (§15.1
   * `placement-diagnostics`): `ad_hoc` по одному размещению, окно обращения
   * он не закрывает.
   */
  async createFocused(
    tx: PubTx,
    product: ProductRef,
    placementId: string,
    periodStart: Date,
    periodEnd: Date,
    actor: string,
    now: Date,
  ): Promise<{ row: ReportRow; audit: AuditInput[] }> {
    const experiment = await this.experimentFor(
      tx,
      product,
      'ad_hoc',
      undefined,
    );
    const inputs = await this.buildInputs(tx, product, {
      kind: 'ad_hoc',
      periodStart,
      periodEnd,
      snapshotAt: now,
      experiment,
      focusPlacementId: placementId,
    });
    const c = computeReport(inputs);
    const row = await this.insertSnapshot(tx, product, {
      kind: 'ad_hoc',
      periodStart,
      periodEnd,
      snapshotAt: now,
      experimentId: experiment?.id ?? null,
      inputs,
      c,
      actor,
    });
    return {
      row,
      audit: [
        {
          objectType: 'report',
          objectId: row.id,
          action: 'create',
          meta: { diagnostic: true, placementId },
        },
      ],
    };
  }

  /** Текущие метрики без сохранения (помечены «предварительно»). */
  async preview(
    tx: PubTx,
    product: ProductRef,
    now: Date,
  ): Promise<EconomicsPreview> {
    const experiment = await this.experimentFor(tx, product, 'd72', undefined);
    const p = await tx.pubProduct.findFirst({
      where: { id: product.id },
      select: { createdAt: true },
    });
    const kind: ReportKind =
      experiment?.t0 && experiment.t42 && experiment.t72 && experiment.t90
        ? 'd72'
        : 'ad_hoc';
    const periodStart =
      kind === 'd72' ? (experiment?.t0 as Date) : (p?.createdAt ?? now);
    const periodEnd =
      kind === 'd72'
        ? (experiment?.t42 as Date)
        : new Date(Math.max(now.getTime(), periodStart.getTime() + 1));
    const inputs = await this.buildInputs(tx, product, {
      kind,
      periodStart,
      periodEnd,
      snapshotAt: now,
      experiment,
    });
    const c = computeReport(inputs);
    return {
      preliminary: true,
      at: now.toISOString(),
      kind,
      cohort: c.cohort,
      sources: c.sources,
      metrics: c.metrics,
      costs: c.costs,
    };
  }
}
