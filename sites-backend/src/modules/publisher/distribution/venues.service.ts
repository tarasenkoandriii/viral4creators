/**
 * AI Publisher, P-C — карточки площадок F10 (проектный документ §6.4
 * `pub_venues`, `pub_venue_evidence`, §7.2; AT-F10-01/02).
 *
 *  - пять одинаковых критериев 0–2 с пояснением; неизвестный — `null`, не
 *    усредняется и не даёт положительного вклада; полнота показывается
 *    отдельно от балла;
 *  - `verified` — только при всех пяти обязательных проверках (тематика и
 *    рынок, подтверждённые итоговая цена и формат, срок, понятный
 *    поставщик), известной маркировке ссылки и хотя бы одном доказательстве
 *    (источник данных); высокий балл без соответствия аудитории (проверка
 *    `topicMarket`) карточку не верифицирует;
 *  - полей прогноза переходов/просмотров нет — такие поля в теле
 *    отвергаются (`unknown_field`), а не молча теряются.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { ProductCtx } from '../contracts/common';
import type {
  CriterionScore,
  VenueCriterion,
  VenueView,
} from '../contracts/distribution-api';
import { VENUE_CRITERIA, type VenueStatus } from '../contracts/states';
import { PubError, validationError } from '../core/errors';
import type { PubTx } from '../core/ports';
import { assertRevision, parseExpectedRevision } from '../core/revision';
import type { PubAccess } from '../core/roles';
import { VENUE_MACHINE, assertTransition } from '../core/state-machines';
import { Fields, type Body } from './input';
import { actorsOf, type OpResult, type Step } from './placements.service';

type VenueRow = Prisma.PubVenueGetPayload<object>;
type EvidenceRow = Prisma.PubVenueEvidenceGetPayload<object>;

const CHECK_KEYS = [
  'topicMarket',
  'priceConfirmed',
  'formatConfirmed',
  'termSet',
  'supplierKnown',
] as const;
type CheckKey = (typeof CHECK_KEYS)[number];
const CHECK_COLUMN: Record<CheckKey, keyof VenueRow> = {
  topicMarket: 'checkTopicMarket',
  priceConfirmed: 'checkPriceConfirmed',
  formatConfirmed: 'checkFormatConfirmed',
  termSet: 'checkTermSet',
  supplierKnown: 'checkSupplierKnown',
};

const BODY_KEYS = [
  'opKey',
  'expectedRevision',
  'title',
  'url',
  'topic',
  'market',
  'language',
  'audienceNote',
  'formats',
  'criteria',
  'checks',
  'linkMarking',
  'riskNote',
  'evidence',
] as const;

/** Балл: сумма ИЗВЕСТНЫХ оценок; неизвестное не усредняется (F10). */
export function venueScore(
  criteria: Partial<Record<VenueCriterion, CriterionScore>>,
): { sum: number; max: number; known: number } {
  let sum = 0;
  let known = 0;
  for (const c of VENUE_CRITERIA) {
    const s = criteria[c]?.score;
    if (s === 0 || s === 1 || s === 2) {
      sum += s;
      known++;
    }
  }
  return { sum, max: known * 2, known };
}

/** Чего не хватает до `verified` (пусто — можно). */
export function missingForVerified(
  v: Pick<
    VenueRow,
    | 'checkTopicMarket'
    | 'checkPriceConfirmed'
    | 'checkFormatConfirmed'
    | 'checkTermSet'
    | 'checkSupplierKnown'
    | 'linkMarking'
  >,
  evidenceCount: number,
): string[] {
  const out: string[] = [];
  for (const k of CHECK_KEYS) {
    if (!v[CHECK_COLUMN[k] as keyof typeof v]) out.push(`checks.${k}`);
  }
  if (v.linkMarking === 'unknown') out.push('linkMarking');
  if (evidenceCount === 0) out.push('evidence');
  return out;
}

