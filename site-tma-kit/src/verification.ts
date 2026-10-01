/**
 * Подтверждение владения хостом: инструкции и разбор статусов.
 *
 * Формат — дословно `TZ-QA-TMA.md` §2.4 (ТЗ помощника §3.3): TXT
 * `_v4c-verify.<хост>` = `v4c-verify=<токен>`, файл
 * `/.well-known/v4c-verify.txt` с токеном в первой строке, мета
 * `<meta name="v4c-verify" content="<токен>">` на `/`. Строки берутся
 * ТОЛЬКО из `brand.ts` — переименование бренда не должно оставить в
 * инструкции старое имя, которое сервер уже не ищет.
 */

import {
  VERIFY_FILE_PATH,
  VERIFY_META_NAME,
  VERIFY_TXT_PREFIX,
  VERIFY_TXT_KEY,
} from './brand';
import { hostOrigin, isPublicPlatformHost, type HostAddress } from './hosts';
import {
  HOST_STATUSES,
  VERIFY_METHODS,
  type HostStatus,
  type SiteHost,
  type VerifyMethod,
} from './types';

export interface DnsInstruction {
  method: 'dns';
  recordType: 'TXT';
  name: string;
  value: string;
}
export interface FileInstruction {
  method: 'file';
  url: string;
  /** Содержимое файла: токен в первой строке. */
  content: string;
}
export interface MetaInstruction {
  method: 'meta';
  pageUrl: string;
  tag: string;
}
export type VerifyInstruction =
  DnsInstruction | FileInstruction | MetaInstruction;

/**
 * Токен попадает в HTML-тег, который человек вставит себе на главную, и
 * в DNS-запись. Символы вне `[A-Za-z0-9_-]` здесь означают сбой сервера
 * или подмену — лучше громко отказаться, чем выдать инструкцию с `"` и
 * `<` внутри.
 */
const TOKEN_RE = /^[A-Za-z0-9_-]{8,128}$/;

export function assertVerifyToken(token: string): void {
  if (!TOKEN_RE.test(token)) {
    throw new Error('Некорректный токен подтверждения');
  }
}

export function dnsRecordName(host: string): string {
  return `${VERIFY_TXT_PREFIX}.${host}`;
}

export function buildInstruction(
  method: VerifyMethod,
  host: HostAddress,
  token: string
): VerifyInstruction {
  assertVerifyToken(token);
  const origin = hostOrigin(host);
  switch (method) {
    case 'dns':
      return {
        method,
        recordType: 'TXT',
        name: dnsRecordName(host.host),
        value: `${VERIFY_TXT_KEY}=${token}`,
      };
    case 'file':
      return { method, url: `${origin}${VERIFY_FILE_PATH}`, content: token };
    case 'meta':
      return {
        method,
        pageUrl: `${origin}/`,
        tag: `<meta name="${VERIFY_META_NAME}" content="${token}">`,
      };
  }
}

/**
 * «Добавьте N записей» одним списком (пакетная проверка, ТЗ §3.3): токен
 * кабинета один, меняется только имя записи. Хосты, которые уже
 * подтверждены, в список не попадают — их запись уже стоит.
 */
export function buildDnsBatch(
  hosts: Array<HostAddress & { status?: HostStatus }>,
  token: string
): DnsInstruction[] {
  const seen = new Set<string>();
  const out: DnsInstruction[] = [];
  for (const h of hosts) {
    if (h.status === 'verified') continue;
    const ins = buildInstruction('dns', h, token) as DnsInstruction;
    if (seen.has(ins.name)) continue;
    seen.add(ins.name);
    out.push(ins);
  }
  return out;
}

/** Какие способы показать: хосты платформ — только DNS. */
export function availableMethods(
  host: Pick<SiteHost, 'host' | 'publicPlatform'>
): VerifyMethod[] {
  return host.publicPlatform || isPublicPlatformHost(host.host)
    ? ['dns']
    : [...VERIFY_METHODS];
}

export function parseHostStatus(raw: unknown): HostStatus | null {
  return typeof raw === 'string' &&
    (HOST_STATUSES as readonly string[]).includes(raw)
    ? (raw as HostStatus)
    : null;
}

export function parseVerifyMethod(raw: unknown): VerifyMethod | null {
  return typeof raw === 'string' &&
    (VERIFY_METHODS as readonly string[]).includes(raw)
    ? (raw as VerifyMethod)
    : null;
}

/**
 * Что показать человеку. К четырём статусам ядра добавляется `failed` —
 * «токен выдан, последняя проверка не нашла запись»: в ядре это
 * по-прежнему `pending`, но человеку важно увидеть, что проверка была и
 * не прошла, а не что «ничего не происходит».
 *
 * `verified` с истёкшим `expiresAt` показываем как `expired`, не дожидаясь
 * крона: зелёная галочка на истёкшем подтверждении — ложное обещание, что
 * виджет и обход работают. Неизвестный статус — никогда не `verified`.
 */
export type HostView =
  'pending' | 'verified' | 'failed' | 'expired' | 'revoked';

export function hostView(
  host: Pick<SiteHost, 'expiresAt' | 'lastCheck'> & {
    status: HostStatus | null;
  },
  now: Date
): HostView {
  switch (host.status) {
    case 'verified': {
      const exp = host.expiresAt ? Date.parse(host.expiresAt) : NaN;
      return Number.isFinite(exp) && exp <= now.getTime()
        ? 'expired'
        : 'verified';
    }
    case 'expired':
      return 'expired';
    case 'revoked':
      return 'revoked';
    case 'pending':
    default:
      return host.lastCheck && host.lastCheck.ok === false
        ? 'failed'
        : 'pending';
  }
}

/** Подтверждение скоро истечёт — показать «до <дата>, затем повтор» жёлтым. */
export function expiresSoon(
  host: Pick<SiteHost, 'status' | 'expiresAt'>,
  now: Date,
  days = 14
): boolean {
  if (host.status !== 'verified' || !host.expiresAt) return false;
  const exp = Date.parse(host.expiresAt);
  if (!Number.isFinite(exp)) return false;
  const left = exp - now.getTime();
  return left > 0 && left <= days * 24 * 3600 * 1000;
}

/**
 * Хосты сайта, которые ещё ждут подтверждения — для «Проверить все»
 * (зеркало отбора `verifyAll` на сервере, кроме отозванных).
 * Отозванные сюда не входят: повторное подтверждение отозванного кабинета
 * может быть заблокировано владельцем хоста (`TZ-QA-TMA.md` §5.1), это
 * решается на экране хоста, а не пачкой.
 */
export function pendingForBatch<
  T extends Pick<SiteHost, 'status' | 'expiresAt' | 'lastCheck'> & {
    reverifyBlocked?: boolean;
  },
>(hosts: T[], now: Date): T[] {
  return hosts.filter((h) => {
    // Заблокированные владельцем хоста сервер в пакет не берёт — и
    // TXT-запись для них показывать незачем: повтор запрещён.
    if (h.reverifyBlocked) return false;
    const v = hostView(h, now);
    return v === 'pending' || v === 'failed' || v === 'expired';
  });
}
