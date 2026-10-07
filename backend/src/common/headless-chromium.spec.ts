/**
 * headless-chromium.spec.ts — тестов на оригинал (встроенный в Solar
 * Shop og-image-fetcher.ts) не было; написаны заново под конвенции
 * этого проекта. `@sparticuz/chromium-min`/`puppeteer-core`/
 * `node:fs/promises`/`./fetch-with-retry` мокаются — реального
 * Chromium/сети/файловой системы тесты не трогают.
 */

jest.mock('./fetch-with-retry', () => ({ fetchWithRetry: jest.fn() }));
jest.mock('node:fs/promises', () => ({ stat: jest.fn(), rm: jest.fn() }));
// Форма — как у настоящего пакета ≥ 132: ESM, `export default Chromium`,
// без свойства `headless`. Через `require(esm)` модуль приезжает
// пространством имён с `.default` — эту развилку код и проходит.
jest.mock('@sparticuz/chromium-min', () => ({
  __esModule: true,
  default: {
    executablePath: jest.fn(),
    args: [
      '--single-process',
      '--no-sandbox',
      '--disable-web-security',
      '--allow-running-insecure-content',
      '--disable-site-isolation-trials',
    ],
  },
}));
jest.mock('puppeteer-core', () => ({ launch: jest.fn() }));
// П-Г3: скачивание с проверкой SHA-256 — фейковое (своя логика — в
// chromium-pack-verify.spec.ts); разбор env — настоящий.
jest.mock('./chromium-pack-verify', () => ({
  ...jest.requireActual('./chromium-pack-verify'),
  downloadVerifiedPack: jest.fn(),
}));

