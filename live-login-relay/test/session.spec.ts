/**
 * Регрессионные тесты на баги, найденные аудитом (см. комментарии в
 * src/session.ts у attachWs()/close()/finalize()): вытеснение старого WS
 * при новом подключении и гонка close()/finalize().
 */

import { createLogger } from '../src/logger';
import {
  Session,
  SessionAlreadyClosedError,
  type RelayBrowser,
  type RelayCdpSession,
  type RelayFrame,
  type RelayPage,
  type WsChannel,
} from '../src/session';

const logger = createLogger('error');

function makeFakeBrowser(): {
  browser: RelayBrowser;
  page: RelayPage;
  cdp: RelayCdpSession;
} {
  const frame: RelayFrame = { url: () => 'https://example.com/' };
  const cdp: RelayCdpSession = {
    send: jest.fn().mockResolvedValue({ cookies: [] }),
    on: jest.fn(),
  };
  const page: RelayPage = {
    goto: jest.fn().mockResolvedValue(undefined),
    url: () => 'https://example.com/',
    target: () => ({ createCDPSession: () => Promise.resolve(cdp) }),
    on: jest.fn(),
    mainFrame: () => frame,
    close: jest.fn().mockResolvedValue(undefined),
  };
  const browser: RelayBrowser = {
    newPage: jest.fn().mockResolvedValue(page),
    close: jest.fn().mockResolvedValue(undefined),
  };
  return { browser, page, cdp };
}

function makeChannel(): WsChannel {
  return { send: jest.fn(), close: jest.fn() };
}

async function makeSession(): Promise<{
  session: Session;
  browser: RelayBrowser;
  page: RelayPage;
}> {
  const { browser, page } = makeFakeBrowser();
  const session = await Session.create({
    startUrl: 'https://example.com/login',
    allowedOrigin: 'https://example.com',
    browser,
    logger,
    navTimeoutMs: 20_000,
  });
  return { session, browser, page };
}

describe('Session — attachWs supersede (Bug A)', () => {
  it('both notifies AND closes the transport of a superseded connection', async () => {
    const { session } = await makeSession();
    const first = makeChannel();
    const second = makeChannel();

    await session.attachWs(first);
    await session.attachWs(second);

    expect(first.send).toHaveBeenCalledWith({
      type: 'closed',
      reason: 'superseded',
    });
    // Без фикса тут вызывался бы только send() — транспорт оставался бы
    // технически живым, и ввод со старой вкладки продолжал бы долетать
    // до dispatchMouse/dispatchKey наравне с новой.
    expect(first.close).toHaveBeenCalledWith(4009, expect.any(String));
    expect(second.close).not.toHaveBeenCalled();
  });

  it('does not close the same channel when attachWs is called again with it', async () => {
    const { session } = await makeSession();
    const channel = makeChannel();

    await session.attachWs(channel);
    await session.attachWs(channel);

    expect(channel.close).not.toHaveBeenCalled();
  });
});

describe('Session — close()/finalize() race (Bug B)', () => {
  it('finalize() throws SessionAlreadyClosedError once the session was force-closed', async () => {
    const { session } = await makeSession();
    session.state = 'streaming';

    await session.close('cancelled');

    await expect(session.finalize()).rejects.toBeInstanceOf(
      SessionAlreadyClosedError,
    );
  });

  it('close() defers to an in-flight finalize() instead of closing the browser twice', async () => {
    const { session, browser, page } = await makeSession();
    session.state = 'streaming';

    const finalizePromise = session.finalize();
    // В этот момент session.state уже 'finalizing' и finalizingPromise уже
    // выставлен — синхронная часть doFinalize() успела отработать до
    // своего первого await, до того как управление вернулось сюда.
    const closePromise = session.close('cancelled');

    await Promise.all([finalizePromise, closePromise]);

    // closeBrowser() должен быть вызван РОВНО один раз — из doFinalize(),
    // а не ещё раз параллельно из close(). Без фикса close() гасил бы
    // браузер второй раз поверх уже гасящегося первого.
    expect(page.close).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(session.state).toBe('closed');
  });

  it('close() is a no-op once the session is already closed', async () => {
    const { session, browser } = await makeSession();
    session.state = 'streaming';

    await session.close('cancelled');
    await session.close('cancelled');

    expect(browser.close).toHaveBeenCalledTimes(1);
  });
});

