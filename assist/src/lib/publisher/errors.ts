/**
 * AI Publisher (P-G1) — ошибка API → строки для человека (§11.2 и
 * «детали и причины» Z-1). Чистая функция, проверяется скриптом.
 *
 *  - `PUB_CONFLICT` — «есть более новая версия» + перезагрузка без
 *    перезаписи (AT-CORE-10);
 *  - `PUB_GATE_CLOSED` — гейт и перечень недостающего;
 *  - `PUB_VALIDATION` — поля и коды;
 *  - `PUB_NOT_IMPLEMENTED` — «не подключено», никогда не успех;
 *  - незнакомый код — текст сервера (он уже на языке `Accept-Language`).
 */

import { ApiError } from '../../kit/envelope';
import type { PublisherDict } from '../../i18n/publisher-ru';
import { fieldIssues, isRetryable } from './common-pure';
import { fmtText } from './view';

export const PUB_ERROR_CODES = [
  'PUB_NOT_FOUND',
  'PUB_PRODUCT_NONE',
  'PUB_PRODUCT_EXISTS',
  'PUB_ROLE_REQUIRED',
  'PUB_VALIDATION',
  'PUB_CONFLICT',
  'PUB_IDEMPOTENCY_REUSED',
  'PUB_BUSY',
  'PUB_TRANSITION_INVALID',
  'PUB_GATE_CLOSED',
  'PUB_PARAMETER_UNAPPROVED',
  'PUB_BLOCKERS_OPEN',
  'PUB_BRIEF_NOT_READY',
  'PUB_APPROVAL_REQUIRED',
  'PUB_APPROVAL_EXPIRED',
  'PUB_APPROVAL_STALE',
  'PUB_CONTENT_STALE',
  'PUB_OBSERVATION_PENDING',
  'PUB_PRICE_INCOMPLETE',
  'PUB_FX_REQUIRED',
  'PUB_BUDGET_INSUFFICIENT',
  'PUB_BUDGET_STOPPED',
  'PUB_RECONCILE_REQUIRED',
  'PUB_MEASUREMENT_UNAVAILABLE',
  'PUB_SOURCE_NOT_ALLOWED',
  'PUB_IMPORT_BLOCKED',
  'PUB_CONTACT_KEY_MISSING',
  'PUB_AI_NOT_EVALUATED',
  'PUB_AI_DISABLED',
  'PUB_AI_LIMIT',
  'PUB_AI_BUDGET',
  'PUB_AI_UNPRICED',
  'PUB_AI_UNAVAILABLE',
  'PUB_AI_SCHEMA_INVALID',
  'PUB_WINDOW_OPEN',
  'PUB_RESTORE_CONFLICT',
  'PUB_FORM_CLOSED',
  'PUB_RATE_LIMITED',
  'PUB_ORIGIN_DENIED',
  'PUB_PAYLOAD_TOO_LARGE',
  'PUB_NOT_IMPLEMENTED',
] as const;
export type PubErrorCode = (typeof PUB_ERROR_CODES)[number];

export function isPubErrorCode(v: unknown): v is PubErrorCode {
  return (
    typeof v === 'string' && (PUB_ERROR_CODES as readonly string[]).includes(v)
  );
}

export interface PubErrorView {
  code: string;
  title: string;
  lines: string[];
  /** 409 `PUB_CONFLICT`: показать «перезагрузить», не перезаписывать. */
  conflict: boolean;
  /** `isRetryable`: сеть, `PUB_BUSY`, 502–504 — повтор тем же `opKey`. */
  retryable: boolean;
  /** AI недоступен/выключен: экран показывает ручной путь. */
  manualPath: boolean;
}

const MANUAL = new Set([
  'PUB_AI_DISABLED',
  'PUB_AI_UNAVAILABLE',
  'PUB_AI_SCHEMA_INVALID',
  'PUB_AI_NOT_EVALUATED',
  'PUB_AI_LIMIT',
  'PUB_AI_BUDGET',
  'PUB_AI_UNPRICED',
]);

function strList(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string').slice(0, 30)
    : [];
}

function labelOf(map: Record<string, string>, k: string): string {
  return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : k;
}

