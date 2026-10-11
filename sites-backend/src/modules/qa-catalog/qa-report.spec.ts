import { parseQaReport, validateReportSnapshot } from './qa-report-input';
import { QaRunService } from './qa-run.service';
import { QaCatalogService } from './qa-catalog.service';
import { AccountMembership } from '../site-core/account/roles';
export const reportFixture = () => ({
  schemaVersion: 1,
  unknownTests: 0,
  runnerStatus: 'passed',
  metadata: {
    source: 'playwright',
    startedAt: '2026-10-11T00:00:00Z',
    testSourceSha: null,
    deployedSha: null,
  },
  cases: [
    {
      id: 'QA-AUTO',
      version: 1,
      type: 'automated',
      projects: ['desktop', 'mobile'],
    },
  ],
  results: [
    {
      caseId: 'QA-AUTO',
      caseVersion: 1,
      project: 'desktop',
      attempt: 0,
      status: 'failed',
      durationMs: 10,
      origin: 'automated',
    },
    {
      caseId: 'QA-AUTO',
      caseVersion: 1,
      project: 'desktop',
      attempt: 1,
      status: 'passed',
      durationMs: 12,
      origin: 'automated',
    },
    {
      caseId: 'QA-AUTO',
      caseVersion: 1,
      project: 'mobile',
      attempt: 0,
      status: 'failed',
      durationMs: 13,
      origin: 'automated',
    },
  ],
});
describe('QA report import validation', () => {
  it('selects one project, keeps retries and hashes independently of expected revision', () => {
    const report = reportFixture(),
      a = parseQaReport({ expectedRevision: 1, project: 'desktop', report }),
      b = parseQaReport({ expectedRevision: 9, project: 'desktop', report });
    expect(a.attempts.map((a) => a.status)).toEqual(['failed', 'passed']);
    expect(a.reportHash).toBe(b.reportHash);
    expect(
      parseQaReport({
        expectedRevision: 1,
        project: 'mobile',
        report,
      }).attempts.map((a) => a.status),
    ).toEqual(['failed']);
  });
  it.each([
    'unknown',
    'version',
    'duplicate',
    'gap',
    'manual',
    'duration',
    'missing',
    'sha',
  ])('rejects invalid %s reports', (kind) => {
    const report = reportFixture();
    if (kind === 'unknown') report.unknownTests = 1;
    if (kind === 'version') report.results[0].caseVersion = 2;
    if (kind === 'duplicate') report.results.push({ ...report.results[0] });
    if (kind === 'gap') report.results[1].attempt = 2;
    if (kind === 'manual') report.cases[0].type = 'manual';
    if (kind === 'duration') report.results[0].durationMs = NaN;
    if (kind === 'missing') report.results = [];
    if (kind === 'sha')
      Object.assign(report.metadata, { testSourceSha: 'not-sha' });
    expect(() =>
      parseQaReport({ expectedRevision: 1, project: 'desktop', report }),
    ).toThrow();
  });
  it.each(['runnerStatus', 'caseType', 'attemptStatus'])(
    'rejects coerced enum %s',
    (field) => {
      const report = reportFixture();
      if (field === 'runnerStatus')
        Object.assign(report, { runnerStatus: ['passed'] });
      if (field === 'caseType')
        Object.assign(report.cases[0], { type: ['automated'] });
      if (field === 'attemptStatus')
        Object.assign(report.results[0], { status: ['failed'] });
      expect(() =>
        parseQaReport({ expectedRevision: 1, project: 'desktop', report }),
      ).toThrow();
    },
  );
  it('requires exact automated snapshots and leaves manual cases separate', () => {
    const r = parseQaReport({
      expectedRevision: 1,
      project: 'desktop',
      report: reportFixture(),
    });
    expect(() =>
      validateReportSnapshot(
        [
          { caseKey: 'QA-AUTO', version: 1, payload: { type: 'automated' } },
          { caseKey: 'QA-MANUAL', version: 7, payload: { type: 'manual' } },
        ],
        r,
      ),
    ).not.toThrow();
    expect(() =>
      validateReportSnapshot(
        [{ caseKey: 'QA-AUTO', version: 2, payload: { type: 'automated' } }],
        r,
      ),
    ).toThrow();
  });
  it('replays without writes and checks access before parsing', async () => {
    const body = {
        expectedRevision: 1,
        project: 'desktop',
        report: reportFixture(),
      },
      tx = {
        qaTestRun: {
          findFirst: jest.fn().mockResolvedValue({
            revision: 4,
            automationProject: 'desktop',
            snapshot: [
              {
                caseKey: 'QA-AUTO',
                version: 1,
                payload: { type: 'automated' },
              },
            ],
          }),
        },
        qaTestRunAttempt: { count: jest.fn().mockResolvedValue(2) },
      };
    const scoped = jest.fn().mockResolvedValue({
      $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
    });
    const service = new QaRunService({ scoped } as unknown as QaCatalogService),
      m = { accountId: 'a', memberId: 'm' } as AccountMembership;
    await expect(
      service.importReport(m, 's', 'r', body),
    ).resolves.toMatchObject({ revision: 4, replayed: true, imported: 0 });
    expect(scoped).toHaveBeenCalledWith(m, 's', true);
  });
});
