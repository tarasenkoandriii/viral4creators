import { SiteVoiceService } from './site-voice.service';

jest.mock('../../assist-billing/public/entitlements', () => ({
  readState: jest.fn(async () => ({ planId: 'business' })),
  siteDailyCapMicroUsd: jest.fn(() => 5000),
}));

describe('stream grant uses existing budgets before authorization leaves backend', () => {
  const ctx = {
    site: { siteId: 's', accountId: 'a', preview: false },
    visitor: {},
  } as never;
  const env = {
    ASSIST_STREAM_ENABLED: 'true',
    ASSIST_SECRETS_KEY: Buffer.alloc(32, 3).toString('base64'),
    LIVE_LOGIN_RELAY_URL: 'https://relay.example',
    LIVE_LOGIN_RELAY_SECRET: 'mock-secret',
    ASSIST_STREAM_MICRO_USD_PER_MINUTE: '100',
  };
  const reservation = {
    id: 'budget-id',
    siteId: 's',
    day: '2026-10-21',
    estMicroUsd: 100,
    expiresAt: new Date(),
    voice: true,
  };
  let voice: SiteVoiceService;
  let reserve: jest.Mock;
  let settle: jest.Mock;
  let request: jest.SpyInstance;
  beforeEach(() => {
    reserve = jest.fn(async () => ({ ok: true, reservation }));
    settle = jest.fn(async () => undefined);
    voice = new SiteVoiceService(
      {} as never,
      { reserve, settle } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    voice.env = env;
    jest
      .spyOn(voice, 'access')
      .mockResolvedValue({ input: true, capMicroUsd: 3000 } as never);
    Object.defineProperty(voice, 'unitsLeft', {
      value: jest.fn(async () => true),
    });
    Object.defineProperty(voice, 'siteCap', {
      value: jest.fn(async () => ({})),
    });
    request = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ boot: '00000000-0000-0000-0000-000000000000' }),
        ),
      );
  });
  afterEach(() => jest.restoreAllMocks());
  it('reserves site, platform and voice and settles ceiling before returning grant', async () => {
    const result = await voice.openStream(ctx);
    expect(result.ok).toBe(true);
    expect(reserve).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        siteId: 's',
        siteCapMicroUsd: 5000,
        voiceCapMicroUsd: 3000,
        estMicroUsd: 100,
      }),
    );
    expect(settle).toHaveBeenCalledWith(expect.anything(), reservation, 100);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe('https://relay.example/voice/boot');
  });
  it('a site outside canary scope cannot contact relay or reserve budget', async () => {
    voice.env = { ...env, ASSIST_STREAM_SITE_IDS: 'other-site' };
    expect(await voice.openStream(ctx)).toEqual({
      ok: false,
      failure: 'unavailable',
    });
    expect(request).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });
  it('denied budget produces no grant and no settle', async () => {
    reserve.mockResolvedValue({ ok: false, denied: 'voice_budget' });
    expect(await voice.openStream(ctx)).toEqual({
      ok: false,
      failure: 'limit',
    });
    expect(settle).not.toHaveBeenCalled();
  });
  it('unavailable relay spends nothing', async () => {
    request.mockRejectedValue(Error('offline'));
    expect(await voice.openStream(ctx)).toEqual({
      ok: false,
      failure: 'upstream',
    });
    expect(reserve).not.toHaveBeenCalled();
  });
  it('ambiguous settle fails closed without retry or authorization', async () => {
    settle.mockRejectedValue(Error('db timeout'));
    await expect(voice.openStream(ctx)).rejects.toThrow('db timeout');
    expect(settle).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledTimes(1);
  });
  it('disabled or forbidden voice never reaches relay or budget', async () => {
    voice.env = {};
    expect(await voice.openStream(ctx)).toEqual({
      ok: false,
      failure: 'unavailable',
    });
    voice.env = env;
    jest.spyOn(voice, 'access').mockResolvedValue({ input: false } as never);
    expect(await voice.openStream(ctx)).toEqual({
      ok: false,
      failure: 'unavailable',
    });
    expect(request).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });
});
