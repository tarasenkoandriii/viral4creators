/**
 * Нормализация URL обхода — K1. Один ключ на страницу: без `#…`, без
 * трекинговых параметров (utm_*, gclid, fbclid, yclid, _ga…), с
 * отсортированными параметрами, без порта 443, хост в нижнем регистре
 * (punycode — WHATWG URL, как site-core/hosts/host-normalize), путь без
 * `/./`, `/../`. Только https. Не URL / не https → null.
 *
 * Почему так строго: ключ `site_pages (hostId, url)` — это и «страница
 * уже обойдена», и «у страницы сменился текст». `?utm_source=a` и
 * `?utm_source=b` как разные страницы дали бы дубли фрагментов и лишние
 * эмбеддинги за деньги бюджета обучения.
 */

/** Параметры, которые не меняют содержимого страницы. */
const TRACKING_PARAMS = new Set([
  'gclid',
  'gclsrc',
  'dclid',
  'gbraid',
  'wbraid',
  'fbclid',
  'yclid',
  'ysclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'igshid',
  'twclid',
  'ttclid',
  'li_fat_id',
  '_ga',
  '_gl',
  '_hsenc',
  '_hsmi',
  '_openstat',
  'ref_src',
  'srsltid',
  'from_tg',
]);

function isTracking(name: string): boolean {
  const n = name.toLowerCase();
  return n.startsWith('utm_') || TRACKING_PARAMS.has(n);
}

export function normalizeCrawlUrl(raw: string, base?: string): string | null {
  if (typeof raw !== 'string') return null;
  const input = raw.trim();
  if (!input || input.length > 4096) return null;
  let u: URL;
  try {
    u = base ? new URL(input, base) : new URL(input);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (u.port !== '') return null;
  u.hash = '';
  // Хост: нижний регистр и punycode делает URL; точку на конце — мы.
  u.hostname = u.hostname.replace(/\.$/, '');
  if (!u.hostname) return null;
  // `/a/./b/../c` URL уже свернул; повторные слэши — один и тот же ресурс
  // у подавляющего большинства серверов.
  u.pathname = u.pathname.replace(/\/{2,}/g, '/') || '/';
  const kept = [...u.searchParams.entries()].filter(([k]) => !isTracking(k));
  kept.sort(([a, av], [b, bv]) =>
    a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1,
  );
  u.search = '';
  for (const [k, v] of kept) u.searchParams.append(k, v);
  return u.toString();
}

/** `https://host` — ключ кэша robots (site_crawl_robots.origin). */
export function originOf(url: string): string {
  return new URL(url).origin;
}

/** Хост нормализованного URL (без порта — порт у нас только 443). */
export function hostOf(url: string): string {
  return new URL(url).hostname;
}

/** URL попадает под исключение продукта (точный URL или префикс). */
export function matchesExcluded(
  url: string,
  prefixes: readonly string[],
  exact: readonly string[] = [],
): boolean {
  for (const raw of exact) {
    if (url === (normalizeCrawlUrl(raw) ?? raw)) return true;
  }
  for (const raw of prefixes) {
    const p = normalizeCrawlUrl(raw) ?? raw;
    if (!p) continue;
    // `https://x.com/a/` как префикс; `https://x.com/a` — и сам URL, и
    // его подстраницы `…/a/…`, `…/a?…`, но не `…/ab`.
    if (url === p) return true;
    if (
      p.endsWith('/')
        ? url.startsWith(p)
        : url.startsWith(`${p}/`) || url.startsWith(`${p}?`)
    ) {
      return true;
    }
  }
  return false;
}
