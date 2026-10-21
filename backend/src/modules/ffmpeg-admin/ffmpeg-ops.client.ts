/**
 * HTTP-клиент backend → собственный ffmpeg-server для вкладки «FFmpeg»
 * (ТЗ FFmpeg-server v1.1 §5, §13.1; решение Р-FF-5).
 *
 * - Ops-маршруты `/api/ops/*` и `/api/control/*` — ключом роли `ops`
 *   (`FFMPEG_SELFHOSTED_OPS_KEY`); операции над задачами backend
 *   (`/api/jobs/{id}`, `/cancel`, `/artifacts`, `/by-key`) — ключом
 *   клиента (`FFMPEG_SELFHOSTED_KEY`): задача принадлежит client_id
 *   backend, а не ops.
 * - Тайм-аут каждого запроса ≤ 5 с (§13.1): интеграция не держит запрос
 *   админки до конца рендера. Недоступность — отдельная ошибка
 *   `FfmpegOpsUnavailable`, не пустой ответ.
 * - Ключи, адрес сервера и исходные URL наружу не уходят: ответ
 *   проходит `sanitizeOps` до того, как попасть в ответ админке.
 */

import { Injectable } from '@nestjs/common';

export const FFMPEG_OPS_TIMEOUT_MS = 5_000;
/** Очищенный stderr в карточке — не больше 64 KiB (§13.1 п.3). */
export const FFMPEG_STDERR_MAX_BYTES = 64 * 1024;

export type FfmpegOpsRole = 'ops' | 'client';

/** Сервер недоступен/не настроен/ответил 5xx — исход неизвестен. */
export class FfmpegOpsUnavailable extends Error {
  constructor(
    readonly kind: 'not-configured' | 'timeout' | 'network' | 'upstream',
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Сервер определённо отказал (4xx): действие не выполнено. */
export class FfmpegOpsRejected extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly details: Record<string, unknown> | undefined,
  ) {
    super(message);
  }
}

const SECRET_SUFFIXES = [
  'url',
  'urls',
  'uri',
  'token',
  'tokens',
  'secret',
  'secrets',
  'password',
  'passwd',
  'key',
  'keys',
  'hmac',
  'payload',
  'cookie',
  'cookies',
  'credential',
  'credentials',
  'signature',
];
const SECRET_EXACT = new Set([
  'command',
  'commands',
  'ffmpeg_commands',
  'authorization',
  'headers',
]);
/** Поле с таким именем не покидает backend ни при каком значении. */
export function isSecretField(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    SECRET_EXACT.has(lower) ||
    /key_?sha/.test(lower) ||
    SECRET_SUFFIXES.some((s) => lower.endsWith(s))
  );
}
const URL_IN_TEXT = /\b(?:https?|wss?|ftp|file):\/\/[^\s"'<>]+/gi;
const BEARER_IN_TEXT = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const MACHINE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

function clipUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  return `${buf.subarray(0, maxBytes).toString('utf8')}\n… [обрезано до ${maxBytes} байт]`;
}

/**
 * Очистка ответа ffmpeg-server перед отдачей в админку: поля с
 * секретными именами выкидываются, URL и Bearer в тексте заменяются,
 * stderr ограничен 64 KiB, глубина — 8.
 */
