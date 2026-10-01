/**
 * Браузерная часть визарда обучалки по сайту заказчика — реализация
 * `PageExplorer` (§5.1, §5.4 doc/CLIENT-SITE-TUTORIAL-SPEC.md), этап 112.
 *
 * ## Один вызов = одна полная жизнь браузера
 *
 * Прод — Vercel Functions: между двумя HTTP-запросами процесс Chromium
 * не доживает, и это не «сложно», а архитектурно исключено. Поэтому
 * каждый раунд: `launchHeadlessBrowser()` → восстановить jar НА ЧИСТОЙ
 * СТРАНИЦЕ → `goto` → выполнить действия → снять `PageExploration` →
 * забрать новый jar → ЗАКРЫТЬ браузер. Закрытие — в `finally`: незакрытый
 * Chromium на serverless живёт ровно до конца инстанса и всё это время
 * держит его память.
 *
 * ## Что здесь проверяется ПОВТОРНО, хотя сервис уже проверил
 *
 * Доменный замок (§8.1). Сервис проверяет адрес ДО запуска браузера и
 * ещё раз по итогу раунда, но между этими двумя моментами страница
 * может увести редиректом куда угодно — и если это случилось, действия
 * пользователя (в том числе ввод пароля от кабинета заказчика!)
 * выполнятся уже на ЧУЖОМ сайте. Поэтому origin перепроверяется здесь,
 * сразу после `goto` и до первого действия, и раунд обрывается, если
 * увело.
 *
 * ## Как это тестируется без Chromium
 *
 * `launchHeadlessBrowser` подменяется через `jest.mock` — тот же приём,
 * что в `tutorial-scenario-runner.service.spec.ts`; фальшивый браузер
 * отдаёт фальшивую страницу с нужными методами. В CI этого проекта
 * настоящий Chromium не поднимается (`doc/CI.md`), а проверять здесь
 * нужно именно ПОРЯДОК операций (куки до goto, замок до действий,
 * закрытие всегда), а не то, что puppeteer умеет кликать.
 */

import {
  BadRequestException,
  GatewayTimeoutException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  CdpCookie,
  CookieSettablePage,
  parseCookieJar,
  restoreCookieJar,
} from '../../common/cookie-jar';
import { launchHeadlessBrowser } from '../../common/headless-chromium';
import { DomainLockError, assertSameSite } from './draft-rounds';
import { dangerWarningFor } from './danger-words';
import { CollectedPage, collectPageExploration } from './page-exploration';
import { PageElement, PageExploration } from './page-exploration.types';
import {
  ExploreRoundRequest,
  ExploreRoundResult,
  PageExplorer,
  ReplayRequest,
  RoundAction,
} from './page-explorer';
import {
  CAPTURE_DEVICE_SCALE_FACTOR,
  CAPTURE_VIEWPORT,
} from '../tutorial-runner/tutorial-video-assembly';
import { LAUNCH_TIMEOUT_MS } from '../../common/headless-chromium';
import { VIDEO_FRAME_CONTENT_TYPE } from './draft-frames';
import {
  DSF_REPAINT_CAP_MS,
  FOREIGN_SETTLE_CEILING_MS,
  DSF_REPAINT_QUIET_SOURCE,
  FRAME_FREEZE_SOURCE,
  FRAME_RELEASE_SOURCE,
  describeReplayTimeout,
  isForeignTimeout,
  redirectWarningFor,
  scrollTargetIntoCenterSource,
  settleForeignFrame,
  withForeignTimeout,
} from './foreign-frame-settle';

/**
 * Размер окна — общий для всех съёмщиков кадров продукта
 * (`CAPTURE_VIEWPORT`, живёт рядом с холстом слайд-шоу). До 29.09.2026
 * здесь стояла копия литералом с комментарием «те же 390×844, что у
 * `ui-snapshot-runner`»: намерение было верным, а держал его
 * комментарий, а не код.
 *
 * ## Плотности здесь НЕТ, и это не недосмотр
 *
 * Остальные три съёмщика снимают с `CAPTURE_DEVICE_SCALE_FACTOR`,
 * выведенным из холста. Здесь — нет, потому что кадр раунда едет в
 * JSON-ответ и в колонку БД (§6.3), а не в Blob: вес важнее
 * детализации, отсюда же `SCREENSHOT_QUALITY = 60`.
 *
 * Цена известна и названа: ролик по сайту заказчика собирается из
 * ЭТИХ ЖЕ кадров (`client-site-tutorial.service.ts`, `uploadFrames`),
 * и на холсте 720 они растягиваются почти вдвое — то есть мылят. У
 * одного кадра два потребителя с противоположными требованиями, и
 * сегодня побеждает лёгкость. Разрешается это не плотностью здесь, а
 * вторым кадром за раунд (лёгкий — в базу, съёмочный — сразу в Blob);
 * решение за владельцем продукта, см. doc/TODO.md.
 */
