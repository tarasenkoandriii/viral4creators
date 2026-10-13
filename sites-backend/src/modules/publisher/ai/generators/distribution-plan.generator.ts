/**
 * Генератор `pub.distribution.plan` — план распространения F09 (P-B2,
 * проектный документ §12.2). В P0 ВЫКЛЮЧЕН (ДТ-2, Р-PUB-31): календарь —
 * вручную (AT-F09-01). Дата и канал — только из переданных; канал
 * `adsAllowed=false` для промо — только в `blocked`.
 */
import type { FieldIssue } from '../../contracts/errors';
import {
  DISTRIBUTION_PLAN_SCHEMA,
  type DistributionPlanOutput,
} from '../../contracts/ai-schemas';
import * as instr from '../instructions/distribution-plan.v1';
import { commonPostCheck, idsOutside, prompt, renderRequest } from './common';
import { outsideIssues, type PubGeneratorSpec } from './spec';

export interface DistributionPlanInput {
  versions: Array<{ id: string; title: string }>;
  channels: Array<{ id: string; name: string; adsAllowed: boolean | null }>;
  /** Окно дат `YYYY-MM-DD` включительно. */
  from: string;
  to: string;
}

export const DISTRIBUTION_PLAN: PubGeneratorSpec<
  DistributionPlanInput,
  DistributionPlanOutput
> = {
  id: 'pub.distribution.plan',
  instructionVersion: instr.INSTRUCTION_VERSION,
  contextRulesVersion: 'ctx@1',
  schema: DISTRIBUTION_PLAN_SCHEMA,
  enabledInP0: false,
  maxOutputTokens: 2500,
  buildPrompt: (input, ctx) =>
    prompt(instr.INSTRUCTION_TEXT, ctx, [
      renderRequest(
        'versions',
        input.versions.map((v) => `[${v.id}] ${v.title}`).join('\n'),
      ),
      renderRequest(
        'channels',
        input.channels
          .map(
            (c) =>
              `[${c.id}] ${c.name}; реклама: ${c.adsAllowed === null ? 'невідомо' : c.adsAllowed ? 'дозволена' : 'заборонена'}`,
          )
          .join('\n'),
      ),
      `Вікно дат: ${input.from} … ${input.to}`,
    ]),
  postCheck: (out, ctx) => commonPostCheck(out, ctx),
  inputIssues: (out, input) => {
    const issues: FieldIssue[] = [
      ...outsideIssues(
        'version_id',
        idsOutside(
          out.actions.map((a) => a.version_id),
          input.versions.map((v) => v.id),
        ),
      ),
      ...outsideIssues(
        'channel_id',
        idsOutside(
          [
            ...out.actions.map((a) => a.channel_id),
            ...out.blocked.map((b) => b.channel_id),
          ],
          input.channels.map((c) => c.id),
        ),
      ),
    ];
    const noAds = new Set(
      input.channels.filter((c) => c.adsAllowed === false).map((c) => c.id),
    );
    if (out.actions.some((a) => noAds.has(a.channel_id))) {
      issues.push({ field: 'actions.channel_id', code: 'ads_not_allowed' });
    }
    if (
      out.actions.some(
        (a) => a.proposed_date < input.from || a.proposed_date > input.to,
      )
    ) {
      issues.push({ field: 'actions.proposed_date', code: 'outside_input' });
    }
    return issues;
  },
};
