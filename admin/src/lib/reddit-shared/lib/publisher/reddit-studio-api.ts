// СГЕНЕРИРОВАНО scripts/sync-admin-reddit-shared.mjs — не править.
// Источник: assist/src/lib/publisher/reddit-studio-api.ts. Правка — в источнике, затем
// `node scripts/sync-admin-reddit-shared.mjs`; CI сверяет копию флагом --check.

/**
 * AI Publisher (P-R, Reddit Manual MVP, M2 AI Content Studio) — клиент
 * маршрутов M2 раздела `…/reddit/**` (брифы, генерация, материалы,
 * копирование, отчёт о публикации) и Reddit-ветви общих маршрутов версий
 * (`…/contents/:cid/versions`), строгие декодеры ответов (контракт
 * `contracts/reddit-api.ts` M2, `contracts/content-api.ts`,
 * `contracts/distribution-api.ts`; описание — `pub-r-m2-contract.md`).
 * `scripts/publisher-reddit-api.test.ts` сверяет 14 маршрутов M2, формы
 * и тела (Reddit-ветвь версий — по правилам §3.1 контракта); `publisher-bodies.test.ts` — тела на уровне типов.
 *
 * Тексты Reddit (контекст брифа, варианты, тело версии) — только текстом
 * на экране. Исходящих запросов к Reddit нет (A11).
 *
 * Чистый модуль (без React).
 */
import type { PublisherHttp, Query } from './common-pure';
import {
  decodeContent,
  decodeQaCheck,
  decodeVersion,
  type ContentView,
  type QaCheckView,
  type VersionView,
} from './content-api';
import { decodeCall, type AiCallView } from './ai-api';
import { decodePublication, type PublicationView } from './calendar-api';
import {
  arr,
  bad,
  bool,
  choice,
  int,
  iso,
  isoN,
  obj,
  page,
  productPath,
  seg,
  str,
  strList,
  strN,
  verbs,
  type ListPage,
} from './ops-decode';
import { AI_CALL_STATUSES, type AiCallStatus } from './states';
import {
  decodeGate,
  decodeRulesSummary,
  type RedditGateView,
  type RedditRulesSummary,
} from './reddit-api';

// ── Закрытые списки (зеркало contracts/states.ts, reddit-api.ts, checks.ts) ─

export const REDDIT_CONTENT_TYPES = ['post', 'comment'] as const;
export type RedditContentType = (typeof REDDIT_CONTENT_TYPES)[number];
export const REDDIT_AFFILIATIONS = [
  'founder',
  'employee',
  'agency',
  'customer',
  'none',
] as const;
export type RedditAffiliation = (typeof REDDIT_AFFILIATIONS)[number];
export const REDDIT_BRIEF_STATUSES = ['draft', 'ready', 'archived'] as const;
export type RedditBriefStatus = (typeof REDDIT_BRIEF_STATUSES)[number];
export const REDDIT_DRAFT_TEMPLATES = [
  'helpful_answer',
  'educational_post',
  'comparison',
  'troubleshooting',
  'feedback_request',
] as const;
export type RedditDraftTemplate = (typeof REDDIT_DRAFT_TEMPLATES)[number];
/** Коды BLOCK `reddit_policy` (`reddit/checks.ts`, `markers@4`: 18). */
export const REDDIT_CHECK_BLOCKERS = [
  'reddit_rules_missing',
  'reddit_rules_unreviewed',
  'reddit_rules_stale',
  'reddit_rules_source_revoked',
  'reddit_rules_changed',
  'reddit_promotion_prohibited',
  'reddit_promotion_unknown',
  'reddit_links_unknown',
  'reddit_links_prohibited',
  'reddit_links_not_allowed',
  'reddit_disclosure_missing',
  'reddit_disclosure_negated',
  'reddit_unverified_claim',
  'reddit_source_not_allowed',
  'reddit_forbidden_claim',
  'reddit_fake_testimonial',
  'reddit_pii',
  'reddit_thread_missing',
] as const;
/** Коды WARN `reddit_policy` (подтверждаются при согласовании и копировании; 13). */
export const REDDIT_CHECK_WARNINGS = [
  'reddit_links_restricted',
  'reddit_claim_needs_verification',
  'reddit_duplicate',
  'reddit_offensive',
  'reddit_flair_missing',
  'reddit_link_suspect',
  'reddit_disclosure_unclear',
  'reddit_claim_from_brief',
  'reddit_guarantee',
  'reddit_personal_experience',
  'reddit_social_proof',
  'reddit_testimonial_unclear',
  'reddit_claim_source_mismatch',
] as const;
/** Находки вызова `pub.reddit.draft` (подсказка человеку, все critical). */
export const REDDIT_AI_FINDINGS = [
  'link_present',
  'first_person_experience',
  'disclosure_missing',
] as const;
/** Чего не хватает брифу (шаблон `key_points[N]` — отдельно). */
export const REDDIT_BRIEF_MISSING = [
  'brief_ready',
  'objective',
  'affiliation',
  'brand',
  'key_points',
  'context',
  'thread',
  'offer_active',
] as const;
export const REDDIT_AI_UNAVAILABLE = [
  'flag_off',
  'generator_disabled',
] as const;
/** Клиентские ключи `meta` Reddit-версии (`REDDIT_VERSION_META_KEYS`). */
export const REDDIT_VERSION_META_KEYS = [
  'disclosure',
  'flairSuggestion',
  'claimMap',
  'uncertainties',
] as const;
export const PUBLICATION_STAGES_R = ['test', 'live'] as const;

