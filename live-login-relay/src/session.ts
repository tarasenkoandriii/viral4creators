/**
 * Одна live-сессия входа — один выделенный браузер. Страниц может быть
 * больше одной: поверх главной открываются попапы SSO (Telegram Login
 * Widget, «Sign in with Google», Apple ID), и стрим с вводом
 * переключаются на них, см. §9.1 спеки. Стримится и принимает ввод
 * всегда ровно одна — `activePage`, со своей CDP-сессией. Модель
 * ресурса и протокол — doc/LIVE-LOGIN-RELAY-SPEC.md §5, §8, §9.1.
 *
 * Узкие интерфейсы `Relay*` ниже — НЕ полный `puppeteer-core`, а только
 * те методы, которые `Session` реально вызывает. Настоящий
 * `puppeteer-core` `Browser`/`Page` структурно им удовлетворяет (это
 * подмножество их публичного API), а в тестах (§14 спеки) подставляются
 * лёгкие моки без реального Chromium.
 */

import { randomUUID } from 'node:crypto';
import { generateStreamToken, verifyStreamToken } from './stream-token';
import type {
  CdpCookie,
  CloseReason,
  FrameMetadata,
  ServerMessage,
  SessionResult,
} from './types';
import type { Logger } from './logger';

export interface RelayFrame {
  url(): string;
}

export interface RelayCdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, handler: (params: any) => void): void; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** События страницы, на которые подписывается реле. `popup` — это
 * `window.open`/`target=_blank`: ровно так входят Telegram Login
 * Widget, «Sign in with Google» и Apple ID, то есть три из четырёх
 * сценариев, ради которых живой вход и существует. Аргумент обнуляем —
 * попап мог и не открыться. */
export interface RelayPageEvents {
  framenavigated: RelayFrame;
  popup: RelayPage | null;
  close: undefined;
}

export interface RelayPage {
  goto(url: string, options?: { timeout?: number }): Promise<unknown>;
  setViewport?(viewport: {
    width: number;
    height: number;
    isMobile?: boolean;
    hasTouch?: boolean;
    deviceScaleFactor?: number;
  }): Promise<void>;
  url(): string;
  target(): { createCDPSession(): Promise<RelayCdpSession> };
  /**
   * Одна сигнатура с картой событий, а НЕ набор перегрузок: у
   * puppeteer `on` объявлен как generic по своей карте `PageEvents`, и
   * перегруженный вариант перестаёт быть ему структурно совместим —
   * `tsc` не может вывести `Key` и подставляет `unknown` (проверено:
   * TS2322 на `launchBrowser()` в main.ts).
   */
  on<K extends keyof RelayPageEvents>(
    event: K,
    handler: (arg: RelayPageEvents[K]) => void,
  ): void;
  mainFrame(): RelayFrame;
  close(): Promise<void>;
}

export interface RelayBrowser {
  newPage(): Promise<RelayPage>;
  close(): Promise<void>;
}

/** Не просто «отправить кадр» — у WS-соединения, которое сессия
 * вытесняет (§8.1 п.3 спеки), нужно ещё и реально ЗАКРЫТЬ транспорт, не
 * только уведомить: иначе старая вкладка технически остаётся живым
 * WS-соединением и её ввод продолжал бы долетать до dispatchMouse/
 * dispatchKey наравне с новой (найдено этим аудитом). */
export interface WsChannel {
  send(message: ServerMessage): void;
  close(code: number, reason: string): void;
}

export class SessionAlreadyClosedError extends Error {}

/** Битовые флаги кнопок мыши CDP — те же значения, что у puppeteer
 * (`cdp/Input.js:156-172`): страница читает их как `MouseEvent.buttons`. */
const MOUSE_BUTTON_FLAGS: Record<string, number> = {
  left: 1,
  right: 2,
  middle: 4,
};

/** Обратное преобразование маски в имя «главной» зажатой кнопки — тем
 * же приоритетом, что `getButtonFromPressedButtons()` у puppeteer. */
