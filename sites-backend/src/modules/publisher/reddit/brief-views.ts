/**
 * AI Publisher, P-R M2 — ответы брифа и материалов раздела Reddit
 * (`contracts/reddit-api.ts`): `RedditBriefView`, `RedditMaterialView`,
 * `RedditPublicationView`. Только чтение, всегда с `productId` (чужой —
 * 404).
 */
import type { Prisma } from '@prisma/client';
import {
  publisherRedditAiEnabled,
  publisherStandFakeAi,
} from '../../../config/publisher-env';
import type { QaCheckView } from '../contracts/content-api';
import type {
  RedditBriefView,
  RedditMaterialView,
  RedditPublicationView,
} from '../contracts/reddit-api';
import type {
  AiCallStatus,
  RedditAffiliation,
  RedditBriefStatus,
  RedditContentType,
} from '../contracts/states';
import { REDDIT_DRAFT } from '../ai/generators/reddit-draft.generator';
import { loadContent, loadVersion, qaView } from '../content/views';
import { publicationView } from '../distribution/publications.service';
import { PubError } from '../core/errors';
import type { PubTx } from '../core/ports';
import { briefState } from './reddit-port';
import { policyGate } from './policy';
import {
  currentRules,
  policySnapshotOf,
  rulesSummary,
  staleDaysFor,
} from './views';

type BriefRow = Prisma.PubRedditBriefGetPayload<object>;

const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** Доступна ли генерация и почему нет (ручной редактор — всегда). */
export function aiAvailability(): RedditBriefView['ai'] {
  if (!publisherRedditAiEnabled())
    return { available: false, reason: 'flag_off' };
  if (!REDDIT_DRAFT.enabledInP0 && !publisherStandFakeAi().enabled)
    return { available: false, reason: 'generator_disabled' };
  return { available: true, reason: null };
}

export async function loadBriefView(
  db: PubTx,
  productId: string,
  id: string,
  now: Date = new Date(),
): Promise<RedditBriefView> {
  const st = await briefState(db, productId, id);
  const b: BriefRow = st.brief;
  const rules = (await currentRules(db, productId, [b.communityId])).get(
    b.communityId,
  );
  const staleDays = await staleDaysFor(db, productId);
  const contents = await db.pubContent.findMany({
    where: { productId, redditBriefId: id },
    orderBy: { id: 'asc' },
    select: { id: true },
  });
  // Раунд 4 (аудит экранов S3-6, AT-RD-14): пометка выдержки возможности
  // («похоже на команду») видна и в брифе; в промпт она идёт атрибутом
  // `flag="possible_instruction"` тега `<thread>`.
  const excerpt = st.opportunity?.excerptSourceId
    ? await db.pubSource.findFirst({
        where: { id: st.opportunity.excerptSourceId, productId },
        select: { usage: true, injectionFlag: true },
      })
    : null;
  return {
    id: b.id,
    projectId: b.projectId,
    communityId: b.communityId,
    subreddit: st.community.name,
    canonicalUrl: st.community.canonicalUrl,
    opportunityId: b.opportunityId,
    threadUrl: st.opportunity?.threadUrl ?? null,
    offerVersionId: b.offerVersionId,
    contentType: b.contentType as RedditContentType,
    objective: b.objective,
    audience: b.audience,
    context: b.context,
    injectionFlag:
      excerpt && excerpt.usage !== 'revoked' ? excerpt.injectionFlag : null,
    keyPoints: st.keyPoints,
    affiliation: b.affiliation as RedditAffiliation | null,
    brand: b.brand,
    linksAllowed: b.linksAllowed,
    tone: b.tone,
    language: b.language,
    constraints: strArray(b.constraints),
    forbiddenClaims: strArray(b.forbiddenClaims),
    cta: b.cta,
    status: b.status as RedditBriefStatus,
    missing: st.missing,
    gate: policyGate(
      rules ? policySnapshotOf(rules.snap, rules.sourceRevoked) : null,
      now,
      staleDays,
      b.contentType as RedditContentType,
      false,
    ),
    ai: aiAvailability(),
    contentIds: contents.map((c) => c.id),
    revision: b.revision,
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
  };
}

/** Публикации Reddit (канал сообщества) → вид раздела. */
export async function redditPublicationViews(
  db: PubTx,
  productId: string,
  rows: Array<Prisma.PubPublicationGetPayload<object>>,
): Promise<RedditPublicationView[]> {
  if (!rows.length) return [];
  const [versions, communities] = await Promise.all([
    db.pubContentVersion.findMany({
      where: { productId, id: { in: rows.map((r) => r.versionId) } },
      select: { id: true, contentId: true },
    }),
    db.pubRedditCommunity.findMany({
      where: { productId, channelId: { in: rows.map((r) => r.channelId) } },
      select: { id: true, name: true, channelId: true },
    }),
  ]);
  const contentOf = new Map(versions.map((v) => [v.id, v.contentId]));
  const communityOf = new Map(communities.map((c) => [c.channelId, c]));
  return rows.map((r) => ({
    ...publicationView(r),
    contentId: contentOf.get(r.versionId) ?? '',
    communityId: communityOf.get(r.channelId)?.id ?? '',
    subreddit: communityOf.get(r.channelId)?.name ?? '',
  }));
}

