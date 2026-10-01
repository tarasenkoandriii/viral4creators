/**
 * Исходящий HTTP с IP-pin (QA-ТЗ §5.4, В-64; лендинг-ТЗ §6.4) — K1.
 *
 * Схема (обязательная, контракт Э1 «IP-pin»):
 *  1. URL: только `https:`, порт 443 (или пустой), без `user:pass@`, хост —
 *     не IP-литерал (любая запись: десятичная, восьмеричная, hex, IPv6 в
 *     скобках) → иначе `SsrfBlockedError`.
 *  2. Резолв ОДИН раз (`dns.lookup(host, { all: true })`); если ЛЮБОЙ
 *     адрес в блок-листе (`isBlockedAddress` из shared/external-url-guard,
 *     источник — backend/src/common/external-url-guard.ts) — отказ.
 *  3. Подключение — undici `Agent({ connect: { lookup } })`, где lookup
 *     ВСЕГДА отдаёт проверенный адрес из шага 2 (обе формы колбэка:
 *     `opts.all` → массив, иначе (err, address, family)); SNI и Host —
 *     исходное имя (сертификат проверяется как обычно). Второго резолва
 *     нет вовсе — DNS-rebinding («первый ответ публичный, второй —
 *     127.0.0.1») не к чему применить.
 *  4. Редиректы — вручную: каждый хоп = шаги 1–3 заново; `sameOrigin` —
 *     другой origin → `RedirectOffsiteError`.
 *  5. Тело — потоком с лимитом `maxBytes` ПОСЛЕ распаковки (gzip-бомба не
 *     раздует память): обрыв и `BodyTooLargeError` (или обрезка, если
 *     `truncateAtMaxBytes`).
 *  6. Таймаут на весь запрос (все хопы и тело); агент закрывается после
 *     каждого хопа — пул соединений с «чужим» адресом не переживает запрос.
 *
 * Мета-тест SSRF — acceptance/e1/ssrf-meta.spec.ts.
 */

import { promises as dns } from 'dns';
import { isIP } from 'net';
import type { Readable } from 'stream';
import { Agent, request } from 'undici';
import * as zlib from 'zlib';
import {
  BodyTooLargeError,
  isBlockedAddress,
} from '../../../shared/external-url-guard';
import type { PinnedFetchOptions, PinnedResponse } from '../types';

export class SsrfBlockedError extends Error {
  constructor(readonly detail: string) {
    super('Адрес недоступен извне или указывает на служебную сеть');
    this.name = 'SsrfBlockedError';
  }
}

export class RedirectOffsiteError extends Error {
  constructor(readonly location: string) {
    super(`Редирект на другой сайт: ${location}`);
    this.name = 'RedirectOffsiteError';
  }
}

/** Весь запрос (с редиректами и телом) не уложился в `timeoutMs`. */
export class FetchTimeoutError extends Error {
  constructor() {
    super('Сайт не ответил вовремя');
    this.name = 'FetchTimeoutError';
  }
}

/** Резолвер — параметр, чтобы мета-тест подставлял «rebinding»-DNS. */
export type LookupAll = (
  host: string,
) => Promise<Array<{ address: string; family: 4 | 6 }>>;

export interface PinnedAddress {
  address: string;
  family: 4 | 6;
}

/**
 * Зависимости сети. Передаются ТОЛЬКО конструктором/параметром (Nest-токен
 * `PINNED_HTTP_DEPS` — только в тестах), НИКОГДА из env: переменная
 * окружения, разрешающая «подключиться куда-то ещё», в проде — дыра.
 */
export interface PinnedHttpDeps {
  lookupAll: LookupAll;
  /** Подменяется в тестах (локальный сервер вместо 443). */
  portOverride?: number;
  /**
   * Только тесты: подключение идёт на локальный сервер, хотя проверку
   * блок-листа прошёл адрес резолва (`ip` ответа — он же). Иначе
   * локальный стенд (127.0.0.1) отсекался бы той самой проверкой, которую
   * тест и проверяет.
   */
  dialOverride?: PinnedAddress;
  /** Только тесты: CA самоподписанного сертификата локального сервера. */
  tlsCa?: string;
  /** Наблюдатель: какое имя и какой проверенный адрес отдан сокету. */
  onDial?: (host: string, pinned: PinnedAddress) => void;
}

