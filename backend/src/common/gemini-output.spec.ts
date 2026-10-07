import {
  GEMINI_FINISH_MAX_TOKENS,
  GEMINI_THINKING_HEADROOM,
  describeGeminiOutput,
  geminiOutputCeiling,
  readGeminiOutput,
} from './gemini-output';

/**
 * Потолок ответа Gemini и признак обрыва. Модель с размышлениями тратит
 * их из того же `maxOutputTokens`: малый потолок давал пустой ответ с
 * `finishReason=MAX_TOKENS`. Здесь — само правило; что обрыв не идёт в
 * дело, проверяют спеки вызывающих сервисов.
 */
describe('geminiOutputCeiling', () => {
  it('запас на размышления — 1024 токена', () => {
    expect(GEMINI_THINKING_HEADROOM).toBe(1024);
  });

  it('видимый размер + запас: 300 → 1324', () => {
    expect(geminiOutputCeiling(300)).toBe(1324);
    expect(geminiOutputCeiling(4000)).toBe(5024);
  });

  it('дробный размер округляется вверх, а не вниз', () => {
    expect(geminiOutputCeiling(299.1)).toBe(1324);
    expect(geminiOutputCeiling(0.2)).toBe(1 + 1024);
  });

  it('ноль и отрицательное — минимум один видимый токен, запас не теряется', () => {
    expect(geminiOutputCeiling(0)).toBe(1025);
    expect(geminiOutputCeiling(-50)).toBe(1025);
  });
});

describe('readGeminiOutput', () => {
  it('MAX_TOKENS с текстом — обрыв, даже если текст есть', () => {
    const out = readGeminiOutput({
      text: 'Марина, с днём рожд',
      candidates: [{ finishReason: 'MAX_TOKENS' }],
      usageMetadata: { thoughtsTokenCount: 900, candidatesTokenCount: 12 },
    });
    expect(out).toEqual({
      text: 'Марина, с днём рожд',
      finishReason: GEMINI_FINISH_MAX_TOKENS,
      truncated: true,
      thoughtsTokens: 900,
      outputTokens: 12,
    });
  });

  it('MAX_TOKENS без текста — размышления съели потолок раньше первого слова', () => {
    const out = readGeminiOutput({
      candidates: [{ finishReason: 'MAX_TOKENS' }],
      usageMetadata: { thoughtsTokenCount: 1300 },
    });
    expect(out.text).toBe('');
    expect(out.truncated).toBe(true);
    expect(out.thoughtsTokens).toBe(1300);
    expect(out.outputTokens).toBe(0);
  });

  it('STOP — обычный ответ, не обрыв', () => {
    const out = readGeminiOutput({
      text: 'готово',
      candidates: [{ finishReason: 'STOP' }],
      usageMetadata: { thoughtsTokenCount: 40, candidatesTokenCount: 3 },
    });
    expect(out.truncated).toBe(false);
    expect(out.finishReason).toBe('STOP');
    expect(out.text).toBe('готово');
  });

  it('нет candidates и usageMetadata — причина null, счётчики нули, не обрыв', () => {
    expect(readGeminiOutput({ text: 'ок' })).toEqual({
      text: 'ок',
      finishReason: null,
      truncated: false,
      thoughtsTokens: 0,
      outputTokens: 0,
    });
    expect(
      readGeminiOutput({ text: 'ок', candidates: null, usageMetadata: null }),
    ).toMatchObject({ finishReason: null, truncated: false });
    expect(readGeminiOutput({ text: 'ок', candidates: [] }).finishReason).toBe(
      null,
    );
    expect(
      readGeminiOutput({ text: 'ок', candidates: [undefined] }).finishReason,
    ).toBe(null);
  });

  it('пустой или отсутствующий ответ целиком — пустой результат без обрыва', () => {
    for (const r of [undefined, null, {}]) {
      expect(readGeminiOutput(r)).toEqual({
        text: '',
        finishReason: null,
        truncated: false,
        thoughtsTokens: 0,
        outputTokens: 0,
      });
    }
  });

  it('не-строковый text читается как пустая строка', () => {
    expect(readGeminiOutput({ text: null }).text).toBe('');
    expect(readGeminiOutput({ text: 42 }).text).toBe('');
    expect(readGeminiOutput({ text: { parts: ['x'] } }).text).toBe('');
  });

  it('finishReason не строкой (enum SDK) приводится к строке', () => {
    const out = readGeminiOutput({
      candidates: [{ finishReason: { toString: () => 'MAX_TOKENS' } }],
    });
    expect(out.finishReason).toBe('MAX_TOKENS');
    expect(out.truncated).toBe(true);
  });
});

describe('describeGeminiOutput', () => {
  it('служебные поля есть, текста ответа нет', () => {
    const secret = 'Марина Иванова, с юбилеем 50 лет!';
    const line = describeGeminiOutput(
      readGeminiOutput({
        text: secret,
        candidates: [{ finishReason: 'MAX_TOKENS' }],
        usageMetadata: { thoughtsTokenCount: 900, candidatesTokenCount: 7 },
      }),
    );
    expect(line).toBe(
      `finishReason=MAX_TOKENS, thoughts=900, out=7, len=${secret.length}`,
    );
    expect(line).not.toContain('Марина');
    expect(line).not.toContain('юбилеем');
  });

  it('без причины завершения — «нет», а не null/undefined', () => {
    const line = describeGeminiOutput(readGeminiOutput({ text: '' }));
    expect(line).toBe('finishReason=нет, thoughts=0, out=0, len=0');
  });
});
