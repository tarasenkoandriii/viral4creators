/**
 * AI Publisher, P-B1 — представления сущностей контента для ответов
 * кабинета (`contracts/content-api.ts`) и их загрузка в транзакции/клиенте
 * кабинета. Только чтение.
 */
import type {
  PubApproval,
  PubBrandFact,
  PubQaCheck,
  PubQuestion,
  PubSource,
} from '@prisma/client';
import type {
  ApprovalView,
  BrandFactKind,
  BrandFactStatus,
  BrandFactView,
  BriefFormat,
  BriefView,
  ClaimRisk,
  ClaimStatus,
  ClaimSupports,
  ClaimType,
  ClaimView,
  ContentView,
  OfferVersionView,
  QaBlocker,
  QaCheckView,
  QuestionGroupView,
  QuestionScores,
  QuestionStage,
  QuestionView,
  SourceKind,
  SourceUsage,
  SourceView,
  SourceVisibility,
  VersionMeta,
  VersionView,
} from '../contracts/content-api';
import { FREQUENCY_UNKNOWN_LABEL } from '../contracts/content-api';
import type {
  ApprovalStatus,
  ContentKind,
  ContentStatus,
  ReviewReason,
} from '../contracts/states';
import { PubError } from '../core/errors';
import type { PubTx } from '../core/ports';
import { CONTENT_MACHINE, allowedFrom } from '../core/state-machines';
import { briefMissing } from './rules';

const iso = (d: Date | null | undefined): string | null =>
  d ? d.toISOString() : null;

/** Задачи, которые блокируют выпуск версии (§7.1). */
export const CHANGE_TASK_REASONS: ReviewReason[] = [
  'offer_changed',
  'fact_changed',
  'claim_changed',
  'source_revoked',
  // QA «fail»/«unknown» по уже согласованной версии (аудит P-B1 S0-1).
  'stale_check',
];

// ── Источник ─────────────────────────────────────────────────────────────

export async function sourceLocked(tx: PubTx, id: string): Promise<boolean> {
  const [frozen, supported] = await Promise.all([
    tx.pubVersionSource.count({
      where: { sourceId: id, version: { frozenAt: { not: null } } },
    }),
    tx.pubClaimSource.count({
      where: { sourceId: id, claim: { status: 'supported' } },
    }),
  ]);
  return frozen + supported > 0;
}

export function sourceView(r: PubSource, locked: boolean): SourceView {
  return {
    id: r.id,
    kind: r.kind as SourceKind,
    url: r.url,
    externalRef: r.externalRef,
    title: r.title,
    author: r.author,
    publishedOn: iso(r.publishedOn),
    fragment: r.fragment,
    language: r.language,
    usage: r.usage as SourceUsage,
    visibility: r.visibility as SourceVisibility,
    checkedAt: iso(r.checkedAt),
    freshness: r.freshness as SourceView['freshness'],
    importedVia: r.importedVia as SourceView['importedVia'],
    contentHash: r.contentHash,
    supersedesId: r.supersedesId,
    injectionFlag: r.injectionFlag,
    isSynthetic: r.isSynthetic,
    revokedAt: iso(r.revokedAt),
    revokedBy: r.revokedBy,
    revokeReason: r.revokeReason,
    locked,
    createdAt: r.createdAt.toISOString(),
    createdBy: r.createdBy,
    revision: r.revision,
  };
}

export async function loadSource(
  tx: PubTx,
  productId: string,
  id: string,
): Promise<SourceView> {
  const r = await tx.pubSource.findFirst({ where: { id, productId } });
  if (!r) throw new PubError('PUB_NOT_FOUND');
  return sourceView(r, await sourceLocked(tx, r.id));
}

// ── Вопрос и группа ──────────────────────────────────────────────────────

export async function loadQuestion(
  tx: PubTx,
  productId: string,
  id: string,
): Promise<QuestionView> {
  const r = await tx.pubQuestion.findFirst({
    where: { id, productId },
    include: { questionSourceQuestionOf: { orderBy: { createdAt: 'asc' } } },
  });
  if (!r) throw new PubError('PUB_NOT_FOUND');
  return questionView(r);
}

export function questionView(
  r: PubQuestion & {
    questionSourceQuestionOf: Array<{
      sourceId: string;
      fragment: string | null;
    }>;
  },
): QuestionView {
  return {
    id: r.id,
    text: r.text,
    audience: r.audience,
    stage: r.stage as QuestionStage,
    groupId: r.groupId,
    observedRepeats: r.observedRepeats,
    frequency: r.frequency,
    frequencySourceId: r.frequencySourceId,
    frequencyLabel:
      r.frequency === null ? FREQUENCY_UNKNOWN_LABEL : String(r.frequency),
    scores: (r.scores ?? {}) as QuestionScores,
    priorityNote: r.priorityNote,
    status: r.status as QuestionView['status'],
    selectedRank: r.selectedRank,
    sources: r.questionSourceQuestionOf.map((s) => ({
      sourceId: s.sourceId,
      fragment: s.fragment,
    })),
    revision: r.revision,
  };
}

