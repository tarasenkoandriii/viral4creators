/**
 * AI Publisher, P-R — списки раздела Reddit (`?before&limit≤100`, фильтры
 * `status`, `projectId`, `communityId`, `q`, у возможностей ещё `policyNow`;
 * §M1.5) и строки CSV-выгрузок.
 * Порядок — `id desc` (как в остальных списках модуля), курсор
 * `nextBefore` — id последней строки страницы. Запрашивается `limit + 1`
 * строк: лишняя — признак продолжения.
 */
import type { Prisma } from '@prisma/client';
import type {
  RedditCommunityView,
  RedditKeywordView,
  RedditOpportunityView,
  RedditProjectView,
} from '../contracts/reddit-api';
import {
  REDDIT_COMMUNITY_STATUSES,
  REDDIT_KEYWORD_STATUSES,
  REDDIT_OPPORTUNITY_STATUSES,
  REDDIT_POLICY_VERDICTS,
  REDDIT_PROJECT_STATUSES,
  type RedditPolicyVerdict,
} from '../contracts/states';
import { validationError } from '../core/errors';
import {
  communityView,
  currentRules,
  keywordView,
  opportunityViews,
  projectView,
  staleDaysFor,
  type ReadDb,
} from './views';

export interface ListParams {
  before?: string;
  /** Уже с запасом (`limit + 1`) или потолком CSV. */
  take: number;
  status?: string;
  projectId?: string;
  communityId?: string;
  q?: string;
  /** Только возможности: фильтр по живому гейту (реаудит N-6). */
  policyNow?: RedditPolicyVerdict;
}

const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * Проверка фильтров списка: id-формы и значения статуса; `policyNow` —
 * только там, где разрешён (`withPolicyNow`, список возможностей).
 */
export function listParams(
  raw: Record<string, unknown>,
  statuses: readonly string[],
  take: number,
  withPolicyNow = false,
): ListParams {
  const out: ListParams = { take };
  const issues: Array<{ field: string; code: string }> = [];
  for (const k of ['before', 'projectId', 'communityId'] as const) {
    const v = raw[k];
    if (v === undefined || v === '') continue;
    if (typeof v !== 'string' || !ID_RE.test(v))
      issues.push({ field: k, code: 'format' });
    else out[k] = v;
  }
  if (raw.status !== undefined && raw.status !== '') {
    if (typeof raw.status !== 'string' || !statuses.includes(raw.status))
      issues.push({ field: 'status', code: 'enum' });
    else out.status = raw.status;
  }
  if (withPolicyNow && raw.policyNow !== undefined && raw.policyNow !== '') {
    const v = raw.policyNow;
    if (
      typeof v !== 'string' ||
      !(REDDIT_POLICY_VERDICTS as readonly string[]).includes(v)
    )
      issues.push({ field: 'policyNow', code: 'enum' });
    else out.policyNow = v as RedditPolicyVerdict;
  }
  if (raw.q !== undefined && raw.q !== '') {
    if (typeof raw.q !== 'string' || [...raw.q].length > 200)
      issues.push({ field: 'q', code: 'length' });
    else out.q = raw.q.trim();
  }
  if (issues.length) throw validationError(issues);
  return out;
}

const contains = (q: string) => ({ contains: q, mode: 'insensitive' as const });
const cursor = (p: ListParams) => (p.before ? { id: { lt: p.before } } : {});

export async function listProjects(
  db: ReadDb,
  productId: string,
  p: ListParams,
): Promise<RedditProjectView[]> {
  const where: Prisma.PubRedditProjectWhereInput = {
    productId,
    ...cursor(p),
    ...(p.status ? { status: p.status } : {}),
    ...(p.q
      ? { OR: [{ name: contains(p.q) }, { market: contains(p.q) }] }
      : {}),
  };
  const rows = await db.pubRedditProject.findMany({
    where,
    orderBy: { id: 'desc' },
    take: p.take,
  });
  return rows.map(projectView);
}

