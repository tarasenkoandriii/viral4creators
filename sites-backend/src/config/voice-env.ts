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
import { createHmac } from 'crypto';
import { WIDGET_VOICE_TICKET_HMAC_LABEL } from '../brand';
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

/** Ключ подписи билета голоса; null — ключа нет (голос закрыт, как и виджет). */
export function voiceTicketKey(
  env: NodeJS.ProcessEnv = process.env,
): Buffer | null {
  const key = env.ASSIST_SECRETS_KEY?.trim();
  if (!key) return null;
  return createHmac('sha256', key)
    .update(WIDGET_VOICE_TICKET_HMAC_LABEL)
    .digest();
}
