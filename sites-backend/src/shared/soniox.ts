// СГЕНЕРИРОВАНО scripts/sync-sites-shared.mjs — не править.
// Источник: backend/src/common/soniox.ts. Правка — в источнике, затем
// `node scripts/sync-sites-shared.mjs`; CI сверяет копию флагом --check.

/**
 * Soniox — распознавание и синтез речи с сильным русским и украинским.
 *
 * Решение владельца продукта 29.09.2026: добавить Soniox ВАРИАНТОМ и для
 * распознавания, и для озвучки, выбираемым в админке. Ключ один на оба
 * направления — `SONIOX_API_KEY`.
 *
 * Формы API сверены с документацией 29.09.2026:
 *
 *   STT (асинхронный, короткие файлы):
 *     POST   https://api.soniox.com/v1/files            multipart, поле `file` → { id }
 *     POST   https://api.soniox.com/v1/transcriptions   { model, file_id, language_hints,
 *                                                        language_hints_strict, context,
 *                                                        enable_language_identification } → { id, status }
 *     GET    https://api.soniox.com/v1/transcriptions/{id}             → { status: queued|processing|completed|error }
 *     GET    https://api.soniox.com/v1/transcriptions/{id}/transcript  → { text?, tokens[] }
 *     DELETE https://api.soniox.com/v1/transcriptions/{id}
 *     DELETE https://api.soniox.com/v1/files/{id}
 *
 *   TTS (REST, запрос-ответ):
 *     POST https://tts-rt.soniox.com/tts         { model, language, voice, audio_format, text ≤ 5000 }
 *                                                → сырые байты аудио
 *     GET  https://api.soniox.com/v1/tts-models  → { models: [{ languages: [{code,name}], voices: [{id,description,gender}] }] }
 *
 * Авторизация везде — `Authorization: Bearer <SONIOX_API_KEY>`.
 *
 * ## Граница честности
 *
 * Как и у Devil's Advocate, откуда взят образец (`soniox-stt.provider.ts`
 * там), код написан по документации: в песочнице нет ни сети к Soniox,
 * ни ключа. Разбор ответа и все ветки покрыты тестами; первый вызов с
 * настоящим ключом — первая настоящая проверка.
 */

export const SONIOX_API_BASE = 'https://api.soniox.com/v1';
export const SONIOX_TTS_BASE = 'https://tts-rt.soniox.com';

/** Модели заданы явно, а не «по умолчанию у провайдера»: молчаливая смена
 *  модели на их стороне не должна менять поведение продукта. v4 — алиасы
 *  на v5, удаляются 30.06.2026; TTS v1 снимается 31.08.2026. */
export const SONIOX_STT_ASYNC_MODEL = 'stt-async-v5';
export const SONIOX_TTS_MODEL = 'tts-rt-v2';

/** Голос синтеза по умолчанию — из примера в справочнике моделей. Голоса
 *  Soniox работают на всех языках модели; бренд может выбрать свой. */
export const SONIOX_DEFAULT_TTS_VOICE = 'Maya';

/** Потолок текста одного запроса синтеза — из документации. */
export const SONIOX_TTS_MAX_CHARACTERS = 5000;

export function sonioxApiKey(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env.SONIOX_API_KEY?.trim() || undefined;
}

/** Язык для запроса: 'uk-UA' → 'uk', мусор → null. */
export function sonioxLanguage(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const base = raw.trim().toLowerCase().split(/[-_]/)[0];
  return /^[a-z]{2,3}$/.test(base) ? base : null;
}
