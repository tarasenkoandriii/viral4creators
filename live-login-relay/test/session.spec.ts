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
