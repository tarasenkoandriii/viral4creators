/**
 * AI Publisher, P-R — Opportunity Score v1 (reddit-manual-mvp-adapted.md
 * §M1.4; AT-RD-06). Чистая детерминированная функция: одинаковые входы —
 * побайтно одинаковый результат (только целочисленная арифметика, порядок
 * ключей фиксирован `REDDIT_SCORE_FACTORS`).
 *
 *   relevance = round(.35·topic_fit + .25·intent_fit + .20·audience_fit + .20·answerability)
 *   risk      = round(.40·policy_risk + .25·promotionality + .20·evidence_gap + .15·context_uncertainty)
 *   priority  = round(relevance · (1 − risk/100))   — только для сортировки
 *
 * Веса — начальные, не эмпирические: константы версии `v1` (новые веса —
 * новая версия). Пропущенный фактор не превращается в 0: группа с `null` —
 * `null` («не рассчитано»), фактор — в `missing`. `policy_risk` оператор не
 * вводит — он выводится из снимка правил (`policy.ts` `policyRisk`). Score
 * не снимает BLOCK (гейт — отдельно, триггер держит `qualified` только при
 * `policy=ok`).
 */
import type {
  RedditFactors,
  RedditFactorsInput,
  RedditScoreView,
} from '../contracts/reddit-api';
import {
  REDDIT_SCORE_FACTORS,
  type RedditScoreFactor,
} from '../contracts/states';

export const SCORE_VERSION = 'v1' as const;

/** Веса v1 в сотых (сумма группы = 100). */
export const SCORE_WEIGHTS_V1 = {
  relevance: {
    topic_fit: 35,
    intent_fit: 25,
    audience_fit: 20,
    answerability: 20,
  },
  risk: {
    policy_risk: 40,
    promotionality: 25,
    evidence_gap: 20,
    context_uncertainty: 15,
  },
} as const satisfies Record<
  'relevance' | 'risk',
  Partial<Record<RedditScoreFactor, number>>
>;

/** Округление неотрицательной дроби `num/den` «половина вверх» без float. */
function roundDiv(num: number, den: number): number {
  return Math.floor((2 * num + den) / (2 * den));
}

function group(
  weights: Partial<Record<RedditScoreFactor, number>>,
  factors: RedditFactors,
  missing: RedditScoreFactor[],
): number | null {
  let sum = 0;
  let complete = true;
  for (const k of REDDIT_SCORE_FACTORS) {
    const w = weights[k];
    if (w === undefined) continue;
    const v = factors[k].value;
    if (v === null) {
      complete = false;
      missing.push(k);
      continue;
    }
    sum += w * v;
  }
  return complete ? roundDiv(sum, 100) : null;
}

/** Score v1 по полному набору факторов (с выведенным `policy_risk`). */
export function computeScore(factors: RedditFactors): RedditScoreView {
  const missing: RedditScoreFactor[] = [];
  const relevance = group(SCORE_WEIGHTS_V1.relevance, factors, missing);
  const risk = group(SCORE_WEIGHTS_V1.risk, factors, missing);
  const priority =
    relevance === null || risk === null
      ? null
      : roundDiv(relevance * (100 - risk), 100);
  return {
    scoreVersion: SCORE_VERSION,
    relevance,
    risk,
    priority,
    missing: REDDIT_SCORE_FACTORS.filter((k) => missing.includes(k)),
  };
}

/** Пустой набор факторов (все «не оценено»). */
export function emptyFactors(): RedditFactors {
  const out = Object.fromEntries(
    REDDIT_SCORE_FACTORS.map((k) => [k, { value: null, why: null }]),
  ) as RedditFactors;
  out.policy_risk = { value: null, why: null, reasons: [] };
  return out;
}

/** Факторы из jsonb-колонки (неизвестные ключи и формы отбрасываются). */
export function factorsFromJson(raw: unknown): RedditFactors {
  const out = emptyFactors();
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const k of REDDIT_SCORE_FACTORS) {
    const f = (raw as Record<string, unknown>)[k] as
      { value?: unknown; why?: unknown; reasons?: unknown } | undefined;
    if (!f || typeof f !== 'object') continue;
    out[k] = {
      value: typeof f.value === 'number' ? f.value : null,
      why: typeof f.why === 'string' ? f.why : null,
    };
    if (k === 'policy_risk')
      out[k].reasons = Array.isArray(f.reasons)
        ? f.reasons.filter((x): x is string => typeof x === 'string')
        : [];
  }
  return out;
}

/**
 * Слияние ввода оператора (уже проверенного) с прежними факторами и
 * выведенным `policy_risk`: обоснование — коды `reasons`
 * (`policyRiskReasons`), `why: null` — экран переводит коды сам.
 */
export function mergeFactors(
  prev: RedditFactors,
  input: RedditFactorsInput | undefined,
  policyRiskValue: number,
  policyRiskReasons: string[],
): RedditFactors {
  const out: RedditFactors = { ...prev };
  for (const [k, v] of Object.entries(input ?? {})) {
    if (!v) continue;
    out[k as RedditScoreFactor] = { value: v.value, why: v.why ?? null };
  }
  out.policy_risk = {
    value: policyRiskValue,
    why: null,
    reasons: [...policyRiskReasons],
  };
  return out;
}
