/**
 * Ключ лимита «на IP» (лендинг-ТЗ §6.3, ТЗ помощника §3.1, контракт Э1 §8):
 * IPv4 целиком, IPv6 — по префиксу /64 (у абонента IPv6 миллиарды адресов:
 * лимит по полному адресу обходится сменой адреса), IPv4-mapped IPv6 — как
 * IPv4. Сырой IP дальше не хранится: вызывающий хеширует ключ (суточная
 * соль песочницы и виджета, HMAC без соли — окно формы Publisher).
 *
 * Р-PUB-12 (AI Publisher, P-A0): перенесён сюда из
 * `assist-sandbox/sandbox-limits.ts` (там остался реэкспорт), чтобы модуль
 * `publisher` брал его из common/, а не из модуля песочницы (правило графа
 * `publisher-scope`). Чистая функция: без базы и env.
 */
import { isIP } from 'net';

/** IPv6 → 8 групп по 4 hex (с IPv4 в хвосте — тоже). null — не IPv6. */
export function expandIPv6(ip: string): string[] | null {
  let s = ip.trim().toLowerCase().replace(/%.*$/, '');
  if (isIP(s) !== 6) return null;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const p = v4[1].split('.').map(Number);
    s =
      s.slice(0, -v4[1].length) +
      `${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const fill = s.includes('::') ? 8 - h.length - t.length : 0;
  const groups = [...h, ...Array<string>(fill).fill('0'), ...t];
  if (groups.length !== 8) return null;
  return groups.map((g) => g.padStart(4, '0'));
}

/**
 * Ключ лимита: IPv4 как есть; IPv4-mapped IPv6 (`::ffff:a.b.c.d`) — как
 * IPv4 (иначе один адрес считался бы двумя ключами); IPv6 — /64.
 */
export function ipLimitKey(ip: string): string {
  const raw = ip
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (isIP(raw) === 4) return raw;
  const groups = expandIPv6(raw);
  if (!groups) return `raw:${raw}`;
  const mapped =
    groups.slice(0, 5).every((g) => g === '0000') && groups[5] === 'ffff';
  if (mapped) {
    const a = parseInt(groups[6], 16);
    const b = parseInt(groups[7], 16);
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return `${groups.slice(0, 4).join(':')}::/64`;
}
