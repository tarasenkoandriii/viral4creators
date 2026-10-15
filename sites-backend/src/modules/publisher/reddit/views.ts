/**
 * AI Publisher, P-R — строки `pub_reddit_*` → ответы API
 * (`contracts/reddit-api.ts`) и общие чтения зоны. Все чтения — клиентом
 * транзакции/кабинета (`SitesDb.forAccount`), всегда с `productId`: строка
 * чужого продукта неотличима от несуществующей (404).
 */
import type { Prisma } from '@prisma/client';
import type {
  RedditCommunityView,
  RedditEvidenceView,
  RedditExcerptsView,
  RedditRulesSourceView,
  RedditGateView,
  RedditKeywordView,
  RedditOpportunityView,
  RedditPolicyReason,
  RedditProjectView,
  RedditRuleSnapshotView,
  RedditRulesSummary,
} from '../contracts/reddit-api';
import type {
  RedditCommunityStatus,
  RedditIntent,
  RedditKeywordStatus,
  RedditLinksPolicy,
  RedditOpportunityStatus,
  RedditPolicyVerdict,
  RedditProjectStatus,
  RedditPromotionPolicy,
  RedditReviewState,
  RedditSnapshotStatus,
} from '../contracts/states';
import { PubError } from '../core/errors';
import type { PubTx } from '../core/ports';
import {
  policyGate,
  snapshotState,
  staleDaysOf,
  type PolicySnapshot,
} from './policy';
import { factorsFromJson } from './score';

export type ProjectRow = Prisma.PubRedditProjectGetPayload<object>;
export type CommunityRow = Prisma.PubRedditCommunityGetPayload<object>;
export type SnapshotRow = Prisma.PubRedditRuleSnapshotGetPayload<object>;
export type KeywordRow = Prisma.PubRedditKeywordGetPayload<object>;
export type OpportunityRow = Prisma.PubRedditOpportunityGetPayload<object>;
type SourceRow = Prisma.PubSourceGetPayload<object>;

/** Клиент чтения: транзакция операции или клиент кабинета. */
export type ReadDb = Pick<
  PubTx,
  | 'pubParameter'
  | 'pubRedditProject'
  | 'pubRedditCommunity'
  | 'pubRedditRuleSnapshot'
  | 'pubRedditKeyword'
  | 'pubRedditOpportunity'
  | 'pubSource'
>;

const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** Статусы параметра, чьё значение действует (посев — допущение 30). */
const STALE_DAYS_EFFECTIVE = ['approved', 'assumption'];

/**
 * Действующее значение `reddit_rules_stale_days` продукта (иначе 30).
 * Отозванное или отклонённое решение хранит прежнее `value`, но не действует
 * (аудит m1-3): тогда — умолчание.
 */
export async function staleDaysFor(
  db: ReadDb,
  productId: string,
): Promise<number> {
  const p = await db.pubParameter.findFirst({
    where: { productId, key: 'reddit_rules_stale_days' },
    select: { value: true, status: true },
  });
  return staleDaysOf(
    p && STALE_DAYS_EFFECTIVE.includes(p.status) ? p.value : null,
  );
}