// ── Формы ─────────────────────────────────────────────────────────────────

export type RedditClaimSources = string[] | 'needs_verification';
export interface RedditKeyPoint {
  text: string;
  sourceIds: RedditClaimSources;
}
export interface RedditBriefView {
  id: string;
  projectId: string;
  communityId: string;
  subreddit: string;
  canonicalUrl: string;
  opportunityId: string | null;
  threadUrl: string | null;
  offerVersionId: string;
  contentType: RedditContentType;
  objective: string;
  audience: string | null;
  context: string | null;
  /** Пометка выдержки треда («похоже на команду модели», §12.4). */
  injectionFlag: string | null;
  keyPoints: RedditKeyPoint[];
  affiliation: RedditAffiliation | null;
  /** Имя продукта/бренда в раскрытии (P-R M2 §9.1); по умолчанию — продукт. */
  brand: string | null;
  linksAllowed: boolean;
  tone: string | null;
  language: string;
  constraints: string[];
  forbiddenClaims: string[];
  cta: string | null;
  status: RedditBriefStatus;
  missing: string[];
  gate: RedditGateView;
  ai: {
    available: boolean;
    reason: (typeof REDDIT_AI_UNAVAILABLE)[number] | null;
  };
  contentIds: string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface RedditDraftVariant {
  title: string | null;
  body: string;
  disclosure: string;
  flair_suggestion: string | null;
  claim_map: Array<{ text: string; source_ids: RedditClaimSources }>;
  uncertainties: string[];
}
export interface RedditGenerateResponse {
  callId: string;
  status: AiCallStatus;
  call: AiCallView | null;
}
export interface RedditPublicationView extends PublicationView {
  contentId: string;
  communityId: string;
  subreddit: string;
}
export interface RedditMaterialApproval {
  id: string;
  versionId: string;
  status: 'active';
  selfReview: boolean;
  decidedAt: string;
}
export interface RedditMaterialView {
  content: ContentView;
  briefId: string;
  contentType: RedditContentType;
  communityId: string;
  subreddit: string;
  canonicalUrl: string;
  threadUrl: string | null;
  openUrl: string;
  rules: RedditRulesSummary | null;
  currentVersion: VersionView | null;
  approvedVersion: VersionView | null;
  /**
   * Активное согласование утверждённой версии — id для отзыва
   * (`…/approvals/:id/revoke`); null — нет или отозвано/истекло (P-R-ADM v1.3).
   */
  approval: RedditMaterialApproval | null;
  policyCheck: QaCheckView | null;
  copies: { count: number; lastAt: string | null };
  publications: RedditPublicationView[];
  /** Последний вызов `pub.reddit.draft` брифа (варианты — `GET ai/calls/:id`). */
  lastGeneration: {
    callId: string;
    status: AiCallStatus;
    requestedAt: string;
  } | null;
}
export interface RedditCopyView {
  contentId: string;
  versionId: string;
  versionHash: string;
  contentType: RedditContentType;
  title: string | null;
  body: string;
  flairSuggestion: string | null;
  disclosure: string;
  openUrl: string;
  copyToken: string;
  copiedAt: string;
  scheduled: boolean;
  policyCheckId: string;
  rules: { snapshotId: string; version: number; checkedAt: string };
}

// ── Тела (без `opKey`) ────────────────────────────────────────────────────

export interface CreateRedditBriefIn {
  projectId: string;
  contentType: RedditContentType;
  opportunityId?: string | null;
  communityId?: string;
  objective: string;
  audience?: string | null;
  context?: string | null;
  keyPoints?: RedditKeyPoint[];
  affiliation?: RedditAffiliation | null;
  brand?: string | null;
  linksAllowed?: boolean;
  tone?: string | null;
  language?: string;
  constraints?: string[];
  forbiddenClaims?: string[];
  cta?: string | null;
}
export interface PatchRedditBriefIn {
  expectedRevision: number;
  objective?: string;
  audience?: string | null;
  context?: string | null;
  keyPoints?: RedditKeyPoint[];
  affiliation?: RedditAffiliation | null;
  brand?: string | null;
  linksAllowed?: boolean;
  tone?: string | null;
  language?: string;
  constraints?: string[];
  forbiddenClaims?: string[];
  cta?: string | null;
  offerVersionId?: string;
}
export interface GenerateRedditDraftIn {
  template: RedditDraftTemplate;
  variants?: 2 | 3;
  request?: string | null;
  rewrite?: { versionId: string; paragraph: number } | null;
}
export interface CreateRedditContentIn {
  ownerMemberId?: string | null;
}
/** Тело копирования: WARN, появившиеся после согласования (§9.7). */
export interface CopyRedditContentIn {
  acknowledgedWarnings?: string[];
}
export interface ReportRedditPublicationIn {
  url: string;
  postedAt: string;
  notes?: string | null;
}
/** Клиентская часть `meta` Reddit-версии (серверные ключи не шлём). */
export interface RedditVersionMetaIn {
  disclosure?: string;
  flairSuggestion?: string | null;
  claimMap?: Array<{ text: string; sourceIds: RedditClaimSources }>;
  uncertainties?: string[];
}
/**
 * Версия Reddit-материала (общий маршрут, ветвь Reddit): у comment нет
 * `title` (сервер пишет служебный), `offerVersionId`/`sourceIds`/
 * `parentVersionId` не передаются (400 `derived`/`not_allowed`).
 */
export interface CreateRedditVersionIn {
  title?: string;
  body: string;
  meta?: RedditVersionMetaIn;
  aiCallId?: string | null;
  variantIndex?: number | null;
}
export interface PatchRedditVersionIn {
  expectedRevision: number;
  title?: string;
  body?: string;
  meta?: RedditVersionMetaIn;
  aiCallId?: string | null;
  variantIndex?: number | null;
}
export interface RedditBriefFilter {
  before?: string;
  limit?: number;
  status?: string;
  projectId?: string;
  communityId?: string;
  opportunityId?: string;
  contentType?: string;
  q?: string;
}
export interface RedditPublicationFilter {
  before?: string;
  limit?: number;
  status?: string;
  stage?: string;
  communityId?: string;
  contentId?: string;
}

// ── Декодеры ──────────────────────────────────────────────────────────────

const MISSING_RE =
  /^(brief_ready|objective|affiliation|brand|key_points|context|thread|offer_active|key_points\[\d{1,2}\])$/;

function claimSources(v: unknown, where: string): RedditClaimSources {
  if (v === 'needs_verification') return 'needs_verification';
  return strList(v, where);
}

export function decodeKeyPoint(v: unknown): RedditKeyPoint {
  const o = obj(v, 'keyPoint');
  return {
    text: str(o.text, 'keyPoint.text'),
    sourceIds: claimSources(o.sourceIds, 'keyPoint.sourceIds'),
  };
}

export function decodeRedditBrief(v: unknown): RedditBriefView {
  const o = obj(v, 'redditBrief');
  const ai = obj(o.ai, 'brief.ai');
  return {
    id: str(o.id, 'brief.id'),
    projectId: str(o.projectId, 'brief.projectId'),
    communityId: str(o.communityId, 'brief.communityId'),
    subreddit: str(o.subreddit, 'brief.subreddit'),
    canonicalUrl: str(o.canonicalUrl, 'brief.canonicalUrl'),
    opportunityId: strN(o.opportunityId, 'brief.opportunityId'),
    threadUrl: strN(o.threadUrl, 'brief.threadUrl'),
    offerVersionId: str(o.offerVersionId, 'brief.offerVersionId'),
    contentType: choice(o.contentType, REDDIT_CONTENT_TYPES, 'brief.type'),
    objective: str(o.objective, 'brief.objective'),
    audience: strN(o.audience, 'brief.audience'),
    context: strN(o.context, 'brief.context'),
    injectionFlag: strN(o.injectionFlag, 'brief.injectionFlag'),
    keyPoints: arr(o.keyPoints, 'brief.keyPoints').map(decodeKeyPoint),
    affiliation:
      o.affiliation === null
        ? null
        : choice(o.affiliation, REDDIT_AFFILIATIONS, 'brief.affiliation'),
    brand: strN(o.brand, 'brief.brand'),
    linksAllowed: bool(o.linksAllowed, 'brief.linksAllowed'),
    tone: strN(o.tone, 'brief.tone'),
    language: str(o.language, 'brief.language'),
    constraints: strList(o.constraints, 'brief.constraints'),
    forbiddenClaims: strList(o.forbiddenClaims, 'brief.forbiddenClaims'),
    cta: strN(o.cta, 'brief.cta'),
    status: choice(o.status, REDDIT_BRIEF_STATUSES, 'brief.status'),
    missing: strList(o.missing, 'brief.missing').map((x) =>
      MISSING_RE.test(x) ? x : bad(`brief.missing:${x}`)
    ),
    gate: decodeGate(o.gate, 'brief.gate'),
    ai: {
      available: bool(ai.available, 'brief.ai.available'),
      reason:
        ai.reason === null
          ? null
          : choice(ai.reason, REDDIT_AI_UNAVAILABLE, 'brief.ai.reason'),
    },
    contentIds: strList(o.contentIds, 'brief.contentIds'),
    revision: int(o.revision, 'brief.revision'),
    createdAt: iso(o.createdAt, 'brief.createdAt'),
    updatedAt: iso(o.updatedAt, 'brief.updatedAt'),
  };
}

/** Выход `pub.reddit.draft` (`AiCallView.output`) — строго, 2..3 варианта. */
export function decodeDraftOutput(v: unknown): RedditDraftVariant[] {
  const o = obj(v, 'redditDraft');
  const vs = arr(o.variants, 'redditDraft.variants').map((x) => {
    const r = obj(x, 'variant');
    return {
      title: strN(r.title, 'variant.title'),
      body: str(r.body, 'variant.body'),
      disclosure: str(r.disclosure, 'variant.disclosure'),
      flair_suggestion: strN(r.flair_suggestion, 'variant.flair'),
      claim_map: arr(r.claim_map, 'variant.claim_map').map((c) => {
        const m = obj(c, 'variant.claim');
        return {
          text: str(m.text, 'variant.claim.text'),
          source_ids: claimSources(m.source_ids, 'variant.claim.source_ids'),
        };
      }),
      uncertainties: strList(r.uncertainties, 'variant.uncertainties'),
    };
  });
  if (vs.length < 2 || vs.length > 3) bad('redditDraft.variants:count');
  return vs;
}

export function decodeGenerate(v: unknown): RedditGenerateResponse {
  const o = obj(v, 'redditGenerate');
  return {
    callId: str(o.callId, 'generate.callId'),
    status: choice(o.status, AI_CALL_STATUSES, 'generate.status'),
    call: o.call === null ? null : decodeCall(o.call),
  };
}

export function decodeRedditPublication(v: unknown): RedditPublicationView {
  const o = obj(v, 'redditPublication');
  return {
    ...decodePublication(o),
    contentId: str(o.contentId, 'publication.contentId'),
    communityId: str(o.communityId, 'publication.communityId'),
    subreddit: str(o.subreddit, 'publication.subreddit'),
  };
}

function decodeLastGeneration(
  v: unknown
): RedditMaterialView['lastGeneration'] {
  if (v === null) return null;
  const g = obj(v, 'material.lastGeneration');
  return {
    callId: str(g.callId, 'lastGeneration.callId'),
    status: choice(g.status, AI_CALL_STATUSES, 'lastGeneration.status'),
    requestedAt: iso(g.requestedAt, 'lastGeneration.requestedAt'),
  };
}

function decodeMaterialApproval(v: unknown): RedditMaterialApproval | null {
  if (v === null) return null;
  const a = obj(v, 'material.approval');
  const id = (x: unknown, where: string): string => {
    const t = str(x, where);
    // id идёт в путь отзыва — только безопасные символы.
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(t)) bad(where);
    return t;
  };
  return {
    id: id(a.id, 'approval.id'),
    versionId: id(a.versionId, 'approval.versionId'),
    status: choice(a.status, ['active'] as const, 'approval.status'),
    selfReview: bool(a.selfReview, 'approval.selfReview'),
    decidedAt: iso(a.decidedAt, 'approval.decidedAt'),
  };
}

