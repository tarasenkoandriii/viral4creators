import { acceptanceStatus } from './qa-attempt-status';
import { runSummary } from './qa-run.service';
describe('QA runner acceptance boundary', () => {
  it.each(['failed', 'timedout', 'interrupted', undefined])(
    'does not certify a passing case from runner %s',
    (runnerStatus) => {
      const attempt = {
        caseKey: 'QA-A',
        status: 'passed',
        origin: 'automated',
        sourceMetadata: { runnerStatus },
      };
      expect(acceptanceStatus(attempt)).toBe('blocked');
      expect(runSummary([{ caseKey: 'QA-A' }], [attempt])).toMatchObject({
        passed: 0,
        blocked: 1,
        complete: false,
      });
      expect(attempt.status).toBe('passed');
    },
  );
  it('preserves recorded failures, human results and successful automated results', () => {
    expect(acceptanceStatus({ status: 'failed', origin: 'automated' })).toBe(
      'failed',
    );
    expect(acceptanceStatus({ status: 'passed', origin: 'manual' })).toBe(
      'passed',
    );
    expect(
      acceptanceStatus({
        status: 'passed',
        origin: 'automated',
        sourceMetadata: { runnerStatus: 'passed' },
      }),
    ).toBe('passed');
  });
});
