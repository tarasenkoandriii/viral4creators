import {
  isVoiceoverProviderKey,
  resolveDefaultProviderKey,
  VOICEOVER_PROVIDER_KEYS,
} from './default-tts-provider';

describe('isVoiceoverProviderKey', () => {
  it('признаёт три допустимых значения', () => {
    for (const key of VOICEOVER_PROVIDER_KEYS) {
      expect(isVoiceoverProviderKey(key)).toBe(true);
    }
  });

  it('отклоняет всё остальное — включая пусто/undefined/мусор', () => {
    expect(isVoiceoverProviderKey('cartesia')).toBe(false);
    expect(isVoiceoverProviderKey('')).toBe(false);
    expect(isVoiceoverProviderKey(undefined)).toBe(false);
    expect(isVoiceoverProviderKey(null)).toBe(false);
  });
});

describe('resolveDefaultProviderKey', () => {
  it('значение из админки побеждает, если оно валидно', () => {
    expect(resolveDefaultProviderKey('resemble', {})).toBe('resemble');
    expect(resolveDefaultProviderKey('veo', { TTS_PROVIDER: 'resemble' })).toBe(
      'veo',
    );
  });

  it('без записи в админке — откат на TTS_PROVIDER из окружения', () => {
    expect(resolveDefaultProviderKey(null, { TTS_PROVIDER: 'resemble' })).toBe(
      'resemble',
    );
    expect(resolveDefaultProviderKey(undefined, { TTS_PROVIDER: 'VEO' })).toBe(
      'veo',
    ); // регистр не важен — так же, как у старой фабрики tts.module.ts
  });

  it('ни админка, ни окружение — умолчание elevenlabs (не регресс этапа 70)', () => {
    expect(resolveDefaultProviderKey(null, {})).toBe('elevenlabs');
    expect(resolveDefaultProviderKey(undefined, {})).toBe('elevenlabs');
  });

  it('мусор в любом из двух источников пропускается молча, а не бросает', () => {
    expect(
      resolveDefaultProviderKey('cartesia', { TTS_PROVIDER: 'resemble' }),
    ).toBe('resemble');
    expect(resolveDefaultProviderKey('cartesia', { TTS_PROVIDER: 'xyz' })).toBe(
      'elevenlabs',
    );
  });
});
