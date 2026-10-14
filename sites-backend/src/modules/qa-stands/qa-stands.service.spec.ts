import { QaStandsService } from './qa-stands.module';
import { baseline, planStand } from './stand-contract';
import { AccountMembership } from '../site-core/account/roles';
describe('QA stands persistence boundaries', () => {
  const m = { accountId: 'a' } as AccountMembership;
  const contract = planStand({
    description: 'Кабинет записей для тестирования',
  });
  function fixture() {
    const row = {
      id: 's',
      accountId: 'a',
      siteId: 'site',
      contract,
      records: baseline(contract),
      revision: 1,
    };
    const db = {
      qaStand: {
        findFirst: jest.fn().mockResolvedValue(row),
        findMany: jest.fn().mockResolvedValue([row]),
        create: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const catalog = { scoped: jest.fn().mockResolvedValue(db) };
    const sites = { forAccount: jest.fn().mockReturnValue(db) };
    return {
      db,
      catalog,
      sites,
      service: new QaStandsService(sites as never, catalog as never),
    };
  }
  it('requires real account write permission before mock mutation', async () => {
    const f = fixture();
    f.catalog.scoped.mockRejectedValue(new Error('forbidden'));
    await expect(
      f.service.command(m, 'site', 's', {
        method: 'POST',
        role: 'admin',
        values: ['a', 'b'],
      }),
    ).rejects.toThrow('forbidden');
    expect(f.db.qaStand.updateMany).not.toHaveBeenCalled();
  });
  it('allows read permission for GET without persisting or escalating access', async () => {
    const f = fixture();
    const result = await f.service.command(m, 'site', 's', {
      method: 'GET',
      role: 'viewer',
      scenario: 'normal',
    });
    expect(f.catalog.scoped).toHaveBeenCalledWith(m, 'site', false);
    expect(result.status).toBe(200);
    expect(result.revision).toBe(1);
    expect(f.db.qaStand.updateMany).not.toHaveBeenCalled();
  });
  it('scopes read by account and site', async () => {
    const f = fixture();
    await f.service.get(m, 'site', 's');
    expect(f.db.qaStand.findFirst).toHaveBeenCalledWith({
      where: { id: 's', accountId: 'a', siteId: 'site' },
    });
  });
  it('unknown or other tenant stand stays missing', async () => {
    const f = fixture();
    f.db.qaStand.findFirst.mockResolvedValue(null as never);
    await expect(f.service.get(m, 'site', 'other')).rejects.toThrow(
      'Стенд не найден',
    );
  });
  it('uses compare-and-swap to prevent lost updates', async () => {
    const f = fixture();
    f.db.qaStand.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      f.service.command(m, 'site', 's', {
        method: 'POST',
        role: 'editor',
        values: ['a', 'b'],
      }),
    ).rejects.toThrow('Стенд изменён');
    expect(f.db.qaStand.updateMany.mock.calls[0][0].where).toEqual({
      id: 's',
      siteId: 'site',
      accountId: 'a',
      revision: 1,
    });
  });
  it('does not write when simulated role forbids action', async () => {
    const f = fixture();
    const result = await f.service.command(m, 'site', 's', {
      method: 'POST',
      role: 'viewer',
      values: ['a', 'b'],
    });
    expect(result.status).toBe(403);
    expect(f.db.qaStand.updateMany).not.toHaveBeenCalled();
  });
  it('reuses requestId and rejects different description', async () => {
    const f = fixture();
    await f.service.create(m, 'site', {
      ...contract,
      requestId: '11111111-1111-1111-1111-111111111111',
    });
    expect(f.db.qaStand.create).not.toHaveBeenCalled();
    await expect(
      f.service.create(m, 'site', {
        ...contract,
        title: 'Different',
        requestId: '11111111-1111-1111-1111-111111111111',
      }),
    ).rejects.toThrow('requestId');
  });
});
