type OwnedChild = {
  exitCode: number | null;
  signalCode?: string | null;
  kill(signal: 'SIGKILL'): boolean;
  once?(event: 'exit', listener: () => void): unknown;
  removeListener?(event: 'exit', listener: () => void): unknown;
};
type OwnedBrowser = {
  close(): Promise<void>;
  process?(): OwnedChild | null;
};

function hasExited(child: OwnedChild): boolean {
  return child.exitCode !== null || child.signalCode != null;
}

/** Release only the Chromium child spawned for this run, even if CDP hangs. */
export async function closeOwnedBrowser(browser: OwnedBrowser): Promise<void> {
  const child = browser.process?.();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      browser.close().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 5_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (child && !hasExited(child)) {
      // kill() only sends a signal. Wait for OS exit before another
      // Chromium launch can overlap this child's resource usage.
      if (child.once && child.removeListener) {
        await new Promise<void>((resolve, reject) => {
          const exited = () => {
            clearTimeout(deadline);
            child.removeListener?.('exit', exited);
            resolve();
          };
          const deadline = setTimeout(() => {
            child.removeListener?.('exit', exited);
            reject(new Error('Owned Chromium did not exit after SIGKILL'));
          }, 2_000);
          child.once?.('exit', exited);
          if (hasExited(child)) exited();
          else child.kill('SIGKILL');
        });
      } else {
        child.kill('SIGKILL');
      }
    }
  }
}
