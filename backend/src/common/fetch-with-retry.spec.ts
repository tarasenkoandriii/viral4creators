import { fetchWithRetry } from './fetch-with-retry';

/**
 * fetch-with-retry.spec.ts — портировано вместе с самим модулем из
 * Solar Shop (см. шапку fetch-with-retry.ts); тестов на оригинал не
 * было, написаны заново под конвенции этого проекта (мок глобального
 * `fetch`, малые `backoffMs`/`timeoutMs` вместо фейковых таймеров —
 * проще и достаточно для проверки retry/backoff-логики).
 */

function fakeResponse(
  status: number,
  opts: { headers?: Record<string, string> } = {},
): Response {
  const headers = opts.headers ?? {};
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as unknown as Response;
}

describe('fetchWithRetry', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('успешный ответ с первой попытки — фетчится один раз, без ретраев', async () => {
    const fetchMock = jest.fn().mockResolvedValue(fakeResponse(200));
    global.fetch = fetchMock as never;

    const res = await fetchWithRetry('https://example.com', { backoffMs: 1 });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('передаёт AbortController.signal в fetch', async () => {
    const fetchMock = jest.fn().mockResolvedValue(fakeResponse(200));
    global.fetch = fetchMock as never;

    await fetchWithRetry('https://example.com', { backoffMs: 1 });

    const passedOptions = fetchMock.mock.calls[0][1] as {
      signal?: AbortSignal;
    };
    expect(passedOptions.signal).toBeInstanceOf(AbortSignal);
  });

  it('5xx — повторяет с backoff, отдаёт финальный успешный ответ', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(fakeResponse(503))
      .mockResolvedValueOnce(fakeResponse(200));
    global.fetch = fetchMock as never;

    const res = await fetchWithRetry('https://example.com', {
      retries: 2,
      backoffMs: 1,
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('5xx на каждой попытке — исчерпывает retries и отдаёт последний (неуспешный) ответ, не бросает', async () => {
    const fetchMock = jest.fn().mockResolvedValue(fakeResponse(500));
    global.fetch = fetchMock as never;

    const res = await fetchWithRetry('https://example.com', {
      retries: 2,
      backoffMs: 1,
    });

    expect(res.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(3); // попытка 0,1,2
  });

  it('404 — не ретраится вовсе, отдаётся сразу', async () => {
    const fetchMock = jest.fn().mockResolvedValue(fakeResponse(404));
    global.fetch = fetchMock as never;

    const res = await fetchWithRetry('https://example.com', {
      retries: 2,
      backoffMs: 1,
    });

    expect(res.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('429 без Retry-After — ретраится как 5xx-подобная перегрузка', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(fakeResponse(429))
      .mockResolvedValueOnce(fakeResponse(200));
    global.fetch = fetchMock as never;

    const res = await fetchWithRetry('https://example.com', {
      retries: 2,
      backoffMs: 1,
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('429 с коротким Retry-After (секунды) — ждёт именно это время, потом ретраится', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        fakeResponse(429, { headers: { 'retry-after': '0' } }),
      )
      .mockResolvedValueOnce(fakeResponse(200));
    global.fetch = fetchMock as never;

    const res = await fetchWithRetry('https://example.com', {
      retries: 2,
      backoffMs: 1,
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('429 с Retry-After дольше MAX_RETRY_AFTER_MS (>5с) — не ждёт и не ретраит, отдаёт 429', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(
        fakeResponse(429, { headers: { 'retry-after': '30' } }),
      );
    global.fetch = fetchMock as never;

    const res = await fetchWithRetry('https://example.com', {
      retries: 2,
      backoffMs: 1,
    });

    expect(res.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('429 с Retry-After в виде HTTP-даты в ближайшем будущем — ретраится', async () => {
    const soon = new Date(Date.now() + 10).toUTCString();
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        fakeResponse(429, { headers: { 'retry-after': soon } }),
      )
      .mockResolvedValueOnce(fakeResponse(200));
    global.fetch = fetchMock as never;

    const res = await fetchWithRetry('https://example.com', {
      retries: 2,
      backoffMs: 1,
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('сетевая ошибка — повторяет и в итоге бросает последнюю ошибку', async () => {
    const error = new Error('network down');
    const fetchMock = jest.fn().mockRejectedValue(error);
    global.fetch = fetchMock as never;

    await expect(
      fetchWithRetry('https://example.com', { retries: 1, backoffMs: 1 }),
    ).rejects.toThrow('network down');
    expect(fetchMock).toHaveBeenCalledTimes(2); // попытка 0,1
  });

  it('onRetry вызывается на каждой повторной попытке с номером попытки', async () => {
    const onRetry = jest.fn();
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(fakeResponse(503))
      .mockResolvedValueOnce(fakeResponse(503))
      .mockResolvedValueOnce(fakeResponse(200));
    global.fetch = fetchMock as never;

    await fetchWithRetry('https://example.com', {
      retries: 2,
      backoffMs: 1,
      onRetry,
    });

    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, 1, expect.any(Error));
    expect(onRetry).toHaveBeenNthCalledWith(2, 2, expect.any(Error));
  });
});
