/**
 * headless-chromium.spec.ts — тестов на оригинал (встроенный в Solar
 * Shop og-image-fetcher.ts) не было; написаны заново под конвенции
 * этого проекта. `@sparticuz/chromium-min`/`puppeteer-core`/
 * `node:fs/promises`/`./fetch-with-retry` мокаются — реального
 * Chromium/сети/файловой системы тесты не трогают.
 */

jest.mock('./fetch-with-retry', () => ({ fetchWithRetry: jest.fn() }));
jest.mock('node:fs/promises', () => ({ stat: jest.fn(), rm: jest.fn() }));
jest.mock('@sparticuz/chromium-min', () => ({
  executablePath: jest.fn(),
  args: ['--single-process', '--no-sandbox'],
  headless: true,
}));
jest.mock('puppeteer-core', () => ({ launch: jest.fn() }));

import { fetchWithRetry } from './fetch-with-retry';
import { stat, rm } from 'node:fs/promises';
// `@sparticuz/chromium-min`'s .d.ts — `export = Chromium` (CJS export
// assignment) — не пускает `import * as` без esModuleInterop (проект его
// не включает); `import ... = require(...)` — родной TS-синтаксис под
// именно этот случай, работает при любом esModuleInterop.
import chromiumMin = require('@sparticuz/chromium-min');
import * as puppeteerCore from 'puppeteer-core';
import {
  resolveHeadlessBrowserLaunchPlan,
  launchHeadlessBrowser,
  withTimeout,
  __resetHeadlessBrowserLaunchPlanForTests,
  HeadlessBrowserLaunchPlan,
} from './headless-chromium';

// Утверждения-сужения типа вместо `if (plan.kind === '...') { expect(...) }`:
// `expect` внутри условного блока запрещён линтером (jest/no-conditional-
// expect) — сам факт, что тип не совпал, уже провал теста, так что эти
// хелперы бросают исключение сами, без условного `expect`.
function assertReady(
  plan: HeadlessBrowserLaunchPlan,
): asserts plan is Extract<HeadlessBrowserLaunchPlan, { kind: 'ready' }> {
  if (plan.kind !== 'ready') {
    throw new Error(`ожидался готовый план, получено: ${JSON.stringify(plan)}`);
  }
}
function assertUnavailable(
  plan: HeadlessBrowserLaunchPlan,
): asserts plan is Extract<HeadlessBrowserLaunchPlan, { kind: 'unavailable' }> {
  if (plan.kind !== 'unavailable') {
    throw new Error(
      `ожидался недоступный план, получено: ${JSON.stringify(plan)}`,
    );
  }
}
function assertLaunchError<
  T extends { error: string } | Record<string, unknown>,
>(result: T): asserts result is Extract<T, { error: string }> {
  if (!('error' in result)) {
    throw new Error(
      `ожидалась ошибка запуска браузера, получено: ${JSON.stringify(result)}`,
    );
  }
}

const statMock = stat as unknown as jest.Mock;
const rmMock = rm as unknown as jest.Mock;
const fetchWithRetryMock = fetchWithRetry as jest.Mock;
const executablePathMock = chromiumMin.executablePath as unknown as jest.Mock;
const launchMock = puppeteerCore.launch as unknown as jest.Mock;

const PACK_DIR = '/tmp/chromium-pack';
const LIB_DIR = '/tmp/al2023/lib'; // Node 20+ в песочнице — всегда эта ветка
const EXTRACTED_PATH = '/tmp/chromium';
const READY_SIZE = 178 * 1024 * 1024; // реальная цифра из шапки модуля

function tarHeaderArrayBuffer(): ArrayBuffer {
  const buf = Buffer.alloc(512);
  buf.write('ustar', 257, 'latin1');
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function tarPrecheckResponse(ok = true, status = 200) {
  return {
    ok,
    status,
    arrayBuffer: async () => tarHeaderArrayBuffer(),
  } as unknown as Response;
}

/** По умолчанию всё "не найдено" (ENOENT-подобно); переопределяем по пути. */
function mockStatByPath(sizes: Record<string, number>) {
  statMock.mockImplementation((p: string) => {
    if (Object.prototype.hasOwnProperty.call(sizes, p)) {
      return Promise.resolve({ size: sizes[p] });
    }
    return Promise.reject(new Error('ENOENT'));
  });
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.PUPPETEER_EXECUTABLE_PATH;
  delete process.env.CHROMIUM_PACK_URL;
  delete process.env.AWS_EXECUTION_ENV;
  delete process.env.AWS_LAMBDA_JS_RUNTIME;
  __resetHeadlessBrowserLaunchPlanForTests();
  jest.clearAllMocks();
  statMock.mockRejectedValue(new Error('ENOENT'));
  rmMock.mockResolvedValue(undefined);
});

