/** Optional cap for TMA Chromium launches per invocation; preserve the default. */
export function scenarioRunBatchLimit(raw: string | undefined): number {
  if (!raw || !/^\d+$/.test(raw.trim())) return 30;
  const value = Number(raw.trim());
  return Number.isInteger(value) && value >= 1 && value <= 30 ? value : 30;
}
