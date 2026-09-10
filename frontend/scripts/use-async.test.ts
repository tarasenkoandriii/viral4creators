/**
 * `useAsync` существует ради одной вещи — «результат устаревшего запроса
 * игнорируется», — и ровно она не была проверена ничем.
 *
 * Почему это важно на живом экране: пользователь переключает товар или
 * жмёт «обновить», уходит второй запрос, а первый возвращается позже
 * (мобильная сеть, холодный старт функции). Без счётчика прогонов
 * поздний ответ затирает свежий, и человек видит данные прошлого
 * товара — молча, без единой ошибки.
 *
 * ## Почему здесь свой крошечный «рендерер»
 *
 * Тестового раннера и DOM во фронтенде нет (см. шаг «unit-скрипты» в
 * CI): чистые функции проверяются `npx tsx scripts/*.test.ts`. Хук —
 * не чистая функция, поэтому ниже поднят минимальный хост хуков через
 * тот же диспетчер, которым в React пользуются настоящие рендереры.
 * Проверяется при этом НАСТОЯЩИЙ код хука, а не его пересказ: хост
 * умеет ровно четыре хука, которые хук и вызывает.
 */
import assert from 'node:assert/strict';
import * as React from 'react';
import { useAsync } from '../src/lib/useAsync';

// ── Минимальный хост хуков ────────────────────────────────────────────

interface HookCell {
  state?: unknown;
  ref?: { current: unknown };
  value?: unknown;
  deps?: unknown[];
  initialised?: boolean;
}

const internals = (
  React as unknown as {
    __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: {
      ReactCurrentDispatcher: { current: unknown };
    };
  }
).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;

function renderHook<T>(render: () => T) {
  const cells: HookCell[] = [];
  let cursor = 0;
  let latest: T | undefined;
  let rendering = false;
  let dirty = false;
  const pendingEffects: Array<() => void> = [];

  const sameDeps = (a: unknown[] | undefined, b: unknown[] | undefined) =>
    !!a &&
    !!b &&
    a.length === b.length &&
    a.every((x, i) => Object.is(x, b[i]));

  const cell = (): HookCell => {
    const c = cells[cursor] ?? (cells[cursor] = {});
    cursor += 1;
    return c;
  };

  const useMemoImpl = <V>(create: () => V, deps?: unknown[]): V => {
    const c = cell();
    if (!c.initialised || !sameDeps(c.deps, deps)) {
      c.value = create();
      c.deps = deps;
      c.initialised = true;
    }
    return c.value as V;
  };

  const dispatcher = {
    useState<V>(initial: V | (() => V)) {
      const c = cell();
      if (!c.initialised) {
        c.state =
          typeof initial === 'function' ? (initial as () => V)() : initial;
        c.initialised = true;
      }
      const setState = (next: V | ((prev: V) => V)) => {
        const value =
          typeof next === 'function'
            ? (next as (prev: V) => V)(c.state as V)
            : next;
        if (Object.is(value, c.state)) return;
        c.state = value;
        flush();
      };
      return [c.state as V, setState];
    },
    useRef<V>(initial: V) {
      const c = cell();
      if (!c.ref) c.ref = { current: initial };
      return c.ref as { current: V };
    },
    useMemo: useMemoImpl,
    useCallback<F>(fn: F, deps?: unknown[]): F {
      return useMemoImpl(() => fn, deps);
    },
    useEffect(create: () => void, deps?: unknown[]) {
      const c = cell();
      if (!c.initialised || !sameDeps(c.deps, deps)) {
        c.deps = deps;
        c.initialised = true;
        pendingEffects.push(create);
      }
    },
  };

  function flush() {
    // Обновление состояния во время рендера не рендерит повторно сразу —
    // как и в React: помечаем и дорисовываем следующим проходом.
    if (rendering) {
      dirty = true;
      return;
    }
    do {
      dirty = false;
      rendering = true;
      cursor = 0;
      const previous = internals.ReactCurrentDispatcher.current;
      internals.ReactCurrentDispatcher.current = dispatcher;
      try {
        latest = render();
      } finally {
        internals.ReactCurrentDispatcher.current = previous;
        rendering = false;
      }
      for (const effect of pendingEffects.splice(0)) effect();
    } while (dirty);
  }

  flush();
  return {
    get current(): T {
      return latest as T;
    },
    rerender: flush,
  };
}

/** Промис, моментом разрешения которого распоряжается сам тест. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Отказ, обработанный позже, не должен ронять процесс как
  // «unhandled rejection» — хук его подберёт, когда дойдёт очередь.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/** Дать разрешённым промисам дойти до состояния хука. */
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

// ── Тесты ─────────────────────────────────────────────────────────────

let passed = 0;
const tests: Array<[string, () => Promise<void>]> = [];
const it = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

