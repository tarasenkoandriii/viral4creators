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
 * параметр `captureFrames`: по одному PNG-скриншоту ПОСЛЕ каждого
 * успешного шага (не покадрово, не по таймеру), которые вызывающий код
 * (`tutorial-scenario-runner.service.ts`) собирает в слайд-шоу через уже
 * существующий внешний ffmpeg-api — тот же провайдер, что уже кроит и
 * переозвучивает готовые рекламные ролики, не вторая инфраструктура.
 * Честно названо слайд-шоу, а не «видео с непрерывной записью»: дешевле,
 * надёжнее и достаточно для обучающего материала (показать состояние
 * экрана после каждого действия), не полноценный скринкаст с движением
 * курсора.
 *
 * ## Платный клик не исполняется — и это ЕДИНСТВЕННОЕ место, где так
 *
 * `triggerPaidOperation` при исполнении — no-op, шаг засчитывается
 * пройденным: это разметка «здесь бы случился платный вызов», а не
 * действие. Вместе с ним пропускается и `click`, идущий СРАЗУ ЗА ним,
 * — то есть ровно тот, ради которого маркер и ставится.
 *
 * До сквозного аудита 29.09.2026 клик исполнялся буквально, и это было
 * записано как осознанное решение с доводом «сценарии этого этапа в
 * основном описывают экраны ДО самого рендера». Довод устарел на этапе
 * I: промпт выводит список платных операций из каталога хуков, там
 * осталась ровно одна (`generation` — кнопка «Сгенерировать рекламный
 * ролик»), а шаг обучалки №8 так и называется «Сгенерируйте видео».
 * То есть промпт теперь ПРОСИТ модель написать `triggerPaidOperation`
 * + `click video-generate`, и правильно написанный сценарий восьмого
 * шага выглядит именно так — на каждой из пяти локалей. Регрессионный
 * прогон идёт КАЖДУЮ ночь; настоящий рендер в нём — расход без
 * потолка и без повторного вопроса человеку (одобрение необратимо).
 * Движок по умолчанию — Grok (`default-video-provider.ts`), то есть
 * ≈$0.64 за восьмисекундный ролик на 480p; на Veo было бы $3.20. Даже
 * меньшая из сумм умножается на пять локалей и на каждую ночь.
 *
 * Доккомментарий `tutorial-scenario-runner.service.ts` всё это время
 * утверждал, что платные сценарии денег на прогоне не тратят. Теперь
 * это правда.
 *
 * Кадр от пропуска не теряется: маркер — успешный шаг, после него
 * снимается кадр, и указатель (этап H) ставится как раз на кнопку
 * СЛЕДУЮЩЕГО клика. То есть экран «палец на кнопке рендера» попадает в
 * ролик, а деньги — нет. Реплика самого пропущенного клика уходит
 * вместе с его кадром, как у любого шага без кадра.
 *
 * Чего это НЕ делает: не мешает снять настоящий рендер один раз для
 * записи. Такой заход — отдельный режим, а не побочный эффект ночного
 * регресса; сегодня его нет, и §8 ТЗ это фиксирует.
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
  /**
   * Опционально (этап H ТЗ `docs-tz/TZ-Tutorial-Video-Voiced.md`) —
   * нужны только указателю клика. `$` — БЕЗ ожидания: элемент ищется
   * ровно в том состоянии страницы, что попало на снимок. Реальный
   * puppeteer `Page` структурно совместим; мок без них просто не даёт
   * указателя.
   */
  $?(selector: string): Promise<ScenarioElement | null>;
  viewport?(): { width: number; height: number } | null;
  /**
   * Опционально — подготовка кадра (`prepareFrame`, 01.10.2026). Реальный
   * puppeteer `Page` структурно совместим; мок без них снимает кадр
   * как раньше, сразу.
   */
  waitForNetworkIdle?(options: {
    idleTime: number;
    timeout: number;
  }): Promise<unknown>;
  waitForFunction?(
    fn: () => boolean,
    options: { timeout: number },
  ): Promise<unknown>;
  evaluate?<A>(fn: (arg: A) => void, arg: A): Promise<unknown>;
}

