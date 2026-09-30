// Plain assertions runnable with `npx tsx scripts/persona-store.test.ts`.
//
// Общий кеш `GET /personas/me` (CONTRACT5 FE1): один запрос на экран,
// сколько бы компонентов ни смонтировалось.

import { createPersonaStore } from '../src/lib/persona-store';

let failed = 0;
let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
  }
}
function eq(a: unknown, b: unknown) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${x} !== ${y}`);
}

function setup(maxAgeMs = 1000) {
  let calls = 0;
  let clock = 0;
  let fail = false;
  let release: (() => void) | null = null;
  let gate = false;
  const store = createPersonaStore(
    async () => {
      calls += 1;
      const n = calls;
      if (gate) await new Promise<void>((r) => (release = r));
      if (fail) throw new Error('net');
      return { n };
    },
    { maxAgeMs, now: () => clock }
  );
  return {
    store,
    calls: () => calls,
    tick: (ms: number) => (clock += ms),
    failNext: (v: boolean) => (fail = v),
    hold: () => (gate = true),
    open: () => {
      gate = false;
      release?.();
    },
  };
}

console.log('persona-store (общий кеш /personas/me)');

async function main() {
  await check('три одновременных ensure — один запрос', async () => {
    const s = setup();
    const r = await Promise.all([
      s.store.ensure(),
      s.store.ensure(),
      s.store.ensure(),
    ]);
    eq(s.calls(), 1);
    eq(r[2], { kind: 'ready', value: { n: 1 } });
  });

  await check('свежий ответ — без запроса; устаревший — запрос', async () => {
    const s = setup(1000);
    await s.store.ensure();
    s.tick(999);
    await s.store.ensure();
    eq(s.calls(), 1);
    s.tick(1);
    await s.store.ensure();
    eq(s.calls(), 2);
  });

  await check('refresh — всегда запрос, и подписчики его видят', async () => {
    const s = setup();
    const seen: unknown[] = [];
    s.store.subscribe((st) => seen.push(st));
    await s.store.ensure();
    await s.store.refresh();
    eq(s.calls(), 2);
    eq(seen, [
      { kind: 'ready', value: { n: 1 } },
      { kind: 'ready', value: { n: 2 } },
    ]);
  });

  await check(
    'ошибка не кешируется: следующий ensure спрашивает снова',
    async () => {
      const s = setup();
      s.failNext(true);
      const st = await s.store.ensure();
      eq(st.kind, 'failed');
      s.failNext(false);
      await s.store.ensure();
      eq(s.calls(), 2);
      eq(s.store.get(), { kind: 'ready', value: { n: 2 } });
    }
  );

  await check('set — известный ответ без запроса', async () => {
    const s = setup();
    s.store.set({ n: 42 });
    await s.store.ensure();
    eq(s.calls(), 0);
    eq(s.store.get(), { kind: 'ready', value: { n: 42 } });
  });

  await check('reset во время запроса — старый ответ не пишется', async () => {
    const s = setup();
    s.hold();
    const p = s.store.ensure();
    s.store.reset();
    s.open();
    await p;
    eq(s.store.get(), { kind: 'loading' });
    await s.store.ensure();
    eq(s.store.get().kind, 'ready');
  });

  await check('отписка — больше не зовётся', async () => {
    const s = setup();
    let n = 0;
    const off = s.store.subscribe(() => (n += 1));
    await s.store.ensure();
    off();
    await s.store.refresh();
    eq(n, 1);
  });

  await check(
    'cacheFailure: «выключено» кешируется на maxAgeMs, сбой сети — нет',
    async () => {
      let calls = 0;
      let clock = 0;
      let err: Error = new Error('disabled');
      const store = createPersonaStore(
        async () => {
          calls += 1;
          throw err;
        },
        {
          maxAgeMs: 1000,
          now: () => clock,
          cacheFailure: (e) => (e as Error).message === 'disabled',
        }
      );
      await store.ensure();
      await store.ensure();
      eq(calls, 1);
      clock += 1000;
      await store.ensure();
      eq(calls, 2);
      // Обычный сбой не держится: каждый ensure — новый запрос.
      err = new Error('net');
      clock += 1000;
      await store.ensure();
      await store.ensure();
      eq(calls, 4);
    }
  );

  await check('без cacheFailure отказ не кешируется (как раньше)', async () => {
    const s = setup();
    s.failNext(true);
    await s.store.ensure();
    await s.store.ensure();
    eq(s.calls(), 2);
  });

  console.log(`persona-store: ${passed} проверок пройдено`);
  if (failed) {
    console.error(`persona-store: ${failed} провалено`);
    process.exit(1);
  }
}

void main();
