/**
 * headless-chromium.ts — запуск headless Chromium на serverless (Vercel)
 * без раздувания деплоя, портировано из Solar Shop
 * (`apps/api/src/common/og-image-fetcher.ts`, аудиты 29–30.08.2026).
 *
 * Намеренно вынесено в СВОЙ файл, отдельно от `og-image-fetcher.ts`,
 * который был единственным вызывающим в оригинале: по прямому запросу
 * владельца продукта этот загрузчик браузера — общая инфраструктура,
 * не привязанная к парсингу og:image, и должна быть пригодна и для
 * будущего исполнителя сценариев обучающих видео (§5
 * doc/TMA-UI-SNAPSHOT-AND-TUTORIAL-VIDEO-SPEC.md, этап 94 оставил его
 * нереализованным именно из-за отсутствия такой инфраструктуры). Этот
 * файл её и есть: `resolveHeadlessBrowserLaunchPlan()`/
 * `launchHeadlessBrowser()` не знают ничего про картинки, RSS или блог —
 * только как поднять Chromium на Vercel.
 *
 * Берётся `@sparticuz/chromium-min`, а НЕ полный `@sparticuz/chromium`:
 * полный пакет распаковывается в ~70 МБ и едет в бандл функции, а лимит
 * Vercel — 250 МБ на функцию вместе с NestJS и движками Prisma.
 * `-min` весит 46 КБ и тянет бинарник в /tmp при первом вызове — размер
 * деплоя не меняется вовсе.
 *
 * Версия прибита гвоздями (127.0.0): URL архива содержит версию, а сам
 * Chromium должен совпадать с протоколом `puppeteer-core`. В проекте
 * `puppeteer-core` 23.x — тот ездит на Chrome 127, не на более свежий
 * (тот рассчитан на `puppeteer-core` 25.x).
 */

// Флаги для системного Chromium в Docker-образе (если он когда-либо
// понадобится локально — на Vercel этой ветки не будет).
const DOCKER_CHROMIUM_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--js-flags=--max-old-space-size=256',
];

const DEFAULT_CHROMIUM_PACK_URL =
  'https://github.com/Sparticuz/chromium/releases/download/v127.0.0/chromium-v127.0.0-pack.tar';

// Замеренные, не угаданные цифры (тот же прогон, что в оригинале):
// загрузка+распаковка — около 3с один раз на инстанс, /tmp после
// распаковки — 178 МБ (лимит Vercel — 512 МБ), пиковый RSS на простой
// странице — 240 МБ.
const CHROMIUM_DOWNLOAD_TIMEOUT_MS = 60_000;

/** Минимальный правдоподобный размер распакованного бинарника (реальный — 178 МБ). */
const MIN_CHROMIUM_BINARY_BYTES = 100 * 1024 * 1024;
const EXTRACTED_CHROMIUM_PATH = '/tmp/chromium';

/**
 * Сколько не повторять неудачную попытку поднять браузер. Без этого
 * прогон по десятку кандидатов с недоступным архивом платил бы таймаут
 * загрузки на каждом.
 */
const LAUNCH_FAILURE_COOLDOWN_MS = 10 * 60 * 1000;

export type HeadlessBrowserLaunchPlan =
  | {
      kind: 'ready';
      executablePath: string;
      args: string[];
      headless: true | 'shell';
      source: string;
    }
  | { kind: 'unavailable'; diagnostic: string };

// Один резолвер на инстанс, а не на вызов — та же причина, что в
// оригинале: параллельность (Vercel исполняет несколько запросов на
// одном инстансе) и стоимость повтора (без памяти о результате каждый
// кандидат заново платил бы за загрузку).
let launchPlanPromise: Promise<HeadlessBrowserLaunchPlan> | null = null;
let launchPlanFailedAt = 0;

export function resolveHeadlessBrowserLaunchPlan(): Promise<HeadlessBrowserLaunchPlan> {
  // Найдено при написании тестов на этот порт (в оригинале Solar Shop —
  // та же формула, без охраны `> 0`): `0` — сентинел "неудачи не было",
  // но `Date.now() - 0` в миллисекундах от эпохи всегда огромен и
  // проходит порог `LAUNCH_FAILURE_COOLDOWN_MS`, поэтому БЕЗ охраны
  // условие истинно сразу после первого успешного билда (и даже для
  // второго вызова в той же синхронной пачке параллельных вызовов,
  // из-за которых кэш вообще заводился) — план тут же сбрасывался и
  // пересобирался заново, сводя дедупликацию на нет ровно в том
  // единственном случае, ради которого она задумана. Охрана `> 0`
  // делает cooldown применимым только к РЕАЛЬНОЙ неудаче (которая
  // всегда пишет настоящий `Date.now()`), а успешный план кэшируется на
  // весь срок жизни тёплого инстанса — что и требуется: Chromium в
  // /tmp остаётся валидным, пока инстанс жив.
  if (
    launchPlanPromise &&
    launchPlanFailedAt > 0 &&
    Date.now() - launchPlanFailedAt >= LAUNCH_FAILURE_COOLDOWN_MS
  ) {
    launchPlanPromise = null;
  }
  if (!launchPlanPromise) {
    launchPlanPromise = buildBrowserLaunchPlan().then((plan) => {
      if (plan.kind === 'unavailable') launchPlanFailedAt = Date.now();
      else launchPlanFailedAt = 0;
      return plan;
    });
  }
  return launchPlanPromise;
}

