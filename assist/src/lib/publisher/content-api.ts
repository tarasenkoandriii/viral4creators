/**
 * AI Publisher (P-G1) — API контента P-B1 (F01–F04, F06 ручной путь;
 * контракт `contracts/content-api.ts`, `CONTENT_ROUTES`). Декодеры строгие;
 * мутации — `opKey` в теле, головы — `expectedRevision`.
 */

import type { PublisherHttp, Query } from './common-pure';
import { seg } from './common-pure';
import {
  arr,
  bool,
  int,
  intOrNull,
  iso,
  isoOrNull,
  itemsOf,
  listPage,
  num,
  numOrNull,
  obj,
  oneOf,
  PubDecodeError,
  str,
  strOrNull,
  type ListPage,
  type Rec,
} from './decode';
import {
  APPROVAL_STATUSES,
  BRAND_FACT_KINDS,
  BRAND_FACT_STATUSES,
  BRIEF_FORMATS,
  BRIEF_MISSING,
  BRIEF_STATUSES,
  CLAIM_RISKS,
  CLAIM_STATUSES,
  CLAIM_SUPPORTS,
  CLAIM_TYPES,
  CONTENT_KINDS,
  CONTENT_STATUSES,
  OFFER_STATUSES,
  QA_CHECK_KINDS,
  QA_RESULTS,
  QUESTION_GROUP_STATUSES,
  QUESTION_SCORE_KEYS,
  QUESTION_STAGES,
  QUESTION_STATUSES,
  REVIEW_REASONS,
  SOURCE_FRESHNESS,
  SOURCE_IMPORTED_VIA,
  SOURCE_KINDS,
  SOURCE_USAGES,
  SOURCE_VISIBILITIES,
  VERSION_STATUSES,
  type ApprovalStatus,
  type BrandFactKind,
  type BrandFactStatus,
  type BriefFormat,
  type ClaimRisk,
  type ClaimStatus,
  type ClaimSupports,
  type ClaimType,
  type ContentKind,
  type ContentStatus,
  type QaCheckKind,
  type QaResult,
  type QuestionStage,
  type QuestionStatus,
  type ReviewReason,
  type ScoreKey,
  type SourceKind,
  type SourceUsage,
  type SourceVisibility,
  type VersionStatus,
} from './states';

// ── Типы ответа (contracts/content-api.ts) ──────────────────────────────

export interface SourceView {
  id: string;
  kind: SourceKind;
  url: string | null;
  externalRef: string | null;
  title: string | null;
  author: string | null;
  publishedOn: string | null;
  fragment: string;
  language: string | null;
  usage: SourceUsage;
  visibility: SourceVisibility;
  checkedAt: string | null;
  freshness: (typeof SOURCE_FRESHNESS)[number];
  importedVia: (typeof SOURCE_IMPORTED_VIA)[number];
  contentHash: string;
  supersedesId: string | null;
  injectionFlag: string | null;
  isSynthetic: boolean;
  revokedAt: string | null;
  revokedBy: string | null;
  revokeReason: string | null;
  locked: boolean;
  createdAt: string;
  createdBy: string;
  revision: number;
}

export interface ScoreEntry {
  score: 0 | 1 | 2 | null;
  why: string | null;
}
export type QuestionScores = Partial<Record<ScoreKey, ScoreEntry>>;

export interface QuestionView {
  id: string;
  text: string;
  audience: string | null;
  stage: QuestionStage;
  groupId: string | null;
  observedRepeats: number | null;
  frequency: number | null;
  frequencySourceId: string | null;
  frequencyLabel: string;
  scores: QuestionScores;
  priorityNote: string | null;
  status: QuestionStatus;
  selectedRank: number | null;
  sources: Array<{ sourceId: string; fragment: string | null }>;
  revision: number;
}

export interface QuestionGroupView {
  id: string;
  key: string;
  task: string;
  stage: QuestionStage;
  audience: string | null;
  rationale: string;
  mergeRisk: string | null;
  status: (typeof QUESTION_GROUP_STATUSES)[number];
  aiCallId: string | null;
  questionIds: string[];
  revision: number;
}

export interface BrandFactView {
  id: string;
  factKey: string;
  kind: BrandFactKind;
  value: unknown;
  scope: string | null;
  sourceId: string | null;
  version: number;
  status: BrandFactStatus;
  approvedBy: string | null;
  approvedAt: string | null;
  conflictWithId: string | null;
  revision: number;
}

export interface CascadeSummary {
  tasksOpened: number;
  correctionRequired: string[];
  approvalsSuperseded: string[];
}

export interface OfferVersionView {
  id: string;
  version: number;
  title: string;
  text: string;
  priceNote: string | null;
  status: (typeof OFFER_STATUSES)[number];
  approvedBy: string | null;
  approvedAt: string | null;
  hash: string;
  factIds: string[];
  revision: number;
}

export interface ContextPreview {
  purpose: string;
  audience: 'internal' | 'public';
  sources: Array<{
    id: string;
    title: string | null;
    visibility: SourceVisibility;
    injectionFlag: string | null;
  }>;
  facts: Array<{
    id: string;
    factKey: string;
    kind: BrandFactKind;
    version: number;
    value: unknown;
  }>;
  offer: {
    id: string;
    version: number;
    title: string;
    priceNote: string | null;
  } | null;
  forbiddenPromises: Array<{ id: string; factKey: string; value: unknown }>;
  excluded: {
    restricted: number;
    revoked: number;
    privateForPublic: number;
    notRequested: number;
  };
}

