/**
 * Потолок выхода Gemini = видимый ответ + запас на размышления.
 *
 * Почему: модель по умолчанию (`GEMINI_MODEL` = gemini-4-argon) думает, и
 * размышления (`usageMetadata.thoughtsTokenCount`) тратят ТОТ ЖЕ потолок
 * `maxOutputTokens`, что и ответ. Замер 07.10.2026 (backend, классификатор, прежняя 3.6 Flash):
 * при потолке 200 — 94 пустых ответа из 250 (`finishReason=MAX_TOKENS`,
 * ответа нет вообще), при 1024 — 0. Платится фактический расход, а не
 * потолок, поэтому запас почти бесплатен; обрезанный ответ хуже отказа.
 *
 * Правило для всего sites-backend: вызывающий задаёт размер ВИДИМОГО ответа
 * (`maxOutputTokens` в GeminiText.generate и SiteChatModel.openStream), а
 * обёртка отправляет провайдеру `geminiOutputCeiling(видимый)`. Оценка денег
 * «сверху» (резерв бюджета до вызова) обязана считать выход по тому же
 * `geminiOutputCeiling`, иначе она перестаёт быть оценкой сверху.
 *
 * Почему здесь, а не в shared/gemini-model: shared — копии чистых модулей
 * backend/ (scripts/sync-sites-shared.mjs), а потолки вызовов sites-backend
 * — его собственное решение; site-ai — нейтральный модуль клиентов Gemini,
 * его импортируют все режимы (правило 5 check-sites-import-graph).
 *
 * `ASSIST_LITE_MODEL` — явная настройка аналитики, не отдельный класс
 * модели. Для неё действует тот же запас и фактический учёт стоимости.
 *
 * Чистый модуль: без Nest, env и SDK.
 */

/** Запас токенов выхода на размышления модели (поверх видимого ответа). */
export const GEMINI_THINKING_HEADROOM = 1024;

/** `finishReason` Gemini: ответ упёрся в `maxOutputTokens`. */
export const GEMINI_FINISH_MAX_TOKENS = 'MAX_TOKENS';

/**
 * Потолок `maxOutputTokens`, который уходит провайдеру, — и он же выход в
 * оценке денег сверху. `visibleTokens` — размер видимого ответа (≥ 1).
 */
export function geminiOutputCeiling(visibleTokens: number): number {
  const visible = Number.isFinite(visibleTokens)
    ? Math.max(1, Math.ceil(visibleTokens))
    : 1;
  return visible + GEMINI_THINKING_HEADROOM;
}
