import { WidgetVoiceController } from './widget-voice.controller';

describe('stream route authenticates and shares STT limits before granting', () => {
  const ctx = {
    site: { siteId: 'site' },
    visitor: { visitorId: 'v', ipHash: 'ip' },
  };
  let auth: jest.Mock;
  let enforce: jest.Mock;
  let hit: jest.Mock;
  let grant: jest.Mock;
  let controller: WidgetVoiceController;
  const request = { headers: { origin: 'https://site.example' } } as never;
  const response = { setHeader: jest.fn() } as never;
  beforeEach(() => {
    auth = jest.fn(async () => ctx);
    enforce = jest.fn(async () => undefined);
    hit = jest.fn(async () => true);
    grant = jest.fn(async () => ({
      ok: true,
      url: 'wss://relay.example/voice/stream',
      grant: 'g',
      signature: 's',
      expires: 123,
    }));
    controller = new WidgetVoiceController(
      { authenticate: auth } as never,
      { enforce, hit } as never,
      { openStream: grant } as never,
    );
  });
  it('denied origin/token cannot reach budget or transport', async () => {
    auth.mockRejectedValue(Error('unauthorized'));
    await expect(
      controller.streamIn('invalid', request, response),
    ).rejects.toThrow('unauthorized');
    expect(grant).not.toHaveBeenCalled();
    expect(enforce).not.toHaveBeenCalled();
  });
  it('exhausted daily cap cannot issue grant', async () => {
    hit.mockResolvedValue(false);
    await expect(
      controller.streamIn('token', request, response),
    ).rejects.toThrow();
    expect(grant).not.toHaveBeenCalled();
  });
  it('shares async counter namespaces and returns only opaque transport grant', async () => {
    const r = await controller.streamIn('token', request, response);
    expect(enforce).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          scope: 'widget-stt-visitor-min',
          key: 'site:v',
        }),
        expect.objectContaining({
          scope: 'widget-stt-ip-site-min',
          key: 'site:ip',
        }),
      ]),
    );
    expect(hit).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'widget-stt-visitor-day' }),
    );
    expect(grant).toHaveBeenCalledWith(ctx);
    expect(r).toEqual({
      url: 'wss://relay.example/voice/stream',
      grant: 'g',
      signature: 's',
      expires: 123,
    });
  });
});
