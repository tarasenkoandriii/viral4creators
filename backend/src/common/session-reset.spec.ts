import { REFERENCE_DERIVED_KEYS, referenceResetPatch } from './session-reset';

describe('referenceResetPatch (этап 28)', () => {
  it('очищает ровно то, что описывало прежний референс', () => {
    const patch = referenceResetPatch();
    expect(Object.keys(patch).sort()).toEqual(
      [...REFERENCE_DERIVED_KEYS].sort(),
    );
    for (const key of REFERENCE_DERIVED_KEYS) {
      expect(patch[key]).toBeUndefined();
    }
  });

  it('не трогает товар, снимок бренда, загруженные сцены и готовый ролик', () => {
    const patch = referenceResetPatch() as Record<string, unknown>;
    for (const key of [
      'productInformation',
      'brandManifestSnapshot',
      'scenes',
      'generatedVideo',
      'generationPrompt',
    ]) {
      expect(key in patch).toBe(false);
    }
  });
});