/**
 * Регрессия аудита этапа 108 — параметры CDP-события мыши. Оба случая
 * бьют по главному сценарию фичи (человек кликает по форме входа и
 * водит пальцем по экрану), но заметны только на живой странице, а не в
 * логах реле: клик «не засчитывается», а движение выглядит как
 * перетаскивание с зажатой кнопкой.
 */
describe('Session — параметры Input.dispatchMouseEvent (этап 108)', () => {
  async function streamingSession(): Promise<{
    session: Session;
    cdp: RelayCdpSession;
  }> {
    const { browser, cdp } = makeFakeBrowser();
    const session = await Session.create({
      startUrl: 'https://example.com/login',
      allowedOrigin: 'https://example.com',
      browser,
      logger,
      navTimeoutMs: 20_000,
    });
    await session.attachWs(makeChannel());
    return { session, cdp };
  }

  it('mouseReleased тоже получает clickCount:1 — иначе страница не увидит click', async () => {
    const { session, cdp } = await streamingSession();
    await session.dispatchMouse({ event: 'mouseReleased', x: 10, y: 20 });
    expect(cdp.send).toHaveBeenCalledWith(
      'Input.dispatchMouseEvent',
      expect.objectContaining({
        type: 'mouseReleased',
        clickCount: 1,
        button: 'left',
      }),
    );
  });

  it('mouseMoved идёт с button:"none" и clickCount:0 — это не перетаскивание', async () => {
    const { session, cdp } = await streamingSession();
    await session.dispatchMouse({ event: 'mouseMoved', x: 5, y: 6 });
    expect(cdp.send).toHaveBeenCalledWith(
      'Input.dispatchMouseEvent',
      expect.objectContaining({
        type: 'mouseMoved',
        button: 'none',
        clickCount: 0,
      }),
    );
  });

  it('явно указанная кнопка сохраняется для нажатия', async () => {
    const { session, cdp } = await streamingSession();
    await session.dispatchMouse({
      event: 'mousePressed',
      x: 1,
      y: 2,
      button: 'right',
    });
    expect(cdp.send).toHaveBeenCalledWith(
      'Input.dispatchMouseEvent',
      expect.objectContaining({ button: 'right', clickCount: 1 }),
    );
  });
});

/**
 * Второй проход аудита этапа 108: перетаскивание. Первый фикс параметров
 * мыши чинил `clickCount`, но заодно ЖЁСТКО слал `button:'none'` на
 * движение и вовсе не слал маску `buttons` — а именно по ней страница
 * отличает «курсор проехал» от «тащат». Ползунковые/пазл-капчи (ровно
 * то, ради чего эта фича и существует) без этого нерешаемы.
 */
describe('Session — перетаскивание мышью (этап 108, второй проход)', () => {
  async function streaming(): Promise<{
    session: Session;
    cdp: RelayCdpSession;
  }> {
    const { browser, cdp } = makeFakeBrowser();
    const session = await Session.create({
      startUrl: 'https://example.com/login',
      allowedOrigin: 'https://example.com',
      browser,
      logger,
      navTimeoutMs: 20_000,
    });
    await session.attachWs(makeChannel());
    return { session, cdp };
  }

  function lastMouseCall(cdp: RelayCdpSession): Record<string, unknown> {
    const calls = (cdp.send as jest.Mock).mock.calls.filter(
      (c) => c[0] === 'Input.dispatchMouseEvent',
    );
    return calls[calls.length - 1][1] as Record<string, unknown>;
  }

  it('движение с зажатой кнопкой несёт buttons:1 и button:"left"', async () => {
    const { session, cdp } = await streaming();
    await session.dispatchMouse({ event: 'mousePressed', x: 10, y: 10 });
    await session.dispatchMouse({ event: 'mouseMoved', x: 60, y: 10 });
    expect(lastMouseCall(cdp)).toMatchObject({
      type: 'mouseMoved',
      buttons: 1,
      button: 'left',
    });
  });

  it('после отпускания движение снова «свободное» (buttons:0, button:"none")', async () => {
    const { session, cdp } = await streaming();
    await session.dispatchMouse({ event: 'mousePressed', x: 10, y: 10 });
    await session.dispatchMouse({ event: 'mouseReleased', x: 60, y: 10 });
    await session.dispatchMouse({ event: 'mouseMoved', x: 70, y: 10 });
    expect(lastMouseCall(cdp)).toMatchObject({
      type: 'mouseMoved',
      buttons: 0,
      button: 'none',
    });
  });

  it('правая кнопка отражается своим флагом маски', async () => {
    const { session, cdp } = await streaming();
    await session.dispatchMouse({
      event: 'mousePressed',
      x: 1,
      y: 1,
      button: 'right',
    });
    expect(lastMouseCall(cdp)).toMatchObject({ buttons: 2, button: 'right' });
  });
});

