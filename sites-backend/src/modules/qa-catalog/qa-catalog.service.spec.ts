import { QaCatalogService } from './qa-catalog.service';
import { parseCaseInput, parseVersion } from './qa-case-input';
import { AccountMembership } from '../site-core/account/roles';
const payload = () => ({
  title: 'Login',
  purpose: 'Verify login',
  preconditions: 'Demo account',
  steps: [{ action: 'Submit invalid password', expected: 'Rejected' }],
  type: 'manual',
  priority: 'high',
  tags: [],
  requirementIds: ['QA-LOGIN'],
  archived: false,
});
const member = (role = 'admin') =>
  ({
    accountId: 'account-a',
    memberId: 'member-a',
    role: 'operator',
    productRoles: { qa: role, assist: 'manager', assistAdmin: 'none' },
  }) as AccountMembership;
function fixture() {
  const tx = {
    site: { findFirst: jest.fn().mockResolvedValue({ id: 'site-a' }) },
    qaTestCase: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue({
        id: 'case-a',
        caseKey: 'QA-LOGIN',
        currentVersion: 1,
      }),
      create: jest.fn().mockResolvedValue({ id: 'case-a' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    qaTestCaseRevision: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
  };
  const client = { ...tx, $transaction: jest.fn(async (fn) => fn(tx)) };
  const db = { forAccount: jest.fn().mockReturnValue(client) };
  return { tx, client, db, service: new QaCatalogService(db as never) };
}
describe('QA versioned catalog', () => {
  it('denies assistant managers without a QA role before database access', async () => {
    const f = fixture();
    await expect(
      f.service.list(member('none'), 'site-a'),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.db.forAccount).not.toHaveBeenCalled();
  });
  it('viewers read but cannot mutate', async () => {
    const f = fixture();
    await f.service.list(member('viewer'), 'site-a');
    await expect(
      f.service.create(member('viewer'), 'site-a', {
        caseKey: 'QA-LOGIN',
        payload: payload(),
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.tx.qaTestCase.create).not.toHaveBeenCalled();
  });
  it('foreign site returns 404 and never reaches case tables', async () => {
    const f = fixture();
    f.tx.site.findFirst.mockResolvedValue(null);
    await expect(
      f.service.get(member(), 'site-b', 'case-b'),
    ).rejects.toMatchObject({ status: 404 });
    expect(f.tx.qaTestCase.findFirst).not.toHaveBeenCalled();
    expect(f.tx.site.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'site-b', accountId: 'account-a' },
      }),
    );
  });
  it('creates head and immutable revision in one transaction with member attribution', async () => {
    const f = fixture();
    await f.service.create(member(), 'site-a', {
      caseKey: 'QA-LOGIN',
      payload: payload(),
    });
    expect(f.client.$transaction).toHaveBeenCalledTimes(1);
    expect(f.tx.qaTestCaseRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        accountId: 'account-a',
        caseId: 'case-a',
        version: 1,
        createdByMemberId: 'member-a',
        payload: payload(),
      }),
    });
  });
  it('stale edits cannot write revisions or overwrite head', async () => {
    const f = fixture();
    f.tx.qaTestCase.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      f.service.replace(member(), 'site-a', 'case-a', {
        expectedVersion: 1,
        payload: payload(),
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(f.tx.qaTestCaseRevision.create).not.toHaveBeenCalled();
  });
  it('successful edits compare version and tenant and append a fresh revision', async () => {
    const f = fixture();
    await f.service.replace(member(), 'site-a', 'case-a', {
      expectedVersion: 1,
      payload: payload(),
    });
    expect(f.tx.qaTestCase.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'case-a',
        siteId: 'site-a',
        accountId: 'account-a',
        currentVersion: 1,
      },
      data: expect.objectContaining({ currentVersion: 2 }),
    });
    expect(f.tx.qaTestCaseRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ version: 2, accountId: 'account-a' }),
    });
  });
  it('history first verifies site and case ownership', async () => {
    const f = fixture();
    f.tx.qaTestCase.findFirst.mockResolvedValue(null);
    await expect(
      f.service.history(member(), 'site-a', 'foreign-case'),
    ).rejects.toMatchObject({ status: 404 });
    expect(f.tx.qaTestCaseRevision.findMany).not.toHaveBeenCalled();
  });
  it('duplicate stable keys return a safe conflict', async () => {
    const f = fixture();
    f.tx.qaTestCase.create.mockRejectedValue({ code: 'P2002' });
    await expect(
      f.service.create(member(), 'site-a', {
        caseKey: 'QA-LOGIN',
        payload: payload(),
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it.each([
    { ...payload(), type: ['manual'] },
    { ...payload(), steps: [] },
    { ...payload(), steps: [{ action: 'Click', expected: '' }] },
    { ...payload(), tags: ['x', 'x'] },
    { ...payload(), accountId: 'other' },
  ])('rejects invalid or untrusted case shape', (p) => {
    expect(() => parseCaseInput(p)).toThrow();
  });
  it('paginates without crossing the tenant or truncating history silently', async () => {
    const f = fixture();
    const rows = Array.from({ length: 101 }, (_, i) => ({
      caseKey: `QA-${String(i).padStart(3, '0')}`,
    }));
    f.tx.qaTestCase.findMany.mockResolvedValue(rows as never);
    const page = await f.service.list(member(), 'site-a', 'QA-000');
    expect(page.items).toHaveLength(100);
    expect(page.nextAfterKey).toBe('QA-099');
    expect(f.tx.qaTestCase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          accountId: 'account-a',
          siteId: 'site-a',
          caseKey: { gt: 'QA-000' },
        },
      }),
    );
    f.tx.qaTestCaseRevision.findMany.mockResolvedValue(
      Array.from({ length: 101 }, (_, i) => ({ version: 200 - i })),
    );
    const history = await f.service.history(
      member(),
      'site-a',
      'case-a',
      '201',
    );
    expect(history.items).toHaveLength(100);
    expect(history.nextBeforeVersion).toBe(101);
    expect(f.tx.qaTestCaseRevision.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          caseId: 'case-a',
          accountId: 'account-a',
          version: { lt: 201 },
        },
      }),
    );
  });
  it('bounds revisions to PostgreSQL integer range', () => {
    expect(() => parseVersion(2147483647)).toThrow();
    expect(() => parseVersion('1')).toThrow();
  });
});
