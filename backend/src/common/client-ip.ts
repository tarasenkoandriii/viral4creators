/**
 * Адрес клиента за прокси (Ш0.7 аудита 02.10.2026, риск В-4) — чистый
 * модуль: только `net` из Node, без Nest/Express/Prisma.
 *
 * Вынесен из `rate-limit.ts` (заход 10, П-С1, Р-З10-4), чтобы
 * `scripts/sync-sites-shared.mjs` копировал ту же логику в
 * `sites-backend/src/shared/client-ip.ts`: у генератора и у бэкенда
 * сайтов одно правило доверия `X-Forwarded-For`. `rate-limit.ts`
 * реэкспортирует `clientIp` — прежние импорты работают.
 *
 * Разбор подсетей — своя копия функций `egress-filter-proxy.ts`
 * (`parseCidr`/`isIpInCidr`): тот модуль копируется в реле живого входа
 * (`scripts/sync-relay-shared.mjs`) и тянет сервер-прокси, поэтому
 * чистым для копии в sites-backend он не является. Совпадение двух
 * реализаций держит `client-ip.egress-parity.spec.ts` (только backend).
 */

import { isIP } from 'net';

/** Заголовки запроса — как у Express (`IncomingHttpHeaders`). */
export type ClientIpHeaders = Record<string, string | string[] | undefined>;

/** Минимум полей запроса, нужных для адреса (Express `Request` подходит). */
export interface ClientIpRequest {
  headers: ClientIpHeaders;
  ip?: string;
  socket?: { remoteAddress?: string };
}

export interface TrustedCidr {
  family: 4 | 6;
  base: bigint;
  mask: bigint;
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** IPv4 → 32-битное число; `null` — не IPv4. */
function ipv4ToBigInt(ip: string): bigint | null {
  if (isIP(ip) !== 4) return null;
  return ip
    .split('.')
    .reduce((acc, part) => (acc << 8n) | BigInt(Number(part)), 0n);
}

/** IPv6 → 128-битное число; `null` — не IPv6. */
function ipv6ToBigInt(raw: string): bigint | null {
  let ip = stripBrackets(raw);
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  if (isIP(ip) !== 6) return null;
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (dotted) {
    const v4 = ipv4ToBigInt(dotted[2]);
    if (v4 === null) return null;
    ip = `${dotted[1]}${((v4 >> 16n) & 0xffffn).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const groups =
    tail === undefined
      ? h
      : [...h, ...new Array<string>(8 - h.length - t.length).fill('0'), ...t];
  if (groups.length !== 8) return null;
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n);
}

/** Разбор `1.2.3.4`, `1.2.3.0/24`, `2a01:4f8::/64`. Кривое — исключение. */
export function parseTrustedCidr(spec: string): TrustedCidr {
  const [addr, bitsRaw] = spec.trim().split('/');
  const v4 = ipv4ToBigInt(addr);
  const family: 4 | 6 = v4 !== null ? 4 : 6;
  const value = v4 ?? ipv6ToBigInt(addr);
  const width = family === 4 ? 32 : 128;
  const bits = bitsRaw === undefined ? width : Number(bitsRaw);
  if (
    value === null ||
    !Number.isInteger(bits) ||
    bits < 0 ||
    bits > width ||
    (bitsRaw !== undefined && !/^\d+$/.test(bitsRaw))
  ) {
    throw new Error(`не адрес и не подсеть: ${JSON.stringify(spec)}`);
  }
  const all = (1n << BigInt(width)) - 1n;
  const mask = bits === 0 ? 0n : (all << BigInt(width - bits)) & all;
  return { family, base: value & mask, mask };
}

/** Входит ли адрес в подсеть (IPv4, IPv6, `::ffff:a.b.c.d`). */
export function ipInTrustedCidr(ip: string, cidr: TrustedCidr): boolean {
  const value = cidr.family === 4 ? ipv4ToBigInt(ip) : ipv6ToBigInt(ip);
  if (value === null) {
    // IPv4, отображённый в IPv6 (`::ffff:1.2.3.4`), против IPv4-подсети.
    if (cidr.family === 4) {
      const v6 = ipv6ToBigInt(ip);
      if (v6 !== null && v6 >> 32n === 0xffffn) {
        return (v6 & 0xffffffffn & cidr.mask) === cidr.base;
      }
    }
    return false;
  }
  return (value & cidr.mask) === cidr.base;
}

/** `::ffff:203.0.113.7` → `203.0.113.7`; остальное — как есть. */
function normalizeIp(raw: string | undefined): string {
  const ip = (raw ?? '').trim();
  return ip.toLowerCase().startsWith('::ffff:') && isIP(ip.slice(7)) === 4
    ? ip.slice(7)
    : ip;
}

/** `TRUSTED_PROXY_CIDRS` — через запятую; кривые записи пропускаются. */
function trustedProxies(env: NodeJS.ProcessEnv): TrustedCidr[] {
  const out: TrustedCidr[] = [];
  for (const spec of (env.TRUSTED_PROXY_CIDRS ?? '').split(',')) {
    if (!spec.trim()) continue;
    try {
      out.push(parseTrustedCidr(spec));
    } catch {
      // Кривая запись = «этому прокси не доверяем»: безопасная сторона.
    }
  }
  return out;
}

/**
 * Адрес клиента.
 *
 * До Ш0.7 здесь безусловно брался первый адрес `X-Forwarded-For`. На
 * Vercel это верно — платформа сама переписывает заголовок, — но вне
 * Vercel (Docker за Traefik/Dokploy, локальный запуск) первый адрес
 * пишет КЛИЕНТ: подставив случайный, он получал новое окно на каждый
 * запрос, и лимит не работал вовсе.
 *
 * Теперь:
 *  - на Vercel (`VERCEL` задан платформой) — первый адрес XFF, как раньше;
 *  - вне Vercel XFF читается, ТОЛЬКО если соединение пришло от прокси
 *    из `TRUSTED_PROXY_CIDRS`; цепочка идёт справа налево, доверенные
 *    звенья пропускаются, берётся первый недоверенный адрес — его
 *    дописал ближайший к нам доверенный прокси, подделать его клиент не
 *    может;
 *  - иначе — адрес сокета.
 */
export function clientIp(
  req: ClientIpRequest,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const forwarded = req.headers['x-forwarded-for'];
  const header = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
  const chain = (header ?? '')
    .split(',')
    .map((s) => normalizeIp(s))
    .filter(Boolean);
  const peer = normalizeIp(req.socket?.remoteAddress || req.ip);

  if (env.VERCEL?.trim()) {
    return chain[0] || peer || 'unknown';
  }
  if (!peer) return 'unknown';

  const trusted = trustedProxies(env);
  const isTrusted = (ip: string) =>
    isIP(ip) !== 0 && trusted.some((c) => ipInTrustedCidr(ip, c));
  if (!isTrusted(peer)) return peer;

  // `last` — самый левый адрес, до которого дошли по доверенным звеньям.
  // Мусор в цепочке — дальше не верим и берём `last`, а НЕ `chain[0]`:
  // левее мусора всё писал клиент (аудит Ш0 02.10.2026 — прежний откат
  // на `chain[0]` отдавал подставленный клиентом адрес).
  let last = peer;
  for (let i = chain.length - 1; i >= 0; i--) {
    if (isIP(chain[i]) === 0) break;
    if (!isTrusted(chain[i])) return chain[i];
    last = chain[i];
  }
  return last;
}
