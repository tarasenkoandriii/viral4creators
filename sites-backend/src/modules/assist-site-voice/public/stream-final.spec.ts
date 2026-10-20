import { createHash, createHmac } from 'crypto';
import { SiteVoiceService } from './site-voice.service';
import { signStreamGrant, readStreamFinal } from './stream-grant';
import { verifyVoiceTicket } from './voice-ticket';
import { voiceTicketKey } from '../../../config/voice-env';
jest.mock('../../assist-billing/public/entitlements', () => ({
  readState: jest.fn(async () => ({ planId: 'business' })),
}));
const env = {
  ASSIST_STREAM_ENABLED: 'true',
  ASSIST_SECRETS_KEY: 'mock-only-voice-secret',
  LIVE_LOGIN_RELAY_URL: 'https://relay.example',
  LIVE_LOGIN_RELAY_SECRET: 'mock-only-relay-secret',
  ASSIST_STREAM_MICRO_USD_PER_MINUTE: '100',
};
const now = new Date('2026-10-21T10:00:00Z');
function receipt(
  tokens: unknown[],
  scope = { siteId: 'site', visitorId: 'visitor' },
) {
  const g = signStreamGrant(env.LIVE_LOGIN_RELAY_SECRET, {
    boot: 'boot',
    id: 'unique-reservation',
    seconds: 30,
    expires: now.getTime() + 30_000,
    ...scope,
  });
  const r = Buffer.from(
    JSON.stringify({
      grantHash: createHash('sha256').update(g.grant).digest('hex'),
      expires: now.getTime() + 90_000,
      tokens,
    }),
  ).toString('base64url');
  return {
    grant: g.grant,
    receipt: r,
    signature: createHmac('sha256', env.LIVE_LOGIN_RELAY_SECRET)
      .update(`soniox-final-v1:${r}`)
      .digest('base64url'),
  };
}
describe('final receipt to voice ticket, no provider calls', () => {
  const ctx = {
    site: { siteId: 'site', accountId: 'account' },
    visitor: { visitorId: 'visitor' },
  } as never;
  let voice: SiteVoiceService;
  let claim: jest.Mock;
  beforeEach(() => {
    claim = jest.fn().mockResolvedValue([{}]);
    voice = new SiteVoiceService(
      { $queryRawUnsafe: claim } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    voice.env = env;
    voice.now = () => now;
    jest.spyOn(voice, 'access').mockResolvedValue({ input: true } as never);
  });
  it('issues existing visitor/text-bound ticket only for authenticated final text', async () => {
    const out = await voice.finishStream(
      ctx,
      receipt([{ text: 'hello', confidence: 0.9, is_final: true }]),
    );
    expect(out).toMatchObject({ ok: true, text: 'hello' });
    if (!out.ok) throw Error('expected final');
    expect(
      verifyVoiceTicket(voiceTicketKey(env)!, out.ticket, {
        siteId: 'site',
        visitorId: 'visitor',
        text: 'hello',
        now,
      }),
    ).toBeTruthy();
    expect(claim).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, 0.2, null])(
    'rejects uncertain yes (%s) before claim',
    async (confidence) => {
      expect(
        await voice.finishStream(
          ctx,
          receipt([{ text: 'yes', confidence, is_final: true }]),
        ),
      ).toMatchObject({ ok: false, failure: 'not_heard' });
      expect(claim).not.toHaveBeenCalled();
    },
  );
  it('rejects forged, wrong visitor, expired and partial results', async () => {
    const p = receipt([{ text: 'yes', confidence: 0.99, is_final: true }]);
    for (const bad of [
      { ...p, signature: 'forged' },
      receipt([{ text: 'yes', confidence: 0.99, is_final: false }]),
      receipt([{ text: 'yes', confidence: 0.99, is_final: true }], {
        siteId: 'site',
        visitorId: 'other',
      }),
    ]) {
      expect(await voice.finishStream(ctx, bad)).toMatchObject({ ok: false });
    }
    expect(
      readStreamFinal(
        env.LIVE_LOGIN_RELAY_SECRET,
        p,
        'site',
        'visitor',
        now.getTime() + 100_000,
      ),
    ).toBeNull();
    expect(claim).not.toHaveBeenCalled();
  });
  it('same final is consumed once; DB errors cannot issue a ticket', async () => {
    const p = receipt([{ text: 'hello', is_final: true }]);
    claim
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(Error('db down'));
    expect(await voice.finishStream(ctx, p)).toMatchObject({ ok: true });
    expect(await voice.finishStream(ctx, p)).toMatchObject({ ok: false });
    await expect(voice.finishStream(ctx, p)).rejects.toThrow('db down');
  });
});