function buttonFromMask(mask: number): string {
  if (mask & MOUSE_BUTTON_FLAGS.left) return 'left';
  if (mask & MOUSE_BUTTON_FLAGS.right) return 'right';
  if (mask & MOUSE_BUTTON_FLAGS.middle) return 'middle';
  return 'none';
}

/**
 * Стартовый вьюпорт сессии (этап 109). У puppeteer по умолчанию
 * `DEFAULT_VIEWPORT = {width: 800, height: 600}` — десктопная форма, а
 * потребитель этой фичи по построению телефон внутри Telegram (§7.4.3
 * основного ТЗ прямо про это: «ТМА работает внутри Telegram, разные
 * экраны»). До этапа 109 первые кадры уходили в 800×600 и, если клиент
 * почему-либо не присылал `resize`, ВСЯ сессия оставалась десктопной:
 * чужой сайт отдавал бы десктопную вёрстку формы входа человеку с
 * телефона. 390×844 — то же значение, что уже принято в
 * `backend/src/modules/ui-snapshot/ui-snapshot-runner.service.ts` для
 * съёмки экранов ТМА, чтобы два места продукта не расходились. Клиент
 * всё равно переопределяет размер первым же `resize` (§8.3).
 */
const DEFAULT_VIEWPORT = {
  width: 390,
  height: 844,
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 1,
};

export interface SessionCreateOptions {
  startUrl: string;
  allowedOrigin: string;
  browser: RelayBrowser;
  logger: Logger;
  /** Потолок ожидания `page.goto(startUrl)` — см. доккомментарий
   * `create()`. */
  navTimeoutMs: number;
}

export class Session {
  readonly id = randomUUID();
  readonly allowedOrigin: string;
  readonly streamToken: string;
  readonly streamTokenHash: string;
  readonly createdAt = Date.now();

  state: 'created' | 'streaming' | 'finalizing' | 'closed' = 'created';
  lastActivityAt = Date.now();

  private readonly browser: RelayBrowser;
  private readonly logger: Logger;
  /**
   * ГЛАВНАЯ страница — та, что открыта на сайте заказчика. Она же и
   * только она даёт `finalUrl` в `harvest()`, и это не деталь: бэкенд
   * в `completeLiveLogin` делает
   * `assertSameOrigin(draft.baseUrl, result.finalUrl)` и при
   * несовпадении отвечает «похоже, вход не завершён: сессия
   * закончилась на стороннем сайте». Если пустить `page` следом за
   * попапом, каждый вход через Telegram/Google заканчивался бы на
   * `oauth.telegram.org` и отвергался бы — человек прошёл бы вход
   * целиком и получил отказ. Поэтому попап живёт в `activePage`, а
   * `page` не меняется никогда.
   */
  private page: RelayPage | null = null;
  /** Страница, которая СЕЙЧАС стримится и принимает ввод: главная либо
   * открытый поверх неё попап. */
  private activePage: RelayPage | null = null;
  /** CDP-сессия `activePage`. Имя оставлено прежним намеренно:
   * `dispatchMouse`/`dispatchKey`/`resize`/`harvest` работают с ней и
   * про переключение страниц знать не обязаны — поэтому ws-handler
   * правок не потребовал вовсе. */
  private cdp: RelayCdpSession | null = null;
  /** Одна CDP-сессия на страницу. Без кеша каждое переключение
   * туда-обратно создавало бы новую сессию к тому же таргету и вешало
   * бы ещё один обработчик кадров. */
  private readonly cdpByPage = new Map<RelayPage, RelayCdpSession>();
  /** Страницы, на которые уже повешены framenavigated/popup — чтобы
   * возврат на главную не подписывался на неё второй раз и не слал
   * `navigated` дважды. */
  private readonly wiredPages = new Set<RelayPage>();
  /** Последний размер, присланный клиентом (`resize`, §8.3). Хранится
   * ради попапа: puppeteer даёт новой странице ДЕФОЛТНЫЙ вьюпорт
   * браузера, а не родительский, и без переноса человек с телефона
   * увидел бы в попапе десктопную вёрстку формы входа. */
  private viewport = {
    width: DEFAULT_VIEWPORT.width,
    height: DEFAULT_VIEWPORT.height,
  };
  /**
   * Сколько чего доехало от человека за сессию. Пишется одной строкой
   * при закрытии — дёшево, и это ровно тот факт, которого не хватило
   * при разборе «прокрутка не работает»: по логам было не отличить
   * «клиент не шлёт колесо» от «шлёт, а страница не реагирует». Без
   * этого каждая такая жалоба — гадание сразу на две стороны.
   */
  private readonly inputCounts = { mouse: 0, wheel: 0, key: 0 };
  private wsChannel: WsChannel | null = null;
  private cachedResult: SessionResult | null = null;
  private closedAt: number | null = null;
  private finalizingPromise: Promise<SessionResult> | null = null;
  /** Маска сейчас зажатых кнопок мыши (CDP `buttons`) — состояние живёт
   * на сессии, потому что перетаскивание по определению растянуто между
   * несколькими сообщениями клиента; см. dispatchMouse(). */
  private pressedButtons = 0;
  private idleWarningSent = false;
  private wallWarningSent = false;

