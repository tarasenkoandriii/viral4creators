/**
 * Режим обучалки A/B и подтверждение прав на аккаунт (Э-С Ш1; П-Т1, П-Т2
 * `docs-tz/SECURITY-PROPOSALS-2026-10-02.md`) — правила экрана без React,
 * чтобы их можно было проверить скриптом (`scripts/site-access.test.ts`).
 *
 * Режим решает СЕРВЕР по статусу хоста в кабинете сайтов; здесь — только
 * что показать: плашку, причину, галочку подтверждения прав.
 *
 * Решение владельца 02.10.2026: «для обучалки все сайты свои,
 * подтверждение не требуется». B — метка «сайт не подтверждён», а не
 * ограничение; галочка нужна, только если сервер работает в
 * `SITE_TUTORIAL_ACCOUNT_CONSENT=required` и сам говорит
 * `consent.required` (дефект 3 аудита: раньше экран решал по `mode`).
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
 * Нужна ли галочка перед обходом, входом и живым входом — решает сервер
 * (`consent.required`). Неизвестный режим (`null`, ещё не спросили) — не
 * нужна: экран спросит сервер до действия, а в `required` сервер всё
 * равно ответит 409, если галочки нет.
 */
export function needsAccountConsent(access: SiteAccessView | null): boolean {
  return !!access && access.consent.required && !access.consent.accepted;
}

/**
 * Причины B, при которых сказать человеку обычно нечего (дефект 4
 * аудита): кабинет сайтов не подключён, нет Telegram, нет кабинета,
 * кабинет не ответил. Карточку режима тогда не показываем — кроме случая,
 * когда сервер предлагает «Это мой сайт» (`no_account`: `/verify-site`
 * создаёт кабинет, решение «максимум удобства» 02.10.2026).
 */
const SILENT_REASONS: ReadonlySet<SiteAccessReason> = new Set([
  'not_configured',
  'no_telegram',
  'no_account',
  'unavailable',
] as SiteAccessReason[]);

export type WizardAccessStage = 'url' | 'page' | 'review';

/**
 * Показывать ли карточку режима. Тупиковые причины — никогда. В
 * `required` — всегда (рядом с галочкой нужен контекст). Иначе — не на
 * экране страницы: там идёт запись, и метка ей только мешает (и не
 * попадает в кадры лендинга — карточка 2 снимается на этом экране).
 */
export function siteModeCardVisible(
  access: SiteAccessView | null,
  stage: WizardAccessStage
): boolean {
  if (!access) return false;
  if (
    access.mode === 'B' &&
    SILENT_REASONS.has(access.reason) &&
    !canOfferVerify(access)
  ) {
    return false;
  }
  if (access.consent.required) return true;
  return stage !== 'page';
}

/**
 * «Это мой сайт»: только если сервер говорит, что кнопка куда-то ведёт
 * (`canRegister`), и есть куда идти подтверждать владение (`verifyUrl` —
 * сервер без `SITES_VERIFY_URL` и сам даёт `canRegister: false`, здесь —
 * страховка от старого сервера).
 */
export function canOfferVerify(access: SiteAccessView): boolean {
  return (
    access.mode === 'B' &&
    access.canRegister &&
    access.hostId === null &&
    safeVerifyUrl(access) !== null
  );
}

/** Подсказка «можно подтвердить, это необязательно» — когда есть путь. */
export function showsVerifyHint(access: SiteAccessView): boolean {
  return (
    access.mode === 'B' && (canOfferVerify(access) || access.hostId !== null)
  );
}

export type ModeReasonKey =
  | 'modeReasonUnavailable'
  | 'modeReasonPending'
  | 'modeReasonExpired'
  | 'modeReasonRevoked'
  | 'modeReasonRole'
  | 'modeReasonOptedOut'
  | 'modeReasonUnsupported'
  | 'modeReasonIp';

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
    case 'ip_address':
      return 'modeReasonIp';
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

export type SiteAccessErrorKey =
  | 'verifyErrNoTelegram'
  | 'verifyErrUnavailable'
  | 'verifyErrRole'
  | 'verifyErrOptedOut'
  | 'verifyErrInvalid'
  | 'verifyErrGeneric'
  | 'consentErrRequired'
  | 'consentErrStale';

/** Префикс кодов отказа «Подтвердить сайт» (`/verify-site`). */
const SITES_CODE_PREFIX = 'SITE_TUTORIAL_SITES_';

/**
 * Код отказа сервера → ключ словаря (дефект 7 аудита): сервер пишет текст
 * по-русски, а экран говорит на языке интерфейса. `null` — код не наш,
 * показываем как раньше (`errorMessage`).
 */
export function siteAccessErrorKey(
  code: string | null
): SiteAccessErrorKey | null {
  if (!code) return null;
  if (code === ACCOUNT_CONSENT_REQUIRED) return 'consentErrRequired';
  if (code === ACCOUNT_CONSENT_STALE) return 'consentErrStale';
  if (!code.startsWith(SITES_CODE_PREFIX)) return null;
  switch (code.slice(SITES_CODE_PREFIX.length)) {
    case 'NO_TELEGRAM':
    case 'ACCOUNT_REQUIRED':
      return 'verifyErrNoTelegram';
    case 'UNAVAILABLE':
      return 'verifyErrUnavailable';
    case 'ACCOUNT_ROLE_REQUIRED':
      return 'verifyErrRole';
    case 'HOST_OPTED_OUT':
      return 'verifyErrOptedOut';
    case 'HOST_INVALID':
      return 'verifyErrInvalid';
    default:
      return 'verifyErrGeneric';
  }
}
