/**
 * AI Publisher — схемы ответа девяти генераторов (контракт P-A1, проектный
 * документ §12.2; генераторы — P-B2 `publisher/ai/generators/*`).
 *
 * Все поля обязательны; `null` — только где указано; строки ≤ 2000,
 * массивы ≤ 30 (умолчания schema-lite), кроме `body_markdown` черновика
 * статьи (≤ 20 000: статья не помещается в 2000 — Р-PUB-A1-11; генератор
 * в P0 выключен). `used_source_ids`/`source_ids` — подмножество переданных
 * (нарушение — ошибка схемы, критическая): `sourceIdsOf` собирает их.
 *
 * Схемы — объекты schema-lite (строгие: лишний ключ — ошибка). В P0
 * рабочий AI — только у четырёх первых (`P0_ENABLED_GENERATORS`).
 */
import { s, type Infer, type SchemaLite } from '../core/schema-lite';
import type { GeneratorId } from './ai';
import {
  CLAIM_RISKS,
  CLAIM_TYPES,
  QUESTION_SCORE_KEYS,
  QUESTION_STAGES,
  VENUE_CRITERIA,
} from './states';

const str = (max = 2000) => s.string({ min: 1, max });
const strs = (max = 30) => s.array(s.string({ min: 1, max: 2000 }), { max });
const ids = () => s.array(s.string({ min: 1, max: 100 }), { max: 30 });
const score = () => s.nullable(s.int({ min: 0, max: 2 }));

export const HELPER_ANSWER_SCHEMA = s.object({
  answer: str(),
  used_source_ids: ids(),
  unknowns: strs(),
  next_action: str(),
});
export type HelperAnswerOutput = Infer<typeof HELPER_ANSWER_SCHEMA>;

export const BRIEF_DRAFT_SCHEMA = s.object({
  question: str(),
  audience: s.nullable(str()),
  source_ids: ids(),
  original_contribution: s.nullable(str()),
  short_answer: str(),
  structure: strs(),
  format: s.enum(['instruction', 'case_review', 'choice_guide'] as const),
  cta: s.object({ text: str(), intent_fit_note: str() }),
  channels: strs(),
  limitations: strs(),
  unresolved_questions: strs(),
});
export type BriefDraftOutput = Infer<typeof BRIEF_DRAFT_SCHEMA>;

/** QA-схема (`pub.qa.review` и `pub.claims.extract`). */
export const QA_REVIEW_SCHEMA = s.object({
  object_version: str(100),
  claims: s.array(
    s.object({
      statement: str(1000),
      type: s.enum(CLAIM_TYPES),
      risk: s.enum(CLAIM_RISKS),
      source_ids: ids(),
      supported: s.enum(['yes', 'no', 'unknown'] as const),
    }),
  ),
  blockers: s.array(
    s.object({
      code: s.string({ min: 1, max: 64, pattern: /^[a-z0-9_.-]+$/ }),
      text: str(),
      claim_index: s.nullable(s.int({ min: 0, max: 29 })),
    }),
  ),
  unresolved_questions: strs(),
  recommendation: str(),
});
export type QaReviewOutput = Infer<typeof QA_REVIEW_SCHEMA>;

export const ADAPTATION_MAKE_SCHEMA = s.refine(
  s.object({
    parent_version: str(100),
    format: s.enum(['post', 'cards', 'checklist', 'video_script'] as const),
    title: str(300),
    body: s.nullable(str()),
    cards: s.nullable(s.array(s.object({ title: str(300), text: str() }))),
    scenes: s.nullable(
      s.array(s.object({ visual: str(), voice: str(), caption: str() })),
    ),
    is_script: s.boolean(),
    cta: str(),
    used_source_ids: ids(),
    preserved_caveats: strs(),
    unresolved_questions: strs(),
  }),
  (v) =>
    (v.format === 'video_script') === v.is_script
      ? null
      : { field: 'is_script', code: 'video_script_flag' },
);
export type AdaptationMakeOutput = Infer<typeof ADAPTATION_MAKE_SCHEMA>;

const scoreWhy = () => s.object({ score: score(), why: str() });

export const QUESTIONS_CLUSTER_SCHEMA = s.object({
  groups: s.array(
    s.object({
      key: s.string({ min: 1, max: 64, pattern: /^[a-z0-9][a-z0-9_-]*$/ }),
      task: str(),
      stage: s.enum(QUESTION_STAGES),
      audience: s.nullable(str()),
      question_ids: ids(),
      rationale: str(),
      merge_risk: s.nullable(str()),
      suggested_scores: s.object(
        Object.fromEntries(
          QUESTION_SCORE_KEYS.map((k) => [k, scoreWhy()]),
        ) as Record<
          (typeof QUESTION_SCORE_KEYS)[number],
          ReturnType<typeof scoreWhy>
        >,
      ),
    }),
  ),
  unclustered_question_ids: ids(),
  unresolved_questions: strs(),
});
export type QuestionsClusterOutput = Infer<typeof QUESTIONS_CLUSTER_SCHEMA>;

