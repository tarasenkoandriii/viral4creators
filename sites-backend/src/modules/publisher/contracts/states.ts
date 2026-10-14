/**
 * AI Publisher — закрытые списки (контракт P-A1, проектный документ §6.9,
 * §7). Источник правды для значений — триггеры `pub_<таблица>_guard`
 * миграции `20261016090000_publisher_core` (P-A0) и следующих миграций
 * Publisher (`…_publisher_reddit` и `…_publisher_reddit_m2` — P-R: списки
 * Reddit, `pub_object_types()`, действия аудита, виды материалов и QA): каждый список здесь дословно равен списку триггера
 * (тест `states.spec.ts` собирает действующий SQL миграций и сверяет). Значение вне списка база отвергает SQLSTATE
 * 23514 с текстом `<таблица>.<поле>: вне списка`.
 *
 * Чистый модуль: ни Nest, ни базы — его берут публичный код
 * (`publisher/public/**`), assist (декодеры) и publisher-site.
 */

import { GENERATOR_IDS } from './ai';
import { PARAMETER_KEYS } from './parameters';

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
export const PROPOSAL_STATUSES = [
  'open',
  'accepted',
  'rejected',
  'withdrawn',
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];
/** Этапы, которые затрагивает решение по параметру (`dependentStages`). */
export const DEPENDENT_STAGES = [
  'public_publish',
  'real_leads',
  'spend',
  'purchases',
  'ai_use',
  'reports',
  // P-R M2 (миграция …_publisher_reddit_m2): гейт копирования Reddit-текста.
  'reddit_publish',
] as const;
export type DependentStage = (typeof DEPENDENT_STAGES)[number];

export const PUB_ROLES = [
  'product_owner',
  'editor',
  'operator',
  'analyst',
  'sales',
  'viewer',
] as const;
export type PubRole = (typeof PUB_ROLES)[number];

/** Имена сущностей журнала аудита, задач проверки, согласований (`objectType`). */
export const OBJECT_TYPES = [
  'product',
  'parameter',
  'parameter_proposal',
  'parameter_decision',
  'role_grant',
  'member',
  'review_task',
  'integration',
  'campaign',
  'source',
  'question_group',
  'question',
  'brand_fact',
  'offer_version',
  'brief',
  'content',
  'content_version',
  'claim',
  'qa_check',
  'approval',
  'channel',
  'distribution_action',
  'publication',
  'venue',
  'placement',
  'budget_limit',
  'reserve_move',
  'expense',
  'expense_entry',
  'time_entry',
  'prospect',
  'lead',
  'lead_contact',
  'lead_decision',
  'payment',
  'notification',
  'queue_check',
  'session',
  'event',
  'metric_import',
  'experiment',
  'report',
  'backup',
  'restore',
  'ai_config',
  'ai_config_binding',
  'ai_task',
  'ai_call',
  'ai_budget_month',
  'ai_eval_run',
  'ai_eval_result',
  // P-R Reddit Manual MVP (миграция …_publisher_reddit, Р-RD-0).
  'reddit_project',
  'reddit_community',
  'reddit_rule_snapshot',
  'reddit_keyword',
  'reddit_opportunity',
  'reddit_brief',
] as const;
export type ObjectType = (typeof OBJECT_TYPES)[number];

export const AUDIT_ACTIONS = [
  'create',
  'update',
  'transition',
  'approve',
  'reject',
  'revoke',
  'grant',
  'reveal_contact',
  'export',
  'erase',
  'restore',
  'backup',
  'import',
  'merge',
  'split',
  'assign',
  'bind',
  'unbind',
  'resolve',
  'dismiss',
  'retry',
  'reset',
  // P-R: копирование утверждённого текста и отчёт о ручной публикации (M2).
  'copy',
  'report_publication',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

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
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];
export const REVIEW_STATUSES = ['open', 'resolved', 'dismissed'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const INTEGRATION_KINDS = [
  'events_collector',
  'web_analytics',
  'search_console',
  'crm_registry',
  'ai_provider',
  'cms',
] as const;
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];
export const INTEGRATION_STATUSES = [
  'connected',
  'degraded',
  'disconnected',
] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

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
export const SOURCE_USAGES = ['allowed', 'restricted', 'revoked'] as const;
export type SourceUsage = (typeof SOURCE_USAGES)[number];
export const SOURCE_VISIBILITIES = ['public', 'private'] as const;
export const SOURCE_FRESHNESS = ['current', 'stale', 'unknown'] as const;
export const SOURCE_IMPORTED_VIA = ['manual', 'url_import'] as const;
/** Происхождение (P-R, `…_publisher_reddit`): `reddit` — доказательство Reddit. */
export const SOURCE_ORIGINS = ['content', 'reddit'] as const;

