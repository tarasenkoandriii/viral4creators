/**
 * Запуск headless Chromium в реле — doc/LIVE-LOGIN-RELAY-SPEC.md §6.
 *
 * НЕ импорт `backend/src/common/headless-chromium.ts` — технически
 * невозможен через границу двух отдельно деплоймых Docker build
 * context'ов (см. §6 того документа). Вместо этого — своя маленькая
 * копия РОВНО той части, которая здесь нужна (Docker-ветка,
 * `PUPPETEER_EXECUTABLE_PATH`, без `@sparticuz/chromium-min`/
 * serverless-ветки, которая реле не касается вообще) и без кэширующего
 * резолвера: та мемоизация в backend'е существует именно под
 * serverless-повторное использование тёплого инстанса, а здесь
 * `PUPPETEER_EXECUTABLE_PATH` статичен с момента старта контейнера.
 */

import puppeteer, { type Browser } from 'puppeteer-core';

// Скопировано построчно из
// backend/src/common/headless-chromium.ts:31-41 — если список
// поменяется там, поменять и здесь (маячок специально оставлен точным
// путём, чтобы grep находил обе копии).
export const DOCKER_CHROMIUM_ARGS = [
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

export async function launchRelayBrowser(
  executablePath: string,
): Promise<Browser> {
  return puppeteer.launch({
    executablePath,
    headless: true,
    args: DOCKER_CHROMIUM_ARGS,
  });
}
