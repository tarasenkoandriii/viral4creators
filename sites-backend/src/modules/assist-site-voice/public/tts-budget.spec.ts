import { ttsFailureBudgetCost } from './tts-budget';

describe('TTS uncertain outcome budget', () => {
  it.each(['timeout', 'error'] as const)(
    'retains estimate for %s',
    (reason) => {
      expect(ttsFailureBudgetCost({ ok: false, reason }, 123)).toBe(123);
    },
  );
  it('retains estimate for upstream server failure', () => {
    expect(
      ttsFailureBudgetCost(
        { ok: false, reason: 'error', reasonCode: 'http-503' },
        123,
      ),
    ).toBe(123);
  });
  it.each(['no_key', 'empty'] as const)(
    'releases local rejection %s',
    (reason) => {
      expect(ttsFailureBudgetCost({ ok: false, reason }, 123)).toBe(0);
    },
  );
  it.each([400, 401, 402, 403, 404, 413, 415, 422, 429])(
    'releases rejected HTTP %s',
    (status) => {
      expect(
        ttsFailureBudgetCost(
          { ok: false, reason: 'error', reasonCode: `http-${status}` },
          123,
        ),
      ).toBe(0);
    },
  );
});
