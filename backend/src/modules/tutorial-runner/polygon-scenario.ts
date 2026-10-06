/**
 * Сценарный путь раннера на демо-витрине `/qa/demo-shop` — для семейства
 * `site-tutorial-demo-*` (решение владельца 06.10.2026, путь А;
 * `doc/TUTORIAL-LANDING-DEMO-SCENARIO-DRAFT.md`, план 5.1).
 *
 * Здесь — только правила, без Prisma и браузера: куда сценарию семейства
 * можно ходить (резолвер маршрута) и что в нём можно написать
 * (валидация шагов). Исполнение — `TutorialScenarioRunnerService`
 * (`runPolygonScenarios`), создание строк — сид
 * (`site-tutorial-demo-seed.ts`).
 *
 * ## Граница безопасности та же, что у словаря примитивов
 *
 * Шаг сценария не несёт URL: `goto.route` — ИМЯ из закрытой таблицы
 * `POLYGON_ROUTES`, а хост берётся из окружения (`LANDING_PUBLIC_URL`,
 * только https и без учётных данных). Три замка подряд:
 *
 *  1. имя — собственный ключ таблицы (не `__proto__`, не произвольная
 *     строка);
 *  2. путь из таблицы начинается с `/qa/` (служебный раздел лендинга,
 *     закрытый от индексации);
 *  3. собранный адрес разбирается заново и сличается по origin с
 *     полигоном — склейка строк не может увести на другой хост.
 *
 * ## Чем валидация семейства отличается от TMA
 *
 * Селекторы — только `[data-qa="…"]` из `DEMO_SHOP_HOOKS` (контракт со
 * страницей витрины), а не из каталога хуков TMA (`qa-hooks.ts`).
 * `triggerPaidOperation` запрещён целиком: на витрине нечего оплачивать,
 * и объявление платы в демо-сценарии — ошибка, а не пометка. Первый шаг
 * — `goto`: без него браузер стоит на `about:blank`, и сценарий упал бы
 * ночью на первом же селекторе.
 */

import {
  DEMO_SHOP_READY_SELECTOR,
  DemoShopHook,
  isDemoShopHook,
  POLYGON_PATH_PREFIX,
  POLYGON_ROUTES,
  PolygonRouteName,
} from './polygon-catalog';
import {
  ParseScenarioResult,
  parseScenarioSteps,
} from '../tutorial-scenario/scenario-steps';
import type { ScenarioPage } from './scenario-runner';
import {
  isSiteTutorialDemoFamilyKey,
  isSiteTutorialDemoKey,
} from '../tutorial-help/site-tutorial-demo';

/** Переменная окружения с публичным адресом лендинга — та же, что у
 *  рассылки и синхронизации базы знаний. Отдельной не заводим: полигон
 *  живёт на том же лендинге (`landing/src/app/qa/`). */
export const POLYGON_ORIGIN_ENV = 'LANDING_PUBLIC_URL';

/**
 * Origin полигона из окружения, или `null` — съёмка семейства тогда не
 * идёт вовсе. Только `https:` и без `user:pass@`: адрес уходит в
 * headless-браузер, и `http://` или учётные данные в нём — это либо
 * ошибка настройки, либо попытка увести съёмку туда, где её можно
 * подменить. Путь в переменной допустим (`https://site/ru`) и
 * отбрасывается: маршрут полигона абсолютный.
 */