export function sanitizeOps(value: unknown, depth = 0): unknown {
  if (depth > 8) return null;
  if (typeof value === 'string') {
    return value
      .replace(URL_IN_TEXT, '[url]')
      .replace(BEARER_IN_TEXT, '[auth]');
  }
  if (Array.isArray(value))
    return value.slice(0, 500).map((v) => sanitizeOps(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'input_files' && v && typeof v === 'object') {
        // Ключи входов — да, исходные (подписанные) URL — никогда.
        out.input_names = Object.keys(v as Record<string, unknown>);
        continue;
      }
      if (k === 'inputs_metadata' && Array.isArray(v)) {
        // `key` is a logical input alias here, but globally remains secret.
        // Publish only a bounded name in this exact metadata envelope.
        out[k] = v.slice(0, 500).flatMap((entry: unknown) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry))
            return [];
          const alias =
            (entry as Record<string, unknown>).key ??
            (entry as Record<string, unknown>).name;
          if (
            typeof alias !== 'string' ||
            !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(alias)
          )
            return [];
          const safe = sanitizeOps(entry, depth + 2) as Record<string, unknown>;
          return [{ ...safe, name: alias }];
        });
        continue;
      }
      if (isSecretField(k)) continue;
      if (/stderr/i.test(k) && typeof v === 'string') {
        out[k] = clipUtf8(sanitizeOps(v) as string, FFMPEG_STDERR_MAX_BYTES);
        continue;
      }
      if (k === 'output_files' && v && typeof v === 'object') {
        // Имена результатов нужны карточке, ссылки с токенами — нет.
        out.output_names = Array.isArray(v)
          ? v.filter((n) => typeof n === 'string')
          : Object.keys(v as Record<string, unknown>);
        continue;
      }
      out[k] = sanitizeOps(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface FfmpegOpsRequestOptions {
  role: FfmpegOpsRole;
  body?: unknown;
  idempotencyKey?: string;
  correlationId?: string;
  query?: Record<string, string | undefined>;
}

interface Endpoint {
  base: string;
  opsKey?: string;
  clientKey?: string;
}

@Injectable()
export class FfmpegOpsClient {
  private endpoint(): Endpoint | undefined {
    const base = process.env.FFMPEG_SELFHOSTED_BASE_URL?.trim().replace(
      /\/+$/,
      '',
    );
    if (!base) return undefined;
    return {
      base,
      opsKey: process.env.FFMPEG_SELFHOSTED_OPS_KEY?.trim() || undefined,
      clientKey: process.env.FFMPEG_SELFHOSTED_KEY?.trim() || undefined,
    };
  }

  /** Что настроено — булевы флаги, без значений. */
  configuration(): { baseUrl: boolean; opsKey: boolean; clientKey: boolean } {
    const e = this.endpoint();
    return {
      baseUrl: !!e,
      opsKey: !!e?.opsKey,
      clientKey: !!e?.clientKey,
    };
  }

  /**
   * Запрос к ffmpeg-server. Возвращает развёрнутый `data` (сырой, НЕ
   * очищенный — очищает вызывающий через `sanitizeOps`, кроме выдачи
   * ссылки на файл, где ссылка и есть результат).
   */
  async request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    opts: FfmpegOpsRequestOptions,
  ): Promise<Record<string, unknown>> {
    return (await this.requestWithStatus(method, path, opts)).data;
  }

  /** То же, плюс HTTP-статус (purge: 202 — удаление идёт, 200 — завершено). */
  async requestWithStatus(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    opts: FfmpegOpsRequestOptions,
  ): Promise<{ status: number; data: Record<string, unknown> }> {
    const e = this.endpoint();
    const key = opts.role === 'ops' ? e?.opsKey : e?.clientKey;
    if (!e || !key)
      throw new FfmpegOpsUnavailable(
        'not-configured',
        opts.role === 'ops'
          ? 'Свой FFmpeg-сервер не настроен (FFMPEG_SELFHOSTED_BASE_URL / FFMPEG_SELFHOSTED_OPS_KEY)'
          : 'Свой FFmpeg-сервер не настроен (FFMPEG_SELFHOSTED_BASE_URL / FFMPEG_SELFHOSTED_KEY)',
      );
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query ?? {}))
      if (v !== undefined && v !== '') qs.set(k, v);
    const url = `${e.base}${path}${qs.size ? `?${qs.toString()}` : ''}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
    };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
    if (opts.correlationId) headers['X-Correlation-Id'] = opts.correlationId;

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(FFMPEG_OPS_TIMEOUT_MS),
        redirect: 'error',
      });
    } catch (err) {
      const name = (err as { name?: string })?.name;
      throw name === 'TimeoutError' || name === 'AbortError'
        ? new FfmpegOpsUnavailable(
            'timeout',
            `FFmpeg-сервер не ответил за ${FFMPEG_OPS_TIMEOUT_MS / 1000} с`,
          )
        : new FfmpegOpsUnavailable('network', 'FFmpeg-сервер недоступен');
    }
    const text = await res.text().catch(() => '');
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      parsed = {};
    }
    if (!res.ok) {
      if (res.status >= 500 || res.status === 429)
        throw new FfmpegOpsUnavailable(
          'upstream',
          `FFmpeg-сервер ответил ${res.status}`,
          res.status,
        );
      const errObj = (
        parsed.error && typeof parsed.error === 'object' ? parsed.error : parsed
      ) as Record<string, unknown>;
      const rawCode = errObj.error_code ?? errObj.code;
      const code =
        typeof rawCode === 'string' && MACHINE_CODE.test(rawCode)
          ? rawCode
          : undefined;
      const rawMessage = errObj.error_message ?? errObj.message;
      const message =
        typeof rawMessage === 'string' && rawMessage
          ? (sanitizeOps(rawMessage) as string).slice(0, 300)
          : `FFmpeg-сервер отказал (${res.status})`;
      const data = (parsed.data ?? errObj.details) as unknown;
      throw new FfmpegOpsRejected(
        res.status,
        code,
        message,
        data && typeof data === 'object'
          ? (sanitizeOps(data) as Record<string, unknown>)
          : undefined,
      );
    }
    const data = parsed.data;
    return {
      status: res.status,
      data:
        data && typeof data === 'object' && !Array.isArray(data)
          ? (data as Record<string, unknown>)
          : parsed,
    };
  }
}