describe('resolveHeadlessBrowserLaunchPlan', () => {
  it('PUPPETEER_EXECUTABLE_PATH задан — Docker-ветка, без сети и без @sparticuz/chromium-min', async () => {
    process.env.PUPPETEER_EXECUTABLE_PATH = '/usr/bin/chromium';

    const plan = await resolveHeadlessBrowserLaunchPlan();

    assertReady(plan);
    expect(plan.executablePath).toBe('/usr/bin/chromium');
    expect(plan.source).toContain('системный Chromium');
    expect(plan.headless).toBe(true);
    expect(fetchWithRetryMock).not.toHaveBeenCalled();
    expect(executablePathMock).not.toHaveBeenCalled();
  });

  it('архив недоступен (precheck не 2xx) — план unavailable с диагностикой', async () => {
    fetchWithRetryMock.mockResolvedValue(tarPrecheckResponse(false, 404));

    const plan = await resolveHeadlessBrowserLaunchPlan();

    assertUnavailable(plan);
    expect(plan.diagnostic).toContain('архив Chromium недоступен');
    expect(plan.diagnostic).toContain('404');
    expect(executablePathMock).not.toHaveBeenCalled();
  });

  it('неудача помнится LAUNCH_FAILURE_COOLDOWN_MS — повторный вызов не бьёт по сети снова', async () => {
    fetchWithRetryMock.mockResolvedValue(tarPrecheckResponse(false, 500));

    const first = await resolveHeadlessBrowserLaunchPlan();
    const second = await resolveHeadlessBrowserLaunchPlan();

    expect(first.kind).toBe('unavailable');
    expect(second.kind).toBe('unavailable');
    expect(fetchWithRetryMock).toHaveBeenCalledTimes(1);
  });

  it('одновременные вызовы в одном тике дедуплицируются в один билд плана', async () => {
    fetchWithRetryMock.mockResolvedValue(tarPrecheckResponse(true));
    mockStatByPath({
      [EXTRACTED_PATH]: READY_SIZE,
      [`${LIB_DIR}/libnss3.so`]: 1024,
    });
    executablePathMock.mockResolvedValue(EXTRACTED_PATH);

    const [a, b] = await Promise.all([
      resolveHeadlessBrowserLaunchPlan(),
      resolveHeadlessBrowserLaunchPlan(),
    ]);

    expect(a).toBe(b); // тот же объект — общий промис
    expect(fetchWithRetryMock).toHaveBeenCalledTimes(1);
    expect(executablePathMock).toHaveBeenCalledTimes(1);
  });

  it('счастливый путь: архив скачивается по URL, план готов', async () => {
    fetchWithRetryMock.mockResolvedValue(tarPrecheckResponse(true));
    mockStatByPath({
      [EXTRACTED_PATH]: READY_SIZE,
      [`${LIB_DIR}/libnss3.so`]: 1024,
    });
    executablePathMock.mockResolvedValue(EXTRACTED_PATH);

    const plan = await resolveHeadlessBrowserLaunchPlan();

    assertReady(plan);
    expect(plan.executablePath).toBe(EXTRACTED_PATH);
    expect(plan.source).toBe(
      `@sparticuz/chromium-min (serverless, ${LIB_DIR})`,
    );
    expect(plan.args).toEqual(['--single-process', '--no-sandbox']);
    expect(plan.headless).toBe(true);
    // Архива локально не было -> executablePath() зовётся с URL, не с packDir.
    expect(executablePathMock).toHaveBeenCalledWith(
      'https://github.com/Sparticuz/chromium/releases/download/v127.0.0/chromium-v127.0.0-pack.tar',
    );
  });

  it('локальный пакет уже распакован — пропускает сетевую проверку, зовёт executablePath(packDir)', async () => {
    mockStatByPath({
      [`${PACK_DIR}/chromium.br`]: 4096,
      [EXTRACTED_PATH]: READY_SIZE,
      [`${LIB_DIR}/libnss3.so`]: 1024,
    });
    executablePathMock.mockResolvedValue(EXTRACTED_PATH);

    const plan = await resolveHeadlessBrowserLaunchPlan();

    expect(plan.kind).toBe('ready');
    expect(fetchWithRetryMock).not.toHaveBeenCalled();
    expect(executablePathMock).toHaveBeenCalledWith(PACK_DIR);
  });

  it('библиотеки (libnss3.so) не распаковались даже после повтора — unavailable', async () => {
    fetchWithRetryMock.mockResolvedValue(tarPrecheckResponse(true));
    mockStatByPath({}); // libnss3.so нигде нет
    executablePathMock.mockResolvedValue(EXTRACTED_PATH);

    const plan = await resolveHeadlessBrowserLaunchPlan();

    assertUnavailable(plan);
    expect(plan.diagnostic).toContain('libnss3.so');
    expect(executablePathMock).toHaveBeenCalledTimes(2); // первая попытка + повтор
    expect(rmMock).toHaveBeenCalledWith(EXTRACTED_PATH, { force: true });
  });

  it('распакованный бинарник неполный — unavailable, файл удаляется', async () => {
    fetchWithRetryMock.mockResolvedValue(tarPrecheckResponse(true));
    mockStatByPath({
      [`${LIB_DIR}/libnss3.so`]: 1024,
      [EXTRACTED_PATH]: 5 * 1024 * 1024, // << MIN_CHROMIUM_BINARY_BYTES
    });
    executablePathMock.mockResolvedValue(EXTRACTED_PATH);

    const plan = await resolveHeadlessBrowserLaunchPlan();

    assertUnavailable(plan);
    expect(plan.diagnostic).toContain('неполный');
    expect(rmMock).toHaveBeenCalledWith(EXTRACTED_PATH, { force: true });
  });

  it('@sparticuz/chromium-min бросает исключение — unavailable, без падения процесса', async () => {
    fetchWithRetryMock.mockResolvedValue(tarPrecheckResponse(true));
    executablePathMock.mockRejectedValue(new Error('boom'));

    const plan = await resolveHeadlessBrowserLaunchPlan();

    assertUnavailable(plan);
    expect(plan.diagnostic).toContain('headless-браузер недоступен');
    expect(plan.diagnostic).toContain('boom');
  });
});

