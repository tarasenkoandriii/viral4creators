/**
 * Разбор `startapp` — единственного параметра, который Telegram передаёт
 * Mini App при открытии по ссылке `t.me/<бот>/app?startapp=<значение>`.
 *
 * ## Зачем отдельный модуль
 *
 * Параметр один на все нужды, а нужд уже три: код приглашения (`r_`,
 * этап 134), привязка обучалки к сайту помощника (`cst_`,
 * `assist-site-link.ts`) и — с этой правки — сценарий лендинга (`e_`):
 * человек, нажавший «Открыть в Telegram» на лендинге поздравлений,
 * должен попасть в мастер поздравления, а не в список проектов. В
 * браузере ту же работу делает `?entry=` (`landing-entry.ts`).
 *
 * ## Формат (зеркало `landing/src/lib/telegram-entry.ts`)
 *
 *     r_<КОД>                    — только приглашение (как с этапа 134)
 *     e_<сценарий>               — только сценарий
 *     e_<сценарий>__r_<КОД>      — сценарий и приглашение
 *
 * Сценарий — из закрытого списка `LANDING_ENTRIES`, код — восемь знаков
 * base32 без похожих символов. Разделитель `__` однозначен: подчёркивания
 * нет ни в сценариях, ни в коде. Самая длинная строка —
 * `e_site-tutorial__r_XXXXXXXX`, 27 знаков из 64, которые разрешает
 * Telegram (алфавит `[A-Za-z0-9_-]`).
 *
 * Разбор строгий: строка либо целиком соответствует формату, либо не
 * значит НИЧЕГО (ни сценария, ни кода). Параметр приходит снаружи, и
 * «вытащить что получится» из подделанной ссылки означало бы, что
 * мусорный хвост решает, куда попадёт человек.
 */

import {
  isLandingEntry,
  type LandingEntry,
} from '../features/projects/landing-entry';

/** Предел Telegram для `startapp`. */
export const START_PARAM_MAX_LENGTH = 64;
/** Алфавит, который Telegram пропускает в `startapp`. */
export const START_PARAM_ALPHABET = /^[A-Za-z0-9_-]+$/;

export const ENTRY_START_PREFIX = 'e_';
export const REFERRAL_START_PREFIX = 'r_';
/** Между частями. Подчёркивания нет ни в сценарии, ни в коде. */
export const START_PARAM_SEPARATOR = '__';

/** Тот же алфавит и длина, что на сервере (`common/referral.ts`). */
const REFERRAL_CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;

/** Код приглашения: регистр и пробелы прощаем, остальное — не код. */
export function normalizeReferralCode(
  raw: string | null | undefined
): string | null {
  if (!raw) return null;
  const code = raw.trim().toUpperCase();
  return REFERRAL_CODE_RE.test(code) ? code : null;
}

export interface LaunchStart {
  entry: LandingEntry | null;
  referralCode: string | null;
}

const NOTHING: LaunchStart = Object.freeze({
  entry: null,
  referralCode: null,
}) as LaunchStart;

/** См. формат в шапке модуля. Мусор — `{ entry: null, referralCode: null }`. */
export function parseStartParam(raw: string | null | undefined): LaunchStart {
  if (
    !raw ||
    raw.length > START_PARAM_MAX_LENGTH ||
    !START_PARAM_ALPHABET.test(raw)
  ) {
    return NOTHING;
  }
  const parts = raw.split(START_PARAM_SEPARATOR);

  let entry: LandingEntry | null = null;
  let referralCode: string | null = null;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    // Сценарий — только первой частью, код — только последней: один
    // канонический порядок, без «e_ и r_ в любом порядке, по разу».
    if (i === 0 && part.startsWith(ENTRY_START_PREFIX)) {
      const value = part.slice(ENTRY_START_PREFIX.length);
      if (!isLandingEntry(value)) return NOTHING;
      entry = value;
    } else if (
      i === parts.length - 1 &&
      part.startsWith(REFERRAL_START_PREFIX)
    ) {
      const code = normalizeReferralCode(
        part.slice(REFERRAL_START_PREFIX.length)
      );
      if (!code) return NOTHING;
      referralCode = code;
    } else {
      return NOTHING;
    }
  }
  // `e_x__e_y`, `r_x__r_y`, `r_x__e_y` и три части и больше сюда не
  // доходят: любая часть не на своём месте попадает в `else` выше.
  return { entry, referralCode };
}

/**
 * Обратное к `parseStartParam` — для тестов и для ссылок, которые
 * собирает сам фронтенд. `null`, если собирать нечего или код негодный.
 */
export function buildStartParam(start: {
  entry?: LandingEntry | null;
  referralCode?: string | null;
}): string | null {
  const parts: string[] = [];
  if (start.entry) {
    if (!isLandingEntry(start.entry)) return null;
    parts.push(`${ENTRY_START_PREFIX}${start.entry}`);
  }
  if (start.referralCode) {
    const code = normalizeReferralCode(start.referralCode);
    if (!code) return null;
    parts.push(`${REFERRAL_START_PREFIX}${code}`);
  }
  return parts.length ? parts.join(START_PARAM_SEPARATOR) : null;
}

/**
 * Сырой `startapp` из адреса запуска. Два источника: `tgWebAppStartParam`
 * в служебном hash'е (его Telegram дописывает при открытии) и
 * `initDataUnsafe.start_param` из SDK — второй на случай клиентов,
 * которые параметр в hash не кладут. Hash первым: он есть уже до того,
 * как SDK что-либо разобрал.
 */
export function startParamFromLaunch(
  hash: string,
  sdkStartParam?: string | null
): string | null {
  const fromHash = new URLSearchParams(hash.replace(/^#/, '')).get(
    'tgWebAppStartParam'
  );
  return fromHash || sdkStartParam || null;
}

/** То же для текущей страницы. Вне браузера — `null`. */
export function currentStartParam(): string | null {
  if (typeof window === 'undefined') return null;
  const sdk = (
    window as unknown as {
      Telegram?: { WebApp?: { initDataUnsafe?: { start_param?: unknown } } };
    }
  ).Telegram?.WebApp?.initDataUnsafe?.start_param;
  return startParamFromLaunch(
    window.location.hash,
    typeof sdk === 'string' ? sdk : null
  );
}
