/* СГЕНЕРИРОВАНО scripts/sync-site-tma-kit.mjs — не править. Источник: site-tma-kit/src/hosts.ts */
/**
 * Ввод и сравнение хостов на клиенте.
 *
 * Сервер всё равно нормализует и проверяет адрес сам
 * (`assertPubliclyRoutableUrl`, ТЗ §3.1) — здесь только то, что нужно,
 * чтобы человек сразу увидел, ЧТО именно он добавляет: единица
 * подтверждения — схема + FQDN + порт, и `www.example.com` ≠
 * `example.com` (ТЗ §3.3, Р-18).
 */

export interface HostAddress {
  scheme: 'https';
  host: string;
  port: number;
}

export type HostInputError =
  'empty' | 'invalid' | 'not_https' | 'port' | 'ip' | 'single_label';

export type HostInputResult =
  ({ ok: true } & HostAddress) | { ok: false; error: HostInputError };

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Разбор того, что человек ввёл: `example.com`, `https://Shop.Example.com/x`,
 * `пример.укр`. Путь и query отбрасываются — подтверждается хост целиком,
 * а не страница. `www` НЕ срезается: это отдельный хост.
 */
export function parseHostInput(raw: string): HostInputResult {
  const input = raw.trim();
  if (!input) return { ok: false, error: 'empty' };

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input)
    ? input
    : `https://${input}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, error: 'invalid' };
  }
  // В MVP подтверждаются только https-хосты на 443 (ТЗ §3.3): виджет на
  // http-origin не работает, и выдать человеку инструкцию для http —
  // значит пообещать то, что потом не заработает.
  if (url.protocol !== 'https:') return { ok: false, error: 'not_https' };
  if (url.port && url.port !== '443') return { ok: false, error: 'port' };
  if (url.username || url.password) return { ok: false, error: 'invalid' };

  // URL уже перевёл IDN в punycode и привёл к нижнему регистру.
  const host = url.hostname.replace(/\.$/, '');
  if (!host) return { ok: false, error: 'invalid' };
  if (host.startsWith('[') || IPV4.test(host)) {
    return { ok: false, error: 'ip' };
  }
  if (!host.includes('.')) return { ok: false, error: 'single_label' };
  return { ok: true, scheme: 'https', host, port: 443 };
}

/** Ключ хоста — та же уникальность, что в ядре: (схема, хост, порт). */
export function hostKey(h: HostAddress): string {
  return `${h.scheme}://${h.host}:${h.port}`;
}

/** Origin для показа и ссылок: порт 443 не пишется. */
export function hostOrigin(h: HostAddress): string {
  return h.port === 443
    ? `${h.scheme}://${h.host}`
    : `${h.scheme}://${h.host}:${h.port}`;
}

/**
 * Покрывает ли подтверждение `verified` хост `candidate`.
 *
 * Только точное совпадение схемы, хоста и порта. Поддомены НЕ
 * наследуются, wildcard через apex — нет (ТЗ §3.3, Р-18;
 * `TZ-QA-TMA.md` §2.4): поддомен может быть делегирован Shopify/Zendesk,
 * и контроль DNS apex не равен контролю его содержимого.
 */
export function verificationCovers(
  verified: HostAddress,
  candidate: HostAddress
): boolean {
  return hostKey(verified) === hostKey(candidate);
}

/**
 * Парный хост для подсказки «www — отдельный хост»: `www.x.com` ↔ `x.com`.
 * Для глубоких поддоменов (`shop.x.com`) пары не предлагаем — `www.shop.`
 * почти никогда не существует, и подсказка была бы шумом.
 */
export function wwwTwin(host: string): string | null {
  if (host.startsWith('www.')) {
    const apex = host.slice(4);
    return apex.includes('.') ? apex : null;
  }
  return host.split('.').length === 2 ? `www.${host}` : null;
}

export type HostRowError = HostInputError | 'duplicate';

/**
 * Проверка списка адресов формы «Добавить сайт»: ошибка по каждой строке
 * и дубли. Дубль считается по ключу ядра (схема+хост+порт), а не по
 * тексту: `Example.com` и `https://example.com/` — один хост, и сервер
 * второй всё равно отклонит (уникальность в кабинете, ТЗ §4.17).
 * Пустые строки пропускаются — это незаполненные поля «ещё адрес».
 */
export function validateHostList(inputs: string[]): {
  hosts: HostAddress[];
  errors: Array<HostRowError | null>;
} {
  const seen = new Set<string>();
  const hosts: HostAddress[] = [];
  const errors = inputs.map((raw): HostRowError | null => {
    if (!raw.trim()) return null;
    const r = parseHostInput(raw);
    if (!r.ok) return r.error;
    const addr: HostAddress = { scheme: r.scheme, host: r.host, port: r.port };
    const key = hostKey(addr);
    if (seen.has(key)) return 'duplicate';
    seen.add(key);
    hosts.push(addr);
    return null;
  });
  return { hosts, errors };
}

/**
 * Хосты публичных платформ — только DNS (ТЗ §3.3): файл/мета на
 * `*.myshopify.com` доказывают доступ к магазину, но не к домену.
 * Авторитетный список — на сервере (`SiteHost.publicPlatform`,
 * `sites-backend/src/modules/site-core/hosts/host-normalize.ts`); здесь —
 * КОПИЯ того же списка, чтобы экран не предлагал способ, который сервер
 * отклонит. Импортом нельзя (разные пакеты, Vercel собирает только root
 * приложения) — поэтому `assist/scripts/platforms.test.ts` читает файл
 * сервера и падает при любом расхождении.
 */
export const PUBLIC_PLATFORM_SUFFIXES = [
  'myshopify.com',
  'tilda.ws',
  'github.io',
  'vercel.app',
  'netlify.app',
  'pages.dev',
  'wixsite.com',
  'webflow.io',
  'herokuapp.com',
  'blogspot.com',
  'wordpress.com',
  'squarespace.com',
  'framer.website',
  'onrender.com',
  'fly.dev',
  'web.app',
  'firebaseapp.com',
  'azurewebsites.net',
  'cloudfront.net',
  'gitlab.io',
] as const;

export function isPublicPlatformHost(host: string): boolean {
  const h = host.toLowerCase();
  return PUBLIC_PLATFORM_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`));
}
