import { QaCiService } from './qa-ci.service';
import { QaCiIdentity } from './qa-ci-identity';
import { QaCatalogService } from './qa-catalog.service';
import { QaRunService } from './qa-run.service';
import { ConflictException } from '@nestjs/common';
import { QaFindingService } from './qa-finding.service';
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
  const createFinding = jest
    .fn()
    .mockResolvedValue({ id: 'finding', revision: 1 });
  const ci = new QaCiService(
    { scoped } as unknown as QaCatalogService,
    { create, importReport } as unknown as QaRunService,
    { create: createFinding } as unknown as QaFindingService,
  );
  return { ci, db, scoped, create, importReport, createFinding };
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

test('re-delivery uses the frozen run after catalog edit or archive', async () => {
  const s = setup(true);
  s.db.qaTestCase.findMany.mockResolvedValue([]);
  await s.ci.deliver('Bearer synthetic', fixture());
  expect(s.db.qaTestCase.findMany).not.toHaveBeenCalled();
  expect(s.create).not.toHaveBeenCalled();
  expect(s.importReport).toHaveBeenCalled();
});

function auditFixture(statuses = ['failed']) {
  const s = setup(true);
  const input = fixture();
  Object.assign(input.report.metadata, {
    targetOrigin: 'https://sandbox.viral4creators.app',
  });
  input.report.cases[0].id = 'SBX-TUTORIAL';
  input.report.results = statuses.map((status, attempt) => ({
    ...input.report.results[0],
    caseId: 'SBX-TUTORIAL',
    status,
    attempt,
  }));
  const rows = statuses.map((status, sourceAttempt) => ({
    id: `attempt${sourceAttempt}`,
    status,
    sourceAttempt,
    origin: 'automated',
    createdAt: new Date('2026-10-11T00:00:00Z'),
    sourceMetadata: { runnerStatus: 'passed' },
  }));
  const host = jest.fn().mockResolvedValue({ id: 'host' });
  const attempts = jest.fn().mockResolvedValue(rows);
  const lookup = jest.fn().mockResolvedValue(null);
  Object.assign(s.db, {
    siteHost: { findFirst: host },
    qaTestRunAttempt: { findMany: attempts },
    qaFinding: { findFirst: lookup },
  });
  return { ...s, input, rows, host, attempts, lookup };
}
test('sandbox failure creates one unconfirmed finding linked to saved attempt, never claims deployed SHA', async () => {
  const s = auditFixture();
  const result = await s.ci.deliver('Bearer synthetic', s.input);
  expect(result.audit).toMatchObject({
    status: 'failed',
    created: true,
    findingId: 'finding',
    requiresReview: true,
  });
  expect(s.createFinding).toHaveBeenCalledWith(
    expect.objectContaining({ accountId: 'account' }),
    'site',
    expect.objectContaining({
      status: 'needs_confirmation',
      deployedSha: null,
      source: {
        runId: result.runId,
        caseKey: 'SBX-TUTORIAL',
        attemptId: 'attempt0',
      },
    }),
  );
  expect(s.host).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        accountId: 'account',
        siteId: 'site',
        status: 'verified',
        revokedAt: null,
        expiresAt: { gt: expect.any(Date) },
        host: 'sandbox.viral4creators.app',
      }),
    }),
  );
  expect(s.attempts).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        accountId: 'account',
        runId: result.runId,
        origin: 'automated',
        reportHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    }),
  );
});
test('replay and later runs reuse stable observation rather than create duplicates', async () => {
  const s = auditFixture();
  s.lookup.mockResolvedValue({ id: 'original' });
  const first = await s.ci.deliver('Bearer synthetic', s.input);
  jest
    .mocked(QaCiIdentity.prototype.authenticate)
    .mockResolvedValue({ runId: '9999', runAttempt: '1', sha: 'a'.repeat(40) });
  const later = await s.ci.deliver('Bearer synthetic', s.input);
  expect(first.audit).toMatchObject({ findingId: 'original', created: false });
  expect(later.audit).toMatchObject({ findingId: 'original', created: false });
  expect(s.lookup.mock.calls[0][0].where.fingerprint).toBe(
    s.lookup.mock.calls[1][0].where.fingerprint,
  );
  expect(s.createFinding).not.toHaveBeenCalled();
});
test('passing recheck references persisted proof without editing or closing existing finding', async () => {
  const s = auditFixture(['passed']);
  s.lookup.mockResolvedValue({ id: 'original' });
  const result = await s.ci.deliver('Bearer synthetic', s.input);
  expect(result.audit).toMatchObject({
    status: 'passed',
    created: false,
    findingId: 'original',
    requiresReview: true,
    proof: { attemptId: 'attempt0' },
  });
  expect(s.createFinding).not.toHaveBeenCalled();
});
test('failed then passing retry remains flaky and requires review', async () => {
  const s = auditFixture(['failed', 'passed']);
  const result = await s.ci.deliver('Bearer synthetic', s.input);
  expect(result.audit).toMatchObject({
    status: 'passed',
    flaky: true,
    requiresReview: true,
    proof: { attemptId: 'attempt1' },
  });
  expect(s.createFinding.mock.calls[0][2].source.attemptId).toBe('attempt0');
});
test('unsuccessful runner cannot certify a passing recheck', async () => {
  const s = auditFixture(['passed']);
  s.rows[0].sourceMetadata.runnerStatus = 'interrupted';
  expect((await s.ci.deliver('Bearer synthetic', s.input)).audit).toMatchObject(
    { status: 'blocked' },
  );
});
test('missing verified sandbox binding does not create findings for a different tenant target', async () => {
  const s = auditFixture();
  s.host.mockResolvedValue(null);
  expect((await s.ci.deliver('Bearer synthetic', s.input)).audit).toEqual({
    status: 'out_of_scope',
  });
  expect(s.attempts).not.toHaveBeenCalled();
  expect(s.createFinding).not.toHaveBeenCalled();
});
test('incomplete persisted proof fails and replay can repair projection after partial delivery', async () => {
  const s = auditFixture();
  s.attempts.mockResolvedValueOnce([]);
  await expect(s.ci.deliver('Bearer synthetic', s.input)).rejects.toThrow(
    'incomplete',
  );
  expect(s.createFinding).not.toHaveBeenCalled();
  expect((await s.ci.deliver('Bearer synthetic', s.input)).audit).toMatchObject(
    { created: true },
  );
  expect(s.create).not.toHaveBeenCalled();
});
test('concurrent duplicate converges but storage failures remain errors', async () => {
  const s = auditFixture();
  s.lookup.mockResolvedValueOnce(null).mockResolvedValue({ id: 'racing' });
  s.createFinding.mockRejectedValue(
    new ConflictException({ code: 'QA_FINDING_DUPLICATE' }),
  );
  expect((await s.ci.deliver('Bearer synthetic', s.input)).audit).toMatchObject(
    { findingId: 'racing', created: false },
  );
  s.lookup.mockResolvedValue(null);
  s.createFinding.mockRejectedValue(new Error('storage offline'));
  await expect(s.ci.deliver('Bearer synthetic', s.input)).rejects.toThrow(
    'storage offline',
  );
});
test('new case versions require explicit pilot approval, never inherit automatic finding rules', async () => {
  const s = auditFixture();
  s.input.report.cases[0].version = 2;
  s.input.report.results[0].caseVersion = 2;
  expect((await s.ci.deliver('Bearer synthetic', s.input)).audit).toEqual({
    status: 'out_of_scope',
  });
  expect(s.host).not.toHaveBeenCalled();
});

test('local or missing target origin cannot attribute a failure to the deployed sandbox', async () => {
  const s = auditFixture();
  Object.assign(s.input.report.metadata, {
    targetOrigin: 'http://127.0.0.1:4173',
  });
  expect((await s.ci.deliver('Bearer synthetic', s.input)).audit).toEqual({
    status: 'out_of_scope',
  });
  Object.assign(s.input.report.metadata, { targetOrigin: null });
  expect((await s.ci.deliver('Bearer synthetic', s.input)).audit).toEqual({
    status: 'out_of_scope',
  });
  expect(s.createFinding).not.toHaveBeenCalled();
});
