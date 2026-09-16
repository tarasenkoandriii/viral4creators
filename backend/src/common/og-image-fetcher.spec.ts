/**
 * og-image-fetcher.spec.ts — тестов на оригинал (Solar Shop) не было;
 * написаны заново под конвенции этого проекта. `./fetch-with-retry` и
 * `./headless-chromium` мокаются — ни реальной сети, ни реального
 * Chromium тесты не поднимают. Функции, выполняющиеся в контексте
 * страницы (`scrollThroughPage`/`collectImageCandidates`), тестируются
 * косвенно, через мок `page.evaluate`, который просто отдаёт заранее
 * заданный список кандидатов — сама сериализация в браузер здесь не
 * проверяется (для этого нужен был бы реальный Puppeteer).
 */

jest.mock('./fetch-with-retry', () => ({ fetchWithRetry: jest.fn() }));
jest.mock('./headless-chromium', () => ({
  launchHeadlessBrowser: jest.fn(),
  withTimeout: jest.fn((promise: Promise<unknown>) => promise),
}));

import { fetchWithRetry } from './fetch-with-retry';
import { launchHeadlessBrowser, withTimeout } from './headless-chromium';
import { fetchOgImage } from './og-image-fetcher';

const fetchWithRetryMock = fetchWithRetry as jest.Mock;
const launchHeadlessBrowserMock = launchHeadlessBrowser as jest.Mock;
const withTimeoutMock = withTimeout as jest.Mock;

// Лёгкий fetch трактует HTML короче 1000 байт как подозрительно
// маленький и эскалирует на headless-браузер БЕЗ разбора кандидатов
// (см. og-image-fetcher.ts) — сознательно, тот же порядок проверок, что
// в оригинале. Тестовые фикстуры для "найдено без эскалации" поэтому
// дополняются балластом до этого порога.
const PADDING = `<!-- ${'x'.repeat(1100)} -->`;
function htmlLongEnough(meaningful: string): string {
  return `${PADDING}${meaningful}`;
}

function htmlResponse(
  html: string,
  opts: { status?: number; ok?: boolean; url?: string } = {},
) {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    url: opts.url ?? 'https://example.com/article',
    text: async () => html,
  } as unknown as Response;
}

function imageHeadResponse(
  opts: { status?: number; contentType?: string; totalBytes?: number } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.contentType) headers['content-type'] = opts.contentType;
  if (opts.totalBytes !== undefined)
    headers['content-range'] = `bytes 0-0/${opts.totalBytes}`;
  return {
    status: opts.status ?? 200,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as unknown as Response;
}

