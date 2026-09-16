import {
  generateStreamToken,
  hashToken,
  verifyStreamToken,
} from '../src/stream-token';

describe('stream-token', () => {
  it('generates unique tokens with sufficient entropy', () => {
    const a = generateStreamToken();
    const b = generateStreamToken();
    expect(a.token).not.toEqual(b.token);
    expect(a.token.length).toBeGreaterThanOrEqual(32);
  });

  it('verifies a token against its own hash', () => {
    const { token, hash } = generateStreamToken();
    expect(verifyStreamToken(token, hash)).toBe(true);
  });

  it('rejects a token that belongs to a different session', () => {
    const a = generateStreamToken();
    const b = generateStreamToken();
    expect(verifyStreamToken(a.token, b.hash)).toBe(false);
  });

  it('rejects a tampered token', () => {
    const { token, hash } = generateStreamToken();
    expect(verifyStreamToken(`${token}x`, hash)).toBe(false);
  });

  it('rejects an empty token', () => {
    const { hash } = generateStreamToken();
    expect(verifyStreamToken('', hash)).toBe(false);
  });

  it('hashToken is deterministic', () => {
    expect(hashToken('abc')).toEqual(hashToken('abc'));
  });
});