  private constructor(opts: {
    allowedOrigin: string;
    browser: RelayBrowser;
    logger: Logger;
  }) {
    this.allowedOrigin = opts.allowedOrigin;
    this.browser = opts.browser;
    this.logger = opts.logger;
    const pair = generateStreamToken();
    this.streamToken = pair.token;
    this.streamTokenHash = pair.hash;
  }

  /**
   * Открывает страницу и переходит на startUrl — не запускает скринкаст
   * (это делает attachWs, §8.1: нет смысла слать кадры, пока никто не
   * подключился).
   *
   * Таймаут навигации ЯВНЫЙ (этап 109). Без него действует умолчание
   * puppeteer — 30 секунд (`common/TimeoutSettings.js:9`), а `POST
   * /sessions` всё это время держит HTTP-запрос backend'а. Типовой
   * таймаут исходящего вызова в backend'е этого проекта — 15 секунд
   * (`youtube-search.service.ts`), то есть backend успел бы сдаться
   * РАНЬШЕ, чем реле ответит: пользователь увидел бы ошибку, а реле
   * тем временем довело бы сессию до конца и держало живой браузер и
   * место под `MAX_CONCURRENT_SESSIONS` все три минуты wall-таймаута —
   * никому не нужную. 20 секунд по умолчанию — то же значение, что
   * `ROUTE_TIMEOUT_MS` у `ui-snapshot-runner` в backend'е.
   */
  static async create(opts: SessionCreateOptions): Promise<Session> {
    const session = new Session({
      allowedOrigin: opts.allowedOrigin,
      browser: opts.browser,
      logger: opts.logger,
    });
    session.page = await opts.browser.newPage();
    // `setViewport` помечен необязательным в узком интерфейсе
    // `RelayPage` — у настоящего puppeteer-овского Page он есть всегда,
    // а тестовым мокам не нужно его реализовывать ради оркестрации.
    if (session.page.setViewport) {
      await session.page.setViewport(DEFAULT_VIEWPORT);
    }
    await session.page.goto(opts.startUrl, { timeout: opts.navTimeoutMs });
    return session;
  }

  verifyToken(presented: string): boolean {
    return verifyStreamToken(presented, this.streamTokenHash);
  }

  /** Только mouse/key считаются активностью для идл-таймаута (§8.3) —
   * вызывается ws-handler'ом отдельно, не на каждое WS-сообщение. */
  markActivity(): void {
    this.lastActivityAt = Date.now();
    // Человек вернулся — предупреждение об истечении снова актуально,
    // когда он снова замрёт (этап 109).
    this.idleWarningSent = false;
  }

