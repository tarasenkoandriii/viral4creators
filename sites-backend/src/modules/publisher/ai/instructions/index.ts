/**
 * AI Publisher — реестр инструкций генераторов (P-B2, проектный документ
 * §12.4). Тексты — `instructions/<генератор>.v<N>.ts` (украинский рабочий
 * язык), версия — константа `INSTRUCTION_VERSION` файла.
 *
 * `INSTRUCTION_SHA256` — записанный hash текста каждой версии. Тест
 * `instructions.spec.ts` сверяет его с фактическим: правка текста без
 * смены версии роняет тест; смена версии меняет `configHash` (новая
 * конфигурация `not_run`), и привязка рабочего продукта к прежней
 * конфигурации перестаёт подходить вызову (§12.4, ТЗ §28).
 */
import type { GeneratorId } from '../../contracts/ai';
import * as adaptation from './adaptation-make.v1';
import * as brief from './brief-draft.v1';
import * as claims from './claims-extract.v1';
import * as distribution from './distribution-plan.v1';
import * as draft from './draft-write.v1';
import * as helper from './helper-answer.v1';
import * as qa from './qa-review.v1';
import * as cluster from './questions-cluster.v1';
import * as venues from './venues-compare.v1';

export interface Instruction {
  version: string;
  text: string;
}

const of = (m: {
  INSTRUCTION_VERSION: string;
  INSTRUCTION_TEXT: string;
}): Instruction => ({
  version: m.INSTRUCTION_VERSION,
  text: m.INSTRUCTION_TEXT,
});

export const INSTRUCTIONS: Readonly<Record<GeneratorId, Instruction>> = {
  'pub.helper.answer': of(helper),
  'pub.brief.draft': of(brief),
  'pub.qa.review': of(qa),
  'pub.adaptation.make': of(adaptation),
  'pub.questions.cluster': of(cluster),
  'pub.draft.write': of(draft),
  'pub.claims.extract': of(claims),
  'pub.distribution.plan': of(distribution),
  'pub.venues.compare': of(venues),
};

/** Записанный sha256 текста версии инструкции (правка без новой версии — тест падает). */
export const INSTRUCTION_SHA256: Readonly<Record<string, string>> = {
  'pub.helper.answer@1':
    '31fa024018847b97d0e56234fadc825952e53c756aa6c9a3358118ef61bcb32d',
  'pub.brief.draft@1':
    '73040de7790a01b9ea52c729c34e3f2fb580955e06b48f62b1e355fd1ec104f8',
  'pub.qa.review@1':
    '4cc7332dc85e3a7df240d423ff7b757eeebee5cbbe105275e06fc9f0046e9d87',
  'pub.adaptation.make@1':
    'a2d1c80284b9e9b8830f406187789314936eaeda43c63765b3cf2bd670b745c7',
  'pub.questions.cluster@1':
    '64da5660f4eb0791ef8aaaa49e345e9fc2864ae5b7291fc2b7e89e29ad54ab3a',
  'pub.draft.write@1':
    'e0583f6f8c78f95717ce7aa4ed1268497a87ddbfce61cff546adbf242f4eef0d',
  'pub.claims.extract@1':
    '35f70bf6b20a0915a0929339fe01fb4e4374094b9b6c3913daac4a731e0f45cf',
  'pub.distribution.plan@1':
    'b192040440d017b18552c1582c54ee210c07fff8782b4ed5ae2833d6773c3454',
  'pub.venues.compare@1':
    'e3930af74f2960d140e8023048c111b4e7dd36aa2cdf5346a14764da11590317',
};