/**
 * Удобный вход для вызывающих, которым не нужна сама схема плана —
 * сразу готовый `puppeteer-core` `Browser`. Вызывающий обязан сам
 * закрыть браузер (`browser.close()`) — этот модуль инстансы не
 * отслеживает и не переиспользует между вызовами, только план запуска.
 */
export async function launchHeadlessBrowser(): Promise<
  { browser: import('puppeteer-core').Browser } | { error: string }
> {
  const plan = await resolveHeadlessBrowserLaunchPlan();
  if (plan.kind === 'unavailable') return { error: plan.diagnostic };

  try {
    const puppeteer = await import('puppeteer-core');
    const browser = await puppeteer.launch({
      executablePath: plan.executablePath,
      headless: plan.headless,
      args: plan.args,
    });
    return { browser };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      error: `запуск браузера (${plan.source}) провалился: ${message}${
        /spawn|ENOENT|killed|out of memory|SIGKILL/i.test(message)
          ? ' — похоже на нехватку памяти или отсутствующий бинарник; проверьте лимит памяти функции на Vercel'
          : ''
      }`,
    };
  }
}

async function buildBrowserLaunchPlan(): Promise<HeadlessBrowserLaunchPlan> {
  // Docker-образ: системный Chromium, путь задан в переменной окружения.
  // Проверяется первым — локально качать 65 МБ с GitHub незачем, браузер
  // уже лежит в контейнере.
  const explicit = process.env.PUPPETEER_EXECUTABLE_PATH?.trim();
  if (explicit) {
    return {
      kind: 'ready',
      executablePath: explicit,
      args: DOCKER_CHROMIUM_ARGS,
      headless: true,
      source: 'системный Chromium (PUPPETEER_EXECUTABLE_PATH)',
    };
  }

  // `||`, а не `??`: переменная окружения, объявленная в дашборде Vercel
  // и оставленная пустой, — это пустая строка, а не undefined.
  const packUrl =
    process.env.CHROMIUM_PACK_URL?.trim() || DEFAULT_CHROMIUM_PACK_URL;

  // Подсказка про рантайм — то, без чего этот код не работает на Vercel:
  // Chromium тянет свои системные библиотеки (libnss3 и восемь других),
  // но распаковывает их библиотека ТОЛЬКО если считает, что работает в
  // AWS Lambda (по AWS_EXECUTION_ENV/AWS_LAMBDA_JS_RUNTIME) — а Vercel не
  // выставляет ни одной, хотя под капотом это та же Lambda. Ставим
  // подсказку сами, до import — модуль читает эти переменные в теле, на
  // этапе загрузки.
  if (!process.env.AWS_EXECUTION_ENV && !process.env.AWS_LAMBDA_JS_RUNTIME) {
    const nodeMajor = Number(process.versions.node.split('.')[0]);
    process.env.AWS_LAMBDA_JS_RUNTIME =
      nodeMajor >= 20 ? 'nodejs20.x' : 'nodejs18.x';
  }
  const expectedLibDir = process.env.AWS_LAMBDA_JS_RUNTIME?.includes('20.x')
    ? '/tmp/al2023/lib'
    : '/tmp/al2/lib';

  // Если архив уже распакован на этом инстансе — берём папку, а не URL:
  // иначе каждая повторная попытка качала бы 65 МБ заново.
  const packDir = '/tmp/chromium-pack';
  const haveLocalPack = (await fileSizeOrZero(`${packDir}/chromium.br`)) > 0;

  if (!haveLocalPack) {
    const precheck = await packUrlLooksLikeTar(packUrl);
    if (!precheck.ok) {
      return {
        kind: 'unavailable',
        diagnostic: `архив Chromium недоступен (${packUrl}): ${precheck.reason}`,
      };
    }
  }

  try {
    const mod: unknown = await import('@sparticuz/chromium-min');
    // Пакет CJS (`export = Chromium`), поэтому через `await import()` он
    // приезжает то как сам объект, то завёрнутый в `.default`.
    const chromium = ((mod as { default?: unknown }).default ??
      mod) as typeof import('@sparticuz/chromium-min');

    let executablePath = await withTimeout(
      chromium.executablePath(haveLocalPack ? packDir : packUrl),
      CHROMIUM_DOWNLOAD_TIMEOUT_MS,
      `загрузка Chromium не уложилась в ${Math.round(CHROMIUM_DOWNLOAD_TIMEOUT_MS / 1000)}с`,
    );

    // executablePath() возвращает /tmp/chromium сразу, как только ФАЙЛ
    // существует, не распаковывая больше ничего. На тёплом инстансе, где
    // бинарник остался от предыдущего деплоя (без библиотек), это
    // означало бы вечное `libnss3.so: cannot open shared object file`.
    if ((await fileSizeOrZero(`${expectedLibDir}/libnss3.so`)) === 0) {
      await removeQuietly(EXTRACTED_CHROMIUM_PATH);
      executablePath = await withTimeout(
        chromium.executablePath(haveLocalPack ? packDir : packUrl),
        CHROMIUM_DOWNLOAD_TIMEOUT_MS,
        `повторная распаковка Chromium не уложилась в ${Math.round(CHROMIUM_DOWNLOAD_TIMEOUT_MS / 1000)}с`,
      );
      if ((await fileSizeOrZero(`${expectedLibDir}/libnss3.so`)) === 0) {
        return {
          kind: 'unavailable',
          diagnostic: `системные библиотеки Chromium не распаковались в ${expectedLibDir} (ожидался libnss3.so) — без них браузер не стартует`,
        };
      }
    }

    // Библиотека считает бинарник готовым по самому наличию файла, без
    // проверки размера, а распаковывает его потоком — оборванная
    // распаковка оставляет в /tmp более короткий файл, который выглядит
    // «готовым» для всех следующих вызовов на этом инстансе.
    const size = await fileSizeOrZero(executablePath);
    if (size < MIN_CHROMIUM_BINARY_BYTES) {
      await removeQuietly(executablePath);
      return {
        kind: 'unavailable',
        diagnostic: `распакованный Chromium неполный (${Math.round(size / 1e6)} МБ вместо ~178 МБ) — файл удалён, следующая попытка начнёт заново`,
      };
    }

    return {
      kind: 'ready',
      executablePath,
      // `--js-flags=--max-old-space-size=256` здесь намеренно НЕ
      // добавляется, хотя в Docker-ветке он есть: `chromium.args`
      // содержит `--single-process` (обязателен для Lambda), и в одном
      // процессе этот лимит V8 накрывает уже не служебный код браузера,
      // а JavaScript самой страницы.
      args: [...chromium.args],
      headless: chromium.headless,
      source: `@sparticuz/chromium-min (serverless, ${expectedLibDir})`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await removeIfTruncated(EXTRACTED_CHROMIUM_PATH);
    return {
      kind: 'unavailable',
      diagnostic: `headless-браузер недоступен: ${message}`,
    };
  }
}

// Проверка ПЕРЕД тем, как отдать URL библиотеке: `@sparticuz/chromium-
// min` качает архив без проверки статус-кода и без обработчика ошибки
// на потоке распаковки — если по URL придёт не tar, процесс падает
// необработанным исключением целиком, а не отклонённым промисом.
async function packUrlLooksLikeTar(
  packUrl: string,
): Promise<{ ok: boolean; reason: string }> {
  try {
    const { fetchWithRetry } = await import('./fetch-with-retry');
    const res = await fetchWithRetry(packUrl, {
      retries: 1,
      timeoutMs: 15_000,
      headers: { Range: 'bytes=0-511' },
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const head = Buffer.from(await res.arrayBuffer());
    if (head.length < 262)
      return { ok: false, reason: `в ответе лишь ${head.length} байт` };
    const magic = head.subarray(257, 262).toString('latin1');
    if (magic !== 'ustar') {
      return {
        ok: false,
        reason: `это не tar-архив (вместо магии "ustar" — ${JSON.stringify(magic)})`,
      };
    }
    return { ok: true, reason: 'OK' };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

async function fileSizeOrZero(path: string): Promise<number> {
  try {
    const { stat } = await import('node:fs/promises');
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function removeQuietly(path: string): Promise<void> {
  try {
    const { rm } = await import('node:fs/promises');
    await rm(path, { force: true });
  } catch {
    /* уборка — best effort, ошибка здесь не должна подменять настоящую причину */
  }
}

async function removeIfTruncated(path: string): Promise<void> {
  const size = await fileSizeOrZero(path);
  if (size > 0 && size < MIN_CHROMIUM_BINARY_BYTES) await removeQuietly(path);
}

/** Экспортируется — вызывающие (og-image-fetcher, будущий исполнитель сценариев) используют тот же приём для собственных таймаутов (навигация страницы и т.п.). */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * Только для тестов — сбрасывает память резолвера между прогонами
 * (`launchPlanPromise` иначе переживает `jest.resetModules()` не всегда
 * предсказуемо, а тест на "план построился заново после провала"
 * нуждается в чистом состоянии).
 */
export function __resetHeadlessBrowserLaunchPlanForTests(): void {
  launchPlanPromise = null;
  launchPlanFailedAt = 0;
}
