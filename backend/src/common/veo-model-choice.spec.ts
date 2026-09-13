import { pickVeoModel, usesVeo30, VEO_3_0_MODEL } from './veo-model-choice';

describe('pickVeoModel (ТЗ §1)', () => {
  it('нет персонажей + standard — Veo 3.0', () => {
    expect(
      pickVeoModel({ legacyFirstFrame: true }, 'standard', 'veo-3.1-generate-preview'),
    ).toBe(VEO_3_0_MODEL);
  });

  it('есть персонажи + standard — фолбэк (Veo 3.1), не Veo 3.0', () => {
    expect(
      pickVeoModel({ legacyFirstFrame: false }, 'standard', 'veo-3.1-generate-preview'),
    ).toBe('veo-3.1-generate-preview');
  });

  it('fast — всегда фолбэк, независимо от персонажей (у Veo 3.0 нет Lite-аналога)', () => {
    expect(
      pickVeoModel({ legacyFirstFrame: true }, 'fast', 'veo-3.1-lite-generate-preview'),
    ).toBe('veo-3.1-lite-generate-preview');
    expect(
      pickVeoModel({ legacyFirstFrame: false }, 'fast', 'veo-3.1-lite-generate-preview'),
    ).toBe('veo-3.1-lite-generate-preview');
  });
});

describe('usesVeo30', () => {
  it('true только для standard + нет персонажей', () => {
    expect(usesVeo30({ legacyFirstFrame: true }, 'standard')).toBe(true);
  });

  it('false для fast, даже без персонажей', () => {
    expect(usesVeo30({ legacyFirstFrame: true }, 'fast')).toBe(false);
  });

  it('false с персонажами, даже на standard', () => {
    expect(usesVeo30({ legacyFirstFrame: false }, 'standard')).toBe(false);
  });
});