export function describePubError(e: unknown, t: PublisherDict): PubErrorView {
  if (!(e instanceof ApiError)) {
    return {
      code: 'unknown',
      title: t.errors.title,
      lines: [e instanceof Error ? e.message : String(e)],
      conflict: false,
      retryable: false,
      manualPath: false,
    };
  }
  const d = e.details ?? {};
  const code = e.code;
  const lines: string[] = [];
  let title: string;
  if (isPubErrorCode(code)) title = t.errors.codes[code];
  else if (code === 'PUB_RESPONSE_INVALID') title = t.errors.responseInvalid;
  else if (code === 'network' || e.status === 0) title = t.errors.network;
  else title = e.message || t.errors.title;

  // Причина нехватки бюджета / закрытого гейта закупок (в т.ч.
  // `purchases_disabled`: per_purchase_max = 0) — словами, а не кодом.
  const budgetReason =
    (code === 'PUB_BUDGET_INSUFFICIENT' || code === 'PUB_GATE_CLOSED') &&
    typeof d.reason === 'string' &&
    Object.prototype.hasOwnProperty.call(t.errors.budgetReasons, d.reason)
      ? labelOf(t.errors.budgetReasons, d.reason)
      : null;
  switch (code) {
    case 'PUB_CONFLICT':
      // Конфликт не версии, а правила (P-R `reddit_evidence_locked`) —
      // словами и без «перезагрузить»: перезагрузка его не снимет.
      if (
        typeof d.reason === 'string' &&
        Object.prototype.hasOwnProperty.call(t.errors.conflictReasons, d.reason)
      ) {
        lines.push(labelOf(t.errors.conflictReasons, d.reason));
      } else {
        lines.push(t.errors.conflictText);
      }
      break;
    case 'PUB_GATE_CLOSED': {
      const gate = typeof d.gate === 'string' ? d.gate : '';
      if (gate) lines.push(labelOf(t.gates.names, gate));
      if (Array.isArray(d.missing)) {
        for (const m of d.missing.slice(0, 30)) {
          if (!m || typeof m !== 'object') continue;
          const o = m as Record<string, unknown>;
          const kind = typeof o.kind === 'string' ? o.kind : '';
          const key = typeof o.key === 'string' ? o.key : '';
          const detail = typeof o.detail === 'string' ? o.detail : '';
          const keyLabel =
            kind === 'parameter' ? labelOf(t.params.keys, key) : key;
          lines.push(
            `${labelOf(t.gates.missingKinds, kind)}: ${keyLabel}${
              detail ? ` — ${labelOf(t.gates.details, detail)}` : ''
            }`
          );
        }
      }
      break;
    }
    case 'PUB_VALIDATION': {
      const fields = fieldIssues(e);
      if (fields.length) {
        lines.push(
          fmtText(t.errors.fields, {
            list: fields
              .map(
                (f) => `${f.field} — ${labelOf(t.errors.fieldCodes, f.code)}`
              )
              .join('; '),
          })
        );
      }
      break;
    }
    case 'PUB_IMPORT_BLOCKED':
      if (typeof d.reason === 'string') {
        lines.push(labelOf(t.errors.importReasons, d.reason));
      }
      break;
    case 'PUB_BLOCKERS_OPEN':
      if (Array.isArray(d.blockers)) {
        for (const b of d.blockers.slice(0, 30)) {
          const c =
            b && typeof b === 'object'
              ? (b as Record<string, unknown>).code
              : null;
          if (typeof c === 'string') lines.push(labelOf(t.errors.blockers, c));
        }
      }
      if (typeof d.openChangeTasks === 'number') {
        lines.push(
          `${t.errors.blockers.change_task_open}: ${d.openChangeTasks}`
        );
      }
      break;
    case 'PUB_BRIEF_NOT_READY':
      for (const m of strList(d.missing)) lines.push(m);
      break;
    case 'PUB_AI_BUDGET':
      // v1.4: «месяц не открыт» ≠ «потолок исчерпан» (аудит P-R-ADM S2-1).
      if (
        typeof d.reason === 'string' &&
        Object.prototype.hasOwnProperty.call(t.errors.aiBudgetReasons, d.reason)
      ) {
        title = labelOf(t.errors.aiBudgetReasons, d.reason);
      }
      break;
    case 'PUB_APPROVAL_STALE':
      if (typeof d.reason === 'string') {
        lines.push(labelOf(t.errors.staleReasons, d.reason));
      }
      break;
    case 'PUB_TRANSITION_INVALID':
      lines.push(
        fmtText(t.errors.transition, {
          from: String(d.from ?? '?'),
          to: String(d.to ?? '?'),
          allowed: strList(d.allowed).join(', ') || '—',
        })
      );
      if (typeof d.hint === 'string') lines.push(d.hint);
      break;
    case 'PUB_BUDGET_INSUFFICIENT':
      lines.push(
        fmtText(t.errors.budget, {
          available: String(d.available ?? '?'),
          requested: String(d.requested ?? '?'),
        })
      );
      break;
    case 'PUB_SOURCE_NOT_ALLOWED':
      if (strList(d.sourceIds).length) {
        lines.push(strList(d.sourceIds).join(', '));
      }
      break;
    default:
      break;
  }
  if (budgetReason) lines.push(budgetReason);
  const ruleConflict =
    code === 'PUB_CONFLICT' &&
    typeof d.reason === 'string' &&
    Object.prototype.hasOwnProperty.call(t.errors.conflictReasons, d.reason);
  if (
    typeof d.reason === 'string' &&
    !ruleConflict &&
    !budgetReason &&
    !['PUB_IMPORT_BLOCKED', 'PUB_APPROVAL_STALE', 'PUB_AI_BUDGET'].includes(
      code
    )
  ) {
    lines.push(fmtText(t.errors.reasons, { reason: d.reason }));
  }
  if (typeof d.callId === 'string') {
    lines.push(fmtText(t.errors.callRef, { id: d.callId }));
  }
  return {
    code,
    title,
    lines,
    conflict: code === 'PUB_CONFLICT' && !ruleConflict,
    retryable: isRetryable(e),
    manualPath: MANUAL.has(code),
  };
}