export type BriefMissing = (typeof BRIEF_MISSING)[number];
export interface BriefView {
  id: string;
  questionId: string;
  offerVersionId: string;
  goal: string;
  format: BriefFormat;
  ownContribution: string | null;
  shortAnswer: string | null;
  cta: string | null;
  ctaIntentNote: string | null;
  structure: string[];
  channels: string[];
  readinessCriteria: string[];
  effortMinutes: number | null;
  unresolved: string[];
  status: (typeof BRIEF_STATUSES)[number];
  aiCallId: string | null;
  sourceIds: string[];
  missing: BriefMissing[];
  revision: number;
}

export interface ContentView {
  id: string;
  kind: ContentKind;
  parentContentId: string | null;
  briefId: string | null;
  slug: string | null;
  status: ContentStatus;
  currentVersionId: string | null;
  approvedVersionId: string | null;
  publishedVersionId: string | null;
  ownerMemberId: string | null;
  ownerDisplayName: string | null;
  nextDueAt: string | null;
  blockReason: string | null;
  criticalStale: boolean;
  firstPublishedAt: string | null;
  /** P-R M2: Reddit-бриф материала `reddit_post|reddit_comment`. */
  redditBriefId: string | null;
  /** P-R M2 §12.5: Reddit-материал — действия только в студии. */
  redditStudio?: true;
  openTasks: Array<{ id: string; reason: ReviewReason; objectType: string }>;
  allowedTransitions: ContentStatus[];
  revision: number;
}

export interface VersionMeta {
  description?: string;
  shortAnswer?: string;
  example?: string;
  limitations?: string[];
  editor?: string;
  cta?: string;
  cards?: Array<{ title: string; text: string }>;
  scenes?: Array<{ visual: string; voice: string; caption: string }>;
  substantiallyUpdatedAt?: string;
  // ── P-R M2: Reddit-версия (`RedditVersionMeta`; входит в hash) ──
  disclosure?: string;
  flairSuggestion?: string | null;
  claimMap?: Array<{
    text: string;
    sourceIds: string[] | 'needs_verification';
  }>;
  uncertainties?: string[];
  /** Ставит сервер. */
  ruleSnapshotId?: string | null;
  affiliation?: string;
  threadUrl?: string | null;
}

export interface VersionView {
  id: string;
  contentId: string;
  number: number;
  title: string;
  body: string;
  meta: VersionMeta;
  format: ContentKind;
  isScript: boolean;
  parentVersionId: string | null;
  offerVersionId: string;
  authorMemberId: string;
  aiCallId: string | null;
  status: VersionStatus;
  hash: string | null;
  frozenAt: string | null;
  sourceIds: string[];
  claimIds: string[];
  factIds: string[];
  revision: number;
}

export interface DiffLine {
  op: 'eq' | 'add' | 'del';
  text: string;
}
export interface VersionDiff {
  a: string;
  b: string;
  title: { from: string; to: string } | null;
  body: DiffLine[];
  bodyCoarse: boolean;
  metaChanged: string[];
  offerChanged: boolean;
  sources: { added: string[]; removed: string[] };
  claims: { added: string[]; removed: string[] };
  facts: { added: string[]; removed: string[] };
}

export interface ClaimView {
  id: string;
  statement: string;
  type: ClaimType;
  risk: ClaimRisk;
  status: ClaimStatus;
  extractedFromVersionId: string | null;
  experimentId: string | null;
  supersedesId: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
  nextCheckAt: string | null;
  aiCallId: string | null;
  sources: Array<{
    sourceId: string;
    supports: ClaimSupports;
    checkedBy: string | null;
    checkedAt: string | null;
    note: string | null;
  }>;
  versionIds: string[];
  revision: number;
}

/**
 * Параметры находки `reddit_policy` (P-R M2 §12.1): `found` — найденные
 * фрагменты, `reason`/`brand` — причина раскрытия, `claims` — номера пунктов
 * `meta.claimMap` (с 0). Текст находки клиент строит по коду и параметрам.
 */
export type QaFindingParams = Record<
  string,
  string | number | string[] | number[]
>;
export interface QaBlocker {
  code: string;
  claimId?: string | null;
  text: string;
  params?: QaFindingParams;
}
export interface QaCheckView {
  id: string;
  versionId: string;
  kind: QaCheckKind;
  result: QaResult;
  blockers: QaBlocker[];
  /** P-R M2: WARN `reddit_policy` (у прочих видов — пусто). */
  warnings: Array<{ code: string; text: string; params?: QaFindingParams }>;
  checkedBy: string;
  checkedAt: string;
  selfReview: boolean;
  aiCallId: string | null;
}

export interface ApprovalView {
  id: string;
  type: 'publish_version';
  objectType: 'content_version';
  objectId: string;
  versionHash: string;
  approverMemberId: string;
  approverDisplayName: string;
  decidedAt: string;
  status: ApprovalStatus;
  selfReview: boolean;
  reason: string | null;
}

// ── Декодеры ─────────────────────────────────────────────────────────────

const strs = (v: unknown, w = 'strings') => arr(v, (x) => str(x, w), w);

