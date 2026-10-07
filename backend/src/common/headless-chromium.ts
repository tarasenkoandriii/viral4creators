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
 * Версия прибита гвоздями: URL архива содержит версию, а сам Chromium
 * должен совпадать с протоколом `puppeteer-core`. До 02.10.2026 здесь
 * стоял 127.0.0 (июль 2024) при `puppeteer-core` 23.x — браузер с
 * десятками опубликованных RCE V8, исполняющий JS чужих сайтов прямо в
 * функции бэкенда со всеми её секретами (риск К-2 аудита
 * docs-tz/AUDIT-Merge-Assistant-Tutorial-QA-2026-10-02.md, шаг Ш0.4).
 * Теперь — 153.0.0 и `puppeteer-core` ~25.11 (его `revisions.chrome` —
 * 153.0.8010.36; 25.12 уже ждёт 154, поэтому тильда, а не крышка).
 *
 * Оба пакета начиная с этих версий — только ESM. Бэкенд собирается в
 * CommonJS, и `await import()` здесь компилируется в `require()`: Node
 * 22.12+ и 24 (рантайм проекта — `engines.node: 24.x`) грузят ESM без
 * верхнеуровневого `await` через `require` штатно. В jest оба модуля
 * всегда подменяются (`jest.mock`), настоящий браузер в CI не
 * поднимается.
 *
 * С 2025 года архив раскладывается по архитектуре
 * (`chromium-v<версия>-pack.x64.tar`), а свойства `headless` у пакета
 * больше нет: он поддерживает только `chrome-headless-shell`, и режим
 * — `'shell'`.
 */

import { Logger } from '@nestjs/common';

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
  'https://github.com/Sparticuz/chromium/releases/download/v153.0.0/chromium-v153.0.0-pack.x64.tar';

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

/**
 * Потолок на САМ запуск браузера (29.09.2026).
 *
 * До этой границы ограничено было только СКАЧИВАНИЕ Chromium
 * (`CHROMIUM_DOWNLOAD_TIMEOUT_MS`), а `puppeteer.launch` не обёрнут
 * ничем — при том, что сообщение об ошибке парой строк ниже само
 * упоминает SIGKILL и нехватку памяти, то есть этот режим отказа был
 * известен. Зависший запуск давал не ошибку, а смерть функции: вызов
 * уходил в потолок платформы, и наружу не попадало ни причины, ни
 * строки в журнале.
 *
 * Граница касается всех четырёх съёмщиков разом — они зовут эту
 * функцию, — и входит в их арифметику потолка. Именно поэтому она
 * невелика: штатный запуск идёт секунды, и тридцати достаточно с
 * запасом, а каждая лишняя секунда здесь отнимается у полезной работы
 * тика.
 */
export const LAUNCH_TIMEOUT_MS = 30_000;

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
/** П-Г3: «хеш не задан» — в лог один раз за инстанс. */
let warnedNoPackSha = false;
const packLogger = new Logger('HeadlessChromium');

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
 * Флаги serverless-сборки, которые ослабляют сам браузер, а не помогают
 * ему уместиться в Lambda (`@sparticuz/chromium-min` ставит их всем
 * подряд). Для СВОИХ страниц (обход TMA, og-картинки своего блога) это
 * безразлично; для чужого сайта — нет: `--disable-web-security`
 * выключает same-origin policy, и страница заказчика (или того, кто
 * выдал себя за него) читала бы ответы других сайтов из-под нашего
 * браузера. Снимаются при `untrustedContent` (Ш0.3).
 */
export const UNTRUSTED_STRIPPED_ARGS: readonly string[] = [
  '--disable-web-security',
  '--allow-running-insecure-content',
  '--disable-site-isolation-trials',
];

export interface HeadlessLaunchOptions {
  /** Дополнительные флаги — например, `--proxy-server` фильтрующего
   * прокси (`common/egress-filter-proxy.ts`). */
  extraArgs?: readonly string[];
  /** Браузер откроет ЧУЖОЙ сайт — снять `UNTRUSTED_STRIPPED_ARGS`. */
  untrustedContent?: boolean;
}

/** Итоговые флаги запуска: план + опции. Экспорт — для тестов. */
export function launchArgs(
  planArgs: readonly string[],
  options: HeadlessLaunchOptions = {},
): string[] {
  const base = options.untrustedContent
    ? planArgs.filter((a) => !UNTRUSTED_STRIPPED_ARGS.includes(a))
    : [...planArgs];
  return [...base, ...(options.extraArgs ?? [])];
}

