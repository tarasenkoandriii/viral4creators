/**
 * Потолок ответа Gemini и признак обрыва.
 *
 * Модель по умолчанию (`gemini-3.6-flash`, `common/gemini-model.ts`) —
 * с размышлениями, и размышления (`usageMetadata.thoughtsTokenCount`)
 * тратят ТОТ ЖЕ `maxOutputTokens`, что и видимый ответ. Замер
 * классификатора регистра 07.10.2026: при потолке 200 — 94 пустых ответа
 * из 250 (`finishReason=MAX_TOKENS` раньше первого слова), при 1024 — ноль.
 * Те же малые потолки (300–600) стояли у подсказок мастера, переводов,
 * сценария поздравления, вариантов сеттинга и разбора реплик — там
 * ответ мог прийти пустым или оборваться посреди фразы.
 *
 * Правило: вызывающий задаёт размер ВИДИМОГО ответа, провайдеру уходит
 * `geminiOutputCeiling(видимый)` — с запасом на размышления. Платится
 * фактический расход, а не потолок, так что запас почти ничего не
 * стоит; модели без размышлений он не нужен и не вредит.
 *
 * Оборванный ответ (`MAX_TOKENS`) в дело не идёт: обрезанная подсказка,
 * перевод или текст поздравления хуже отказа, а отказ у каждого вызова
 * уже есть. То же правило в sites-backend — `site-ai/gemini-output.ts`.
 */

/** Запас на размышления поверх видимого ответа. */
export const GEMINI_THINKING_HEADROOM = 1024;

export const GEMINI_FINISH_MAX_TOKENS = 'MAX_TOKENS';

/** Потолок, который уходит провайдеру. */
export function geminiOutputCeiling(visibleTokens: number): number {
  return Math.max(1, Math.ceil(visibleTokens)) + GEMINI_THINKING_HEADROOM;
}

interface GeminiResponseLike {
  text?: string | null;
  candidates?: Array<{ finishReason?: unknown } | undefined> | null;
  usageMetadata?: {
    thoughtsTokenCount?: number;
    candidatesTokenCount?: number;
  } | null;
}

export interface GeminiOutput {
  /** Текст ответа как есть (может быть пустым). */
  text: string;
  finishReason: string | null;
  /** Ответ упёрся в потолок — даже если какой-то текст есть. */
  truncated: boolean;
  thoughtsTokens: number;
  outputTokens: number;
}

/** Разбор ответа: текст, причина завершения, обрыв, расход на размышления. */
export function readGeminiOutput(response: unknown): GeminiOutput {
  const r = (response ?? {}) as GeminiResponseLike;
  const raw = r.candidates?.[0]?.finishReason;
  const finishReason = raw == null ? null : String(raw);
  return {
    text: typeof r.text === 'string' ? r.text : '',
    finishReason,
    truncated: finishReason === GEMINI_FINISH_MAX_TOKENS,
    thoughtsTokens: r.usageMetadata?.thoughtsTokenCount ?? 0,
    outputTokens: r.usageMetadata?.candidatesTokenCount ?? 0,
  };
}

/**
 * Строка для лога — только служебное: ни текста ответа, ни промпта, ни
 * данных пользователя (в них бывают имена и поводы).
 */
export function describeGeminiOutput(o: GeminiOutput): string {
  return `finishReason=${o.finishReason ?? 'нет'}, thoughts=${o.thoughtsTokens}, out=${o.outputTokens}, len=${o.text.length}`;
}
