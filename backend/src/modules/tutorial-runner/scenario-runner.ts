/**
 * scenario-runner.ts — интерпретатор шагов сценария (§5 ТЗ
 * doc/TMA-UI-SNAPSHOT-AND-TUTORIAL-VIDEO-SPEC.md, этап 97). Проигрывает
 * `ScenarioStep[]` (словарь примитивов — этап 94,
 * `modules/tutorial-scenario/scenario-steps.types.ts`) против уже
 * открытой страницы headless-браузера — тем же приёмом, что
 * `scenario-steps.ts`: чистая функция без сети/Nest/Prisma, тестируется
 * мок-объектом страницы, без реального Chromium (см. приём
 * `og-image-fetcher.spec.ts`/`headless-chromium.spec.ts`).
 *
 * ## Осознанное сужение объёма (этап 97)
 *
 * Это РЕГРЕССИОННЫЙ прогон, не запись видео (§5 ТЗ предполагает общий
 * драйвер для обеих задач, но видео-захват — Часть Б §4.2 — целиком
 * отложен, см. доккомментарий модуля/«Сделано» в
 * doc/PRODUCT-PROJECT-IMPLEMENTATION-PLAN.md): страница просто
 * проверяется на то, что она доходит до конца сценария без ошибок,
 * скриншоты/видео не снимаются.
 *
 * ## Захват кадров (этап 98) — слайд-шоу, не непрерывная запись
 *
 * §4.2 ТЗ предполагает `Playwright.recordVideo`, но реальная
 * инфраструктура — puppeteer-core без встроенного эквивалента, а живой
 * CDP-скринкаст (`Page.startScreencast`) пришлось бы кодировать в mp4
 * ЛОКАЛЬНО ffmpeg'ом, которого на Vercel Functions нет (см.
 * `postprod/ffmpeg-api.service.ts`). Вместо этого — опциональный
 * параметр `captureFrames`: по одному JPEG-скриншоту ПОСЛЕ каждого
 * успешного шага (не покадрово, не по таймеру), которые вызывающий код
 * (`tutorial-scenario-runner.service.ts`) собирает в слайд-шоу через уже
 * существующий внешний ffmpeg-api — тот же провайдер, что уже кроит и
 * переозвучивает готовые рекламные ролики, не вторая инфраструктура.
 * Честно названо слайд-шоу, а не «видео с непрерывной записью»: дешевле,
 * надёжнее и достаточно для обучающего материала (показать состояние
 * экрана после каждого действия), не полноценный скринкаст с движением
 * курсора.
 *
 * `triggerPaidOperation` при ИСПОЛНЕНИИ — no-op: сценарий мог бы
 * реально нажать кнопку рендера/переозвучки на следующем шаге и
 * потратить настоящие деньги при каждом автоматическом ночном прогоне
 * крона — именно то, ради чего этот шаг вообще декларативный, а не
 * исполняемый (см. доккомментарий `scenario-steps.types.ts`). Сам шаг
 * засчитывается пройденным (это разметка "здесь бы случился платный
 * вызов", а не действие), а следующий за ним `click` — если сценарий
 * это на самом деле пытается кликнуть кнопку рендера — тоже выполнится
 * буквально, то есть страница просто нажмёт кнопку без предоплаченного
 * контекста. Это осознанно НЕ блокируется здесь: сценарии для этого
 * этапа (§4.4 обучалка) в основном описывают экраны ДО самого рендера
 * (заполнение полей, выбор персонажа), а не сам платный клик — если
 * будущий сценарий всё же дойдёт до такого клика, ответственность за
 * это несёт одобряющий оператор (`approved`, §4.11 ТЗ), тот же барьер,
 * что уже есть для прикидки стоимости.
 */

import { ScenarioStep } from '../tutorial-scenario/scenario-steps.types';

/**
 * Минимальный интерфейс страницы, который нужен интерпретатору —
 * подмножество `puppeteer-core` `Page`, не весь тип целиком: реальный
 * `Page` структурно совместим (методы совпадают по имени и сигнатуре),
 * а тесты подставляют простой мок-объект без импорта puppeteer вообще.
 */
export interface ScenarioPage {
  goto(
    url: string,
    options?: { waitUntil?: string; timeout?: number },
  ): Promise<unknown>;
  waitForSelector(
    selector: string,
    options?: { visible?: boolean; timeout?: number },
  ): Promise<unknown>;
  locator(selector: string): ScenarioLocator;
  $eval(
    selector: string,
    fn: (el: Element) => string | null,
  ): Promise<string | null>;
  /** Опционально (этап 98) — нужен только когда вызывающий код просит
   * `captureFrames: true`. Реальный puppeteer `Page.screenshot()`
   * структурно совместим (возвращает `Buffer`/`Uint8Array`); моки в
   * тестах, не собирающие кадры, могут его не реализовывать вовсе. */
  screenshot?(): Promise<Uint8Array>;
}

export interface ScenarioLocator {
  click(): Promise<unknown>;
  fill(value: string): Promise<unknown>;
}

/**
 * Резолвер `route` из шага `goto` в настоящий URL — сам интерпретатор
 * ничего не знает про маршруты конкретного фронтенда (см.
 * `route-templates.ts`, реализующий это для этого продукта).
 */
