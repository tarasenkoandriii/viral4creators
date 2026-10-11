import { QaCiService } from './qa-ci.service';
import { QaCiIdentity } from './qa-ci-identity';
import { QaCatalogService } from './qa-catalog.service';
import { QaRunService } from './qa-run.service';
const config = {
  QA_CI_REPOSITORY: 'owner/repo',
  QA_CI_REPOSITORY_ID: '123',
  QA_CI_OWNER_ID: '456',
  QA_CI_WORKFLOW: '.github/workflows/qa.yml',
  QA_CI_ACCOUNT_ID: 'account',
  QA_CI_SITE_ID: 'site',
};
function fixture() {
  const sha = 'a'.repeat(40);
  return {
    project: 'desktop',
    report: {
      schemaVersion: 1,
      unknownTests: 0,
      runnerStatus: 'passed',
      metadata: {
        source: 'playwright',
        startedAt: '2026-10-11T00:00:00Z',
        testSourceSha: sha,
        deployedSha: null,
      },
      cases: [
        { id: 'QA-AUTO', version: 1, type: 'automated', projects: ['desktop'] },
      ],
      results: [
        {
          caseId: 'QA-AUTO',
          caseVersion: 1,
          project: 'desktop',
          attempt: 0,
          status: 'passed',
          durationMs: 10,
          origin: 'automated',
        },
      ],
    },
  };
}
function setup(existing = false) {
  const db = {
    qaTestCase: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { id: 'case', caseKey: 'QA-AUTO', currentVersion: 1 },
        ]),
    },
    qaTestRun: {
      findFirst: jest.fn().mockResolvedValue(existing ? { revision: 2 } : null),
    },
  };
  const scoped = jest.fn().mockResolvedValue(db);
  const create = jest.fn().mockResolvedValue({ revision: 1 });
  const importReport = jest.fn().mockResolvedValue({
    revision: 2,
    imported: 1,
    replayed: false,
    project: 'desktop',
  });
  const ci = new QaCiService(
    { scoped } as unknown as QaCatalogService,
    { create, importReport } as unknown as QaRunService,
  );
  return { ci, db, scoped, create, importReport };
}
beforeEach(() => {
  Object.assign(process.env, config);
  jest
    .spyOn(QaCiIdentity.prototype, 'authenticate')
    .mockResolvedValue({ runId: '1234', runAttempt: '1', sha: 'a'.repeat(40) });
});
afterEach(() => {
  jest.restoreAllMocks();
  for (const k of Object.keys(config)) delete process.env[k];
});
test('fixed site binding; no owner role, no manual results or catalog edits', async () => {
  const s = setup();
  const result = await s.ci.deliver('Bearer synthetic', fixture());
  expect(s.scoped).toHaveBeenCalledWith(
    expect.objectContaining({
      accountId: 'account',
      role: 'operator',
      productRoles: { qa: 'admin', assist: 'none', assistAdmin: 'none' },
    }),
    'site',
    true,
  );
  expect(s.create.mock.calls[0][3]).toBe(result.runId);
  expect(s.importReport.mock.calls[0][3].expectedRevision).toBe(1);
});
test('same workflow delivery reuses deterministic run', async () => {
  const first = await setup().ci.deliver('Bearer synthetic', fixture());
  const s = setup(true);
  const second = await s.ci.deliver('Bearer synthetic', fixture());
  expect(second.runId).toBe(first.runId);
  expect(s.create).not.toHaveBeenCalled();
  expect(s.importReport.mock.calls[0][3].expectedRevision).toBe(2);
});
test('retrying Actions produces a separate run', async () => {
  const ci = setup().ci;
  const first = await ci.deliver('Bearer synthetic', fixture());
  jest
    .mocked(QaCiIdentity.prototype.authenticate)
    .mockResolvedValue({ runId: '1234', runAttempt: '2', sha: 'a'.repeat(40) });
  expect((await ci.deliver('Bearer synthetic', fixture())).runId).not.toBe(
    first.runId,
  );
});
test('rejects caller supplied account and mismatched SHA before database access', async () => {
  const s = setup();
  await expect(
    s.ci.deliver('Bearer synthetic', { ...fixture(), accountId: 'other' }),
  ).rejects.toThrow();
  const input = fixture();
  input.report.metadata.testSourceSha = 'b'.repeat(40);
  await expect(s.ci.deliver('Bearer synthetic', input)).rejects.toThrow();
  expect(s.scoped).not.toHaveBeenCalled();
});
test('disabled binding and changed catalog versions stop delivery', async () => {
  const s = setup();
  s.db.qaTestCase.findMany.mockResolvedValue([
    { id: 'case', caseKey: 'QA-AUTO', currentVersion: 2 },
  ]);
  await expect(s.ci.deliver('Bearer synthetic', fixture())).rejects.toThrow();
  expect(s.create).not.toHaveBeenCalled();
  delete process.env.QA_CI_SITE_ID;
  await expect(s.ci.deliver('Bearer synthetic', fixture())).rejects.toThrow(
    'CI report delivery is not configured',
  );
});
