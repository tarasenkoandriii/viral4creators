/**
 * Сравнение `Origin` со списком разрешённых источников, включая
 * подстановку вида `*.vercel.app` — общая логика для CORS (`main.ts`) и
 * для `PublicOriginGuard` (`modules/assistant`, ТЗ §4.2.3).
 *
 * Раньше эта логика жила только инлайном внутри `app.enableCors()` в
 * `main.ts` — единственным потребителем был сам CORS. `isOriginAllowed`
 * в `common/csrf.ts` выглядит похоже, но это НЕ то же самое: она защищает
 * cookie-маршруты и осознанно точная, без подстановок (см. её
 * доккомментарий, «Точное сравнение, без подстановок вида
 * `*.vercel.app`») — публичный, без cookie, маршрут ассистента копировать
 * её не должен: preview-домены лендинга (`*.vercel.app`) получили бы 403
 * там, где CORS их пропускает. Эта функция — вынесенный из `main.ts`
 * общий код сравнения, без изменения поведения ни одного из двух мест.
 */

/**
 * `requestOrigin` разрешён списком `allowed`? Запись `"*.vercel.app"`
 * матчит `https://foo.vercel.app`, но не `https://vercel.app` и не
 * `https://notvercel.app`. Обычная запись — точное совпадение строки.
 */
export function matchesAllowedOrigin(
  requestOrigin: string,
  allowed: readonly string[],
): boolean {
  return allowed.some((allowedEntry) => {
    if (allowedEntry.startsWith('*.')) {
      const suffix = allowedEntry.slice(1); // ".vercel.app"
      try {
        const { hostname } = new URL(requestOrigin);
        return hostname.endsWith(suffix) && hostname !== suffix.slice(1);
      } catch {
        return false;
      }
    }
    return allowedEntry === requestOrigin;
  });
}