describe('Session — finalize устойчив к мёртвому WS (этап 108)', () => {
  it('отдаёт куки и закрывает браузер, даже если отправка "closed" в WS бросила', async () => {
    const { browser } = makeFakeBrowser();
    const session = await Session.create({
      startUrl: 'https://example.com/login',
      allowedOrigin: 'https://example.com',
      browser,
      logger,
      navTimeoutMs: 20_000,
    });
    const badChannel: WsChannel = {
      send: jest.fn(() => {
        throw new Error('WebSocket is not open');
      }),
      close: jest.fn(),
    };
    await session.attachWs(badChannel);

    // Куки УЖЕ собраны — это и есть весь смысл операции, и терять их
    // из-за оборвавшегося сокета нельзя: повторный live-вход стоит
    // человеку ещё одной минуты живого времени. Уведомление по WS —
    // best-effort, результат — нет.
    const result = await session.finalize();
    expect(result).toEqual({ cookies: [], finalUrl: 'https://example.com/' });
    // И процесс Chromium при этом не остался жить.
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(session.state).toBe('closed');
  });
});

/**
 * Этап 109 — стартовые параметры страницы. Обе величины видны только на
 * живой странице чужого сайта: реле в логах выглядит одинаково, а
 * человек либо получает мобильную вёрстку формы входа, либо десктопную
 * на телефоне; и либо ждёт ответа `POST /sessions` 20 секунд, либо все
 * 30 (умолчание puppeteer), пережив таймаут вызывающего backend'а.
 */
describe('Session.create — вьюпорт и таймаут навигации (этап 109)', () => {
  it('ставит мобильный вьюпорт и явный таймаут goto', async () => {
    const { browser } = makeFakeBrowser();
    const page = await browser.newPage();
    (browser.newPage as jest.Mock).mockResolvedValue(page);
    const setViewport = jest.fn().mockResolvedValue(undefined);
    (page as RelayPage).setViewport = setViewport;

    await Session.create({
      startUrl: 'https://example.com/login',
      allowedOrigin: 'https://example.com',
      browser,
      logger,
      navTimeoutMs: 20_000,
    });

    expect(setViewport).toHaveBeenCalledWith(
      expect.objectContaining({ width: 390, height: 844, isMobile: true }),
    );
    expect(page.goto).toHaveBeenCalledWith('https://example.com/login', {
      timeout: 20_000,
    });
  });

  it('работает и с моком без setViewport (поле необязательное)', async () => {
    const { browser } = makeFakeBrowser();
    await expect(
      Session.create({
        startUrl: 'https://example.com/login',
        allowedOrigin: 'https://example.com',
        browser,
        logger,
        navTimeoutMs: 20_000,
      }),
    ).resolves.toBeInstanceOf(Session);
  });
});

/**
 * Попапы (Telegram Login Widget, «Sign in with Google», Apple ID).
 *
 * До этой правки реле водило ровно одну вкладку: `browser.newPage()`,
 * скринкаст привязан к её CDP-сессии, обработчиков `popup`/
 * `targetcreated` не было вовсе. Попап открывался внутри серверного
 * Chromium отдельным таргетом, который никуда не транслировался и
 * никуда не принимал ввод — снаружи это выглядело как «кнопка входа не
 * работает». Логин через попап не мог пройти в принципе.
 */

