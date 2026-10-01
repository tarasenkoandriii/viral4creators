/**
 * Исходящий запрос проверки владения (файл/мета) и подсказки хостов.
 *
 * Это запрос с НАШЕГО сервера на адрес, который назвал пользователь, —
 * тот же SSRF-вектор, что у фида товаров (QA-ТЗ §5.1). Поэтому:
 *  - каждый хоп проходит `assertPubliclyRoutableUrl` (shared/
 *    external-url-guard — та же проверка, что внутри
 *    `fetchPubliclyRoutable`), редиректы движку сети не отдаются;
 *  - сам запрос хопа (по умолчанию) — через IP-pin `pinnedFetch`
 *    (site-crawl/net, Э1): сокет получает ровно проверенный адрес, без
 *    второго резолва (DNS-rebinding, В-64);
 *  - редирект на ДРУГОЙ хост (или схему/порт) — отказ сразу: токен на
 *    чужом хосте не доказывает владение нашим (QA §2.4, приёмка Э0);
 *  - редиректы в пределах того же origin (`/` → `/uk/`) — до 3;
 *  - таймаут 10 с на весь запрос.
 *
 * Почему не сам `fetchPubliclyRoutable`: он идёт по редиректам на любой
 * публичный хост и не отдаёт `Location` наружу (при `maxRedirects = 0`
 * редирект превращается в безликий «небезопасный адрес»), а нам нужно
 * различать «чужой хост» и «тот же хост, другой путь». Логика хопа —
 * его же, плюс замок на origin.
 */

import {
  UnsafeExternalUrlError,
  assertPubliclyRoutableUrl,
} from '../../../shared/external-url-guard';
import {
  PinnedHttpDeps,
  SsrfBlockedError,
  pinnedFetch,
} from '../../site-crawl/net/pinned-fetch';
import {
  VERIFY_MAX_SAME_HOST_REDIRECTS,
  VERIFY_TIMEOUT_MS,
} from '../site-core.constants';
import type { FetchLike } from './doh.client';

export class RedirectToOtherHostError extends Error {
  constructor(readonly location: string) {
    super(`редирект на другой хост: ${location}`);
    this.name = 'RedirectToOtherHostError';
  }
}

export class TooManyRedirectsError extends Error {}

export interface SafeHttpDeps {
  assertUrl: (url: string) => Promise<void>;
  fetch: FetchLike;
  timeoutMs: number;
}

/**
 * Сколько тела берёт один хоп проверки. Больше, чем читают потребители
 * (`VERIFY_BODY_LIMIT_BYTES`, подсказка хостов): обрезка здесь — потолок
 * памяти, а решение «файл-маркер слишком большой» остаётся за
 * `readBodyWithLimit` вызывающего (он видит обрезанное тело длиннее
 * своего лимита и бросает, как раньше).
 */
export const PINNED_HOP_MAX_BYTES = 1024 * 1024;

/**
 * Один хоп через IP-pin (Э1, K1; закрывает отложенное Э0 «IP-pin»): адрес
 * резолвится один раз, проверяется блок-листом и только он отдаётся
 * сокету — DNS-rebinding между проверкой и подключением невозможен.
 * Редиректы pinnedFetch НЕ проходит (`maxRedirects: 0`): их по-прежнему
 * разбирает `fetchSameOrigin` (замок на origin, различение «чужой хост»).
 * Отказ SSRF превращается в `UnsafeExternalUrlError` — его классифицирует
 * ownership-checker (`UNSAFE_URL`).
 */
export function pinnedFetchLike(net: Partial<PinnedHttpDeps> = {}): FetchLike {
  return async (input, init = {}) => {
    if (init.signal?.aborted) throw init.signal.reason;
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v;
    });
    try {
      const res = await pinnedFetch(
        input,
        {
          method: init.method === 'HEAD' ? 'HEAD' : 'GET',
          headers,
          maxBytes: PINNED_HOP_MAX_BYTES,
          truncateAtMaxBytes: true,
          timeoutMs: VERIFY_TIMEOUT_MS,
          maxRedirects: 0,
          sameOrigin: true,
        },
        net,
      );
      // 204/304 и т.п. не могут нести тело в конструкторе Response.
      const nullBody = [101, 103, 204, 205, 304].includes(res.status);
      return new Response(nullBody ? null : new Uint8Array(res.body), {
        status: res.status,
        headers: res.headers,
      });
    } catch (e) {
      if (e instanceof SsrfBlockedError) {
        throw new UnsafeExternalUrlError(e.message);
      }
      throw e;
    }
  };
}

export const DEFAULT_SAFE_HTTP_DEPS: SafeHttpDeps = {
  assertUrl: assertPubliclyRoutableUrl,
  fetch: pinnedFetchLike(),
  timeoutMs: VERIFY_TIMEOUT_MS,
};

/** Тот же origin: схема + хост + порт (порт по умолчанию нормализован URL). */
function sameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.host === b.host;
}

/**
 * GET без перехода на другой origin. Возвращает ответ последнего хопа
 * (не-3xx). Бросает `UnsafeExternalUrlError` (SSRF),
 * `RedirectToOtherHostError`, `TooManyRedirectsError` или сетевую ошибку.
 */
export async function fetchSameOrigin(
  url: string,
  deps: SafeHttpDeps = DEFAULT_SAFE_HTTP_DEPS,
  init: RequestInit = {},
): Promise<{ res: Response; finalUrl: string }> {
  const start = new URL(url);
  let current = start;
  const signal = AbortSignal.timeout(deps.timeoutMs);
  for (let hop = 0; ; hop++) {
    await deps.assertUrl(current.toString());
    const res = await deps.fetch(current.toString(), {
      ...init,
      method: 'GET',
      redirect: 'manual',
      signal,
    });
    if (res.status < 300 || res.status >= 400) {
      return { res, finalUrl: current.toString() };
    }
    const location = res.headers.get('location');
    if (!location) return { res, finalUrl: current.toString() };
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new UnsafeExternalUrlError('некорректный Location');
    }
    // Тело редиректа не нужно — освобождаем соединение.
    await res.body?.cancel().catch(() => undefined);
    if (!sameOrigin(start, next)) {
      throw new RedirectToOtherHostError(next.origin);
    }
    if (hop >= VERIFY_MAX_SAME_HOST_REDIRECTS) {
      throw new TooManyRedirectsError();
    }
    current = next;
  }
}

/**
 * Первые `maxBytes` тела — и обрыв потока. Для меты и подсказки хостов:
 * `<head>` с мета-тегом лежит в начале страницы, а главная магазина легко
 * весит больше 64 КБ, и `readBodyWithLimit` (который на превышении
 * БРОСАЕТ) сделал бы мету непригодной для половины сайтов. Память всё
 * равно ограничена: больше `maxBytes` (+ один чанк) не держим.
 */
export async function readPrefix(
  res: Response,
  maxBytes: number,
): Promise<Buffer> {
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.subarray(0, maxBytes);
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    total += value.byteLength;
    if (total >= maxBytes) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return Buffer.concat(chunks).subarray(0, maxBytes);
}
