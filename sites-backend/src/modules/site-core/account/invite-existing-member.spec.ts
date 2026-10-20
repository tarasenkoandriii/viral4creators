import { AccountService } from './account.service';
import type { SitesDb } from '../../../prisma/sites-db.service';
import type { RequestIdentity } from '../../telegram-auth/identity';
const identity: RequestIdentity = {
  app: 'assist',
  telegramId: 123n,
  username: null,
  firstName: null,
  languageCode: null,
};
const now = new Date('2026-10-20T00:00:00Z');
const member = (role: string) => ({
  id: 'member',
  accountId: 'account',
  telegramId: 123n,
  role,
  productRoles: { qa: 'viewer' },
  createdAt: now,
});
function setup(existing: string | null) {
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  const create = jest.fn().mockResolvedValue(member('operator'));
  const row = {
    id: 'invite',
    accountId: 'account',
    role: 'operator',
    productRoles: { qa: 'viewer' },
    usedAt: null,
    expiresAt: new Date(now.getTime() + 60000),
  };
  const client = {
    siteAccountInvite: {
      findUnique: jest.fn().mockResolvedValue(row),
      updateMany,
    },
    siteAccountMember: {
      findMany: jest.fn().mockResolvedValue(existing ? [member(existing)] : []),
      create,
    },
  };
  return {
    service: new AccountService({
      system: () => client,
      forAccount: () => client,
    } as unknown as SitesDb),
    updateMany,
    create,
    row,
  };
}
describe('Existing members do not spend invitations', () => {
  it.each(['owner', 'manager', 'operator'])(
    'preserves %s membership and invitation',
    async (role) => {
      const s = setup(role);
      const result = await s.service.acceptInvite(
        identity,
        'A'.repeat(32),
        now,
      );
      expect(result.role).toBe(role);
      expect(s.updateMany).not.toHaveBeenCalled();
      expect(s.create).not.toHaveBeenCalled();
    },
  );
  it('a newcomer claims once before membership creation', async () => {
    const s = setup(null);
    await s.service.acceptInvite(identity, 'A'.repeat(32), now);
    expect(s.updateMany).toHaveBeenCalledWith({
      where: { id: 'invite', usedAt: null },
      data: { usedAt: now, usedByTelegramId: 123n },
    });
    expect(s.create).toHaveBeenCalledTimes(1);
  });
  it('a lost concurrent claim does not create a duplicate', async () => {
    const s = setup(null);
    s.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      s.service.acceptInvite(identity, 'A'.repeat(32), now),
    ).rejects.toThrow();
    expect(s.create).not.toHaveBeenCalled();
  });
  it('an expired invitation is still rejected for an existing owner', async () => {
    const s = setup('owner');
    s.row.expiresAt = now;
    await expect(
      s.service.acceptInvite(identity, 'A'.repeat(32), now),
    ).rejects.toThrow();
    expect(s.updateMany).not.toHaveBeenCalled();
  });
});