interface FakePage {
  page: RelayPage;
  cdp: RelayCdpSession;
  sent: { method: string; params?: Record<string, unknown> }[];
  handlerCount(event: string): number;
  emit(event: string, arg?: unknown): void;
  emitFrame(data: string, frameSessionId: number): void;
  navigate(to: string): void;
}

function makeFakePage(initialUrl: string): FakePage {
  const handlers = new Map<string, ((arg: unknown) => void)[]>();
  const sent: { method: string; params?: Record<string, unknown> }[] = [];
  let frameHandler: ((p: unknown) => void) | null = null;
  let current = initialUrl;

  const cdp: RelayCdpSession = {
    send: jest.fn(async (method: string, params?: Record<string, unknown>) => {
      sent.push({ method, params });
      if (method === 'Network.getAllCookies') return { cookies: [] };
      return undefined;
    }),
    on: (event: string, handler: (p: unknown) => void) => {
      if (event === 'Page.screencastFrame') frameHandler = handler;
    },
  };

  const frame: RelayFrame = { url: () => current };
  const page = {
    goto: jest.fn().mockResolvedValue(undefined),
    setViewport: jest.fn().mockResolvedValue(undefined),
    url: () => current,
    target: () => ({ createCDPSession: () => Promise.resolve(cdp) }),
    on: (event: string, handler: (arg: unknown) => void) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    mainFrame: () => frame,
    close: jest.fn().mockResolvedValue(undefined),
  } as unknown as RelayPage;

  return {
    page,
    cdp,
    sent,
    handlerCount: (event) => (handlers.get(event) ?? []).length,
    emit: (event, arg) =>
      [...(handlers.get(event) ?? [])].forEach((h) => h(arg)),
    emitFrame: (data, frameSessionId) =>
      frameHandler?.({ data, metadata: {}, sessionId: frameSessionId }),
    navigate: (to) => {
      current = to;
    },
  };
}