const VIEWPORT = CAPTURE_VIEWPORT;

/** Навигация по чужому сайту. Дефолт puppeteer — 30с; столько ждать на
 * serverless-функции нельзя (её собственный потолок исполнения ближе), а
 * живой сайт заказчика отвечает за секунды. */
const NAV_TIMEOUT_MS = 20_000;
/** Одно действие (`fill`/`click`) — Locators API сам ждёт появления и
 * кликабельности элемента, так что это потолок на «элемента нет вовсе». */
const ACTION_TIMEOUT_MS = 10_000;
/** Сколько ждать оседания страницы: либо навигация, либо затишье сети.
 * Без этого кадр снимался бы в момент, когда страница ещё
 * перерисовывается, и пользователь видел бы пустой экран вместо
 * результата своего шага. Потолок один на оба пути — после клика и на
 * первом открытии: страница, которая ещё собирается, одинаково плоха в
 * обоих случаях. */
const SETTLE_TIMEOUT_MS = 6_000;

/** Сколько сеть должна молчать, чтобы считаться затихшей. */
const NETWORK_IDLE_MS = 400;

/**
 * Пол возраста кадра: раньше этого времени от начала перехода кадр не
 * снимается НИКОГДА (замер 29.09.2026, §11-седециес ТЗ).
 *
 * Почему пол, а не «дождаться, пока всё догрузится». Дождаться нельзя:
 * содержимое на таймере не даёт сети ни единого пакета, и никакое
 * ожидание сети его не увидит. На полигоне это измерено: блок
 * появляется на 1000-й миллисекунде, `networkidle2` отпускает на
 * 990-й — десять миллисекунд, и в одном прогоне из десяти блок в кадр
 * попадал, в девяти нет. Решало не правило, а то, с какой стороны
 * границы лёг запуск.
 *
 * Пол не делает разведчика всеведущим: содержимое, появившееся позже,
 * в кадр по-прежнему не попадёт. Но это станет ЗАПИСАННЫМ правилом с
 * названным числом, а не совпадением, которое нельзя ни воспроизвести,
 * ни объяснить человеку, у которого «половина сайта не видна».
 *
 * Шов держит пол выше задержки ленивого блока полигона: полигон для
 * того и заведён, чтобы правило на нём проверялось, а не обходилось.
 */
export const SETTLE_FLOOR_MS = 1_500;
/** Потолок на весь раунд целиком — страховка от суммы таймаутов. */
const ROUND_TIMEOUT_MS = 45_000;

/**
 * Сколько времени раунда держать НЕТРОНУТЫМ под сами снимки (JPEG, PNG
 * на плотности 2) и снятие кук (аудит этапа 01.10.2026).
 *
 * Мягкие ожидания стабилизации кадра (оседание до 3 с, затишье после
 * DSF=2) добавились к прежней сумме таймаутов, и худший случай раунда
 * (goto 20 + сеть 6 + клик 10 + навигация 6 + оседание 3 + DSF ≈1,3 +
 * снимки) вылез за `ROUND_TIMEOUT_MS`. Поднимать потолок нельзя — он
 * посчитан против потолка функции и ожидания наблюдателя (см. спек
 * «бюджет раунда»). Поэтому новые ожидания берут только ОСТАТОК
 * бюджета: не осталось — кадр снимается как есть, а не раунд падает
 * по таймауту с уже потраченным слотом лимита.
 */
const SNAPSHOT_RESERVE_MS = 2_000;

/**
 * Сколько ВСЕГО может занять один раунд у вызывающего по HTTP
 * (аудит собственных правок 29.09.2026).
 *
 * Раунд — это не только работа внутри `withTimeout`: перед ней
 * поднимается браузер (`LAUNCH_TIMEOUT_MS`, `inFreshBrowser` делает это
 * ДО гонки). Тому, кто ждёт ответа, важна именно сумма.
 *
 * Скачивание Chromium (`CHROMIUM_DOWNLOAD_TIMEOUT_MS`, 60 с) в сумму
 * СОЗНАТЕЛЬНО не входит: оно случается один раз на холодный инстанс, а
 * закладывать его в ожидание значило бы требовать от наблюдателя
 * 135 секунд — больше, чем весь его собственный бюджет тика. Цена
 * известна и названа: на первом раунде холодного инстанса наблюдатель
 * сдастся раньше сервера.
 */
