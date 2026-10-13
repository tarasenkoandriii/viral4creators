/**
 * AI Publisher (P-G1) — закрытые списки, которые показывает экран
 * (зеркало `sites-backend/src/modules/publisher/contracts/states.ts`,
 * `parameters.ts`, `ai.ts`). `scripts/publisher-api.test.ts` сверяет
 * каждый список с исходником сервера: новое значение на сервере без
 * перевода здесь роняет тест, а не экран.
 *
 * Чистый модуль (общий с P-G2).
 */

export const PRODUCT_KINDS = ['working', 'test', 'eval', 'restored'] as const;
export type ProductKind = (typeof PRODUCT_KINDS)[number];
export const PRODUCT_MODES = ['closed', 'test', 'live'] as const;
export type ProductMode = (typeof PRODUCT_MODES)[number];
export const PRODUCT_STATUSES = ['active', 'archived'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export const PARAMETER_STATUSES = [
  'assumption',
  'approved',
  'rejected',
  'revoked',
] as const;
export type ParameterStatus = (typeof PARAMETER_STATUSES)[number];
/** Предложение параметра (`pub_parameter_proposals.status`). */
export const PROPOSAL_STATUSES = [
  'open',
  'accepted',
  'rejected',
  'withdrawn',
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];
export const DEPENDENT_STAGES = [
  'public_publish',
  'real_leads',
  'spend',
  'purchases',
  'ai_use',
  'reports',
] as const;
export type DependentStage = (typeof DEPENDENT_STAGES)[number];

export const GATE_NAMES = [
  'public_publish',
  'real_leads',
  'spend',
  'purchases',
  'ai_use',
] as const;
export type GateName = (typeof GATE_NAMES)[number];
export const GATE_MISSING_KINDS = [
  'parameter',
  'host',
  'integration',
  'evidence',
  'observation',
  'reconcile',
  'ai_config',
  'report_decision',
  'product',
  'budget',
] as const;
export type GateMissingKind = (typeof GATE_MISSING_KINDS)[number];

export const REVIEW_REASONS = [
  'offer_changed',
  'fact_changed',
  'source_revoked',
  'claim_changed',
  'fact_conflict',
  'stale_check',
  'retention_review',
  'approval_expired',
  'member_removed',
  'publication_unverified',
  'form_after_t72',
  'report_late_decision',
  'other',
] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];
export const REVIEW_SEVERITIES = ['critical', 'normal'] as const;
export const REVIEW_STATUSES = ['open', 'resolved', 'dismissed'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const SOURCE_KINDS = [
  'url',
  'interview',
  'customer_question',
  'discussion',
  'search_data',
  'document',
  'manual_text',
  'experiment_record',
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export const SOURCE_USAGES = ['allowed', 'restricted', 'revoked'] as const;
export type SourceUsage = (typeof SOURCE_USAGES)[number];
export const SOURCE_VISIBILITIES = ['public', 'private'] as const;
export type SourceVisibility = (typeof SOURCE_VISIBILITIES)[number];
export const SOURCE_FRESHNESS = ['current', 'stale', 'unknown'] as const;
export const SOURCE_IMPORTED_VIA = ['manual', 'url_import'] as const;

export const QUESTION_STAGES = [
  'awareness',
  'consideration',
  'decision',
  'unknown',
] as const;
export type QuestionStage = (typeof QUESTION_STAGES)[number];
export const QUESTION_GROUP_STATUSES = [
  'proposed',
  'confirmed',
  'split',
  'rejected',
] as const;
export const QUESTION_STATUSES = ['candidate', 'selected', 'rejected'] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];
export const QUESTION_SCORE_KEYS = [
  'offer_fit',
  'confirmed_task',
  'own_answer',
  'cost',
] as const;
export type ScoreKey = (typeof QUESTION_SCORE_KEYS)[number];

export const BRAND_FACT_KINDS = [
  'fact',
  'price',
  'condition',
  'example',
  'case',
  'contact',
  'tone',
  'limitation',
  'forbidden_promise',
  'faq',
] as const;
export type BrandFactKind = (typeof BRAND_FACT_KINDS)[number];
export const BRAND_FACT_STATUSES = [
  'draft',
  'active',
  'superseded',
  'needs_resolution',
  'rejected',
] as const;
export type BrandFactStatus = (typeof BRAND_FACT_STATUSES)[number];
export const OFFER_STATUSES = [
  'draft',
  'active',
  'superseded',
  'historical',
] as const;
export const BRIEF_FORMATS = [
  'instruction',
  'case_review',
  'choice_guide',
] as const;
export type BriefFormat = (typeof BRIEF_FORMATS)[number];
export const BRIEF_STATUSES = ['draft', 'ready', 'rejected'] as const;
export const BRIEF_MISSING = [
  'own_contribution',
  'cta',
  'cta_intent_note',
  'allowed_source',
  'offer_active',
] as const;

export const CONTENT_KINDS = [
  'article',
  'post',
  'cards',
  'checklist',
  'video_script',
] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];
export const ADAPTATION_KINDS = [
  'post',
  'cards',
  'checklist',
  'video_script',
] as const;
export type AdaptationKind = (typeof ADAPTATION_KINDS)[number];
export const CONTENT_STATUSES = [
  'brief',
  'drafting',
  'editorial_review',
  'changes_requested',
  'approved',
  'scheduled',
  'published',
  'correction_required',
  'revised',
  'withdrawn',
] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];
export const VERSION_STATUSES = [
  'draft',
  'submitted',
  'changes_requested',
  'approved',
  'rejected',
  'superseded',
] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];

