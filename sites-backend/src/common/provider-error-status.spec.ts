import {
  providerErrorStatus,
  providerQuotaDiagnostic,
} from './provider-error-status';
const quota = (id: string, metric: string, retryDelay = '12s') => ({
  status: 429,
  message: JSON.stringify({
    error: {
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
          violations: [
            { quotaId: id, quotaMetric: metric, secret: 'never-log-me' },
          ],
        },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay },
      ],
    },
  }),
});
describe('safe provider diagnostics', () => {
  it('keeps only a valid integer HTTP error status', () => {
    expect(providerErrorStatus({ status: 503 })).toBe('503');
    expect(providerErrorStatus({ status: '503' })).toBe('unknown');
    expect(providerErrorStatus({ status: 200 })).toBe('unknown');
  });
  it('identifies minute request quota without copying secrets', () => {
    const d = providerQuotaDiagnostic(
      quota(
        'GenerateRequestsPerMinutePerProjectPerModel',
        'generativelanguage.googleapis.com/generate_content_free_tier_requests',
      ),
    );
    expect(d).toEqual({
      period: 'minute',
      unit: 'requests',
      freeTier: true,
      retryAfterSeconds: 12,
    });
    expect(JSON.stringify(d)).not.toContain('never-log-me');
  });
  it('distinguishes daily token quota from retriable minute limits', () => {
    expect(
      providerQuotaDiagnostic(
        quota(
          'GenerateTokensPerDayPerProject',
          'generativelanguage.googleapis.com/generate_content_tokens',
        ),
      ),
    ).toEqual({
      period: 'day',
      unit: 'tokens',
      freeTier: false,
      retryAfterSeconds: 12,
    });
  });
  it.each([
    { status: 429, message: 'secret plain text' },
    { status: 402, message: 'credit-secret' },
    { status: 429, message: '{invalid' },
    { status: 429, message: 'x'.repeat(65537) },
  ])('does not expose malformed or unrelated provider bodies', (e) => {
    expect(providerQuotaDiagnostic(e)).toEqual({
      period: 'unknown',
      unit: 'unknown',
      freeTier: null,
      retryAfterSeconds: null,
    });
  });
  it('rejects unbounded or invalid retry delay', () => {
    expect(
      providerQuotaDiagnostic(quota('', '', '99999999s')).retryAfterSeconds,
    ).toBeNull();
    expect(
      providerQuotaDiagnostic(quota('', '', 'secret')).retryAfterSeconds,
    ).toBeNull();
  });
});
