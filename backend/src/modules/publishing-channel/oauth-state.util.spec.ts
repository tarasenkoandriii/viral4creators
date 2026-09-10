import { createHmac } from 'crypto';
import { signOAuthState, verifyOAuthState } from './oauth-state.util';

const KEY = 'test-channel-token-key';

describe('oauth-state.util', () => {
  it('round-trip: verify возвращает userId/platform, подписанные sign', () => {
    const state = signOAuthState('user-1', 'YOUTUBE', KEY);
    const payload = verifyOAuthState(state, KEY);
    expect(payload?.userId).toBe('user-1');
    expect(payload?.platform).toBe('YOUTUBE');
  });

  it('подделанная подпись — null, а не исключение', () => {
    const state = signOAuthState('user-1', 'YOUTUBE', KEY);
    const [payload] = state.split('.');
    const tampered = `${payload}.wrongsignature`;
    expect(verifyOAuthState(tampered, KEY)).toBeNull();
  });

  it('подделанный payload при валидной по формату подписи — null', () => {
    const state = signOAuthState('user-1', 'YOUTUBE', KEY);
    const [, sig] = state.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({
        userId: 'attacker',
        platform: 'YOUTUBE',
        expiresAt: 9999999999,
      }),
      'utf8',
    ).toString('base64url');
    expect(verifyOAuthState(`${forgedPayload}.${sig}`, KEY)).toBeNull();
  });

  it('неверный ключ проверки — null', () => {
    const state = signOAuthState('user-1', 'YOUTUBE', KEY);
    expect(verifyOAuthState(state, 'a-different-key')).toBeNull();
  });

  it('просроченный state — null', () => {
    const expiredPayload = Buffer.from(
      JSON.stringify({ userId: 'user-1', platform: 'YOUTUBE', expiresAt: 1 }),
      'utf8',
    ).toString('base64url');
    const sig = createHmac('sha256', KEY)
      .update(expiredPayload)
      .digest('base64url');
    expect(verifyOAuthState(`${expiredPayload}.${sig}`, KEY)).toBeNull();
  });

  it('пустой/отсутствующий state — null', () => {
    expect(verifyOAuthState(undefined, KEY)).toBeNull();
    expect(verifyOAuthState('', KEY)).toBeNull();
    expect(verifyOAuthState('not-two-parts', KEY)).toBeNull();
  });

  it('без CHANNEL_TOKEN_KEY — sign бросает понятную ошибку', () => {
    expect(() => signOAuthState('user-1', 'YOUTUBE', undefined)).toThrow(
      /CHANNEL_TOKEN_KEY не задан/,
    );
  });
});
