/**
 * Vercel Web Analytics (§10.1) — адрес просмотра без query и якоря.
 *
 * Скрипт Vercel по умолчанию отправляет `location.href` целиком, а у нас в
 * query бывает то, что не должно уходить третьей стороне: адрес сайта
 * посетителя (`/try?url=…` из hero, §6) и utm. Как у first-party событий
 * (`landing-events.ts` `cleanPath`): остаётся только origin + путь.
 * Неразбираемый адрес — событие отбрасывается (null), а не уходит как есть.
 */
export function redactAnalyticsUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}

/** `beforeSend` для `<Analytics>`: тот же тип события, адрес — без query/якоря. */
export function analyticsBeforeSend<E extends { url: string }>(event: E): E | null {
  const url = redactAnalyticsUrl(event.url);
  return url ? { ...event, url } : null;
}
