/**
 * TXT-запись через DNS-over-HTTPS у ДВУХ независимых резолверов
 * (QA-ТЗ §5.1, ТЗ помощника §3.3): подтверждение — только при совпадении.
 *
 * Почему не `dns.resolveTxt`: системный резолвер функции Vercel — один и
 * кэширующий; отравленный/устаревший ответ одного резолвера не должен
 * давать подтверждение владения. Два разных оператора (Cloudflare и
 * Google) с собственными кэшами — это и есть «независимые».
 *
 * Адреса резолверов — константы, а не ввод пользователя: SSRF-ворота
 * (`fetchPubliclyRoutable`) им не нужны, нужен только таймаут.
 */

import { VERIFY_TIMEOUT_MS } from '../site-core.constants';

export interface DohResolver {
  name: string;
  /** Полный URL запроса TXT для имени. */
  url(name: string): string;
}

export const DEFAULT_DOH_RESOLVERS: readonly DohResolver[] = [
  {
    name: 'cloudflare',
    url: (n) =>
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(n)}&type=TXT`,
  },
  {
    name: 'google',
    url: (n) =>
      `https://dns.google/resolve?name=${encodeURIComponent(n)}&type=TXT`,
  },
];

/** Ответ одного резолвера: набор значений TXT или сбой. */
export type DohAnswer =
  | { ok: true; resolver: string; values: string[] }
  | { ok: false; resolver: string; error: string };

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

const TXT_TYPE = 16;
/** RCODE: 0 — NOERROR, 3 — NXDOMAIN (имени нет — это ответ, не сбой). */
const RCODE_NOERROR = 0;
const RCODE_NXDOMAIN = 3;

/**
 * `data` TXT в JSON-API DoH — строка(и) в кавычках: `"a" "b"` для записи,
 * разбитой на куски по 255 байт. Склеиваем куски, как это делает
 * `dns.resolveTxt` (массив кусков → одна строка).
 */
export function parseTxtData(data: string): string {
  const parts = [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) =>
    m[1].replace(/\\(.)/g, '$1'),
  );
  return parts.length > 0 ? parts.join('') : data;
}

export class DohClient {
  constructor(
    private readonly resolvers: readonly DohResolver[] = DEFAULT_DOH_RESOLVERS,
    private readonly fetchImpl: FetchLike = (i, init) => fetch(i, init),
    private readonly timeoutMs = VERIFY_TIMEOUT_MS,
  ) {
    if (resolvers.length < 2) {
      // Один резолвер — это не «два независимых»: молча ослабить правило
      // нельзя, лучше упасть при старте.
      throw new Error('DoH: нужно минимум два независимых резолвера');
    }
  }

  get resolverCount(): number {
    return this.resolvers.length;
  }

  /** TXT у всех резолверов параллельно; сбой одного не роняет остальные. */
  async resolveTxtAll(name: string): Promise<DohAnswer[]> {
    return Promise.all(this.resolvers.map((r) => this.resolveOne(r, name)));
  }

  private async resolveOne(r: DohResolver, name: string): Promise<DohAnswer> {
    try {
      const res = await this.fetchImpl(r.url(name), {
        headers: { accept: 'application/dns-json' },
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
      if (!res.ok) {
        return { ok: false, resolver: r.name, error: `HTTP ${res.status}` };
      }
      const body = (await res.json()) as {
        Status?: unknown;
        Answer?: unknown;
      };
      if (body.Status === RCODE_NXDOMAIN) {
        return { ok: true, resolver: r.name, values: [] };
      }
      if (body.Status !== RCODE_NOERROR) {
        return {
          ok: false,
          resolver: r.name,
          error: `RCODE ${String(body.Status)}`,
        };
      }
      const answers = Array.isArray(body.Answer) ? body.Answer : [];
      const values = answers
        .filter(
          (a): a is { type: number; data: string } =>
            typeof a === 'object' &&
            a !== null &&
            (a as { type?: unknown }).type === TXT_TYPE &&
            typeof (a as { data?: unknown }).data === 'string',
        )
        .map((a) => parseTxtData(a.data).trim());
      return { ok: true, resolver: r.name, values };
    } catch (error) {
      return {
        ok: false,
        resolver: r.name,
        error: error instanceof Error ? error.name : 'error',
      };
    }
  }
}
