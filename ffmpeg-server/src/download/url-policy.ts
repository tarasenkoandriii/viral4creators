/**
 * Политика источников входов (ТЗ §7): только HTTPS без userinfo, порт из
 * списка (по умолчанию 443), хост из allowlist; адреса — только публичные
 * unicast (без loopback/private/link-local/metadata/CGNAT/ULA/multicast/
 * reserved/IPv4-mapped).
 */
import { BlockList, isIP } from 'node:net';

export interface SourcePolicyOk {
  ok: true;
  url: URL;
  host: string;
}
export interface SourcePolicyFail {
  ok: false;
  code: 'FORBIDDEN_SOURCE';
  message: string;
}

/**
 * Элемент allowlist: точный хост (`store.example.com`) или `*.suffix`
 * (любой поддомен suffix, но не сам suffix). Сравнение без учёта регистра,
 * хвостовая точка снимается.
 */
export function hostAllowed(
  host: string,
  allowedHosts: readonly string[],
): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  for (const raw of allowedHosts) {
    const a = raw.trim().toLowerCase().replace(/\.$/, '');
    if (!a) continue;
    if (a.startsWith('*.')) {
      const suffix = a.slice(1); // ".suffix"
      if (h.length > suffix.length && h.endsWith(suffix)) return true;
    } else if (h === a) {
      return true;
    }
  }
  return false;
}

const v4 = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, в т.ч. metadata 169.254.169.254
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.31.196.0', 24], // AS112
  ['192.52.193.0', 24], // AMT
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['192.175.48.0', 24], // AS112
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
] as const) {
  v4.addSubnet(net, prefix, 'ipv4');
}

const v6 = new BlockList();
for (const [net, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['::ffff:0:0', 96], // IPv4-mapped
  ['::', 96], // IPv4-compatible (устар.)
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48], // local NAT64
  ['100::', 64], // discard-only
  ['2001::', 23], // IETF protocol assignments (Teredo и др.)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (несёт IPv4 внутри)
  ['3fff::', 20], // documentation
  ['5f00::', 16], // SRv6 SIDs
  ['fc00::', 7], // ULA, в т.ч. fd00:ec2::254 (metadata)
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (устар.)
  ['ff00::', 8], // multicast
] as const) {
  v6.addSubnet(net, prefix, 'ipv6');
}
const globalUnicast6 = new BlockList();
globalUnicast6.addSubnet('2000::', 3, 'ipv6');

/** Публичный unicast-адрес, к которому разрешено подключаться. */
export function isPublicAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return !v4.check(address, 'ipv4');
  if (kind === 6) {
    // IPv4-mapped в точечной записи (::ffff:1.2.3.4) — всегда отказ.
    if (address.includes('.')) return false;
    return globalUnicast6.check(address, 'ipv6') && !v6.check(address, 'ipv6');
  }
  return false;
}

/**
 * Синхронная проверка URL без DNS — для 403 FORBIDDEN_SOURCE при приёме
 * задачи и для каждого redirect в downloader. Сообщение не содержит
 * query/path (в них бывают подписи и токены).
 */
export function checkSourceUrl(
  url: string,
  allowedHosts: readonly string[],
  opts: { allowedPorts?: readonly number[] } = {},
): SourcePolicyOk | SourcePolicyFail {
  const fail = (message: string): SourcePolicyFail => ({
    ok: false,
    code: 'FORBIDDEN_SOURCE',
    message,
  });
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return fail('input URL is not valid');
  }
  if (u.protocol !== 'https:') return fail('only https input URLs are allowed');
  if (u.username || u.password)
    return fail('userinfo in input URL is not allowed');
  const port = u.port ? Number(u.port) : 443;
  const ports = opts.allowedPorts ?? [443];
  if (!ports.includes(port)) return fail(`port ${port} is not allowed`);
  // Хост из URL: IPv6-литерал приходит в скобках.
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(host) && !isPublicAddress(host)) {
    return fail('input host address is not public');
  }
  if (!hostAllowed(host, allowedHosts)) {
    return fail(`input host ${host} is not in the allowlist`);
  }
  return { ok: true, url: u, host };
}