export function decodeSource(v: unknown): SourceView {
  const o = obj(v, 'source');
  return {
    id: str(o.id),
    kind: oneOf(o.kind, SOURCE_KINDS, 'source.kind'),
    url: strOrNull(o.url),
    externalRef: strOrNull(o.externalRef),
    title: strOrNull(o.title),
    author: strOrNull(o.author),
    publishedOn: strOrNull(o.publishedOn),
    fragment: str(o.fragment, 'source.fragment'),
    language: strOrNull(o.language),
    usage: oneOf(o.usage, SOURCE_USAGES, 'source.usage'),
    visibility: oneOf(o.visibility, SOURCE_VISIBILITIES, 'source.visibility'),
    checkedAt: isoOrNull(o.checkedAt),
    freshness: oneOf(o.freshness, SOURCE_FRESHNESS, 'source.freshness'),
    importedVia: oneOf(o.importedVia, SOURCE_IMPORTED_VIA, 'source.via'),
    contentHash: str(o.contentHash),
    supersedesId: strOrNull(o.supersedesId),
    injectionFlag: strOrNull(o.injectionFlag),
    isSynthetic: bool(o.isSynthetic),
    revokedAt: isoOrNull(o.revokedAt),
    revokedBy: strOrNull(o.revokedBy),
    revokeReason: strOrNull(o.revokeReason),
    locked: bool(o.locked),
    createdAt: iso(o.createdAt),
    createdBy: str(o.createdBy),
    revision: int(o.revision),
  };
}

function scoreOf(v: unknown): 0 | 1 | 2 {
  if (v === 0 || v === 1 || v === 2) return v;
  throw new PubDecodeError('score');
}

function decodeScores(v: unknown): QuestionScores {
  const o = obj(v, 'scores');
  const out: QuestionScores = {};
  for (const k of QUESTION_SCORE_KEYS) {
    if (o[k] === undefined) continue;
    const e = obj(o[k], `scores.${k}`);
    const sc = e.score;
    out[k] = {
      score: sc === null || sc === undefined ? null : scoreOf(sc),
      why: strOrNull(e.why),
    };
  }
  return out;
}

export function decodeQuestion(v: unknown): QuestionView {
  const o = obj(v, 'question');
  return {
    id: str(o.id),
    text: str(o.text),
    audience: strOrNull(o.audience),
    stage: oneOf(o.stage, QUESTION_STAGES, 'question.stage'),
    groupId: strOrNull(o.groupId),
    observedRepeats: intOrNull(o.observedRepeats),
    frequency: numOrNull(o.frequency),
    frequencySourceId: strOrNull(o.frequencySourceId),
    frequencyLabel: str(o.frequencyLabel),
    scores: decodeScores(o.scores ?? {}),
    priorityNote: strOrNull(o.priorityNote),
    status: oneOf(o.status, QUESTION_STATUSES, 'question.status'),
    selectedRank: intOrNull(o.selectedRank),
    sources: arr(o.sources, (x) => {
      const s = obj(x, 'question.source');
      return { sourceId: str(s.sourceId), fragment: strOrNull(s.fragment) };
    }),
    revision: int(o.revision),
  };
}

export function decodeGroup(v: unknown): QuestionGroupView {
  const o = obj(v, 'group');
  return {
    id: str(o.id),
    key: str(o.key),
    task: str(o.task),
    stage: oneOf(o.stage, QUESTION_STAGES, 'group.stage'),
    audience: strOrNull(o.audience),
    rationale: str(o.rationale),
    mergeRisk: strOrNull(o.mergeRisk),
    status: oneOf(o.status, QUESTION_GROUP_STATUSES, 'group.status'),
    aiCallId: strOrNull(o.aiCallId),
    questionIds: strs(o.questionIds),
    revision: int(o.revision),
  };
}

export function decodeFact(v: unknown): BrandFactView {
  const o = obj(v, 'fact');
  return {
    id: str(o.id),
    factKey: str(o.factKey),
    kind: oneOf(o.kind, BRAND_FACT_KINDS, 'fact.kind'),
    value: o.value ?? null,
    scope: strOrNull(o.scope),
    sourceId: strOrNull(o.sourceId),
    version: int(o.version),
    status: oneOf(o.status, BRAND_FACT_STATUSES, 'fact.status'),
    approvedBy: strOrNull(o.approvedBy),
    approvedAt: isoOrNull(o.approvedAt),
    conflictWithId: strOrNull(o.conflictWithId),
    revision: int(o.revision),
  };
}

export function decodeCascade(v: unknown): CascadeSummary {
  const o = obj(v, 'cascade');
  return {
    tasksOpened: int(o.tasksOpened),
    correctionRequired: strs(o.correctionRequired),
    approvalsSuperseded: strs(o.approvalsSuperseded),
  };
}

export function decodeOffer(v: unknown): OfferVersionView {
  const o = obj(v, 'offer');
  return {
    id: str(o.id),
    version: int(o.version),
    title: str(o.title),
    text: str(o.text),
    priceNote: strOrNull(o.priceNote),
    status: oneOf(o.status, OFFER_STATUSES, 'offer.status'),
    approvedBy: strOrNull(o.approvedBy),
    approvedAt: isoOrNull(o.approvedAt),
    hash: str(o.hash),
    factIds: strs(o.factIds),
    revision: int(o.revision),
  };
}

