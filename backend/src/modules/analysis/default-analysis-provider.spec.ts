import {
  ANALYSIS_PROVIDER_KEYS,
  isAnalysisProviderKey,
  resolveDefaultAnalysisProvider,
} from './default-analysis-provider';

describe('isAnalysisProviderKey', () => {
  it('признаёт два допустимых значения', () => {
    for (const key of ANALYSIS_PROVIDER_KEYS) {
      expect(isAnalysisProviderKey(key)).toBe(true);
    }
  });

  it('отклоняет всё остальное — включая пусто/undefined/мусор', () => {
    expect(isAnalysisProviderKey('claude')).toBe(false);
    expect(isAnalysisProviderKey('')).toBe(false);
    expect(isAnalysisProviderKey(undefined)).toBe(false);
    expect(isAnalysisProviderKey(null)).toBe(false);
  });
});

describe('resolveDefaultAnalysisProvider', () => {
  it('значение из админки побеждает, если оно валидно', () => {
    expect(resolveDefaultAnalysisProvider('grok')).toBe('grok');
    expect(resolveDefaultAnalysisProvider('gemini')).toBe('gemini');
  });

  it('ничего не задано — умолчание gemini (текущее поведение до этой фичи)', () => {
    expect(resolveDefaultAnalysisProvider(null)).toBe('gemini');
    expect(resolveDefaultAnalysisProvider(undefined)).toBe('gemini');
  });

  it('мусор в записи — тихий откат на gemini, не исключение', () => {
    expect(resolveDefaultAnalysisProvider('claude')).toBe('gemini');
  });
});