export const CLIENT_ROUND_BUDGET_MS = LAUNCH_TIMEOUT_MS + ROUND_TIMEOUT_MS;
/** Переигровка (`/undo`) проходит до `MAX_DRAFT_STEPS` шагов подряд, а
 * не один — свой, заметно больший бюджет. Всё равно конечный: висящая
 * serverless-функция стоит денег и всё равно будет убита платформой. */
const REPLAY_TIMEOUT_MS = 120_000;
/** Качество JPEG кадра. Кадр едет в JSON-ответ и в колонку БД (§6.3), а
 * не в Blob, поэтому вес важнее детализации. */
const SCREENSHOT_QUALITY = 60;

/**
 * Формат съёмочного кадра — PNG, и он НЕ тот же, что у предпросмотра
 * (29.09.2026, замер по живым страницам). Довод целиком — у
 * `VIDEO_FRAME_CONTENT_TYPE` в `draft-frames.ts`, где тип и объявлен:
 * оттуда же берётся имя файла в хранилище, и двух мнений о формате
 * кадра в проекте быть не должно. Прежнее качество JPEG (80) больше
 * ни при чём — у PNG качества нет.
 */

/**
 * Плотность кадра ПРЕДПРОСМОТРА — единица, и это настройка, а не
 * умолчание браузера.
 *
 * Предпросмотр едет в JSON-ответ и в колонку БД (§6.3), и каждый
 * множитель плотности учетверяет его вес. Своё имя нужно ровно
 * потому, что рядом живёт вторая плотность: без имени единица в коде
 * читается как «забыли задать», а это осознанный выбор, симметричный
 * `CAPTURE_DEVICE_SCALE_FACTOR`.
 */
const PREVIEW_DEVICE_SCALE_FACTOR = 1;

/** Те же значения, что `PuppeteerLifeCycleEvent`. Своим типом, а не
 * `string`: широкий `string` сделал бы интерфейс НЕсовместимым с
 * настоящим `Page` (проверено отдельной временной сверкой типов, см.
 * «Сделано (этап 112…)» в плане) — а ровно эта совместимость и есть
 * смысл узкого интерфейса. */
type LifecycleEvent =
  | 'load'
  | 'domcontentloaded'
  | 'networkidle0'
  | 'networkidle2';

/** Минимальное подмножество puppeteer `Page`, которым пользуется этот
 * файл. Настоящий `Page` ему структурно удовлетворяет; тест подставляет
 * лёгкий мок — тот же приём, что `ScenarioPage`/`CookieSettablePage`. */
export interface ExplorerPage extends CookieSettablePage {
  setViewport(v: {
    width: number;
    height: number;
    /** Плотность — часть контракта съёмки (вариант А, 29.09.2026):
     *  съёмочный кадр снимается ею, предпросмотровый без неё. */
    deviceScaleFactor?: number;
  }): Promise<void>;
  goto(
    url: string,
    options?: { waitUntil?: LifecycleEvent; timeout?: number },
  ): Promise<unknown>;
  url(): string;
  locator(selector: string): ExplorerLocator;
  waitForNavigation(options?: {
    waitUntil?: LifecycleEvent;
    timeout?: number;
  }): Promise<unknown>;
  waitForNetworkIdle(options?: {
    idleTime?: number;
    timeout?: number;
  }): Promise<unknown>;
  evaluate(source: string): Promise<unknown>;
  /** Два кадра — два формата: предпросмотр JPEG с качеством,
   *  съёмочный PNG без него (у PNG качества не бывает, и `quality`
   *  вместе с ним puppeteer считает ошибкой). */
  screenshot(
    options:
      | { type: 'jpeg'; quality: number; encoding: 'base64' }
      | { type: 'png'; encoding: 'base64' },
  ): Promise<string>;
  createCDPSession(): Promise<CdpSession>;
}

/** Locator API puppeteer ≥22: сам ждёт появления и кликабельности
 * элемента. `setTimeout` возвращает НОВЫЙ локатор, а не меняет текущий
 * (локаторы неизменяемы) — вызвать и выбросить результат значит не
 * задать таймаут вовсе. */