  /** Предупредить клиента о близком автозакрытии — один раз на «замирание»
   * (для идла флаг сбрасывается любой активностью, для wall — нет, там
   * потолок непродлеваемый). */
  warnExpiring(
    reason: 'idle-timeout' | 'wall-timeout',
    msRemaining: number,
  ): void {
    if (reason === 'idle-timeout') {
      if (this.idleWarningSent) return;
      this.idleWarningSent = true;
    } else {
      if (this.wallWarningSent) return;
      this.wallWarningSent = true;
    }
    this.notify({ type: 'expiring', reason, msRemaining });
  }

  /**
   * Уведомление клиента — ВСЕГДА best-effort (найдено вторым проходом
   * аудита этапа 108). `ws.send` умеет бросать (сокет оборвался между
   * проверкой `readyState` и самой отправкой), и раньше это исключение
   * летело наверх прямо посреди `finalize()`/`close()`. Последствия
   * были несоразмерны причине: в `finalize()` — куки УЖЕ собраны, они и
   * есть весь смысл операции, но вызывающий получал 502 и терял их
   * (повторный live-вход — это ещё одна минута живого времени
   * человека); в `close()` по таймауту — исключение уходило в
   * `void this.expire(...)` необработанным отклонением. Сообщить
   * человеку, что сессия закрылась, приятно, но не ценой самого
   * результата.
   */
  private notify(message: ServerMessage): void {
    try {
      this.wsChannel?.send(message);
    } catch (err) {
      this.logger.warn('не удалось уведомить клиента по WS', {
        sessionId: this.id,
        error: String(err),
      });
    }
  }

  /** WS подключился и прошёл auth. Если уже было активное соединение —
   * вытесняет его: уведомляет (`closed:'superseded'`) И реально закрывает
   * транспорт (§8.1 п.3, найдено аудитом — иначе старое соединение
   * оставалось бы живым и продолжало бы слать mouse/key). Скринкаст
   * стартует только один раз — при первом подключении. */
  async attachWs(channel: WsChannel): Promise<void> {
    if (this.wsChannel && this.wsChannel !== channel) {
      const old = this.wsChannel;
      // Вытеснение — best-effort с обоих концов: и уведомление, и само
      // закрытие транспорта могут бросить на уже оборвавшемся сокете,
      // а новое подключение из-за этого страдать не должно.
      try {
        old.send({ type: 'closed', reason: 'superseded' });
      } catch (err) {
        this.logger.warn('не удалось уведомить вытесняемое соединение', {
          sessionId: this.id,
          error: String(err),
        });
      }
      try {
        old.close(4009, 'superseded by new connection');
      } catch (err) {
        this.logger.warn('не удалось закрыть вытесняемое соединение', {
          sessionId: this.id,
          error: String(err),
        });
      }
    }
    this.wsChannel = channel;
    if (this.state === 'created') {
      if (!this.page) throw new Error('сессия не инициализирована');
      await this.streamFrom(this.page);
      this.state = 'streaming';
    }
  }

  detachWs(channel: WsChannel): void {
    if (this.wsChannel === channel) this.wsChannel = null;
  }

  /** CDP-сессия страницы, одна на страницу. Обработчик кадров вешается
   * здесь же — ровно один раз, и он сам проверяет, что страница всё ещё
   * активна: кадр, отправленный до того, как долетел `stopScreencast`,
   * иначе уехал бы в канвас поверх уже переключённой картинки. */
  private async cdpFor(page: RelayPage): Promise<RelayCdpSession> {
    const existing = this.cdpByPage.get(page);
    if (existing) return existing;

    const cdp = await page.target().createCDPSession();
    this.cdpByPage.set(page, cdp);

    cdp.on(
      'Page.screencastFrame',
      (params: {
        data: string;
        metadata: FrameMetadata;
        sessionId: number;
      }) => {
        // Подтверждать нужно ЛЮБОЙ кадр, даже отброшенный: без ack
        // Chromium перестаёт слать следующие, и страница, на которую
        // мы потом вернёмся, замерла бы навсегда.
        const ack = () =>
          cdp
            .send('Page.screencastFrameAck', { sessionId: params.sessionId })
            .catch((err) => {
              this.logger.warn('screencastFrameAck failed', {
                sessionId: this.id,
                error: String(err),
              });
            });
        if (this.cdp !== cdp) {
          ack();
          return;
        }
        this.notify({
          type: 'frame',
          data: params.data,
          metadata: params.metadata,
          frameAckId: params.sessionId,
        });
        ack();
      },
    );

    return cdp;
  }

