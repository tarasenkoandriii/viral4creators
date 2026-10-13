/**
 * Генератор `pub.questions.cluster` — группировка вопросов F01 (P-B2,
 * проектный документ §12.2). В P0 ВЫКЛЮЧЕН (ДТ-2, Р-PUB-31): набор 30 задач
 * его схему не покрывает; группировка — вручную. Реализован и проверяется
 * на фейке.
 */
import {
  QUESTIONS_CLUSTER_SCHEMA,
  type QuestionsClusterOutput,
} from '../../contracts/ai-schemas';
import * as instr from '../instructions/questions-cluster.v1';
import { commonPostCheck, idsOutside, prompt, renderRequest } from './common';
import { outsideIssues, type PubGeneratorSpec } from './spec';

export interface QuestionsClusterInput {
  questions: Array<{ id: string; text: string }>;
}

export const QUESTIONS_CLUSTER: PubGeneratorSpec<
  QuestionsClusterInput,
  QuestionsClusterOutput
> = {
  id: 'pub.questions.cluster',
  instructionVersion: instr.INSTRUCTION_VERSION,
  contextRulesVersion: 'ctx@1',
  schema: QUESTIONS_CLUSTER_SCHEMA,
  enabledInP0: false,
  maxOutputTokens: 3000,
  buildPrompt: (input, ctx) =>
    prompt(instr.INSTRUCTION_TEXT, ctx, [
      renderRequest(
        'questions',
        input.questions.map((q) => `[${q.id}] ${q.text}`).join('\n'),
      ),
    ]),
  postCheck: (out, ctx) => commonPostCheck(out, ctx),
  inputIssues: (out, input) =>
    outsideIssues(
      'question_ids',
      idsOutside(
        [
          ...out.groups.flatMap((g) => g.question_ids),
          ...out.unclustered_question_ids,
        ],
        input.questions.map((q) => q.id),
      ),
    ),
};
