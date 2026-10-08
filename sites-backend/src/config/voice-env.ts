/**
 * Переменные окружения голоса виджета Э5 — ОДНО место чтения (ТЗ помощника
 * §4.10, §7.3; план, Приложение А «Этап 5»; doc/DEPLOYMENT.md §6.13).
 *
 *  - SONIOX_API_KEY — ключ Soniox (распознавание и озвучка, одно имя с
 *    генератором, но СВОЁ значение в проекте sites-backend: у помощника
 *    свой счёт провайдера и своя граница утечки). Нет ключа — голос в
 *    виджете не показывается (конфиг `voice` выключен), чат — текстом.
 *  - ASSIST_VOICE_ENABLED — аварийный рубильник голоса платформы: `false` —
 *    микрофон и озвучка пропадают у всех сайтов (кэш конфига ≤ 5 мин), а
 *    маршруты голоса отвечают VOICE_UNAVAILABLE. Умолчание — включено (голос
 *    и так требует тариф Business+, ключ и включение владельцем).
 *  - ASSIST_TTS_VOICE — голос озвучки по умолчанию (если владелец не выбрал
 *    свой); умолчание — голос Soniox из справочника (`shared/soniox.ts`).
 *  - Ключ подписи «билета голоса» — производный от ASSIST_SECRETS_KEY (как
 *    visitor-token, без нового секрета).
 */
import { WIDGET_VOICE_TICKET_HMAC_LABEL } from '../brand';
import { derivedKeys } from '../common/secrets-keyring';
import { SONIOX_DEFAULT_TTS_VOICE, sonioxApiKey } from '../shared/soniox';

export function voicePlatformEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.ASSIST_VOICE_ENABLED?.trim().toLowerCase() !== 'false';
}

/** Провайдер голоса настроен (ключ Soniox есть). */
export function voiceProviderConfigured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return !!sonioxApiKey(env);
}

/** Голос озвучки по умолчанию: env → голос из справочника Soniox. */
export function defaultTtsVoice(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.ASSIST_TTS_VOICE?.trim();
  return v && /^[A-Za-z0-9 _.-]{1,64}$/.test(v) ? v : SONIOX_DEFAULT_TTS_VOICE;
}

/**
 * Ключ ПОДПИСИ билета голоса (и итогов сухого прогона мемо) — текущий ключ
 * связки `ASSIST_SECRETS_KEY` (№60); null — ключа нет (голос закрыт).
 */
export function voiceTicketKey(
  env: NodeJS.ProcessEnv = process.env,
): Buffer | null {
  return derivedKeys(env, WIDGET_VOICE_TICKET_HMAC_LABEL)?.currentKey ?? null;
}

/**
 * Ключи ПРОВЕРКИ билета голоса виджета и «Админки» и итогов мемо: текущий
 * и прежние (`ASSIST_SECRETS_KEYS_OLD`, №60) — выданное до ротации доживает
 * свой срок.
 */
export function voiceTicketKeys(
  env: NodeJS.ProcessEnv = process.env,
): readonly Buffer[] | null {
  return derivedKeys(env, WIDGET_VOICE_TICKET_HMAC_LABEL)?.all ?? null;
}