import { Logger } from '@nestjs/common';
import { downloadVerifiedPack } from './chromium-pack-verify';
import { fetchWithRetry } from './fetch-with-retry';
import { stat, rm } from 'node:fs/promises';
import chromiumMin from '@sparticuz/chromium-min';
import * as puppeteerCore from 'puppeteer-core';
import {
  resolveHeadlessBrowserLaunchPlan,
  launchHeadlessBrowser,
  launchArgs,
  UNTRUSTED_STRIPPED_ARGS,
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
  delete process.env.CHROMIUM_PACK_SHA256;
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
    expect(plan.args).toContain('--single-process');
    // Ш0.4: пакет ≥ 132 поддерживает только chrome-headless-shell.
    expect(plan.headless).toBe('shell');
    // Архива локально не было -> executablePath() зовётся с URL, не с packDir.
    // Ш0.4: свежий Chromium и архив под архитектуру (x64 у Vercel).
    expect(executablePathMock).toHaveBeenCalledWith(
      'https://github.com/Sparticuz/chromium/releases/download/v153.0.0/chromium-v153.0.0-pack.x64.tar',
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

describe('П-Г3: проверка SHA-256 архива Chromium', () => {
  const verifyMock = downloadVerifiedPack as jest.Mock;
  const SHA = 'ab'.repeat(32);
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    fetchWithRetryMock.mockResolvedValue(tarPrecheckResponse(true));
    mockStatByPath({
      [EXTRACTED_PATH]: READY_SIZE,
      [`${LIB_DIR}/libnss3.so`]: 1024,
    });
    executablePathMock.mockResolvedValue(EXTRACTED_PATH);
  });
  afterEach(() => warn.mockRestore());

  it('хеш не совпал — отказ с понятной причиной, браузер не распаковывается и не запускается', async () => {
    process.env.CHROMIUM_PACK_SHA256 = SHA;
    verifyMock.mockResolvedValue({
      ok: false,
      diagnostic: 'архив Chromium не прошёл проверку SHA-256 (…)',
    });
    const plan = await resolveHeadlessBrowserLaunchPlan();
    assertUnavailable(plan);
    expect(plan.diagnostic).toContain('SHA-256');
    expect(verifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ expectedSha256: SHA, destDir: PACK_DIR }),
    );
    expect(executablePathMock).not.toHaveBeenCalled();
    const launched = await launchHeadlessBrowser();
    assertLaunchError(launched);
    expect(launchMock).not.toHaveBeenCalled();
  });

  it('хеш совпал — библиотеке отдаётся проверенная папка, а не URL', async () => {
    process.env.CHROMIUM_PACK_SHA256 = SHA.toUpperCase();
    verifyMock.mockResolvedValue({ ok: true, sha256: SHA, files: 4 });
    const plan = await resolveHeadlessBrowserLaunchPlan();
    assertReady(plan);
    expect(verifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ expectedSha256: SHA }),
    );
    expect(executablePathMock).toHaveBeenCalledWith(PACK_DIR);
    expect(warn).not.toHaveBeenCalled();
  });

  it('хеш задан неверно — отказ, а не молчаливый пропуск проверки', async () => {
    process.env.CHROMIUM_PACK_SHA256 = 'не-хеш';
    const plan = await resolveHeadlessBrowserLaunchPlan();
    assertUnavailable(plan);
    expect(plan.diagnostic).toContain('CHROMIUM_PACK_SHA256 задан неверно');
    expect(verifyMock).not.toHaveBeenCalled();
    expect(executablePathMock).not.toHaveBeenCalled();
  });

  it('хеш не задан — как раньше (URL), предупреждение в лог один раз за инстанс', async () => {
    // Первый план проваливается после проверки архива (распаковка упала)…
    executablePathMock.mockRejectedValueOnce(new Error('распаковка'));
    const first = await resolveHeadlessBrowserLaunchPlan();
    expect(first.kind).toBe('unavailable');
    expect(executablePathMock).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/github\.com\/Sparticuz\//),
    );
    // …и после паузы неудачи строится заново — предупреждение не повторяется.
    const t0 = Date.now();
    const now = jest.spyOn(Date, 'now').mockReturnValue(t0 + 11 * 60 * 1000);
    try {
      const second = await resolveHeadlessBrowserLaunchPlan();
      assertReady(second);
    } finally {
      now.mockRestore();
    }
    expect(executablePathMock).toHaveBeenCalledTimes(2);
    expect(verifyMock).not.toHaveBeenCalled();
    const shaWarnings = warn.mock.calls.filter((c) =>
      String(c[0]).includes('CHROMIUM_PACK_SHA256 не задан'),
    );
    expect(shaWarnings).toHaveLength(1);
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

  /**
   * Граница на сам запуск — правка 29.09.2026, и оба теста здесь про
   * её цену, а не про неё саму.
   */
  it('запуск не уложился в срок — ошибка, а не зависание', async () => {
    // До этой границы `puppeteer.launch` не был обёрнут ничем: вызов
    // уходил в потолок функции, и наружу не попадало ни причины, ни
    // строки в журнале.
    process.env.PUPPETEER_EXECUTABLE_PATH = '/usr/bin/chromium';
    jest.useFakeTimers();
    try {
      launchMock.mockReturnValue(new Promise(() => {}));
      const pending = launchHeadlessBrowser();
      await jest.advanceTimersByTimeAsync(31_000);
      const result = await pending;
      assertLaunchError(result);
      expect(result.error).toContain('не уложился');
    } finally {
      jest.useRealTimers();
    }
  });

  it('опоздавший браузер ЗАКРЫВАЕТСЯ, а не остаётся висеть', async () => {
    // `withTimeout` — это `Promise.race`, запуск он не отменяет.
    // Chromium, поднявшийся после срока, никому не нужен, и не
    // закрыть его значит вылечить зависание ценой утечки процесса:
    // незакрытый браузер держит память инстанса до его смерти.
    process.env.PUPPETEER_EXECUTABLE_PATH = '/usr/bin/chromium';
    jest.useFakeTimers();
    try {
      const close = jest.fn().mockResolvedValue(undefined);
      let settle: (b: unknown) => void = () => {};
      launchMock.mockReturnValue(
        new Promise((resolve) => {
          settle = resolve;
        }),
      );
      const pending = launchHeadlessBrowser();
      await jest.advanceTimersByTimeAsync(31_000);
      assertLaunchError(await pending);
      // Браузер поднялся с опозданием.
      settle({ close });
      await Promise.resolve();
      await Promise.resolve();
      expect(close).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('успешный запуск НЕ закрывается — его отдали вызывающему', async () => {
    // Обратная сторона той же правки: уборка не должна срабатывать на
    // штатном пути, иначе раннер получит уже закрытый браузер.
    process.env.PUPPETEER_EXECUTABLE_PATH = '/usr/bin/chromium';
    const close = jest.fn();
    launchMock.mockResolvedValue({ close });

    const result = await launchHeadlessBrowser();

    expect('browser' in result).toBe(true);
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
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

describe('launchArgs — чужой сайт (Ш0.3)', () => {
  const planArgs = [
    '--single-process',
    '--disable-web-security',
    '--allow-running-insecure-content',
    '--disable-site-isolation-trials',
    '--no-sandbox',
  ];

  it('без опций план не трогается', () => {
    expect(launchArgs(planArgs)).toEqual(planArgs);
  });

  it('untrustedContent снимает флаги, ослабляющие same-origin policy', () => {
    const args = launchArgs(planArgs, { untrustedContent: true });
    for (const weak of UNTRUSTED_STRIPPED_ARGS) {
      expect(args).not.toContain(weak);
    }
    expect(args).toEqual(['--single-process', '--no-sandbox']);
  });

  it('extraArgs дописываются в конец (прокси)', () => {
    expect(
      launchArgs(['--a'], { extraArgs: ['--proxy-server=http://127.0.0.1:1'] }),
    ).toEqual(['--a', '--proxy-server=http://127.0.0.1:1']);
  });

  it('launchHeadlessBrowser передаёт итоговые флаги в puppeteer.launch', async () => {
    process.env.PUPPETEER_EXECUTABLE_PATH = '/usr/bin/chromium';
    launchMock.mockResolvedValue({ close: jest.fn() });
    await launchHeadlessBrowser({
      untrustedContent: true,
      extraArgs: ['--proxy-server=http://127.0.0.1:9'],
    });
    const args = launchMock.mock.calls[0][0].args as string[];
    expect(args[args.length - 1]).toBe('--proxy-server=http://127.0.0.1:9');
  });
});
