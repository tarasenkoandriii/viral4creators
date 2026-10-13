/**
 * AI Publisher — машины состояний (P-A1, проектный документ §7, §3.2):
 * таблицы переходов как данные `{from, to, action, roles, guards}`.
 * Сервисы пакетов вызывают `assertTransition(machine, from, to, ctx)`:
 * недопустимый переход — 409 `PUB_TRANSITION_INVALID {from, to, allowed}`,
 * роль вне строки — 403 `PUB_ROLE_REQUIRED`. Условия (`guards`) — имена
 * проверок, которые выполняет сервис-владелец в транзакции операции
 * (перечислены для ревью и экрана; машина их не исполняет).
 *
 * Где у переходов есть триггер (режим продукта, публикация, согласование,
 * задача проверки, предложение, AI-вызов), таблица здесь не шире
 * триггера — тест `state-machines.spec.ts` перебирает все пары.
 *
 * Чистый модуль (кроме исключения `PubError`).
 */
import {
  AI_CALL_STATUSES,
  AI_TASK_STATUSES,
  APPROVAL_STATUSES,
  CONTENT_STATUSES,
  DISTRIBUTION_STATUSES,
  EXPERIMENT_STATUSES,
  INTEGRATION_STATUSES,
  LEAD_STATUSES,
  PARAMETER_STATUSES,
  PAYMENT_STATUSES,
  PLACEMENT_STATUSES,
  PRODUCT_MODES,
  PROPOSAL_STATUSES,
  PUBLICATION_STATUSES,
  REVIEW_STATUSES,
  VENUE_STATUSES,
  type PubRole,
} from '../contracts/states';
import { PubError } from './errors';

/** Кто совершает переход: роль продукта, `admin` (publisher=admin), система, посетитель. */
export type Actor = PubRole | 'admin' | 'system' | 'public';

export interface Transition<S extends string> {
  from: S;
  to: S;
  action: string;
  roles: readonly Actor[];
  guards: readonly string[];
}

export interface Machine<S extends string> {
  name: string;
  states: readonly S[];
  /** Начальные статусы (создание строки), если машина их задаёт. */
  initial: readonly S[];
  transitions: ReadonlyArray<Transition<S>>;
}

type Row<S extends string> = [
  from: S | readonly S[],
  to: S,
  action: string,
  roles: readonly Actor[],
  guards?: readonly string[],
];

function machine<S extends string>(
  name: string,
  states: readonly S[],
  initial: readonly S[],
  rows: Array<Row<S>>,
): Machine<S> {
  const transitions: Array<Transition<S>> = [];
  for (const [from, to, action, roles, guards = []] of rows) {
    for (const f of (Array.isArray(from) ? from : [from]) as S[]) {
      transitions.push({ from: f, to, action, roles, guards });
    }
  }
  return { name, states, initial, transitions };
}

const PO = 'product_owner' as const;
const ED = 'editor' as const;
const OP = 'operator' as const;
const SA = 'sales' as const;
const AN = 'analyst' as const;
const AD = 'admin' as const;
const SYS = 'system' as const;

/** Режим продукта (§3.2, триггер `pub_products_guard`). */
export const PRODUCT_MODE_MACHINE = machine(
  'product_mode',
  PRODUCT_MODES,
  ['closed'],
  [
    ['closed', 'test', 'mode.test', [AD], ['kind_not_eval_or_restored']],
    ['test', 'closed', 'mode.close', [AD]],
    [
      ['closed', 'test'],
      'live',
      'mode.live',
      [AD],
      ['kind_working', 'gate_public_publish', 'verified_host'],
    ],
    ['live', 'closed', 'mode.close', [AD], ['honest_message_alt_contact']],
  ],
);

