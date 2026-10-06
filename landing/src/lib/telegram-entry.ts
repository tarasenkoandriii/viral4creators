/**
 * Вход с лендинга в нужный сценарий мини-аппа — и в браузере, и в Telegram.
 *
 * У каждого из трёх лендингов две дороги в продукт:
 *
 *  - **браузер** — `TMA_URL?entry=<сценарий>#/projects/new`: обычный
 *    фронтенд, форма нового проекта читает `?entry=`
 *    (`frontend/src/features/projects/landing-entry.ts`);
 *  - **Telegram** — `t.me/<бот>/app?startapp=e_<сценарий>`: тот же
 *    фронтенд в роли Mini App. Telegram передаёт ему один параметр
 *    `startapp`, и мини-апп при старте переписывает себя на тот же адрес
 *    `?entry=…`, что и браузерная кнопка (`frontend/src/lib/start-param.ts`).
 *
 * ## Формат `startapp` (зеркало `frontend/src/lib/start-param.ts`)
 *
 *     e_<сценарий>               — сценарий
 *     e_<сценарий>__r_<КОД>      — сценарий и приглашение
 *
 * Сценарий — из закрытого списка `LANDING_ENTRIES`. Код приглашения —
 * тот же, что `?ref=` (`referral.ts`): если человек пришёл на лендинг по
 * приглашению, обе кнопки уносят код с собой. Telegram разрешает до 64
 * знаков `[A-Za-z0-9_-]`; самая длинная строка формата — 27.
 *
 * Здесь только чистые функции: страницы лендинга статические, и код
 * из адреса подставляет клиентский компонент (`EntryActions`).
 */

/** Закрытый список — тот же, что `LANDING_ENTRIES` во frontend. */
export const LANDING_ENTRIES = ['ads', 'greetings', 'site-tutorial'] as const;
export type LandingEntry = (typeof LANDING_ENTRIES)[number];

export const ENTRY_START_PREFIX = 'e_';
/** Тот же префикс, что у приглашения (`referral.ts`, `START_PARAM_PREFIX`). */
export const REFERRAL_START_PREFIX = 'r_';
export const START_PARAM_SEPARATOR = '__';
export const START_PARAM_MAX_LENGTH = 64;
export const START_PARAM_ALPHABET = /^[A-Za-z0-9_-]+$/;

/** Тот же алфавит и длина, что на сервере и во frontend. */
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;

/**
 * Имя бота Telegram: 5–32 знака латиницы, цифр и `_`. Другое значение в
 * переменной окружения — опечатка, и ссылка по нему увела бы людей на
 * чужой (или несуществующий) аккаунт; тогда кнопки «Открыть в Telegram»
 * просто нет.
 */
const BOT_RE = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;

export function isLandingEntry(value: unknown): value is LandingEntry {
  return typeof value === 'string' && (LANDING_ENTRIES as readonly string[]).includes(value);
}

/**
 * Код приглашения из `?ref=` лендинга. `URLSearchParams` уже раскодировал
 * значение, поэтому здесь — без `decodeURIComponent` (в отличие от
 * `normalizeCode` маршрута `/r/<код>`, которому строка приходит сырой;
 * на `%E0` тот бросал бы).
 */
export function entryReferralCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const code = raw.trim().toUpperCase();
  return CODE_RE.test(code) ? code : null;
}

/** `e_<сценарий>[__r_<КОД>]`; негодный код отбрасывается, сценарий остаётся. */
export function entryStartParam(entry: LandingEntry, refCode?: string | null): string {
  const code = entryReferralCode(refCode);
  const head = `${ENTRY_START_PREFIX}${entry}`;
  return code ? `${head}${START_PARAM_SEPARATOR}${REFERRAL_START_PREFIX}${code}` : head;
}

export function normalizeBotUsername(raw: string | null | undefined): string | null {
  const bot = raw?.trim().replace(/^@/, '');
  return bot && BOT_RE.test(bot) ? bot : null;
}

/**
 * «Открыть в Telegram». `null`, если имя бота не задано или негодное —
 * кнопку тогда не показываем (выдуманное имя увело бы на чужой аккаунт,
 * см. `TELEGRAM_BOT_USERNAME` в `content.ts`).
 */
export function telegramEntryLink(
  entry: LandingEntry,
  botUsername: string | null | undefined,
  refCode?: string | null,
): string | null {
  const bot = normalizeBotUsername(botUsername);
  if (!bot) return null;
  return `https://t.me/${bot}/app?startapp=${entryStartParam(entry, refCode)}`;
}

/**
 * Браузерная кнопка: `TMA_URL?entry=<сценарий>[&ref=<КОД>]#/projects/new`.
 * `?ref=` — тот же параметр, что у страницы приглашения (`appInviteLink`).
 */
export function browserEntryLink(entry: LandingEntry, tmaUrl: string, refCode?: string | null): string {
  const code = entryReferralCode(refCode);
  const query = code ? `entry=${entry}&ref=${code}` : `entry=${entry}`;
  return `${tmaUrl}?${query}#/projects/new`;
}
