/**
 * AI Publisher, P-C — закупка размещения (проектный документ §7.2, §7.3,
 * §8.2; F12; ТЗ §13, §17; AT-CORE-13…17, AT-F12-01/02).
 *
 * Машина `PLACEMENT_MACHINE` (core/state-machines.ts) + проверки:
 *  - proposed: площадка `verified`; версия согласована и не `criticalStale`;
 *    материал ∈ эксперимента `pilot`; 7 дней бесплатного наблюдения;
 *    итоговая цена с комиссиями в валюте лимита (иная валюта — курс,
 *    источник, время, иначе `PUB_FX_REQUIRED`); выданная ссылка с UTM
 *    `placementCode`; вторая закупка — только после публикации первой;
 *  - approved: согласование `purchase` (hash версии, снимок цены, максимум,
 *    срок ≤ min(оферта, 72 ч)); 3-я и дальше — со снимком отчёта с решением;
 *  - budget_reserved: гейт `purchases` + атомарный резерв
 *    `sites.pub_budget_reserve` (согласование → `consumed`);
 *  - ordered: без оплаты `pending|unknown` (иначе `PUB_RECONCILE_REQUIRED`);
 *  - cancelled: освобождается только подтверждённо отменённая сумма;
 *  - disputed: владелец претензии и дата следующего действия.
 * Оплата закупки — записи `pub_expense_entries` (ExpensesService), статус
 * оплаты выводится из них и от публикации не зависит (§7.3).
 */
import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { ProductCtx } from '../contracts/common';
import type {
  PlacementView,
  ResolveDisputeBody,
} from '../contracts/distribution-api';
import type { FieldIssue } from '../contracts/errors';
import type { PlacementStatus } from '../contracts/states';
import { PubError, validationError } from '../core/errors';
import { convertMinor } from '../core/money';
import { memberAccessIn } from '../core/product-access.service';
import { PILOT_CAMPAIGN_CODE } from '../core/product.service';
import { PubPorts, type AuditInput, type PubTx } from '../core/ports';
import { assertRevision, parseExpectedRevision } from '../core/revision';
import { can, isSelfReview, type PubAccess } from '../core/roles';
import {
  PLACEMENT_MACHINE,
  assertTransition,
  type Actor,
} from '../core/state-machines';
import { buildMeasurableUrl, utmOf, UtmError } from '../core/utm';
import { budgetFn } from './budget-fn';
import { canReserve } from './budget-math';
import { BudgetService } from './budget.service';
import {
  inPilotExperiment,
  observationPassed,
  observationStart,
  versionTarget,
} from './content-read';
import {
  PurchaseApprovalsService,
  priceSnapshotHash,
  purchaseApprovalExpiry,
} from './approvals-purchase.service';
import { paymentStatusOf } from './budget-math';
import { expenseAmountsOf } from './budget.service';
import { Fields, canonicalUrl, parseFx, type Body } from './input';

export interface Step {
  actor: string;
  now: Date;
}

export interface OpResult<T> {
  body: T;
  audit: AuditInput[];
}

export function actorsOf(access: PubAccess): Actor[] {
  return [...access.roles, ...(access.admin ? (['admin'] as const) : [])];
}

type PlacementRow = Prisma.PubPlacementGetPayload<object>;

const s = (v: bigint) => v.toString();

export function placementView(
  p: PlacementRow,
  paymentPartial = false,
): PlacementView {
  return {
    id: p.id,
    venueId: p.venueId,
    versionId: p.versionId,
    campaignId: p.campaignId,
    placementCode: p.placementCode,
    issuedUrl: p.issuedUrl,
    purchaseSeq: p.purchaseSeq,
    basePriceMinor: s(p.basePriceMinor),
    feesMinor: s(p.feesMinor),
    totalPriceMinor: s(p.totalPriceMinor),
    currency: p.currency,
    orig:
      p.origCurrency &&
      p.origAmountMinor !== null &&
      p.fxRate &&
      p.fxSource &&
      p.fxAt
        ? {
            currency: p.origCurrency,
            amountMinor: s(p.origAmountMinor),
            fxRate: p.fxRate.toString(),
            fxSource: p.fxSource,
            fxAt: p.fxAt.toISOString(),
          }
        : null,
    priceConfirmedAt: p.priceConfirmedAt?.toISOString() ?? null,
    priceSource: p.priceSource,
    offerExpiresAt: p.offerExpiresAt?.toISOString() ?? null,
    terms: p.terms,
    externalOrderId: p.externalOrderId,
    status: p.status as PlacementView['status'],
    paymentStatus: p.paymentStatus as PlacementView['paymentStatus'],
    paymentPartial,
    approvalId: p.approvalId,
    expenseId: p.expenseId,
    reportDecisionId: p.reportDecisionId,
    publishDueAt: p.publishDueAt?.toISOString() ?? null,
    publishedAt: p.publishedAt?.toISOString() ?? null,
    verifiedAt: p.verifiedAt?.toISOString() ?? null,
    claimStatus: p.claimStatus as PlacementView['claimStatus'],
    claimOwnerMemberId: p.claimOwnerMemberId,
    nextActionAt: p.nextActionAt?.toISOString() ?? null,
    observationOk: p.observationOk,
    priceSnapshotHash: priceSnapshotHash(p),
    revision: p.revision,
  };
}

/** Канал записей размещений закупок (создаётся по требованию, kind `paid_venue`). */
export const PAID_VENUES_CHANNEL = 'paid-venues';

/**
 * Статусы с обязательством, где оплата идёт по согласованной цене
 * (`assertPriceApproved`); отменённая/отклонённая закупка — без проверки
 * (оплату, списанную после отмены, записать нужно).
 */
export const PRICE_BOUND_STATUSES: readonly string[] = [
  'budget_reserved',
  'ordered',
  'publication_pending',
  'published',
  'verified_complete',
  'disputed',
];

/**
 * URL размещения — на площадке: тот же хост (без `www.`) или его поддомен,
 * и под путём карточки площадки, если он задан (`t.me/channel`, раздел
 * сайта). Чужой хост — не размещение этой закупки (S1-2).
 */
export function urlOnVenue(url: string, venueUrl: string): boolean {
  let u: URL;
  let v: URL;
  try {
    u = new URL(url);
    v = new URL(venueUrl);
  } catch {
    return false;
  }
  const strip = (h: string) => h.toLowerCase().replace(/^www\./, '');
  const uh = strip(u.hostname);
  const vh = strip(v.hostname);
  if (uh !== vh && !uh.endsWith(`.${vh}`)) return false;
  const vp = v.pathname.replace(/\/+$/, '');
  if (!vp) return true;
  const up = u.pathname.replace(/\/+$/, '');
  return up === vp || up.startsWith(`${vp}/`);
}

/**
 * Ссылка, найденная на странице размещения, — выданная этой закупке:
 * `utm_content = placementCode`, `utm_campaign` кампании и тот же адрес
 * назначения, что у выданной ссылки (`issuedUrl`).
 */
export function linkOfPlacement(
  link: string,
  p: { issuedUrl: string | null; placementCode: string },
  campaignCode: string,
): boolean {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return false;
  }
  const utm = utmOf(link);
  if (utm.content !== p.placementCode || utm.campaign !== campaignCode) {
    return false;
  }
  if (!p.issuedUrl) return true;
  const i = new URL(p.issuedUrl);
  const path = (x: URL) => x.pathname.replace(/\/+$/, '');
  return u.hostname === i.hostname && path(u) === path(i);
}