export function decodeContextPreview(v: unknown): ContextPreview {
  const o = obj(v, 'contextPreview');
  const ex = obj(o.excluded, 'contextPreview.excluded');
  const offer = o.offer === null || o.offer === undefined ? null : obj(o.offer);
  return {
    purpose: str(o.purpose),
    audience: oneOf(o.audience, ['internal', 'public'] as const),
    sources: arr(o.sources, (x) => {
      const s = obj(x);
      return {
        id: str(s.id),
        title: strOrNull(s.title),
        visibility: oneOf(s.visibility, SOURCE_VISIBILITIES),
        injectionFlag: strOrNull(s.injectionFlag),
      };
    }),
    facts: arr(o.facts, (x) => {
      const f = obj(x);
      return {
        id: str(f.id),
        factKey: str(f.factKey),
        kind: oneOf(f.kind, BRAND_FACT_KINDS),
        version: int(f.version),
        value: f.value ?? null,
      };
    }),
    offer: offer
      ? {
          id: str(offer.id),
          version: int(offer.version),
          title: str(offer.title),
          priceNote: strOrNull(offer.priceNote),
        }
      : null,
    forbiddenPromises: arr(o.forbiddenPromises, (x) => {
      const f = obj(x);
      return { id: str(f.id), factKey: str(f.factKey), value: f.value ?? null };
    }),
    excluded: {
      restricted: int(ex.restricted),
      revoked: int(ex.revoked),
      privateForPublic: int(ex.privateForPublic),
      notRequested: int(ex.notRequested),
    },
  };
}

export function decodeBrief(v: unknown): BriefView {
  const o = obj(v, 'brief');
  return {
    id: str(o.id),
    questionId: str(o.questionId),
    offerVersionId: str(o.offerVersionId),
    goal: str(o.goal),
    format: oneOf(o.format, BRIEF_FORMATS, 'brief.format'),
    ownContribution: strOrNull(o.ownContribution),
    shortAnswer: strOrNull(o.shortAnswer),
    cta: strOrNull(o.cta),
    ctaIntentNote: strOrNull(o.ctaIntentNote),
    structure: strs(o.structure),
    channels: strs(o.channels),
    readinessCriteria: strs(o.readinessCriteria),
    effortMinutes: intOrNull(o.effortMinutes),
    unresolved: strs(o.unresolved),
    status: oneOf(o.status, BRIEF_STATUSES, 'brief.status'),
    aiCallId: strOrNull(o.aiCallId),
    sourceIds: strs(o.sourceIds),
    missing: arr(o.missing, (x) => oneOf(x, BRIEF_MISSING, 'brief.missing')),
    revision: int(o.revision),
  };
}

export function decodeContent(v: unknown): ContentView {
  const o = obj(v, 'content');
  return {
    id: str(o.id),
    kind: oneOf(o.kind, CONTENT_KINDS, 'content.kind'),
    parentContentId: strOrNull(o.parentContentId),
    briefId: strOrNull(o.briefId),
    slug: strOrNull(o.slug),
    status: oneOf(o.status, CONTENT_STATUSES, 'content.status'),
    currentVersionId: strOrNull(o.currentVersionId),
    approvedVersionId: strOrNull(o.approvedVersionId),
    publishedVersionId: strOrNull(o.publishedVersionId),
    ownerMemberId: strOrNull(o.ownerMemberId),
    ownerDisplayName: strOrNull(o.ownerDisplayName),
    nextDueAt: isoOrNull(o.nextDueAt),
    blockReason: strOrNull(o.blockReason),
    criticalStale: bool(o.criticalStale),
    firstPublishedAt: isoOrNull(o.firstPublishedAt),
    redditBriefId: strOrNull(o.redditBriefId),
    ...(o.redditStudio === undefined
      ? {}
      : o.redditStudio === true
        ? { redditStudio: true as const }
        : (() => {
            throw new PubDecodeError('content.redditStudio');
          })()),
    openTasks: arr(o.openTasks, (x) => {
      const t = obj(x, 'content.openTasks');
      return {
        id: str(t.id),
        reason: oneOf(t.reason, REVIEW_REASONS, 'openTasks.reason'),
        objectType: str(t.objectType),
      };
    }),
    allowedTransitions: arr(o.allowedTransitions, (x) =>
      oneOf(x, CONTENT_STATUSES, 'content.allowed')
    ),
    revision: int(o.revision),
  };
}

function decodeMeta(v: unknown): VersionMeta {
  if (v === null || v === undefined) return {};
  const o = obj(v, 'meta');
  const out: VersionMeta = {};
  if (o.description !== undefined) out.description = str(o.description);
  if (o.shortAnswer !== undefined) out.shortAnswer = str(o.shortAnswer);
  if (o.example !== undefined) out.example = str(o.example);
  if (o.limitations !== undefined) out.limitations = strs(o.limitations);
  if (o.editor !== undefined) out.editor = str(o.editor);
  if (o.cta !== undefined) out.cta = str(o.cta);
  if (o.cards !== undefined) {
    out.cards = arr(o.cards, (x) => {
      const c = obj(x);
      return { title: str(c.title), text: str(c.text) };
    });
  }
  if (o.scenes !== undefined) {
    out.scenes = arr(o.scenes, (x) => {
      const c = obj(x);
      return {
        visual: str(c.visual),
        voice: str(c.voice),
        caption: str(c.caption),
      };
    });
  }
  if (o.substantiallyUpdatedAt !== undefined) {
    out.substantiallyUpdatedAt = str(o.substantiallyUpdatedAt);
  }
  if (o.disclosure !== undefined) out.disclosure = str(o.disclosure);
  if (o.flairSuggestion !== undefined)
    out.flairSuggestion = strOrNull(o.flairSuggestion);
  if (o.claimMap !== undefined) {
    out.claimMap = arr(o.claimMap, (x) => {
      const c = obj(x, 'meta.claimMap');
      return {
        text: str(c.text),
        sourceIds:
          c.sourceIds === 'needs_verification'
            ? ('needs_verification' as const)
            : strs(c.sourceIds),
      };
    });
  }
  if (o.uncertainties !== undefined) out.uncertainties = strs(o.uncertainties);
  if (o.ruleSnapshotId !== undefined)
    out.ruleSnapshotId = strOrNull(o.ruleSnapshotId);
  if (o.affiliation !== undefined) out.affiliation = str(o.affiliation);
  if (o.threadUrl !== undefined) out.threadUrl = strOrNull(o.threadUrl);
  return out;
}

