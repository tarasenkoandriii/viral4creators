import { assertRelaySecret, safeEqual } from '../src/auth';

describe('assertRelaySecret', () => {
  const secret = 'super-secret-value';

  it('accepts the correct secret', () => {
    expect(() => assertRelaySecret(secret, secret)).not.toThrow();
  });

  it('rejects a missing header', () => {
    expect(() => assertRelaySecret(undefined, secret)).toThrow(
      /неверный или отсутствующий/,
    );
  });

  it('rejects an incorrect secret', () => {
    expect(() => assertRelaySecret('wrong', secret)).toThrow();
  });

  it('rejects a secret of a different length', () => {
    expect(() => assertRelaySecret('short', secret)).toThrow();
  });

  it('trims surrounding whitespace before comparing', () => {
    expect(() => assertRelaySecret(`  ${secret}  `, secret)).not.toThrow();
  });

  it('rejects an empty string header', () => {
    expect(() => assertRelaySecret('', secret)).toThrow();
  });
});

describe('safeEqual', () => {
  it('returns true for identical strings', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
  });

  it('returns false for different strings of the same length', () => {
    expect(safeEqual('abc', 'abd')).toBe(false);
  });

  it('returns false for different lengths without throwing', () => {
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