/** Подмножество puppeteer `ElementHandle`, нужное указателю клика. */
export interface ScenarioElement {
  boundingBox(): Promise<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>;
  /**
   * Необязательно — нужно только быстрому отказу на выключенной
   * кнопке (см. `case 'click'`). Реальный `ElementHandle` puppeteer
   * структурно совместим; мок без него просто не даёт этой проверки, и
   * клик ведёт себя как раньше.
   */
  evaluate?<T>(fn: (el: Element) => T): Promise<T>;
}

/*
 * Размер окна съёмки жил здесь до 29.09.2026 и переехал в
 * `tutorial-video-assembly.ts` — туда, где холст, из которого он
 * выводится. Ре-экспорта тут СОЗНАТЕЛЬНО нет: два пути к одному имени
 * — это два места, где потом заведётся второе определение, а сам этот
 * модуль размером окна не пользуется (координаты указателя он берёт у
 * страницы через `page.viewport()`).
 */

/**
 * Где на снимке элемент, по которому кликнет СЛЕДУЮЩИЙ шаг, — доли
 * ширины и высоты вьюпорта (0…1), центр рамки (этап H).
 *
 * Доли, а не пиксели: снимок снимается с плотностью пикселей
 * вьюпорта, а рисуется на холсте другого размера, и переводить в
 * пиксели холста — дело плана сборки, знающего холст. Округлены до
 * десятитысячных: иначе дробный хвост `boundingBox()` менял бы
 * отпечаток сборки при побайтово том же снимке.
 */
export interface FramePointer {
  x: number;
  y: number;
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
  /** Шаг засчитан пройденным, но НЕ исполнялся: это платный клик за
   * маркером `triggerPaidOperation` (см. доккомментарий файла). */
  skippedAsPaid?: true;
}

/**
 * Снятый кадр вместе с номером шага, ПОСЛЕ которого он снят.
 *
 * Номер шага, а не позиция в массиве, — с этапа A ТЗ
 * `docs-tz/TZ-Tutorial-Video-Voiced.md`. Массив кадров короче массива
 * шагов в трёх штатных случаях сразу: прогон оборвался на ошибке;
 * единичный скриншот не удался (best-effort, см. `runStep`); у
 * страницы вовсе нет `screenshot` (см. `ScenarioPage`) — тогда кадров
 * нет ни одного. Второй случай глотается молча и оставляет ДЫРУ
 * посреди прогона — после чего
 * сопоставление «кадр i ↔ шаг i» врёт для всех последующих кадров, и
 * выглядит это как «реплика написана не к тому экрану», а не как
 * ошибка. С привязкой сопоставление не может разъехаться в принципе:
 * сдвиг некуда спрятать, дыра видна как пропущенный номер.
 */
export interface ScenarioFrame {
  /** 0-based индекс шага в исходном массиве `steps`. */
  stepIndex: number;
  /** PNG. */
  bytes: Uint8Array;
  /**
   * Куда кликнет следующий шаг, если он `click` и его элемент ВИДЕН на
   * этом снимке (этап H). Замер — сразу после снимка и без ожидания: в
   * том же состоянии страницы. Элемента на снимке нет (появится позже,
   * пока локатор клика его ждёт) — указателя нет, а не кружок на пустом
   * месте.
   */
  pointer?: FramePointer;
}

