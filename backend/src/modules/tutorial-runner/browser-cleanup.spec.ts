import { EventEmitter } from 'node:events';
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
  it('waits for the owned process exit after sending SIGKILL', async () => {
    jest.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null as string | null,
      kill: jest.fn().mockReturnValue(true),
    });
    let settled = false;
    const run = closeOwnedBrowser({
      close: async () => undefined,
      process: () => child,
    }).then(() => {
      settled = true;
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(settled).toBe(false);
    child.signalCode = 'SIGKILL';
    child.emit('exit');
    await run;
    expect(settled).toBe(true);
    expect(child.listenerCount('exit')).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not signal an already signal-terminated process', async () => {
    const kill = jest.fn();
    await closeOwnedBrowser({
      close: async () => undefined,
      process: () => ({ exitCode: null, signalCode: 'SIGKILL', kill }),
    });
    expect(kill).not.toHaveBeenCalled();
  });

  it('rejects cleanup when process exit cannot be confirmed', async () => {
    jest.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      kill: jest.fn().mockReturnValue(true),
    });
    const run = closeOwnedBrowser({
      close: async () => undefined,
      process: () => child,
    });
    const rejected = run.catch((error: Error) => error);
    await jest.advanceTimersByTimeAsync(2000);
    expect(((await rejected) as Error).message).toContain(
      'did not exit after SIGKILL',
    );
    expect(child.listenerCount('exit')).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });
});