/** Материал и адаптация (§7.1). */
export const CONTENT_MACHINE = machine(
  'content',
  CONTENT_STATUSES,
  ['brief'],
  [
    [
      'brief',
      'drafting',
      'draft',
      [ED, PO],
      [
        'brief_ready',
        'own_contribution',
        'allowed_source',
        'cta',
        'offer_active',
      ],
    ],
    [
      'drafting',
      'editorial_review',
      'submit',
      [ED, PO],
      ['version_submitted', 'claims_extracted', 'facts_confirmed'],
    ],
    [
      'editorial_review',
      'changes_requested',
      'request_changes',
      [ED, PO],
      ['reason'],
    ],
    [
      'changes_requested',
      'drafting',
      'new_version',
      [ED, PO],
      ['new_draft_version'],
    ],
    [
      'editorial_review',
      'approved',
      'approve',
      [PO],
      [
        'no_open_blockers',
        'qa_editorial_pass',
        'qa_technical_pass',
        'critical_claims_supported',
        'sources_allowed',
        'offer_active',
        'no_open_change_tasks',
        'adaptation_meaning_pass',
        'parent_still_approved',
        'self_review_marked',
      ],
    ],
    [
      'approved',
      'drafting',
      'new_version',
      [ED, PO],
      ['unpublished_approval_superseded'],
    ],
    [
      'approved',
      'scheduled',
      'schedule',
      [OP, PO],
      [
        'approval_active_hash',
        'planned_date',
        'offer_active',
        'sources_allowed',
        'no_offer_fact_tasks',
      ],
    ],
    [
      'scheduled',
      'published',
      'publish',
      [OP, PO],
      [
        'live_publication',
        'gate_public_publish',
        'recheck_offer_sources_tasks',
        'first_published_once',
        't0_once',
      ],
    ],
    ['scheduled', 'approved', 'unschedule', [OP, PO], ['reason']],
    [
      ['published', 'revised'],
      'correction_required',
      'needs_correction',
      [SYS, ED, PO],
      ['change_task', 'critical_stale_if_price_or_critical'],
    ],
    [
      'correction_required',
      'drafting',
      'new_version',
      [ED, PO],
      ['published_version_still_shown'],
    ],
    [
      'correction_required',
      'revised',
      'publish_revision',
      [ED, PO],
      ['new_version_published_same_url'],
    ],
    [
      ['correction_required', 'published', 'revised'],
      'published',
      'confirm_unaffected',
      [ED, PO],
      ['task_resolved_with_decision'],
    ],
    [
      [
        'brief',
        'drafting',
        'editorial_review',
        'changes_requested',
        'approved',
        'scheduled',
        'published',
        'correction_required',
        'revised',
      ],
      'withdrawn',
      'withdraw',
      [ED, PO],
      ['reason', 'publications_withdrawn'],
    ],
  ],
);

/** Площадка (§7.2). */
export const VENUE_MACHINE = machine(
  'venue',
  VENUE_STATUSES,
  ['candidate'],
  [
    [
      'candidate',
      'verified',
      'verify',
      [OP, PO],
      ['all_required_checks', 'link_marking_known'],
    ],
    [['candidate', 'verified'], 'rejected', 'reject', [OP, PO], ['reason']],
    [
      'verified',
      'candidate',
      'evidence_stale',
      [SYS, OP],
      ['evidence_freshness_expired'],
    ],
  ],
);

