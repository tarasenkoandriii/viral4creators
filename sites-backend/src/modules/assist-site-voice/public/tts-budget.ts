import type { SiteTtsResult } from './soniox-tts.client';

/** Conservative daily-limit accounting, not an invoiced usage record.
 * An interrupted request may have been processed upstream.
 */
export function ttsFailureBudgetCost(
  result: Extract<SiteTtsResult, { ok: false }>,
  estimate: number,
): number {
  if (result.reason === 'no_key' || result.reason === 'empty') return 0;
  if (
    /^http-(400|401|402|403|404|413|415|422|429)$/.test(result.reasonCode ?? '')
  ) {
    return 0;
  }
  return estimate;
}
