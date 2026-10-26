import { describeDb } from '../assist-sandbox/testing/k3-stack.testing';
import { ChatStack } from '../assist-site-chat/testing/chat-stack.testing';
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
      expect(sql.join('')).toContain('UPDATE "sites"."assist_sites"');
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

describeDb('admin auto-speech with the default database search path', () => {
  const st = new ChatStack();
  beforeAll(async () => st.init());
  afterAll(async () => st.close());
  it('persists both values without changing other voice settings, caps or sites', async () => {
    const one = await st.site();
    const two = await st.site();
    const voiceConfig = {
      schema: 1,
      input: true,
      output: true,
      voiceId: 'Maya',
    };
    await st.owner.assistSite.update({
      where: { siteId: one.siteId },
      data: {
        voiceConfig,
        dailyCapMicroUsd: 500000,
        voiceDailyCapMicroUsd: 100000,
      },
    });
    const other = await st.owner.assistSite.findUniqueOrThrow({
      where: { siteId: two.siteId },
    });
    const service = new PlatformAdmin(st.owner);
    jest.spyOn(service, 'account').mockResolvedValue({} as never);
    const search = await st.owner.$queryRaw<
      Array<{ search_path: string }>
    >`SHOW search_path`;
    expect(search[0].search_path).not.toContain('sites');
    for (const voiceAutoSpeak of [false, true]) {
      await service.setSite(one.siteId, 'operator', { voiceAutoSpeak });
      const row = await st.owner.assistSite.findUniqueOrThrow({
        where: { siteId: one.siteId },
      });
      expect(row.voiceConfig).toEqual({
        ...voiceConfig,
        autoSpeak: voiceAutoSpeak,
      });
      expect(row.dailyCapMicroUsd).toBe(500000);
      expect(row.voiceDailyCapMicroUsd).toBe(100000);
      const untouched = await st.owner.assistSite.findUniqueOrThrow({
        where: { siteId: two.siteId },
      });
      expect(untouched.voiceConfig).toEqual(other.voiceConfig);
      expect(untouched.dailyCapMicroUsd).toBe(other.dailyCapMicroUsd);
      expect(untouched.voiceDailyCapMicroUsd).toBe(other.voiceDailyCapMicroUsd);
    }
  });
});
