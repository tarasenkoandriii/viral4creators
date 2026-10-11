import { closeOwnedBrowser } from './browser-cleanup';

describe('owned Chromium cleanup', () => {
  afterEach(() => jest.useRealTimers());

  it('does not kill an exited child after graceful close', async () => {
    const kill = jest.fn();
    await closeOwnedBrowser({
      close: async () => undefined,
      process: () => ({ exitCode: 0, kill }),
    });
    expect(kill).not.toHaveBeenCalled();
  });

  it('terminates the owned child when CDP close hangs', async () => {
    jest.useFakeTimers();
    const kill = jest.fn().mockReturnValue(true);
    const run = closeOwnedBrowser({
      close: () => new Promise(() => undefined),
      process: () => ({ exitCode: null, kill }),
    });
    await jest.advanceTimersByTimeAsync(5000);
    await run;
    expect(kill).toHaveBeenCalledWith('SIGKILL');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('terminates a surviving child after a close error', async () => {
    const kill = jest.fn().mockReturnValue(true);
    await closeOwnedBrowser({
      close: async () => {
        throw new Error('CDP disconnected');
      },
      process: () => ({ exitCode: null, kill }),
    });
    expect(kill).toHaveBeenCalledWith('SIGKILL');
  });
});
