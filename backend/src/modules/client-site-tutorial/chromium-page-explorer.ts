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
import {
  launchHeadlessBrowser,
  withTimeout,
} from '../../common/headless-chromium';
import { DomainLockError, assertSameOrigin } from './draft-rounds';
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

/**
 * Вьюпорт — телефон: обучалка снимается для показа внутри Telegram
 * (§0 ТЗ), и кадр обязан выглядеть так, как его увидит зритель. Те же
 * 390×844, что у `ui-snapshot-runner.service.ts`, чтобы два разных
 * съёмщика кадров этого продукта не давали разную геометрию.
 */
const VIEWPORT = { width: 390, height: 844 };

/** Навигация по чужому сайту. Дефолт puppeteer — 30с; столько ждать на
 * serverless-функции нельзя (её собственный потолок исполнения ближе), а
 * живой сайт заказчика отвечает за секунды. */
const NAV_TIMEOUT_MS = 20_000;
/** Одно действие (`fill`/`click`) — Locators API сам ждёт появления и
 * кликабельности элемента, так что это потолок на «элемента нет вовсе». */
const ACTION_TIMEOUT_MS = 10_000;
/** Сколько ждать после клика: либо навигация, либо затишье сети. Без
 * этого кадр снимался бы в момент, когда страница ещё перерисовывается,
 * и пользователь видел бы пустой экран вместо результата своего шага. */
const POST_CLICK_SETTLE_MS = 6_000;
/** Потолок на весь раунд целиком — страховка от суммы таймаутов. */
const ROUND_TIMEOUT_MS = 45_000;
/** Переигровка (`/undo`) проходит до `MAX_DRAFT_STEPS` шагов подряд, а
 * не один — свой, заметно больший бюджет. Всё равно конечный: висящая
 * serverless-функция стоит денег и всё равно будет убита платформой. */
const REPLAY_TIMEOUT_MS = 120_000;
/** Качество JPEG кадра. Кадр едет в JSON-ответ и в колонку БД (§6.3), а
 * не в Blob, поэтому вес важнее детализации. */
const SCREENSHOT_QUALITY = 60;

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
  setViewport(v: { width: number; height: number }): Promise<void>;
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
  screenshot(options: {
    type: 'jpeg';
    quality: number;
    encoding: 'base64';
  }): Promise<string>;
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
      (browser) => this.runInBrowser(browser, request),
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
    return this.inFreshBrowser(
      (browser) => this.replayInBrowser(browser, request),
      REPLAY_TIMEOUT_MS,
      'переигровка сценария',
    );
  }

  /**
   * Общая для обоих путей жизнь браузера: поднять → сделать → ЗАКРЫТЬ.
   * `finally`, а не «закрыть в конце удачного пути»: незакрытый Chromium
   * на serverless держит память инстанса до его смерти.
   */
  private async inFreshBrowser<T>(
    work: (browser: ExplorerBrowser) => Promise<T>,
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
      return await withTimeout(
        work(browser),
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

    await this.openPage(page, first.route, request.allowedOrigin);

    for (const step of rest) {
      if (step.kind === 'goto') {
        await this.openPage(page, step.route, request.allowedOrigin);
        continue;
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
        continue;
      }
      if (step.kind === 'click') {
        await this.click(page, step.selector, request.allowedOrigin);
        continue;
      }
      // `waitFor`/`assertVisible`/`assertText`/`triggerPaidOperation`
      // визард не записывает и не исполняет — они существуют для
      // сценариев НАШЕГО продукта. Пропускаем молча, а не падаем: чужой
      // шаг в этом списке означает, что черновик писала другая версия
      // кода, и терять из-за этого работу пользователя незачем.
    }

    const exploration = await this.snapshot(page, request.allowedOrigin);
    return { exploration, cookies: await this.harvestCookies(page) };
  }

  private async runInBrowser(
    browser: ExplorerBrowser,
    request: ExploreRoundRequest,
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

    await this.openPage(page, request.url, request.allowedOrigin);

    for (const action of request.actions) {
      if (action.kind === 'fill') {
        await this.fill(page, action.selector, action.value);
      } else {
        await this.click(page, action.selector, request.allowedOrigin);
      }
    }

    const exploration = await this.snapshot(page, request.allowedOrigin, {
      clickedSelector: lastClickedSelector(request.actions),
    });

    return { exploration, cookies: await this.harvestCookies(page) };
  }

  /** Переход + замок ДО первого действия: если `goto` увёл редиректом
   * на чужой сайт, вводить туда креды заказчика нельзя ни при каких
   * условиях. */
  private async openPage(
    page: ExplorerPage,
    url: string,
    allowedOrigin: string,
  ): Promise<void> {
    await withTimeout(
      page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: NAV_TIMEOUT_MS,
      }),
      NAV_TIMEOUT_MS,
      `страница не открылась за ${Math.round(NAV_TIMEOUT_MS / 1000)}с`,
    );
    this.assertInside(allowedOrigin, page.url());
  }

  private async fill(
    page: ExplorerPage,
    selector: string,
    value: string,
  ): Promise<void> {
    const locator = this.locate(page, selector);
    await withTimeout(
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
        timeout: POST_CLICK_SETTLE_MS,
      })
      .catch(() => null);
    await withTimeout(
      locator.click() as Promise<unknown>,
      ACTION_TIMEOUT_MS,
      `кнопка ${selector} не найдена или не кликается`,
    );
    await Promise.race([
      navigated,
      page
        .waitForNetworkIdle({ idleTime: 400, timeout: POST_CLICK_SETTLE_MS })
        .catch(() => null),
    ]);

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
    opts: { clickedSelector?: string } = {},
  ): Promise<PageExploration> {
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

    const screenshotBase64 = await page.screenshot({
      type: 'jpeg',
      quality: SCREENSHOT_QUALITY,
      encoding: 'base64',
    });

    return {
      currentUrl: page.url(),
      screenshotDataUrl: `data:image/jpeg;base64,${screenshotBase64}`,
      elements,
      looksLikeLogin: collected.looksLikeLogin,
      ...(dangerWarning ? { dangerWarning } : {}),
    };
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
      assertSameOrigin(allowedOrigin, currentUrl);
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