/** Закупка (§7.2). */
export const PLACEMENT_MACHINE = machine(
  'placement',
  PLACEMENT_STATUSES,
  ['proposed'],
  [
    [
      'proposed',
      'approved',
      'approve',
      [PO],
      [
        'report_decision_if_seq3',
        'approval_purchase_created',
        'self_review_marked',
      ],
    ],
    [
      'approved',
      'budget_reserved',
      'reserve',
      [OP, PO],
      [
        'gate_purchases',
        'approval_active_not_expired',
        'price_snapshot_matches',
        'budget_available',
        'per_purchase_cap',
      ],
    ],
    [
      'budget_reserved',
      'ordered',
      'order',
      [OP, PO],
      ['external_order_id', 'no_pending_payment'],
    ],
    [
      'ordered',
      'publication_pending',
      'await_publication',
      [OP, PO],
      ['publish_due_at'],
    ],
    [
      'publication_pending',
      'published',
      'mark_published',
      [OP, PO],
      ['published_at', 'url'],
    ],
    [
      'published',
      'verified_complete',
      'verify',
      [OP, PO],
      ['url_utm_marking_checked'],
    ],
    [
      ['proposed', 'approved'],
      'rejected',
      'reject',
      [OP, PO],
      ['reason', 'approval_revoked'],
    ],
    [
      ['budget_reserved', 'ordered', 'publication_pending'],
      'cancelled',
      'cancel',
      [OP, PO],
      ['confirmed_cancel_amount'],
    ],
    [
      ['ordered', 'publication_pending', 'published'],
      'disputed',
      'dispute',
      [OP, PO],
      ['claim_owner', 'next_action_at', 'reason'],
    ],
    [
      'disputed',
      'publication_pending',
      'resolve_dispute',
      [OP, PO],
      ['claim_outcome'],
    ],
    ['disputed', 'published', 'resolve_dispute', [OP, PO], ['claim_outcome']],
    [
      'disputed',
      'cancelled',
      'resolve_dispute',
      [OP, PO],
      ['claim_outcome', 'confirmed_cancel_amount'],
    ],
  ],
);

/** Оплата закупки (§7.3) — выводится из записей оплаты. */
export const PLACEMENT_PAYMENT_MACHINE = machine(
  'placement_payment',
  PAYMENT_STATUSES,
  ['unpaid'],
  [
    ['unpaid', 'pending', 'pay_pending', [OP, PO]],
    [['unpaid', 'pending'], 'unknown', 'pay_unknown', [OP, PO]],
    [
      ['pending', 'unknown'],
      'paid',
      'reconcile_confirmed',
      [OP, PO],
      ['document'],
    ],
    [
      ['pending', 'unknown'],
      'unpaid',
      'reconcile_void',
      [OP, PO],
      ['document'],
    ],
    ['paid', 'refunded', 'refund_confirmed', [OP, PO], ['confirmed_refund']],
  ],
);

/** Заявка (§7.4). Создание (`new`) — публичный приём. */
export const LEAD_MACHINE = machine(
  'lead',
  LEAD_STATUSES,
  ['new'],
  [
    ['new', 'contacted', 'contact', [SA, PO], ['contact_date']],
    [
      ['new', 'contacted'],
      'qualified',
      'qualify',
      [SA, PO],
      // ДТ-3: тестовая заявка квалифицируется (запись test, вне деловых сумм).
      ['prospect', 'confirmed_interest', 'test_excluded', 'external_segment'],
    ],
    [
      ['new', 'contacted'],
      'rejected',
      'reject',
      [SA, PO],
      ['reason_code', 'encrypted_note'],
    ],
    ['qualified', 'proposal_sent', 'send_proposal', [SA, PO], ['date']],
    [['proposal_sent'], 'won', 'win', [SA, PO]],
    [['proposal_sent'], 'lost', 'lose', [SA, PO], ['reason_code']],
    [['rejected', 'lost'], 'contacted', 'reopen', [SA, PO], ['reason_code']],
    ['qualified', 'contacted', 'unqualify', [SA, PO], ['reason_code']],
  ],
);

/** Согласование (§7.5, триггер `pub_approvals_guard`). */
export const APPROVAL_MACHINE = machine(
  'approval',
  APPROVAL_STATUSES,
  ['active'],
  [
    ['active', 'revoked', 'revoke', [ED, PO], ['reason']],
    ['active', 'expired', 'expire', [SYS], ['expires_at_passed']],
    [
      'active',
      'superseded',
      'supersede',
      [SYS, ED, PO],
      ['newer_version_published_or_offer_changed'],
    ],
    ['active', 'consumed', 'consume', [OP, PO], ['purchase_reserve']],
  ],
);

/** Задача проверки (§7.5). */
export const REVIEW_TASK_MACHINE = machine(
  'review_task',
  REVIEW_STATUSES,
  ['open'],
  [
    ['open', 'resolved', 'resolve', [ED, PO, SA], ['resolution']],
    ['open', 'dismissed', 'dismiss', [ED, PO, SA], ['resolution']],
  ],
);

