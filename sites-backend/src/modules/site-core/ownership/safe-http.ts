/**
 * Исходящий запрос проверки владения (файл/мета) и подсказки хостов.
 *
 * Это запрос с НАШЕГО сервера на адрес, который назвал пользователь, —
 * тот же SSRF-вектор, что у фида товаров (QA-ТЗ §5.1). Поэтому:
 *  - каждый хоп проходит `assertPubliclyRoutableUrl` (shared/
 *    external-url-guard — та же проверка, что внутри
 *    `fetchPubliclyRoutable`), редиректы движку сети не отдаются;
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

export const DEFAULT_SAFE_HTTP_DEPS: SafeHttpDeps = {
  assertUrl: assertPubliclyRoutableUrl,
  fetch: (i, init) => fetch(i, init),
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
