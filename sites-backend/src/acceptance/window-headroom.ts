/**
 * Общий хелпер приёмки: запас до конца окна лимита перед серией запросов.
 *
 * Окна лимитов фиксированные (начало окна = floor(now / windowMs), сутки —
 * по полуночи UTC): серия, попавшая на смену окна, начинается в одном окне
 * и кончается в другом — лимит «не срабатывает» или счётчик/строка дня
 * ищется не в том окне (так упал CI на 1bfb425 в 18:48:00, Э5
 * voice-http.spec). Перед серией ждём начала следующего окна, если до конца
 * текущего меньше `needMs`.
 *
 * Время — `Date.now()` (те же часы, что у сервисов в процессе jest), ждём
 * настоящим `setTimeout`: файлу с этим хелпером нужен `jest.setTimeout`
 * больше `needMs` (по умолчанию у jest 5 с).
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** Ждать начала следующего окна, если до конца текущего меньше `needMs`. */
export async function awaitWindowHeadroom(
  windowMs: number,
  needMs: number,
): Promise<void> {
  if (needMs >= windowMs) {
    throw new Error(`запас ${needMs} мс не меньше окна ${windowMs} мс`);
  }
  const left = windowMs - (Date.now() % windowMs);
  if (left < needMs) await new Promise((r) => setTimeout(r, left + 50));
}

/** Минутное окно: серия должна уложиться в `needMs` (умолчание 20 с). */
export function awaitMinuteHeadroom(needMs = 20_000): Promise<void> {
  return awaitWindowHeadroom(MINUTE_MS, needMs);
}

/** Часовое окно (лимиты «в час»). */
export function awaitHourHeadroom(needMs = 20_000): Promise<void> {
  return awaitWindowHeadroom(HOUR_MS, needMs);
}

/**
 * Сутки UTC (лимиты «в сутки», строки бюджета `day` = toISOString().slice(0, 10)):
 * тест, который берёт «сегодня» до и после действия, не должен застать
 * полночь UTC посередине.
 */
export function awaitUtcDayHeadroom(needMs = 30_000): Promise<void> {
  return awaitWindowHeadroom(DAY_MS, needMs);
}