/**
 * Действующее согласование НА ТЕКУЩУЮ цену (S0-1): закупка после резерва
 * идёт дальше (заказ, ожидание публикации, оплата) только если её
 * согласование израсходовано на этот же снимок цены, максимум не меньше
 * цены, обязательство равно цене и цена не выше `perPurchaseMax`. Любая
 * правка цены/условий после согласования отвязывает его (PATCH) — тогда
 * `PUB_APPROVAL_STALE {reason:'price_changed'}` до повторного согласования.
 */
export async function assertPriceApproved(
  tx: PubTx,
  productId: string,
  p: PlacementRow,
): Promise<void> {
  const snap = priceSnapshotHash(p);
  const a = p.approvalId
    ? await tx.pubApproval.findFirst({
        where: { id: p.approvalId, productId, type: 'purchase' },
        select: {
          status: true,
          priceSnapshotHash: true,
          maxAmountMinor: true,
          objectId: true,
        },
      })
    : null;
  if (!a) {
    // Согласование было (снято правкой цены: действующее — superseded,
    // израсходованное резервом — просто отвязано) — оно устарело.
    const earlier = await tx.pubApproval.count({
      where: {
        productId,
        type: 'purchase',
        objectId: p.id,
        status: { in: ['superseded', 'consumed'] },
      },
    });
    throw new PubError(
      earlier > 0 ? 'PUB_APPROVAL_STALE' : 'PUB_APPROVAL_REQUIRED',
      earlier > 0 ? { reason: 'price_changed' } : {},
    );
  }
  if (
    a.objectId !== p.id ||
    a.status !== 'consumed' ||
    a.priceSnapshotHash !== snap ||
    (a.maxAmountMinor ?? 0n) < p.totalPriceMinor
  ) {
    throw new PubError('PUB_APPROVAL_STALE', {
      reason: 'price_changed',
      priceSnapshotHash: snap,
    });
  }
  if (p.expenseId) {
    const e = await tx.pubExpense.findFirst({
      where: { id: p.expenseId, productId },
      select: { amountTotalMinor: true },
    });
    if (!e || e.amountTotalMinor !== p.totalPriceMinor) {
      throw new PubError('PUB_APPROVAL_STALE', {
        reason: 'commitment_mismatch',
        totalPriceMinor: p.totalPriceMinor.toString(),
        commitmentMinor: e?.amountTotalMinor.toString() ?? null,
      });
    }
  }
  await assertPerPurchaseCap(tx, productId, p.totalPriceMinor);
}

/** Итоговая цена закупки не выше `perPurchaseMax` строки лимита. */
export async function assertPerPurchaseCap(
  tx: PubTx,
  productId: string,
  total: bigint,
): Promise<void> {
  const l = await tx.pubBudgetLimit.findFirst({
    where: { productId },
    select: { perPurchaseMaxMinor: true },
  });
  if (l && total > l.perPurchaseMaxMinor) {
    throw new PubError('PUB_BUDGET_INSUFFICIENT', {
      reason: 'per_purchase_cap',
      requested: total.toString(),
      perPurchaseMax: l.perPurchaseMaxMinor.toString(),
    });
  }
}

/** Площадка закупки всё ещё `verified` (перепроверка после предложения, S3-4). */
async function assertVenueVerified(
  tx: PubTx,
  productId: string,
  venueId: string,
): Promise<{ url: string; linkMarking: string }> {
  const v = await tx.pubVenue.findFirst({
    where: { id: venueId, productId },
    select: { status: true, url: true, linkMarking: true },
  });
  if (!v) throw new PubError('PUB_NOT_FOUND', { field: 'venueId' });
  if (v.status !== 'verified') {
    throw new PubError('PUB_GATE_CLOSED', {
      gate: 'purchases',
      missing: [{ kind: 'evidence', key: 'venue', detail: v.status }],
    });
  }
  return v;
}

interface PriceInput {
  base: bigint;
  fees: bigint;
  total: bigint;
  currency: string;
  orig: {
    currency: string;
    amount: bigint;
    rate: string;
    source: string;
    at: Date;
  } | null;
}

@Injectable()
export class PlacementsService {
  constructor(
    private readonly ports: PubPorts,
    private readonly budget: BudgetService,
    private readonly approvals: PurchaseApprovalsService,
  ) {}

  async row(tx: PubTx, productId: string, id: string): Promise<PlacementRow> {
    const p = await tx.pubPlacement.findFirst({ where: { id, productId } });
    if (!p) throw new PubError('PUB_NOT_FOUND');
    return p;
  }

  async view(tx: PubTx, productId: string, id: string): Promise<PlacementView> {
    const p = await this.row(tx, productId, id);
    return placementView(p, await this.partialOf(tx, p.expenseId));
  }

  async list(
    tx: PubTx,
    productId: string,
    q: { status?: string; before?: string; limit: number },
  ): Promise<PlacementRow[]> {
    return tx.pubPlacement.findMany({
      where: {
        productId,
        ...(q.status ? { status: q.status } : {}),
        ...(q.before ? { id: { lt: q.before } } : {}),
      },
      orderBy: { id: 'desc' },
      take: q.limit,
    });
  }

  private async partialOf(tx: PubTx, expenseId: string | null) {
    if (!expenseId) return false;
    const e = await tx.pubExpense.findFirst({ where: { id: expenseId } });
    if (!e) return false;
    const pays = await tx.pubExpenseEntry.findMany({
      where: { expenseId, kind: 'pay' },
      select: { status: true },
    });
    return paymentStatusOf(
      expenseAmountsOf(e),
      pays as Array<{ status: 'confirmed' }>,
    ).partial;
  }

  // ── Цена (AT-CORE-13) ───────────────────────────────────────────────────

  /**
   * Итоговая цена в валюте лимита. Комиссии — обязательное поле (0 — явно
   * «без комиссий»): цена без них не окончательная (`PUB_PRICE_INCOMPLETE`).
   * Иная валюта — курс, источник и время, иначе `PUB_FX_REQUIRED`; пересчёт
   * целочисленный, вверх (лимит не меньше фактической цены).
   */
  private parsePrice(
    f: Fields,
    b: Body,
    limitCurrency: string,
  ): PriceInput | null {
    const raw = b.price;
    if (raw === undefined || raw === null || typeof raw !== 'object') {
      throw new PubError('PUB_PRICE_INCOMPLETE', { missing: ['price'] });
    }
    const pb = raw as Body;
    if (pb.feesMinor === undefined || pb.feesMinor === null) {
      throw new PubError('PUB_PRICE_INCOMPLETE', { missing: ['feesMinor'] });
    }
    const currency = f.currency(pb, 'currency');
    const base = f.minor(pb, 'baseMinor');
    const fees = f.minor(pb, 'feesMinor');
    const fx = parseFx(f, b.fx);
    f.done();
    if (!currency || base === null || fees === null) return null;
    if (base + fees <= 0n) {
      throw validationError([{ field: 'price.baseMinor', code: 'range' }]);
    }
    if (currency === limitCurrency) {
      return { base, fees, total: base + fees, currency, orig: null };
    }
    if (!fx) {
      throw new PubError('PUB_FX_REQUIRED', {
        currency,
        limitCurrency,
        missing: ['fx.rate', 'fx.source', 'fx.at'],
      });
    }
    const cBase = convertMinor(base, fx.rate);
    const cFees = convertMinor(fees, fx.rate);
    return {
      base: cBase,
      fees: cFees,
      total: cBase + cFees,
      currency: limitCurrency,
      orig: {
        currency,
        amount: base + fees,
        rate: fx.rate,
        source: fx.source,
        at: fx.at,
      },
    };
  }