export function polygonOrigin(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env[POLYGON_ORIGIN_ENV]?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    if (!u.hostname) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** Имя маршрута полигона — собственный ключ таблицы, не из прототипа
 *  (`__proto__`, `constructor` и т. п. маршрутами не становятся). */
function isPolygonRouteName(name: string): name is PolygonRouteName {
  return Object.prototype.hasOwnProperty.call(POLYGON_ROUTES, name);
}

/** Локаль в `?lang=` — только короткий код, как у остальных локалей
 *  продукта; всё прочее в адрес не попадает. */
const LOCALE_SHAPE = /^[a-z]{2}$/;

export type PolygonRouteResolution =
  | { ok: true; url: string }
  | { ok: false; reason: string };

/**
 * Имя маршрута → адрес на полигоне (`<origin>/qa/…?lang=<locale>`).
 * Отказ — с причиной: её увидит оператор в `lastRunError`.
 */
export function resolvePolygonRoute(
  routeName: string,
  origin: string,
  locale: string,
): PolygonRouteResolution {
  if (!isPolygonRouteName(routeName)) {
    return {
      ok: false,
      reason: `маршрута «${routeName}» нет в таблице полигона (POLYGON_ROUTES)`,
    };
  }
  const path: string = POLYGON_ROUTES[routeName];
  if (!path.startsWith(POLYGON_PATH_PREFIX)) {
    return {
      ok: false,
      reason: `маршрут «${routeName}» ведёт не под ${POLYGON_PATH_PREFIX}`,
    };
  }
  if (!LOCALE_SHAPE.test(locale)) {
    return { ok: false, reason: `локаль «${locale}» не годится для адреса` };
  }
  let base: URL;
  try {
    base = new URL(origin);
  } catch {
    return { ok: false, reason: 'origin полигона не разбирается' };
  }
  if (base.protocol !== 'https:' || base.origin !== origin) {
    return { ok: false, reason: 'origin полигона — не https-origin' };
  }
  const url = new URL(path, base);
  url.searchParams.set('lang', locale);
  // Сличение уже СОБРАННОГО адреса: путь вида `//evil.example/qa/`
  // склеился бы в чужой хост, и проверка префикса строки его не видит.
  if (url.origin !== base.origin || !url.pathname.startsWith('/qa/')) {
    return { ok: false, reason: 'адрес ушёл с полигона' };
  }
  return { ok: true, url: url.toString() };
}

/** Тот же вид селектора, что у каталога TMA, — `[data-qa="id"]`. */
const SELECTOR_SHAPE = /^\[data-qa="([a-z0-9-]+)"\]$/;

/** Элемент витрины из селектора, или `null` — селектор не того вида
 *  или элемента нет в каталоге. */
export function demoShopHookOf(selector: string): DemoShopHook | null {
  const id = SELECTOR_SHAPE.exec(selector.trim())?.[1];
  return id && isDemoShopHook(id) ? id : null;
}

/** Селектор элемента витрины — для сида и тестов. */
export function demoShopSelector(id: DemoShopHook): string {
  return `[data-qa="${id}"]`;
}

function refuse(reason: string): ParseScenarioResult {
  return {
    ok: false,
    steps: [],
    reason,
    droppedNarrations: [],
    droppedPaidOperations: [],
  };
}

/**
 * Полная проверка шагов семейства демо обучающего лендинга.
 *
 * Разбор структуры и реплик — общий (`parseScenarioSteps`): словарь
 * примитивов один, и правила реплик (одна строка, до 220 символов) те
 * же — их читает та же озвучка. Отличие — в том, КУДА шаги ведут.
 */
export function validatePolygonScenarioSteps(
  rawSteps: unknown,
  subjectKey: string,
): ParseScenarioResult {
  if (!isSiteTutorialDemoKey(subjectKey)) {
    return refuse(
      isSiteTutorialDemoFamilyKey(subjectKey)
        ? `слота «${subjectKey}» у демо обучающего лендинга нет`
        : `тема «${subjectKey}» — не из семейства демо обучающего лендинга`,
    );
  }
  const parsed = parseScenarioSteps(rawSteps);
  if (!parsed.ok) return parsed;
  const steps = parsed.steps;
  if (steps[0]?.kind !== 'goto') {
    return refuse(
      'шаг 1: сценарий витрины начинается с goto — до него браузер стоит на пустой странице',
    );
  }
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const n = i + 1;
    if (step.kind === 'triggerPaidOperation') {
      return refuse(
        `шаг ${n}: triggerPaidOperation в демо витрины запрещён — платить там не за что`,
      );
    }
    if (step.kind === 'goto') {
      if (!isPolygonRouteName(step.route)) {
        return refuse(
          `шаг ${n} (goto): маршрута «${step.route}» нет на полигоне — допустимы ${Object.keys(POLYGON_ROUTES).join(', ')}`,
        );
      }
      if (!POLYGON_ROUTES[step.route].startsWith(POLYGON_PATH_PREFIX)) {
        return refuse(
          `шаг ${n} (goto): маршрут «${step.route}» ведёт не под ${POLYGON_PATH_PREFIX}`,
        );
      }
      continue;
    }
    if (demoShopHookOf(step.selector) === null) {
      return refuse(
        `шаг ${n} (${step.kind}): селектор «${step.selector}» не из каталога витрины (DEMO_SHOP_HOOKS, tutorial-runner/polygon-catalog.ts)`,
      );
    }
  }
  return parsed;
}

/** Сколько ждать, пока витрина оживёт после перехода. Страница без сети
 *  и таймеров оживает за доли секунды; десять секунд — потолок на
 *  холодный CDN, а не ожидаемое время. */
export const POLYGON_READY_TIMEOUT_MS = 10_000;

/**
 * Страница для `runScenario`, у которой `goto` дожидается ожившей
 * витрины (`DEMO_SHOP_READY_SELECTOR`). Без этого первый клик мог
 * прийти в серверную разметку до гидратации и пропасть молча: шаг
 * «прошёл», а экран не сменился. Не ожила — шаг `goto` падает с
 * названной причиной, а не следующий шаг таймаутом. Остальное — та же
 * страница: методы вызываются на ней самой.
 */
export function withPolygonReadyWait<P extends ScenarioPage>(page: P): P {
  return new Proxy(page, {
    get(target, prop) {
      if (prop === 'goto') {
        return async (
          url: string,
          options?: { waitUntil?: string; timeout?: number },
        ) => {
          const res = await target.goto(url, options);
          try {
            await target.waitForSelector(DEMO_SHOP_READY_SELECTOR, {
              timeout: POLYGON_READY_TIMEOUT_MS,
            });
          } catch {
            throw new Error(
              `витрина не ожила за ${POLYGON_READY_TIMEOUT_MS / 1000} с (нет data-demo-ready="true") — клики ушли бы в неживую страницу`,
            );
          }
          return res;
        };
      }
      // Получатель — сама страница, а не прокси: у puppeteer `Page`
      // приватные поля (`#…`), и геттер, вызванный на прокси, бросил бы.
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}