/** Материал раздела со всем, что нужно студии (одним чтением). */
export async function loadMaterialView(
  db: PubTx,
  productId: string,
  contentId: string,
  now: Date = new Date(),
): Promise<RedditMaterialView> {
  const c = await db.pubContent.findFirst({
    where: { id: contentId, productId },
    select: {
      id: true,
      kind: true,
      redditBriefId: true,
      currentVersionId: true,
      approvedVersionId: true,
    },
  });
  if (!c || !c.redditBriefId) throw new PubError('PUB_NOT_FOUND');
  const st = await briefState(db, productId, c.redditBriefId);
  const rules = (await currentRules(db, productId, [st.community.id])).get(
    st.community.id,
  );
  const staleDays = await staleDaysFor(db, productId);
  const currentVersion = c.currentVersionId
    ? await loadVersion(db, productId, c.currentVersionId, c.id)
    : null;
  const approvedVersion = c.approvedVersionId
    ? await loadVersion(db, productId, c.approvedVersionId, c.id)
    : null;
  const forCheck = [currentVersion, approvedVersion].find(
    (v) => v && v.frozenAt,
  );
  const check = forCheck
    ? await db.pubQaCheck.findFirst({
        where: { productId, versionId: forCheck.id, kind: 'reddit_policy' },
        orderBy: [{ checkedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      })
    : null;
  const copies = await db.pubAuditEvent.findMany({
    where: { productId, objectType: 'content', objectId: c.id, action: 'copy' },
    orderBy: { occurredAt: 'desc' },
    select: { occurredAt: true },
  });
  const versions = await db.pubContentVersion.findMany({
    where: { productId, contentId: c.id },
    select: { id: true },
  });
  const pubs = await db.pubPublication.findMany({
    where: { productId, versionId: { in: versions.map((v) => v.id) } },
    orderBy: { id: 'desc' },
  });
  const contentType: RedditContentType =
    c.kind === 'reddit_post' ? 'post' : 'comment';
  const threadUrl = st.opportunity?.threadUrl ?? null;
  // Активное согласование утверждённой версии — id для отзыва (экраны).
  const approval = approvedVersion
    ? await db.pubApproval.findFirst({
        where: {
          productId,
          type: 'publish_version',
          objectType: 'content_version',
          objectId: approvedVersion.id,
          status: 'active',
        },
        orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }],
        select: {
          id: true,
          objectId: true,
          status: true,
          selfReview: true,
          decidedAt: true,
        },
      })
    : null;
  return {
    content: await loadContent(db, productId, c.id),
    briefId: c.redditBriefId,
    contentType,
    communityId: st.community.id,
    subreddit: st.community.name,
    canonicalUrl: st.community.canonicalUrl,
    threadUrl,
    openUrl:
      contentType === 'comment' && threadUrl
        ? threadUrl
        : st.community.canonicalUrl,
    rules: rules
      ? rulesSummary(rules.snap, now, staleDays, rules.sourceRevoked)
      : null,
    currentVersion,
    approvedVersion,
    approval: approval
      ? {
          id: approval.id,
          versionId: approval.objectId,
          status: approval.status as 'active',
          selfReview: approval.selfReview,
          decidedAt: approval.decidedAt.toISOString(),
        }
      : null,
    policyCheck: check ? (qaView(check) as QaCheckView) : null,
    copies: {
      count: copies.length,
      lastAt: copies[0]?.occurredAt.toISOString() ?? null,
    },
    publications: await redditPublicationViews(db, productId, pubs),
    lastGeneration: await lastGenerationOf(db, productId, c.redditBriefId),
  };
}

/** id версий Reddit-материалов брифа (задачи «переписать абзац», Р-RD-83). */
export async function briefVersionIds(
  db: PubTx,
  productId: string,
  briefIds: readonly string[],
): Promise<string[]> {
  if (!briefIds.length) return [];
  const rows = await db.pubContentVersion.findMany({
    where: { productId, content: { redditBriefId: { in: [...briefIds] } } },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/**
 * Последний вызов генерации брифа (замечание экранов M2, Р-RD-72): экран
 * восстанавливает варианты после перезагрузки (`GET …/ai/calls/:id`).
 * Учитываются задача брифа и задачи «переписать абзац» его черновиков.
 */
export async function lastGenerationOf(
  db: PubTx,
  productId: string,
  briefId: string,
): Promise<RedditMaterialView['lastGeneration']> {
  const versionIds = await briefVersionIds(db, productId, [briefId]);
  const call = await db.pubAiCall.findFirst({
    where: {
      productId,
      generator: 'pub.reddit.draft',
      task: {
        OR: [
          { objectType: 'reddit_brief', objectId: briefId },
          ...(versionIds.length
            ? [{ objectType: 'content_version', objectId: { in: versionIds } }]
            : []),
        ],
      },
    },
    orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
    select: { id: true, status: true, requestedAt: true },
  });
  return call
    ? {
        callId: call.id,
        status: call.status as AiCallStatus,
        requestedAt: call.requestedAt.toISOString(),
      }
    : null;
}