  /** Подписки на страницу — ровно один раз на страницу (см. `wiredPages`). */
  private wirePage(page: RelayPage): void {
    if (this.wiredPages.has(page)) return;
    this.wiredPages.add(page);

    page.on('framenavigated', (frame) => {
      // Навигация неактивной страницы клиента не касается: он смотрит
      // не на неё, и `navigated` сбил бы ему показанный адрес.
      if (this.activePage !== page) return;
      if (frame !== page.mainFrame()) return;
      this.notify({ type: 'navigated', url: frame.url() });
    });

    page.on('popup', (popup) => {
      if (!popup) return;
      this.handlePopup(popup);
    });
  }

  /**
   * Попап открылся — показать его человеку и отдать ему ввод.
   *
   * §9 основного ТЗ остаётся в силе: реле не запрещает чужой домен, а
   * показывает его. Клиент узнаёт об этом обычным `navigated` — новых
   * сообщений протокола не понадобилось, а фронтенд уже показывает
   * адрес, чтобы человек видел, на каком он сайте.
   */
  private handlePopup(popup: RelayPage): void {
    // Попап мог открыться в момент финализации или принудительного
    // закрытия: стартовать скринкаст на умирающем браузере нельзя —
    // CDP ответит «Session closed», и отклонение улетело бы в никуда.
    if (this.state !== 'streaming') return;

    popup.on('close', () => {
      // Возвращаемся, только если смотрели именно на него: попап мог
      // закрыться уже после того, как поверх открылся следующий.
      if (this.activePage !== popup) return;
      if (this.state !== 'streaming') return;
      const main = this.page;
      if (!main) return;
      void this.streamFrom(main).catch((err) => {
        this.logger.warn('возврат на главную страницу не удался', {
          sessionId: this.id,
          error: String(err),
        });
      });
    });

    void this.streamFrom(popup).catch((err) => {
      this.logger.warn('переключение на попап не удалось', {
        sessionId: this.id,
        error: String(err),
      });
    });
  }