export const QUESTION_STAGES = [
  'awareness',
  'consideration',
  'decision',
  'unknown',
] as const;
export const QUESTION_GROUP_STATUSES = [
  'proposed',
  'confirmed',
  'split',
  'rejected',
] as const;
export const QUESTION_STATUSES = ['candidate', 'selected', 'rejected'] as const;
/** Четыре критерия оценки вопроса F01 (`pub_questions.scores`). */
export const QUESTION_SCORE_KEYS = [
  'offer_fit',
  'confirmed_task',
  'own_answer',
  'cost',
] as const;

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
export const BRAND_FACT_STATUSES = [
  'draft',
  'active',
  'superseded',
  'needs_resolution',
  'rejected',
] as const;
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
export const BRIEF_STATUSES = ['draft', 'ready', 'rejected'] as const;

export const CONTENT_KINDS = [
  'article',
  'post',
  'cards',
  'checklist',
  'video_script',
  // P-R M2 (Р-RD-6): Reddit-материалы по Reddit-брифу (`redditBriefId`).
  'reddit_post',
  'reddit_comment',
] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];
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
/** `pub_contents.blockReason` (ТЗ §7). */
export const CONTENT_BLOCK_REASONS = [
  'source',
  'approval',
  'access',
  'measurement',
  'budget',
  'vendor',
  'no_venue',
] as const;
export const VERSION_STATUSES = [
  'draft',
  'submitted',
  'changes_requested',
  'approved',
  'rejected',
  'superseded',
] as const;

export const CLAIM_TYPES = [
  'fact',
  'estimate',
  'hypothesis',
  'example',
] as const;
export const CLAIM_RISKS = ['critical', 'high', 'normal'] as const;
export const CLAIM_STATUSES = [
  'unverified',
  'supported',
  'unsupported',
  'unknown',
  'needs_review',
] as const;
export const CLAIM_SUPPORTS = ['yes', 'no', 'partial', 'unknown'] as const;
export const QA_CHECK_KINDS = [
  'editorial',
  'technical',
  'ai_review',
  'adaptation_meaning',
  /** P-R M2: детерминированная проверка `system:reddit-policy` (Р-RD-8). */
  'reddit_policy',
] as const;
export type QaCheckKind = (typeof QA_CHECK_KINDS)[number];
export const QA_RESULTS = ['pass', 'fail', 'unknown'] as const;

export const APPROVAL_TYPES = [
  'publish_version',
  'purchase',
  'reserve_release',
  'ai_extra_generation',
] as const;
export type ApprovalType = (typeof APPROVAL_TYPES)[number];
export const APPROVAL_STATUSES = [
  'active',
  'revoked',
  'expired',
  'superseded',
  'consumed',
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

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
export const PUBLICATION_STAGES = ['test', 'live'] as const;
export const PUBLICATION_STATUSES = [
  'pending',
  'published',
  'replaced',
  'failed',
  'withdrawn',
] as const;
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];
/** Вид записи публикации (P-R M2, Р-RD-10): `user_reported` — отчёт человека. */
export const PUBLICATION_REPORT_KINDS = ['standard', 'user_reported'] as const;
export type PublicationReportKind = (typeof PUBLICATION_REPORT_KINDS)[number];
export const PUBLICATION_VERIFY_STATUSES = [
  'not_checked',
  'ok',
  'mismatch',
  'unreachable',
] as const;