export function decodeVersion(v: unknown): VersionView {
  const o = obj(v, 'version');
  return {
    id: str(o.id),
    contentId: str(o.contentId),
    number: int(o.number),
    title: str(o.title),
    body: str(o.body),
    meta: decodeMeta(o.meta),
    format: oneOf(o.format, CONTENT_KINDS, 'version.format'),
    isScript: bool(o.isScript),
    parentVersionId: strOrNull(o.parentVersionId),
    offerVersionId: str(o.offerVersionId),
    authorMemberId: str(o.authorMemberId),
    aiCallId: strOrNull(o.aiCallId),
    status: oneOf(o.status, VERSION_STATUSES, 'version.status'),
    hash: strOrNull(o.hash),
    frozenAt: isoOrNull(o.frozenAt),
    sourceIds: strs(o.sourceIds),
    claimIds: strs(o.claimIds),
    factIds: strs(o.factIds),
    revision: int(o.revision),
  };
}

function addRem(v: unknown) {
  const o = obj(v, 'diff.set');
  return { added: strs(o.added), removed: strs(o.removed) };
}

export function decodeDiff(v: unknown): VersionDiff {
  const o = obj(v, 'diff');
  const title = o.title === null || o.title === undefined ? null : obj(o.title);
  return {
    a: str(o.a),
    b: str(o.b),
    title: title ? { from: str(title.from), to: str(title.to) } : null,
    body: arr(o.body, (x) => {
      const l = obj(x);
      return {
        op: oneOf(l.op, ['eq', 'add', 'del'] as const),
        text: str(l.text),
      };
    }),
    bodyCoarse: bool(o.bodyCoarse),
    metaChanged: strs(o.metaChanged),
    offerChanged: bool(o.offerChanged),
    sources: addRem(o.sources),
    claims: addRem(o.claims),
    facts: addRem(o.facts),
  };
}

export function decodeClaim(v: unknown): ClaimView {
  const o = obj(v, 'claim');
  return {
    id: str(o.id),
    statement: str(o.statement),
    type: oneOf(o.type, CLAIM_TYPES, 'claim.type'),
    risk: oneOf(o.risk, CLAIM_RISKS, 'claim.risk'),
    status: oneOf(o.status, CLAIM_STATUSES, 'claim.status'),
    extractedFromVersionId: strOrNull(o.extractedFromVersionId),
    experimentId: strOrNull(o.experimentId),
    supersedesId: strOrNull(o.supersedesId),
    verifiedBy: strOrNull(o.verifiedBy),
    verifiedAt: isoOrNull(o.verifiedAt),
    nextCheckAt: isoOrNull(o.nextCheckAt),
    aiCallId: strOrNull(o.aiCallId),
    sources: arr(o.sources, (x) => {
      const s = obj(x, 'claim.source');
      return {
        sourceId: str(s.sourceId),
        supports: oneOf(s.supports, CLAIM_SUPPORTS, 'claim.supports'),
        checkedBy: strOrNull(s.checkedBy),
        checkedAt: isoOrNull(s.checkedAt),
        note: strOrNull(s.note),
      };
    }),
    versionIds: strs(o.versionIds),
    revision: int(o.revision),
  };
}

/** Параметры находки: строки, числа и их списки (иное — чужая форма). */
export function decodeFindingParams(v: unknown): QaFindingParams {
  const o = obj(v, 'finding.params');
  const out: QaFindingParams = {};
  for (const [k, x] of Object.entries(o)) {
    if (typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x)))
      out[k] = x;
    else if (Array.isArray(x) && x.every((y) => typeof y === 'string'))
      out[k] = x as string[];
    else if (
      Array.isArray(x) &&
      x.every((y) => typeof y === 'number' && Number.isFinite(y))
    )
      out[k] = x as number[];
    else throw new PubDecodeError(`finding.params.${k}`);
  }
  return out;
}

function decodeBlocker(v: unknown): QaBlocker {
  const o = obj(v, 'blocker');
  const out: QaBlocker = { code: str(o.code), text: str(o.text) };
  if (o.claimId !== undefined) out.claimId = strOrNull(o.claimId);
  if (o.params !== undefined) out.params = decodeFindingParams(o.params);
  return out;
}

export function decodeQaCheck(v: unknown): QaCheckView {
  const o = obj(v, 'qaCheck');
  return {
    id: str(o.id),
    versionId: str(o.versionId),
    kind: oneOf(o.kind, QA_CHECK_KINDS, 'qa.kind'),
    result: oneOf(o.result, QA_RESULTS, 'qa.result'),
    blockers: arr(o.blockers, decodeBlocker),
    warnings: arr(o.warnings ?? [], (x) => {
      const w = obj(x, 'qa.warning');
      return {
        code: str(w.code),
        text: str(w.text),
        ...(w.params !== undefined
          ? { params: decodeFindingParams(w.params) }
          : {}),
      };
    }),
    checkedBy: str(o.checkedBy),
    checkedAt: iso(o.checkedAt),
    selfReview: bool(o.selfReview),
    aiCallId: strOrNull(o.aiCallId),
  };
}