export interface ExplorerLocator {
  setTimeout?(ms: number): ExplorerLocator;
  fill(value: string): Promise<unknown>;
  click(): Promise<unknown>;
}

export interface CdpSession {
  send(method: string): Promise<unknown>;
  detach(): Promise<unknown>;
}

export interface ExplorerBrowser {
  newPage(): Promise<ExplorerPage>;
  close(): Promise<unknown>;
}

@Injectable()
export class ChromiumPageExplorer implements PageExplorer {
  private readonly logger = new Logger(ChromiumPageExplorer.name);

  async runRound(request: ExploreRoundRequest): Promise<ExploreRoundResult> {
    return this.inFreshBrowser(
      (browser, deadline) => this.runInBrowser(browser, request, deadline),
      ROUND_TIMEOUT_MS,
      'раунд',
    );
  }

  /**
   * Переигровка оставшегося сценария с нуля (§5.2 `/undo`, §14 п.6). Тот
   * же браузер-на-один-вызов, но БЕЗ восстановления кук: в этом и смысл
   * — состояния «на раунд раньше» взять неоткуда, сессия зарабатывается
   * заново теми же шагами входа, что и в первый раз.
   *
   * Бюджет времени свой и заметно больший: здесь не одно действие, а до
   * тридцати подряд.
   */
  async replay(request: ReplayRequest): Promise<ExploreRoundResult> {
    const progress = { done: 0, total: request.steps.length };
    try {
      return await this.inFreshBrowser(
        (browser, deadline) =>
          this.replayInBrowser(browser, request, progress, deadline),
        REPLAY_TIMEOUT_MS,
        'переигровка сценария',
      );
    } catch (err) {
      // Переигровка проходит заново ВЕСЬ вход, и таймаут на ней почти
      // никогда не «сайт медленный»: чаще новый экран согласия на куки,
      // проверка возраста/гео или переделанная форма, которых не было
      // при записи. Голое «не уложилась в 20с» отправляло человека
      // ждать и повторять — то есть тратить слоты лимита на то же самое.
      if (isForeignTimeout(err)) {
        throw new GatewayTimeoutException(
          describeReplayTimeout((err as Error).message, progress),
        );
      }
      throw err;
    }
  }

  /**
   * Общая для обоих путей жизнь браузера: поднять → сделать → ЗАКРЫТЬ.
   * `finally`, а не «закрыть в конце удачного пути»: незакрытый Chromium
   * на serverless держит память инстанса до его смерти.
   */
  private async inFreshBrowser<T>(
    /** `deadline` — момент (по `now()`), когда раунд убьёт таймаут;
     * новые мягкие ожидания меряются остатком до него. */
    work: (browser: ExplorerBrowser, deadline: number) => Promise<T>,
    timeoutMs: number,
    what: string,
  ): Promise<T> {
    const launched = await launchHeadlessBrowser();
    if ('error' in launched) {
      // 503, а не 500: браузер — внешняя по отношению к бизнес-логике
      // инфраструктура, и «сейчас не получилось» честнее, чем
      // «внутренняя ошибка». Сервис по этому исключению вернёт слот
      // суточного лимита — раунд не состоялся.
      this.logger.warn(`headless-браузер недоступен: ${launched.error}`);
      throw new ServiceUnavailableException(
        `Не удалось открыть страницу сайта заказчика: ${launched.error}`,
      );
    }

    const browser = launched.browser as unknown as ExplorerBrowser;
    try {
      const deadline = this.now() + timeoutMs;
      return await withForeignTimeout(
        work(browser, deadline),
        timeoutMs,
        `${what} не уложилась в ${Math.round(timeoutMs / 1000)}с — сайт заказчика отвечает слишком медленно`,
      );
    } finally {
      await browser.close().catch(() => undefined);
    }
  }

  private async replayInBrowser(
    browser: ExplorerBrowser,
    request: ReplayRequest,
    progress: { done: number },
    deadline: number,
  ): Promise<ExploreRoundResult> {
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);

    const [first, ...rest] = request.steps;
    if (!first || first.kind !== 'goto') {
      // Сценарий без ведущего `goto` переигрывать не с чего. Это баг
      // вызывающего, а не пользовательский случай.
      throw new BadRequestException(
        'сценарий черновика повреждён: первый шаг обязан быть переходом на исходную страницу',
      );
    }

