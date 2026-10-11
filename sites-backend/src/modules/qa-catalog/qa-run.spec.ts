import { ForbiddenException } from '@nestjs/common';
import { AccountMembership } from '../site-core/account/roles';
import { QaCatalogService } from './qa-catalog.service';
import {
  QaRunService,
  parseRunAttempt,
  parseRunInput,
  runSummary,
} from './qa-run.service';
describe('QA run input and summary', () => {
  it.each([
    null,
    {},
    { title: 'a', caseIds: [] },
    { title: 'a', caseIds: ['x', 'x'] },
    { title: 'a', caseIds: ['../x'] },
    { title: 'a', caseIds: ['x'], accountId: 'foreign' },
  ])('rejects invalid or caller-owned fields %p', (input) =>
    expect(() => parseRunInput(input)).toThrow(),
  );
  it('normalizes a valid selection', () =>
    expect(parseRunInput({ title: ' Run ', caseIds: ['case1'] })).toEqual({
      title: 'Run',
      caseIds: ['case1'],
    }));
  it.each([
    { expectedRevision: 1, caseKey: 'QA-CASE', status: 'failed', comment: '' },
    {
      expectedRevision: 1,
      caseKey: 'QA-CASE',
      status: 'passed',
      comment: '',
      attemptNumber: 99,
    },
    { expectedRevision: 0, caseKey: 'QA-CASE', status: 'passed', comment: '' },
    { expectedRevision: 1, caseKey: 'QA-CASE', status: 'not-run', comment: '' },
  ])('rejects invalid attempt %p', (input) =>
    expect(() => parseRunAttempt(input)).toThrow(),
  );
  it('requires an explanation for non-passing results', () =>
    expect(
      parseRunAttempt({
        expectedRevision: 1,
        caseKey: 'QA-CASE',
        status: 'blocked',
        comment: ' Missing device ',
      }),
    ).toMatchObject({ comment: 'Missing device' }));
  it('does not turn skipped or missing results into complete acceptance', () =>
    expect(
      runSummary(
        [{ caseKey: 'QA-A' }, { caseKey: 'QA-B' }],
        [{ caseKey: 'QA-A', status: 'skipped' }],
      ),
    ).toEqual({
      passed: 0,
      failed: 0,
      blocked: 0,
      skipped: 1,
      notRun: 1,
      total: 2,
      complete: false,
    }));
  it('a failed executed check is complete but remains failed', () =>
    expect(
      runSummary(
        [{ caseKey: 'QA-A' }],
        [{ caseKey: 'QA-A', status: 'failed' }],
      ),
    ).toMatchObject({ failed: 1, passed: 0, complete: true }));
});

describe('QA run role boundary', () => {
  it('uses the shared write boundary before creating a run or recording results', async () => {
    const scoped = jest.fn().mockRejectedValue(new ForbiddenException());
    const service = new QaRunService({ scoped } as unknown as QaCatalogService);
    const m = { accountId: 'account' } as AccountMembership;
    await expect(service.create(m, 'site', {})).rejects.toMatchObject({
      status: 403,
    });
    await expect(service.record(m, 'site', 'run', {})).rejects.toMatchObject({
      status: 403,
    });
    expect(scoped.mock.calls).toEqual([
      [m, 'site', true],
      [m, 'site', true],
    ]);
  });
});

it('creates a selection with one revision query and keeps selected order', async () => {
  const payload = {
    title: 'Case',
    purpose: '',
    preconditions: '',
    steps: [{ action: 'a', expected: 'b' }],
    type: 'manual',
    priority: 'normal',
    tags: [],
    requirementIds: [],
    archived: false,
  };
  const revisions = jest.fn().mockResolvedValue([
    { caseId: 'b', version: 2, payload },
    { caseId: 'a', version: 1, payload },
  ]);
  const create = jest
    .fn()
    .mockImplementation(({ data }) => Promise.resolve(data));
  const tx = {
    qaTestCase: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'a', caseKey: 'QA-A', currentVersion: 1 },
        { id: 'b', caseKey: 'QA-B', currentVersion: 2 },
      ]),
    },
    qaTestCaseRevision: { findMany: revisions },
    qaTestRun: { create },
  };
  const db = {
    $transaction: async (cb: (value: typeof tx) => Promise<unknown>) => cb(tx),
  };
  const service = new QaRunService({
    scoped: async () => db,
  } as unknown as QaCatalogService);
  const run = await service.create(
    { accountId: 'account', memberId: 'member' } as AccountMembership,
    'site',
    { title: 'Batch', caseIds: ['b', 'a'] },
  );
  expect(revisions).toHaveBeenCalledTimes(1);
  expect(revisions).toHaveBeenCalledWith({
    where: {
      accountId: 'account',
      OR: [
        { caseId: 'a', version: 1 },
        { caseId: 'b', version: 2 },
      ],
    },
  });
  expect(run.snapshot).toEqual([
    { caseId: 'b', caseKey: 'QA-B', version: 2, payload },
    { caseId: 'a', caseKey: 'QA-A', version: 1, payload },
  ]);
});
