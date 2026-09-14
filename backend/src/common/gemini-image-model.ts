/**
 * Какую модель Gemini зовёт генерация статичного превью персонажа из
 * текста (доп. запрос владельца продукта) — двойной клик по описанию
 * в `CharacterCasting.tsx` без фото.
 *
 * Отдельная константа от `GEMINI_MODEL` (common/gemini-model.ts) — это
 * ДРУГАЯ модель по назначению (генерация изображений, не текста), не
 * взаимозаменяемая с текстовой моделью platform-настройки.
 *
 * Проверено (не предположено): `gemini-2.5-flash-image` подтверждена
 * официальной документацией Google (developers.googleblog.com,
 * "ready for production with new aspect ratios") как production-ready
 * модель — `generateContent` с `responseModalities: ['Image']`,
 * результат в `response.candidates[0].content.parts[].inlineData.data`
 * (base64 PNG). Цена подтверждена той же страницей — $0.039/изображение
 * при ставке $30/1M выходных токенов (см. `common/ai-pricing.ts`).
 */
export const GEMINI_IMAGE_MODEL =
  process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