export function decodeMaterial(v: unknown): RedditMaterialView {
  const o = obj(v, 'redditMaterial');
  const cp = obj(o.copies, 'material.copies');
  return {
    content: decodeContent(o.content),
    briefId: str(o.briefId, 'material.briefId'),
    contentType: choice(o.contentType, REDDIT_CONTENT_TYPES, 'material.type'),
    communityId: str(o.communityId, 'material.communityId'),
    subreddit: str(o.subreddit, 'material.subreddit'),
    canonicalUrl: str(o.canonicalUrl, 'material.canonicalUrl'),
    threadUrl: strN(o.threadUrl, 'material.threadUrl'),
    openUrl: str(o.openUrl, 'material.openUrl'),
    rules: o.rules === null ? null : decodeRulesSummary(o.rules),
    currentVersion:
      o.currentVersion === null ? null : decodeVersion(o.currentVersion),
    approvedVersion:
      o.approvedVersion === null ? null : decodeVersion(o.approvedVersion),
    approval: decodeMaterialApproval(o.approval),
    policyCheck: o.policyCheck === null ? null : decodeQaCheck(o.policyCheck),
    copies: {
      count: int(cp.count, 'material.copies.count'),
      lastAt: isoN(cp.lastAt, 'material.copies.lastAt'),
    },
    publications: arr(o.publications, 'material.publications').map(
      decodeRedditPublication
    ),
    lastGeneration: decodeLastGeneration(o.lastGeneration),
  };
}

