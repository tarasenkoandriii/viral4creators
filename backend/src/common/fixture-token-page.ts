/**
 * Фикстурный токен в headless-браузере — ТОЛЬКО на запросы к своему API
 * (этап I ТЗ docs-tz/TZ-Tutorial-Video-Voiced.md).
 *
 * ## Что было
 *
 * Оба прогона против фикстурного пользователя — сценарии обучалки
 * (`TutorialScenarioRunnerService`) и снимки мастера
 * (`UiSnapshotRunnerService`) — ставили заголовок через
 * `page.setExtraHTTPHeaders({ 'X-Fixture-Token': token })`. CDP
 * `Network.setExtraHTTPHeaders` прикладывает его ко ВСЕМ запросам
 * страницы, а не только к XHR самого SPA. Проверено на том же Chromium
 * 127, что поднимает `headless-chromium.ts`: заголовок получили чужой
 * CSS, чужой скрипт и чужой шрифт. На проде это fonts.googleapis.com,
 * fonts.gstatic.com и telegram.org (`telegram-web-app.js` из
 * `frontend/index.html`), причём снимки мастера ходят туда каждые две
 * минуты. Токен — это вход под фикстурным пользователем, то есть
 * прод-секрет уходил в журналы третьих сторон открытым текстом.
 *
 * ## Что теперь
 *
 * Перехват запросов: заголовок добавляется запросу, чей origin совпадает
 * с origin `API_PUBLIC_URL`, и СНИМАЕТСЯ со всех остальных (на случай,
 * если его выставил кто-то ещё). Проверено там же: GET и POST к API
 * получают токен, документ TMA, CSS, скрипт и шрифт — нет.
 *
 * ## Почему `API_PUBLIC_URL`, а не новая переменная
 *
 * Это уже «публичный адрес ЭТОГО backend» — им собираются OAuth-колбэки,
 * вебхук WayForPay и Resemble. Вторая переменная с тем же смыслом
 * разъехалась бы с первой при первом же переезде.
 *
 * ## Почему отказ, а не заголовок «всем», когда адреса нет
 *
 * Fail-closed, как у самого токена (`fixture-token.ts`): без адреса API
 * отличить свой запрос от чужого нечем, а вернуться к «всем подряд»
 * значит вернуть утечку. Прогон честно пропускается с причиной.
 */

/** Минимум страницы puppeteer, который нужен перехвату. */
export interface FixtureTokenPage {
  setRequestInterception(value: boolean): Promise<void>;
  on(
    event: 'request',
    handler: (request: FixtureTokenRequest) => void,
  ): unknown;
}

export interface FixtureTokenRequest {
  url(): string;
  headers(): Record<string, string>;
  isInterceptResolutionHandled?(): boolean;
  continue(overrides?: { headers?: Record<string, string> }): Promise<void>;
  /** Нужны только `blockMedia`; настоящий puppeteer `HTTPRequest` их имеет. */
  resourceType?(): string;
  abort?(): Promise<void>;
}

export interface AttachFixtureTokenOptions {
  /**
   * Не скачивать `<video>`/`<audio>` (`resourceType() === 'media'`).
   *
   * Разбор счёта Vercel 01.10.2026: главная статья — Blob Data
   * Transfer ($24.67 за цикл при хранении на $0.07). Робот
   * `ui-snapshot-run` открывал экраны с настоящими роликами 720 раз в
   * сутки свежим браузером без кеша, и Chromium буферизовал каждый
   * ролик почти целиком даже при `preload="metadata"` (замер: 25–100 %
   * файла). В сравниваемом кадре содержимое `<video>` и так скрыто —
   * байты качались впустую. Плеер без медиа остаётся на месте и в
   * раскладке.
   */
  blockMedia?: boolean;
}

const HEADER = 'x-fixture-token';

/**
 * Origin API из `API_PUBLIC_URL` (там путь с `/api` на конце —
 * сравнивается только origin) или `null`, если адрес не задан или не
 * разбирается.
 */
export function fixtureApiOrigin(
  env: {
    API_PUBLIC_URL?: string;
    [key: string]: string | undefined;
  } = process.env,
): string | null {
  const raw = env.API_PUBLIC_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Нести ли токен на этот адрес: только на origin API, буква в букву. */
export function carriesFixtureToken(
  requestUrl: string,
  apiOrigin: string,
): boolean {
  try {
    return new URL(requestUrl).origin === apiOrigin;
  } catch {
    // `data:`/`blob:` и прочее без origin — точно не наш API.
    return false;
  }
}

/**
 * Включает перехват и прикладывает токен к запросам на origin API.
 * Вызывать ДО `goto`: первый же XHR SPA уходит раньше, чем вызывающий
 * успеет что-то сделать после навигации.
 */
export async function attachFixtureToken(
  page: FixtureTokenPage,
  token: string,
  apiOrigin: string,
  options: AttachFixtureTokenOptions = {},
): Promise<void> {
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    // Кооперативный перехват: если запрос уже кто-то разрешил, второй
    // `continue` бросил бы и уронил обработчик.
    if (request.isInterceptResolutionHandled?.()) return;
    if (
      options.blockMedia &&
      request.abort &&
      request.resourceType?.() === 'media'
    ) {
      request.abort().catch(() => undefined);
      return;
    }
    const headers = { ...request.headers() };
    delete headers[HEADER];
    if (carriesFixtureToken(request.url(), apiOrigin)) {
      headers[HEADER] = token;
    }
    // Страница могла закрыться посреди запроса — это не ошибка прогона.
    request.continue({ headers }).catch(() => undefined);
  });
}