export async function loadGroup(
  tx: PubTx,
  productId: string,
  id: string,
): Promise<QuestionGroupView> {
  const r = await tx.pubQuestionGroup.findFirst({
    where: { id, productId },
    include: {
      questionGroupOf: { select: { id: true }, orderBy: { id: 'asc' } },
    },
  });
  if (!r) throw new PubError('PUB_NOT_FOUND');
  return {
    id: r.id,
    key: r.key,
    task: r.task,
    stage: r.stage as QuestionStage,
    audience: r.audience,
    rationale: r.rationale,
    mergeRisk: r.mergeRisk,
    status: r.status as QuestionGroupView['status'],
    aiCallId: r.aiCallId,
    questionIds: r.questionGroupOf.map((q) => q.id),
    revision: r.revision,
  };
}

// ── Бренд ────────────────────────────────────────────────────────────────

export function factView(r: PubBrandFact): BrandFactView {
  return {
    id: r.id,
    factKey: r.factKey,
    kind: r.kind as BrandFactKind,
    value: r.value,
    scope: r.scope,
    sourceId: r.sourceId,
    version: r.version,
    status: r.status as BrandFactStatus,
    approvedBy: r.approvedBy,
    approvedAt: iso(r.approvedAt),
    conflictWithId: r.conflictWithId,
    revision: r.revision,
  };
}

export async function loadFact(
  tx: PubTx,
  productId: string,
  id: string,
): Promise<BrandFactView> {
  const r = await tx.pubBrandFact.findFirst({ where: { id, productId } });
  if (!r) throw new PubError('PUB_NOT_FOUND');
  return factView(r);
}

export async function loadOffer(
  tx: PubTx,
  productId: string,
  id: string,
): Promise<OfferVersionView> {
  const r = await tx.pubOfferVersion.findFirst({
    where: { id, productId },
    include: { offerFactOfferVersionOf: { select: { factId: true } } },
  });
  if (!r) throw new PubError('PUB_NOT_FOUND');
  return {
    id: r.id,
    version: r.version,
    title: r.title,
    text: r.text,
    priceNote: r.priceNote,
    status: r.status as OfferVersionView['status'],
    approvedBy: r.approvedBy,
    approvedAt: iso(r.approvedAt),
    hash: r.hash,
    factIds: r.offerFactOfferVersionOf.map((f) => f.factId).sort(),
    revision: r.revision,
  };
}

// ── Бриф ─────────────────────────────────────────────────────────────────