beforeEach(() => {
  // reset, не clear: тесты цепочкой ставят несколько mockResolvedValueOnce
  // подряд, и невыбранный остаток из предыдущего теста иначе утекал бы в
  // следующий (clearAllMocks очищает только calls/results, не очередь
  // "once"-реализаций).
  jest.resetAllMocks();
  withTimeoutMock.mockImplementation((promise: Promise<unknown>) => promise);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('fetchOgImage — лёгкий путь (без headless-браузера)', () => {
  it('находит og:image в HTML и подтверждает, что он открывается', async () => {
    const html = htmlLongEnough(
      `<html><head><meta property="og:image" content="https://cdn.example.com/cover.jpg" /></head></html>`,
    );
    fetchWithRetryMock
      .mockResolvedValueOnce(htmlResponse(html))
      .mockResolvedValueOnce(
        imageHeadResponse({ contentType: 'image/jpeg', totalBytes: 54321 }),
      );

    const result = await fetchOgImage('https://example.com/article');

    expect(result.imageUrl).toBe('https://cdn.example.com/cover.jpg');
    expect(launchHeadlessBrowserMock).not.toHaveBeenCalled();
  });

  it('HTML без единого кандидата — null, без эскалации на браузер (разметка прочиталась успешно)', async () => {
    fetchWithRetryMock.mockResolvedValueOnce(
      htmlResponse(
        `<html><body>${'текст без картинок '.repeat(100)}</body></html>`,
      ),
    );

    const result = await fetchOgImage('https://example.com/article');

    expect(result.imageUrl).toBeNull();
    expect(launchHeadlessBrowserMock).not.toHaveBeenCalled();
  });

  it('404 — не эскалирует на браузер (страница реально не существует)', async () => {
    fetchWithRetryMock.mockResolvedValueOnce(
      htmlResponse('', { ok: false, status: 404 }),
    );

    const result = await fetchOgImage('https://example.com/gone');

    expect(result.imageUrl).toBeNull();
    expect(result.diagnostic).toContain('404');
    expect(launchHeadlessBrowserMock).not.toHaveBeenCalled();
  });

  it('DNS не резолвится — не эскалирует на браузер (тот же DNS у него)', async () => {
    fetchWithRetryMock.mockRejectedValueOnce(
      Object.assign(new Error('fetch failed'), {
        cause: Object.assign(
          new Error('getaddrinfo ENOTFOUND example.invalid'),
          { code: 'ENOTFOUND' },
        ),
      }),
    );

    const result = await fetchOgImage('https://example.invalid/article');

    expect(result.imageUrl).toBeNull();
    expect(launchHeadlessBrowserMock).not.toHaveBeenCalled();
  });
});

describe('fetchOgImage — эскалация на headless-браузер', () => {
  it('403 — классический бот-блок, эскалирует и использует DOM-кандидатов браузера', async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(htmlResponse('', { ok: false, status: 403 })) // лёгкий fetch
      .mockResolvedValueOnce(
        imageHeadResponse({ contentType: 'image/png', totalBytes: 99999 }),
      ); // проверка кандидата

    const fakePage = {
      setUserAgent: jest.fn(),
      setExtraHTTPHeaders: jest.fn(),
      goto: jest.fn().mockResolvedValue(undefined),
      evaluate: jest
        .fn()
        .mockResolvedValue(['https://cdn.example.com/from-dom.png']),
      content: jest.fn().mockResolvedValue('<html></html>'),
    };
    const fakeBrowser = {
      newPage: jest.fn().mockResolvedValue(fakePage),
      close: jest.fn().mockResolvedValue(undefined),
    };
    launchHeadlessBrowserMock.mockResolvedValue({ browser: fakeBrowser });

    const result = await fetchOgImage('https://example.com/protected');

    expect(result.imageUrl).toBe('https://cdn.example.com/from-dom.png');
    expect(fakeBrowser.close).toHaveBeenCalled();
  });

  it('JS-челлендж (короткий HTML с характерным маркером) — эскалирует', async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(
        htmlResponse('<html>checking your browser before accessing...</html>'),
      )
      .mockResolvedValueOnce(
        imageHeadResponse({ contentType: 'image/jpeg', totalBytes: 20000 }),
      );

    const fakePage = {
      setUserAgent: jest.fn(),
      setExtraHTTPHeaders: jest.fn(),
      goto: jest.fn().mockResolvedValue(undefined),
      evaluate: jest.fn().mockResolvedValue([]),
      content: jest
        .fn()
        .mockResolvedValue(
          '<meta property="og:image" content="https://cdn.example.com/after-challenge.jpg">',
        ),
    };
    const fakeBrowser = {
      newPage: jest.fn().mockResolvedValue(fakePage),
      close: jest.fn().mockResolvedValue(undefined),
    };
    launchHeadlessBrowserMock.mockResolvedValue({ browser: fakeBrowser });

    const result = await fetchOgImage('https://example.com/challenged');

    expect(result.imageUrl).toBe('https://cdn.example.com/after-challenge.jpg');
  });

  it('браузер недоступен (launchHeadlessBrowser вернул error) — null с диагностикой запуска', async () => {
    fetchWithRetryMock.mockResolvedValueOnce(
      htmlResponse('', { ok: false, status: 429 }),
    );
    launchHeadlessBrowserMock.mockResolvedValue({
      error: 'headless-браузер недоступен: тест',
    });

    const result = await fetchOgImage('https://example.com/limited');

    expect(result.imageUrl).toBeNull();
    expect(result.diagnostic).toContain('недоступен');
  });

  it('браузер поднялся, но кандидатов нет вовсе — null, browser.close всё равно вызван', async () => {
    fetchWithRetryMock.mockResolvedValueOnce(
      htmlResponse('', { ok: false, status: 403 }),
    );
    const fakePage = {
      setUserAgent: jest.fn(),
      setExtraHTTPHeaders: jest.fn(),
      goto: jest.fn().mockResolvedValue(undefined),
      evaluate: jest.fn().mockResolvedValue([]),
      content: jest
        .fn()
        .mockResolvedValue('<html><body>ничего полезного</body></html>'),
    };
    const fakeBrowser = {
      newPage: jest.fn().mockResolvedValue(fakePage),
      close: jest.fn().mockResolvedValue(undefined),
    };
    launchHeadlessBrowserMock.mockResolvedValue({ browser: fakeBrowser });

    const result = await fetchOgImage('https://example.com/empty');

    expect(result.imageUrl).toBeNull();
    expect(fakeBrowser.close).toHaveBeenCalled();
  });

  it('page.goto бросает — ошибка ловится, browser.close вызван, null с диагностикой', async () => {
    fetchWithRetryMock.mockResolvedValueOnce(
      htmlResponse('', { ok: false, status: 403 }),
    );
    const fakePage = {
      setUserAgent: jest.fn(),
      setExtraHTTPHeaders: jest.fn(),
      goto: jest
        .fn()
        .mockRejectedValue(
          new Error('Navigation timeout of 20000 ms exceeded'),
        ),
    };
    const fakeBrowser = {
      newPage: jest.fn().mockResolvedValue(fakePage),
      close: jest.fn().mockResolvedValue(undefined),
    };
    launchHeadlessBrowserMock.mockResolvedValue({ browser: fakeBrowser });

    const result = await fetchOgImage('https://example.com/slow');

    expect(result.imageUrl).toBeNull();
    expect(result.diagnostic).toContain('headless-браузер провалился');
    expect(fakeBrowser.close).toHaveBeenCalled();
  });
});

