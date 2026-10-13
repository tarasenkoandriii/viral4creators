import { cronPartialError } from './cron-partial-error';
import { providerErrorStatus } from './provider-error-status';
describe('composite cron failures', () => {
  it.each(['assist-embed-run', 'assist-admin-embed-run'])(
    'preserves %s file and index failures',
    (job) => {
      expect(
        cronPartialError(job, {
          filesError: 'secret provider payload',
          index: { failed: 1 },
        }),
      ).toBe('PartialFailure: files, index');
      expect(cronPartialError(job, { filesFailed: 1 })).toBe(
        'PartialFailure: files',
      );
      expect(
        cronPartialError(job, {
          filesError: null,
          index: { failed: 0, budgetExhausted: true },
        }),
      ).toBeNull();
    },
  );
  it('records AI part failures without losing healthy rollups', () => {
    expect(
      cronPartialError('assist-analytics-run', {
        voice: null,
        ai: { labels: null, weekly: {}, experiments: {} },
      }),
    ).toBe('PartialFailure: voice, ai.labels');
    expect(
      cronPartialError('assist-analytics-rollup', { behavior: null }),
    ).toBe('PartialFailure: behavior');
  });
  it('does not flag lock skips, idle successful parts or unrelated jobs', () => {
    expect(cronPartialError('assist-analytics-run', { ran: false })).toBeNull();
    expect(
      cronPartialError('assist-analytics-run', {
        voice: {},
        ai: { labels: {}, weekly: {}, experiments: {} },
      }),
    ).toBeNull();
    expect(cronPartialError('other', { filesError: 'error' })).toBeNull();
  });
  it('provider diagnostics contain only a valid HTTP status', () => {
    expect(providerErrorStatus({ status: 402, message: 'secret prompt' })).toBe(
      '402',
    );
    expect(providerErrorStatus({ status: 'secret' })).toBe('unknown');
    expect(providerErrorStatus({ status: Infinity })).toBe('unknown');
    expect(providerErrorStatus(null)).toBe('unknown');
  });
});