export function decodeCopy(v: unknown): RedditCopyView {
  const o = obj(v, 'redditCopy');
  const rl = obj(o.rules, 'copy.rules');
  return {
    contentId: str(o.contentId, 'copy.contentId'),
    versionId: str(o.versionId, 'copy.versionId'),
    versionHash: str(o.versionHash, 'copy.versionHash'),
    contentType: choice(o.contentType, REDDIT_CONTENT_TYPES, 'copy.type'),
    title: strN(o.title, 'copy.title'),
    body: str(o.body, 'copy.body'),
    flairSuggestion: strN(o.flairSuggestion, 'copy.flair'),
    disclosure: str(o.disclosure, 'copy.disclosure'),
    openUrl: str(o.openUrl, 'copy.openUrl'),
    copyToken: str(o.copyToken, 'copy.copyToken'),
    copiedAt: iso(o.copiedAt, 'copy.copiedAt'),
    scheduled: bool(o.scheduled, 'copy.scheduled'),
    policyCheckId: str(o.policyCheckId, 'copy.policyCheckId'),
    rules: {
      snapshotId: str(rl.snapshotId, 'copy.rules.snapshotId'),
      version: int(rl.version, 'copy.rules.version'),
      checkedAt: iso(rl.checkedAt, 'copy.rules.checkedAt'),
    },
  };
}

