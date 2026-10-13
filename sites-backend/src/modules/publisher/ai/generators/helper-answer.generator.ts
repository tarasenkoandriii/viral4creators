/**
 * Генератор `pub.helper.answer` — внутренний helper (P-B2, проектный
 * документ §12.2; допущен в P0 — 22 задачи набора). Режим `public` получает
 * только `visibility=public` источники и активный оффер (§12.3, AI-26).
 */
import type { GeneratorSpec } from '../../contracts/ai';
import {
  HELPER_ANSWER_SCHEMA,
  type HelperAnswerOutput,
} from '../../contracts/ai-schemas';
import * as instr from '../instructions/helper-answer.v1';
import { commonPostCheck, prompt, renderRequest } from './common';

export interface HelperAnswerInput {
  question: string;
  audience: 'internal' | 'public';
}

export const HELPER_ANSWER: GeneratorSpec<
  HelperAnswerInput,
  HelperAnswerOutput
> = {
  id: 'pub.helper.answer',
  instructionVersion: instr.INSTRUCTION_VERSION,
  contextRulesVersion: 'ctx@1',
  schema: HELPER_ANSWER_SCHEMA,
  enabledInP0: true,
  maxOutputTokens: 1500,
  buildPrompt: (input, ctx) =>
    prompt(instr.INSTRUCTION_TEXT, ctx, [
      `Режим: ${input.audience}.`,
      renderRequest('question', input.question),
    ]),
  postCheck: (out, ctx) => commonPostCheck(out, ctx),
};
