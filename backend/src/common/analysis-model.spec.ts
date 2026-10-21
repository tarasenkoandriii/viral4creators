import { analysisModelCacheKey, resolveAnalysisModel } from './analysis-model';
import { DEFAULT_GEMINI_MODEL, GEMINI_MODEL } from './gemini-model';

describe('Argon rollout model and analysis cache', () => {
  it('uses Argon as the project default and rejects unknown stored analysis models', () => {
    expect(DEFAULT_GEMINI_MODEL).toBe('gemini-4-argon');
    expect(resolveAnalysisModel('unknown')).toBe(GEMINI_MODEL);
  });
  it('keeps the legacy unscoped cache with Flash and scopes Argon separately', () => {
    expect(analysisModelCacheKey('yt:one', 'gemini-3.6-flash')).toBe('yt:one');
    expect(analysisModelCacheKey('yt:one', 'gemini-4-argon')).toBe(
      'yt:one:model:gemini-4-argon',
    );
    expect(analysisModelCacheKey(null, 'gemini-4-argon')).toBeNull();
  });
});