export async function listCommunities(
  db: ReadDb,
  productId: string,
  p: ListParams,
  now: Date,
): Promise<RedditCommunityView[]> {
  const rows = await db.pubRedditCommunity.findMany({
    where: {
      productId,
      ...cursor(p),
      ...(p.status ? { status: p.status } : {}),
      ...(p.projectId ? { projectId: p.projectId } : {}),
      ...(p.q ? { name: contains(p.q.replace(/^\/?r\//i, '')) } : {}),
    },
    orderBy: { id: 'desc' },
    take: p.take,
  });
  const rules = await currentRules(
    db,
    productId,
    rows.map((r) => r.id),
  );
  const staleDays = await staleDaysFor(db, productId);
  return rows.map((c) =>
    communityView(c, rules.get(c.id) ?? null, now, staleDays),
  );
}

export async function listKeywords(
  db: ReadDb,
  productId: string,
  p: ListParams,
): Promise<RedditKeywordView[]> {
  const rows = await db.pubRedditKeyword.findMany({
    where: {
      productId,
      ...cursor(p),
      ...(p.status ? { status: p.status } : {}),
      ...(p.projectId ? { projectId: p.projectId } : {}),
      ...(p.q ? { phrase: contains(p.q) } : {}),
    },
    orderBy: { id: 'desc' },
    take: p.take,
  });
  return rows.map(keywordView);
}

/** Пачка просмотра при фильтре `policyNow` (живой гейт считается в коде). */
const POLICY_NOW_BATCH = 200;

export async function listOpportunities(
  db: ReadDb,
  productId: string,
  p: ListParams,
  now: Date = new Date(),
  /** Размер пачки просмотра при `policyNow` (тесты — меньше). */
  batch: number = POLICY_NOW_BATCH,
): Promise<RedditOpportunityView[]> {
  const where: Prisma.PubRedditOpportunityWhereInput = {
    productId,
    ...(p.status ? { status: p.status } : {}),
    ...(p.projectId ? { projectId: p.projectId } : {}),
    ...(p.communityId ? { communityId: p.communityId } : {}),
    ...(p.q
      ? { OR: [{ titleManual: contains(p.q) }, { threadUrl: contains(p.q) }] }
      : {}),
  };
  if (!p.policyNow) {
    const rows = await db.pubRedditOpportunity.findMany({
      where: { ...where, ...cursor(p) },
      orderBy: { id: 'desc' },
      take: p.take,
    });
    return opportunityViews(db, productId, rows, now);
  }
  // Реаудит N-6: `policyNow` — вычисляемый (сроки, отзыв первоисточника,
  // смена снимка), поэтому строки просматриваются пачками `id desc`, пока
  // не наберётся `take` подходящих. Курсор `nextBefore` (id последней
  // отданной строки) остаётся верным: пропущенные строки до него не
  // подходят под фильтр.
  const out: RedditOpportunityView[] = [];
  let before = p.before;
  for (;;) {
    const rows = await db.pubRedditOpportunity.findMany({
      where: { ...where, ...(before ? { id: { lt: before } } : {}) },
      orderBy: { id: 'desc' },
      take: batch,
    });
    if (rows.length === 0) break;
    const views = await opportunityViews(db, productId, rows, now);
    for (const v of views) {
      if (v.policyNow !== p.policyNow) continue;
      out.push(v);
      if (out.length >= p.take) return out;
    }
    if (rows.length < batch) break;
    before = rows[rows.length - 1].id;
  }
  return out;
}

export const LIST_STATUSES = {
  projects: REDDIT_PROJECT_STATUSES,
  communities: REDDIT_COMMUNITY_STATUSES,
  keywords: REDDIT_KEYWORD_STATUSES,
  opportunities: REDDIT_OPPORTUNITY_STATUSES,
} as const;

// ── Строки CSV (колонки — REDDIT_CSV_COLUMNS) ───────────────────────────

export function communityCsvRow(c: RedditCommunityView) {
  return {
    id: c.id,
    projectId: c.projectId,
    subreddit: c.subreddit,
    canonicalUrl: c.canonicalUrl,
    language: c.language,
    status: c.status,
    rulesVersion: c.rules?.version ?? null,
    rulesState: c.rules?.state ?? null,
    rulesCheckedAt: c.rules?.checkedAt ?? null,
    promotionPolicy: c.rules?.promotionPolicy ?? null,
    linksPolicy: c.rules?.linksPolicy ?? null,
  };
}

export function opportunityCsvRow(o: RedditOpportunityView) {
  return {
    id: o.id,
    projectId: o.projectId,
    subreddit: o.subreddit,
    threadUrl: o.threadUrl,
    titleManual: o.titleManual,
    intent: o.intent,
    relevance: o.score.relevance,
    risk: o.score.risk,
    priority: o.score.priority,
    missing: o.score.missing.join(' '),
    policy: o.policy,
    policyReasons: o.policyReasons.join(' '),
    policyNow: o.policyNow,
    policyNowReasons: o.policyNowReasons.join(' '),
    status: o.status,
    createdAt: o.createdAt,
  };
}