export const VENUE_LINK_MARKINGS = [
  'sponsored',
  'nofollow',
  'unknown',
] as const;
export const VENUE_STATUSES = ['candidate', 'verified', 'rejected'] as const;
export type VenueStatus = (typeof VENUE_STATUSES)[number];
export const VENUE_CRITERIA = [
  'topic',
  'geo_language',
  'format',
  'evidence_freshness',
  'real_distribution',
] as const;
export const PLACEMENT_STATUSES = [
  'proposed',
  'approved',
  'budget_reserved',
  'ordered',
  'publication_pending',
  'published',
  'verified_complete',
  'rejected',
  'cancelled',
  'disputed',
] as const;
export type PlacementStatus = (typeof PLACEMENT_STATUSES)[number];
export const PAYMENT_STATUSES = [
  'unpaid',
  'pending',
  'paid',
  'refunded',
  'unknown',
] as const;
export type PlacementPaymentStatus = (typeof PAYMENT_STATUSES)[number];
export const CLAIM_STATUSES_PLACEMENT = ['none', 'open', 'resolved'] as const;
export const RESERVE_CATEGORIES = ['placements', 'tools'] as const;
export const EXPENSE_CATEGORIES = ['placements', 'tools', 'other'] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];
export const EXPENSE_STATUSES = ['open', 'closed'] as const;
export const EXPENSE_ENTRY_KINDS = [
  'commit',
  'pay',
  'refund',
  'cancel',
  'deliver',
  'adjust',
] as const;
export const EXPENSE_ENTRY_STATUSES = [
  'confirmed',
  'pending',
  'unknown',
  'void',
] as const;

export const TIME_ENTRY_ROLES = [...PUB_ROLES, 'admin'] as const;
export const TIME_ENTRY_CATEGORIES = [
  'setup',
  'research',
  'production',
  'distribution',
  'analytics_ops',
  'qa_reports',
  'development',
] as const;

export const PRIOR_EXTERNAL_PAYMENT = ['yes', 'no', 'unknown'] as const;
export const PROSPECT_LINK_REASONS = [
  'intake_exact_match',
  'new',
  'manual_merge',
  'manual_split',
  'manual_assign',
] as const;
export const LEAD_STATUSES = [
  'new',
  'contacted',
  'qualified',
  'rejected',
  'proposal_sent',
  'won',
  'lost',
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];
export const LEAD_TEST_REASONS = [
  'test_mode',
  'test_product',
  'team',
  'manual',
] as const;
export const CONTACT_METHODS = ['email', 'phone', 'telegram', 'other'] as const;
export type ContactMethod = (typeof CONTACT_METHODS)[number];
export const CONSENT_STATES = [
  'granted',
  'denied',
  'unknown',
  'not_required',
] as const;
export type ConsentState = (typeof CONSENT_STATES)[number];
export const LEAD_REASON_CODES = [
  'spam',
  'vendor_offer',
  'team',
  'fake',
  'out_of_scope',
  'unreachable',
  'price',
  'timing',
  'other',
] as const;
export const PAYMENT_RECORD_TYPES = [
  'payment_received',
  'refund',
  'contract_signed',
] as const;
export const PAYER_KINDS = ['external', 'internal', 'test', 'self'] as const;
export const CLIENT_PAYMENT_STATUSES = [
  'pending',
  'confirmed',
  'refunded',
  'cancelled',
] as const;
export const NEW_CUSTOMER_VALUES = ['yes', 'no', 'unknown'] as const;

export const EVENT_NAMES = [
  'content_view',
  'cta_click',
  'lead_submit_success',
] as const;
export const CHANNEL_GROUPS = [
  'organic_search',
  'unpaid_social_community',
  'paid_placement',
  'other_referral',
  'direct_unknown',
] as const;
export type ChannelGroup = (typeof CHANNEL_GROUPS)[number];
/** Ключи UTM, которые принимает публичный API (раздел 11.4). */
export const UTM_KEYS = ['source', 'medium', 'campaign', 'content'] as const;
export type UtmKey = (typeof UTM_KEYS)[number];
export const OUTBOX_STATUSES = [
  'pending',
  'processing',
  'done',
  'failed',
] as const;
export const NOTIFICATION_KINDS = [
  'new_lead',
  'retention_review',
  'contact_overdue',
] as const;
export const NOTIFICATION_STATUSES = [
  'pending',
  'sending',
  'sent',
  'failed',
  'dead',
  'suppressed',
] as const;

