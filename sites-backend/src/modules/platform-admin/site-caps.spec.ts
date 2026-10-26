import { PlatformAdminController } from './platform-admin.controller';
import { PlatformAdmin } from './platform-admin.service';

describe('per-site voice caps', () => {
  it.each([null, 0, 'false', {}])(
    'rejects invalid auto-speech setting %p',
    (voiceAutoSpeak) => {
      const setSite = jest.fn();
      const controller = new PlatformAdminController(
        { setSite } as never,
        null as never,
      );
      expect(() =>
        controller.site('raffle-site', 'operator', { voiceAutoSpeak }),
      ).toThrow();
      expect(setSite).not.toHaveBeenCalled();
    },
  );
  it.each([true, false])(
    'updates auto-speech only for the selected site (%p)',
    async (voiceAutoSpeak) => {
      const prisma = {
        assistSite: {
          findUnique: jest.fn().mockResolvedValue({ accountId: 'owner' }),
          update: jest.fn(),
        },
        $executeRaw: jest.fn(),
        assistPlatformAccessLog: { create: jest.fn() },
      };
      const service = new PlatformAdmin(prisma as never);
      jest.spyOn(service, 'account').mockResolvedValue({} as never);
      await service.setSite('raffle-site', 'operator', { voiceAutoSpeak });
      expect(prisma.assistSite.update).not.toHaveBeenCalled();
      const [sql, value, site] = prisma.$executeRaw.mock.calls[0];
      expect(sql.join('')).toContain('jsonb_set');
      expect(value).toBe(JSON.stringify(voiceAutoSpeak));
      expect(site).toBe('raffle-site');
      expect(prisma.assistPlatformAccessLog.create).toHaveBeenCalledWith({
        data: {
          actor: 'operator',
          action: 'site:voice-auto-speak',
          target: 'raffle-site',
        },
      });
    },
  );

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