export function projectView(r: ProjectRow): RedditProjectView {
  return {
    id: r.id,
    title: r.name,
    locale: r.locale,
    market: r.market,
    status: r.status as RedditProjectStatus,
    revision: r.revision,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function policySnapshotOf(
  s: SnapshotRow,
  sourceRevoked = false,
): PolicySnapshot {
  return {
    reviewState: s.reviewState as RedditReviewState,
    checkedAt: s.checkedAt,
    promotionPolicy: s.promotionPolicy as RedditPromotionPolicy,
    linksPolicy: s.linksPolicy as RedditLinksPolicy,
    sourceRevoked,
  };
}

/** Текущий снимок сообщества и состояние его первоисточника (S2-2). */
export interface CurrentRules {
  snap: SnapshotRow;
  sourceRevoked: boolean;
}

export function rulesSummary(
  s: SnapshotRow,
  now: Date,
  staleDays: number,
  sourceRevoked = false,
): RedditRulesSummary {
  const ps = policySnapshotOf(s, sourceRevoked);
  return {
    snapshotId: s.id,
    version: s.version,
    state: snapshotState(ps, now, staleDays),
    reviewState: ps.reviewState,
    checkedAt: s.checkedAt.toISOString(),
    reviewedAt: s.reviewedAt?.toISOString() ?? null,
    selfReview: s.selfReview,
    promotionPolicy: ps.promotionPolicy,
    linksPolicy: ps.linksPolicy,
    gate: policyGate(ps, now, staleDays, 'opportunity', false),
  };
}

export function communityView(
  c: CommunityRow,
  current: CurrentRules | null,
  now: Date,
  staleDays: number,
): RedditCommunityView {
  return {
    id: c.id,
    projectId: c.projectId,
    channelId: c.channelId,
    subreddit: c.name,
    canonicalUrl: c.canonicalUrl,
    descriptionManual: c.descriptionManual,
    language: c.language,
    topics: strArray(c.topics),
    status: c.status as RedditCommunityStatus,
    rules: current
      ? rulesSummary(current.snap, now, staleDays, current.sourceRevoked)
      : null,
    staleDays,
    revision: c.revision,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

export function snapshotView(
  s: SnapshotRow,
  src: SourceRow,
  now: Date,
  staleDays: number,
): RedditRuleSnapshotView {
  const ps = policySnapshotOf(s, src.usage === 'revoked');
  return {
    id: s.id,
    communityId: s.communityId,
    version: s.version,
    source: {
      id: src.id,
      url: src.url ?? '',
      excerpt: src.fragment,
      injectionFlag: src.injectionFlag,
      usage: src.usage as RedditRuleSnapshotView['source']['usage'],
    },
    promotionPolicy: ps.promotionPolicy,
    linksPolicy: ps.linksPolicy,
    flairRequired: s.flairRequired,
    conditions: strArray(s.conditions),
    checkedAt: s.checkedAt.toISOString(),
    reviewState: ps.reviewState,
    state: snapshotState(ps, now, staleDays),
    createdBy: s.createdBy,
    reviewedBy: s.reviewedBy,
    reviewedAt: s.reviewedAt?.toISOString() ?? null,
    selfReview: s.selfReview,
    status: s.status as RedditSnapshotStatus,
    gate: policyGate(ps, now, staleDays, 'opportunity', false),
    createdAt: s.createdAt.toISOString(),
  };
}

export function keywordView(k: KeywordRow): RedditKeywordView {
  return {
    id: k.id,
    projectId: k.projectId,
    phrase: k.phrase,
    phraseNorm: k.phraseNorm,
    intent: k.intent as RedditIntent,
    locale: k.locale,
    priority: k.priority,
    status: k.status as RedditKeywordStatus,
    revision: k.revision,
    createdAt: k.createdAt.toISOString(),
    updatedAt: k.updatedAt.toISOString(),
  };
}

export function opportunityView(
  o: OpportunityRow,
  ctx: {
    subreddit: string;
    excerpt: SourceRow | null;
    snapshotVersion: number | null;
    /** Гейт сейчас (пересчитан при чтении, S2-3). */
    now: RedditGateView;
  },
): RedditOpportunityView {
  const factors = factorsFromJson(o.factors);
  const missing = (Object.keys(factors) as Array<keyof typeof factors>).filter(
    (k) => factors[k].value === null,
  );
  return {
    id: o.id,
    projectId: o.projectId,
    communityId: o.communityId,
    subreddit: ctx.subreddit,
    threadUrl: o.threadUrl,
    threadKey: o.threadKey,
    titleManual: o.titleManual,
    excerpt: ctx.excerpt
      ? {
          sourceId: ctx.excerpt.id,
          text: ctx.excerpt.fragment,
          injectionFlag: ctx.excerpt.injectionFlag,
          usage: ctx.excerpt.usage as 'allowed' | 'restricted' | 'revoked',
        }
      : null,
    intent: o.intent as RedditIntent,
    angle: o.angle,
    keywordIds: strArray(o.keywordIds),
    factors,
    score: {
      scoreVersion: 'v1',
      relevance: o.relevance,
      risk: o.risk,
      priority: o.priority,
      missing,
    },
    ruleSnapshotId: o.ruleSnapshotId,
    ruleSnapshotVersion: ctx.snapshotVersion,
    policy: o.policy as RedditPolicyVerdict,
    policyReasons: strArray(o.policyReasons) as RedditPolicyReason[],
    policyNow: ctx.now.verdict,
    policyNowReasons: ctx.now.reasons,
    status: o.status as RedditOpportunityStatus,
    revision: o.revision,
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
  };
}

// ── Загрузчики (404 для чужого/несуществующего) ─────────────────────────

export async function projectRow(
  db: ReadDb,
  productId: string,
  id: string,
): Promise<ProjectRow> {
  const r = await db.pubRedditProject.findFirst({ where: { id, productId } });
  if (!r) throw new PubError('PUB_NOT_FOUND');
  return r;
}

export async function communityRow(
  db: ReadDb,
  productId: string,
  id: string,
): Promise<CommunityRow> {
  const r = await db.pubRedditCommunity.findFirst({
    where: { id, productId },
  });
  if (!r) throw new PubError('PUB_NOT_FOUND');
  return r;
}

export async function currentSnapshot(
  db: ReadDb,
  productId: string,
  communityId: string,
): Promise<SnapshotRow | null> {
  return db.pubRedditRuleSnapshot.findFirst({
    where: { productId, communityId, status: 'current' },
  });
}

/** Текущие снимки сообществ с признаком отзыва первоисточника (одним проходом). */
export async function currentRules(
  db: ReadDb,
  productId: string,
  communityIds: string[],
): Promise<Map<string, CurrentRules>> {
  if (communityIds.length === 0) return new Map();
  const snaps = await db.pubRedditRuleSnapshot.findMany({
    where: { productId, status: 'current', communityId: { in: communityIds } },
  });
  const revoked = new Set(
    (
      await db.pubSource.findMany({
        where: {
          productId,
          id: { in: snaps.map((x) => x.sourceId) },
          usage: 'revoked',
        },
        select: { id: true },
      })
    ).map((x) => x.id),
  );
  return new Map(
    snaps.map((x) => [
      x.communityId,
      { snap: x, sourceRevoked: revoked.has(x.sourceId) },
    ]),
  );
}

/**
 * Гейт возможности СЕЙЧАС (S2-3): по текущему снимку, `staleDays` и отзыву
 * первоисточника. Гейт ok, но оценка была по другому снимку —
 * `recheck_required` (`rules_changed`).
 */
export function gateNow(
  o: Pick<OpportunityRow, 'ruleSnapshotId'>,
  rules: CurrentRules | null,
  now: Date,
  staleDays: number,
): RedditGateView {
  const g = policyGate(
    rules ? policySnapshotOf(rules.snap, rules.sourceRevoked) : null,
    now,
    staleDays,
    'opportunity',
    false,
  );
  if (g.verdict === 'ok' && (rules?.snap.id ?? null) !== o.ruleSnapshotId)
    return {
      verdict: 'recheck_required',
      reasons: ['rules_changed'],
      warnings: [],
    };
  return g;
}

export async function loadCommunityView(
  db: ReadDb,
  productId: string,
  id: string,
  now: Date,
): Promise<RedditCommunityView> {
  const c = await communityRow(db, productId, id);
  return communityView(
    c,
    (await currentRules(db, productId, [id])).get(id) ?? null,
    now,
    await staleDaysFor(db, productId),
  );
}

export async function loadSnapshotView(
  db: ReadDb,
  productId: string,
  id: string,
  now: Date,
): Promise<RedditRuleSnapshotView> {
  const s = await db.pubRedditRuleSnapshot.findFirst({
    where: { id, productId },
  });
  if (!s) throw new PubError('PUB_NOT_FOUND');
  const src = await db.pubSource.findFirst({
    where: { id: s.sourceId, productId },
  });
  if (!src) throw new PubError('PUB_NOT_FOUND');
  return snapshotView(s, src, now, await staleDaysFor(db, productId));
}

export async function opportunityRow(
  db: ReadDb,
  productId: string,
  id: string,
): Promise<OpportunityRow> {
  const r = await db.pubRedditOpportunity.findFirst({
    where: { id, productId },
  });
  if (!r) throw new PubError('PUB_NOT_FOUND');
  return r;
}

/** Ответы списка/карточки возможностей одним проходом (без N+1). */
export async function opportunityViews(
  db: ReadDb,
  productId: string,
  rows: OpportunityRow[],
  now: Date = new Date(),
): Promise<RedditOpportunityView[]> {
  if (rows.length === 0) return [];
  const communityIds = [...new Set(rows.map((r) => r.communityId))];
  const sourceIds = rows
    .map((r) => r.excerptSourceId)
    .filter((x): x is string => !!x);
  const snapIds = rows
    .map((r) => r.ruleSnapshotId)
    .filter((x): x is string => !!x);
  const [communities, sources, snaps] = await Promise.all([
    db.pubRedditCommunity.findMany({
      where: { productId, id: { in: communityIds } },
      select: { id: true, name: true },
    }),
    sourceIds.length
      ? db.pubSource.findMany({ where: { productId, id: { in: sourceIds } } })
      : Promise.resolve([] as SourceRow[]),
    snapIds.length
      ? db.pubRedditRuleSnapshot.findMany({
          where: { productId, id: { in: snapIds } },
          select: { id: true, version: true },
        })
      : Promise.resolve([] as Array<{ id: string; version: number }>),
  ]);
  const rules = await currentRules(db, productId, communityIds);
  const staleDays = await staleDaysFor(db, productId);
  const cName = new Map(communities.map((c) => [c.id, c.name]));
  const src = new Map(sources.map((s) => [s.id, s]));
  const snapV = new Map(snaps.map((s) => [s.id, s.version]));
  return rows.map((o) =>
    opportunityView(o, {
      subreddit: cName.get(o.communityId) ?? '',
      excerpt: o.excerptSourceId ? (src.get(o.excerptSourceId) ?? null) : null,
      snapshotVersion: o.ruleSnapshotId
        ? (snapV.get(o.ruleSnapshotId) ?? null)
        : null,
      now: gateNow(o, rules.get(o.communityId) ?? null, now, staleDays),
    }),
  );
}

export async function loadOpportunityView(
  db: ReadDb,
  productId: string,
  id: string,
): Promise<RedditOpportunityView> {
  const o = await opportunityRow(db, productId, id);
  return (await opportunityViews(db, productId, [o]))[0];
}

// ── Доказательства P-R (UI-аудит S2-2, Р-RD-46) ─────────────────────────

function evidenceView(
  src: SourceRow,
  revision: number,
  current: boolean,
): RedditEvidenceView {
  return {
    sourceId: src.id,
    revision,
    supersedesId: src.supersedesId,
    current,
    url: src.url ?? '',
    fragment: src.fragment,
    injectionFlag: src.injectionFlag,
    usage: src.usage as RedditEvidenceView['usage'],
    revokedAt: src.revokedAt?.toISOString() ?? null,
    revokeReason: src.revokeReason,
    createdAt: src.createdAt.toISOString(),
    createdBy: src.createdBy,
  };
}

/**
 * Все выдержки треда возможности (при любом её статусе): источники продукта
 * `origin='reddit'`, `discussion`, `url = threadUrl` — выдержка пишется
 * только с URL своего треда, и он у возможности неизменен. Так видны и
 * прежние редакции (`supersedesId`), и выдержки, отвязанные `null`.
 */
export async function opportunityExcerpts(
  db: ReadDb,
  productId: string,
  id: string,
): Promise<RedditExcerptsView> {
  const o = await opportunityRow(db, productId, id);
  const rows = await db.pubSource.findMany({
    where: {
      productId,
      origin: 'reddit',
      kind: 'discussion',
      url: o.threadUrl,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return {
    opportunityId: o.id,
    currentSourceId: o.excerptSourceId,
    items: rows.map((r, i) =>
      evidenceView(r, i + 1, r.id === o.excerptSourceId),
    ),
  };
}

/** Первоисточник снимка правил сообщества (и `superseded`). */
export async function rulesSource(
  db: ReadDb,
  productId: string,
  communityId: string,
  snapshotId: string,
): Promise<RedditRulesSourceView> {
  await communityRow(db, productId, communityId);
  const s = await db.pubRedditRuleSnapshot.findFirst({
    where: { id: snapshotId, productId, communityId },
  });
  if (!s) throw new PubError('PUB_NOT_FOUND');
  const src = await db.pubSource.findFirst({
    where: { id: s.sourceId, productId },
  });
  if (!src) throw new PubError('PUB_NOT_FOUND');
  return {
    snapshotId: s.id,
    communityId: s.communityId,
    version: s.version,
    status: s.status as RedditSnapshotStatus,
    source: evidenceView(src, 1, s.status === 'current'),
  };
}
