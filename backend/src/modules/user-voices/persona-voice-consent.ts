/**
 * Фраза согласия на клон голоса персоны «Я в кадре» (ТЗ TZ-Greeting-2.0
 * §4.6): человек произносит её ПЕРВОЙ в записи образца, и запись сама
 * становится свидетельством согласия — отдельно от галочки
 * `UserVoice.consentAt`.
 *
 * ТРЕБУЕТ ПРОВЕРКИ ЮРИСТОМ до выпуска (§4.10) и сверки с требованиями
 * Resemble к фразе согласия (§4.6: «не принимать на веру»). Любое
 * изменение смысла — новая `PERSONA_VOICE_CONSENT_VERSION`.
 *
 * `{name}` — место имени: его подставляет клиент (имя из профиля или
 * введённое человеком), сервер отдаёт шаблон и готовый текст, если имя
 * известно. Чистый модуль — проверяется тестом без DI.
 */

import { normalizeLocale, SupportedLocale } from '../../common/locale';

export const PERSONA_VOICE_CONSENT_VERSION = '2026-09-30';

export const PERSONA_VOICE_NAME_PLACEHOLDER = '{name}';

// ТРЕБУЕТ ПРОВЕРКИ ЮРИСТОМ (§4.10) — все пять редакций.
const PHRASES: Record<SupportedLocale, string> = {
  ru: 'Я, {name}, разрешаю создать синтетическую копию моего голоса и использовать её только в моих роликах в этом сервисе.',
  uk: 'Я, {name}, дозволяю створити синтетичну копію мого голосу та використовувати її лише в моїх роликах у цьому сервісі.',
  en: 'I, {name}, allow the creation of a synthetic copy of my voice and its use only in my own videos on this service.',
  de: 'Ich, {name}, erlaube die Erstellung einer synthetischen Kopie meiner Stimme und ihre Verwendung ausschließlich in meinen eigenen Videos in diesem Dienst.',
  es: 'Yo, {name}, autorizo la creación de una copia sintética de mi voz y su uso únicamente en mis propios videos en este servicio.',
};

export interface PersonaVoiceConsentPhrase {
  locale: SupportedLocale;
  version: string;
  /** Шаблон с `{name}` — для клиента, который подставит имя сам. */
  template: string;
  /** Готовая фраза, если имя известно; иначе `null`. */
  text: string | null;
}

/**
 * Имя для фразы: без управляющих символов и фигурных скобок (иначе имя
 * «{name}» размножило бы подстановку), не длиннее 60 символов.
 */
function cleanName(name: string | null | undefined): string {
  return (
    (name ?? '')
      // eslint-disable-next-line no-control-regex -- управляющие символы и есть цель
      .replace(/[\u0000-\u001f\u007f{}]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60)
  );
}

export function personaVoiceConsentPhrase(
  locale: string | null | undefined,
  name?: string | null,
): PersonaVoiceConsentPhrase {
  const loc = normalizeLocale(locale ?? undefined);
  const template = PHRASES[loc] ?? PHRASES.ru;
  const clean = cleanName(name);
  return {
    locale: loc,
    version: PERSONA_VOICE_CONSENT_VERSION,
    template,
    text: clean
      ? template.replace(PERSONA_VOICE_NAME_PLACEHOLDER, clean)
      : null,
  };
}
