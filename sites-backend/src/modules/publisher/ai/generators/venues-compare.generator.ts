/**
 * Генератор `pub.venues.compare` — сводка площадок F10 (P-B2, проектный
 * документ §12.2). В P0 ВЫКЛЮЧЕН (ДТ-2, Р-PUB-31): сравнение по карточкам
 * вручную. Полей прогноза переходов в схеме нет.
 */
import {
  VENUES_COMPARE_SCHEMA,
  type VenuesCompareOutput,
} from '../../contracts/ai-schemas';
import * as instr from '../instructions/venues-compare.v1';
import { commonPostCheck, idsOutside, prompt, renderRequest } from './common';
import { outsideIssues, type PubGeneratorSpec } from './spec';

export interface VenuesCompareInput {
  venues: Array<{ id: string; name: string; card: string }>;
}

export const VENUES_COMPARE: PubGeneratorSpec<
  VenuesCompareInput,
  VenuesCompareOutput
> = {
  id: 'pub.venues.compare',
  instructionVersion: instr.INSTRUCTION_VERSION,
  contextRulesVersion: 'ctx@1',
  schema: VENUES_COMPARE_SCHEMA,
  enabledInP0: false,
  maxOutputTokens: 3000,
  buildPrompt: (input, ctx) =>
    prompt(instr.INSTRUCTION_TEXT, ctx, [
      renderRequest(
        'venues',
        input.venues.map((v) => `[${v.id}] ${v.name}\n${v.card}`).join('\n\n'),
      ),
    ]),
  postCheck: (out, ctx) => commonPostCheck(out, ctx),
  inputIssues: (out, input) =>
    outsideIssues(
      'venue_id',
      idsOutside(
        out.venues.map((v) => v.venue_id),
        input.venues.map((v) => v.id),
      ),
    ),
};
