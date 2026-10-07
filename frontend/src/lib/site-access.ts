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
  AssistLinkCandidate,
  AssistLinkState,
  ConsentLocale,
  PageElement,
  SiteAccessReason,
  SiteAccessView,
  StepClick,
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
  | 'verifyErrRateLimited'
  | 'consentErrRequired'
  | 'consentErrStale'
  | 'recordErrOptedOut'
  | 'recordErrUnavailable'
  | 'loginErrAttempts'
  | 'loginErrIdentities'
  | 'dangerErrConfirm';

/** П-Т11: домен в реестре отказов — запись по нему запрещена (403). */
export const SITE_OPTED_OUT = 'SITE_TUTORIAL_SITE_OPTED_OUT';
/** П-Т9: выключатель или глобальный суточный потолок (503). */
export const TUTORIAL_TEMPORARILY_UNAVAILABLE =
  'SITE_TUTORIAL_TEMPORARILY_UNAVAILABLE';
/** П-Т8: неудачные входы в час исчерпаны (429, `retryAfterMs`). */
export const LOGIN_ATTEMPTS_EXCEEDED = 'SITE_TUTORIAL_LOGIN_ATTEMPTS_EXCEEDED';
/** П-Т6: разные логины на сайт за 30 дней исчерпаны (429). */
export const LOGIN_IDENTITIES_EXCEEDED =
  'SITE_TUTORIAL_LOGIN_IDENTITIES_EXCEEDED';
/** Ш1-хвост: «Это мой сайт» слишком часто (429, `retryAfterMs`). */
export const VERIFY_SITE_RATE_LIMITED = 'SITE_TUTORIAL_VERIFY_RATE_LIMITED';
/** П-Т13: «опасный» клик в режиме B без подтверждения (409). */
export const DANGER_CONFIRM_REQUIRED = 'SITE_TUTORIAL_DANGER_CONFIRM_REQUIRED';

const EXACT_CODES: ReadonlyMap<string, SiteAccessErrorKey> = new Map([
  [ACCOUNT_CONSENT_REQUIRED, 'consentErrRequired'],
  [ACCOUNT_CONSENT_STALE, 'consentErrStale'],
  [SITE_OPTED_OUT, 'recordErrOptedOut'],
  [TUTORIAL_TEMPORARILY_UNAVAILABLE, 'recordErrUnavailable'],
  [LOGIN_ATTEMPTS_EXCEEDED, 'loginErrAttempts'],
  [LOGIN_IDENTITIES_EXCEEDED, 'loginErrIdentities'],
  [VERIFY_SITE_RATE_LIMITED, 'verifyErrRateLimited'],
  [DANGER_CONFIRM_REQUIRED, 'dangerErrConfirm'],
]);

/**
 * П-Т11: запись по этому сайту запрещена его владельцем (реестр отказов) —
 * «Открыть» не ведёт никуда, экран говорит об этом сразу.
 */
export function recordingBlocked(access: SiteAccessView | null): boolean {
  return !!access && access.mode === 'B' && access.reason === 'opted_out';
}

/**
 * Текст отказа с `{minutes}` — минуты ожидания вверх, не меньше одной
 * (`retryAfterMs` из конверта); нет срока — «несколько».
 */
export function withMinutes(
  text: string,
  retryAfterMs: number | null,
  fallback = '…'
): string {
  const minutes =
    retryAfterMs && retryAfterMs > 0
      ? String(Math.max(1, Math.ceil(retryAfterMs / 60_000)))
      : fallback;
  return text.split('{minutes}').join(minutes);
}

/**
 * Тело клика `/step` (П-Т13): селектор, видимый текст кнопки (сервер по
 * нему решает, «опасный» ли клик; ≤ 300 символов — длиннее стоп-лист не
 * читает) и `confirmDanger` — только после «Да, выполнить» в диалоге.
 */
export function stepClick(el: PageElement, confirmed: boolean): StepClick {
  // `clickText` шлём ВСЕГДА (пусть пустой): его наличие — признак нового
  // клиента для сервера (аудит захода 7, п.5а). Старый бандл поля не шлёт,
  // и сервер по этому различает «уже подтвердил сам» и не упирается в 409.
  const text = (el.visibleText ?? el.label ?? '').trim().slice(0, 300);
  return {
    clickSelector: el.selector,
    clickText: text,
    ...(confirmed ? { confirmDanger: true as const } : {}),
  };
}

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
  const exact = EXACT_CODES.get(code);
  if (exact) return exact;
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

/**
 * Ответ `assist-link` (Э6-хвост, L6445; backend — пакет C) → состояние
 * плашки. Терпит и прежний ответ (`{ clientSiteId, siteName }`): привязка
 * видна, выбора нет. Мусор — «не привязано, привязать нельзя», а не
 * падение экрана.
 */
export function normalizeAssistLink(raw: unknown): AssistLinkState {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >;
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.length > 0 ? v : null;
  const siteId = str(o.siteId) ?? str(o.clientSiteId);
  const candidates: AssistLinkCandidate[] = Array.isArray(o.candidates)
    ? o.candidates.flatMap((c: unknown) => {
        const r = (c && typeof c === 'object' ? c : {}) as Record<
          string,
          unknown
        >;
        const id = str(r.siteId);
        return id ? [{ siteId: id, name: str(r.name) ?? id }] : [];
      })
    : [];
  const linked = typeof o.linked === 'boolean' ? o.linked : siteId !== null;
  return {
    linked,
    siteId: linked ? siteId : null,
    siteName: linked ? str(o.siteName) : null,
    canLink: !linked && o.canLink === true && candidates.length > 0,
    candidates,
  };
}

/**
 * Что показать на экране просмотра: `linked` — плашка «привязано к
 * помощнику», `pick` — выбор кабинета-сайта и «Привязать», `hidden` —
 * ничего (не знаем, или привязать некуда).
 */
export function assistLinkCardMode(
  state: AssistLinkState | null
): 'linked' | 'pick' | 'hidden' {
  if (!state) return 'hidden';
  if (state.linked) return 'linked';
  return state.canLink ? 'pick' : 'hidden';
}

/**
 * Переходная совместимость (аудит захода 7, п.5б; УБРАТЬ ПОСЛЕ 2026-11-06):
 * новый фронтенд может попасть на ещё НЕ обновлённый backend (Vercel
 * собирает фронт и API одновременно, сборка API может отстать на миграции).
 * Старый `StepDto` с `forbidNonWhitelisted` отвечает 400 на поля
 * `clickText`/`confirmDanger` («property clickText should not exist»).
 * Эта чистая проверка узнаёт такой ответ по телу конверта — вызывающий
 * повторит `/step` один раз без этих полей.
 */
export function stepFieldRejected(data: unknown, fields: string[]): boolean {
  const text = (() => {
    try {
      return JSON.stringify(data ?? '');
    } catch {
      return '';
    }
  })();
  if (!/should not exist/i.test(text)) return false;
  return fields.some((f) => text.includes(f));
}
