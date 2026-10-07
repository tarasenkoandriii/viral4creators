/**
 * Потолок выхода Gemini: видимый ответ + запас на размышления (замер
 * 07.10.2026: при 200 — 94/250 пустых ответов, при 1024 — 0).
 */
import { GEMINI_THINKING_HEADROOM, geminiOutputCeiling } from './gemini-output';

describe('geminiOutputCeiling', () => {
  it('видимый ответ + запас ≥ 1024; дробное — вверх, мусор — минимум 1 видимый', () => {
    expect(GEMINI_THINKING_HEADROOM).toBeGreaterThanOrEqual(1024);
    expect(geminiOutputCeiling(200)).toBe(200 + GEMINI_THINKING_HEADROOM);
    expect(geminiOutputCeiling(299.2)).toBe(300 + GEMINI_THINKING_HEADROOM);
    expect(geminiOutputCeiling(0)).toBe(1 + GEMINI_THINKING_HEADROOM);
    expect(geminiOutputCeiling(-5)).toBe(1 + GEMINI_THINKING_HEADROOM);
    expect(geminiOutputCeiling(Number.NaN)).toBe(1 + GEMINI_THINKING_HEADROOM);
  });
});