export function venueView(v: VenueRow, ev: EvidenceRow[]): VenueView {
  const criteria = (v.criteria ?? {}) as Partial<
    Record<VenueCriterion, CriterionScore>
  >;
  return {
    id: v.id,
    title: v.name,
    url: v.url,
    topic: v.topic,
    market: v.market,
    language: v.language,
    audienceNote: v.audienceNote,
    formats: v.formats,
    criteria,
    score: venueScore(criteria),
    completeness: v.completeness,
    checks: {
      topicMarket: v.checkTopicMarket,
      priceConfirmed: v.checkPriceConfirmed,
      formatConfirmed: v.checkFormatConfirmed,
      termSet: v.checkTermSet,
      supplierKnown: v.checkSupplierKnown,
    },
    linkMarking: v.linkMarking as VenueView['linkMarking'],
    riskNote: v.riskNote,
    rejectReason: v.rejectReason,
    status: v.status as VenueStatus,
    evidence: ev.map((e) => ({
      id: e.id,
      criterion: e.criterion as VenueCriterion,
      sourceId: e.sourceId,
      checkedAt: e.checkedAt.toISOString(),
    })),
    missingForVerified: missingForVerified(v, ev.length),
    revision: v.revision,
  };
}

function parseCriteria(
  f: Fields,
  v: unknown,
): Partial<Record<VenueCriterion, CriterionScore>> | null {
  if (v === undefined) return null;
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    f.add('criteria', 'type');
    return null;
  }
  const out: Partial<Record<VenueCriterion, CriterionScore>> = {};
  for (const [k, x] of Object.entries(v as Body)) {
    if (!(VENUE_CRITERIA as readonly string[]).includes(k)) {
      f.add(`criteria.${k}`, 'unknown_field');
      continue;
    }
    if (!x || typeof x !== 'object' || Array.isArray(x)) {
      f.add(`criteria.${k}`, 'type');
      continue;
    }
    const xb = x as Body;
    f.only(xb, ['score', 'why'], `criteria.${k}.`);
    const score = xb.score;
    if (!(score === null || score === 0 || score === 1 || score === 2)) {
      f.add(`criteria.${k}.score`, 'enum');
      continue;
    }
    const why = f.str(xb, 'why', 2000);
    if (why === null) {
      f.issues.pop();
      f.add(`criteria.${k}.why`, 'required');
      continue;
    }
    out[k as VenueCriterion] = { score, why };
  }
  return out;
}

@Injectable()
export class VenuesService {
  async row(tx: PubTx, productId: string, id: string): Promise<VenueRow> {
    const v = await tx.pubVenue.findFirst({ where: { id, productId } });
    if (!v) throw new PubError('PUB_NOT_FOUND');
    return v;
  }

  async view(tx: PubTx, productId: string, id: string): Promise<VenueView> {
    const v = await this.row(tx, productId, id);
    const ev = await tx.pubVenueEvidence.findMany({
      where: { venueId: id },
      orderBy: { checkedAt: 'asc' },
    });
    return venueView(v, ev);
  }

  async list(
    tx: PubTx,
    productId: string,
    q: { status?: string; before?: string; limit: number },
  ): Promise<VenueView[]> {
    const rows = await tx.pubVenue.findMany({
      where: {
        productId,
        ...(q.status ? { status: q.status } : {}),
        ...(q.before ? { id: { lt: q.before } } : {}),
      },
      orderBy: { id: 'desc' },
      take: q.limit,
    });
    const ev = await tx.pubVenueEvidence.findMany({
      where: { venueId: { in: rows.map((r) => r.id) } },
    });
    return rows.map((r) =>
      venueView(
        r,
        ev.filter((e) => e.venueId === r.id),
      ),
    );
  }

