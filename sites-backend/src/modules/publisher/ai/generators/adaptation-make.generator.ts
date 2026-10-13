/**
 * Генератор `pub.adaptation.make` — адаптация F06 (P-B2, проектный документ
 * §12.2; допущен в P0 — AI-11…AI-16). Для `video_script` — `is_script=true`
 * (схема), `parent_version` — метка из запроса.
 */
import type { GeneratorSpec } from '../../contracts/ai';
import {
  ADAPTATION_MAKE_SCHEMA,
  type AdaptationMakeOutput,
} from '../../contracts/ai-schemas';
import * as instr from '../instructions/adaptation-make.v1';
import { commonPostCheck, prompt, renderRequest } from './common';

export type AdaptationFormat = 'post' | 'cards' | 'checklist' | 'video_script';

export interface AdaptationMakeInput {
  /** Метка батьківської версії (`parent_version` ответа). */
  parentVersion: string;
  format: AdaptationFormat;
  /** Запрос редактора (длина, канал, подача). */
  request: string;
  /** Текст батьківської версії (материал); в наборе задач — источник. */
  parentTitle: string | null;
  parentBody: string | null;
}

export const ADAPTATION_MAKE: GeneratorSpec<
  AdaptationMakeInput,
  AdaptationMakeOutput
> = {
  id: 'pub.adaptation.make',
  instructionVersion: instr.INSTRUCTION_VERSION,
  contextRulesVersion: 'ctx@1',
  schema: ADAPTATION_MAKE_SCHEMA,
  enabledInP0: true,
  maxOutputTokens: 2500,
  buildPrompt: (input, ctx) =>
    prompt(instr.INSTRUCTION_TEXT, ctx, [
      // Аудит S3-9: метка версии (slug — ввод человека) и формат — тоже
      // данные в экранированной разметке, не текст инструкции.
      renderRequest(
        'target',
        `Батьківська версія: ${input.parentVersion}. Формат: ${input.format}.`,
      ),
      ...(input.parentBody
        ? [
            renderRequest(
              'parent_version',
              `${input.parentTitle ? `${input.parentTitle}\n\n` : ''}${input.parentBody}`,
            ),
          ]
        : []),
      renderRequest('request', input.request),
    ]),
  postCheck: (out, ctx) => {
    const findings = commonPostCheck(out, ctx);
    if (out.format !== 'video_script' && out.scenes !== null) {
      findings.push({
        code: 'scenes_outside_script',
        severity: 'warning',
        text: 'Сцени заповнені не для сценарію',
      });
    }
    return findings;
  },
};
