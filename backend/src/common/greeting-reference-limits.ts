/**
 * Потолок изображений поздравления (docs.x.ai reference-to-video: до 7
 * `reference_images` за один запрос).
 *
 * Вынесен из `greeting-reference.service.ts` (аудит захода 8): промпт
 * (`greeting-prompt.service.ts`) и рендер брали его оттуда, а сервис фото
 * теперь сам перештамповывает сценарий через `greeting-session-edit/restamp`
 * — константа в сервисе замыкала цикл импортов
 * reference → restamp → session-edit → prompt → reference.
 */
export const MAX_GREETING_REFERENCE_IMAGES = 7;