it('поздний ответ прошлого запроса не затирает свежий', async () => {
  // Главное, ради чего хук написан. Пользователь переключил товар:
  // первый запрос ещё в полёте, второй уже вернулся. Победить обязан
  // второй — независимо от того, кто ответил последним по времени.
  const first = deferred<string>();
  const second = deferred<string>();
  const answers = [first.promise, second.promise];
  let call = 0;
  const hook = renderHook(() => useAsync(() => answers[call++], []));

  await settle();
  hook.current.reload();
  await settle();

  second.resolve('свежий');
  await settle();
  assert.equal(hook.current.data, 'свежий');

  first.resolve('устаревший');
  await settle();
  assert.equal(hook.current.data, 'свежий');
  assert.equal(hook.current.loading, false);
});

it('поздний ответ не снимает индикатор загрузки со свежего запроса', async () => {
  // Экран сказал бы «готово», показывая пустоту: свежий запрос ещё идёт,
  // а спиннер уже погас.
  const first = deferred<string>();
  const second = deferred<string>();
  const answers = [first.promise, second.promise];
  let call = 0;
  const hook = renderHook(() => useAsync(() => answers[call++], []));

  await settle();
  hook.current.reload();
  await settle();

  first.resolve('устаревший');
  await settle();
  assert.equal(hook.current.loading, true);
  assert.equal(hook.current.data, null);

  second.resolve('свежий');
  await settle();
  assert.equal(hook.current.loading, false);
  assert.equal(hook.current.data, 'свежий');
});

it('ошибка устаревшего запроса не показывается поверх свежих данных', async () => {
  // Отменённый запрос часто падает по таймауту уже после того, как его
  // заменили. Показать эту ошибку — значит обвинить сервис в сбое,
  // которого для пользователя не было.
  const first = deferred<string>();
  const second = deferred<string>();
  const answers = [first.promise, second.promise];
  let call = 0;
  const hook = renderHook(() => useAsync(() => answers[call++], []));

  await settle();
  hook.current.reload();
  await settle();
  second.resolve('свежий');
  await settle();

  first.reject(new Error('таймаут прошлого запроса'));
  await settle();
  assert.equal(hook.current.error, null);
  assert.equal(hook.current.data, 'свежий');
});

it('смена зависимостей тоже отменяет прошлый запрос', async () => {
  // Второй способ устареть — не кнопка «обновить», а смена ключа
  // (другой товар, другая сессия). Он ходит через useEffect, а не через
  // reload, и обязан работать так же.
  const first = deferred<string>();
  const second = deferred<string>();
  const answers = [first.promise, second.promise];
  let call = 0;
  let productId = 'товар-1';
  const hook = renderHook(() => useAsync(() => answers[call++], [productId]));

  await settle();
  productId = 'товар-2';
  hook.rerender();
  await settle();

  first.resolve('данные товара-1');
  await settle();
  assert.equal(hook.current.data, null);

  second.resolve('данные товара-2');
  await settle();
  assert.equal(hook.current.data, 'данные товара-2');
});

it('без гонки хук просто отдаёт данные — правило не запрещает всё подряд', async () => {
  // Обратная половина: «игнорировать всё» тоже прошло бы проверки выше.
  const only = deferred<string>();
  const hook = renderHook(() => useAsync(() => only.promise, []));

  assert.equal(hook.current.loading, true);
  only.resolve('ответ');
  await settle();
  assert.equal(hook.current.data, 'ответ');
  assert.equal(hook.current.loading, false);
  assert.equal(hook.current.error, null);
});

it('ошибка текущего запроса доходит до экрана', async () => {
  // Ради этого этап 39 и доводил ошибки до интерфейса: молчащий экран
  // выглядит зависшим.
  const only = deferred<string>();
  const hook = renderHook(() => useAsync(() => only.promise, []));

  only.reject(new Error('сеть недоступна'));
  await settle();
  assert.equal((hook.current.error as Error).message, 'сеть недоступна');
  assert.equal(hook.current.loading, false);
});

it('повторный запрос сбрасывает прошлую ошибку, а не копит её', async () => {
  const first = deferred<string>();
  const second = deferred<string>();
  const answers = [first.promise, second.promise];
  let call = 0;
  const hook = renderHook(() => useAsync(() => answers[call++], []));

  first.reject(new Error('сеть недоступна'));
  await settle();
  assert.ok(hook.current.error);

  hook.current.reload();
  await settle();
  assert.equal(hook.current.error, null);
  assert.equal(hook.current.loading, true);

  second.resolve('получилось');
  await settle();
  assert.equal(hook.current.data, 'получилось');
});

async function main() {
  console.log('useAsync — устаревший ответ не затирает свежий');
  for (const [name, fn] of tests) {
    await fn();
    passed += 1;
    console.log('  ✓', name);
  }
  console.log(`\n${passed} проверок пройдено`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