/** Переключение на попап идёт через `void this.streamFrom(...)` внутри
 * синхронного обработчика события — дождаться его можно только сменой
 * макрозадачи, микротасков там несколько. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const MAIN_URL = 'https://shop.example.com/login';
const POPUP_URL = 'https://oauth.telegram.org/auth?bot_id=1';

async function makePopupSession(): Promise<{
  session: Session;
  main: FakePage;
  channel: WsChannel;
  sentMessages(): { type: string; [k: string]: unknown }[];
}> {
  const main = makeFakePage(MAIN_URL);
  const browser: RelayBrowser = {
    newPage: jest.fn().mockResolvedValue(main.page),
    close: jest.fn().mockResolvedValue(undefined),
  };
  const session = await Session.create({
    startUrl: MAIN_URL,
    allowedOrigin: 'https://shop.example.com',
    browser,
    logger,
    navTimeoutMs: 20_000,
  });
  const channel = makeChannel();
  await session.attachWs(channel);
  const sentMessages = () =>
    (channel.send as jest.Mock).mock.calls.map(
      (c) => c[0] as { type: string; [k: string]: unknown },
    );
  return { session, main, channel, sentMessages };
}

describe('Session — итог ввода в логе', () => {
  it('считает колесо отдельно от обычной мыши и пишет итог при закрытии', async () => {
    // Ровно тот факт, которого не хватило при разборе «прокрутка не
    // работает»: по логам было не отличить «клиент не шлёт колесо» от
    // «шлёт, а страница не реагирует».
    const lines: { msg: string; extra?: Record<string, unknown> }[] = [];
    const spy = jest.spyOn(logger, 'info').mockImplementation((msg, extra) => {
      lines.push({ msg, extra });
    });
    try {
      const { session } = await makePopupSession();
      await session.dispatchMouse({ event: 'mousePressed', x: 1, y: 1 });
      await session.dispatchMouse({
        event: 'mouseWheel',
        x: 1,
        y: 1,
        deltaY: 40,
      });
      await session.dispatchMouse({
        event: 'mouseWheel',
        x: 1,
        y: 1,
        deltaY: 40,
      });
      await session.dispatchKey({ event: 'keyDown', key: 'a', code: 'KeyA' });
      await session.close('cancelled');

      const summary = lines.find((l) => l.msg === 'итог ввода за сессию');
      expect(summary?.extra).toMatchObject({ mouse: 1, wheel: 2, key: 1 });
    } finally {
      spy.mockRestore();
    }
  });

  it('итог пишется ровно один раз, даже если close() звали дважды', async () => {
    const lines: string[] = [];
    const spy = jest.spyOn(logger, 'info').mockImplementation((msg) => {
      lines.push(msg);
    });
    try {
      const { session } = await makePopupSession();
      await session.close('cancelled');
      await session.close('cancelled');
      expect(lines.filter((m) => m === 'итог ввода за сессию')).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('Session — keyCode в CDP', () => {
  it('keyCode уезжает обоими полями виртуального кода', () => {
    // Chromium выводит `event.keyCode` именно из
    // `windowsVirtualKeyCode`; без него страница видит ноль.
    return (async () => {
      const { session, main } = await makePopupSession();
      await session.dispatchKey({
        event: 'keyDown',
        key: 'u',
        code: 'KeyU',
        text: 'u',
        keyCode: 85,
      });
      expect(main.sent).toContainEqual({
        method: 'Input.dispatchKeyEvent',
        params: {
          type: 'keyDown',
          key: 'u',
          code: 'KeyU',
          text: 'u',
          windowsVirtualKeyCode: 85,
          nativeVirtualKeyCode: 85,
        },
      });
      await session.close('cancelled');
    })();
  });
});

describe('Session — попапы SSO', () => {
  it('попап становится активным: стрим переезжает на него', async () => {
    const { session, main, sentMessages } = await makePopupSession();
    const popup = makeFakePage(POPUP_URL);

    main.emit('popup', popup.page);
    await settle();

    expect(main.sent.map((c) => c.method)).toContain('Page.stopScreencast');
    expect(popup.sent.map((c) => c.method)).toContain('Page.startScreencast');
    expect(sentMessages()).toContainEqual({
      type: 'navigated',
      url: POPUP_URL,
    });
    await session.close('cancelled');
  });

  it('ввод после переключения уходит в попап, а не в главную', async () => {
    const { session, main } = await makePopupSession();
    const popup = makeFakePage(POPUP_URL);
    main.emit('popup', popup.page);
    await settle();

    const mainBefore = main.sent.length;
    await session.dispatchKey({
      event: 'keyDown',
      key: 'a',
      code: 'KeyA',
      text: 'a',
    });

    expect(popup.sent.map((c) => c.method)).toContain('Input.dispatchKeyEvent');
    expect(main.sent.length).toBe(mainBefore);
    await session.close('cancelled');
  });

  it('finalUrl остаётся у ГЛАВНОЙ страницы, пока активен попап', async () => {
    // Смысл всей развязки page/activePage. Бэкенд в completeLiveLogin
    // делает assertSameOrigin(draft.baseUrl, result.finalUrl) — если
    // пустить finalUrl за попапом, каждый вход через Telegram
    // заканчивался бы на oauth.telegram.org и отвергался бы с «вход не
    // завершён», то есть человек прошёл бы логин и получил отказ.
    const { session, main } = await makePopupSession();
    const popup = makeFakePage(POPUP_URL);
    main.emit('popup', popup.page);
    await settle();

    const result = await session.finalize();

    expect(result.finalUrl).toBe(MAIN_URL);
    expect(result.finalUrl).not.toContain('oauth.telegram.org');
  });

  it('закрытие попапа возвращает стрим на главную', async () => {
    const { session, main, sentMessages } = await makePopupSession();
    const popup = makeFakePage(POPUP_URL);
    main.emit('popup', popup.page);
    await settle();

    const mainStartsBefore = main.sent.filter(
      (c) => c.method === 'Page.startScreencast',
    ).length;
    popup.emit('close');
    await settle();

    expect(
      main.sent.filter((c) => c.method === 'Page.startScreencast').length,
    ).toBe(mainStartsBefore + 1);
    expect(popup.sent.map((c) => c.method)).toContain('Page.stopScreencast');
    expect(sentMessages().filter((m) => m.type === 'navigated')).toContainEqual(
      { type: 'navigated', url: MAIN_URL },
    );
    await session.close('cancelled');
  });

  it('кадр неактивной страницы не уходит клиенту, но подтверждается', async () => {
    // Без ack Chromium перестаёт слать следующие кадры — страница, на
    // которую мы потом вернёмся, замерла бы навсегда.
    const { session, main, sentMessages } = await makePopupSession();
    const popup = makeFakePage(POPUP_URL);
    main.emit('popup', popup.page);
    await settle();

    const framesBefore = sentMessages().filter(
      (m) => m.type === 'frame',
    ).length;
    main.emitFrame('опоздавший-кадр', 77);
    await settle();

    expect(sentMessages().filter((m) => m.type === 'frame').length).toBe(
      framesBefore,
    );
    expect(main.sent).toContainEqual({
      method: 'Page.screencastFrameAck',
      params: { sessionId: 77 },
    });
    await session.close('cancelled');
  });

  it('кадр активного попапа доезжает до клиента', async () => {
    const { session, main, sentMessages } = await makePopupSession();
    const popup = makeFakePage(POPUP_URL);
    main.emit('popup', popup.page);
    await settle();

    popup.emitFrame('кадр-попапа', 5);

    expect(sentMessages()).toContainEqual(
      expect.objectContaining({ type: 'frame', data: 'кадр-попапа' }),
    );
    await session.close('cancelled');
  });

  it('размер из resize переносится на попап', async () => {
    // puppeteer даёт попапу ДЕФОЛТНЫЙ вьюпорт браузера, а не
    // родительский: без переноса человек с телефона увидел бы в окне
    // входа десктопную вёрстку.
    const { session, main } = await makePopupSession();
    await session.resize(360, 640);
    const popup = makeFakePage(POPUP_URL);
    main.emit('popup', popup.page);
    await settle();

    expect(popup.sent).toContainEqual({
      method: 'Emulation.setDeviceMetricsOverride',
      params: { width: 360, height: 640, deviceScaleFactor: 1, mobile: false },
    });
    await session.close('cancelled');
  });

  it('попап после закрытия сессии игнорируется', async () => {
    // Скринкаст на умирающем браузере — CDP ответит «Session closed», а
    // отклонение улетело бы необработанным.
    const { session, main } = await makePopupSession();
    await session.close('cancelled');

    const popup = makeFakePage(POPUP_URL);
    main.emit('popup', popup.page);
    await settle();

    expect(popup.sent).toEqual([]);
  });

  it('попап, открытый из попапа, тоже подхватывается', async () => {
    const { session, main } = await makePopupSession();
    const first = makeFakePage(POPUP_URL);
    main.emit('popup', first.page);
    await settle();

    const second = makeFakePage('https://accounts.google.com/');
    first.emit('popup', second.page);
    await settle();

    expect(second.sent.map((c) => c.method)).toContain('Page.startScreencast');
    await session.close('cancelled');
  });

  it('возврат на главную не подписывается на неё второй раз', async () => {
    // Иначе каждый цикл «попап открылся — закрылся» добавлял бы ещё
    // один обработчик framenavigated, и адрес уезжал бы клиенту N раз.
    const { session, main, sentMessages } = await makePopupSession();
    const popup = makeFakePage(POPUP_URL);
    main.emit('popup', popup.page);
    await settle();
    popup.emit('close');
    await settle();

    expect(main.handlerCount('framenavigated')).toBe(1);

    const before = sentMessages().filter((m) => m.type === 'navigated').length;
    main.emit('framenavigated', main.page.mainFrame());
    expect(sentMessages().filter((m) => m.type === 'navigated').length).toBe(
      before + 1,
    );
    await session.close('cancelled');
  });

  it('навигация НЕактивной страницы клиенту не уходит', async () => {
    const { session, main, sentMessages } = await makePopupSession();
    const popup = makeFakePage(POPUP_URL);
    main.emit('popup', popup.page);
    await settle();

    const before = sentMessages().filter((m) => m.type === 'navigated').length;
    main.navigate('https://shop.example.com/cabinet');
    main.emit('framenavigated', main.page.mainFrame());

    expect(sentMessages().filter((m) => m.type === 'navigated').length).toBe(
      before,
    );
    await session.close('cancelled');
  });
});