  private parse(
    b: Body,
    creating: boolean,
  ): {
    data: Prisma.PubVenueUncheckedUpdateManyInput;
    evidence: Array<{
      criterion: VenueCriterion;
      sourceId: string;
      checkedAt: Date;
    }>;
  } {
    const f = new Fields();
    f.only(b, BODY_KEYS);
    const data: Prisma.PubVenueUncheckedUpdateManyInput = {};
    if (creating || b.title !== undefined)
      data.name = f.str(b, 'title', 300) ?? undefined;
    if (creating || b.url !== undefined)
      data.url = f.https(b, 'url') ?? undefined;
    for (const [k, max] of [
      ['topic', 300],
      ['market', 100],
      ['language', 35],
      ['audienceNote', 2000],
      ['riskNote', 2000],
    ] as const) {
      if (b[k] !== undefined) data[k] = f.str(b, k, max, { optional: true });
    }
    if (b.formats !== undefined) {
      if (b.formats === null || typeof b.formats !== 'object')
        f.add('formats', 'type');
      else data.formats = b.formats as Prisma.InputJsonValue;
    } else if (creating) {
      data.formats = [];
    }
    const criteria = parseCriteria(f, b.criteria);
    if (criteria) {
      data.criteria = criteria as Prisma.InputJsonValue;
      data.completeness = Object.values(criteria).filter(
        (c) => c && c.score !== null,
      ).length;
    } else if (creating) {
      data.criteria = {};
      data.completeness = 0;
    }
    if (b.checks !== undefined) {
      if (
        !b.checks ||
        typeof b.checks !== 'object' ||
        Array.isArray(b.checks)
      ) {
        f.add('checks', 'type');
      } else {
        const cb = b.checks as Body;
        f.only(cb, CHECK_KEYS, 'checks.');
        for (const k of CHECK_KEYS) {
          if (cb[k] === undefined) continue;
          if (typeof cb[k] !== 'boolean') f.add(`checks.${k}`, 'type');
          else (data as Record<string, unknown>)[CHECK_COLUMN[k]] = cb[k];
        }
      }
    }
    if (b.linkMarking !== undefined) {
      data.linkMarking =
        f.oneOf(b, 'linkMarking', [
          'sponsored',
          'nofollow',
          'unknown',
        ] as const) ?? undefined;
    }
    const evidence: Array<{
      criterion: VenueCriterion;
      sourceId: string;
      checkedAt: Date;
    }> = [];
    if (b.evidence !== undefined) {
      if (!Array.isArray(b.evidence)) f.add('evidence', 'type');
      else {
        b.evidence.forEach((x, i) => {
          if (!x || typeof x !== 'object') {
            f.add(`evidence.${i}`, 'type');
            return;
          }
          const xb = x as Body;
          const criterion = f.oneOf(xb, 'criterion', VENUE_CRITERIA);
          const sourceId = f.id(xb, 'sourceId');
          const checkedAt = f.date(xb, 'checkedAt');
          if (criterion && sourceId && checkedAt) {
            evidence.push({ criterion, sourceId, checkedAt });
          }
        });
      }
    }
    f.done();
    return { data, evidence };
  }

  private async addEvidence(
    tx: PubTx,
    product: ProductCtx,
    venueId: string,
    evidence: Array<{
      criterion: VenueCriterion;
      sourceId: string;
      checkedAt: Date;
    }>,
    actor: string,
  ): Promise<void> {
    for (const e of evidence) {
      const src = await tx.pubSource.findFirst({
        where: { id: e.sourceId, productId: product.id },
        select: { id: true, usage: true },
      });
      if (!src)
        throw validationError([
          { field: 'evidence.sourceId', code: 'not_found' },
        ]);
      if (src.usage === 'revoked') {
        throw new PubError('PUB_SOURCE_NOT_ALLOWED', { sourceId: e.sourceId });
      }
      await tx.pubVenueEvidence.upsert({
        where: {
          venueId_criterion_sourceId: {
            venueId,
            criterion: e.criterion,
            sourceId: e.sourceId,
          },
        },
        create: {
          accountId: product.accountId,
          productId: product.id,
          venueId,
          criterion: e.criterion,
          sourceId: e.sourceId,
          checkedAt: e.checkedAt,
          createdBy: actor,
        },
        update: {},
      });
    }
  }

