/**
 * Режим обучалки A/B и подтверждение прав на аккаунт (Э-С Ш1; П-Т1, П-Т2
 * `docs-tz/SECURITY-PROPOSALS-2026-10-02.md`) — правила экрана без React,
 * чтобы их можно было проверить скриптом (`scripts/site-access.test.ts`).
 *
 * Режим решает СЕРВЕР по статусу хоста в кабинете сайтов; здесь — только
 * что показать: плашку, причину, галочку подтверждения прав.
 */
import type {
  ConsentLocale,
  SiteAccessReason,
  SiteAccessView,
} from '../types/client-site-tutorial';

/** Языки текста подтверждения — uk/ru/en; остальные видят английский. */
export function consentLocaleOf(locale: string): ConsentLocale {
  return locale === 'uk' || locale === 'ru' ? locale : 'en';
}

/** Текст подтверждения на языке интерфейса с подставленным доменом. */
export function consentText(access: SiteAccessView, locale: string): string {
  const lang = consentLocaleOf(locale);
  const text = access.consent.texts[lang] ?? access.consent.texts.en ?? '';
  return text.split('{domain}').join(access.registrableDomain);
}

/**
 * Нужна ли галочка перед обходом, входом и живым входом. Неизвестный
 * режим (`null`, ещё не спросили) — не нужна: экран спросит сервер до
 * действия, а сервер всё равно ответит 409, если галочки нет.
 */
export function needsAccountConsent(access: SiteAccessView | null): boolean {
  return !!access && access.mode === 'B' && !access.consent.accepted;
}

export type ModeReasonKey =
  | 'modeReasonUnavailable'
  | 'modeReasonPending'
  | 'modeReasonExpired'
  | 'modeReasonRevoked'
  | 'modeReasonRole'
  | 'modeReasonOptedOut'
  | 'modeReasonUnsupported';

/** Пояснение к режиму B; `null` — хватает общего текста плашки. */
export function modeReasonKey(reason: SiteAccessReason): ModeReasonKey | null {
  switch (reason) {
    case 'unavailable':
      return 'modeReasonUnavailable';
    case 'not_verified':
      return 'modeReasonPending';
    case 'expired':
      return 'modeReasonExpired';
    case 'revoked':
      return 'modeReasonRevoked';
    case 'role':
      return 'modeReasonRole';
    case 'opted_out':
      return 'modeReasonOptedOut';
    case 'unsupported_url':
      return 'modeReasonUnsupported';
    default:
      return null;
  }
}

/** Ссылку «открыть кабинет сайтов» показываем только на https. */
export function safeVerifyUrl(access: SiteAccessView | null): string | null {
  const raw = access?.verifyUrl;
  if (!raw) return null;
  try {
    return new URL(raw).protocol === 'https:' ? raw : null;
  } catch {
    return null;
  }
}

/** Код сервера «нужно подтверждение прав» (ворота П-Т2). */
export const ACCOUNT_CONSENT_REQUIRED =
  'SITE_TUTORIAL_ACCOUNT_CONSENT_REQUIRED';
/** Текст подтверждения сменился, пока экран был открыт. */
export const ACCOUNT_CONSENT_STALE = 'SITE_TUTORIAL_CONSENT_VERSION_STALE';
