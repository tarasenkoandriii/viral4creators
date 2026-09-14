/**
 * Режим озвучки (ТЗ §15.1, этап 35).
 *
 * До этого этапа выбора не было: речь синтезировал сам Veo из реплик,
 * написанных в промпте. Это работает и стоит ноль сверху, но голос
 * каждый раз новый, и у бренда его не может быть — а голос это ровно то,
 * что делает серию роликов узнаваемой.
 *
 * Отсюда три режима, а не два. `dub` мог бы показаться лишним рядом с
 * `voiceover`, но разница принципиальная: в `voiceover` звук Veo уходит
 * в фон (атмосфера, музыка, шаги — половина достоверности ролика), в
 * `dub` его нет вовсе. Второе нужно, когда Veo всё-таки заговорил не тем
 * голосом и приглушённая речь под нашей дорожкой слышна как эхо.
 */

export const VOICE_MODES = ['veo', 'voiceover', 'dub'] as const;
export type VoiceMode = (typeof VOICE_MODES)[number];

/**
 * Умолчание для НОВЫХ брендов (Prisma `BrandManifest.voiceMode @default`
 * и форма манифеста на фронтенде). Доп. запрос владельца продукта
 * (14.09.2026): модели (Veo и Grok одинаково) читают кириллицу с
 * неверными ударениями, поэтому свой синтез поверх ролика — правило, а
 * голос модели — осознанное исключение. Смена этого значения меняет
 * ТОЛЬКО умолчание для новых записей; уже выбранный режим бренда и
 * снимки сессий не трогает (их мигрирует отдельная миграция
 * `20260914120000_voiceover_default`).
 */
export const DEFAULT_VOICE_MODE: VoiceMode = 'voiceover';

/**
 * Что считать режимом записи, у которой поля нет вовсе — данные до этапа
 * 35, когда речь синтезировала только сама модель. Намеренно НЕ равно
 * `DEFAULT_VOICE_MODE`: для старого снимка без поля «свой голос поверх»
 * означал бы платный синтез при повторном рендере — а такого выбора
 * никто не делал.
 */
export const LEGACY_VOICE_MODE: VoiceMode = 'veo';

export const VOICE_MODE_LABEL: Record<VoiceMode, string> = {
  veo: 'Голос Veo',
  voiceover: 'Свой голос поверх',
  dub: 'Свой голос вместо',
};

export const VOICE_MODE_HINT: Record<VoiceMode, string> = {
  veo: 'Речь синтезирует сама модель по репликам из промпта. Ничего настраивать не нужно, но голос каждый раз новый.',
  voiceover:
    'Реплики озвучивает выбранный голос, звук ролика остаётся фоном — музыка и атмосфера сохраняются.',
  dub: 'Реплики озвучивает выбранный голос, звук ролика заменяется целиком. Берите, если модель всё-таки заговорила своим голосом.',
};

export function isVoiceMode(value: unknown): value is VoiceMode {
  return (
    typeof value === 'string' &&
    (VOICE_MODES as readonly string[]).includes(value)
  );
}

export function normalizeVoiceMode(value: unknown): VoiceMode {
  return isVoiceMode(value) ? value : LEGACY_VOICE_MODE;
}

/** Наш синтез участвует — значит нужен текст, голос и проход ffmpeg. */
export function usesOwnVoice(mode: VoiceMode): boolean {
  return mode === 'voiceover' || mode === 'dub';
}

/**
 * Секция брифа для автора промпта. Смысл её в одном: если реплики будем
 * озвучивать мы, Veo не должен снимать говорящие головы. Ролик, где
 * персонаж артикулирует одно, а слышно другое, читается как брак — и
 * никакой микс это уже не чинит.
 */
export function voiceModeBriefText(mode: VoiceMode): string {
  if (!usesOwnVoice(mode)) return '';
  return [
    'VOICE TRACK IS ADDED SEPARATELY — do not have anyone speak on camera:',
    '- No lip-synced dialogue, no talking heads, no characters addressing the camera with words.',
    '- Keep the same beats and emotions, but carry them with action, reactions and on-screen text instead of speech.',
    '- Audio direction should describe music, ambience and foley only; the spoken lines are voiced by a separate narrator track.',
  ].join('\n');
}