// ── Клиент ────────────────────────────────────────────────────────────────

function q(f: Record<string, string | number | undefined>): Query {
  const out: Query = {};
  for (const [k, v] of Object.entries(f)) {
    if (v === undefined || v === '') continue;
    out[k] = k === 'limit' ? Math.max(1, Math.min(100, Number(v))) : v;
  }
  if (typeof out.q === 'string') out.q = out.q.trim().slice(0, 200);
  return out;
}

/** Списки M2 с CSV (`REDDIT_CSV_COLUMNS.briefs|publications`). */
export const REDDIT_STUDIO_LISTS = ['briefs', 'publications'] as const;

export function redditStudioListPath(
  pid: string,
  list: (typeof REDDIT_STUDIO_LISTS)[number]
): string {
  return `${productPath(pid)}/reddit/${list}`;
}

export function createRedditStudioApi(http: PublisherHttp, pid: string) {
  const R = `${productPath(pid)}/reddit`;
  const C = productPath(pid);
  const { get, post, patch } = verbs(http);
  return {
    // Брифы
    briefs: async (
      f: RedditBriefFilter = {}
    ): Promise<ListPage<RedditBriefView>> =>
      page(await get(`${R}/briefs`, q({ ...f })), decodeRedditBrief),
    brief: async (id: string) =>
      decodeRedditBrief(await get(`${R}/briefs/${seg(id)}`)),
    createBrief: async (opKey: string, body: CreateRedditBriefIn) =>
      decodeRedditBrief(await post(`${R}/briefs`, { ...body }, opKey)),
    patchBrief: async (id: string, opKey: string, body: PatchRedditBriefIn) =>
      decodeRedditBrief(
        await patch(`${R}/briefs/${seg(id)}`, { ...body }, opKey)
      ),
    briefReady: async (id: string, opKey: string, expectedRevision: number) =>
      decodeRedditBrief(
        await post(`${R}/briefs/${seg(id)}/ready`, { expectedRevision }, opKey)
      ),
    archiveBrief: async (id: string, opKey: string, expectedRevision: number) =>
      decodeRedditBrief(
        await post(
          `${R}/briefs/${seg(id)}/archive`,
          { expectedRevision },
          opKey
        )
      ),
    generate: async (id: string, opKey: string, body: GenerateRedditDraftIn) =>
      decodeGenerate(
        await post(`${R}/briefs/${seg(id)}/generate`, { ...body }, opKey)
      ),
    briefContents: async (id: string) =>
      arr(
        obj(await get(`${R}/briefs/${seg(id)}/contents`), 'briefContents')
          .items,
        'briefContents.items'
      ).map(decodeMaterial),
    createContent: async (
      briefId: string,
      opKey: string,
      body: CreateRedditContentIn = {}
    ) =>
      decodeMaterial(
        await post(`${R}/briefs/${seg(briefId)}/contents`, { ...body }, opKey)
      ),
    // Материал
    material: async (cid: string) =>
      decodeMaterial(await get(`${R}/contents/${seg(cid)}`)),
    check: async (cid: string, opKey: string) =>
      decodeQaCheck(await post(`${R}/contents/${seg(cid)}/check`, {}, opKey)),
    copy: async (cid: string, opKey: string, body: CopyRedditContentIn = {}) =>
      decodeCopy(
        await post(`${R}/contents/${seg(cid)}/copy`, { ...body }, opKey)
      ),
    reportPublication: async (
      cid: string,
      opKey: string,
      body: ReportRedditPublicationIn
    ) =>
      decodeRedditPublication(
        await post(
          `${R}/contents/${seg(cid)}/report-publication`,
          { ...body },
          opKey
        )
      ),
    publications: async (
      f: RedditPublicationFilter = {}
    ): Promise<ListPage<RedditPublicationView>> =>
      page(
        await get(`${R}/publications`, q({ ...f })),
        decodeRedditPublication
      ),
    // Версии Reddit-материала (общие маршруты контента, ветвь Reddit)
    createVersion: async (
      cid: string,
      opKey: string,
      body: CreateRedditVersionIn
    ) =>
      decodeVersion(
        await post(`${C}/contents/${seg(cid)}/versions`, { ...body }, opKey)
      ),
    patchVersion: async (
      cid: string,
      vid: string,
      opKey: string,
      body: PatchRedditVersionIn
    ) =>
      decodeVersion(
        await patch(
          `${C}/contents/${seg(cid)}/versions/${seg(vid)}`,
          { ...body },
          opKey
        )
      ),
  };
}
export type RedditStudioApi = ReturnType<typeof createRedditStudioApi>;
