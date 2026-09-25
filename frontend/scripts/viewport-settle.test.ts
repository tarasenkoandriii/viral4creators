import assert from 'node:assert/strict';
import { whenViewportSettled } from '../src/lib/viewport-settle';

type Handler = () => void;

function fakeWebApp() {
  const handlers = new Map<string, Set<Handler>>();
  return {
    handlers,
    onEvent: (event: 'themeChanged' | 'viewportChanged', h: Handler) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(h);
    },
    offEvent: (event: 'themeChanged' | 'viewportChanged', h: Handler) => {
      handlers.get(event)?.delete(h);
    },
    fire: (event: string) => {
      for (const h of [...(handlers.get(event) ?? [])]) h();
    },
  };
}

const settled = async (p: Promise<void>): Promise<boolean> => {
  let ok = false;
  void p.then(() => {
    ok = true;
  });
  await new Promise((r) => setTimeout(r, 0));
  return ok;
};

// Событие пришло — ждать дальше нечего.
{
  const app = fakeWebApp();
  const p = whenViewportSettled(app, 10_000);
  assert.equal(await settled(p), false, 'до события ожидание не кончилось');
  app.fire('viewportChanged');
  await p;
  // Подписка снята: она была нужна один раз, а живёт столько же,
  // сколько мини-апп.
  assert.equal(app.handlers.get('viewportChanged')?.size ?? 0, 0);
}

// События не будет вовсе (окно уже развёрнуто) — снимок обязан уйти.
{
  const app = fakeWebApp();
  const start = Date.now();
  await whenViewportSettled(app, 20);
  assert.ok(Date.now() - start >= 15, 'потолок ожидания сработал');
  assert.equal(app.handlers.get('viewportChanged')?.size ?? 0, 0);
}

// Второе событие ничего не ломает: обработчик срабатывает один раз.
{
  const app = fakeWebApp();
  const p = whenViewportSettled(app, 10_000);
  app.fire('viewportChanged');
  app.fire('viewportChanged');
  await p;
}

// Старый клиент без подписки на события — не висим.
{
  await whenViewportSettled({} as never, 10_000);
}

console.log('viewport-settle: ok');
