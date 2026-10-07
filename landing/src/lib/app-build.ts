/**
 * `<meta name="app-build">` служебных страниц лендинга (`/qa/*`) — коммит
 * сборки для съёмки обучалки (TODO «демо обучающего лендинга», хвост
 * `captureBuild`, 07.10.2026).
 *
 * Сценарный путь раннера снимает витрину демо-магазина (`/qa/*`) и читает
 * `content` этого тега (`readCaptureBuild` в
 * `backend/src/modules/tutorial-runner/tutorial-scenario-runner.service.ts`),
 * записывая `captureBuild = "landing:<версия>"`. Без тега у роликов витрины
 * было `null`, и оператор не видел, какой версией витрины снят ролик.
 *
 * Правило то же, что у мини-аппа (`frontend/app-build-meta.ts`): первые
 * семь символов `VERCEL_GIT_COMMIT_SHA`, если это похоже на коммит, иначе
 * `dev` — обрывок «undefi» не должен выглядеть настоящей версией. Копия, а
 * не импорт: лендинг не тянет код фронтенда в свою сборку; совпадение
 * правил держит `scripts/app-build.test.ts`.
 */

export const APP_BUILD_SHA_LENGTH = 7;
export const APP_BUILD_DEV = 'dev';

export function appBuildVersion(env: {
  VERCEL_GIT_COMMIT_SHA?: string;
}): string {
  const sha = (env.VERCEL_GIT_COMMIT_SHA ?? '').trim();
  return /^[0-9a-f]{7,40}$/i.test(sha)
    ? sha.slice(0, APP_BUILD_SHA_LENGTH).toLowerCase()
    : APP_BUILD_DEV;
}

/**
 * Поле `other` метаданных Next: `{ 'app-build': '<версия>' }` рисуется как
 * `<meta name="app-build" content="<версия>">`. Переменная читается ЯВНО по
 * имени — так её видит и сборка, и серверный рендер.
 */
export function appBuildMetaOther(): { 'app-build': string } {
  return {
    'app-build': appBuildVersion({
      VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA,
    }),
  };
}
