import assert from 'node:assert/strict';
import { afterFirstPaint } from '../src/lib/after-first-paint';
function setup(idle = true, visibility = 'visible') {
  let seq = 0,
    calls = 0;
  const frames = new Map<number, () => void>(),
    jobs = new Map<number, () => void>();
  const listeners = new Set<() => void>();
  const host = {
    requestAnimationFrame: (fn: () => void) => {
      frames.set(++seq, fn);
      return seq;
    },
    cancelAnimationFrame: (id: number) => {
      frames.delete(id);
    },
    setTimeout: (fn: () => void) => {
      jobs.set(++seq, fn);
      return seq;
    },
    clearTimeout: (id: number) => {
      jobs.delete(id);
    },
    ...(idle
      ? {
          requestIdleCallback: (fn: () => void, opts: { timeout: number }) => {
            assert.equal(opts.timeout, 3000);
            jobs.set(++seq, fn);
            return seq;
          },
          cancelIdleCallback: (id: number) => {
            jobs.delete(id);
          },
        }
      : {}),
  };
  const page = {
    visibilityState: visibility,
    addEventListener: (_: string, fn: () => void) => {
      listeners.add(fn);
    },
    removeEventListener: (_: string, fn: () => void) => {
      listeners.delete(fn);
    },
  };
  const cancel = afterFirstPaint(
    () => {
      calls++;
    },
    host as unknown as Window,
    page as unknown as Document,
  );
  const flush = (queue: Map<number, () => void>) => {
    const pending = [...queue.values()];
    queue.clear();
    pending.forEach((fn) => fn());
  };
  return {
    cancel,
    frames,
    jobs,
    listeners,
    calls: () => calls,
    frame: () => flush(frames),
    idle: () => flush(jobs),
    hide: () => {
      page.visibilityState = 'hidden';
      [...listeners].forEach((fn) => fn());
    },
  };
}
for (const idle of [true, false]) {
  const x = setup(idle);
  assert.equal(x.calls(), 0);
  x.frame();
  assert.equal(x.calls(), 0);
  x.frame();
  assert.equal(x.calls(), 0);
  x.idle();
  assert.equal(x.calls(), 1);
  x.hide();
  assert.equal(x.calls(), 1);
  assert.equal(x.listeners.size, 0);
}
for (const phase of [0, 1, 2]) {
  const x = setup();
  for (let n = 0; n < phase; n++) x.frame();
  x.cancel();
  x.frame();
  x.idle();
  x.hide();
  assert.equal(x.calls(), 0);
}
const hidden = setup(true, 'hidden');
assert.equal(hidden.calls(), 1);
assert.equal(hidden.frames.size, 0);
const hideBeforePaint = setup();
hideBeforePaint.hide();
hideBeforePaint.frame();
hideBeforePaint.idle();
assert.equal(hideBeforePaint.calls(), 1);
console.log(
  'after-first-paint: telemetry waits for paint, cancels on unmount, starts once on visibility loss — ok',
);
