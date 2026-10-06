/**
 * `<meta name="app-build">` в собранном `index.html` (заход 1 после
 * аудита кронов обучалки, 06.10.2026).
 *
 * Читает его съёмка обучалки: исполнитель открывает мини-апп в
 * безголовом браузере, берёт `content` и пишет его в
 * `TutorialVideoAsset.captureBuild` — по нему оператор видит, какой
 * версией интерфейса снят ролик и не устарел ли он. Поэтому значение —
 * коммит, а не штамп с датой (`__APP_BUILD__`, `src/lib/build-info.ts`):
 * сверяют его с `git log`, а не сортируют.
 *
 * Чистые функции без `process` и без импорта `vite`: их проверяет
 * `scripts/app-build-meta.test.ts`, а подключает `vite.config.ts`.
 */

/** Семь символов — как `git log --oneline` и штамп `__APP_BUILD__`. */
export const APP_BUILD_SHA_LENGTH = 7;

/** Значение вне Vercel (локальная сборка, docker, dev-сервер). */
export const APP_BUILD_DEV = 'dev';

/** Заглушка в `index.html`, которую подменяет сборка. */
export const APP_BUILD_PLACEHOLDER = '__APP_BUILD_META__';

/**
 * Версия для meta: первые семь символов `VERCEL_GIT_COMMIT_SHA`, если
 * это похоже на коммит, иначе `dev`. Строка «undefined» (переменная,
 * подставленная шаблоном) и обрывки короче семи символов — тоже `dev`:
 * обрезанная «undefi» выглядела бы как настоящая версия.
 */
export function appBuildVersion(env: {
  VERCEL_GIT_COMMIT_SHA?: string;
}): string {
  const sha = (env.VERCEL_GIT_COMMIT_SHA ?? '').trim();
  return /^[0-9a-f]{7,40}$/i.test(sha)
    ? sha.slice(0, APP_BUILD_SHA_LENGTH).toLowerCase()
    : APP_BUILD_DEV;
}

/**
 * Подставить версию в `index.html`. Заглушки нет — исключение, а не
 * тихая сборка без meta: без неё съёмка молча писала бы `captureBuild =
 * null`, и «не знаем версию» выглядело бы как «старый ролик».
 */
export function injectAppBuildMeta(html: string, version: string): string {
  if (!html.includes(APP_BUILD_PLACEHOLDER)) {
    throw new Error(
      `index.html: нет заглушки ${APP_BUILD_PLACEHOLDER} для <meta name="app-build">`
    );
  }
  return html.split(APP_BUILD_PLACEHOLDER).join(version);
}