describe('fetchOgImage — валидация кандидатов', () => {
  it('первый кандидат битый (404), второй рабочий — берёт второй', async () => {
    const html = htmlLongEnough(
      [
        '<meta property="og:image" content="https://cdn.example.com/broken.jpg">',
        '<meta name="twitter:image" content="https://cdn.example.com/works.jpg">',
      ].join(''),
    );
    fetchWithRetryMock
      .mockResolvedValueOnce(htmlResponse(html))
      .mockResolvedValueOnce(imageHeadResponse({ status: 404 }))
      .mockResolvedValueOnce(
        imageHeadResponse({ contentType: 'image/jpeg', totalBytes: 20000 }),
      );

    const result = await fetchOgImage('https://example.com/article');

    expect(result.imageUrl).toBe('https://cdn.example.com/works.jpg');
  });

  it('кандидат — заглушка lazy-load (меньше 1024 байт) — отбрасывается', async () => {
    const html = htmlLongEnough(
      '<meta property="og:image" content="https://cdn.example.com/placeholder.gif">',
    );
    fetchWithRetryMock
      .mockResolvedValueOnce(htmlResponse(html))
      .mockResolvedValueOnce(
        imageHeadResponse({ contentType: 'image/gif', totalBytes: 43 }),
      );

    const result = await fetchOgImage('https://example.com/article');

    expect(result.imageUrl).toBeNull();
  });

  it('content-type text/html вместо картинки (мягкий 404) — отбрасывается', async () => {
    const html = htmlLongEnough(
      '<meta property="og:image" content="https://cdn.example.com/gone.jpg">',
    );
    fetchWithRetryMock
      .mockResolvedValueOnce(htmlResponse(html))
      .mockResolvedValueOnce(
        imageHeadResponse({ contentType: 'text/html; charset=utf-8' }),
      );

    const result = await fetchOgImage('https://example.com/article');

    expect(result.imageUrl).toBeNull();
  });
});
