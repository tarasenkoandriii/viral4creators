/**
 * Генератор `pub.claims.extract` — извлечение claims F04 (P-B2, проектный
 * документ §12.2; QA-схема). В P0 ВЫКЛЮЧЕН (ДТ-2, Р-PUB-31): claims вводит
 * редактор (AT-F04-01); реализован и проверяется на фейке.
 */
import {
  QA_REVIEW_SCHEMA,
  type QaReviewOutput,
} from '../../contracts/ai-schemas';
import * as instr from '../instructions/claims-extract.v1';
import { commonPostCheck, prompt, renderRequest } from './common';
import { qaFindings, type QaReviewInput } from './qa-review.generator';
import type { PubGeneratorSpec } from './spec';

export const CLAIMS_EXTRACT: PubGeneratorSpec<QaReviewInput, QaReviewOutput> = {
  id: 'pub.claims.extract',
  instructionVersion: instr.INSTRUCTION_VERSION,
  contextRulesVersion: 'ctx@1',
  schema: QA_REVIEW_SCHEMA,
  enabledInP0: false,
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