/** Действие распространения (§7.5). */
export const DISTRIBUTION_MACHINE = machine(
  'distribution_action',
  DISTRIBUTION_STATUSES,
  ['planned', 'blocked'],
  [
    ['planned', 'blocked', 'block', [OP, ED, PO, SYS], ['block_reason']],
    [
      'planned',
      'done',
      'done',
      [OP, ED, PO],
      ['publication', 'real_url', 'not_critical_stale'],
    ],
    ['planned', 'cancelled', 'cancel', [OP, ED, PO]],
    ['blocked', 'planned', 'unblock', [OP, ED, PO], ['reason_cleared']],
  ],
);

/** Публикация (§7.5, триггер `pub_publication_guard`). */
export const PUBLICATION_MACHINE = machine(
  'publication',
  PUBLICATION_STATUSES,
  ['pending', 'published'],
  [
    [
      'pending',
      'published',
      'publish',
      [OP, PO, SYS],
      ['approval_active_same_hash'],
    ],
    ['pending', 'failed', 'fail', [OP, PO, SYS]],
    [
      'published',
      'replaced',
      'replace',
      [OP, PO, ED, SYS],
      ['new_version_same_url'],
    ],
    [
      ['pending', 'published'],
      'withdrawn',
      'withdraw',
      [OP, PO, ED],
      ['reason'],
    ],
  ],
);

/** Эксперимент (§7.5). */
export const EXPERIMENT_MACHINE = machine(
  'experiment',
  EXPERIMENT_STATUSES,
  ['registered'],
  [
    ['registered', 'running', 'start', [AN, PO], ['registered_before_applied']],
    [
      'running',
      'concluded',
      'conclude',
      [AN, PO],
      ['window_closed_or_inconclusive', 'decision'],
    ],
    [['registered', 'running'], 'cancelled', 'cancel', [AN, PO], ['reason']],
    [
      ['registered', 'running', 'concluded', 'cancelled'],
      'superseded',
      'new_version',
      [AN, PO],
      ['new_version_row'],
    ],
  ],
);

/** Интеграция (§7.5): статус ставит человек; `connected → degraded` — и крон. */
export const INTEGRATION_MACHINE = machine(
  'integration',
  INTEGRATION_STATUSES,
  INTEGRATION_STATUSES,
  [
    [
      'connected',
      'degraded',
      'degrade',
      [AN, PO, AD, SYS],
      ['stale_after_hours'],
    ],
    ['connected', 'disconnected', 'disconnect', [AN, PO, AD]],
    ['degraded', 'connected', 'restore', [AN, PO, AD], ['last_success']],
    ['degraded', 'disconnected', 'disconnect', [AN, PO, AD]],
    ['disconnected', 'connected', 'connect', [AN, PO, AD], ['last_success']],
    ['disconnected', 'degraded', 'partial', [AN, PO, AD]],
  ],
);

/** AI-задача (§7.5). */
export const AI_TASK_MACHINE = machine(
  'ai_task',
  AI_TASK_STATUSES,
  ['open'],
  [
    ['open', 'done', 'accept', [ED, PO, OP]],
    ['open', 'needs_human', 'give_up', [SYS], ['two_failed_generations']],
    // Аудит P-B2 S3-5: генерация — только по `open`; третья генерация после
    // отказа возвращает задачу в работу решением редактора (согласование
    // `ai_extra_generation`).
    ['needs_human', 'open', 'reopen', [ED, PO], ['extra_generation_approved']],
  ],
);

/** AI-вызов (§7.5): `running` → итог; блокирующие статусы пишутся сразу. */
export const AI_CALL_MACHINE = machine(
  'ai_call',
  AI_CALL_STATUSES,
  [
    'running',
    'budget_blocked',
    'unpriced_blocked',
    'not_evaluated',
    'disabled',
  ],
  [
    ['running', 'ok', 'finish', [SYS]],
    ['running', 'schema_invalid', 'finish', [SYS]],
    ['running', 'timeout', 'finish', [SYS]],
    ['running', 'unavailable', 'finish', [SYS]],
    ['running', 'empty', 'finish', [SYS]],
    ['running', 'truncated', 'finish', [SYS]],
    ['running', 'refused', 'finish', [SYS]],
  ],
);

