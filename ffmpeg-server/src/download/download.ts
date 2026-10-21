/**
 * Безопасное скачивание входа (ТЗ §7).
 *
 *  - Только HTTPS без userinfo, хост из allowlist, порт из списка; не
 *    больше `maxRedirects` (3) переходов, политика — на каждом.
 *  - DNS: проверяются ВСЕ A/AAAA; любой непубличный адрес — отказ.
 *    Соединение идёт ровно к проверенному адресу через свой `lookup`, а
 *    TLS (SNI и проверка сертификата) — по исходному hostname. Каждое
 *    соединение — новое (`agent: false`), проверка повторяется.
 *  - Тело читается потоком; лимит — по реальным байтам независимо от
 *    Content-Length. Тайм-ауты connect / stall / файл / общий дедлайн;
 *    AbortSignal.
 *  - Ни query, ни путь URL (в них подписи и токены) не попадают в
 *    сообщения ошибок: только хост.
 */
import * as https from 'node:https';
import { promises as dns } from 'node:dns';
import { createHash } from 'node:crypto';
import { promises as fsp, createWriteStream } from 'node:fs';
import { isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';
import type { LookupFunction } from 'node:net';
import type { DownloadOutcome, ErrorCode } from '../contracts';
import { checkSourceUrl, isPublicAddress } from './url-policy';

export type DownloadErrorCode = Extract<
  ErrorCode,
  | 'FORBIDDEN_SOURCE'
  | 'INPUT_EXPIRED'
  | 'INPUT_TOO_LARGE'
  | 'INPUT_DOWNLOAD_FAILED'
  | 'TIMEOUT'
  | 'CANCELED'
>;

export class DownloadError extends Error {
  constructor(
    readonly code: DownloadErrorCode,
    message: string,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface DownloadOptions {
  allowedHosts: readonly string[];
  maxBytes: number;
  /** Абсолютный дедлайн pipeline (epoch ms) → код TIMEOUT. */
  deadlineAt?: number;
  connectTimeoutMs?: number;
  stallTimeoutMs?: number;
  /** Срок на один файл (включая redirects). */
  fileTimeoutMs?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
  /** Доверенный CA (тесты/частный CA хранилища). По умолчанию — системные. */
  ca?: string | Buffer | Array<string | Buffer>;
  /** Резолвер (тесты). По умолчанию dns.lookup({all: true}). */
  lookup?: (hostname: string) => Promise<ResolvedAddress[]>;
  allowedPorts?: readonly number[];
  /** Политика адресов (только тесты). По умолчанию isPublicAddress. */
  addressAllowed?: (address: string) => boolean;
  userAgent?: string;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

async function defaultLookup(hostname: string): Promise<ResolvedAddress[]> {
  const list = await dns.lookup(hostname, { all: true, verbatim: true });
  return list.map((a) => ({
    address: a.address,
    family: a.family === 6 ? 6 : 4,
  }));
}

function pinnedLookup(addr: ResolvedAddress): LookupFunction {
  return ((
    _hostname: string,
    options: { all?: boolean },
    cb: (...args: unknown[]) => void,
  ) => {
    if (options && options.all)
      cb(null, [{ address: addr.address, family: addr.family }]);
    else cb(null, addr.address, addr.family);
  }) as unknown as LookupFunction;
}

export async function downloadInput(
  url: string,
  destPath: string,
  opts: DownloadOptions,
): Promise<DownloadOutcome> {
  const maxRedirects = opts.maxRedirects ?? 3;
  const fileDeadline = Date.now() + (opts.fileTimeoutMs ?? 120_000);
  const allowedAddr = opts.addressAllowed ?? isPublicAddress;
  const lookup = opts.lookup ?? defaultLookup;
  const part = `${destPath}.part`;
  let current = url;

  const checkTime = () => {
    if (opts.signal?.aborted)
      throw new DownloadError('CANCELED', 'download canceled');
    if (opts.deadlineAt !== undefined && Date.now() >= opts.deadlineAt) {
      throw new DownloadError(
        'TIMEOUT',
        'pipeline deadline reached during download',
      );
    }
    if (Date.now() >= fileDeadline) {
      throw new DownloadError(
        'INPUT_DOWNLOAD_FAILED',
        'input download took too long',
      );
    }
  };

  await fsp.rm(part, { force: true });
  try {
    for (let hop = 0; ; hop++) {
      checkTime();
      const policy = checkSourceUrl(current, opts.allowedHosts, {
        allowedPorts: opts.allowedPorts,
      });
      if (!policy.ok)
        throw new DownloadError('FORBIDDEN_SOURCE', policy.message);
      const host = policy.host;
      let addresses: ResolvedAddress[];
      if (isIP(host)) {
        addresses = [{ address: host, family: isIP(host) === 6 ? 6 : 4 }];
      } else {
        try {
          addresses = await lookup(host);
        } catch {
          throw new DownloadError(
            'INPUT_DOWNLOAD_FAILED',
            `cannot resolve ${host}`,
          );
        }
      }
      if (addresses.length === 0) {
        throw new DownloadError(
          'INPUT_DOWNLOAD_FAILED',
          `cannot resolve ${host}`,
        );
      }
      // ВСЕ адреса должны быть разрешены: иначе атакующий DNS выдал бы
      // смесь публичного и внутреннего.
      for (const a of addresses) {
        if (!allowedAddr(a.address)) {
          throw new DownloadError(
            'FORBIDDEN_SOURCE',
            `input host ${host} resolves to a non-public address`,
          );
        }
      }
      const res = await requestOnce(
        policy.url,
        host,
        addresses[0],
        opts,
        fileDeadline,
      );
      const status = res.statusCode ?? 0;
      if (REDIRECTS.has(status)) {
        res.resume();
        const loc = res.headers.location;
        if (!loc) {
          throw new DownloadError(
            'INPUT_DOWNLOAD_FAILED',
            `redirect without location from ${host}`,
            status,
          );
        }
        if (hop >= maxRedirects) {
          throw new DownloadError(
            'INPUT_DOWNLOAD_FAILED',
            'too many redirects',
          );
        }
        try {
          current = new URL(loc, policy.url).toString();
        } catch {
          throw new DownloadError(
            'INPUT_DOWNLOAD_FAILED',
            'invalid redirect location',
          );
        }
        continue;
      }
      if (status === 401 || status === 403 || status === 410) {
        res.resume();
        throw new DownloadError(
          'INPUT_EXPIRED',
          `input link rejected by ${host} (HTTP ${status})`,
          status,
        );
      }
      if (status !== 200) {
        res.resume();
        throw new DownloadError(
          'INPUT_DOWNLOAD_FAILED',
          `HTTP ${status} from ${host}`,
          status,
        );
      }
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > opts.maxBytes) {
        res.destroy();
        throw new DownloadError(
          'INPUT_TOO_LARGE',
          `input is larger than ${opts.maxBytes} bytes`,
        );
      }
      const outcome = await streamBody(res, part, host, opts, fileDeadline);
      await fsp.rename(part, destPath);
      return outcome;
    }
  } catch (e) {
    await fsp.rm(part, { force: true }).catch(() => undefined);
    if (e instanceof DownloadError) throw e;
    throw new DownloadError('INPUT_DOWNLOAD_FAILED', 'input download failed');
  }
}

function requestOnce(
  url: URL,
  host: string,
  addr: ResolvedAddress,
  opts: DownloadOptions,
  fileDeadline: number,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timers: NodeJS.Timeout[] = [];
    const done = (err: Error | null, res?: IncomingMessage) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      opts.signal?.removeEventListener('abort', onAbort);
      if (err) {
        req.destroy();
        reject(err);
      } else resolve(res!);
    };
    const onAbort = () =>
      done(new DownloadError('CANCELED', 'download canceled'));
    const req = https.request({
      protocol: 'https:',
      hostname: host,
      servername: isIP(host) ? undefined : host,
      port: url.port ? Number(url.port) : 443,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      agent: false,
      lookup: pinnedLookup(addr),
      ca: opts.ca,
      headers: {
        'accept-encoding': 'identity',
        'user-agent': opts.userAgent ?? 'ffmpeg-server-downloader/1',
      },
    });
    const remaining = () =>
      Math.min(
        fileDeadline - Date.now(),
        opts.deadlineAt !== undefined ? opts.deadlineAt - Date.now() : Infinity,
      );
    const overall = remaining();
    timers.push(
      setTimeout(
        () =>
          done(
            opts.deadlineAt !== undefined && Date.now() >= opts.deadlineAt
              ? new DownloadError(
                  'TIMEOUT',
                  'pipeline deadline reached during download',
                )
              : new DownloadError(
                  'INPUT_DOWNLOAD_FAILED',
                  'input download took too long',
                ),
          ),
        Math.max(0, overall),
      ),
    );
    timers.push(
      setTimeout(
        () =>
          done(
            new DownloadError(
              'INPUT_DOWNLOAD_FAILED',
              `connect timeout to ${host}`,
            ),
          ),
        opts.connectTimeoutMs ?? 10_000,
      ),
    );
    req.on('socket', (sock) => {
      sock.once('secureConnect', () => {
        clearTimeout(timers[1]);
        // Ожидание заголовков ответа — тоже «нет прогресса».
        timers[1] = setTimeout(
          () =>
            done(
              new DownloadError(
                'INPUT_DOWNLOAD_FAILED',
                `no response from ${host}`,
              ),
            ),
          opts.stallTimeoutMs ?? 15_000,
        );
      });
    });
    req.on('response', (res) => done(null, res));
    req.on('error', (err) => {
      const tls = /certificate|self[- ]signed|SSL|TLS/i.test(err.message);
      done(
        new DownloadError(
          'INPUT_DOWNLOAD_FAILED',
          tls
            ? `TLS verification failed for ${host}`
            : `connection to ${host} failed`,
        ),
      );
    });
    if (opts.signal) {
      if (opts.signal.aborted) return onAbort();
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    req.end();
  });
}

function streamBody(
  res: IncomingMessage,
  part: string,
  host: string,
  opts: DownloadOptions,
  fileDeadline: number,
): Promise<DownloadOutcome> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const out = createWriteStream(part, { flags: 'wx', mode: 0o640 });
    let bytes = 0;
    let settled = false;
    let stall: NodeJS.Timeout | undefined;
    const fail = (err: DownloadError) => {
      if (settled) return;
      settled = true;
      cleanup();
      res.destroy();
      out.destroy();
      reject(err);
    };
    const armStall = () => {
      if (stall) clearTimeout(stall);
      stall = setTimeout(
        () =>
          fail(
            new DownloadError(
              'INPUT_DOWNLOAD_FAILED',
              `download from ${host} stalled`,
            ),
          ),
        opts.stallTimeoutMs ?? 15_000,
      );
    };
    const remaining = Math.min(
      fileDeadline - Date.now(),
      opts.deadlineAt !== undefined ? opts.deadlineAt - Date.now() : Infinity,
    );
    const overall = setTimeout(
      () =>
        fail(
          opts.deadlineAt !== undefined && Date.now() >= opts.deadlineAt
            ? new DownloadError(
                'TIMEOUT',
                'pipeline deadline reached during download',
              )
            : new DownloadError(
                'INPUT_DOWNLOAD_FAILED',
                'input download took too long',
              ),
        ),
      Math.max(0, remaining),
    );
    const onAbort = () =>
      fail(new DownloadError('CANCELED', 'download canceled'));
    const cleanup = () => {
      if (stall) clearTimeout(stall);
      clearTimeout(overall);
      opts.signal?.removeEventListener('abort', onAbort);
    };
    if (opts.signal) {
      if (opts.signal.aborted) return onAbort();
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    armStall();
    res.on('data', (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > opts.maxBytes) {
        fail(
          new DownloadError(
            'INPUT_TOO_LARGE',
            `input is larger than ${opts.maxBytes} bytes`,
          ),
        );
        return;
      }
      hash.update(chunk);
      armStall();
      if (!out.write(chunk)) {
        res.pause();
        out.once('drain', () => res.resume());
      }
    });
    res.on('aborted', () =>
      fail(
        new DownloadError(
          'INPUT_DOWNLOAD_FAILED',
          `connection to ${host} was cut`,
        ),
      ),
    );
    res.on('error', () =>
      fail(
        new DownloadError(
          'INPUT_DOWNLOAD_FAILED',
          `connection to ${host} was cut`,
        ),
      ),
    );
    out.on('error', () =>
      fail(
        new DownloadError('INPUT_DOWNLOAD_FAILED', 'cannot write input file'),
      ),
    );
    res.on('end', () => {
      if (settled) return;
      if (!res.complete) {
        fail(
          new DownloadError(
            'INPUT_DOWNLOAD_FAILED',
            `connection to ${host} was cut`,
          ),
        );
        return;
      }
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared !== bytes) {
        fail(
          new DownloadError(
            'INPUT_DOWNLOAD_FAILED',
            `truncated body from ${host}`,
          ),
        );
        return;
      }
      out.end(() => {
        void (async () => {
          try {
            const fh = await fsp.open(part, 'r+');
            await fh.sync();
            await fh.close();
          } catch {
            /* fsync — лучшая попытка */
          }
          if (settled) return;
          settled = true;
          cleanup();
          const ct = res.headers['content-type'];
          resolve({
            bytes,
            sha256: hash.digest('hex'),
            contentType:
              typeof ct === 'string' ? ct.split(';')[0].trim() || null : null,
          });
        })();
      });
    });
  });
}