export function decodeApproval(v: unknown): ApprovalView {
  const o = obj(v, 'approval');
  return {
    id: str(o.id),
    type: oneOf(o.type, ['publish_version'] as const),
    objectType: oneOf(o.objectType, ['content_version'] as const),
    objectId: str(o.objectId),
    versionHash: str(o.versionHash),
    approverMemberId: str(o.approverMemberId),
    approverDisplayName: str(o.approverDisplayName),
    decidedAt: iso(o.decidedAt),
    status: oneOf(o.status, APPROVAL_STATUSES, 'approval.status'),
    selfReview: bool(o.selfReview),
    reason: strOrNull(o.reason),
  };
}

// ── Тела мутаций (зеркало `*Body` contracts/content-api.ts без `opKey`;
// сверка ключей — `scripts/publisher-bodies.test.ts`, тип-уровень) ───────

type Rev = { expectedRevision: number };
type Nul<T> = T | null;
export type CreateSourceIn = {
  kind: SourceKind;
  url?: Nul<string>;
  externalRef?: Nul<string>;
  title: string;
  author?: Nul<string>;
  publishedOn?: Nul<string>;
  fragment: string;
  language?: Nul<string>;
  visibility: SourceVisibility;
  usage: 'allowed' | 'restricted';
};
export type PatchSourceIn = Rev & {
  title?: Nul<string>;
  author?: Nul<string>;
  publishedOn?: Nul<string>;
  language?: Nul<string>;
  externalRef?: Nul<string>;
  visibility?: SourceVisibility;
  checkedAt?: Nul<string>;
  freshness?: 'current' | 'stale' | 'unknown';
  usage?: 'allowed';
  url?: Nul<string>;
  fragment?: string;
};
type QuestionFields = {
  audience?: Nul<string>;
  stage?: QuestionStage;
  observedRepeats?: Nul<number>;
  frequency?: Nul<number>;
  frequencySourceId?: Nul<string>;
  scores?: object;
  priorityNote?: Nul<string>;
  sources?: Array<{ sourceId: string; fragment?: Nul<string> }>;
};
export type CreateQuestionIn = QuestionFields & { text: string };
export type PatchQuestionIn = Rev &
  QuestionFields & {
    text?: string;
    groupId?: Nul<string>;
    status?: 'candidate' | 'selected' | 'rejected';
    selectedRank?: Nul<number>;
  };
export type CreateGroupIn = {
  key: string;
  task: string;
  stage: QuestionStage;
  audience?: Nul<string>;
  rationale: string;
  mergeRisk?: Nul<string>;
  questionIds: string[];
  aiCallId?: Nul<string>;
  moveFromOtherGroups?: boolean;
};
export type PatchGroupIn = Rev & {
  task?: string;
  rationale?: string;
  mergeRisk?: Nul<string>;
  audience?: Nul<string>;
  stage?: QuestionStage;
  status?: 'confirmed' | 'split' | 'rejected';
};
export type CreateFactIn = {
  factKey: string;
  kind: BrandFactKind;
  value: unknown;
  scope?: Nul<string>;
  sourceId?: Nul<string>;
};
export type FactDecisionIn = {
  activate: { basis?: Nul<string> };
  resolve: { keepId: string; reason: string };
  retire: { reason: string };
};
export type CreateOfferIn = {
  title: string;
  text: string;
  priceNote?: Nul<string>;
  factIds?: string[];
};
type BriefFields = {
  offerVersionId?: string;
  goal?: string;
  format?: BriefFormat;
  ownContribution?: Nul<string>;
  shortAnswer?: Nul<string>;
  cta?: Nul<string>;
  ctaIntentNote?: Nul<string>;
  structure?: string[];
  channels?: string[];
  readinessCriteria?: string[];
  effortMinutes?: Nul<number>;
  unresolved?: string[];
  sourceIds?: string[];
};
export type CreateBriefIn = Omit<BriefFields, 'offerVersionId'> & {
  questionId: string;
  offerVersionId?: Nul<string>;
  goal: string;
  format: BriefFormat;
  aiCallId?: Nul<string>;
};
export type PatchBriefIn = Rev &
  BriefFields & { status?: 'draft' | 'rejected' };
export type CreateContentIn = {
  kind: ContentKind;
  briefId?: Nul<string>;
  parentContentId?: Nul<string>;
  slug?: Nul<string>;
  ownerMemberId?: Nul<string>;
  ownerDisplayName?: Nul<string>;
};
export type PatchContentIn = Rev & {
  slug?: Nul<string>;
  ownerMemberId?: Nul<string>;
  ownerDisplayName?: Nul<string>;
  nextDueAt?: Nul<string>;
  blockReason?: Nul<string>;
};
type VersionFields = {
  title?: string;
  body?: string;
  meta?: object;
  sourceIds?: string[];
  claimIds?: string[];
  factIds?: string[];
  offerVersionId?: string;
  parentVersionId?: Nul<string>;
};
export type CreateVersionIn = VersionFields & {
  title: string;
  body: string;
  offerVersionId: string;
  aiCallId?: Nul<string>;
};
export type PatchVersionIn = Rev & VersionFields;
export type TransitionIn = Rev & {
  to: ContentStatus;
  reason?: Nul<string>;
  plannedAt?: Nul<string>;
};
export type CreateClaimIn = {
  statement: string;
  type: ClaimType;
  risk: ClaimRisk;
  extractedFromVersionId?: Nul<string>;
  experimentId?: Nul<string>;
  nextCheckAt?: Nul<string>;
  aiCallId?: Nul<string>;
};
export type PatchClaimIn = Rev & {
  statement?: string;
  type?: ClaimType;
  risk?: ClaimRisk;
  nextCheckAt?: Nul<string>;
};
export type ClaimSourceIn = {
  sourceId: string;
  supports: ClaimSupports;
  note?: Nul<string>;
};
export type VerifyClaimIn = Rev & {
  status: 'supported' | 'unsupported' | 'unknown' | 'needs_review';
};
export type QaCheckIn = {
  kind: 'editorial' | 'technical' | 'adaptation_meaning';
  result: 'pass' | 'fail' | 'unknown';
  blockers?: Array<{ code: string; claimId?: Nul<string>; text: string }>;
};
/**
 * Согласование версии: имя согласующего сервер берёт из гранта роли
 * (P-B1 S3-6) — в теле его нет; `reason` — необязательное основание.
 */