export const METRIC_IMPORT_SOURCES = [
  'search_console',
  'web_analytics',
  'manual',
] as const;
export const EXPERIMENT_KINDS = ['pilot', 'change'] as const;
export const EXPERIMENT_STATUSES = [
  'registered',
  'running',
  'concluded',
  'cancelled',
  'superseded',
] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];
export const EXPERIMENT_CONCLUSIONS = [
  'supported',
  'not_supported',
  'inconclusive',
] as const;
export const EXPERIMENT_DECISIONS = [
  'continue_limited',
  'fix_stage',
  'stop_purchases',
  'test_external_order',
  'scale',
] as const;
export const REPORT_KINDS = [
  'weekly',
  'd42',
  'd72',
  'd90',
  'late_cohort',
  'ad_hoc',
] as const;
export const REPORT_RECOMPUTE_REASONS = [
  'late_decision',
  'late_payment',
  'identity_change',
  'manual',
  /** Решение по отчёту — строка-наследник с `decision` (интеграция Z-1, Р-PUB-Z1-6). */
  'decision',
] as const;
export const BACKUP_KINDS = ['weekly', 'post_purchase', 'manual'] as const;
export const BACKUP_STATUSES = ['ok', 'failed', 'expired_deleted'] as const;
export const RESTORE_MODES = ['dry_run', 'apply_new_product'] as const;
export const RESTORE_STATUSES = ['running', 'done', 'failed'] as const;