export interface ScenarioRunResult {
  ok: boolean;
  steps: ScenarioStepResult[];
  /** Индекс первого провалившегося шага (0-based) — undefined, если все прошли. */
  failedAt?: number;
  /** Кадры, которые не удалось снять: шаг прошёл, а снимок — нет.
   * Ролик тогда короче сценария, и это обязано быть видно снаружи. */
  skippedFrames: { stepIndex: number; error: string }[];
  /** Номера шагов (0-based), на которых `click` был ПРОПУЩЕН как платный
   * — то есть шёл сразу за `triggerPaidOperation`. Пустой массив у
   * подавляющего большинства сценариев; непустой означает, что ролик
   * показывает экран до нажатия, а не результат (см. доккомментарий
   * файла). Потребитель обязан донести это до оператора: «прошло» и
   * «прошло, но платный шаг не нажимался» — разные исходы. */
  skippedPaidClicks: number[];
  /** По одному кадру после каждого УСПЕШНОГО шага, только когда вызвано
   * с `captureFrames: true` — иначе всегда пустой массив (этап 98). Может
   * быть короче `steps.length` и содержать пропуски в нумерации шагов:
   * неудачный шаг обрывает прогон раньше, а единичный сбой самого
   * скриншота (best-effort, см. `runStep`) просто пропускает этот кадр,
   * не весь прогон. Порядок — по возрастанию `stepIndex`. */
  frames: ScenarioFrame[];
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
  const frames: ScenarioFrame[] = [];
  const skippedPaidClicks: number[] = [];
  const skippedFrames: { stepIndex: number; error: string }[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    // Клик сразу за маркером платной операции не исполняется вовсе —
    // см. доккомментарий файла. Проверка стоит ДО `try`: это не отказ
    // и не ошибка шага, а сознательный пропуск, и он не должен
    // выглядеть как пройденное действие ни в кадрах, ни в счётчиках.
    if (
      step.kind === 'click' &&
      steps[i - 1]?.kind === 'triggerPaidOperation'
    ) {
      skippedPaidClicks.push(i);
      results.push({ index: i, step, ok: true, skippedAsPaid: true });
      continue;
    }
    try {
      await runStep(page, step, resolveRoute, stepTimeoutMs);
      results.push({ index: i, step, ok: true });
      if (captureFrames && page.screenshot) {
        // Best-effort: неудачный скриншот (страница в переходном
        // состоянии, редкая гонка CDP) не должен ронять весь регресс-
        // прогон ради необязательного кадра для слайд-шоу.
        let frame: ScenarioFrame | null = null;
        try {
          await prepareFrame(page, step);
          frame = { stepIndex: i, bytes: await page.screenshot() };
          frames.push(frame);
        } catch (err) {
          // Пропускаем кадр, не весь прогон — но НЕ молча (сквозной
          // аудит 29.09.2026). Пустой `catch` прятал единственный след
          // частичного успеха: ролик собирался из пяти кадров вместо
          // десяти, а узнать об этом было неоткуда — ни счётчика, ни
          // строки в журнале.
          skippedFrames.push({
            stepIndex: i,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        // Указатель (этап H) — на кадр ПЕРЕД кликом: кнопка видна
        // именно на нём, а кадр самого клика снимается уже после
        // нажатия, и кнопки там может не быть вовсе (клик увёл на
        // другой экран). Нет кадра — не к чему и указатель.
        const next = steps[i + 1];
        if (frame && next?.kind === 'click') {
          const pointer = await measurePointer(page, next.selector);
          if (pointer) frame.pointer = pointer;
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      results.push({ index: i, step, ok: false, error });
      return {
        ok: false,
        steps: results,
        failedAt: i,
        frames,
        skippedPaidClicks,
        skippedFrames,
      };
    }
  }
  return {
    ok: true,
    steps: results,
    frames,
    skippedPaidClicks,
    skippedFrames,
  };
}

/** Сколько ждать оседания экрана перед кадром — мягко, не осело —
 * снимаем как есть. Сеть — только после перехода (`goto`). */
export const FRAME_SETTLE_NETWORK_MS = 3_000;
export const FRAME_SETTLE_SPINNER_MS = 3_000;
const FRAME_NETWORK_IDLE_MS = 500;

/**
 * Подготовка кадра: экран осел и то, о чём говорит шаг, — в кадре.
 *
 * Найдено просмотром роликов прода 01.10.2026 перед одобрением:
 *  - первый кадр почти каждого ролика — спиннер: снимок шёл сразу за
 *    `goto(networkidle2)`, а SPA дорисовывает экран после него;
 *  - кадр шага «ждём карточку готового ролика» показывал форму «Повод»
 *    над ней: `waitForSelector` дождался элемента, но он ниже края
 *    экрана, и реплика говорила о том, чего на кадре нет.
 *
 * Поэтому: после перехода — затишье сети; перед каждым кадром — нет
 * `.animate-spin` (тот же признак, что у ночного снимка интерфейса);
 * у шага с селектором — элемент в центр экрана. Всё мягкое: ни одно
 * ожидание не роняет шаг, кадр best-effort, как и раньше.
 */
export async function prepareFrame(
  page: ScenarioPage,
  step: ScenarioStep,
): Promise<void> {
  if (step.kind === 'goto' && page.waitForNetworkIdle) {
    await page
      .waitForNetworkIdle({
        idleTime: FRAME_NETWORK_IDLE_MS,
        timeout: FRAME_SETTLE_NETWORK_MS,
      })
      .catch(() => undefined);
  }
  const selector = 'selector' in step ? step.selector : null;
  if (selector && page.evaluate) {
    await page
      .evaluate((sel: string) => {
        document
          .querySelector(sel)
          ?.scrollIntoView({ block: 'center', behavior: 'instant' });
      }, selector)
      .catch(() => undefined);
  }
  if (page.waitForFunction) {
    await page
      .waitForFunction(() => document.querySelector('.animate-spin') === null, {
        timeout: FRAME_SETTLE_SPINNER_MS,
      })
      .catch(() => undefined);
  }
}

/**
 * Центр рамки элемента в долях вьюпорта — или `null`, если указывать
 * не на что: элемента нет на странице, он скрыт (рамки нет), рамка
 * пустая или центр вне экрана (клик прокрутил бы страницу, и снимок
 * показывает не то место).
 *
 * Best-effort, как и сам снимок: любая ошибка — просто без указателя.
 */
export async function measurePointer(
  page: ScenarioPage,
  selector: string,
): Promise<FramePointer | null> {
  if (!page.$ || !page.viewport) return null;
  try {
    const viewport = page.viewport();
    if (!viewport || viewport.width <= 0 || viewport.height <= 0) return null;
    const element = await page.$(selector);
    const box = element ? await element.boundingBox() : null;
    if (!box || box.width <= 0 || box.height <= 0) return null;
    const x = (box.x + box.width / 2) / viewport.width;
    const y = (box.y + box.height / 2) / viewport.height;
    if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return null;
    const round = (v: number) => Math.round(v * 10_000) / 10_000;
    return { x: round(x), y: round(y) };
  } catch {
    return null;
  }
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
    case 'click': {
      // Выключенная кнопка — отдельный, НАЗВАННЫЙ отказ, а не таймаут
      // (находка боевого прогона 29.09.2026).
      //
      // `locator().click()` у выключенного элемента ждёт, пока тот
      // включится, и падает через тридцать секунд с «Timed out after
      // waiting 30000ms» — причина в этой строке не названа вовсе.
      // Восемь сценариев из девяти падали так, съев весь бюджет тика:
      // каждый отдал тридцать секунд, чтобы сообщить, что кнопка
      // выключена. Спросить это можно сразу.
      const handle = page.$
        ? await page.$(step.selector).catch(() => null)
        : null;
      const disabled = handle?.evaluate
        ? await handle
            .evaluate((el) => (el as HTMLButtonElement).disabled === true)
            .catch(() => false)
        : false;
      if (disabled) {
        throw new Error(
          `элемент ${step.selector} есть на экране, но выключен — ` +
            'нажать его нельзя; позиции степпера включаются только у ' +
            'пройденных шагов',
        );
      }
      await page.locator(step.selector).click();
      return;
    }
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
