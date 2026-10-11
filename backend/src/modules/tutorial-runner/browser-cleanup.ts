type OwnedBrowser = {
  close(): Promise<void>;
  process?(): {
    exitCode: number | null;
    kill(signal: 'SIGKILL'): boolean;
  } | null;
};

/** Release only the Chromium child spawned for this run, even if CDP hangs. */
export async function closeOwnedBrowser(browser: OwnedBrowser): Promise<void> {
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
    const child = browser.process?.();
    if (child?.exitCode === null) child.kill('SIGKILL');
  }
}