export const AI_EVAL_STATUSES = [
  'not_run',
  'passed',
  'failed',
  'blocked',
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
export const AI_EVAL_MODES = ['fake', 'live'] as const;
export const AI_EVAL_SCHEMAS = [
  'answer',
  'brief',
  'qa',
  'adaptation',
  // P-R M2: задачи AI-31…AI-42 набора 2.3 (`pub.reddit.draft`).
  'reddit',
] as const;

// ── Reddit Manual MVP, пакет P-R (миграция …_publisher_reddit) ───────────
// doc/ai-publisher/reddit-manual-mvp-adapted.md §1–2. Режим только
// MANUAL_COPY: запросов к Reddit нет (Р-RD-0).

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
/** Факторы score v1 (§M1.4): первые четыре — relevance, остальные — risk. */
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

// ── M2 AI Content Studio (миграция …_publisher_reddit_m2) ────────────────

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
/** Вид материала по типу брифа. */
export const REDDIT_CONTENT_KIND_OF: Readonly<
  Record<RedditContentType, 'reddit_post' | 'reddit_comment'>
> = { post: 'reddit_post', comment: 'reddit_comment' };
export function isRedditContentKind(
  kind: string,
): kind is 'reddit_post' | 'reddit_comment' {
  return kind === 'reddit_post' || kind === 'reddit_comment';
}

/**
 * Сводная таблица «колонка → список» в формате сообщений триггеров
 * (`<таблица>.<поле>`). По ней `states.spec.ts` сверяет миграцию: каждый
 * список триггера должен быть здесь, и наоборот.
 */
export const PUB_CLOSED_LISTS: Readonly<Record<string, readonly string[]>> = {
  'pub_products.kind': PRODUCT_KINDS,
  'pub_products.mode': PRODUCT_MODES,
  'pub_products.status': PRODUCT_STATUSES,
  'pub_parameters.key': PARAMETER_KEYS,
  'pub_parameters.status': PARAMETER_STATUSES,
  'pub_parameter_proposals.parameterKey': PARAMETER_KEYS,
  'pub_parameter_proposals.status': PROPOSAL_STATUSES,
  'pub_parameter_decisions.parameterKey': PARAMETER_KEYS,
  /** Сообщение триггера одно на fromStatus и toStatus. */
  'pub_parameter_decisions.status': PARAMETER_STATUSES,
  'pub_parameter_decisions.fromStatus': PARAMETER_STATUSES,
  'pub_parameter_decisions.toStatus': PARAMETER_STATUSES,
  'pub_parameter_decisions.dependentStages': DEPENDENT_STAGES,
  'pub_role_grants.role': PUB_ROLES,
  'pub_audit_events.objectType': OBJECT_TYPES,
  'pub_audit_events.action': AUDIT_ACTIONS,
  'pub_review_tasks.objectType': OBJECT_TYPES,
  'pub_review_tasks.reason': REVIEW_REASONS,
  'pub_review_tasks.severity': REVIEW_SEVERITIES,
  'pub_review_tasks.status': REVIEW_STATUSES,
  'pub_integrations.kind': INTEGRATION_KINDS,
  'pub_integrations.status': INTEGRATION_STATUSES,
  'pub_sources.kind': SOURCE_KINDS,
  'pub_sources.usage': SOURCE_USAGES,
  'pub_sources.visibility': SOURCE_VISIBILITIES,
  'pub_sources.freshness': SOURCE_FRESHNESS,
  'pub_sources.importedVia': SOURCE_IMPORTED_VIA,
  'pub_sources.origin': SOURCE_ORIGINS,
  'pub_question_groups.stage': QUESTION_STAGES,
  'pub_question_groups.status': QUESTION_GROUP_STATUSES,
  'pub_questions.stage': QUESTION_STAGES,
  'pub_questions.status': QUESTION_STATUSES,
  'pub_questions.scores': QUESTION_SCORE_KEYS,
  'pub_brand_facts.kind': BRAND_FACT_KINDS,
  'pub_brand_facts.status': BRAND_FACT_STATUSES,
  'pub_offer_versions.status': OFFER_STATUSES,
  'pub_briefs.format': BRIEF_FORMATS,
  'pub_briefs.status': BRIEF_STATUSES,
  'pub_contents.kind': CONTENT_KINDS,
  'pub_contents.status': CONTENT_STATUSES,
  'pub_contents.blockReason': CONTENT_BLOCK_REASONS,
  'pub_content_versions.status': VERSION_STATUSES,
  'pub_claims.type': CLAIM_TYPES,
  'pub_claims.risk': CLAIM_RISKS,
  'pub_claims.status': CLAIM_STATUSES,
  'pub_claim_sources.supports': CLAIM_SUPPORTS,
  'pub_qa_checks.kind': QA_CHECK_KINDS,
  'pub_qa_checks.result': QA_RESULTS,
  'pub_approvals.objectType': OBJECT_TYPES,
  'pub_approvals.type': APPROVAL_TYPES,
  'pub_approvals.status': APPROVAL_STATUSES,
  'pub_channels.kind': CHANNEL_KINDS,
  'pub_channels.status': CHANNEL_STATUSES,
  'pub_distribution_actions.status': DISTRIBUTION_STATUSES,
  'pub_distribution_actions.blockReason': DISTRIBUTION_BLOCK_REASONS,
  'pub_publications.stage': PUBLICATION_STAGES,
  'pub_publications.status': PUBLICATION_STATUSES,
  'pub_publications.verifyStatus': PUBLICATION_VERIFY_STATUSES,
  'pub_publications.reportKind': PUBLICATION_REPORT_KINDS,
  'pub_venues.linkMarking': VENUE_LINK_MARKINGS,
  'pub_venues.status': VENUE_STATUSES,
  'pub_venues.criteria': VENUE_CRITERIA,
  'pub_venue_evidence.criterion': VENUE_CRITERIA,
  'pub_placements.status': PLACEMENT_STATUSES,
  'pub_placements.paymentStatus': PAYMENT_STATUSES,
  'pub_placements.claimStatus': CLAIM_STATUSES_PLACEMENT,
  'pub_reserve_moves.toCategory': RESERVE_CATEGORIES,
  'pub_expenses.category': EXPENSE_CATEGORIES,
  'pub_expenses.status': EXPENSE_STATUSES,
  'pub_expense_entries.kind': EXPENSE_ENTRY_KINDS,
  'pub_expense_entries.status': EXPENSE_ENTRY_STATUSES,
  'pub_time_entries.role': TIME_ENTRY_ROLES,
  'pub_time_entries.category': TIME_ENTRY_CATEGORIES,
  'pub_prospects.priorExternalPayment': PRIOR_EXTERNAL_PAYMENT,
  'pub_lead_prospect_links.reason': PROSPECT_LINK_REASONS,
  'pub_leads.status': LEAD_STATUSES,
  'pub_leads.testReason': LEAD_TEST_REASONS,
  'pub_leads.contactMethod': CONTACT_METHODS,
  'pub_leads.consentState': CONSENT_STATES,
  'pub_lead_decisions.status': LEAD_STATUSES,
  'pub_lead_decisions.reasonCode': LEAD_REASON_CODES,
  'pub_payments.recordType': PAYMENT_RECORD_TYPES,
  'pub_payments.payerKind': PAYER_KINDS,
  'pub_payments.status': CLIENT_PAYMENT_STATUSES,
  'pub_payments.isNewCustomer': NEW_CUSTOMER_VALUES,
  'pub_sessions.consentState': CONSENT_STATES,
  'pub_sessions.channelGroup': CHANNEL_GROUPS,
  'pub_events.name': EVENT_NAMES,
  'pub_events.channelGroup': CHANNEL_GROUPS,
  'pub_events.utm': UTM_KEYS,
  'pub_lead_outbox.status': OUTBOX_STATUSES,
  'pub_notifications.kind': NOTIFICATION_KINDS,
  'pub_notifications.status': NOTIFICATION_STATUSES,
  'pub_metric_imports.source': METRIC_IMPORT_SOURCES,
  'pub_experiments.kind': EXPERIMENT_KINDS,
  'pub_experiments.status': EXPERIMENT_STATUSES,
  'pub_experiments.conclusion': EXPERIMENT_CONCLUSIONS,
  'pub_experiments.decision': EXPERIMENT_DECISIONS,
  'pub_reports.kind': REPORT_KINDS,
  'pub_reports.recomputeReason': REPORT_RECOMPUTE_REASONS,
  'pub_backups.kind': BACKUP_KINDS,
  'pub_backups.status': BACKUP_STATUSES,
  'pub_restores.mode': RESTORE_MODES,
  'pub_restores.status': RESTORE_STATUSES,
  'pub_ai_configs.evalStatus': AI_EVAL_STATUSES,
  'pub_ai_tasks.generator': GENERATOR_IDS,
  'pub_ai_tasks.status': AI_TASK_STATUSES,
  'pub_ai_calls.generator': GENERATOR_IDS,
  'pub_ai_calls.status': AI_CALL_STATUSES,
  'pub_ai_calls.costStatus': AI_COST_STATUSES,
  'pub_ai_eval_runs.mode': AI_EVAL_MODES,
  'pub_ai_eval_results.schema': AI_EVAL_SCHEMAS,
  'pub_ai_eval_results.costStatus': AI_COST_STATUSES,
  'pub_reddit_projects.status': REDDIT_PROJECT_STATUSES,
  'pub_reddit_communities.status': REDDIT_COMMUNITY_STATUSES,
  'pub_reddit_rule_snapshots.promotionPolicy': REDDIT_PROMOTION_POLICIES,
  'pub_reddit_rule_snapshots.linksPolicy': REDDIT_LINKS_POLICIES,
  'pub_reddit_rule_snapshots.reviewState': REDDIT_REVIEW_STATES,
  'pub_reddit_rule_snapshots.status': REDDIT_SNAPSHOT_STATUSES,
  'pub_reddit_keywords.intent': REDDIT_INTENTS,
  'pub_reddit_keywords.status': REDDIT_KEYWORD_STATUSES,
  'pub_reddit_opportunities.intent': REDDIT_INTENTS,
  'pub_reddit_opportunities.policy': REDDIT_POLICY_VERDICTS,
  'pub_reddit_opportunities.status': REDDIT_OPPORTUNITY_STATUSES,
  'pub_reddit_opportunities.factors': REDDIT_SCORE_FACTORS,
  'pub_reddit_briefs.contentType': REDDIT_CONTENT_TYPES,
  'pub_reddit_briefs.status': REDDIT_BRIEF_STATUSES,
  'pub_reddit_briefs.affiliation': REDDIT_AFFILIATIONS,
};

/** Значение из закрытого списка (сужение типа). */
export function isOneOf<T extends string>(
  list: readonly T[],
  v: unknown,
): v is T {
  return typeof v === 'string' && (list as readonly string[]).includes(v);
}
