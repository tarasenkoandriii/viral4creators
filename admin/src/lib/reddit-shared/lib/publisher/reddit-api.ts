// СГЕНЕРИРОВАНО scripts/sync-admin-reddit-shared.mjs — не править.
// Источник: assist/src/lib/publisher/reddit-api.ts. Правка — в источнике, затем
// `node scripts/sync-admin-reddit-shared.mjs`; CI сверяет копию флагом --check.

/**
 * AI Publisher (P-R, Reddit Manual MVP, M1 Research) — клиент маршрутов
 * `/publisher/products/:pid/reddit/**` и строгие декодеры ответов
 * (контракт `sites-backend/src/modules/publisher/contracts/reddit-api.ts`,
 * `REDDIT_ROUTES`; закрытые списки — `contracts/states.ts` `REDDIT_*`).
 * `scripts/publisher-reddit-api.test.ts` сверяет перечни, ключи ответов,
 * пути/методы всех 23 маршрутов и тела мутаций; `publisher-bodies.test.ts`
 * — тела на уровне типов.
 *
 * Режим только ручного ввода (Р-RD-0): кабинет не обращается к Reddit —
 * ни превью, ни oEmbed, ни favicon. URL треда/правил — только хранимая
 * строка; выдержки (`excerpt`) — только текст (экран — `<pre>`).
 *
 * Чистый модуль (без React).
 */
