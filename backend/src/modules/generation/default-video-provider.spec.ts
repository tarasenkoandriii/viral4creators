import {
  VIDEO_PROVIDER_KEYS,
  isVideoProviderKey,
  resolveDefaultVideoProvider,
} from './default-video-provider';

describe('isVideoProviderKey', () => {
  it('признаёт оба допустимых значения', () => {
    for (const key of VIDEO_PROVIDER_KEYS) {
      expect(isVideoProviderKey(key)).toBe(true);
    }
  });

  it('отклоняет всё остальное', () => {
    expect(isVideoProviderKey('sora')).toBe(false);
    expect(isVideoProviderKey('')).toBe(false);
    expect(isVideoProviderKey(undefined)).toBe(false);
    expect(isVideoProviderKey(null)).toBe(false);
  });
});

describe('resolveDefaultVideoProvider', () => {
  it('значение из админки побеждает, если оно валидно', () => {
    expect(resolveDefaultVideoProvider('veo')).toBe('veo');
    expect(resolveDefaultVideoProvider('grok')).toBe('grok');
  });

  it('ничего не задано — умолчание grok (решено по прямому запросу, ТЗ §20)', () => {
    expect(resolveDefaultVideoProvider(null)).toBe('grok');
    expect(resolveDefaultVideoProvider(undefined)).toBe('grok');
  });

  it('мусор в записи — тихий откат на grok, не исключение', () => {
    expect(resolveDefaultVideoProvider('sora')).toBe('grok');
  });
});