export async function loadBrief(
  tx: PubTx,
  productId: string,
  id: string,
): Promise<BriefView> {
  const r = await tx.pubBrief.findFirst({
    where: { id, productId },
    include: {
      briefSourceBriefOf: { include: { source: { select: { usage: true } } } },
      offerVersion: { select: { status: true } },
    },
  });
  if (!r) throw new PubError('PUB_NOT_FOUND');
  const arr = (v: unknown): string[] =>
    Array.isArray(v)
      ? (v as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
  const allowed = r.briefSourceBriefOf.filter(
    (s) => s.source.usage === 'allowed',
  ).length;
  return {
    id: r.id,
    questionId: r.questionId,
    offerVersionId: r.offerVersionId,
    goal: r.goal,
    format: r.format as BriefFormat,
    ownContribution: r.ownContribution,
    shortAnswer: r.shortAnswer,
    cta: r.cta,
    ctaIntentNote: r.ctaIntentNote,
    structure: arr(r.structure),
    channels: arr(r.channels),
    readinessCriteria: arr(r.readinessCriteria),
    effortMinutes: r.effortMinutes,
    unresolved: arr(r.unresolved),
    status: r.status as BriefView['status'],
    aiCallId: r.aiCallId,
    sourceIds: r.briefSourceBriefOf.map((s) => s.sourceId).sort(),
    missing: briefMissing({
      ownContribution: r.ownContribution,
      cta: r.cta,
      ctaIntentNote: r.ctaIntentNote,
      allowedSources: allowed,
      offerActive: r.offerVersion.status === 'active',
    }),
    revision: r.revision,
  };
}

// ── Материал и версия ────────────────────────────────────────────────────

export async function openTasksOf(
  tx: PubTx,
  productId: string,
  contentId: string,
): Promise<ContentView['openTasks']> {
  const versions = await tx.pubContentVersion.findMany({
    where: { contentId, productId },
    select: { id: true },
  });
  const rows = await tx.pubReviewTask.findMany({
    where: {
      productId,
      status: 'open',
      OR: [
        { objectType: 'content', objectId: contentId },
        {
          objectType: 'content_version',
          objectId: { in: versions.map((v) => v.id) },
        },
      ],
    },
    select: { id: true, reason: true, objectType: true },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((t) => ({
    id: t.id,
    reason: t.reason as ReviewReason,
    objectType: t.objectType,
  }));
}

export async function loadContent(
  tx: PubTx,
  productId: string,
  id: string,
): Promise<ContentView> {
  const r = await tx.pubContent.findFirst({ where: { id, productId } });
  if (!r) throw new PubError('PUB_NOT_FOUND');
  return {
    id: r.id,
    kind: r.kind as ContentKind,
    parentContentId: r.parentContentId,
    briefId: r.briefId,
    slug: r.slug,
    status: r.status as ContentStatus,
    currentVersionId: r.currentVersionId,
    approvedVersionId: r.approvedVersionId,
    publishedVersionId: r.publishedVersionId,
    ownerMemberId: r.ownerMemberId,
    ownerDisplayName: r.ownerDisplayName,
    nextDueAt: iso(r.nextDueAt),
    blockReason: r.blockReason,
    criticalStale: r.criticalStale,
    firstPublishedAt: iso(r.firstPublishedAt),
    redditBriefId: r.redditBriefId,
    // P-R M2, раунд 4 (аудит экранов S3-10): Reddit-материал ведётся в
    // студии — общий экран прячет общие действия публикации/согласования.
    ...(r.redditBriefId ? { redditStudio: true as const } : {}),
    openTasks: await openTasksOf(tx, productId, r.id),
    allowedTransitions: allowedFrom(CONTENT_MACHINE, r.status as ContentStatus),
    revision: r.revision,
  };
}

export async function loadVersion(
  tx: PubTx,
  productId: string,
  id: string,
  contentId?: string,
): Promise<VersionView> {
  const r = await tx.pubContentVersion.findFirst({
    where: { id, productId, ...(contentId ? { contentId } : {}) },
    include: {
      versionSourceVersionOf: { select: { sourceId: true } },
      versionClaimVersionOf: { select: { claimId: true } },
      versionFactVersionOf: { select: { factId: true } },
    },
  });
  if (!r) throw new PubError('PUB_NOT_FOUND');
  return {
    id: r.id,
    contentId: r.contentId,
    number: r.number,
    title: r.title,
    body: r.body,
    meta: (r.meta ?? {}) as VersionMeta,
    format: r.format as ContentKind,
    isScript: r.format === 'video_script',
    parentVersionId: r.parentVersionId,
    offerVersionId: r.offerVersionId,
    authorMemberId: r.authorMemberId,
    aiCallId: r.aiCallId,
    status: r.status as VersionView['status'],
    hash: r.hash,
    frozenAt: iso(r.frozenAt),
    sourceIds: r.versionSourceVersionOf.map((x) => x.sourceId).sort(),
    claimIds: r.versionClaimVersionOf.map((x) => x.claimId).sort(),
    factIds: r.versionFactVersionOf.map((x) => x.factId).sort(),
    revision: r.revision,
  };
}

// ── Claim, QA, согласование ──────────────────────────────────────────────

export async function loadClaim(
  tx: PubTx,
  productId: string,
  id: string,
): Promise<ClaimView> {
  const r = await tx.pubClaim.findFirst({
    where: { id, productId },
    include: {
      claimSourceClaimOf: { orderBy: { createdAt: 'asc' } },
      versionClaimClaimOf: { select: { versionId: true } },
    },
  });
  if (!r) throw new PubError('PUB_NOT_FOUND');
  return {
    id: r.id,
    statement: r.statement,
    type: r.type as ClaimType,
    risk: r.risk as ClaimRisk,
    status: r.status as ClaimStatus,
    extractedFromVersionId: r.extractedFromVersionId,
    experimentId: r.experimentId,
    supersedesId: r.supersedesId,
    verifiedBy: r.verifiedBy,
    verifiedAt: iso(r.verifiedAt),
    nextCheckAt: iso(r.nextCheckAt),
    aiCallId: r.aiCallId,
    sources: r.claimSourceClaimOf.map((s) => ({
      sourceId: s.sourceId,
      supports: s.supports as ClaimSupports,
      checkedBy: s.checkedBy,
      checkedAt: iso(s.checkedAt),
      note: s.note,
    })),
    versionIds: r.versionClaimClaimOf.map((v) => v.versionId).sort(),
    revision: r.revision,
  };
}

export function qaView(r: PubQaCheck): QaCheckView {
  return {
    id: r.id,
    versionId: r.versionId,
    kind: r.kind as QaCheckView['kind'],
    result: r.result as QaCheckView['result'],
    blockers: (Array.isArray(r.blockers)
      ? r.blockers
      : []) as unknown as QaBlocker[],
    warnings: (Array.isArray(r.warnings)
      ? r.warnings
      : []) as unknown as QaCheckView['warnings'],
    checkedBy: r.checkedBy,
    checkedAt: r.checkedAt.toISOString(),
    selfReview: r.selfReview,
    aiCallId: r.aiCallId,
  };
}

export function approvalView(r: PubApproval): ApprovalView {
  return {
    id: r.id,
    type: 'publish_version',
    objectType: 'content_version',
    objectId: r.objectId,
    versionHash: r.versionHash ?? '',
    approverMemberId: r.approverMemberId,
    approverDisplayName: r.approverDisplayName,
    decidedAt: r.decidedAt.toISOString(),
    status: r.status as ApprovalStatus,
    selfReview: r.selfReview,
    reason: r.reason,
  };
}