describe('launchHeadlessBrowser', () => {
  it('план unavailable — не пытается импортировать puppeteer-core', async () => {
    fetchWithRetryMock.mockResolvedValue(tarPrecheckResponse(false, 500));

    const result = await launchHeadlessBrowser();

    expect('error' in result).toBe(true);
    expect(launchMock).not.toHaveBeenCalled();
  });

  it('план готов — запускает puppeteer.launch с параметрами плана, отдаёт browser', async () => {
    process.env.PUPPETEER_EXECUTABLE_PATH = '/usr/bin/chromium';
    const fakeBrowser = { close: jest.fn() };
    launchMock.mockResolvedValue(fakeBrowser);

    const result = await launchHeadlessBrowser();

    expect(result).toEqual({ browser: fakeBrowser });
    expect(launchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        executablePath: '/usr/bin/chromium',
        headless: true,
      }),
    );
  });

  it('puppeteer.launch падает с признаком нехватки памяти — диагностика с подсказкой', async () => {
    process.env.PUPPETEER_EXECUTABLE_PATH = '/usr/bin/chromium';
    launchMock.mockRejectedValue(new Error('spawn ENOENT'));

    const result = await launchHeadlessBrowser();

    assertLaunchError(result);
    expect(result.error).toContain('нехватку памяти');
  });

  it('puppeteer.launch падает с обычной ошибкой — без подсказки про память', async () => {
    process.env.PUPPETEER_EXECUTABLE_PATH = '/usr/bin/chromium';
    launchMock.mockRejectedValue(new Error('какая-то другая ошибка'));

    const result = await launchHeadlessBrowser();

    assertLaunchError(result);
    expect(result.error).toContain('какая-то другая ошибка');
    expect(result.error).not.toContain('нехватку памяти');
  });
});

describe('withTimeout', () => {
  it('промис укладывается в срок — отдаёт его значение', async () => {
    await expect(
      withTimeout(Promise.resolve('ok'), 1000, 'timeout'),
    ).resolves.toBe('ok');
  });

  it('промис не укладывается в срок — отклоняется с переданным сообщением', async () => {
    const neverResolves = new Promise(() => undefined);
    await expect(
      withTimeout(neverResolves, 5, 'слишком долго'),
    ).rejects.toThrow('слишком долго');
  });
});
