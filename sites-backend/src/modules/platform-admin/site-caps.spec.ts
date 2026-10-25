import { PlatformAdminController } from './platform-admin.controller';
import { PlatformAdmin } from './platform-admin.service';

describe('per-site voice caps', () => {
  const siteId = 'raffle-site';
  it.each([-1, 1001, NaN, Infinity, '0.01', {}, true])(
    'rejects invalid voice cap %p before mutation',
    (value) => {
      const setSite = jest.fn();
      const controller = new PlatformAdminController(
        { setSite } as unknown as PlatformAdmin,
        null as never,
      );
      expect(() =>
        controller.site(siteId, 'operator', { voiceDailyCapUsd: value }),
      ).toThrow();
      expect(setSite).not.toHaveBeenCalled();
    },
  );
  it.each([0, 0.01, 1000, null])(
    'passes a valid cap %p only to the requested site',
    (value) => {
      const setSite = jest.fn();
      const controller = new PlatformAdminController(
        { setSite } as unknown as PlatformAdmin,
        null as never,
      );
      controller.site(siteId, 'operator', { voiceDailyCapUsd: value });
      expect(setSite).toHaveBeenCalledWith(
        siteId,
        'operator',
        expect.objectContaining({ voiceDailyCapUsd: value }),
      );
    },
  );
  it('writes integer microdollars and audits only the selected site without changing its plan', async () => {
    const prisma = {
      assistSite: {
        findUnique: jest.fn().mockResolvedValue({ accountId: 'owner' }),
        update: jest.fn(),
      },
      assistPlatformAccessLog: { create: jest.fn() },
    };
    const service = new PlatformAdmin(prisma as never);
    jest.spyOn(service, 'account').mockResolvedValue({} as never);
    await service.setSite(siteId, 'operator', { voiceDailyCapUsd: 0.01 });
    expect(prisma.assistSite.update).toHaveBeenCalledWith({
      where: { siteId },
      data: { voiceDailyCapMicroUsd: 10000 },
    });
    expect(prisma.assistPlatformAccessLog.create).toHaveBeenCalledWith({
      data: { actor: 'operator', action: 'site:voice-cap', target: siteId },
    });
  });
});
