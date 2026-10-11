import { ForbiddenException } from '@nestjs/common';
import { parseFinding, findingFingerprint } from './qa-finding-input';
import { QaFindingService } from './qa-finding.service';
import { QaCatalogService } from './qa-catalog.service';
import { AccountMembership } from '../site-core/account/roles';
const payload = {
  title: 'Login overlaps',
  category: 'layout',
  severity: 'P2',
  status: 'needs_confirmation',
  url: 'https://example.com/login',
  context: '390x844 dark ru',
  steps: 'Open login',
  expected: 'Button visible per specification',
  actual: 'Button covered',
  impact: 'Cannot login',
  evidence: [],
  deployedSha: null,
  observedAt: '2026-10-10T10:00:00Z',
  verification: null,
};
describe('QA findings input', () => {
  it('normalizes timestamps and produces a stable observation identity', () => {
    const p = parseFinding(payload);
    expect(p.observedAt).toBe('2026-10-10T10:00:00.000Z');
    expect(findingFingerprint(p)).toBe(
      findingFingerprint(
        parseFinding({
          ...payload,
          title: 'Other title',
          severity: 'P1',
          steps: ' Open   login ',
        }),
      ),
    );
  });
  it.each([
    null,
    {},
    { ...payload, accountId: 'other' },
    { ...payload, status: ['confirmed'] },
    { ...payload, status: 'confirmed' },
    { ...payload, url: 'https://u:p@example.com' },
    { ...payload, url: 'https://example.com?token=x' },
    { ...payload, url: 'javascript:alert(1)' },
    { ...payload, deployedSha: 'unknown' },
    { ...payload, observedAt: 'tomorrow' },
    { ...payload, evidence: ['x'.repeat(501)] },
    { ...payload, status: 'fixed_verified', evidence: ['screenshot'] },
  ])('rejects invalid or unsupported proof %p', (input) =>
    expect(() => parseFinding(input)).toThrow(),
  );
  it('requires a repeat check to close as fixed, and rejects checks before observation', () => {
    const verification = {
      steps: 'Repeat login',
      result: 'Button visible',
      checkedAt: '2026-10-11T10:00:00Z',
      deployedSha: 'a'.repeat(40),
    };
    expect(
      parseFinding({
        ...payload,
        status: 'fixed_verified',
        evidence: ['screenshot'],
        verification,
      }).status,
    ).toBe('fixed_verified');
    expect(() =>
      parseFinding({
        ...payload,
        status: 'fixed_verified',
        evidence: ['screenshot'],
        verification: { ...verification, checkedAt: '2026-10-09T10:00:00Z' },
      }),
    ).toThrow();
  });
});
const member = {
  accountId: 'account',
  memberId: 'member',
} as AccountMembership;
function fixture() {
  const tx = {
    qaFinding: {
      findFirst: jest.fn().mockResolvedValue({ id: 'finding' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest.fn().mockResolvedValue({ id: 'finding' }),
    },
    qaFindingRevision: { create: jest.fn() },
  };
  const db = {
    ...tx,
    $transaction: jest.fn(async (fn: (v: typeof tx) => unknown) => fn(tx)),
  };
  const scoped = jest.fn().mockResolvedValue(db);
  return {
    tx,
    db,
    scoped,
    service: new QaFindingService({ scoped } as unknown as QaCatalogService),
  };
}
describe('QA findings tenant and revision boundary', () => {
  it('checks access before parsing or writes', async () => {
    const scoped = jest.fn().mockRejectedValue(new ForbiddenException());
    const s = new QaFindingService({ scoped } as unknown as QaCatalogService);
    await expect(s.create(member, 'site', null)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(scoped).toHaveBeenCalledWith(member, 'site', true);
  });
  it('does not append a version after a stale edit', async () => {
    const f = fixture();
    f.tx.qaFinding.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      f.service.replace(member, 'site', 'finding', {
        expectedRevision: 1,
        payload,
      }),
    ).rejects.toMatchObject({ response: { code: 'QA_FINDING_CONFLICT' } });
    expect(f.tx.qaFindingRevision.create).not.toHaveBeenCalled();
  });
  it('rejects foreign or missing findings before appending', async () => {
    const f = fixture();
    f.tx.qaFinding.findFirst.mockResolvedValue(null);
    await expect(
      f.service.replace(member, 'site', 'finding', {
        expectedRevision: 1,
        payload,
      }),
    ).rejects.toMatchObject({ response: { code: 'QA_FINDING_NOT_FOUND' } });
    expect(f.tx.qaFinding.updateMany).not.toHaveBeenCalled();
  });
  it('keeps author, tenant and immutable revision on a successful edit', async () => {
    const f = fixture();
    await f.service.replace(member, 'site', 'finding', {
      expectedRevision: 2,
      payload,
    });
    expect(f.tx.qaFinding.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'finding',
          accountId: 'account',
          siteId: 'site',
          revision: 2,
        },
      }),
    );
    expect(f.tx.qaFindingRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        accountId: 'account',
        findingId: 'finding',
        version: 3,
        createdByMemberId: 'member',
      }),
    });
  });
  it('returns only a tenant-scoped existing id for a duplicate', async () => {
    const f = fixture();
    f.tx.qaFinding.create.mockRejectedValue({ code: 'P2002' });
    await expect(
      f.service.create(member, 'site', payload),
    ).rejects.toMatchObject({
      response: {
        code: 'QA_FINDING_DUPLICATE',
        details: { findingId: 'finding' },
      },
    });
    expect(f.tx.qaFindingRevision.create).not.toHaveBeenCalled();
    expect(f.tx.qaFinding.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          accountId: 'account',
          siteId: 'site',
        }),
      }),
    );
  });
});