/**
 * Статус параметра (§6.2, решения владельца). `approved → approved` —
 * новое значение по предложению (версия растёт).
 */
export const PARAMETER_MACHINE = machine(
  'parameter',
  PARAMETER_STATUSES,
  ['assumption'],
  [
    ['assumption', 'approved', 'approve', [PO], ['basis', 'approvable_value']],
    ['assumption', 'rejected', 'reject', [PO], ['basis']],
    [
      'approved',
      'approved',
      'approve_change',
      [PO],
      ['basis', 'proposal', 'approvable_value'],
    ],
    ['approved', 'revoked', 'revoke', [PO], ['basis']],
    [
      ['rejected', 'revoked'],
      'approved',
      'approve',
      [PO],
      ['basis', 'approvable_value'],
    ],
    // Допущение для режима test (контракт P-A0: представление читает
    // допущение в test только при решении `assumption` той же версии).
    [
      ['assumption', 'rejected', 'revoked'],
      'assumption',
      'set_test_assumption',
      [PO],
      ['basis'],
    ],
  ],
);

/** Предложение параметра (§6.2, триггер `pub_parameter_proposals_guard`). */
export const PROPOSAL_MACHINE = machine(
  'parameter_proposal',
  PROPOSAL_STATUSES,
  ['open'],
  [
    ['open', 'accepted', 'accept', [PO], ['decision']],
    ['open', 'rejected', 'reject', [PO], ['basis']],
    ['open', 'withdrawn', 'withdraw', [PO, AN, AD], ['proposer_or_owner']],
  ],
);

export const MACHINES = {
  product_mode: PRODUCT_MODE_MACHINE,
  content: CONTENT_MACHINE,
  venue: VENUE_MACHINE,
  placement: PLACEMENT_MACHINE,
  placement_payment: PLACEMENT_PAYMENT_MACHINE,
  lead: LEAD_MACHINE,
  approval: APPROVAL_MACHINE,
  review_task: REVIEW_TASK_MACHINE,
  distribution_action: DISTRIBUTION_MACHINE,
  publication: PUBLICATION_MACHINE,
  experiment: EXPERIMENT_MACHINE,
  integration: INTEGRATION_MACHINE,
  ai_task: AI_TASK_MACHINE,
  ai_call: AI_CALL_MACHINE,
  parameter: PARAMETER_MACHINE,
  parameter_proposal: PROPOSAL_MACHINE,
} as const;

/** Допустимые переходы из статуса (для ответа и экрана). */
export function allowedFrom<S extends string>(m: Machine<S>, from: S): S[] {
  return [
    ...new Set(m.transitions.filter((t) => t.from === from).map((t) => t.to)),
  ];
}

export function findTransition<S extends string>(
  m: Machine<S>,
  from: S,
  to: S,
): Transition<S> | undefined {
  return m.transitions.find((t) => t.from === from && t.to === to);
}

export function canTransition<S extends string>(
  m: Machine<S>,
  from: S,
  to: S,
): boolean {
  return findTransition(m, from, to) !== undefined;
}

/**
 * Проверка перехода. `ctx.actors` — кто действует (роли участника, `admin`,
 * `system`): без пересечения со строкой — 403 `PUB_ROLE_REQUIRED`.
 */
export function assertTransition<S extends string>(
  m: Machine<S>,
  from: S,
  to: S,
  ctx: { actors?: ReadonlyArray<Actor> } = {},
): Transition<S> {
  const t = findTransition(m, from, to);
  if (!t) {
    throw new PubError('PUB_TRANSITION_INVALID', {
      machine: m.name,
      from,
      to,
      allowed: allowedFrom(m, from),
    });
  }
  if (ctx.actors && !ctx.actors.some((a) => t.roles.includes(a))) {
    throw new PubError('PUB_ROLE_REQUIRED', {
      action: `${m.name}.${t.action}`,
    });
  }
  return t;
}
