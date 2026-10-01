// СГЕНЕРИРОВАНО scripts/sync-sites-shared.mjs — не править.
// Источник: backend/src/common/assist-chat-core/protocol.spec.ts. Правка — в источнике, затем
// `node scripts/sync-sites-shared.mjs`; CI сверяет копию флагом --check.

import { chatUsageFromMeta, toGeminiContent } from './protocol';

describe('chatUsageFromMeta', () => {
  it('нет метаданных — нули, а не NaN/undefined', () => {
    expect(chatUsageFromMeta(null)).toEqual({ in: 0, out: 0, cached: 0 });
    expect(chatUsageFromMeta(undefined)).toEqual({ in: 0, out: 0, cached: 0 });
  });

  it('«мысли» модели считаются выходом', () => {
    expect(
      chatUsageFromMeta({
        promptTokenCount: 100,
        candidatesTokenCount: 20,
        thoughtsTokenCount: 7,
        cachedContentTokenCount: 80,
      }),
    ).toEqual({ in: 100, out: 27, cached: 80 });
  });
});

describe('toGeminiContent', () => {
  it('assistant → model, user остаётся user', () => {
    expect(toGeminiContent({ role: 'assistant', content: 'ок' })).toEqual({
      role: 'model',
      parts: [{ text: 'ок' }],
    });
    expect(toGeminiContent({ role: 'user', content: 'вопрос' })).toEqual({
      role: 'user',
      parts: [{ text: 'вопрос' }],
    });
  });
});