export const CLAIM_TYPES = [
  'fact',
  'estimate',
  'hypothesis',
  'example',
] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];
export const CLAIM_RISKS = ['critical', 'high', 'normal'] as const;
export type ClaimRisk = (typeof CLAIM_RISKS)[number];
export const CLAIM_STATUSES = [
  'unverified',
  'supported',
  'unsupported',
  'unknown',
  'needs_review',
] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];
export const CLAIM_SUPPORTS = ['yes', 'no', 'partial', 'unknown'] as const;
export type ClaimSupports = (typeof CLAIM_SUPPORTS)[number];
export const QA_CHECK_KINDS = [
  'editorial',
  'technical',
  'ai_review',
  'adaptation_meaning',
] as const;
export type QaCheckKind = (typeof QA_CHECK_KINDS)[number];
export const QA_RESULTS = ['pass', 'fail', 'unknown'] as const;
export type QaResult = (typeof QA_RESULTS)[number];
export const APPROVAL_STATUSES = [
  'active',
  'revoked',
  'expired',
  'superseded',
  'consumed',
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
export const APPROVAL_BLOCKER_CODES = [
  'qa_editorial_missing',
  'qa_technical_missing',
  'qa_adaptation_meaning_missing',
  'qa_blocker',
  'claim_not_supported',
  'claim_unsupported',
  'source_not_allowed',
  'offer_inactive',
  'change_task_open',
  'parent_not_approved',
] as const;

export const CHANNEL_KINDS = [
  'own',
  'community',
  'paid_venue',
  'site',
] as const;
export const CHANNEL_STATUSES = ['available', 'unavailable'] as const;
export const DISTRIBUTION_STATUSES = [
  'planned',
  'blocked',
  'done',
  'cancelled',
] as const;
export type DistributionStatus = (typeof DISTRIBUTION_STATUSES)[number];
export const DISTRIBUTION_BLOCK_REASONS = [
  'ads_not_allowed',
  'channel_unavailable',
  'content_stale',
  'source',
  'approval',
  'access',
  'measurement',
  'budget',
  'vendor',
  'no_venue',
  'other',
] as const;
export type DistributionBlockReason =
  (typeof DISTRIBUTION_BLOCK_REASONS)[number];
export const PUBLICATION_STAGES = ['test', 'live'] as const;
export const PUBLICATION_STATUSES = [
  'pending',
  'published',
  'replaced',
  'failed',
  'withdrawn',
] as const;
export const PUBLICATION_VERIFY_STATUSES = [
  'not_checked',
  'ok',
  'mismatch',
  'unreachable',
] as const;

export const GENERATOR_IDS = [
  'pub.helper.answer',
  'pub.brief.draft',
  'pub.qa.review',
  'pub.adaptation.make',
  'pub.questions.cluster',
  'pub.draft.write',
  'pub.claims.extract',
  'pub.distribution.plan',
  'pub.venues.compare',
] as const;
export type GeneratorId = (typeof GENERATOR_IDS)[number];
/** Допуск P0 (ДТ-2): остальные пять — `PUB_AI_DISABLED`, ручной путь. */
export const P0_ENABLED_GENERATORS = [
  'pub.helper.answer',
  'pub.brief.draft',
  'pub.qa.review',
  'pub.adaptation.make',
] as const;
export const AI_TASK_STATUSES = ['open', 'done', 'needs_human'] as const;
export type AiTaskStatus = (typeof AI_TASK_STATUSES)[number];
export const AI_CALL_STATUSES = [
  'running',
  'ok',
  'schema_invalid',
  'refused',
  'timeout',
  'unavailable',
  'empty',
  'truncated',
  'budget_blocked',
  'unpriced_blocked',
  'not_evaluated',
  'disabled',
] as const;
export type AiCallStatus = (typeof AI_CALL_STATUSES)[number];
export const AI_COST_STATUSES = ['priced', 'unpriced', 'unknown'] as const;
export type AiCostStatus = (typeof AI_COST_STATUSES)[number];
export const AI_EVAL_STATUSES = [
  'not_run',
  'passed',
  'failed',
  'blocked',
] as const;

export const PARAMETER_KEYS = [
  'niche',
  'language',
  'market',
  'offer_active_version',
  'own_channels',
  'domain_host',
  'hosting',
  'attribution_tool',
  'consent_map',
  'analytics_storage',
  'event_map',
  'perf_targets',
  'data_notice_version',
  'retention_policy',
  'budget_total',
  'budget_split',
  'per_purchase_max',
  'ai_budget_usd_month',
  'ai_fx_rate',
  'ai_unpriced_allowed',
  'rates_by_role',
  'allowed_cpl_inputs',
  'investment_cpl_limit',
  'dev_investment',
  'cac_payment_window',
  'd42_thresholds',
  'd90_thresholds',
  'late_cohort_rules',
  'qualification_rules',
  'responsibles',
  'sales_hours_t42_t72',
  'contact_sla',
  'form_limit',
  'alt_contact',
  'test_hosts',
  'pilot_calendar',
  'launch_evidence_d0',
  'launch_evidence_purchase',
  // P-R Reddit: срок свежести проверки правил сообщества (`{days}`, 1..365).
  'reddit_rules_stale_days',
] as const;
export type ParameterKey = (typeof PARAMETER_KEYS)[number];

/**
 * Группы экрана «Запуск» (§14.1: «параметры по группам, включая карту
 * событий и целевое время ответа»). Тест: группы покрывают все ключи ровно
 * по одному разу.
 */
export const PARAMETER_GROUPS = {
  product: [
    'niche',
    'language',
    'market',
    'offer_active_version',
    'own_channels',
    'reddit_rules_stale_days',
  ],
  site: [
    'domain_host',
    'hosting',
    'test_hosts',
    'data_notice_version',
    'consent_map',
    'analytics_storage',
  ],
  measurement: ['event_map', 'attribution_tool', 'perf_targets'],
  leads: [
    'qualification_rules',
    'responsibles',
    'sales_hours_t42_t72',
    'contact_sla',
    'form_limit',
    'alt_contact',
    'retention_policy',
  ],
  budget: [
    'budget_total',
    'budget_split',
    'per_purchase_max',
    'rates_by_role',
    'allowed_cpl_inputs',
    'investment_cpl_limit',
    'dev_investment',
    'cac_payment_window',
  ],
  ai: ['ai_budget_usd_month', 'ai_fx_rate', 'ai_unpriced_allowed'],
  pilot: [
    'pilot_calendar',
    'd42_thresholds',
    'd90_thresholds',
    'late_cohort_rules',
    'launch_evidence_d0',
    'launch_evidence_purchase',
  ],
} as const satisfies Record<string, readonly ParameterKey[]>;
export type ParameterGroup = keyof typeof PARAMETER_GROUPS;

export function isOneOf<T extends string>(
  list: readonly T[],
  v: unknown
): v is T {
  return typeof v === 'string' && (list as readonly string[]).includes(v);
}