/** Nest-токен для подмены сети в тестах (провайдер по умолчанию не нужен). */
export const PINNED_HTTP_DEPS = Symbol('PINNED_HTTP_DEPS');

const defaultLookupAll: LookupAll = async (host) => {
  const list = await dns.lookup(host, { all: true, verbatim: true });
  return list.map((a) => ({
    address: a.address,
    family: a.family === 6 ? 6 : 4,
  }));
};

export const DEFAULT_PINNED_HTTP_DEPS: PinnedHttpDeps = {
  lookupAll: defaultLookupAll,
};

/** Проверка URL до сети (шаг 1). Бросает SsrfBlockedError. */
export function assertCrawlableUrl(url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new SsrfBlockedError('не URL');
  }
  if (u.protocol !== 'https:') throw new SsrfBlockedError('не https');
  // WHATWG URL уже убрал «:443»; любой другой порт — отказ.
  if (u.port !== '') throw new SsrfBlockedError(`порт ${u.port}`);
  if (u.username || u.password) {
    throw new SsrfBlockedError('логин/пароль в адресе');
  }
  const host = u.hostname;
  // URL-парсер переводит `2130706433`, `0177.0.0.1`, `0x7f.1` в
  // `127.0.0.1`, а IPv6 оставляет в скобках — оба случая ловятся здесь.
  if (!host || host.startsWith('[') || isIP(host) !== 0) {
    throw new SsrfBlockedError('IP-литерал вместо имени');
  }
  const bare = host.replace(/\.$/, '');
  if (!bare.includes('.')) throw new SsrfBlockedError('одноуровневое имя');
  return u;
}

/** Шаг 2: резолв один раз, проверка КАЖДОГО адреса, выбор первого. */
export async function resolveAndCheck(
  host: string,
  lookupAll: LookupAll,
): Promise<PinnedAddress> {
  let list: Array<{ address: string; family: 4 | 6 }>;
  try {
    list = await lookupAll(host.replace(/\.$/, ''));
  } catch {
    throw new SsrfBlockedError('имя не резолвится');
  }
  if (!list || list.length === 0) {
    throw new SsrfBlockedError('имя не резолвится');
  }
  // Блок, если ХОТЬ ОДИН адрес служебный: какой из них выберет сокет,
  // заранее не известно (тот же довод, что в assertPubliclyRoutableUrl).
  for (const a of list) {
    if (isBlockedAddress(a.address)) {
      throw new SsrfBlockedError(`служебный адрес ${a.address}`);
    }
  }
  return { address: list[0].address, family: list[0].family };
}

type LookupCb = (
  err: NodeJS.ErrnoException | null,
  address: string | Array<{ address: string; family: number }>,
  family?: number,
) => void;

function pinnedAgent(
  host: string,
  pinned: PinnedAddress,
  deps: PinnedHttpDeps,
  timeoutMs: number,
): Agent {
  const dial = deps.dialOverride ?? pinned;
  return new Agent({
    connections: 1,
    pipelining: 0,
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    connect: {
      timeout: timeoutMs,
      ...(deps.tlsCa ? { ca: deps.tlsCa } : {}),
      lookup: ((_h: string, opts: unknown, cb: LookupCb) => {
        deps.onDial?.(host, pinned);
        if (opts && (opts as { all?: boolean }).all) {
          cb(null, [{ address: dial.address, family: dial.family }]);
        } else {
          cb(null, dial.address, dial.family);
        }
      }) as never,
    },
  });
}