export type ApproveIn = {
  versionHash: string;
  reason?: Nul<string>;
  /** P-R M2: ровно коды WARN свежей `reddit_policy` (подтверждение человеком). */
  acknowledgedWarnings?: string[];
};

/** Тело согласования из формы: hash версии и необязательное основание. */
export function approveBody(versionHash: string, reason: string): ApproveIn {
  const r = reason.trim();
  return { versionHash, ...(r ? { reason: r } : {}) };
}

// ── Клиент ───────────────────────────────────────────────────────────────

export function createContentApi(http: PublisherHttp, pid: string) {
  const P = `products/${seg(pid)}`;
  const page = async <T>(path: string, q: Query, dec: (x: unknown) => T) =>
    listPage(await http.get(`${P}/${path}`, q), dec) as ListPage<T>;
  return {
    // Источники
    sources: (q: Query = {}) => page('sources', q, decodeSource),
    source: async (id: string) =>
      decodeSource(await http.get(`${P}/sources/${seg(id)}`)),
    createSource: async (b: CreateSourceIn, opKey?: string) =>
      decodeSource(await http.send('POST', `${P}/sources`, b, opKey)),
    importUrl: async (
      b: { url: string; visibility: SourceVisibility },
      opKey?: string
    ) =>
      decodeSource(
        await http.send('POST', `${P}/sources/import-url`, b, opKey)
      ),
    patchSource: async (id: string, b: PatchSourceIn, opKey?: string) =>
      decodeSource(
        await http.send('PATCH', `${P}/sources/${seg(id)}`, b, opKey)
      ),
    revokeSource: async (id: string, reason: string, opKey?: string) => {
      const o = obj(
        await http.send(
          'POST',
          `${P}/sources/${seg(id)}/revoke`,
          { reason },
          opKey
        )
      );
      return {
        source: decodeSource(o.source),
        revocationId: str(o.revocationId),
        tasksOpened: int(o.tasksOpened),
      };
    },
    // Вопросы
    questions: (q: Query = {}) => page('questions', q, decodeQuestion),
    createQuestion: async (b: CreateQuestionIn, opKey?: string) =>
      decodeQuestion(await http.send('POST', `${P}/questions`, b, opKey)),
    patchQuestion: async (id: string, b: PatchQuestionIn, opKey?: string) =>
      decodeQuestion(
        await http.send('PATCH', `${P}/questions/${seg(id)}`, b, opKey)
      ),
    groups: (q: Query = {}) => page('question-groups', q, decodeGroup),
    createGroup: async (b: CreateGroupIn, opKey?: string) =>
      decodeGroup(await http.send('POST', `${P}/question-groups`, b, opKey)),
    patchGroup: async (id: string, b: PatchGroupIn, opKey?: string) =>
      decodeGroup(
        await http.send('PATCH', `${P}/question-groups/${seg(id)}`, b, opKey)
      ),
    // Бренд и оффер
    facts: (q: Query = {}) => page('brand-facts', q, decodeFact),
    createFact: async (b: CreateFactIn, opKey?: string) => {
      const o = obj(await http.send('POST', `${P}/brand-facts`, b, opKey));
      return {
        fact: decodeFact(o.fact),
        conflictTaskOpened: bool(o.conflictTaskOpened),
      };
    },
    factDecision: async <A extends keyof FactDecisionIn>(
      id: string,
      action: A,
      b: FactDecisionIn[A],
      opKey?: string
    ) => {
      const o = obj(
        await http.send(
          'POST',
          `${P}/brand-facts/${seg(id)}/${action}`,
          b,
          opKey
        )
      );
      return { fact: decodeFact(o.fact), cascade: decodeCascade(o.cascade) };
    },
    offers: (q: Query = {}) => page('offers', q, decodeOffer),
    createOffer: async (b: CreateOfferIn, opKey?: string) =>
      decodeOffer(await http.send('POST', `${P}/offers`, b, opKey)),
    activateOffer: async (id: string, basis: string, opKey?: string) => {
      const o = obj(
        await http.send(
          'POST',
          `${P}/offers/${seg(id)}/activate`,
          { basis },
          opKey
        )
      );
      return {
        offer: decodeOffer(o.offer),
        parameterVersion: int(o.parameterVersion),
        cascade: decodeCascade(o.cascade),
      };
    },
    contextPreview: async (q: Query = {}) =>
      decodeContextPreview(await http.get(`${P}/context-preview`, q)),
    // Брифы
    briefs: (q: Query = {}) => page('briefs', q, decodeBrief),
    brief: async (id: string) =>
      decodeBrief(await http.get(`${P}/briefs/${seg(id)}`)),
    createBrief: async (b: CreateBriefIn, opKey?: string) =>
      decodeBrief(await http.send('POST', `${P}/briefs`, b, opKey)),
    patchBrief: async (id: string, b: PatchBriefIn, opKey?: string) =>
      decodeBrief(await http.send('PATCH', `${P}/briefs/${seg(id)}`, b, opKey)),
    briefReady: async (id: string, expectedRevision: number, opKey?: string) =>
      decodeBrief(
        await http.send(
          'POST',
          `${P}/briefs/${seg(id)}/ready`,
          { expectedRevision },
          opKey
        )
      ),
    // Материалы
    contents: (q: Query = {}) => page('contents', q, decodeContent),
    content: async (cid: string) =>
      decodeContent(await http.get(`${P}/contents/${seg(cid)}`)),
    createContent: async (b: CreateContentIn, opKey?: string) =>
      decodeContent(await http.send('POST', `${P}/contents`, b, opKey)),
    patchContent: async (cid: string, b: PatchContentIn, opKey?: string) =>
      decodeContent(
        await http.send('PATCH', `${P}/contents/${seg(cid)}`, b, opKey)
      ),
    transition: async (cid: string, b: TransitionIn, opKey?: string) =>
      decodeContent(
        await http.send(
          'POST',
          `${P}/contents/${seg(cid)}/transition`,
          b,
          opKey
        )
      ),
    versions: async (cid: string) =>
      itemsOf(
        await http.get(`${P}/contents/${seg(cid)}/versions`),
        decodeVersion
      ),
    version: async (cid: string, vid: string) =>
      decodeVersion(
        await http.get(`${P}/contents/${seg(cid)}/versions/${seg(vid)}`)
      ),
    diff: async (cid: string, a: string, b: string) =>
      decodeDiff(
        await http.get(
          `${P}/contents/${seg(cid)}/versions/${seg(a)}/diff/${seg(b)}`
        )
      ),
    createVersion: async (cid: string, b: CreateVersionIn, opKey?: string) =>
      decodeVersion(
        await http.send('POST', `${P}/contents/${seg(cid)}/versions`, b, opKey)
      ),
    patchVersion: async (
      cid: string,
      vid: string,
      b: PatchVersionIn,
      opKey?: string
    ) =>
      decodeVersion(
        await http.send(
          'PATCH',
          `${P}/contents/${seg(cid)}/versions/${seg(vid)}`,
          b,
          opKey
        )
      ),
    submitVersion: async (
      cid: string,
      vid: string,
      expectedRevision: number,
      opKey?: string
    ) =>
      decodeVersion(
        await http.send(
          'POST',
          `${P}/contents/${seg(cid)}/versions/${seg(vid)}/submit`,
          { expectedRevision },
          opKey
        )
      ),
    // Claims
    claims: (q: Query = {}) => page('claims', q, decodeClaim),
    createClaim: async (b: CreateClaimIn, opKey?: string) =>
      decodeClaim(await http.send('POST', `${P}/claims`, b, opKey)),
    patchClaim: async (id: string, b: PatchClaimIn, opKey?: string) => {
      const o = obj(
        await http.send('PATCH', `${P}/claims/${seg(id)}`, b, opKey)
      );
      return {
        claim: decodeClaim(o.claim),
        supersededId: strOrNull(o.supersededId),
        cascade:
          o.cascade === null || o.cascade === undefined
            ? null
            : decodeCascade(o.cascade),
      };
    },
    claimSource: async (id: string, b: ClaimSourceIn, opKey?: string) =>
      decodeClaim(
        await http.send('POST', `${P}/claims/${seg(id)}/sources`, b, opKey)
      ),
    verifyClaim: async (id: string, b: VerifyClaimIn, opKey?: string) =>
      decodeClaim(
        await http.send('POST', `${P}/claims/${seg(id)}/verify`, b, opKey)
      ),
    // QA и согласование
    qaChecks: async (vid: string) =>
      itemsOf(
        await http.get(`${P}/versions/${seg(vid)}/qa-checks`),
        decodeQaCheck
      ),
    qaCheck: async (vid: string, b: QaCheckIn, opKey?: string) =>
      decodeQaCheck(
        await http.send('POST', `${P}/versions/${seg(vid)}/qa-checks`, b, opKey)
      ),
    approve: async (vid: string, b: ApproveIn, opKey?: string) =>
      decodeApproval(
        await http.send('POST', `${P}/versions/${seg(vid)}/approve`, b, opKey)
      ),
    approvals: async (q: Query = {}) =>
      itemsOf(await http.get(`${P}/approvals`, q), decodeApproval),
    revokeApproval: async (id: string, reason: string, opKey?: string) =>
      decodeApproval(
        await http.send(
          'POST',
          `${P}/approvals/${seg(id)}/revoke`,
          { reason },
          opKey
        )
      ),
  };
}
export type ContentApi = ReturnType<typeof createContentApi>;

/** Значение факта бренда для показа: `{text}`, `{question, answer}`, цена. */
export function factValueText(v: unknown): string {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Rec;
    if (typeof o.text === 'string') return o.text;
    if (typeof o.question === 'string' && typeof o.answer === 'string') {
      return `${o.question} — ${o.answer}`;
    }
    if (typeof o.amountMinor === 'number' && typeof o.currency === 'string') {
      const n = num(o.amountMinor) / 100;
      return `${n} ${o.currency}${typeof o.note === 'string' ? ` (${o.note})` : ''}`;
    }
  }
  return JSON.stringify(v);
}