export type ScenarioRouteResolver = (
  routeName: string,
) => { ok: true; url: string } | { ok: false; reason: string };

export interface ScenarioStepResult {
  index: number;
  step: ScenarioStep;
  ok: boolean;
  error?: string;
}

export interface ScenarioRunResult {
  ok: boolean;
  steps: ScenarioStepResult[];
  /** Индекс первого провалившегося шага (0-based) — undefined, если все прошли. */
  failedAt?: number;
  /** По одному кадру после каждого УСПЕШНОГО шага, только когда вызвано
   * с `captureFrames: true` — иначе всегда пустой массив (этап 98). Может
   * быть короче `steps.length`: неудачный шаг обрывает прогон раньше, а
   * единичный сбой самого скриншота (best-effort, см. `runStep`) просто
   * пропускает этот кадр, не весь прогон. */
  frames: Uint8Array[];
}

/** Таймаут одного шага по умолчанию — тот же порядок величины, что
 * `withTimeout` у og-image-fetcher (20-25с на всю навигацию), но на
 * шаг, не на весь сценарий: до 30 шагов (`MAX_SCENARIO_STEPS`), общий
 * таймаут в 25с на всё уронил бы длинный, но исправный сценарий. */
const DEFAULT_STEP_TIMEOUT_MS = 15_000;

/**
 * Проигрывает шаги по порядку, ОСТАНАВЛИВАЯСЬ на первой ошибке (тот же
 * принцип all-or-nothing, что у валидации при генерации,
 * `scenario-steps.ts`: порядок шагов значим, `click` после `fill`
 * предполагает, что `fill` реально состоялся — продолжать вслепую после
 * провала даёт либо шум из вторичных ошибок, либо, хуже, случайно
 * совпавший "успех" следующего шага на неверном состоянии страницы).
 */
export async function runScenario(
  page: ScenarioPage,
  steps: ScenarioStep[],
  resolveRoute: ScenarioRouteResolver,
  stepTimeoutMs = DEFAULT_STEP_TIMEOUT_MS,
  captureFrames = false,
): Promise<ScenarioRunResult> {
  const results: ScenarioStepResult[] = [];
  const frames: Uint8Array[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    try {
      await runStep(page, step, resolveRoute, stepTimeoutMs);
      results.push({ index: i, step, ok: true });
      if (captureFrames && page.screenshot) {
        // Best-effort: неудачный скриншот (страница в переходном
        // состоянии, редкая гонка CDP) не должен ронять весь регресс-
        // прогон ради необязательного кадра для слайд-шоу.
        try {
          frames.push(await page.screenshot());
        } catch {
          /* пропускаем этот кадр, не весь прогон */
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      results.push({ index: i, step, ok: false, error });
      return { ok: false, steps: results, failedAt: i, frames };
    }
  }
  return { ok: true, steps: results, frames };
}

async function runStep(
  page: ScenarioPage,
  step: ScenarioStep,
  resolveRoute: ScenarioRouteResolver,
  timeoutMs: number,
): Promise<void> {
  switch (step.kind) {
    case 'goto': {
      const resolved = resolveRoute(step.route);
      if (!resolved.ok) {
        throw new Error(`маршрут "${step.route}": ${resolved.reason}`);
      }
      await page.goto(resolved.url, {
        waitUntil: 'networkidle2',
        timeout: timeoutMs,
      });
      return;
    }
    case 'fill':
      // Locators API (puppeteer-core ≥22) — сама ждёт видимости и
      // кликабельности элемента с повтором, в отличие от классического
      // `page.type()`, который бросает немедленно, если элемент ещё не
      // отрисован (частый случай сразу после `goto`/`click` в SPA).
      await page.locator(step.selector).fill(step.value);
      return;
    case 'click':
      await page.locator(step.selector).click();
      return;
    case 'waitFor':
    case 'assertVisible':
      // Оба шага технически делают одно и то же на исполнении —
      // различается только СМЫСЛ в глазах генератора (ждать перед
      // следующим действием vs проверить как регрессионный факт), а не
      // механика. Разделять реализацию незачем.
      await page.waitForSelector(step.selector, {
        visible: true,
        timeout: timeoutMs,
      });
      return;
    case 'assertText': {
      await page.waitForSelector(step.selector, {
        visible: true,
        timeout: timeoutMs,
      });
      const actual = await page.$eval(step.selector, (el) => el.textContent);
      // includes(), не строгое равенство: ожидаемый текст пишет модель
      // по описанию шага обучалки, а не копирует байт-в-байт из
      // реального DOM (пробелы/переносы/обрамляющий текст) — точное
      // совпадение сделало бы шаг хрупким без всякой диагностической
      // пользы.
      if (!actual || !actual.includes(step.value)) {
        throw new Error(
          `ожидали текст, содержащий "${step.value}", в ${step.selector} — нашли ${JSON.stringify(actual)}`,
        );
      }
      return;
    }
    case 'triggerPaidOperation':
      // См. доккомментарий файла — декларативный маркер, не действие.
      return;
    default:
      // Недостижимо при исчерпывающем ScenarioStep — защита на случай
      // расширения словаря без обновления этого файла.
      throw new Error(
        `неизвестный тип шага: ${(step as { kind: string }).kind}`,
      );
  }
}