import type { PublisherHttp, Query } from './common-pure';
import {
  arr,
  bad,
  bool,
  choice,
  int,
  intN,
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

// ── Закрытые списки (зеркало contracts/states.ts и reddit-api.ts) ─────────

export const REDDIT_PROJECT_STATUSES = ['active', 'archived'] as const;
export type RedditProjectStatus = (typeof REDDIT_PROJECT_STATUSES)[number];
export const REDDIT_COMMUNITY_STATUSES = ['active', 'archived'] as const;
export type RedditCommunityStatus = (typeof REDDIT_COMMUNITY_STATUSES)[number];
export const REDDIT_PROMOTION_POLICIES = [
  'allowed_with_conditions',
  'prohibited',
  'unknown',
] as const;
export type RedditPromotionPolicy = (typeof REDDIT_PROMOTION_POLICIES)[number];
export const REDDIT_LINKS_POLICIES = [
  'allowed',
  'restricted',
  'prohibited',
  'unknown',
] as const;
export type RedditLinksPolicy = (typeof REDDIT_LINKS_POLICIES)[number];
export const REDDIT_REVIEW_STATES = ['unreviewed', 'reviewed'] as const;
export type RedditReviewState = (typeof REDDIT_REVIEW_STATES)[number];
export const REDDIT_SNAPSHOT_STATUSES = ['current', 'superseded'] as const;
export type RedditSnapshotStatus = (typeof REDDIT_SNAPSHOT_STATUSES)[number];
export const REDDIT_INTENTS = [
  'how_to',
  'comparison',
  'alternative',
  'troubleshooting',
  'recommendation',
  'discussion',
  'other',
] as const;
export type RedditIntent = (typeof REDDIT_INTENTS)[number];
export const REDDIT_KEYWORD_STATUSES = ['active', 'archived'] as const;
export type RedditKeywordStatus = (typeof REDDIT_KEYWORD_STATUSES)[number];
export const REDDIT_POLICY_VERDICTS = [
  'ok',
  'block',
  'recheck_required',
] as const;
export type RedditPolicyVerdict = (typeof REDDIT_POLICY_VERDICTS)[number];
export const REDDIT_OPPORTUNITY_STATUSES = [
  'new',
  'qualified',
  'recheck_required',
  'blocked',
  'skipped',
  'in_brief',
  'archived',
] as const;
export type RedditOpportunityStatus =
  (typeof REDDIT_OPPORTUNITY_STATUSES)[number];
/** Факторы score v1: первые четыре — relevance, остальные — risk. */
export const REDDIT_SCORE_FACTORS = [
  'topic_fit',
  'intent_fit',
  'audience_fit',
  'answerability',
  'policy_risk',
  'promotionality',
  'evidence_gap',
  'context_uncertainty',
] as const;
export type RedditScoreFactor = (typeof REDDIT_SCORE_FACTORS)[number];
/** Факторы, которые вводит оператор (`policy_risk` — из снимка правил). */
export const REDDIT_OPERATOR_FACTORS = REDDIT_SCORE_FACTORS.filter(
  (f): f is Exclude<RedditScoreFactor, 'policy_risk'> => f !== 'policy_risk'
);
export type RedditOperatorFactor = (typeof REDDIT_OPERATOR_FACTORS)[number];
export const REDDIT_SNAPSHOT_STATES = [
  'unreviewed',
  'reviewed',
  'stale',
] as const;
export type RedditSnapshotState = (typeof REDDIT_SNAPSHOT_STATES)[number];
export const REDDIT_POLICY_REASONS = [
  'rules_missing',
  'rules_unreviewed',
  'rules_stale',
  'promotion_prohibited',
  'promotion_unknown',
  'links_unknown',
  'links_prohibited',
  'rules_changed',
  /** Первоисточник текущего снимка отозван (`POST /sources/:id/revoke`). */
  'rules_source_revoked',
] as const;
export type RedditPolicyReason = (typeof REDDIT_POLICY_REASONS)[number];
export const REDDIT_POLICY_WARNINGS = ['links_restricted'] as const;
/**
 * Коды обоснования `factors.policy_risk.reasons` (`reddit/policy.ts`
 * `policyRiskReasons`): `rules_missing` либо `promotion_<политика>` +
 * `links_<политика>`; экран переводит сам (текста сервер не шлёт).
 */
export const REDDIT_POLICY_RISK_REASONS = [
  'rules_missing',
  'promotion_allowed_with_conditions',
  'promotion_prohibited',
  'promotion_unknown',
  'links_allowed',
  'links_restricted',
  'links_prohibited',
  'links_unknown',
] as const;
export type RedditPolicyRiskReason =
  (typeof REDDIT_POLICY_RISK_REASONS)[number];
export type RedditPolicyWarning = (typeof REDDIT_POLICY_WARNINGS)[number];
export const SOURCE_USAGES_R = ['allowed', 'restricted', 'revoked'] as const;
/** `PUB_TRANSITION_INVALID.details.reason` маршрутов P-R. */
export const REDDIT_TRANSITION_REASONS = [
  'policy_block',
  'policy_recheck',
  'status',
  'project_archived',
  'community_archived',
  'already_reviewed',
  'superseded',
] as const;
export type RedditTransitionReason = (typeof REDDIT_TRANSITION_REASONS)[number];

/** Колонки CSV (`REDDIT_CSV_COLUMNS`) — подпись выгрузки на экране. */
export const REDDIT_LISTS = [
  'projects',
  'communities',
  'opportunities',
  'keywords',
] as const;
export type RedditList = (typeof REDDIT_LISTS)[number];

// ── Формы ответов ─────────────────────────────────────────────────────────

export interface RedditGateView {
  verdict: RedditPolicyVerdict;
  reasons: RedditPolicyReason[];
  warnings: RedditPolicyWarning[];
}
export interface RedditProjectView {
  id: string;
  title: string;
  locale: string;
  market: string;
  status: RedditProjectStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface RedditRulesSummary {
  snapshotId: string;
  version: number;
  state: RedditSnapshotState;
  reviewState: RedditReviewState;
  checkedAt: string;
  reviewedAt: string | null;
  selfReview: boolean;
  promotionPolicy: RedditPromotionPolicy;
  linksPolicy: RedditLinksPolicy;
  gate: RedditGateView;
}
export interface RedditCommunityView {
  id: string;
  projectId: string;
  channelId: string;
  subreddit: string;
  canonicalUrl: string;
  descriptionManual: string | null;
  language: string | null;
  topics: string[];
  status: RedditCommunityStatus;
  rules: RedditRulesSummary | null;
  staleDays: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface RedditRuleSnapshotView {
  id: string;
  communityId: string;
  version: number;
  source: {
    id: string;
    url: string;
    excerpt: string;
    injectionFlag: string | null;
    usage: (typeof SOURCE_USAGES_R)[number];
  };
  promotionPolicy: RedditPromotionPolicy;
  linksPolicy: RedditLinksPolicy;
  flairRequired: boolean | null;
  conditions: string[];
  checkedAt: string;
  reviewState: RedditReviewState;
  state: RedditSnapshotState;
  createdBy: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  selfReview: boolean;
  status: RedditSnapshotStatus;
  gate: RedditGateView;
  createdAt: string;
}
export interface RedditKeywordView {
  id: string;
  projectId: string;
  phrase: string;
  phraseNorm: string;
  intent: RedditIntent;
  locale: string | null;
  priority: number;
  status: RedditKeywordStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface RedditFactorValue {
  value: number | null;
  /** Обоснование оператора; у `policy_risk` — null (см. `reasons`). */
  why: string | null;
  /** Только `policy_risk`: коды обоснования из снимка правил. */
  reasons?: RedditPolicyRiskReason[];
}
export type RedditFactors = Record<RedditScoreFactor, RedditFactorValue>;
export type RedditFactorsInput = Partial<
  Record<RedditOperatorFactor, { value: number | null; why?: string | null }>
>;
export interface RedditScoreView {
  scoreVersion: 'v1';
  relevance: number | null;
  risk: number | null;
  priority: number | null;
  missing: RedditScoreFactor[];
}
export interface RedditOpportunityView {
  id: string;
  projectId: string;
  communityId: string;
  subreddit: string;
  threadUrl: string;
  threadKey: string;
  titleManual: string;
  excerpt: {
    sourceId: string;
    text: string;
    injectionFlag: string | null;
    usage: (typeof SOURCE_USAGES_R)[number];
  } | null;
  intent: RedditIntent;
  angle: string | null;
  keywordIds: string[];
  factors: RedditFactors;
  score: RedditScoreView;
  ruleSnapshotId: string | null;
  ruleSnapshotVersion: number | null;
  policy: RedditPolicyVerdict;
  policyReasons: RedditPolicyReason[];
  /** Гейт СЕЙЧАС (по текущему снимку, считается при чтении); `policy` — на момент оценки. */
  policyNow: RedditPolicyVerdict;
  policyNowReasons: RedditPolicyReason[];
  status: RedditOpportunityStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Доказательство Reddit (выдержка треда, первоисточник правил) для отзыва:
 * `GET …/opportunities/:id/excerpts`, `GET …/communities/:id/rules/:sid/source`
 * — при любом статусе; отозванные не скрываются. Текст — только текстом.
 */
export interface RedditEvidenceView {
  sourceId: string;
  revision: number;
  supersedesId: string | null;
  current: boolean;
  url: string;
  fragment: string;
  injectionFlag: string | null;
  usage: (typeof SOURCE_USAGES_R)[number];
  revokedAt: string | null;
  revokeReason: string | null;
  createdAt: string;
  createdBy: string;
}
export interface RedditExcerptsView {
  opportunityId: string;
  currentSourceId: string | null;
  items: RedditEvidenceView[];
}
export interface RedditRulesSourceView {
  snapshotId: string;
  communityId: string;
  version: number;
  status: RedditSnapshotStatus;
  source: RedditEvidenceView;
}

// ── Тела мутаций (без `opKey` — его кладёт `PublisherHttp`) ───────────────

export interface CreateRedditProjectIn {
  title: string;
  locale: string;
  market: string;
}
export interface PatchRedditProjectIn {
  expectedRevision: number;
  title?: string;
  locale?: string;
  market?: string;
}
export interface CreateRedditCommunityIn {
  projectId: string;
  community: string;
  descriptionManual?: string | null;
  language?: string | null;
  topics?: string[];
}
export interface PatchRedditCommunityIn {
  expectedRevision: number;
  descriptionManual?: string | null;
  language?: string | null;
  topics?: string[];
  status?: RedditCommunityStatus;
}
export interface CreateRedditRulesIn {
  sourceUrl: string;
  sourceExcerpt: string;
  promotionPolicy: RedditPromotionPolicy;
  linksPolicy: RedditLinksPolicy;
  flairRequired?: boolean | null;
  conditions?: string[];
  checkedAt: string;
}
export interface CreateRedditKeywordIn {
  projectId: string;
  phrase: string;
  intent: RedditIntent;
  locale?: string | null;
  priority: number;
}
export interface PatchRedditKeywordIn {
  expectedRevision: number;
  phrase?: string;
  intent?: RedditIntent;
  locale?: string | null;
  priority?: number;
  status?: RedditKeywordStatus;
}
export interface CreateRedditOpportunityIn {
  projectId: string;
  communityId: string;
  threadUrl: string;
  titleManual: string;
  excerpt?: string | null;
  intent: RedditIntent;
  angle?: string | null;
  keywordIds?: string[];
  factors?: RedditFactorsInput;
}
export interface PatchRedditOpportunityIn {
  expectedRevision: number;
  /** Новая редакция выдержки; `null` — отвязать (у отозванной — 409). */
  excerpt?: string | null;
  titleManual?: string;
  intent?: RedditIntent;
  angle?: string | null;
  keywordIds?: string[];
  factors?: RedditFactorsInput;
}
export interface RedditTransitionIn {
  expectedRevision: number;
  reason?: string;
}
export type RedditTransition = 'qualify' | 'skip' | 'archive';

export interface RedditListFilter {
  before?: string;
  limit?: number;
  status?: string;
  projectId?: string;
  communityId?: string;
  q?: string;
  /** Только возможности: фильтр по живому гейту. */
  policyNow?: RedditPolicyVerdict | '';
}

// ── Декодеры ──────────────────────────────────────────────────────────────

export function decodeGate(v: unknown, where = 'gate'): RedditGateView {
  const o = obj(v, where);
  return {
    verdict: choice(o.verdict, REDDIT_POLICY_VERDICTS, `${where}.verdict`),
    reasons: arr(o.reasons, `${where}.reasons`).map((x) =>
      choice(x, REDDIT_POLICY_REASONS, `${where}.reasons`)
    ),
    warnings: arr(o.warnings, `${where}.warnings`).map((x) =>
      choice(x, REDDIT_POLICY_WARNINGS, `${where}.warnings`)
    ),
  };
}

export function decodeRedditProject(v: unknown): RedditProjectView {
  const o = obj(v, 'redditProject');
  return {
    id: str(o.id, 'project.id'),
    title: str(o.title, 'project.title'),
    locale: str(o.locale, 'project.locale'),
    market: str(o.market, 'project.market'),
    status: choice(o.status, REDDIT_PROJECT_STATUSES, 'project.status'),
    revision: int(o.revision, 'project.revision'),
    createdAt: iso(o.createdAt, 'project.createdAt'),
    updatedAt: iso(o.updatedAt, 'project.updatedAt'),
  };
}

export function decodeRulesSummary(v: unknown): RedditRulesSummary {
  const o = obj(v, 'rulesSummary');
  return {
    snapshotId: str(o.snapshotId, 'rules.snapshotId'),
    version: int(o.version, 'rules.version'),
    state: choice(o.state, REDDIT_SNAPSHOT_STATES, 'rules.state'),
    reviewState: choice(o.reviewState, REDDIT_REVIEW_STATES, 'rules.review'),
    checkedAt: iso(o.checkedAt, 'rules.checkedAt'),
    reviewedAt: isoN(o.reviewedAt, 'rules.reviewedAt'),
    selfReview: bool(o.selfReview, 'rules.selfReview'),
    promotionPolicy: choice(
      o.promotionPolicy,
      REDDIT_PROMOTION_POLICIES,
      'rules.promotionPolicy'
    ),
    linksPolicy: choice(o.linksPolicy, REDDIT_LINKS_POLICIES, 'rules.links'),
    gate: decodeGate(o.gate, 'rules.gate'),
  };
}

export function decodeRedditCommunity(v: unknown): RedditCommunityView {
  const o = obj(v, 'redditCommunity');
  return {
    id: str(o.id, 'community.id'),
    projectId: str(o.projectId, 'community.projectId'),
    channelId: str(o.channelId, 'community.channelId'),
    subreddit: str(o.subreddit, 'community.subreddit'),
    canonicalUrl: str(o.canonicalUrl, 'community.canonicalUrl'),
    descriptionManual: strN(o.descriptionManual, 'community.description'),
    language: strN(o.language, 'community.language'),
    topics: strList(o.topics, 'community.topics'),
    status: choice(o.status, REDDIT_COMMUNITY_STATUSES, 'community.status'),
    rules: o.rules === null ? null : decodeRulesSummary(o.rules),
    staleDays: int(o.staleDays, 'community.staleDays'),
    revision: int(o.revision, 'community.revision'),
    createdAt: iso(o.createdAt, 'community.createdAt'),
    updatedAt: iso(o.updatedAt, 'community.updatedAt'),
  };
}

export function decodeRuleSnapshot(v: unknown): RedditRuleSnapshotView {
  const o = obj(v, 'redditRules');
  const s = obj(o.source, 'rules.source');
  return {
    id: str(o.id, 'rules.id'),
    communityId: str(o.communityId, 'rules.communityId'),
    version: int(o.version, 'rules.version'),
    source: {
      id: str(s.id, 'rules.source.id'),
      url: str(s.url, 'rules.source.url'),
      excerpt: str(s.excerpt, 'rules.source.excerpt'),
      injectionFlag: strN(s.injectionFlag, 'rules.source.injectionFlag'),
      usage: choice(s.usage, SOURCE_USAGES_R, 'rules.source.usage'),
    },
    promotionPolicy: choice(
      o.promotionPolicy,
      REDDIT_PROMOTION_POLICIES,
      'rules.promotionPolicy'
    ),
    linksPolicy: choice(o.linksPolicy, REDDIT_LINKS_POLICIES, 'rules.links'),
    flairRequired:
      o.flairRequired === null ? null : bool(o.flairRequired, 'rules.flair'),
    conditions: strList(o.conditions, 'rules.conditions'),
    checkedAt: iso(o.checkedAt, 'rules.checkedAt'),
    reviewState: choice(o.reviewState, REDDIT_REVIEW_STATES, 'rules.review'),
    state: choice(o.state, REDDIT_SNAPSHOT_STATES, 'rules.state'),
    createdBy: str(o.createdBy, 'rules.createdBy'),
    reviewedBy: strN(o.reviewedBy, 'rules.reviewedBy'),
    reviewedAt: isoN(o.reviewedAt, 'rules.reviewedAt'),
    selfReview: bool(o.selfReview, 'rules.selfReview'),
    status: choice(o.status, REDDIT_SNAPSHOT_STATUSES, 'rules.status'),
    gate: decodeGate(o.gate, 'rules.gate'),
    createdAt: iso(o.createdAt, 'rules.createdAt'),
  };
}

export function decodeRedditKeyword(v: unknown): RedditKeywordView {
  const o = obj(v, 'redditKeyword');
  return {
    id: str(o.id, 'keyword.id'),
    projectId: str(o.projectId, 'keyword.projectId'),
    phrase: str(o.phrase, 'keyword.phrase'),
    phraseNorm: str(o.phraseNorm, 'keyword.phraseNorm'),
    intent: choice(o.intent, REDDIT_INTENTS, 'keyword.intent'),
    locale: strN(o.locale, 'keyword.locale'),
    priority: int(o.priority, 'keyword.priority'),
    status: choice(o.status, REDDIT_KEYWORD_STATUSES, 'keyword.status'),
    revision: int(o.revision, 'keyword.revision'),
    createdAt: iso(o.createdAt, 'keyword.createdAt'),
    updatedAt: iso(o.updatedAt, 'keyword.updatedAt'),
  };
}

/** Фактор 0..100 или null (не 0): иное — ошибка формы. */
function factorValue(v: unknown, where: string): number | null {
  const n = intN(v, where);
  if (n !== null && (n < 0 || n > 100)) bad(`${where}:range`);
  return n;
}

export function decodeFactors(v: unknown): RedditFactors {
  const o = obj(v, 'factors');
  const out = {} as RedditFactors;
  for (const k of REDDIT_SCORE_FACTORS) {
    const f = obj(o[k], `factors.${k}`);
    out[k] = {
      value: factorValue(f.value, `factors.${k}.value`),
      why: strN(f.why, `factors.${k}.why`),
    };
    if (k === 'policy_risk') {
      // Машинное обоснование — коды, не текст (раунд исправлений P-R).
      if (out[k].why !== null) bad('factors.policy_risk.why');
      out[k].reasons = arr(f.reasons, 'factors.policy_risk.reasons').map((x) =>
        choice(x, REDDIT_POLICY_RISK_REASONS, 'factors.policy_risk.reasons')
      );
    } else if (f.reasons !== undefined) {
      bad(`factors.${k}.reasons`);
    }
  }
  for (const k of Object.keys(o)) {
    if (!(REDDIT_SCORE_FACTORS as readonly string[]).includes(k)) {
      bad(`factors.${k}:unknown`);
    }
  }
  return out;
}

export function decodeScore(v: unknown): RedditScoreView {
  const o = obj(v, 'score');
  return {
    scoreVersion: choice(o.scoreVersion, ['v1'] as const, 'score.version'),
    relevance: factorValue(o.relevance, 'score.relevance'),
    risk: factorValue(o.risk, 'score.risk'),
    priority: factorValue(o.priority, 'score.priority'),
    missing: arr(o.missing, 'score.missing').map((x) =>
      choice(x, REDDIT_SCORE_FACTORS, 'score.missing')
    ),
  };
}

export function decodeRedditOpportunity(v: unknown): RedditOpportunityView {
  const o = obj(v, 'redditOpportunity');
  let excerpt: RedditOpportunityView['excerpt'] = null;
  if (o.excerpt !== null) {
    const e = obj(o.excerpt, 'opportunity.excerpt');
    excerpt = {
      sourceId: str(e.sourceId, 'excerpt.sourceId'),
      text: str(e.text, 'excerpt.text'),
      injectionFlag: strN(e.injectionFlag, 'excerpt.injectionFlag'),
      usage: choice(e.usage, SOURCE_USAGES_R, 'excerpt.usage'),
    };
  }
  return {
    id: str(o.id, 'opportunity.id'),
    projectId: str(o.projectId, 'opportunity.projectId'),
    communityId: str(o.communityId, 'opportunity.communityId'),
    subreddit: str(o.subreddit, 'opportunity.subreddit'),
    threadUrl: str(o.threadUrl, 'opportunity.threadUrl'),
    threadKey: str(o.threadKey, 'opportunity.threadKey'),
    titleManual: str(o.titleManual, 'opportunity.titleManual'),
    excerpt,
    intent: choice(o.intent, REDDIT_INTENTS, 'opportunity.intent'),
    angle: strN(o.angle, 'opportunity.angle'),
    keywordIds: strList(o.keywordIds, 'opportunity.keywordIds'),
    factors: decodeFactors(o.factors),
    score: decodeScore(o.score),
    ruleSnapshotId: strN(o.ruleSnapshotId, 'opportunity.ruleSnapshotId'),
    ruleSnapshotVersion: intN(o.ruleSnapshotVersion, 'opportunity.ruleVer'),
    policy: choice(o.policy, REDDIT_POLICY_VERDICTS, 'opportunity.policy'),
    policyReasons: arr(o.policyReasons, 'opportunity.policyReasons').map((x) =>
      choice(x, REDDIT_POLICY_REASONS, 'opportunity.policyReasons')
    ),
    policyNow: choice(
      o.policyNow,
      REDDIT_POLICY_VERDICTS,
      'opportunity.policyNow'
    ),
    policyNowReasons: arr(o.policyNowReasons, 'opportunity.policyNowRe').map(
      (x) => choice(x, REDDIT_POLICY_REASONS, 'opportunity.policyNowReasons')
    ),
    status: choice(o.status, REDDIT_OPPORTUNITY_STATUSES, 'opportunity.status'),
    revision: int(o.revision, 'opportunity.revision'),
    createdAt: iso(o.createdAt, 'opportunity.createdAt'),
    updatedAt: iso(o.updatedAt, 'opportunity.updatedAt'),
  };
}

export function decodeEvidence(v: unknown): RedditEvidenceView {
  const o = obj(v, 'evidence');
  return {
    sourceId: str(o.sourceId, 'evidence.sourceId'),
    revision: int(o.revision, 'evidence.revision'),
    supersedesId: strN(o.supersedesId, 'evidence.supersedesId'),
    current: bool(o.current, 'evidence.current'),
    url: str(o.url, 'evidence.url'),
    fragment: str(o.fragment, 'evidence.fragment'),
    injectionFlag: strN(o.injectionFlag, 'evidence.injectionFlag'),
    usage: choice(o.usage, SOURCE_USAGES_R, 'evidence.usage'),
    revokedAt: isoN(o.revokedAt, 'evidence.revokedAt'),
    revokeReason: strN(o.revokeReason, 'evidence.revokeReason'),
    createdAt: iso(o.createdAt, 'evidence.createdAt'),
    createdBy: str(o.createdBy, 'evidence.createdBy'),
  };
}

export function decodeExcerpts(v: unknown): RedditExcerptsView {
  const o = obj(v, 'excerpts');
  return {
    opportunityId: str(o.opportunityId, 'excerpts.opportunityId'),
    currentSourceId: strN(o.currentSourceId, 'excerpts.currentSourceId'),
    items: arr(o.items, 'excerpts.items').map(decodeEvidence),
  };
}

export function decodeRulesSource(v: unknown): RedditRulesSourceView {
  const o = obj(v, 'rulesSource');
  return {
    snapshotId: str(o.snapshotId, 'rulesSource.snapshotId'),
    communityId: str(o.communityId, 'rulesSource.communityId'),
    version: int(o.version, 'rulesSource.version'),
    status: choice(o.status, REDDIT_SNAPSHOT_STATUSES, 'rulesSource.status'),
    source: decodeEvidence(o.source),
  };
}

// ── Клиент ────────────────────────────────────────────────────────────────

/** Фильтр списка → query (`limit` 1..100; пустые значения не уходят). */
export function listQuery(f: RedditListFilter = {}): Query {
  const q: Query = {};
  if (f.before) q.before = f.before;
  if (f.limit !== undefined) q.limit = Math.max(1, Math.min(100, f.limit));
  if (f.status) q.status = f.status;
  if (f.projectId) q.projectId = f.projectId;
  if (f.communityId) q.communityId = f.communityId;
  if (f.policyNow) q.policyNow = f.policyNow;
  const term = (f.q ?? '').trim();
  if (term) q.q = term.slice(0, 200);
  return q;
}

/** Путь списка для CSV (`?format=csv` добавляет `PublisherHttp.csv`). */
export function redditListPath(pid: string, list: RedditList): string {
  return `${productPath(pid)}/reddit/${list}`;
}

export function createRedditApi(http: PublisherHttp, pid: string) {
  const R = `${productPath(pid)}/reddit`;
  const { get, post, patch } = verbs(http);
  return {
    // Проекты
    projects: async (
      f?: RedditListFilter
    ): Promise<ListPage<RedditProjectView>> =>
      page(await get(`${R}/projects`, listQuery(f)), decodeRedditProject),
    project: async (id: string) =>
      decodeRedditProject(await get(`${R}/projects/${seg(id)}`)),
    createProject: async (opKey: string, body: CreateRedditProjectIn) =>
      decodeRedditProject(await post(`${R}/projects`, { ...body }, opKey)),
    patchProject: async (
      id: string,
      opKey: string,
      body: PatchRedditProjectIn
    ) =>
      decodeRedditProject(
        await patch(`${R}/projects/${seg(id)}`, { ...body }, opKey)
      ),
    archiveProject: async (
      id: string,
      opKey: string,
      expectedRevision: number
    ) =>
      decodeRedditProject(
        await post(
          `${R}/projects/${seg(id)}/archive`,
          { expectedRevision },
          opKey
        )
      ),

    // Сообщества
    communities: async (
      f?: RedditListFilter
    ): Promise<ListPage<RedditCommunityView>> =>
      page(await get(`${R}/communities`, listQuery(f)), decodeRedditCommunity),
    community: async (id: string) =>
      decodeRedditCommunity(await get(`${R}/communities/${seg(id)}`)),
    createCommunity: async (opKey: string, body: CreateRedditCommunityIn) =>
      decodeRedditCommunity(await post(`${R}/communities`, { ...body }, opKey)),
    patchCommunity: async (
      id: string,
      opKey: string,
      body: PatchRedditCommunityIn
    ) =>
      decodeRedditCommunity(
        await patch(`${R}/communities/${seg(id)}`, { ...body }, opKey)
      ),

    // Правила
    rules: async (
      communityId: string
    ): Promise<ListPage<RedditRuleSnapshotView>> =>
      page(
        await get(`${R}/communities/${seg(communityId)}/rules`),
        decodeRuleSnapshot
      ),
    createRules: async (
      communityId: string,
      opKey: string,
      body: CreateRedditRulesIn
    ) =>
      decodeRuleSnapshot(
        await post(
          `${R}/communities/${seg(communityId)}/rules`,
          { ...body },
          opKey
        )
      ),
    rulesSource: async (communityId: string, snapshotId: string) =>
      decodeRulesSource(
        await get(
          `${R}/communities/${seg(communityId)}/rules/${seg(snapshotId)}/source`
        )
      ),
    reviewRules: async (snapshotId: string, opKey: string) =>
      decodeRuleSnapshot(
        await post(`${R}/rules/${seg(snapshotId)}/review`, {}, opKey)
      ),

    // Возможности
    opportunities: async (
      f?: RedditListFilter
    ): Promise<ListPage<RedditOpportunityView>> =>
      page(
        await get(`${R}/opportunities`, listQuery(f)),
        decodeRedditOpportunity
      ),
    opportunity: async (id: string) =>
      decodeRedditOpportunity(await get(`${R}/opportunities/${seg(id)}`)),
    excerpts: async (id: string) =>
      decodeExcerpts(await get(`${R}/opportunities/${seg(id)}/excerpts`)),
    createOpportunity: async (opKey: string, body: CreateRedditOpportunityIn) =>
      decodeRedditOpportunity(
        await post(`${R}/opportunities`, { ...body }, opKey)
      ),
    patchOpportunity: async (
      id: string,
      opKey: string,
      body: PatchRedditOpportunityIn
    ) =>
      decodeRedditOpportunity(
        await patch(`${R}/opportunities/${seg(id)}`, { ...body }, opKey)
      ),
    scoreOpportunity: async (
      id: string,
      opKey: string,
      expectedRevision: number
    ) =>
      decodeRedditOpportunity(
        await post(
          `${R}/opportunities/${seg(id)}/score`,
          { expectedRevision },
          opKey
        )
      ),
    transitionOpportunity: async (
      id: string,
      to: RedditTransition,
      opKey: string,
      body: RedditTransitionIn
    ) =>
      decodeRedditOpportunity(
        await post(
          `${R}/opportunities/${seg(id)}/${seg(to)}`,
          {
            expectedRevision: body.expectedRevision,
            ...(body.reason && body.reason.trim()
              ? { reason: body.reason.trim() }
              : {}),
          },
          opKey
        )
      ),

    // Ключевые запросы
    keywords: async (
      f?: RedditListFilter
    ): Promise<ListPage<RedditKeywordView>> =>
      page(await get(`${R}/keywords`, listQuery(f)), decodeRedditKeyword),
    createKeyword: async (opKey: string, body: CreateRedditKeywordIn) =>
      decodeRedditKeyword(await post(`${R}/keywords`, { ...body }, opKey)),
    patchKeyword: async (
      id: string,
      opKey: string,
      body: PatchRedditKeywordIn
    ) =>
      decodeRedditKeyword(
        await patch(`${R}/keywords/${seg(id)}`, { ...body }, opKey)
      ),
  };
}
export type RedditApi = ReturnType<typeof createRedditApi>;