    let redirectWarning = await this.openPage(
      page,
      first.route,
      request.allowedOrigin,
    );
    progress.done = 1;

    // Цель кадра — последний fill/click ПОСЛЕ последнего перехода и
    // адрес до него: тот же смысл, что у раунда (см. `runInBrowser`).
    let target: string | undefined;
    let urlBeforeTarget = page.url();

    for (const step of rest) {
      if (step.kind === 'goto') {
        // Предупреждение — о последнем переходе: промежуточный редирект
        // (вход → кабинет) в переигровке ожидаем, важен экран кадра.
        redirectWarning = await this.openPage(
          page,
          step.route,
          request.allowedOrigin,
        );
        target = undefined;
        progress.done += 1;
        continue;
      }
      if (step.kind === 'fill' || step.kind === 'click') {
        target = step.selector;
        urlBeforeTarget = page.url();
      }
      if (step.kind === 'fill') {
        // §7.3: пустое значение в сценарии означает «это было секретное
        // поле» — настоящее значение живёт в `credentialsEnc` и
        // подставляется только здесь. Отсутствие креда не подменяется
        // пустой строкой молча: вход просто не состоится, а причина
        // должна быть названа.
        const secret = request.secrets[step.selector];
        const value = step.value === '' ? (secret ?? '') : step.value;
        if (step.value === '' && secret === undefined) {
          throw new BadRequestException(
            `для поля ${step.selector} не сохранены учётные данные — переиграть вход нечем`,
          );
        }
        await this.fill(page, step.selector, value);
        progress.done += 1;
        continue;
      }
      if (step.kind === 'click') {
        await this.click(page, step.selector, request.allowedOrigin);
        progress.done += 1;
        continue;
      }
      progress.done += 1;
      // `waitFor`/`assertVisible`/`assertText`/`triggerPaidOperation`
      // визард не записывает и не исполняет — они существуют для
      // сценариев НАШЕГО продукта. Пропускаем молча, а не падаем: чужой
      // шаг в этом списке означает, что черновик писала другая версия
      // кода, и терять из-за этого работу пользователя незачем.
    }