function lowerHeaders(
  raw: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

function decoderFor(encoding: string | undefined): zlib.Gunzip | null {
  const enc = (encoding ?? '').trim().toLowerCase();
  if (enc === 'gzip' || enc === 'x-gzip') return zlib.createGunzip();
  if (enc === 'deflate') return zlib.createInflate() as unknown as zlib.Gunzip;
  if (enc === 'br') {
    return zlib.createBrotliDecompress() as unknown as zlib.Gunzip;
  }
  return null;
}

/** Тело потоком: лимит считается по РАСПАКОВАННЫМ байтам. */
async function readLimited(
  body: Readable,
  encoding: string | undefined,
  maxBytes: number,
  truncate: boolean,
): Promise<Buffer> {
  const decoder = decoderFor(encoding);
  let source: AsyncIterable<Buffer> = body;
  if (decoder) {
    body.on('error', (e) => decoder.destroy(e));
    body.pipe(decoder);
    source = decoder;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of source) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (total + buf.length > maxBytes) {
        if (!truncate) throw new BodyTooLargeError();
        chunks.push(buf.subarray(0, maxBytes - total));
        total = maxBytes;
        break;
      }
      chunks.push(buf);
      total += buf.length;
    }
  } finally {
    // Обрыв: не дочитываем остаток чужого ответа.
    body.destroy();
    decoder?.destroy();
  }
  return Buffer.concat(chunks, total);
}

function isAbort(e: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  const name = (e as { name?: string; code?: string })?.name ?? '';
  const code = (e as { code?: string })?.code ?? '';
  return (
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
  );
}

export async function pinnedFetch(
  url: string,
  opts: PinnedFetchOptions,
  deps?: Partial<PinnedHttpDeps>,
): Promise<PinnedResponse> {
  const d: PinnedHttpDeps = { ...DEFAULT_PINNED_HTTP_DEPS, ...deps };
  const start = assertCrawlableUrl(url);
  let current = start;
  const redirects: string[] = [];
  const signal = AbortSignal.timeout(opts.timeoutMs);
  const method = opts.method ?? 'GET';

  for (let hop = 0; ; hop++) {
    const pinned = await resolveAndCheck(current.hostname, d.lookupAll);
    if (signal.aborted) throw new FetchTimeoutError();
    const agent = pinnedAgent(current.hostname, pinned, d, opts.timeoutMs);
    try {
      const target = new URL(current.href);
      const headers: Record<string, string> = {
        'accept-encoding': 'gzip, deflate, br',
        ...lowerHeaders(opts.headers ?? {}),
      };
      if (d.portOverride) {
        target.port = String(d.portOverride);
        // Host — исходный, как в проде (порт стенда наружу не светим).
        headers.host = current.host;
      }
      let res;
      try {
        res = await request(target, {
          dispatcher: agent,
          method,
          headers,
          signal,
        });
      } catch (e) {
        if (isAbort(e, signal)) throw new FetchTimeoutError();
        throw e;
      }
      const resHeaders = lowerHeaders(
        res.headers as Record<string, string | string[] | undefined>,
      );
      const status = res.statusCode;
      const location = resHeaders.location;
      if (
        status >= 300 &&
        status < 400 &&
        status !== 304 &&
        location &&
        hop < opts.maxRedirects
      ) {
        await res.body.dump().catch(() => undefined);
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          throw new SsrfBlockedError('некорректный Location');
        }
        if (opts.sameOrigin && next.origin !== start.origin) {
          throw new RedirectOffsiteError(next.href);
        }
        current = assertCrawlableUrl(next.href);
        redirects.push(current.href);
        continue;
      }
      let body: Buffer;
      if (method === 'HEAD' || status === 304 || status === 204) {
        await res.body.dump().catch(() => undefined);
        body = Buffer.alloc(0);
      } else {
        try {
          body = await readLimited(
            res.body as unknown as Readable,
            resHeaders['content-encoding'],
            opts.maxBytes,
            opts.truncateAtMaxBytes === true,
          );
        } catch (e) {
          if (e instanceof BodyTooLargeError) throw e;
          if (isAbort(e, signal)) throw new FetchTimeoutError();
          throw e;
        }
      }
      return {
        url: current.href,
        status,
        headers: resHeaders,
        body,
        redirects,
        ip: pinned.address,
      };
    } finally {
      await agent.destroy().catch(() => undefined);
    }
  }
}
