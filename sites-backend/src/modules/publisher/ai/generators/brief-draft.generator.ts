/**
 * Генератор `pub.brief.draft` — черновик брифа F03 (P-B2, проектный документ
 * §12.2; допущен в P0 — AI-20). Не придуманная аудитория — `null` и вопрос
 * в `unresolved_questions`.
 */
import type { GeneratorSpec } from '../../contracts/ai';
import {
  BRIEF_DRAFT_SCHEMA,
  type BriefDraftOutput,
} from '../../contracts/ai-schemas';
import * as instr from '../instructions/brief-draft.v1';
import { commonPostCheck, prompt, renderRequest } from './common';

export interface BriefDraftInput {
  /** Текст вопроса F01 (или запрос редактора в наборе задач). */
  question: string;
  /** Пожелания редактора к формату (необязательно). */
  notes?: string | null;
}

export const BRIEF_DRAFT: GeneratorSpec<BriefDraftInput, BriefDraftOutput> = {
  id: 'pub.brief.draft',
  instructionVersion: instr.INSTRUCTION_VERSION,
  contextRulesVersion: 'ctx@1',
  schema: BRIEF_DRAFT_SCHEMA,
  enabledInP0: true,
  maxOutputTokens: 2000,
  buildPrompt: (input, ctx) =>
    prompt(instr.INSTRUCTION_TEXT, ctx, [
      renderRequest('question', input.question),
      ...(input.notes ? [renderRequest('notes', input.notes)] : []),
    ]),
  postCheck: (out, ctx) => {
    const findings = commonPostCheck(out, ctx);
    if (out.source_ids.length === 0) {
      findings.push({
        code: 'brief_without_source',
        severity: 'warning',
        text: 'Бриф без джерела не може стати готовим (F03)',
      });
    }
    return findings;
  },
};
