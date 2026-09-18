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
/**
 * 17.09.2026 (фаза −1 doc/AI-SKETCH-SPEC.md): `gemini-2.5-flash-image`
 * по сторонним сводкам отключается 02.10.2026 и на Gemini API, и на
 * Vertex; замена — GA `gemini-3.1-flash-image` (preview-вариант
 * `gemini-3.1-flash-image-preview` уже снят). Официальная страница
 * Google из этой среды недоступна — ID и цену ПРОВЕРИТЬ одним ручным
 * вызовом до 02.10. Откат без релиза: переменная `GEMINI_IMAGE_MODEL`.
 */
export const DEFAULT_GEMINI_IMAGE_MODEL = 'gemini-3.1-flash-image';

export const GEMINI_IMAGE_MODEL =
  process.env.GEMINI_IMAGE_MODEL || DEFAULT_GEMINI_IMAGE_MODEL;