/**
 * Удобный вход для вызывающих, которым не нужна сама схема плана —
 * сразу готовый `puppeteer-core` `Browser`. Вызывающий обязан сам
 * закрыть браузер (`browser.close()`) — этот модуль инстансы не
 * отслеживает и не переиспользует между вызовами, только план запуска.
 */
export async function launchHeadlessBrowser(
  options: HeadlessLaunchOptions = {},
): Promise<{ browser: import('puppeteer-core').Browser } | { error: string }> {
  const plan = await resolveHeadlessBrowserLaunchPlan();
  if (plan.kind === 'unavailable') return { error: plan.diagnostic };
  const args = launchArgs(plan.args, options);

  // Запуск и его ожидание — РАЗНЫЕ вещи, и здесь это важно.
  // `withTimeout` устроен как `Promise.race` и запуск не отменяет:
  // Chromium, поднявшийся на тридцать первой секунде, просто окажется
  // никому не нужным. Не закрыть его значило бы вылечить зависание
  // ценой утечки процесса — а незакрытый Chromium держит память
  // инстанса до его смерти (об этом же доккомментарий `inFreshBrowser`
  // у разведчика чужой страницы). Поэтому ссылка на запуск живёт
  // отдельно от гонки, и опоздавший браузер закрывается сам.
  //
  // Найдено аудитом собственной правки 29.09.2026: первая редакция
  // границы этого не делала.
  let handedOver = false;
  let launching: Promise<import('puppeteer-core').Browser> | null = null;
  try {
    const puppeteer = await import('puppeteer-core');
    launching = puppeteer.launch({
      executablePath: plan.executablePath,
      headless: plan.headless,
      args,
    });
    const browser = await withTimeout(
      launching,
      LAUNCH_TIMEOUT_MS,
      `запуск браузера не уложился в ${Math.round(LAUNCH_TIMEOUT_MS / 1000)}с`,
    );
    handedOver = true;
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
  } finally {
    // `.catch` обязателен: если запуск провалился по-настоящему,
    // `launching` уже отклонён, и без него здесь появился бы
    // необработанный reject поверх честно возвращённой ошибки.
    if (!handedOver && launching) {
      void launching.then((b) => b.close()).catch(() => undefined);
    }
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
  let haveLocalPack = (await fileSizeOrZero(`${packDir}/chromium.br`)) > 0;

  if (!haveLocalPack) {
    const precheck = await packUrlLooksLikeTar(packUrl);
    if (!precheck.ok) {
      return {
        kind: 'unavailable',
        diagnostic: `архив Chromium недоступен (${packUrl}): ${precheck.reason}`,
      };
    }
    // П-Г3: проверка SHA-256 скачанного архива (`chromium-pack-verify.ts`).
    // Задан хеш — качаем сами, сверяем и распаковываем в packDir; дальше
    // библиотеке отдаётся папка. Несовпадение — отказ без запуска.
    const verify = await import('./chromium-pack-verify');
    const expected = verify.expectedPackSha256(process.env);
    if (expected.kind === 'invalid') {
      return {
        kind: 'unavailable',
        diagnostic: `${verify.PACK_SHA256_ENV} задан неверно (нужны 64 hex-символа SHA-256 архива) — браузер не запускается`,
      };
    }
    if (expected.kind === 'sha256') {
      const v = await verify.downloadVerifiedPack({
        url: packUrl,
        expectedSha256: expected.value,
        destDir: packDir,
        timeoutMs: CHROMIUM_DOWNLOAD_TIMEOUT_MS,
      });
      if (!v.ok) return { kind: 'unavailable', diagnostic: v.diagnostic };
      haveLocalPack = true;
    } else if (!warnedNoPackSha) {
      // Один раз за инстанс: прод без хеша работает как раньше.
      warnedNoPackSha = true;
      packLogger.warn(
        `${verify.PACK_SHA256_ENV} не задан — архив Chromium (${packUrl}) запускается без проверки SHA-256`,
      );
    }
  }

  try {
    const mod: unknown = await import('@sparticuz/chromium-min');
    // Пакет ESM (`export default Chromium`): через `require(esm)` он
    // приезжает пространством имён с `.default`, а подменённый в тестах —
    // самим объектом. Берём то, что есть.
    const chromium = ((mod as { default?: unknown }).default ??
      mod) as typeof import('@sparticuz/chromium-min').default;

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
      // У пакета ≥ 132 свойства `headless` нет: поддерживается только
      // `chrome-headless-shell` (флаг `--headless='shell'` уже в `args`).
      headless: 'shell',
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
  warnedNoPackSha = false;
}
