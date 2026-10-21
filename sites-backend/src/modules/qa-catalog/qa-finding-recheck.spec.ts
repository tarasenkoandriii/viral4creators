import { readFindingRecheck } from './qa-finding-recheck';
import { QaFindingService } from './qa-finding.service';
import { AccountMembership } from '../site-core/account/roles';
import { QaCatalogService } from './qa-catalog.service';
type Db = Awaited<ReturnType<QaCatalogService['scoped']>>;
const time = '2026-10-21T10:00:00Z';
const original = {
  id: 'old',
  runId: 'run-old',
  caseKey: 'SBX-TUTORIAL',
  accountId: 'a',
  origin: 'automated',
  project: 'desktop',
  reportHash: 'old-hash',
  sourceAttempt: 0,
  createdAt: new Date(time),
  attemptNumber: 1,
  status: 'failed',
  sourceMetadata: {
    source: 'playwright',
    targetOrigin: 'https://sandbox.viral4creators.app',
    startedAt: time,
    runnerStatus: 'passed',
  },
  run: { snapshot: [{ caseKey: 'SBX-TUTORIAL', version: 1 }] },
};
const candidate = (overrides = {}) => ({
  ...original,
  id: 'new',
  runId: 'run-new',
  reportHash: 'new-hash',
  createdAt: new Date('2026-10-21T11:00:00Z'),
  status: 'passed',
  sourceMetadata: {
    ...original.sourceMetadata,
    startedAt: '2026-10-21T11:00:00Z',
  },
  ...overrides,
});
const payload = {
  source: {
    runId: original.runId,
    caseKey: original.caseKey,
    attemptId: original.id,
  },
};
function fixture(rows: unknown[], origin: unknown = original) {
  const findFirst = jest.fn().mockResolvedValue(origin),
    findMany = jest.fn().mockResolvedValue(rows);
  return {
    db: { qaTestRunAttempt: { findFirst, findMany } } as unknown as Db,
    findFirst,
    findMany,
  };
}
describe('finding recheck evidence', () => {
  it('adds a scoped receipt without changing human status or revision', async () => {
    const f = fixture([candidate()]);
    const db = {
      ...f.db,
      qaFinding: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'finding',
          revision: 3,
          status: 'confirmed',
        }),
      },
      qaFindingRevision: {
        findFirst: jest.fn().mockResolvedValue({ payload }),
      },
    };
    const scoped = jest.fn().mockResolvedValue(db);
    const service = new QaFindingService({
      scoped,
    } as unknown as QaCatalogService);
    const result = await service.get(
      { accountId: 'a' } as AccountMembership,
      'site',
      'finding',
    );
    expect(scoped).toHaveBeenCalledWith({ accountId: 'a' }, 'site');
    expect(result).toMatchObject({
      revision: 3,
      status: 'confirmed',
      payload,
      recheck: { attemptId: 'new', requiresReview: true },
    });
  });
  it('reads a later compatible run without changing human acceptance', async () => {
    const f = fixture([candidate()]);
    expect(await readFindingRecheck(f.db, 'a', 'site', payload)).toMatchObject({
      runId: 'run-new',
      attemptId: 'new',
      caseVersion: 1,
      status: 'passed',
      requiresReview: true,
    });
    expect(f.findMany.mock.calls[0][0].where).toMatchObject({
      accountId: 'a',
      project: 'desktop',
      run: { accountId: 'a', siteId: 'site' },
    });
    expect(f.findMany.mock.calls[0][0].take).toBe(100);
  });
  it('blocks success under failed runner and preserves raw result', async () => {
    const f = fixture([
      candidate({
        sourceMetadata: {
          ...candidate().sourceMetadata,
          runnerStatus: 'failed',
        },
      }),
    ]);
    expect(await readFindingRecheck(f.db, 'a', 'site', payload)).toMatchObject({
      status: 'blocked',
      recordedStatus: 'passed',
      runnerStatus: 'failed',
    });
  });
  it('unknown runner stays blocked and has no fabricated runner result', async () => {
    const f = fixture([
      candidate({
        sourceMetadata: {
          ...candidate().sourceMetadata,
          runnerStatus: 'unknown',
        },
      }),
    ]);
    expect(await readFindingRecheck(f.db, 'a', 'site', payload)).toMatchObject({
      status: 'blocked',
      recordedStatus: 'passed',
      runnerStatus: null,
    });
  });
  it.each([
    { run: { snapshot: [{ caseKey: 'SBX-TUTORIAL', version: 2 }] } },
    {
      sourceMetadata: {
        ...candidate().sourceMetadata,
        targetOrigin: 'https://other.test',
      },
    },
    {
      sourceMetadata: {
        ...candidate().sourceMetadata,
        startedAt: '2026-10-21T09:00:00Z',
      },
    },
    { sourceMetadata: { ...candidate().sourceMetadata, source: 'jest' } },
    { reportHash: null },
  ])('does not certify incompatible or stale evidence %j', async (change) => {
    const f = fixture([candidate(change)]);
    expect(await readFindingRecheck(f.db, 'a', 'site', payload)).toBeNull();
  });
  it('shows successful retry from the same report', async () => {
    const f = fixture([
      candidate({
        runId: original.runId,
        reportHash: original.reportHash,
        sourceMetadata: original.sourceMetadata,
        sourceAttempt: 1,
      }),
    ]);
    expect(await readFindingRecheck(f.db, 'a', 'site', payload)).toMatchObject({
      status: 'passed',
    });
  });
  it('returns null for manual or missing source without candidate queries', async () => {
    const f = fixture([], { ...original, origin: 'manual' });
    expect(await readFindingRecheck(f.db, 'a', 'site', payload)).toBeNull();
    expect(await readFindingRecheck(f.db, 'a', 'site', {})).toBeNull();
    expect(f.findMany).not.toHaveBeenCalled();
  });
  it('uses actual test time rather than late delivery time', async () => {
    const later = candidate();
    const stale = candidate({
      id: 'stale',
      createdAt: new Date('2026-10-21T12:00:00Z'),
      sourceMetadata: {
        ...later.sourceMetadata,
        startedAt: '2026-10-21T10:30:00Z',
      },
    });
    expect(
      await readFindingRecheck(
        fixture([stale, later]).db,
        'a',
        'site',
        payload,
      ),
    ).toMatchObject({ attemptId: 'new' });
  });
});