  async create(
    tx: PubTx,
    product: ProductCtx,
    step: Step,
    b: Body,
  ): Promise<OpResult<VenueView>> {
    const { data, evidence } = this.parse(b, true);
    const row = await tx.pubVenue.create({
      data: {
        ...(data as Prisma.PubVenueUncheckedCreateInput),
        accountId: product.accountId,
        productId: product.id,
        createdBy: step.actor,
      },
    });
    await this.addEvidence(tx, product, row.id, evidence, step.actor);
    return {
      body: await this.view(tx, product.id, row.id),
      audit: [
        {
          objectType: 'venue',
          objectId: row.id,
          action: 'create',
          toStatus: 'candidate',
          meta: { completeness: row.completeness },
        },
      ],
    };
  }

  async patch(
    tx: PubTx,
    product: ProductCtx,
    step: Step,
    id: string,
    b: Body,
  ): Promise<OpResult<VenueView>> {
    const expected = parseExpectedRevision(b.expectedRevision);
    const v = await this.row(tx, product.id, id);
    assertRevision(v.revision, expected);
    const { data, evidence } = this.parse(b, false);
    // Карточка `verified` с утраченным обязательным условием возвращается в
    // кандидаты (§7.2 «verified → candidate») в ТОЙ ЖЕ записи — иначе
    // гвард базы отверг бы «проверенную» карточку без условий.
    const merged = { ...v, ...(data as Partial<VenueRow>) };
    const evBefore = await tx.pubVenueEvidence.count({
      where: { venueId: id },
    });
    const missing = missingForVerified(merged, evBefore + evidence.length);
    const downgrade = v.status === 'verified' && missing.length > 0;
    const r = await tx.pubVenue.updateMany({
      where: { id, revision: expected },
      data: {
        ...data,
        ...(downgrade ? { status: 'candidate' } : {}),
        revision: { increment: 1 },
      },
    });
    if (r.count !== 1) throw new PubError('PUB_CONFLICT');
    await this.addEvidence(tx, product, id, evidence, step.actor);
    const audit: OpResult<VenueView>['audit'] = [
      { objectType: 'venue', objectId: id, action: 'update' },
    ];
    if (downgrade) {
      audit.push({
        objectType: 'venue',
        objectId: id,
        action: 'transition',
        fromStatus: 'verified',
        toStatus: 'candidate',
        meta: { missing: missing.join(',') },
      });
    }
    return { body: await this.view(tx, product.id, id), audit };
  }

  async transition(
    tx: PubTx,
    product: ProductCtx,
    access: PubAccess,
    id: string,
    b: Body,
  ): Promise<OpResult<VenueView>> {
    const expected = parseExpectedRevision(b.expectedRevision);
    const f = new Fields();
    const to = f.oneOf(b, 'to', ['verified', 'rejected', 'candidate'] as const);
    const reason = f.str(b, 'reason', 2000, { optional: true });
    f.done();
    const v = await this.row(tx, product.id, id);
    assertTransition(VENUE_MACHINE, v.status as VenueStatus, to!, {
      actors: actorsOf(access),
    });
    assertRevision(v.revision, expected);
    if (to === 'verified') {
      const ev = await tx.pubVenueEvidence.count({ where: { venueId: id } });
      const missing = missingForVerified(v, ev);
      if (missing.length) {
        throw validationError(
          missing.map((field) => ({ field, code: 'required' })),
        );
      }
    }
    if (to === 'rejected' && !reason) {
      throw validationError([{ field: 'reason', code: 'required' }]);
    }
    const r = await tx.pubVenue.updateMany({
      where: { id, revision: expected, status: v.status },
      data: {
        status: to!,
        ...(to === 'rejected' ? { rejectReason: reason } : {}),
        revision: { increment: 1 },
      },
    });
    if (r.count !== 1) throw new PubError('PUB_CONFLICT');
    return {
      body: await this.view(tx, product.id, id),
      audit: [
        {
          objectType: 'venue',
          objectId: id,
          action: 'transition',
          fromStatus: v.status,
          toStatus: to,
          reason,
        },
      ],
    };
  }
}
