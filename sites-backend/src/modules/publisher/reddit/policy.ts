/**
 * AI Publisher, P-R — реестр правил и Policy Gate (reddit-manual-mvp-
 * adapted.md §M1.3; AT-RD-03, AT-RD-04). Чистые функции: без базы, сети и
 * LLM — модель не может менять policy (в AI-слое нет ни маршрута, ни
 * импорта, который пишет снимки: правило графа `publisher-ai-no-authority`).
 *
 * `snapshotState`: `unreviewed` | `reviewed` | `stale` (reviewed, но
 * `checkedAt + staleDays < now`; дни — календарные по Kyiv). Свежесть не гарантирует актуальность
 * правил — это только срок, после которого человек должен перепроверить.
 *
 * `policyGate` (таблица §M1.3): причины копятся все; вердикт — `block`, если
 * есть хоть одна блокирующая; иначе `recheck_required` при `stale`; иначе
 * `ok`. `links_restricted` при ссылке — WARN, вердикт не меняет.
 */
import type {
  RedditGateView,
  RedditPolicyReason,
  RedditPolicyWarning,
  RedditSnapshotState,
} from '../contracts/reddit-api';
import type {
  RedditLinksPolicy,
  RedditPromotionPolicy,
  RedditReviewState,
} from '../contracts/states';
import { addKyivCalendarDays } from '../core/kyiv-time';

export const STALE_DAYS_DEFAULT = 30;
export const STALE_DAYS_MIN = 1;
export const STALE_DAYS_MAX = 365;

/** Поля снимка, нужные гейту. */
export interface PolicySnapshot {
  reviewState: RedditReviewState;
  checkedAt: Date;
  promotionPolicy: RedditPromotionPolicy;
  linksPolicy: RedditLinksPolicy;
  /**
   * Первоисточник снимка отозван (`pub_sources.usage='revoked'`): вывода о
   * правилах без действующего источника нет — `block` (аудит P-R S2-2).
   */
  sourceRevoked?: boolean;
}

/** Что проверяется: возможность (ответ без текста), пост или комментарий (M2). */
export type PolicyContentKind = 'opportunity' | 'post' | 'comment';

/** Допустимое значение параметра `reddit_rules_stale_days` (иначе умолчание). */
export function staleDaysOf(value: unknown): number {
  const d = (value as { days?: unknown } | null)?.days;
  return typeof d === 'number' &&
    Number.isInteger(d) &&
    d >= STALE_DAYS_MIN &&
    d <= STALE_DAYS_MAX
    ? d
    : STALE_DAYS_DEFAULT;
}

export function snapshotState(
  snapshot: Pick<PolicySnapshot, 'reviewState' | 'checkedAt'>,
  now: Date,
  staleDays: number,
): RedditSnapshotState {
  if (snapshot.reviewState !== 'reviewed') return 'unreviewed';
  // Календарные дни Kyiv (переход DST не сдвигает срок, §20 проекта).
  return addKyivCalendarDays(snapshot.checkedAt, staleDays).getTime() <
    now.getTime()
    ? 'stale'
    : 'reviewed';
}

const BLOCKING: ReadonlySet<RedditPolicyReason> = new Set([
  'rules_missing',
  'rules_source_revoked',
  'rules_unreviewed',
  'promotion_prohibited',
  'promotion_unknown',
  'links_unknown',
  'links_prohibited',
]);

export function policyGate(
  snapshot: PolicySnapshot | null,
  now: Date,
  staleDays: number,
  // Вид материала нужен проверкам M2 (comment/post); в M1 гейт одинаков.
  _contentKind: PolicyContentKind,
  hasLinks: boolean,
): RedditGateView {
  if (!snapshot) {
    return { verdict: 'block', reasons: ['rules_missing'], warnings: [] };
  }
  const reasons: RedditPolicyReason[] = [];
  const warnings: RedditPolicyWarning[] = [];
  const state = snapshotState(snapshot, now, staleDays);
  if (snapshot.sourceRevoked) reasons.push('rules_source_revoked');
  if (state === 'unreviewed') reasons.push('rules_unreviewed');
  if (state === 'stale') reasons.push('rules_stale');
  if (snapshot.promotionPolicy === 'prohibited')
    reasons.push('promotion_prohibited');
  if (snapshot.promotionPolicy === 'unknown') reasons.push('promotion_unknown');
  if (snapshot.linksPolicy === 'unknown') reasons.push('links_unknown');
  if (snapshot.linksPolicy === 'prohibited' && hasLinks)
    reasons.push('links_prohibited');
  if (snapshot.linksPolicy === 'restricted' && hasLinks)
    warnings.push('links_restricted');
  const verdict = reasons.some((r) => BLOCKING.has(r))
    ? 'block'
    : reasons.includes('rules_stale')
      ? 'recheck_required'
      : 'ok';
  return { verdict, reasons, warnings };
}

/**
 * Риск политики из снимка (§M1.4): при `promotionPolicy =
 * allowed_with_conditions` ссылки `allowed` → 20, `restricted` → 50,
 * `prohibited` → 60 (пост без ссылок возможен; ссылка даст BLOCK в M2.4);
 * `unknown` (любая политика), `promotionPolicy = prohibited` или снимка
 * нет → 100 (и вердикт уже `block`).
 */
export function policyRisk(
  snapshot: Pick<PolicySnapshot, 'promotionPolicy' | 'linksPolicy'> | null,
): number {
  if (!snapshot || snapshot.promotionPolicy !== 'allowed_with_conditions')
    return 100;
  switch (snapshot.linksPolicy) {
    case 'allowed':
      return 20;
    case 'restricted':
      return 50;
    case 'prohibited':
      return 60;
    default:
      return 100;
  }
}

/**
 * Машиночитаемое обоснование `policy_risk` (коды, без текста — экран
 * переводит сам): `rules_missing` либо `promotion_<политика>` и
 * `links_<политика>` снимка.
 */
export function policyRiskReasons(
  snapshot: Pick<PolicySnapshot, 'promotionPolicy' | 'linksPolicy'> | null,
): string[] {
  if (!snapshot) return ['rules_missing'];
  return [
    `promotion_${snapshot.promotionPolicy}`,
    `links_${snapshot.linksPolicy}`,
  ];
}