    const exploration = await this.snapshot(page, request.allowedOrigin, {
      centerSelector:
        target && page.url() === urlBeforeTarget ? target : undefined,
      redirectWarning,
      deadline,
    });
    return { exploration, cookies: await this.harvestCookies(page) };
  }

  private async runInBrowser(
    browser: ExplorerBrowser,
    request: ExploreRoundRequest,
    deadline: number,
  ): Promise<ExploreRoundResult> {
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);

    // Куки — ДО `goto` и на ещё чистой странице (§5.1 и доккомментарий
    // `restoreCookieJar`): иначе puppeteer подставит текущий URL как
    // `url` куки, и домен из jar'а перестанет быть источником правды.
    const { restored } = await restoreCookieJar(page, request.cookies);
    if (restored > 0) {
      this.logger.debug(`восстановлено кук: ${restored}`);
    }

    const redirectWarning = await this.openPage(
      page,
      request.url,
      request.allowedOrigin,
    );
    const urlBeforeActions = page.url();

    for (const action of request.actions) {
      if (action.kind === 'fill') {
        await this.fill(page, action.selector, action.value);
      } else {
        await this.click(page, action.selector, request.allowedOrigin);
      }
    }

    // Цель раунда — последний fill/click. Довернуть к ней окно имеет
    // смысл, только если экран остался тем же: после перехода смысл
    // кадра — верх НОВОГО экрана, и прокрутка к селектору, случайно
    // совпавшему на новой странице, показала бы её середину. Переход
    // определяется по адресу: SPA, перерисовавшая экран без смены
    // адреса, обычно убирает и сам элемент — тогда прокрутка в странице
    // просто не найдёт его.
    const target = request.actions[request.actions.length - 1]?.selector;
    const exploration = await this.snapshot(page, request.allowedOrigin, {
      clickedSelector: lastClickedSelector(request.actions),
      centerSelector:
        target && page.url() === urlBeforeActions ? target : undefined,
      redirectWarning,
      deadline,
    });

    return { exploration, cookies: await this.harvestCookies(page) };
  }

  /** Переход + замок ДО первого действия: если `goto` увёл редиректом
   * на чужой сайт, вводить туда креды заказчика нельзя ни при каких
   * условиях. Возвращает предупреждение, если внутри сайта открылся
   * другой экран (`redirectWarningFor`). */
  private async openPage(
    page: ExplorerPage,
    url: string,
    allowedOrigin: string,
  ): Promise<string | undefined> {
    const startedAt = this.now();
    await withForeignTimeout(
      page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: NAV_TIMEOUT_MS,
      }),
      NAV_TIMEOUT_MS,
      `страница не открылась за ${Math.round(NAV_TIMEOUT_MS / 1000)}с`,
    );
    // Оседание — и на ПЕРВОМ открытии тоже, а не только после клика.
    // До 29.09.2026 первый кадр снимался на 57-й миллисекунде (замер на
    // полигоне): `domcontentloaded` и сразу съёмка. На статической
    // странице это незаметно, на живом сайте с клиентской отрисовкой
    // разведчик отчитывался бы «нашёл восемь элементов» там, где их
    // двадцать, — и ни он, ни человек не узнали бы, что смотрели на
    // недособранную страницу.
    await this.settle(page, startedAt);
    this.assertInside(allowedOrigin, page.url());
    return redirectWarningFor(url, page.url());
  }

  /**
   * Оседание страницы после перехода: затишье сети, затем пол возраста
   * кадра (`SETTLE_FLOOR_MS`). Оба шага мягкие — «не случилось» здесь
   * нормальный исход, а не ошибка: сайт с вечным опросом сервера
   * затишья не даст никогда, и валить из-за этого раунд, за который
   * уже потрачен слот суточного лимита, — обмен не в пользу человека.
   */
  private async settle(page: ExplorerPage, startedAt: number): Promise<void> {
    await page
      .waitForNetworkIdle({
        idleTime: NETWORK_IDLE_MS,
        timeout: SETTLE_TIMEOUT_MS,
      })
      .catch(() => null);
    await this.floor(startedAt);
  }

  /** Досидеть до пола возраста кадра. Отдельным методом, потому что у
   * пути после клика своё ожидание (навигация ИЛИ затишье), а пол —
   * общий. */
  private async floor(startedAt: number): Promise<void> {
    const left = startedAt + SETTLE_FLOOR_MS - this.now();
    if (left > 0) await this.sleep(left);
  }

  /** Часы и сон — методами, чтобы тест не ждал полторы секунды на
   * каждый раунд по-настоящему. */
  protected now(): number {
    return Date.now();
  }

  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async fill(
    page: ExplorerPage,
    selector: string,
    value: string,
  ): Promise<void> {
    const locator = this.locate(page, selector);
    await withForeignTimeout(
      locator.fill(value) as Promise<unknown>,
      ACTION_TIMEOUT_MS,
      `поле ${selector} не найдено или не заполняется`,
    );
  }

  private async click(
    page: ExplorerPage,
    selector: string,
    allowedOrigin: string,
  ): Promise<void> {
    const locator = this.locate(page, selector);
    // Клик может увести на другую страницу, а может перерисовать SPA на
    // месте. Ждём того, что случится раньше: навигацию или затишье
    // сети. Оба промиса гасятся `.catch`, потому что «не случилось»
    // здесь — нормальный исход, а не ошибка.
    const navigated = page
      .waitForNavigation({
        waitUntil: 'domcontentloaded',
        timeout: SETTLE_TIMEOUT_MS,
      })
      .catch(() => null);
    const startedAt = this.now();
    await withForeignTimeout(
      locator.click() as Promise<unknown>,
      ACTION_TIMEOUT_MS,
      `кнопка ${selector} не найдена или не кликается`,
    );
    await Promise.race([
      navigated,
      page
        .waitForNetworkIdle({
          idleTime: NETWORK_IDLE_MS,
          timeout: SETTLE_TIMEOUT_MS,
        })
        .catch(() => null),
    ]);
    await this.floor(startedAt);

    // Замок ПОСЛЕ каждого перехода — клик на чужом сайте мог увести
    // куда угодно, и следующее действие (или кадр) уже не наше дело.
    this.assertInside(allowedOrigin, page.url());
  }

  private locate(page: ExplorerPage, selector: string): ExplorerLocator {
    const base = page.locator(selector);
    return base.setTimeout?.(ACTION_TIMEOUT_MS) ?? base;
  }

  /** Снять кадр и список элементов — общий финал обоих путей. */
  private async snapshot(
    page: ExplorerPage,
    allowedOrigin: string,
    opts: {
      clickedSelector?: string;
      /** Цель раунда, к которой довернуть окно (экран не сменился). */
      centerSelector?: string;
      redirectWarning?: string;
      /** Дедлайн раунда (`inFreshBrowser`); без него — без ограничения
       * остатком, только собственные потолки ожиданий. */
      deadline?: number;
    } = {},
  ): Promise<PageExploration> {
    const leftMs = () =>
      opts.deadline === undefined
        ? Number.POSITIVE_INFINITY
        : opts.deadline - this.now() - SNAPSHOT_RESERVE_MS;
    // Сначала прокрутка, потом оседание: прокрутка сама может включить
    // ленивую подгрузку (скелетоны, `loading=lazy`), и ждать надо уже её.
    if (opts.centerSelector) {
      await page
        .evaluate(scrollTargetIntoCenterSource(opts.centerSelector))
        .catch(() => false);
    }
    const settleBudget = Math.min(FOREIGN_SETTLE_CEILING_MS, leftMs());
    const settled =
      settleBudget > 0
        ? await settleForeignFrame(
            (src) => page.evaluate(src),
            { now: () => this.now(), sleep: (ms) => this.sleep(ms) },
            settleBudget,
          )
        : { settled: false, holdingBy: 'бюджет раунда исчерпан' };
    if (!settled.settled) {
      // Не ошибка: снимаем как есть (потоковое видео, вечный скелетон).
      this.logger.debug(
        `кадр снят, не дождавшись оседания: ${settled.holdingBy}`,
      );
    }

    const collected = await this.collect(page, allowedOrigin);
    const elements = collected.elements.map(withDanger);

    let dangerWarning: string | undefined;
    if (opts.clickedSelector) {
      // Кнопка уже нажата, страница уже сменилась — её текста в новом
      // DOM может не быть. Берём предупреждение из того, что знаем:
      // текста элемента с тем же селектором, если он пережил переход, и
      // самого селектора (в нём часто и лежит говорящее имя).
      const stillThere = elements.find(
        (e) => e.selector === opts.clickedSelector,
      );
      dangerWarning =
        dangerWarningFor(stillThere?.visibleText) ??
        dangerWarningFor(opts.clickedSelector);
    }

    // Заморозка — только на время снимков и с обязательным снятием в
    // `finally`: страница живёт дальше (переигровка, следующий шаг).
    await page.evaluate(FRAME_FREEZE_SOURCE).catch(() => undefined);
    let screenshotBase64: string;
    let videoFrameDataUrl: string | undefined;
    try {
      screenshotBase64 = await page.screenshot({
        type: 'jpeg',
        quality: SCREENSHOT_QUALITY,
        encoding: 'base64',
      });
      videoFrameDataUrl = await this.captureVideoFrame(page, leftMs);
    } finally {
      await page.evaluate(FRAME_RELEASE_SOURCE).catch(() => undefined);
    }

    return {
      currentUrl: page.url(),
      screenshotDataUrl: `data:image/jpeg;base64,${screenshotBase64}`,
      ...(videoFrameDataUrl ? { videoFrameDataUrl } : {}),
      elements,
      looksLikeLogin: collected.looksLikeLogin,
      ...(dangerWarning ? { dangerWarning } : {}),
      ...(opts.redirectWarning
        ? { redirectWarning: opts.redirectWarning }
        : {}),
    };
  }

  private async captureVideoFrame(
    page: ExplorerPage,
    leftMs: () => number,
  ): Promise<string | undefined> {
    /**
     * Второй кадр — съёмочный (вариант А, 29.09.2026).
     *
     * Сначала лёгкий, потом плотный, а не наоборот: лёгкий обязателен
     * — он и есть ответ человеку, — а плотный необязателен. Снять его
     * первым значило бы рисковать ответом ради ролика.
     *
     * `catch` без проброса по той же причине: сбой второго снимка
     * делает ролик мягче на один кадр и только. Валить из-за него
     * раунд, за который уже потрачен слот суточного лимита, — обмен не
     * в пользу человека.
     */
    let videoFrameDataUrl: string | undefined;
    try {
      await page.setViewport({
        ...CAPTURE_VIEWPORT,
        deviceScaleFactor: CAPTURE_DEVICE_SCALE_FACTOR,
      });
      // Затишье после смены плотности: `srcset` выбирает новый
      // кандидат, и снимок сразу после — старая картинка, растянутая
      // вдвое. Мягко и с потолком: свой потолок в странице, наш —
      // на случай, если страница не отвечает вовсе.
      // Только если остаток бюджета вмещает весь потолок затишья: оно
      // необязательное, а раунд — нет.
      if (leftMs() >= DSF_REPAINT_CAP_MS + 500) {
        await withForeignTimeout(
          page.evaluate(DSF_REPAINT_QUIET_SOURCE),
          DSF_REPAINT_CAP_MS + 500,
          'затишье после смены плотности',
        ).catch(() => undefined);
      }
      // Второй проход заморозки: догрузившаяся картинка могла запустить
      // свою анимацию проявления.
      await page.evaluate(FRAME_FREEZE_SOURCE).catch(() => undefined);
      const videoBase64 = await page.screenshot({
        type: 'png',
        encoding: 'base64',
      });
      videoFrameDataUrl = `data:${VIDEO_FRAME_CONTENT_TYPE};base64,${videoBase64}`;
    } catch (err) {
      this.logger.warn(
        `съёмочный кадр не снялся (${err instanceof Error ? err.message : String(err)}) — ролик будет мягче на один кадр`,
      );
    } finally {
      // Вернуть плотность обязательно: страница живёт дальше в этом же
      // раунде (переигровка делает несколько снимков подряд), и
      // следующий лёгкий кадр иначе приехал бы тяжёлым — то есть
      // правка отменила бы сама себя через один шаг.
      await page
        .setViewport({
          ...CAPTURE_VIEWPORT,
          deviceScaleFactor: PREVIEW_DEVICE_SCALE_FACTOR,
        })
        .catch(() => undefined);
    }
    return videoFrameDataUrl;
  }

  /**
   * Исходник функции уезжает в страницу строкой (см. доккомментарий
   * `page-exploration.ts`). Строкой, а не `page.evaluate(fn, args)`,
   * потому что аргументом DOM не передать, а внутри нужен `document`.
   */
  private async collect(
    page: ExplorerPage,
    allowedOrigin: string,
  ): Promise<CollectedPage> {
    const source = `(${collectPageExploration.toString()})(${JSON.stringify(allowedOrigin)})`;
    const raw = (await page.evaluate(source)) as CollectedPage | null;
    if (!raw || !Array.isArray(raw.elements)) {
      // Страница могла уйти в редирект ровно во время съёма — это не
      // повод падать с непонятной ошибкой.
      return { currentUrl: page.url(), elements: [], looksLikeLogin: false };
    }
    return raw;
  }

  /**
   * Весь jar браузера, а не куки текущей страницы: сессия могла
   * частично жить на домене стороннего SSO (§7.4.5), и без него
   * следующий раунд разлогинится. `page.cookies()` этого не умеет —
   * только CDP `Network.getAllCookies`.
   */
  private async harvestCookies(page: ExplorerPage): Promise<CdpCookie[]> {
    let session: CdpSession | undefined;
    try {
      session = await page.createCDPSession();
      const result = (await session.send('Network.getAllCookies')) as {
        cookies?: unknown;
      };
      // Через `parseCookieJar`, а не как есть: это данные ЧУЖОГО сайта,
      // и они нормализуются ровно тем же разбором, что и строка из БД.
      const { cookies, dropped } = parseCookieJar(result?.cookies);
      if (dropped > 0) {
        this.logger.warn(`снятие кук: отброшено ${dropped} некорректных`);
      }
      return cookies;
    } catch (err) {
      // Потеря jar'а — не повод терять весь раунд: шаг уже выполнен и
      // кадр снят. Следующий раунд просто начнётся неавторизованным, и
      // это видно человеку на кадре.
      this.logger.warn(
        `не удалось снять куки: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    } finally {
      await session?.detach().catch(() => undefined);
    }
  }

  /** Нарушение замка — это 400 «так нельзя», а не 500: пользователь
   * увидит внятную причину, а сервис вернёт слот суточного лимита. */
  private assertInside(allowedOrigin: string, currentUrl: string): void {
    try {
      assertSameSite(allowedOrigin, currentUrl);
    } catch (err) {
      if (err instanceof DomainLockError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }
}

/** Селектор последнего клика раунда — только он может нести
 * предупреждение стоп-листа (§8.3): `fill` необратимого не делает. */
function lastClickedSelector(actions: RoundAction[]): string | undefined {
  const last = actions[actions.length - 1];
  return last?.kind === 'click' ? last.selector : undefined;
}

function withDanger(element: PageElement): PageElement {
  const danger = dangerWarningFor(element.visibleText ?? element.label);
  return danger ? { ...element, danger } : element;
}
