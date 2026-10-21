import { streamSettings, signStreamGrant } from './stream-grant';
import { createHmac } from 'crypto';

describe('streaming uses current relay and an explicit bounded price', () => {
  const env = {
    ASSIST_STREAM_ENABLED: 'true',
    LIVE_LOGIN_RELAY_URL: 'https://relay.example',
    LIVE_LOGIN_RELAY_SECRET: 'test-only',
    ASSIST_STREAM_MICRO_USD_PER_MINUTE: '17',
  };
  it('is disabled by default; missing/invalid price never means free', () => {
    expect(streamSettings({})).toBeNull();
    for (const rate of ['', '0', '-1', 'NaN', '1.5', '1000001']) {
      expect(
        streamSettings({ ...env, ASSIST_STREAM_MICRO_USD_PER_MINUTE: rate }),
      ).toBeNull();
    }
  });
  it('requires an HTTPS server-configured relay without credentials', () => {
    expect(
      streamSettings({ ...env, LIVE_LOGIN_RELAY_URL: 'http://relay.example' }),
    ).toBeNull();
    expect(
      streamSettings({
        ...env,
        LIVE_LOGIN_RELAY_URL: 'https://user:pass@relay.example',
      }),
    ).toBeNull();
    expect(streamSettings({ ...env, LIVE_LOGIN_RELAY_SECRET: '' })).toBeNull();
    expect(streamSettings(env)?.chargeMicroUsd).toBe(17);
  });
  it('limits a canary to exact configured site IDs, failing closed for empty scope', () => {
    const scoped = {
      ...env,
      ASSIST_STREAM_SITE_IDS: ' sandbox-site, another-site ',
    };
    expect(streamSettings(scoped, 'sandbox-site')).not.toBeNull();
    expect(streamSettings(scoped, 'another-site')).not.toBeNull();
    for (const id of [undefined, '', 'sandbox', 'sandbox-site-extra']) {
      expect(streamSettings(scoped, id)).toBeNull();
    }
    expect(
      streamSettings({ ...env, ASSIST_STREAM_SITE_IDS: '' }, 'sandbox-site'),
    ).toBeNull();
  });
  it('signs exactly the VPS protocol with a domain-separated secret', () => {
    const p = {
      boot: 'mock-boot',
      id: 'reservation',
      expires: 12345,
      seconds: 30,
    };
    const s = signStreamGrant('test', p);
    expect(JSON.parse(Buffer.from(s.grant, 'base64url').toString())).toEqual(p);
    expect(s.signature).toBe(
      createHmac('sha256', 'test')
        .update(`soniox-stream-v1:${s.grant}`)
        .digest('base64url'),
    );
  });
});
