import { threadKey } from './reddit-kit.testing';
import { looksLikeContact } from '../../core/pii-guard';
describe('Reddit acceptance fixture keys', () => {
  it('remain valid Reddit keys without phone-shaped digit sequences in free text', () => {
    const keys = Array.from({ length: 100 }, () => threadKey());
    expect(new Set(keys).size).toBe(100);
    for (const key of keys) {
      expect(key).toMatch(/^[a-z]{13}$/);
      expect(looksLikeContact(`rename 3 ${key}`)).toBe(false);
      expect(looksLikeContact(`same phrase ${key}`)).toBe(false);
    }
  });
});
