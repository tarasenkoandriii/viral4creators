import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import { AccountMembership } from '../site-core/account/roles';
import { QaRunService } from './qa-run.service';
import { QaCatalogService } from './qa-catalog.service';
import { QaFindingService } from './qa-finding.service';
const ciDescribe = process.env.CI === 'true' ? describe : describe.skip;
ciDescribe('QA catalog on isolated CI Postgres', () => {
  let prisma: PrismaService;
  let service: QaCatalogService;
  let runs: QaRunService;
  let findings: QaFindingService;
  let accountA: string,
    accountB: string,
    siteA: string,
    siteB: string,
    caseId: string;
  const member = (accountId: string) =>
    ({
      accountId,
      memberId: 'qa-fixture',
      role: 'owner',
      productRoles: { qa: 'admin', assist: 'none', assistAdmin: 'none' },
    }) as AccountMembership;
  const payload = (title = 'Login') => ({
    title,
    purpose: '',
    preconditions: '',
    steps: [{ action: 'Submit', expected: 'Rejected' }],
    type: 'manual',
    priority: 'normal',
    tags: [],
    requirementIds: [],
    archived: false,
  });
  beforeAll(async () => {
    // Never seed a production URL inherited by a developer or CI runner.
    const url = new URL(process.env.SITES_DATABASE_URL || 'http://invalid');
    if (url.hostname !== 'localhost' || url.pathname !== '/sites')
      throw new Error(
        'QA database acceptance requires isolated localhost/sites CI database',
      );
    prisma = new PrismaService();
    const db = new SitesDb(prisma);
    service = new QaCatalogService(db);
    runs = new QaRunService(service);
    findings = new QaFindingService(service);
    const raw = db.system('QA isolated acceptance fixture');
    accountA = (
      await raw.siteAccount.create({ data: { verifyToken: randomUUID() } })
    ).id;
    accountB = (
      await raw.siteAccount.create({ data: { verifyToken: randomUUID() } })
    ).id;
    siteA = (
      await db
        .forAccount(accountA)
        .site.create({ data: { accountId: accountA, name: 'QA A' } })
    ).id;
    siteB = (
      await db
        .forAccount(accountB)
        .site.create({ data: { accountId: accountB, name: 'QA B' } })
    ).id;
    caseId = (
      await service.create(member(accountA), siteA, {
        caseKey: 'QA-LOGIN',
        payload: payload(),
      })
    ).id;
  }, 30000);
  afterAll(async () => {
    if (prisma) {
      await prisma.siteAccount.deleteMany({
        where: { id: { in: [accountA, accountB].filter(Boolean) } },
      });
      await prisma.$disconnect();
    }
  });
  it('cannot read another account case through an owned site', async () => {
    await expect(
      service.get(member(accountB), siteB, caseId),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('compound foreign key rejects cross-account revision even bypassing the service', async () => {
    await expect(
      prisma.qaTestCaseRevision.create({
        data: {
          accountId: accountB,
          caseId,
          version: 99,
          payload: payload(),
          createdByMemberId: 'qa-fixture',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });
  it('concurrent edits commit exactly one revision and preserve the old snapshot', async () => {
    const results = await Promise.allSettled(
      ['A', 'B'].map((title) =>
        service.replace(member(accountA), siteA, caseId, {
          expectedVersion: 1,
          payload: payload(title),
        }),
      ),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const failure = results.find(
      (result) => result.status === 'rejected',
    ) as PromiseRejectedResult;
    expect(failure.reason).toMatchObject({ status: 409 });
    const history = await service.history(member(accountA), siteA, caseId);
    expect(history.items.map((item) => item.version)).toEqual([2, 1]);
    expect(history.items[1].payload).toMatchObject({ title: 'Login' });
  }, 30000);
  it('run snapshots stay unchanged after catalog edits and results stay not-run until recorded', async () => {
    const before = await service.get(member(accountA), siteA, caseId);
    const run = await runs.create(member(accountA), siteA, {
      title: 'Snapshot',
      caseIds: [caseId],
    });
    await service.replace(member(accountA), siteA, caseId, {
      expectedVersion: before.currentVersion,
      payload: payload('Later edit'),
    });
    const read = await runs.get(member(accountA), siteA, run.id);
    expect(read.snapshot).toEqual([
      {
        caseId,
        caseKey: 'QA-LOGIN',
        version: before.currentVersion,
        payload: before.revision!.payload,
      },
    ]);
    expect(read.summary).toMatchObject({
      notRun: 1,
      passed: 0,
      complete: false,
    });
    await expect(
      runs.get(member(accountB), siteB, run.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      prisma.qaTestRunAttempt.create({
        data: {
          accountId: accountB,
          runId: run.id,
          caseKey: 'QA-LOGIN',
          attemptNumber: 1,
          status: 'passed',
          comment: '',
          createdByMemberId: 'fixture',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });
  it('retries preserve failures and stale concurrent writes cannot add extra attempts', async () => {
    const run = await runs.create(member(accountA), siteA, {
      title: 'Retries',
      caseIds: [caseId],
    });
    await runs.record(member(accountA), siteA, run.id, {
      expectedRevision: 1,
      caseKey: 'QA-LOGIN',
      status: 'failed',
      comment: 'Validation missing',
    });
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        runs.record(member(accountA), siteA, run.id, {
          expectedRevision: 2,
          caseKey: 'QA-LOGIN',
          status: 'passed',
          comment: 'Retest',
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (results.find((r) => r.status === 'rejected') as PromiseRejectedResult)
        .reason,
    ).toMatchObject({ status: 409 });
    const read = await runs.get(member(accountA), siteA, run.id);
    expect(read.revision).toBe(3);
    expect(read.summary).toMatchObject({
      passed: 1,
      notRun: 0,
      complete: true,
    });
    expect(read.flakyCaseKeys).toEqual(['QA-LOGIN']);
    const history = await runs.attempts(member(accountA), siteA, run.id);
    expect(history.items.map((a) => [a.attemptNumber, a.status])).toEqual([
      [2, 'passed'],
      [1, 'failed'],
    ]);
  });
  it('manual API cannot record automated cases or case keys outside the run snapshot', async () => {
    const automated = await service.create(member(accountA), siteA, {
      caseKey: 'QA-AUTO',
      payload: { ...payload(), type: 'automated' },
    });
    const run = await runs.create(member(accountA), siteA, {
      title: 'Auto pending',
      caseIds: [automated.id],
    });
    for (const caseKey of ['QA-AUTO', 'QA-LOGIN'])
      await expect(
        runs.record(member(accountA), siteA, run.id, {
          expectedRevision: 1,
          caseKey,
          status: 'passed',
          comment: '',
        }),
      ).rejects.toMatchObject({ status: 400 });
    expect((await runs.get(member(accountA), siteA, run.id)).revision).toBe(1);
  });
  it('imports retries atomically, replays safely and rejects project/tenant/version mixing', async () => {
    const automated = await service.create(member(accountA), siteA, {
      caseKey: 'QA-IMPORT',
      payload: { ...payload(), type: 'automated' },
    });
    const run = await runs.create(member(accountA), siteA, {
      title: 'Imported',
      caseIds: [automated.id, caseId],
    });
    const report = {
      schemaVersion: 1,
      unknownTests: 0,
      runnerStatus: 'passed',
      metadata: { source: 'playwright', startedAt: '2026-10-11T00:00:00Z' },
      cases: [
        {
          id: 'QA-IMPORT',
          version: 1,
          type: 'automated',
          projects: ['desktop', 'mobile'],
        },
      ],
      results: [
        {
          caseId: 'QA-IMPORT',
          caseVersion: 1,
          project: 'desktop',
          attempt: 0,
          status: 'failed',
          durationMs: 10,
          origin: 'automated',
        },
        {
          caseId: 'QA-IMPORT',
          caseVersion: 1,
          project: 'desktop',
          attempt: 1,
          status: 'passed',
          durationMs: 12,
          origin: 'automated',
        },
        {
          caseId: 'QA-IMPORT',
          caseVersion: 1,
          project: 'mobile',
          attempt: 0,
          status: 'failed',
          durationMs: 12,
          origin: 'automated',
        },
      ],
    };
    const body = { expectedRevision: 1, project: 'desktop', report };
    const concurrent = await Promise.allSettled(
      [1, 2].map(() =>
        runs.importReport(member(accountA), siteA, run.id, body),
      ),
    );
    expect(concurrent.some((r) => r.status === 'fulfilled')).toBe(true);
    expect(
      (await runs.importReport(member(accountA), siteA, run.id, body)).replayed,
    ).toBe(true);
    const read = await runs.get(member(accountA), siteA, run.id);
    expect(read.revision).toBe(2);
    expect(read.automationProject).toBe('desktop');
    expect(read.summary).toMatchObject({
      passed: 1,
      notRun: 1,
      complete: false,
    });
    expect(read.flakyCaseKeys).toEqual(['QA-IMPORT']);
    expect(
      (await runs.attempts(member(accountA), siteA, run.id)).items,
    ).toHaveLength(2);
    await expect(
      runs.importReport(member(accountA), siteA, run.id, {
        ...body,
        expectedRevision: 2,
        project: 'mobile',
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      runs.importReport(member(accountB), siteB, run.id, body),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      runs.importReport(member(accountA), siteA, run.id, {
        ...body,
        report: { ...report, cases: [{ ...report.cases[0], version: 2 }] },
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect((await runs.get(member(accountA), siteA, run.id)).revision).toBe(2);
  });
  it('finding revisions enforce compound tenant keys, CAS, history and scoped dedupe', async () => {
    const observation = {
      title: 'Observed overlap',
      category: 'layout',
      severity: 'P2',
      status: 'needs_confirmation',
      url: 'https://example.com/login',
      context: '390x844 dark ru',
      steps: 'Open login',
      expected: 'Button visible',
      actual: 'Button covered',
      impact: 'Cannot submit',
      evidence: [],
      deployedSha: null,
      observedAt: '2026-10-10T10:00:00Z',
      verification: null,
    };
    const f = await findings.create(member(accountA), siteA, observation);
    await expect(
      findings.get(member(accountB), siteB, f.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      findings.create(member(accountA), siteA, observation),
    ).rejects.toMatchObject({
      response: { code: 'QA_FINDING_DUPLICATE', details: { findingId: f.id } },
    });
    await expect(
      prisma.qaFindingRevision.create({
        data: {
          accountId: accountB,
          findingId: f.id,
          version: 99,
          payload: observation,
          createdByMemberId: 'fixture',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    const results = await Promise.allSettled(
      ['A', 'B'].map((title) =>
        findings.replace(member(accountA), siteA, f.id, {
          expectedRevision: 1,
          payload: { ...observation, title },
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (results.find((r) => r.status === 'rejected') as PromiseRejectedResult)
        .reason,
    ).toMatchObject({ status: 409 });
    const history = await findings.history(member(accountA), siteA, f.id);
    expect(history.items.map((r) => r.version)).toEqual([2, 1]);
    expect(history.items[1].payload).toMatchObject({
      title: 'Observed overlap',
    });
    const older = await findings.history(member(accountA), siteA, f.id, '2');
    expect(older.items.map((r) => r.version)).toEqual([1]);
  }, 30000);
});
