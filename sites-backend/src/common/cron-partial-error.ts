/** Only audited composite jobs: preserve partial work without erasing failures.
 * Stored diagnostics contain fixed stage names, never provider text or secrets. */
function hasFailures(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return ['failed', 'errors'].some(
    (key) => typeof v[key] === 'number' && (v[key] as number) > 0,
  );
}

export function cronPartialError(job: string, value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const errors: string[] = [];
  if (['assist-embed-run', 'assist-admin-embed-run'].includes(job)) {
    if (
      v.filesError ||
      (typeof v.filesFailed === 'number' && v.filesFailed > 0)
    )
      errors.push('files');
    const index = v.index as Record<string, unknown> | null;
    if (
      index &&
      ((typeof index.failed === 'number' && index.failed > 0) ||
        (typeof index.cleanupErrors === 'number' && index.cleanupErrors > 0))
    )
      errors.push('index');
    if (job === 'assist-admin-embed-run') {
      if (v.analytics === null) errors.push('analytics');
      else if (v.analytics && typeof v.analytics === 'object') {
        const a = v.analytics as Record<string, unknown>;
        if (a.exports === null || hasFailures(a.exports))
          errors.push('analytics.exports');
        // Throttling deliberately skips the remaining stages; it is not a failure.
        if (a.throttled === false) {
          for (const part of ['alerts', 'labels', 'rollup', 'weekly']) {
            if (a[part] === null || hasFailures(a[part]))
              errors.push(`analytics.${part}`);
          }
        }
      }
    }
  }
  if (job === 'assist-analytics-run') {
    if (v.voice === null) errors.push('voice');
    if (v.ai === null) errors.push('ai');
    else if (v.ai && typeof v.ai === 'object') {
      for (const part of ['labels', 'weekly', 'experiments'])
        if (
          (v.ai as Record<string, unknown>)[part] === null ||
          hasFailures((v.ai as Record<string, unknown>)[part])
        )
          errors.push(`ai.${part}`);
    }
  }
  if (job === 'assist-analytics-rollup' && v.behavior === null)
    errors.push('behavior');
  return errors.length ? `PartialFailure: ${errors.join(', ')}` : null;
}