  /**
   * Сделать страницу активной: стрим и ввод уходят на неё.
   *
   * Скринкаст всегда ровно один. Две одновременно стримящие страницы
   * слали бы кадры вперемешку в один и тот же `<canvas>` на клиенте —
   * картинка мигала бы между сайтом заказчика и окном входа.
   */
  private async streamFrom(page: RelayPage): Promise<void> {
    // Подписки ставятся здесь, а не у вызывающих: так нельзя сделать
    // страницу активной, забыв её подписать. Повторный вызов безвреден
    // — `wirePage` идемпотентен, и это не украшение: возврат с попапа
    // на главную приходит сюда ВТОРОЙ раз для той же страницы, и без
    // защиты на ней оказалось бы два обработчика `framenavigated`, то
    // есть каждый переход уезжал бы клиенту дважды.
    this.wirePage(page);
    const previous = this.cdp;
    const cdp = await this.cdpFor(page);

    // Переключаем указатель ДО остановки предыдущего скринкаста:
    // обработчик кадров сверяется именно с ним, и кадры, уже летящие
    // от старой страницы, будут отброшены, а не нарисованы поверх.
    this.activePage = page;
    this.cdp = cdp;

    if (previous && previous !== cdp) {
      await previous.send('Page.stopScreencast').catch((err) => {
        this.logger.warn('stopScreencast failed', {
          sessionId: this.id,
          error: String(err),
        });
      });
    }

    // Тот же вызов и те же флаги, что в `resize()` — намеренно: размер
    // попапа обязан совпадать с тем, под который клиент рисует канвас.
    // (Расхождение `mobile:false` здесь и `isMobile:true` в стартовом
    // вьюпорте — пререквизит, существовавший до этой правки; трогать
    // его в этой задаче не стал.)
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: this.viewport.width,
      height: this.viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
    });

    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60 });

    // Адрес новой страницы — сразу, не дожидаясь её навигации: попап
    // открывается уже на нужном URL, и `framenavigated` по нему может
    // не прийти вовсе.
    this.notify({ type: 'navigated', url: page.url() });
  }

  /** §9 основного ТЗ — реле НЕ блокирует/откатывает навигацию, только
   * ретранслирует ввод и информирует фронтенд через 'navigated'. */
  async dispatchMouse(params: {
    event: string;
    x: number;
    y: number;
    button?: string;
    deltaX?: number;
    deltaY?: number;
  }): Promise<void> {
    if (!this.cdp) return;
    if (params.event === 'mouseWheel') this.inputCounts.wheel += 1;
    else this.inputCounts.mouse += 1;
    // Найдено аудитом этапа 108 — три отклонения от того, как те же
    // события формирует сам puppeteer (`Mouse.down/up/move`,
    // `puppeteer-core/lib/cjs/puppeteer/cdp/Input.js:265-330`), и все
    // три бьют ровно по главному сценарию фичи — человек руками
    // проходит форму входа и капчу:
    //  - `clickCount` ставился ТОЛЬКО на `mousePressed`. Для CDP
    //    `mouseReleased` с clickCount:0 — это отпускание без клика, и
    //    страница может не получить событие `click` вовсе (Chromium
    //    синтезирует его по паре press/release с одинаковым ненулевым
    //    clickCount). Клик «в никуда» по кнопке «Войти» — худший из
    //    возможных багов здесь.
    //  - `button` подставлялся `'left'` ДАЖЕ для `mouseMoved`, то есть
    //    любое движение курсора выглядело для страницы как движение с
    //    зажатой левой кнопкой (выделение текста, drag'n'drop).
    //  - Не передавался `buttons` — битовая маска СЕЙЧАС зажатых
    //    кнопок. Именно по ней страница отличает «курсор просто
    //    проехал» от «тащат». Без неё ползунковые/пазл-капчи (а это
    //    ровно то, ради чего нужен живой человек) нерешаемы в принципе:
    //    у `mousedown`/`mousemove` в обработчике страницы
    //    `e.buttons === 0`.
    // Поэтому маска пишется в состояние сессии по press/release, и
    // `button` для движения выводится из неё — тем же способом, что
    // `getButtonFromPressedButtons()` у puppeteer.
    const flag = MOUSE_BUTTON_FLAGS[params.button ?? 'left'] ?? 0;
    let button: string;
    let clickCount = 0;
    if (params.event === 'mousePressed') {
      this.pressedButtons |= flag;
      button = params.button ?? 'left';
      clickCount = 1;
    } else if (params.event === 'mouseReleased') {
      this.pressedButtons &= ~flag;
      button = params.button ?? 'left';
      clickCount = 1;
    } else {
      button = buttonFromMask(this.pressedButtons);
    }
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: params.event,
      x: params.x,
      y: params.y,
      button,
      buttons: this.pressedButtons,
      clickCount,
      deltaX: params.deltaX,
      deltaY: params.deltaY,
    });
  }

  async dispatchKey(params: {
    event: string;
    key: string;
    code: string;
    text?: string;
    keyCode?: number;
  }): Promise<void> {
    if (!this.cdp) return;
    this.inputCounts.key += 1;
    await this.cdp.send('Input.dispatchKeyEvent', {
      type: params.event,
      key: params.key,
      code: params.code,
      text: params.text,
      // Без этих двух полей Chromium отдаёт странице
      // `event.keyCode === 0`. `key`/`code` — современные свойства, но
      // масса живого кода на чужих сайтах (включая виджет входа
      // Telegram) до сих пор читает устаревший `keyCode`, и для неё
      // клавиатура выглядела мёртвой: события приходят, а значение
      // нулевое. puppeteer подставляет их всегда (`cdp/Input.js`), и
      // здесь ровно тот же приём. Значение берётся с клавиатуры
      // человека, а не угадывается по `key`.
      windowsVirtualKeyCode: params.keyCode,
      nativeVirtualKeyCode: params.keyCode,
    });
  }

  async resize(width: number, height: number): Promise<void> {
    // Запоминаем ВСЕГДА, даже если применить некуда: значение нужно
    // попапу, который откроется позже (см. `streamFrom`).
    this.viewport = { width, height };
    if (!this.cdp) return;
    await this.cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  /**
   * `GET /sessions/:id/result` — снимает куки со всего контекста,
   * закрывает браузер, переводит в finalizing→closed. Идемпотентно
   * (§7.2 спеки): повторный вызов после завершения первого просто
   * возвращает cachedResult; ДВА ОДНОВРЕМЕННЫХ вызова (до того, как
   * первый успел закэшировать результат) дедуплицируются через
   * finalizingPromise — без этого второй параллельный вызов запустил бы
   * второй снимок кук/второе закрытие браузера поверх первого.
   *
   * Гонка с close() (найдено аудитом, §5 спеки): если сессию уже
   * ПРИНУДИТЕЛЬНО закрыли (таймаут/DELETE/shutdown) — close() успел
   * выставить state='closed' синхронно, ДО отдачи управления — то
   * finalize() не должен молча вернуть "успешный" результат с пустыми
   * куками поверх уже закрытого браузера: это ввело бы вызывающего в
   * заблуждение. Вместо этого — явная ошибка.
   */
  async finalize(): Promise<SessionResult> {
    if (this.cachedResult) return this.cachedResult;
    if (this.state === 'closed') {
      throw new SessionAlreadyClosedError(
        'сессия уже принудительно закрыта, финализация невозможна',
      );
    }
    if (this.finalizingPromise) return this.finalizingPromise;
    this.finalizingPromise = this.doFinalize();
    try {
      return await this.finalizingPromise;
    } finally {
      this.finalizingPromise = null;
    }
  }

  /**
   * Всё тело — в `try/finally`, где `finally` гасит браузер и уводит
   * сессию в `closed` (найдено вторым проходом аудита этапа 108).
   * Раньше `closeBrowser()` стоял на прямом пути: любое исключение
   * ВЫШЕ него — `page.url()` на уже упавшей странице, `ws.send()` в
   * оборвавшееся соединение — оставляло сессию в состоянии
   * `finalizing` с ЖИВЫМ процессом Chromium, а менеджер тем временем
   * уже снял wall/idle-таймеры и через `resultCacheMs` просто удалял
   * запись из `Map`. Браузер в этот момент терял последнюю ссылку на
   * себя и оставался висеть в контейнере навсегда — ровно та утечка,
   * что и при неудачном старте сессии, только с другого конца
   * жизненного цикла.
   */
  private async doFinalize(): Promise<SessionResult> {
    this.state = 'finalizing';
    let result: SessionResult = { cookies: [], finalUrl: '' };
    try {
      result = await this.harvest();
      this.notify({ type: 'closed', reason: 'finalized' });
    } finally {
      await this.closeBrowser();
      this.state = 'closed';
      this.closedAt = Date.now();
    }
    this.cachedResult = result;
    return result;
  }

  /** Снятие cookie jar со ВСЕГО контекста (§7.4.5 основного ТЗ — не
   * `page.cookies()`, который отдал бы только текущий домен и потерял бы
   * куки SSO-провайдера) плюс текущий URL. Отдельный метод, потому что
   * с этапа 109 он нужен ДВУМ путям: штатной финализации и истечению
   * таймаута (см. `close()`). */
  private async harvest(): Promise<SessionResult> {
    let cookies: CdpCookie[] = [];
    if (this.cdp) {
      try {
        const res = (await this.cdp.send('Network.getAllCookies')) as {
          cookies: CdpCookie[];
        };
        cookies = res.cookies;
      } catch (err) {
        this.logger.warn('collecting cookies failed', {
          sessionId: this.id,
          error: String(err),
        });
      }
    }
    return { cookies, finalUrl: this.page?.url() ?? '' };
  }

  /** Принудительное закрытие — таймауты/DELETE/shutdown, НЕ штатное
   * завершение (то делает finalize()). Идемпотентно.
   *
   * Гонка с finalize() (найдено аудитом): если finalize() уже в процессе
   * (finalizingPromise выставлен), close() не должен параллельно тоже
   * гасить браузер/страницу — closeBrowser() не рассчитан на конкурентный
   * вызов из двух мест и лучший случай тут — просто дождаться finalize()
   * и вернуться (сессия и так закрывается). А `state`/`closedAt`
   * выставляются СИНХРОННО, до первого await — иначе окно между входом в
   * close() и первым await оставляло бы state==='created'/'streaming' на
   * протяжении первого тика, и второй одновременный вызов close() (или
   * finalize(), см. его собственную проверку) мог бы проскочить эту
   * проверку и тоже начать закрывать браузер. */
  async close(reason: CloseReason): Promise<void> {
    if (this.state === 'closed') return;
    if (this.finalizingPromise) {
      await this.finalizingPromise.catch(() => undefined);
      return;
    }
    const wasStreaming = this.state === 'streaming';
    this.state = 'closed';
    this.closedAt = Date.now();
    this.notify({ type: 'closed', reason });
    // Куки снимаются ДАЖЕ при истечении таймаута (этап 109, находка
    // аудита бизнес-процесса). Раньше wall/idle-таймаут просто гасил
    // браузер, и `GET /result` после него отвечал 410 — то есть человек,
    // который честно прошёл капчу и 2FA, но нажал «Готово, я вошёл»
    // на секунду позже потолка, терял ВСЮ работу: куки, ради которых
    // всё и затевалось, уже уничтожены вместе с браузером, а повторный
    // live-вход — это ещё одна минута его живого времени (§7.2 спеки
    // ровно про эту цену). Снимок стоит один CDP-вызов, а окно
    // `RESULT_CACHE_MS` и так уже существует — backend, пришедший за
    // результатом чуть позже, теперь получит его, а не пустой отказ.
    //
    // Только из `streaming`: в `created` (WS ещё не подключался)
    // человека за рулём не было вовсе, снимать нечего. И только для
    // таймаутов: `cancelled` — это явная отмена пользователем, а
    // `server-shutdown` кэширует результат в память процесса, который
    // прямо сейчас завершается.
    if (
      wasStreaming &&
      (reason === 'wall-timeout' || reason === 'idle-timeout')
    ) {
      try {
        this.cachedResult = await this.harvest();
      } catch (err) {
        this.logger.warn('снять куки при истечении таймаута не удалось', {
          sessionId: this.id,
          error: String(err),
        });
      }
    }
    await this.closeBrowser();
  }

  private async closeBrowser(): Promise<void> {
    // Итог по вводу — здесь, а не в `close()`/`doFinalize()` по
    // отдельности: `closeBrowser()` зовут оба пути и ровно один раз.
    this.logger.info('итог ввода за сессию', {
      sessionId: this.id,
      mouse: this.inputCounts.mouse,
      wheel: this.inputCounts.wheel,
      key: this.inputCounts.key,
    });
    try {
      await this.page?.close();
    } catch {
      /* best effort — страница могла уже упасть сама */
    }
    try {
      await this.browser.close();
    } catch {
      /* best effort — тот же довод */
    }
  }

  get closedAtMs(): number | null {
    return this.closedAt;
  }
}
