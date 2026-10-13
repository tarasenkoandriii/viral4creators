/**
 * Генератор `pub.draft.write` — черновик статьи (P-B2, проектный документ
 * §12.2). В P0 ВЫКЛЮЧЕН (ДТ-2, Р-PUB-31); реализован и проверяется на фейке.
 */
import {
  DRAFT_WRITE_SCHEMA,
  type DraftWriteOutput,
} from '../../contracts/ai-schemas';
import * as instr from '../instructions/draft-write.v1';
import { commonPostCheck, prompt, renderRequest } from './common';
import type { PubGeneratorSpec } from './spec';

export interface DraftWriteInput {
  /** Готовый бриф текстом (вопрос, короткий ответ, структура, CTA). */
  brief: string;
}

export const DRAFT_WRITE: PubGeneratorSpec<DraftWriteInput, DraftWriteOutput> =
  {
    id: 'pub.draft.write',
    instructionVersion: instr.INSTRUCTION_VERSION,
    contextRulesVersion: 'ctx@1',
    schema: DRAFT_WRITE_SCHEMA,
    enabledInP0: false,
    maxOutputTokens: 8000,
    buildPrompt: (input, ctx) =>
      prompt(instr.INSTRUCTION_TEXT, ctx, [
        renderRequest('brief', input.brief),
      ]),
    postCheck: (out, ctx) => commonPostCheck(out, ctx),
  };