export const DRAFT_WRITE_SCHEMA = s.object({
  title: str(300),
  short_answer: str(),
  body_markdown: str(20_000),
  example: str(),
  limitations: strs(),
  used_source_ids: ids(),
  claim_candidates: s.array(
    s.object({
      statement: str(1000),
      type: s.enum(CLAIM_TYPES),
      source_ids: ids(),
    }),
  ),
  unresolved_questions: strs(),
});
export type DraftWriteOutput = Infer<typeof DRAFT_WRITE_SCHEMA>;

export const DISTRIBUTION_PLAN_SCHEMA = s.object({
  actions: s.array(
    s.object({
      version_id: str(100),
      channel_id: str(100),
      format: str(100),
      goal: str(),
      proposed_date: s.string({
        min: 10,
        max: 10,
        pattern: /^\d{4}-\d{2}-\d{2}$/,
      }),
      owner_role: s.enum(['product_owner', 'editor', 'operator'] as const),
      requires_measurable_link: s.boolean(),
      note: str(),
    }),
  ),
  blocked: s.array(s.object({ channel_id: str(100), reason: str() })),
  unresolved_questions: strs(),
});
export type DistributionPlanOutput = Infer<typeof DISTRIBUTION_PLAN_SCHEMA>;

const criterion = () =>
  s.object({ score: score(), why: str(), evidence_source_ids: ids() });

export const VENUES_COMPARE_SCHEMA = s.object({
  venues: s.array(
    s.object({
      venue_id: str(100),
      criteria: s.object(
        Object.fromEntries(
          VENUE_CRITERIA.map((k) => [k, criterion()]),
        ) as Record<
          (typeof VENUE_CRITERIA)[number],
          ReturnType<typeof criterion>
        >,
      ),
      gaps: strs(),
      risks: strs(),
    }),
  ),
  unresolved_questions: strs(),
});
export type VenuesCompareOutput = Infer<typeof VENUES_COMPARE_SCHEMA>;

/**
 * `pub.reddit.draft` (P-R M2, §M2.3): 2–3 варианта одним вызовом
 * (Р-RD-15). `title` — null у комментария (проверка против входа —
 * `inputIssues` генератора), `disclosure` пуст только при `affiliation=none`
 * (находка `disclosure_missing`); `source_ids` пункта claim_map —
 * подмножество переданных или пометка `needs_verification`.
 */
export const REDDIT_DRAFT_SCHEMA = s.object({
  variants: s.array(
    s.object({
      title: s.nullable(str(300)),
      body: str(10_000),
      disclosure: s.string({ min: 0, max: 300 }),
      flair_suggestion: s.nullable(str(64)),
      claim_map: s.array(
        s.object({
          text: str(500),
          source_ids: s.union(
            s.array(s.string({ min: 1, max: 100 }), { min: 1, max: 10 }),
            s.literal('needs_verification'),
          ),
        }),
      ),
      uncertainties: s.array(str(500), { max: 20 }),
    }),
    { min: 2, max: 3 },
  ),
});
export type RedditDraftOutput = Infer<typeof REDDIT_DRAFT_SCHEMA>;

export const GENERATOR_SCHEMAS: Record<GeneratorId, SchemaLite<unknown>> = {
  'pub.helper.answer': HELPER_ANSWER_SCHEMA,
  'pub.brief.draft': BRIEF_DRAFT_SCHEMA,
  'pub.qa.review': QA_REVIEW_SCHEMA,
  'pub.adaptation.make': ADAPTATION_MAKE_SCHEMA,
  'pub.questions.cluster': QUESTIONS_CLUSTER_SCHEMA,
  'pub.draft.write': DRAFT_WRITE_SCHEMA,
  'pub.claims.extract': QA_REVIEW_SCHEMA,
  'pub.distribution.plan': DISTRIBUTION_PLAN_SCHEMA,
  'pub.venues.compare': VENUES_COMPARE_SCHEMA,
  'pub.reddit.draft': REDDIT_DRAFT_SCHEMA,
};

/** Схема набора задач для генератора (`pub_ai_eval_results.schema`). */
export const EVAL_SCHEMA_OF: Partial<
  Record<GeneratorId, 'answer' | 'brief' | 'qa' | 'adaptation' | 'reddit'>
> = {
  'pub.helper.answer': 'answer',
  'pub.brief.draft': 'brief',
  'pub.qa.review': 'qa',
  'pub.adaptation.make': 'adaptation',
  'pub.reddit.draft': 'reddit',
};

/**
 * Все id источников в ответе (для проверки «подмножество переданных»):
 * `used_source_ids`, `source_ids`, `evidence_source_ids` на любой глубине.
 */
export function sourceIdsOf(output: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v === null || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (
        (k === 'used_source_ids' ||
          k === 'source_ids' ||
          k === 'evidence_source_ids') &&
        Array.isArray(x)
      ) {
        for (const id of x) if (typeof id === 'string') out.add(id);
      } else {
        walk(x);
      }
    }
  };
  walk(output);
  return [...out];
}

/** id источников ответа вне разрешённых (непусто — критическая ошибка схемы). */
export function sourceIdsOutside(
  output: unknown,
  allowed: readonly string[],
): string[] {
  const ok = new Set(allowed);
  return sourceIdsOf(output).filter((id) => !ok.has(id));
}
