/**
 * AI Publisher, P-R M2 — списки брифов и публикаций раздела Reddit
 * (`?before&limit≤100&format=csv`, `id desc`, курсор `nextBefore`; §M2.7) и
 * строки CSV (`REDDIT_CSV_COLUMNS.briefs|publications`).
 */
import type { Prisma } from '@prisma/client';
import type {
  RedditBriefView,
  RedditPublicationView,
} from '../contracts/reddit-api';
import {
  PUBLICATION_STAGES,
  PUBLICATION_STATUSES,
  REDDIT_BRIEF_STATUSES,
  REDDIT_CONTENT_TYPES,
} from '../contracts/states';
import { validationError } from '../core/errors';
import type { PubTx } from '../core/ports';
import { loadBriefViews, redditPublicationViews } from './brief-views';
import { listParams, type ListParams } from './lists';

const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

export interface BriefListParams extends ListParams {
  opportunityId?: string;
  contentType?: string;
}

export function briefListParams(
  raw: Record<string, unknown>,
  take: number,
): BriefListParams {
  const p: BriefListParams = listParams(raw, REDDIT_BRIEF_STATUSES, take);
  const issues: Array<{ field: string; code: string }> = [];
  if (raw.opportunityId !== undefined && raw.opportunityId !== '') {
    if (typeof raw.opportunityId !== 'string' || !ID_RE.test(raw.opportunityId))
      issues.push({ field: 'opportunityId', code: 'format' });
    else p.opportunityId = raw.opportunityId;
  }
  if (raw.contentType !== undefined && raw.contentType !== '') {
    if (
      typeof raw.contentType !== 'string' ||
      !(REDDIT_CONTENT_TYPES as readonly string[]).includes(raw.contentType)
    )
      issues.push({ field: 'contentType', code: 'enum' });
    else p.contentType = raw.contentType;
  }
  if (issues.length) throw validationError(issues);
  return p;
}

export async function listBriefs(
  db: PubTx,
  productId: string,
  p: BriefListParams,
  now: Date,
): Promise<RedditBriefView[]> {
  const where: Prisma.PubRedditBriefWhereInput = {
    productId,
    ...(p.before ? { id: { lt: p.before } } : {}),
    ...(p.status ? { status: p.status } : {}),
    ...(p.projectId ? { projectId: p.projectId } : {}),
    ...(p.communityId ? { communityId: p.communityId } : {}),
    ...(p.opportunityId ? { opportunityId: p.opportunityId } : {}),
    ...(p.contentType ? { contentType: p.contentType } : {}),
    ...(p.q
      ? { objective: { contains: p.q, mode: 'insensitive' as const } }
      : {}),
  };
  const rows = await db.pubRedditBrief.findMany({
    where,
    orderBy: { id: 'desc' },
    take: p.take,
    select: { id: true },
  });
  // Аудит m2-13: страница — пакетом (CSV до 5000 строк — тоже).
  return loadBriefViews(
    db,
    productId,
    rows.map((r) => r.id),
    now,
  );
}

export interface PublicationListParams {
  before?: string;
  take: number;
  status?: string;
  stage?: string;
  communityId?: string;
  contentId?: string;
}

export function publicationListParams(
  raw: Record<string, unknown>,
  take: number,
): PublicationListParams {
  const out: PublicationListParams = { take };
  const issues: Array<{ field: string; code: string }> = [];
  for (const k of ['before', 'communityId', 'contentId'] as const) {
    const v = raw[k];
    if (v === undefined || v === '') continue;
    if (typeof v !== 'string' || !ID_RE.test(v))
      issues.push({ field: k, code: 'format' });
    else out[k] = v;
  }
  for (const [k, list] of [
    ['status', PUBLICATION_STATUSES],
    ['stage', PUBLICATION_STAGES],
  ] as const) {
    const v = raw[k];
    if (v === undefined || v === '') continue;
    if (typeof v !== 'string' || !(list as readonly string[]).includes(v))
      issues.push({ field: k, code: 'enum' });
    else out[k] = v;
  }
  if (issues.length) throw validationError(issues);
  return out;
}

/** Публикации каналов сообществ Reddit продукта (поверх `pub_publications`). */
export async function listPublications(
  db: PubTx,
  productId: string,
  p: PublicationListParams,
): Promise<RedditPublicationView[]> {
  const communities = await db.pubRedditCommunity.findMany({
    where: {
      productId,
      ...(p.communityId ? { id: p.communityId } : {}),
    },
    select: { channelId: true },
  });
  if (!communities.length) return [];
  const rows = await db.pubPublication.findMany({
    where: {
      productId,
      channelId: { in: communities.map((c) => c.channelId) },
      ...(p.before ? { id: { lt: p.before } } : {}),
      ...(p.status ? { status: p.status } : {}),
      ...(p.stage ? { stage: p.stage } : {}),
      ...(p.contentId ? { version: { contentId: p.contentId } } : {}),
    },
    orderBy: { id: 'desc' },
    take: p.take,
  });
  return redditPublicationViews(db, productId, rows);
}

export function briefCsvRow(b: RedditBriefView) {
  return {
    id: b.id,
    projectId: b.projectId,
    subreddit: b.subreddit,
    opportunityId: b.opportunityId,
    contentType: b.contentType,
    objective: b.objective,
    affiliation: b.affiliation,
    linksAllowed: b.linksAllowed,
    language: b.language,
    status: b.status,
    missing: b.missing.join(' '),
    contentIds: b.contentIds.join(' '),
    createdAt: b.createdAt,
  };
}

export function publicationCsvRow(p: RedditPublicationView) {
  return {
    id: p.id,
    contentId: p.contentId,
    versionId: p.versionId,
    subreddit: p.subreddit,
    finalUrl: p.finalUrl,
    stage: p.stage,
    status: p.status,
    reportKind: p.reportKind,
    verifyStatus: p.verifyStatus,
    publishedAt: p.publishedAt,
  };
}
