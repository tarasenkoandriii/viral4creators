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
