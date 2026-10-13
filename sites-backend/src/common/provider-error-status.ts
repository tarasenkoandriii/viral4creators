/** Keep raw SDK messages (potential prompts/credentials) out of diagnostics. */
export function providerErrorStatus(error: unknown): string {
  const status =
    error && typeof error === 'object'
      ? (error as { status?: unknown }).status
      : undefined;
  return typeof status === 'number' &&
    Number.isInteger(status) &&
    status >= 400 &&
    status <= 599
    ? String(status)
    : 'unknown';
}

/** Fixed categories only; never copy provider messages, URLs, or quota IDs. */
export function providerQuotaDiagnostic(error: unknown): {
  period: 'minute' | 'day' | 'unknown';
  unit: 'requests' | 'tokens' | 'unknown';
  freeTier: boolean | null;
  retryAfterSeconds: number | null;
} {
  const result = {
    period: 'unknown' as 'minute' | 'day' | 'unknown',
    unit: 'unknown' as 'requests' | 'tokens' | 'unknown',
    freeTier: null as boolean | null,
    retryAfterSeconds: null as number | null,
  };
  if (providerErrorStatus(error) !== '429') return result;
  const message = (error as { message?: unknown }).message;
  if (typeof message !== 'string' || message.length > 65536) return result;
  try {
    const parsed = JSON.parse(message.slice(message.indexOf('{'))) as {
      error?: { details?: unknown };
    };
    const details = parsed.error?.details;
    if (!Array.isArray(details)) return result;
    for (const raw of details) {
      if (!raw || typeof raw !== 'object') continue;
      const d = raw as {
        '@type'?: unknown;
        violations?: unknown;
        retryDelay?: unknown;
      };
      if (
        d['@type'] === 'type.googleapis.com/google.rpc.RetryInfo' &&
        typeof d.retryDelay === 'string'
      ) {
        const match = /^(\d+(?:\.\d+)?)s$/.exec(d.retryDelay);
        if (match && Number(match[1]) <= 86400)
          result.retryAfterSeconds = Number(match[1]);
      }
      if (
        d['@type'] !== 'type.googleapis.com/google.rpc.QuotaFailure' ||
        !Array.isArray(d.violations)
      )
        continue;
      for (const rawViolation of d.violations) {
        if (!rawViolation || typeof rawViolation !== 'object') continue;
        const v = rawViolation as { quotaId?: unknown; quotaMetric?: unknown };
        const id = typeof v.quotaId === 'string' ? v.quotaId : '';
        const metric = typeof v.quotaMetric === 'string' ? v.quotaMetric : '';
        if (/PerDay/i.test(id)) result.period = 'day';
        else if (/PerMinute/i.test(id) && result.period !== 'day')
          result.period = 'minute';
        if (/Tokens/i.test(id)) result.unit = 'tokens';
        else if (/Requests/i.test(id) && result.unit === 'unknown')
          result.unit = 'requests';
        if (metric.startsWith('generativelanguage.googleapis.com/'))
          result.freeTier =
            (result.freeTier ?? false) || /free_tier/i.test(metric);
      }
    }
  } catch {
    /* Unknown shape stays unknown; never expose the raw message. */
  }
  return result;
}