  private async limitCurrency(tx: PubTx, productId: string): Promise<string> {
    const l = await this.budget.limitRow(tx, productId);
    if (!l) {
      throw new PubError('PUB_GATE_CLOSED', {
        gate: 'purchases',
        missing: [
          { kind: 'budget', key: 'pub_budget_limits', detail: 'not_built' },
        ],
      });
    }
    return l.currency;
  }

  // ── proposed ───────────────────────────────────────────────────────────

  async propose(
    tx: PubTx,
    product: ProductCtx,
    access: PubAccess,
    step: Step,
    b: Body,
  ): Promise<OpResult<PlacementView>> {
    void access; // роль — матрица `placement.propose` (runOperation)
    const f = new Fields();
    const venueId = f.id(b, 'venueId');
    const versionId = f.id(b, 'versionId');
    const priceSource = f.str(b, 'priceSource', 300, { optional: true });
    const priceConfirmedAt = f.date(b, 'priceConfirmedAt', { optional: true });
    const offerExpiresAt = f.date(b, 'offerExpiresAt', { optional: true });
    const terms = f.str(b, 'terms', 2000);
    const targetUrl = f.https(b, 'targetUrl', { optional: true });
    const code = f.str(b, 'placementCode', 64, { optional: true, pii: false });
    if (code !== null && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(code)) {
      f.add('placementCode', 'format');
    }
    f.done();
    const limitCurrency = await this.limitCurrency(tx, product.id);
    const price = this.parsePrice(f, b, limitCurrency);
    if (!price || !venueId || !versionId || !terms) {
      throw validationError([{ field: '$', code: 'required' }]);
    }
    if (!priceSource) {
      throw new PubError('PUB_PRICE_INCOMPLETE', { missing: ['priceSource'] });
    }
    await assertPerPurchaseCap(tx, product.id, price.total);
    const venue = await tx.pubVenue.findFirst({
      where: { id: venueId, productId: product.id },
      select: { id: true, status: true, url: true },
    });
    if (!venue) throw new PubError('PUB_NOT_FOUND', { field: 'venueId' });
    if (venue.status !== 'verified') {
      throw new PubError('PUB_GATE_CLOSED', {
        gate: 'purchases',
        missing: [{ kind: 'evidence', key: 'venue', detail: venue.status }],
      });
    }
    const target = await versionTarget(tx, product.id, versionId);
    if (!target) throw new PubError('PUB_NOT_FOUND', { field: 'versionId' });
    const pv = await this.ports
      .content()
      .publishableVersion(tx, product, versionId);
    if (pv.criticalStale || target.criticalStale) {
      throw new PubError('PUB_CONTENT_STALE', { versionId });
    }
    if (!pv.approvalActive) {
      throw new PubError('PUB_APPROVAL_REQUIRED', { versionId });
    }
    const contents = [...new Set([target.contentId, target.rootContentId])];
    if (!(await inPilotExperiment(tx, product.id, contents))) {
      throw new PubError('PUB_GATE_CLOSED', {
        gate: 'purchases',
        missing: [
          {
            kind: 'evidence',
            key: 'pilot_experiment_contents',
            detail: 'not_selected',
          },
        ],
      });
    }
    const obsStart = await observationStart(
      tx,
      product,
      contents,
      pv.firstLivePublishedAt,
    );
    if (!observationPassed(obsStart, step.now)) {
      throw new PubError('PUB_OBSERVATION_PENDING', {
        firstPublishedAt: obsStart?.toISOString() ?? null,
      });
    }
    const campaign = await tx.pubCampaign.findFirst({
      where: { productId: product.id, code: PILOT_CAMPAIGN_CODE },
      select: { id: true, code: true },
    });
    if (!campaign) throw new PubError('PUB_NOT_FOUND', { field: 'campaign' });
    const prior = await tx.pubPlacement.findMany({
      where: { productId: product.id, campaignId: campaign.id },
      orderBy: { purchaseSeq: 'desc' },
      select: { purchaseSeq: true, status: true },
    });
    const seq = (prior[0]?.purchaseSeq ?? 0) + 1;
    const live = prior.find(
      (x) => !['rejected', 'cancelled'].includes(x.status),
    );
    if (live && !['published', 'verified_complete'].includes(live.status)) {
      // Последовательность (аудит P3-10): следующая — после публикации предыдущей.
      throw new PubError('PUB_GATE_CLOSED', {
        gate: 'purchases',
        missing: [
          { kind: 'evidence', key: 'previous_purchase', detail: live.status },
        ],
      });
    }
    const placementCode =
      code ?? `pl${seq}-${Math.random().toString(36).slice(2, 8)}`;
    const dest = targetUrl ?? target.siteUrl;
    if (!dest)
      throw validationError([{ field: 'targetUrl', code: 'required' }]);
    let issuedUrl: string;
    try {
      issuedUrl = buildMeasurableUrl(dest, {
        source: new URL(venue.url).hostname,
        medium: 'paid',
        campaign: campaign.code,
        content: placementCode,
      });
    } catch (e) {
      if (e instanceof UtmError) {
        throw validationError([{ field: `utm.${e.field}`, code: e.code }]);
      }
      throw e;
    }
    const row = await tx.pubPlacement.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        venueId,
        versionId,
        campaignId: campaign.id,
        placementCode,
        issuedUrl,
        purchaseSeq: seq,
        basePriceMinor: price.base,
        feesMinor: price.fees,
        totalPriceMinor: price.total,
        currency: price.currency,
        origCurrency: price.orig?.currency ?? null,
        origAmountMinor: price.orig?.amount ?? null,
        fxRate: price.orig?.rate ?? null,
        fxSource: price.orig?.source ?? null,
        fxAt: price.orig?.at ?? null,
        priceSource,
        priceConfirmedAt: priceConfirmedAt ?? step.now,
        offerExpiresAt,
        terms,
        observationOk: true,
        createdBy: step.actor,
      },
    });
    return {
      body: placementView(row),
      audit: [
        {
          objectType: 'placement',
          objectId: row.id,
          action: 'create',
          toStatus: 'proposed',
          meta: {
            venueId,
            versionId,
            purchaseSeq: seq,
            totalPriceMinor: Number(price.total),
            currency: price.currency,
            fx: price.orig ? price.orig.rate : null,
          },
        },
      ],
    };
  }

  /** Правка цены/условий (proposed, approved; после резерва — до публикации). */
  async patch(
    tx: PubTx,
    product: ProductCtx,
    step: Step,
    id: string,
    b: Body,
  ): Promise<OpResult<PlacementView>> {
    const expected = parseExpectedRevision(b.expectedRevision);
    const p = await this.row(tx, product.id, id);
    assertRevision(p.revision, expected);
    if (
      !['proposed', 'approved', 'budget_reserved', 'ordered'].includes(p.status)
    ) {
      throw new PubError('PUB_TRANSITION_INVALID', {
        machine: 'placement',
        from: p.status,
        to: p.status,
        allowed: [],
      });
    }
    const f = new Fields();
    const data: Prisma.PubPlacementUncheckedUpdateManyInput = {};
    if (b.price !== undefined) {
      const price = this.parsePrice(f, b, p.currency);
      if (price) {
        Object.assign(data, {
          basePriceMinor: price.base,
          feesMinor: price.fees,
          totalPriceMinor: price.total,
          origCurrency: price.orig?.currency ?? null,
          origAmountMinor: price.orig?.amount ?? null,
          fxRate: price.orig?.rate ?? null,
          fxSource: price.orig?.source ?? null,
          fxAt: price.orig?.at ?? null,
          priceConfirmedAt: step.now,
        });
      }
    }
    if (b.priceSource !== undefined) {
      data.priceSource = f.str(b, 'priceSource', 300);
    }
    if (b.priceConfirmedAt !== undefined) {
      data.priceConfirmedAt = f.date(b, 'priceConfirmedAt');
    }
    if (b.offerExpiresAt !== undefined) {
      data.offerExpiresAt = f.date(b, 'offerExpiresAt', { optional: true });
    }
    if (b.terms !== undefined) data.terms = f.str(b, 'terms', 2000);
    f.done();
    const audit: AuditInput[] = [];
    const merged = { ...p, ...data } as PlacementRow;
    // Потолок одной закупки — и при правке цены (S0-1).
    await assertPerPurchaseCap(tx, product.id, merged.totalPriceMinor);
    // Любая правка снимка цены (цена, курс, условия, срок оферты) после
    // согласования: согласование больше не покрывает закупку — действующее
    // снимается (`superseded`), израсходованное резервом просто
    // отвязывается. Дальше — повторное согласование PO на текущую цену;
    // до него резерв, заказ, ожидание публикации и оплата отвечают
    // PUB_APPROVAL_STALE {reason:'price_changed'} (AT-F12-02, S0-1).
    // Повторное согласование после резерва выравнивает обязательство по
    // новой цене в той же операции (`approve`).
    if (p.approvalId && priceSnapshotHash(merged) !== priceSnapshotHash(p)) {
      data.approvalId = null;
      if (await this.approvals.close(tx, p.approvalId, 'superseded', null)) {
        audit.push({
          objectType: 'approval',
          objectId: p.approvalId,
          action: 'transition',
          fromStatus: 'active',
          toStatus: 'superseded',
          meta: { cause: 'price_changed' },
        });
      }
    }
    const r = await tx.pubPlacement.updateMany({
      where: { id, revision: expected },
      data: { ...data, revision: { increment: 1 } },
    });
    if (r.count !== 1) throw new PubError('PUB_CONFLICT');
    const after = await this.row(tx, product.id, id);
    audit.push({
      objectType: 'placement',
      objectId: id,
      action: 'update',
      meta: {
        totalPriceMinor: Number(after.totalPriceMinor),
        priceSnapshotHash: priceSnapshotHash(after),
        reapprovalRequired: !!p.approvalId && !after.approvalId,
      },
    });
    return { body: placementView(after), audit };
  }

  // ── approved ───────────────────────────────────────────────────────────

  async approve(
    tx: PubTx,
    product: ProductCtx,
    access: PubAccess,
    step: Step,
    id: string,
    b: Body,
    opKey: string,
  ): Promise<OpResult<PlacementView>> {
    const expected = parseExpectedRevision(b.expectedRevision);
    const p = await this.row(tx, product.id, id);
    assertRevision(p.revision, expected);
    // Повторное согласование (правка цены после согласования/резерва —
    // §6.4, AT-F12-02, S0-1): статус не меняется, прежнее действующее →
    // superseded; после резерва обязательство выравнивается по новой цене
    // в этой же операции.
    const reapproval = [
      'approved',
      'budget_reserved',
      'ordered',
      'publication_pending',
    ].includes(p.status);
    if (!reapproval) {
      assertTransition(
        PLACEMENT_MACHINE,
        p.status as PlacementStatus,
        'approved',
        {
          actors: actorsOf(access),
        },
      );
    } else {
      assertTransition(PLACEMENT_MACHINE, 'proposed', 'approved', {
        actors: actorsOf(access),
      });
    }
    const f = new Fields();
    const max = f.minor(b, 'maxAmountMinor', { positive: true });
    const currency = f.currency(b, 'currency');
    const versionHash = f.str(b, 'versionHash', 64, { pii: false });
    const snap = f.str(b, 'priceSnapshotHash', 64, { pii: false });
    const reportDecisionId = f.id(b, 'reportDecisionId', { optional: true });
    const reason = f.str(b, 'reason', 2000, { optional: true });
    f.done();
    if (max === null || !currency || !versionHash || !snap) {
      throw validationError([{ field: '$', code: 'required' }]);
    }
    if (!p.priceConfirmedAt || !p.priceSource) {
      throw new PubError('PUB_PRICE_INCOMPLETE', {
        missing: ['priceConfirmedAt', 'priceSource'],
      });
    }
    if (currency !== p.currency) {
      throw validationError([{ field: 'currency', code: 'enum' }]);
    }
    if (max < p.totalPriceMinor) {
      throw validationError([{ field: 'maxAmountMinor', code: 'range' }]);
    }
    await assertVenueVerified(tx, product.id, p.venueId);
    await assertPerPurchaseCap(tx, product.id, p.totalPriceMinor);
    const pv = await this.ports
      .content()
      .publishableVersion(tx, product, p.versionId);
    if (pv.criticalStale) throw new PubError('PUB_CONTENT_STALE');
    if (!pv.approvalActive) throw new PubError('PUB_APPROVAL_REQUIRED');
    if (versionHash !== pv.hash || snap !== priceSnapshotHash(p)) {
      throw new PubError('PUB_APPROVAL_STALE', {
        versionHash: pv.hash,
        priceSnapshotHash: priceSnapshotHash(p),
      });
    }
    let decision = p.reportDecisionId;
    if (p.purchaseSeq >= 3 && !decision) {
      if (reportDecisionId) {
        const rep = await tx.pubReport.findFirst({
          where: { id: reportDecisionId, productId: product.id },
          select: { id: true, decision: true },
        });
        if (rep?.decision) decision = rep.id;
      }
      if (!decision) {
        throw new PubError('PUB_GATE_CLOSED', {
          gate: 'purchases',
          missing: [
            {
              kind: 'report_decision',
              key: 'reportDecisionId',
              detail: 'required',
            },
          ],
        });
      }
    }
    // Гейт `purchases` блокирует переход в approved (§10).
    await this.ports.gates().assertOpen(tx, product, 'purchases', step.now, {
      placement: {
        observationOk: p.observationOk,
        purchaseSeq: p.purchaseSeq,
        reportDecisionId: decision,
      },
    });
    const audit: AuditInput[] = [];
    if (reapproval && p.approvalId) {
      if (await this.approvals.close(tx, p.approvalId, 'superseded', null)) {
        audit.push({
          objectType: 'approval',
          objectId: p.approvalId,
          action: 'transition',
          fromStatus: 'active',
          toStatus: 'superseded',
        });
      }
    }
    const author = /^member:(.+)$/.exec(p.createdBy)?.[1] ?? null;
    const selfReview =
      access.accountOwner && author === access.memberId
        ? true
        : isSelfReview(access, 'placement.approve', author);
    const approvalId = await this.approvals.createPurchase(tx, product, {
      placementId: p.id,
      maxAmountMinor: max,
      currency,
      versionHash,
      priceSnapshotHash: snap,
      decidedAt: step.now,
      expiresAt: purchaseApprovalExpiry(step.now, p.offerExpiresAt),
      approverMemberId: access.memberId,
      selfReview,
      reason,
      actor: step.actor,
    });
    const r = await tx.pubPlacement.updateMany({
      where: { id, revision: expected },
      data: {
        approvalId,
        reportDecisionId: decision,
        status: reapproval ? p.status : 'approved',
        revision: { increment: 1 },
      },
    });
    if (r.count !== 1) throw new PubError('PUB_CONFLICT');
    audit.push(
      {
        objectType: 'approval',
        objectId: approvalId,
        action: 'approve',
        toStatus: 'active',
        meta: {
          type: 'purchase',
          placementId: p.id,
          maxAmountMinor: Number(max),
          versionHash,
          priceSnapshotHash: snap,
          selfReview,
        },
      },
      {
        objectType: 'placement',
        objectId: p.id,
        action: reapproval ? 'update' : 'transition',
        fromStatus: p.status,
        toStatus: reapproval ? p.status : 'approved',
      },
    );
    if (reapproval && p.expenseId) {
      audit.push(
        ...(await this.alignCommitment(
          tx,
          product,
          step,
          p,
          approvalId,
          snap,
          opKey,
        )),
      );
    }
    return { body: await this.view(tx, product.id, id), audit };
  }

  /**
   * Повторное согласование после резерва (S0-1): обязательство = новая
   * цена в той же операции. Рост — положительной корректировкой по новому
   * согласованию (функция расходует его, проверяет остаток, категорию и
   * потолок закупки атомарно); снижение — отрицательной (не ниже
   * оплаченного/оказанного, без неурегулированной оплаты); согласование при
   * этом расходуется. Без изменения суммы — только расходуется.
   */
  private async alignCommitment(
    tx: PubTx,
    product: ProductCtx,
    step: Step,
    p: PlacementRow,
    approvalId: string,
    snap: string,
    opKey: string,
  ): Promise<AuditInput[]> {
    const e = await tx.pubExpense.findFirst({
      where: { id: p.expenseId!, productId: product.id },
    });
    if (!e) throw new PubError('PUB_NOT_FOUND', { field: 'expenseId' });
    const delta = p.totalPriceMinor - e.amountTotalMinor;
    const note = 'Повторне погодження ціни закупки';
    const unsettled = await tx.pubExpenseEntry.count({
      where: {
        expenseId: e.id,
        kind: 'pay',
        status: { in: ['pending', 'unknown'] },
      },
    });
    if (delta !== 0n && unsettled > 0) {
      throw new PubError('PUB_RECONCILE_REQUIRED', { expenseId: e.id });
    }
    let entryId: string | null = null;
    if (delta > 0n) {
      if (await budgetFn.stopped(tx, product.id)) {
        throw new PubError('PUB_BUDGET_STOPPED', { reason: 'reconcile' });
      }
      const limit = await this.budget.limitRow(tx, product.id);
      if (!limit) throw new PubError('PUB_GATE_CLOSED', { gate: 'purchases' });
      const m = await this.budget.math(tx, product.id, limit);
      const ok = canReserve(m, delta, 'placements');
      if (!ok.ok) {
        throw new PubError(
          ok.reason === 'stopped'
            ? 'PUB_BUDGET_STOPPED'
            : 'PUB_BUDGET_INSUFFICIENT',
          {
            available: m.available.toString(),
            requested: delta.toString(),
            reason: ok.reason,
          },
        );
      }
      entryId = await budgetFn.adjust(tx, product, {
        expenseId: e.id,
        amount: delta,
        note,
        approvalId,
        priceSnapshotHash: snap,
        occurredAt: step.now,
        opKey,
        actor: step.actor,
      });
    } else {
      if (delta < 0n) {
        const next = e.amountTotalMinor + delta;
        if (
          next < e.paidMinor + e.cancelledMinor ||
          next < e.deliveredMinor + e.cancelledMinor
        ) {
          throw validationError([{ field: 'price', code: 'below_settled' }]);
        }
        entryId = await budgetFn.adjust(tx, product, {
          expenseId: e.id,
          amount: delta,
          note,
          approvalId: null,
          priceSnapshotHash: null,
          occurredAt: step.now,
          opKey,
          actor: step.actor,
        });
      }
      if (!(await this.approvals.consume(tx, approvalId))) {
        throw new PubError('PUB_CONFLICT', { approvalId });
      }
    }
    await refreshPaymentStatus(tx, p.id);
    return [
      {
        objectType: 'approval',
        objectId: approvalId,
        action: 'transition',
        fromStatus: 'active',
        toStatus: 'consumed',
      },
      ...(entryId
        ? [
            {
              objectType: 'expense_entry' as const,
              objectId: entryId,
              action: 'create' as const,
              toStatus: 'confirmed',
              meta: {
                expenseId: e.id,
                kind: 'adjust',
                amountMinor: Number(delta),
                approvalId,
              },
            },
          ]
        : []),
    ];
  }

  // ── budget_reserved: атомарный резерв (AT-CORE-14) ─────────────────────

  async reserve(
    tx: PubTx,
    product: ProductCtx,
    access: PubAccess,
    step: Step,
    id: string,
    b: Body,
    opKey: string,
  ): Promise<OpResult<PlacementView>> {
    const expected = parseExpectedRevision(b.expectedRevision);
    const p = await this.row(tx, product.id, id);
    assertTransition(
      PLACEMENT_MACHINE,
      p.status as PlacementStatus,
      'budget_reserved',
      {
        actors: actorsOf(access),
      },
    );
    assertRevision(p.revision, expected);
    await assertVenueVerified(tx, product.id, p.venueId);
    const pv = await this.ports
      .content()
      .publishableVersion(tx, product, p.versionId);
    if (pv.criticalStale) throw new PubError('PUB_CONTENT_STALE');
    await this.ports.gates().assertOpen(tx, product, 'purchases', step.now, {
      placement: {
        observationOk: p.observationOk,
        purchaseSeq: p.purchaseSeq,
        reportDecisionId: p.reportDecisionId,
      },
    });
    const a = p.approvalId
      ? await tx.pubApproval.findFirst({
          where: { id: p.approvalId, productId: product.id },
        })
      : null;
    if (!a || !['active', 'expired'].includes(a.status)) {
      // Согласование снято ростом цены — оно устарело, нужно новое.
      const superseded = await tx.pubApproval.count({
        where: {
          productId: product.id,
          type: 'purchase',
          objectId: p.id,
          status: 'superseded',
        },
      });
      throw new PubError(
        superseded > 0 ? 'PUB_APPROVAL_STALE' : 'PUB_APPROVAL_REQUIRED',
        superseded > 0 ? { reason: 'price_changed' } : {},
      );
    }
    if (a.status === 'expired' || !a.expiresAt || a.expiresAt <= step.now) {
      throw new PubError('PUB_APPROVAL_EXPIRED', {
        expiresAt: a.expiresAt?.toISOString() ?? null,
      });
    }
    const snap = priceSnapshotHash(p);
    if (a.priceSnapshotHash !== snap || a.versionHash !== pv.hash) {
      // Рост цены или новая версия материала — новое согласование (AT-F12-02).
      throw new PubError('PUB_APPROVAL_STALE', {
        priceSnapshotHash: snap,
        versionHash: pv.hash,
      });
    }
    if (await budgetFn.stopped(tx, product.id)) {
      throw new PubError('PUB_BUDGET_STOPPED', { reason: 'reconcile' });
    }
    // Причину отказа уточняем ДО атомарного вызова (после ошибки функции
    // транзакция прервана); решает всё равно условный UPDATE функции.
    const limit = await this.budget.limitRow(tx, product.id);
    if (!limit) {
      throw new PubError('PUB_GATE_CLOSED', {
        gate: 'purchases',
        missing: [
          { kind: 'budget', key: 'pub_budget_limits', detail: 'not_built' },
        ],
      });
    }
    const snapBefore = await this.budget.math(tx, product.id, limit);
    const amount = p.totalPriceMinor;
    const ok = canReserve(snapBefore, amount, 'placements');
    if (!ok.ok) {
      throw new PubError(
        ok.reason === 'stopped'
          ? 'PUB_BUDGET_STOPPED'
          : 'PUB_BUDGET_INSUFFICIENT',
        {
          available: snapBefore.available.toString(),
          requested: amount.toString(),
          reason: ok.reason,
        },
      );
    }
    let expenseId: string | null;
    try {
      expenseId = await budgetFn.reserve(tx, product, {
        amount,
        approvalId: a.id,
        priceSnapshotHash: snap,
        placementId: p.id,
        revision: p.revision,
        opKey,
        actor: step.actor,
      });
    } catch (e) {
      if (e instanceof PubError && e.code === 'PUB_BUDGET_INSUFFICIENT') {
        throw new PubError('PUB_BUDGET_INSUFFICIENT', {
          available: snapBefore.available.toString(),
          requested: amount.toString(),
          reason: 'concurrent',
        });
      }
      throw e;
    }
    return {
      body: await this.view(tx, product.id, id),
      audit: [
        {
          objectType: 'placement',
          objectId: p.id,
          action: 'transition',
          fromStatus: 'approved',
          toStatus: 'budget_reserved',
          meta: { expenseId, amountMinor: Number(amount) },
        },
        {
          objectType: 'approval',
          objectId: a.id,
          action: 'transition',
          fromStatus: 'active',
          toStatus: 'consumed',
        },
        {
          objectType: 'expense',
          objectId: expenseId ?? p.id,
          action: 'create',
          toStatus: 'open',
          meta: { category: 'placements', amountMinor: Number(amount) },
        },
      ],
    };
  }

  // ── ordered … verified_complete ────────────────────────────────────────

  private async move(
    tx: PubTx,
    product: ProductCtx,
    access: PubAccess,
    id: string,
    b: Body,
    to: PlacementStatus,
    data: Prisma.PubPlacementUncheckedUpdateManyInput,
    meta: Record<string, unknown> = {},
    reason?: string | null,
  ): Promise<OpResult<PlacementView>> {
    const expected = parseExpectedRevision(b.expectedRevision);
    const p = await this.row(tx, product.id, id);
    assertTransition(PLACEMENT_MACHINE, p.status as PlacementStatus, to, {
      actors: actorsOf(access),
    });
    assertRevision(p.revision, expected);
    const r = await tx.pubPlacement.updateMany({
      where: { id, revision: expected, status: p.status },
      data: { ...data, status: to, revision: { increment: 1 } },
    });
    if (r.count !== 1) throw new PubError('PUB_CONFLICT');
    return {
      body: await this.view(tx, product.id, id),
      audit: [
        {
          objectType: 'placement',
          objectId: id,
          action: 'transition',
          fromStatus: p.status,
          toStatus: to,
          reason: reason ?? null,
          meta,
        },
      ],
    };
  }

  private async assertNoUnsettledPay(tx: PubTx, expenseId: string | null) {
    if (!expenseId) return;
    const n = await tx.pubExpenseEntry.count({
      where: { expenseId, kind: 'pay', status: { in: ['pending', 'unknown'] } },
    });
    if (n > 0) throw new PubError('PUB_RECONCILE_REQUIRED', { expenseId });
  }

  async order(
    tx: PubTx,
    product: ProductCtx,
    access: PubAccess,
    step: Step,
    id: string,
    b: Body,
  ): Promise<OpResult<PlacementView>> {
    const f = new Fields();
    // Номер заказа — идентификатор поставщика (часто только цифры), не
    // свободный текст: правило контактов к нему не применяется (S2-2).
    const externalOrderId = f.str(b, 'externalOrderId', 200, { pii: false });
    const note = f.str(b, 'note', 2000, { optional: true });
    f.done();
    const p = await this.row(tx, product.id, id);
    // Сначала — сверка: повтор заказа при неизвестной оплате — RECONCILE
    // (AT-CORE-15), а не общий гейт.
    await this.assertNoUnsettledPay(tx, p.expenseId);
    // Заказ — только по согласованию текущей цены и обязательству на неё
    // (S0-1) и у всё ещё проверенной площадки (S3-4).
    if (p.status === 'budget_reserved') {
      await assertPriceApproved(tx, product.id, p);
    }
    await assertVenueVerified(tx, product.id, p.venueId);
    await this.ports.gates().assertOpen(tx, product, 'purchases', step.now, {
      placement: {
        observationOk: p.observationOk,
        purchaseSeq: p.purchaseSeq,
        reportDecisionId: p.reportDecisionId,
      },
    });
    return this.move(
      tx,
      product,
      access,
      id,
      b,
      'ordered',
      { externalOrderId },
      { externalOrderId },
      note,
    );
  }

  async awaitPublication(
    tx: PubTx,
    product: ProductCtx,
    access: PubAccess,
    id: string,
    b: Body,
  ): Promise<OpResult<PlacementView>> {
    const f = new Fields();
    const publishDueAt = f.date(b, 'publishDueAt');
    f.done();
    const p = await this.row(tx, product.id, id);
    if (p.status === 'ordered') await assertPriceApproved(tx, product.id, p);
    return this.move(tx, product, access, id, b, 'publication_pending', {
      publishDueAt,
    });
  }

  // ── Размещение: запись URL и проверка (S1-2) ───────────────────────────

  /** Канал записей размещений закупок продукта (создаётся по требованию). */
  private async paidChannel(
    tx: PubTx,
    product: ProductCtx,
    actor: string,
  ): Promise<string> {
    const ch = await tx.pubChannel.findFirst({
      where: { productId: product.id, code: PAID_VENUES_CHANNEL },
      select: { id: true, kind: true },
    });
    if (ch) {
      if (ch.kind !== 'paid_venue') {
        throw new PubError('PUB_CONFLICT', {
          field: 'channel',
          reason: 'paid_venues_code_taken',
        });
      }
      return ch.id;
    }
    const row = await tx.pubChannel.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        code: PAID_VENUES_CHANNEL,
        name: 'Платні майданчики',
        kind: 'paid_venue',
        utmSource: 'paid-venues',
        utmMedium: 'paid',
        rulesNote:
          'Записи розміщень закупок (F12): URL розміщення і перевірка — тут.',
        createdBy: actor,
      },
      select: { id: true },
    });
    return row.id;
  }

  /** URL размещения на площадке закупки (канонический) или 400. */
  private async venueUrlOf(
    tx: PubTx,
    productId: string,
    p: PlacementRow,
    raw: string,
  ): Promise<{ url: string; linkMarking: string }> {
    const v = await tx.pubVenue.findFirst({
      where: { id: p.venueId, productId },
      select: { url: true, linkMarking: true },
    });
    const url = canonicalUrl(raw);
    if (!v || !urlOnVenue(url, v.url)) {
      throw validationError([{ field: 'url', code: 'venue_mismatch' }]);
    }
    return { url, linkMarking: v.linkMarking };
  }

  /**
   * Записать размещение публикацией в канале `paid-venues` (URL хранится
   * в `pub_publications.finalUrl`; стадия — как у публикаций продукта,
   * live — под гейтом `public_publish`). Публикация — по действующему
   * согласованию версии закупки, а если его уже сменила новая версия того
   * же материала — по согласованию актуальной версии (страница по выданной
   * ссылке показывает её). Статус материала и t0 не трогает: их ставит
   * публикация на сайте.
   */
  private async recordPublication(
    tx: PubTx,
    product: ProductCtx,
    step: Step,
    p: PlacementRow,
    url: string,
    publishedAt: Date,
  ): Promise<string> {
    const target = await versionTarget(tx, product.id, p.versionId);
    if (!target) throw new PubError('PUB_NOT_FOUND', { field: 'versionId' });
    const stage =
      product.kind === 'working' && product.mode === 'live' ? 'live' : 'test';
    if (stage === 'live') {
      await this.ports
        .gates()
        .assertOpen(tx, product, 'public_publish', step.now);
    }
    const channelId = await this.paidChannel(tx, product, step.actor);
    const versions = await tx.pubContentVersion.findMany({
      where: { productId: product.id, contentId: target.contentId },
      select: { id: true },
      orderBy: { number: 'desc' },
    });
    const same = new Set(versions.map((v) => v.id));
    const active = await tx.pubPublication.findFirst({
      where: {
        productId: product.id,
        channelId,
        finalUrl: url,
        stage,
        status: { in: ['pending', 'published'] },
      },
      select: { id: true, versionId: true },
    });
    if (active) {
      if (same.has(active.versionId)) return active.id;
      throw new PubError('PUB_CONFLICT', {
        publicationId: active.id,
        reason: 'url_in_use',
      });
    }
    let use: { versionId: string; approvalId: string } | null = null;
    for (const vid of [
      p.versionId,
      ...[...same].filter((x) => x !== p.versionId),
    ]) {
      const pv = await this.ports
        .content()
        .publishableVersion(tx, product, vid);
      if (pv.approvalActive && pv.approvalId) {
        use = { versionId: vid, approvalId: pv.approvalId };
        break;
      }
    }
    if (!use) {
      throw new PubError('PUB_APPROVAL_REQUIRED', {
        versionId: p.versionId,
        reason: 'no_approved_version',
      });
    }
    const row = await tx.pubPublication.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        versionId: use.versionId,
        channelId,
        approvalId: use.approvalId,
        stage,
        finalUrl: url,
        publishedAt,
        status: 'published',
        opKey: randomUUID(),
        createdBy: step.actor,
      },
      select: { id: true },
    });
    return row.id;
  }

  /** Запись размещения закупки по URL (тот же материал, `published`). */
  private async placementPublication(
    tx: PubTx,
    productId: string,
    p: PlacementRow,
    url: string,
  ): Promise<{ id: string; revision: number } | null> {
    const target = await versionTarget(tx, productId, p.versionId);
    if (!target) return null;
    return tx.pubPublication.findFirst({
      where: {
        productId,
        finalUrl: url,
        status: 'published',
        channel: { code: PAID_VENUES_CHANNEL, kind: 'paid_venue' },
        version: { contentId: target.contentId },
      },
      select: { id: true, revision: true },
    });
  }

  async published(
    tx: PubTx,
    product: ProductCtx,
    access: PubAccess,
    step: Step,
    id: string,
    b: Body,
  ): Promise<OpResult<PlacementView>> {
    const f = new Fields();
    const raw = f.https(b, 'url');
    const publishedAt = f.date(b, 'publishedAt');
    f.done();
    const p = await this.row(tx, product.id, id);
    assertTransition(
      PLACEMENT_MACHINE,
      p.status as PlacementStatus,
      'published',
      {
        actors: actorsOf(access),
      },
    );
    const { url } = await this.venueUrlOf(tx, product.id, p, raw!);
    const publicationId = await this.recordPublication(
      tx,
      product,
      step,
      p,
      url,
      publishedAt!,
    );
    return this.move(
      tx,
      product,
      access,
      id,
      b,
      'published',
      { publishedAt },
      { publicationId },
    );
  }

  /**
   * Проверка размещения (§7.2, S1-2): URL — на площадке закупки и совпадает
   * с записанным при `published`; на странице найдена ВЫДАННАЯ ссылка
   * (`linkUrl`: utm_content = placementCode, кампания, адрес назначения);
   * маркировка — обещанная площадкой; доказательство (`evidenceUrl`:
   * снимок/архивная копия) обязательно. Результат — в записи публикации
   * (`verifyStatus=ok`, `evidenceUrl`, кто и когда проверил).
   */
  async verify(
    tx: PubTx,
    product: ProductCtx,
    access: PubAccess,
    step: Step,
    id: string,
    b: Body,
  ): Promise<OpResult<PlacementView>> {
    const f = new Fields();
    const raw = f.https(b, 'url');
    const linkUrl = f.https(b, 'linkUrl');
    const evidenceUrl = f.https(b, 'evidenceUrl');
    const marking = f.oneOf(b, 'marking', ['sponsored', 'nofollow'] as const);
    f.done();
    const p = await this.row(tx, product.id, id);
    assertTransition(
      PLACEMENT_MACHINE,
      p.status as PlacementStatus,
      'verified_complete',
      { actors: actorsOf(access) },
    );
    const campaign = await tx.pubCampaign.findFirst({
      where: { id: p.campaignId, productId: product.id },
      select: { code: true },
    });
    const issues: FieldIssue[] = [];
    let url: string | null = null;
    let promised = 'unknown';
    try {
      const v = await this.venueUrlOf(tx, product.id, p, raw!);
      url = v.url;
      promised = v.linkMarking;
    } catch {
      issues.push({ field: 'url', code: 'venue_mismatch' });
    }
    if (!linkOfPlacement(linkUrl!, p, campaign?.code ?? '')) {
      issues.push({ field: 'linkUrl', code: 'utm' });
    }
    if (promised !== 'unknown' && marking !== promised) {
      issues.push({ field: 'marking', code: 'mismatch' });
    }
    if (issues.length) throw validationError(issues);
    const pub = await this.placementPublication(tx, product.id, p, url!);
    if (!pub) throw validationError([{ field: 'url', code: 'not_published' }]);
    const r = await tx.pubPublication.updateMany({
      where: { id: pub.id, revision: pub.revision },
      data: {
        verifyStatus: 'ok',
        evidenceUrl: canonicalUrl(evidenceUrl!),
        lastVerifiedAt: step.now,
        verifiedBy: step.actor,
        verifyResult:
          `placement ${p.placementCode}; marking ${marking}; link ${linkUrl}`.slice(
            0,
            2000,
          ),
        revision: { increment: 1 },
      },
    });
    if (r.count !== 1) throw new PubError('PUB_CONFLICT');
    const out = await this.move(
      tx,
      product,
      access,
      id,
      b,
      'verified_complete',
      { verifiedAt: step.now },
      { publicationId: pub.id, marking },
    );
    out.audit.push({
      objectType: 'publication',
      objectId: pub.id,
      action: 'update',
      meta: { verifyStatus: 'ok', placementId: p.id },
    });
    return out;
  }

  /**
   * Претензия (AT-CORE-16): владелец и дата следующего действия
   * обязательны; владелец — участник с правом вести претензии в этом
   * продукте (PO/OP или владелец кабинета, S3-7).
   */
  async dispute(
    tx: PubTx,
    product: ProductCtx,
    access: PubAccess,
    id: string,
    b: Body,
  ): Promise<OpResult<PlacementView>> {
    const f = new Fields();
    const owner = f.id(b, 'claimOwnerMemberId');
    const nextActionAt = f.date(b, 'nextActionAt');
    const reason = f.str(b, 'reason', 2000);
    f.done();
    if (owner) {
      const acc = await memberAccessIn(tx, product.id, owner);
      if (!acc) {
        throw validationError([
          { field: 'claimOwnerMemberId', code: 'not_member' },
        ]);
      }
      if (!can(acc, 'placement.claim')) {
        throw validationError([
          { field: 'claimOwnerMemberId', code: 'no_role' },
        ]);
      }
    }
    return this.move(
      tx,
      product,
      access,
      id,
      b,
      'disputed',
      {
        claimStatus: 'open',
        claimOwnerMemberId: owner,
        nextActionAt,
      },
      { claimOwnerMemberId: owner },
      reason,
    );
  }

  async resolveDispute(
    tx: PubTx,
    product: ProductCtx,
    access: PubAccess,
    step: Step,
    id: string,
    b: Body,
    opKey: string,
  ): Promise<OpResult<PlacementView>> {
    const f = new Fields();
    const to = f.oneOf(b, 'to', [
      'publication_pending',
      'published',
      'cancelled',
    ] as const satisfies ReadonlyArray<ResolveDisputeBody['to']>);
    const reason = f.str(b, 'reason', 2000);
    f.done();
    if (to === 'cancelled') {
      const r = await this.cancel(
        tx,
        product,
        access,
        step,
        id,
        b,
        opKey,
        reason,
      );
      await tx.pubPlacement.updateMany({
        where: { id },
        data: { claimStatus: 'resolved' },
      });
      return { body: await this.view(tx, product.id, id), audit: r.audit };
    }
    const data: Prisma.PubPlacementUncheckedUpdateManyInput = {
      claimStatus: 'resolved',
    };
    let raw: string | null = null;
    if (to === 'publication_pending') {
      data.publishDueAt = f.date(b, 'publishDueAt');
    } else {
      raw = f.https(b, 'url');
      data.publishedAt = f.date(b, 'publishedAt');
    }
    f.done();
    const p = await this.row(tx, product.id, id);
    assertTransition(PLACEMENT_MACHINE, p.status as PlacementStatus, to!, {
      actors: actorsOf(access),
    });
    const meta: Record<string, unknown> = {};
    if (to === 'publication_pending') {
      await assertPriceApproved(tx, product.id, p);
    } else {
      const { url } = await this.venueUrlOf(tx, product.id, p, raw!);
      meta.publicationId = await this.recordPublication(
        tx,
        product,
        step,
        p,
        url,
        data.publishedAt as Date,
      );
    }
    return this.move(
      tx,
      product,
      access,
      id,
      b,
      to as PlacementStatus,
      data,
      meta,
      reason,
    );
  }

  /**
   * Отмена (AT-CORE-17): освобождается только подтверждённо отменённая
   * сумма (функция `pub_budget_cancel`); неотменённый остаток обязательства
   * остаётся в open_commitment до отдельного решения. Подтверждённая сумма
   * 0 — заказ снят без освобождения (S1-3: оплаченный заказ, деньги
   * возвращаются записью `refund`; закупка закрывается, следующая закупка
   * кампании становится возможной).
   */
  async cancel(
    tx: PubTx,
    product: ProductCtx,
    access: PubAccess,
    step: Step,
    id: string,
    b: Body,
    opKey: string,
    reasonOverride?: string | null,
  ): Promise<OpResult<PlacementView>> {
    const f = new Fields();
    const amount = f.minor(b, 'confirmedAmountMinor');
    const document = f.str(b, 'document', 2000);
    f.done();
    const p = await this.row(tx, product.id, id);
    assertTransition(
      PLACEMENT_MACHINE,
      p.status as PlacementStatus,
      'cancelled',
      {
        actors: actorsOf(access),
      },
    );
    if (!p.expenseId || amount === null) {
      throw validationError([{ field: 'confirmedAmountMinor', code: 'range' }]);
    }
    const entryId = await budgetFn.cancel(tx, product, {
      expenseId: p.expenseId,
      amount,
      sourceDocument: document,
      note: reasonOverride ?? null,
      occurredAt: step.now,
      opKey,
      actor: step.actor,
    });
    const r = await this.move(
      tx,
      product,
      access,
      id,
      b,
      'cancelled',
      {},
      { expenseId: p.expenseId, entryId, cancelledMinor: Number(amount) },
      reasonOverride ?? null,
    );
    await refreshPaymentStatus(tx, p.id);
    return { body: await this.view(tx, product.id, id), audit: r.audit };
  }

  async reject(
    tx: PubTx,
    product: ProductCtx,
    access: PubAccess,
    id: string,
    b: Body,
  ): Promise<OpResult<PlacementView>> {
    const f = new Fields();
    const reason = f.str(b, 'reason', 2000);
    f.done();
    const p = await this.row(tx, product.id, id);
    const r = await this.move(
      tx,
      product,
      access,
      id,
      b,
      'rejected',
      {},
      {},
      reason,
    );
    if (
      p.approvalId &&
      (await this.approvals.close(tx, p.approvalId, 'revoked', reason))
    ) {
      r.audit.push({
        objectType: 'approval',
        objectId: p.approvalId,
        action: 'revoke',
        fromStatus: 'active',
        toStatus: 'revoked',
        reason,
      });
    }
    return r;
  }
}

/** Статус оплаты закупки — из записей её обязательства (§6.4, §7.3). */
export async function refreshPaymentStatus(
  tx: PubTx,
  placementId: string,
): Promise<void> {
  const p = await tx.pubPlacement.findFirst({
    where: { id: placementId },
    select: { id: true, expenseId: true, paymentStatus: true },
  });
  if (!p?.expenseId) return;
  const e = await tx.pubExpense.findFirst({ where: { id: p.expenseId } });
  if (!e) return;
  const pays = await tx.pubExpenseEntry.findMany({
    where: { expenseId: e.id, kind: 'pay' },
    select: { status: true },
  });
  const st = paymentStatusOf(
    expenseAmountsOf(e),
    pays as Array<{ status: 'confirmed' | 'pending' | 'unknown' | 'void' }>,
  ).status;
  if (st !== p.paymentStatus) {
    await tx.pubPlacement.updateMany({
      where: { id: p.id },
      data: { paymentStatus: st, revision: { increment: 1 } },
    });
  }
}
