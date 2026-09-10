/**
 * Ключ Gemini доезжает до SDK (этап 53, В-6.15).
 */
const ctorArgs: unknown[] = [];
jest.mock('@google/genai', () => ({
  GoogleGenAI: class {
    constructor(opts: unknown) {
      ctorArgs.push(opts);
    }
  },
}));

import { createGeminiClient, geminiApiKey } from './gemini-client';

describe('gemini-client', () => {
  beforeEach(() => ctorArgs.splice(0));

  it('принимает оба имени переменной, приоритет у GEMINI_API_KEY', () => {
    expect(
      geminiApiKey({ GEMINI_API_KEY: 'a', GOOGLE_GEMINI_API_KEY: 'b' }),
    ).toBe('a');
    expect(geminiApiKey({ GOOGLE_GEMINI_API_KEY: 'b' })).toBe('b');
    expect(geminiApiKey({})).toBeUndefined();
    expect(geminiApiKey({ GEMINI_API_KEY: '' })).toBeUndefined();
  });

  it('ключ передаётся SDK явно — в том числе из GOOGLE_GEMINI_API_KEY', () => {
    // Раньше `new GoogleGenAI({})` читал только свои переменные: оператор
    // с одним GOOGLE_GEMINI_API_KEY проходил проверку при старте и получал
    // отказ провайдера в рантайме.
    createGeminiClient({ GOOGLE_GEMINI_API_KEY: 'only-google-name' });
    expect(ctorArgs[0]).toEqual({ apiKey: 'only-google-name' });
  });

  it('без ключа — понятная ошибка при старте, а не в рантайме', () => {
    expect(() => createGeminiClient({})).toThrow(/GEMINI_API_KEY/);
  });
});
