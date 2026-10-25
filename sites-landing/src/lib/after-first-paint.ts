type Host = Pick<
  Window,
  | 'requestAnimationFrame'
  | 'cancelAnimationFrame'
  | 'setTimeout'
  | 'clearTimeout'
> &
  Partial<Pick<Window, 'requestIdleCallback' | 'cancelIdleCallback'>>;
type Page = Pick<
  Document,
  'visibilityState' | 'addEventListener' | 'removeEventListener'
>;

/** Defer optional telemetry until after a paint; a hidden page must not wait for RAF. */
export function afterFirstPaint(
  task: () => void,
  host: Host = window,
  page: Page = document,
): () => void {
  let stopped = false;
  let started = false;
  let frame: number | undefined;
  let idle: number | undefined;
  let timer: number | undefined;
  const clear = () => {
    if (frame !== undefined) host.cancelAnimationFrame(frame);
    if (idle !== undefined) host.cancelIdleCallback?.(idle);
    if (timer !== undefined) host.clearTimeout(timer);
    page.removeEventListener('visibilitychange', hidden);
  };
  const start = () => {
    if (stopped || started) return;
    started = true;
    clear();
    task();
  };
  const hidden = () => {
    if (page.visibilityState === 'hidden') start();
  };
  page.addEventListener('visibilitychange', hidden);
  if (page.visibilityState === 'hidden') start();
  else
    frame = host.requestAnimationFrame(() => {
      frame = host.requestAnimationFrame(() => {
        if (stopped || started) return;
        if (typeof host.requestIdleCallback === 'function')
          idle = host.requestIdleCallback(start, { timeout: 3000 });
        else timer = host.setTimeout(start, 0);
      });
    });
  return () => {
    stopped = true;
    clear();
  };
}
