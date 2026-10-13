/**
 * Генератор `pub.qa.review` — AI-проверка версии (F04; P-B2, проектный
 * документ §12.2; допущен в P0 — AI-06). Результат — предложение
 * редактору: `ai_review` никогда не даёт `pass` для выпуска (§12.5).
 */
import type { GeneratorSpec } from '../../contracts/ai';
import {
  QA_REVIEW_SCHEMA,
  type QaReviewOutput,
} from '../../contracts/ai-schemas';
import * as instr from '../instructions/qa-review.v1';
import { commonPostCheck, prompt, renderRequest } from './common';

export interface QaReviewInput {
  /** Метка версии (`object_version` ответа). */
  versionLabel: string;
  title: string | null;
  body: string;
}

/** Критический claim «supported=yes» без источника — находка человеку. */
export function qaFindings(out: QaReviewOutput) {
  return out.claims
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.supported === 'yes' && c.source_ids.length === 0)
    .map(({ i }) => ({
      code: 'supported_without_source',
      severity: 'critical' as const,
      text: `Твердження #${i} позначене підтвердженим без джерела`,
    }));
}

export const QA_REVIEW: GeneratorSpec<QaReviewInput, QaReviewOutput> = {
  id: 'pub.qa.review',
  instructionVersion: instr.INSTRUCTION_VERSION,
  contextRulesVersion: 'ctx@1',
  schema: QA_REVIEW_SCHEMA,
  enabledInP0: true,
  maxOutputTokens: 3000,
  buildPrompt: (input, ctx) =>
    prompt(instr.INSTRUCTION_TEXT, ctx, [
      `Версія: ${input.versionLabel}`,
      renderRequest(
        'version',
        `${input.title ? `${input.title}\n\n` : ''}${input.body}`,
      ),
    ]),
  postCheck: (out, ctx) => [...commonPostCheck(out, ctx), ...qaFindings(out)],
};
