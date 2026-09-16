/**
 * fetch-with-retry.ts — единая точка ретраев/backoff для внешних HTTP-
 * вызовов, которые проект делает через голый `fetch`, а не через `axios`
 * (общий клиент для API третьих сторон в проекте — `axios`, см.
 * `youtube-search.service.ts`; этот модуль — намеренное исключение:
 * портирован из Solar Shop вместе с `og-image-fetcher.ts`/
 * `headless-chromium.ts`, весь их код уже написан на форме Fetch API
 * (`Response.ok`/`.headers.get()`/`.arrayBuffer()`), и Node уже даёт
 * `fetch` нативно — заводить сюда `axios` только ради формы вызова не
 * нужно).
 *
 * Экспоненциальный backoff: `backoffMs * 2^attempt`. Повторяются 5xx и
 * 429 (с уважением к `Retry-After`, если сервер его прислал и просит не
 * дольше `MAX_RETRY_AFTER_MS`) — тот же список условий, что в
 * оригинале.
 */

export interface FetchWithRetryOptions extends RequestInit {
  retries?: number;
  backoffMs?: number;
  timeoutMs?: number;
  onRetry?: (attempt: number, error: unknown) => void;
}

export async function fetchWithRetry(
  url: string,
  options: FetchWithRetryOptions = {},
): Promise<Response> {
  const {
    retries = 3,
    backoffMs = 500,
    timeoutMs = 10_000,
    onRetry,
    ...fetchOptions
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        ...fetchOptions,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      // 429 повторяем тоже, с паузой от сервера — не считаем как 5xx
      // молча, а читаем Retry-After: короткий всплеск лимита сервера не
      // должен выглядеть как полный отказ.
      if (!res.ok && res.status === 429 && attempt < retries) {
        const wait = retryAfterMs(res);
        // Сервер попросил ждать дольше, чем мы готовы, — не ретраим
        // вовсе, отдаём 429 вызывающему (см. MAX_RETRY_AFTER_MS ниже).
        if (wait === null || wait <= MAX_RETRY_AFTER_MS) {
          lastError = new Error(`HTTP 429 at ${url}`);
          onRetry?.(attempt + 1, lastError);
          await sleep(wait ?? backoffMs * 2 ** attempt);
          continue;
        }
      }

      if (!res.ok && res.status >= 500 && attempt < retries) {
        lastError = new Error(`HTTP ${res.status} at ${url}`);
        onRetry?.(attempt + 1, lastError);
        await sleep(backoffMs * 2 ** attempt);
        continue;
      }

      return res;
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      if (attempt < retries) {
        onRetry?.(attempt + 1, error);
        await sleep(backoffMs * 2 ** attempt);
        continue;
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`fetchWithRetry exhausted retries for ${url}`);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Сколько мы готовы ждать по просьбе сервера. Больше — не ждём и не ретраим. */
const MAX_RETRY_AFTER_MS = 5_000;

/** Retry-After бывает в двух форматах: секунды или HTTP-дата. */
function retryAfterMs(res: Response): number | null {
  const header = res.headers.get('retry-after');
  if (!header) return null;

  const asSeconds = Number(header);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) return asSeconds * 1000;

  const asDate = Date.parse(header);
  if (!Number.isNaN(asDate)) return Math.max(asDate - Date.now(), 0);

  return null;
}
