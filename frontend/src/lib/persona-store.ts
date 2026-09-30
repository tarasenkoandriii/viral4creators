/**
 * Общий кеш `GET /personas/me` (ТЗ Greeting 2.0 §4, CONTRACT5 FE1):
 * вход, экран «Я в кадре», «Кто в кадре» в брифе и личный бренд-бук
 * читают одну и ту же персону. Без общего кеша каждый смонтированный
 * компонент делал свой запрос — на одном экране их было до трёх.
 *
 * Правила:
 * - одновременные запросы склеиваются в один (`inflight`);
 * - свежий ответ (моложе `maxAgeMs`) отдаётся без запроса;
 * - `refresh()` — всегда запрос (после правки: создал образ, удалил);
 * - подписчики получают каждое новое состояние.
 *
 * Без React и axios — чтобы правила проверялись тестом
 * (scripts/persona-store.test.ts).
 */

export type StoreState<T> =
  | { kind: 'loading' }
  | { kind: 'ready'; value: T }
  | { kind: 'failed'; error: unknown };

export interface PersonaStore<T> {
  get(): StoreState<T>;
  /** Загрузить, если нет свежего ответа; вернёт текущий или новый. */
  ensure(): Promise<StoreState<T>>;
  /** Перечитать всегда (склеивается с уже идущим запросом). */
  refresh(): Promise<StoreState<T>>;
  /** Положить известный ответ без запроса. */
  set(value: T): void;
  /** Забыть всё (выход из аккаунта, удаление персоны). */
  reset(): void;
  subscribe(cb: (s: StoreState<T>) => void): () => void;
}

export function createPersonaStore<T>(
  fetcher: () => Promise<T>,
  opts: {
    maxAgeMs: number;
    now?: () => number;
    /**
     * Отказ, который живёт столько же, сколько свежий ответ (CONTRACT6
     * G-FE п. 14): 404 `PERSONA_DISABLED` — это «режим выключен», а не
     * сбой. Без кеша каждый смонтированный вход, бриф и бренд-бук заново
     * спрашивали сервер и получали тот же 404. Остальные ошибки (сеть,
     * 5xx) не кешируются — следующий экран пробует снова.
     */
    cacheFailure?: (error: unknown) => boolean;
  }
): PersonaStore<T> {
  const now = opts.now ?? (() => Date.now());
  let state: StoreState<T> = { kind: 'loading' };
  let loadedAt: number | null = null;
  let inflight: Promise<StoreState<T>> | null = null;
  let generation = 0;
  const listeners = new Set<(s: StoreState<T>) => void>();

  const emit = (next: StoreState<T>) => {
    state = next;
    for (const cb of [...listeners]) cb(state);
  };

  const load = (): Promise<StoreState<T>> => {
    if (inflight) return inflight;
    const gen = generation;
    inflight = fetcher()
      .then((value): StoreState<T> => ({ kind: 'ready', value }))
      .catch((error: unknown): StoreState<T> => ({ kind: 'failed', error }))
      .then((next) => {
        // Сброс во время запроса — ответ уже не про нынешнее состояние.
        if (gen === generation) {
          loadedAt = now();
          emit(next);
        }
        inflight = null;
        return state;
      });
    return inflight;
  };

  return {
    get: () => state,
    ensure() {
      const cacheable =
        state.kind === 'ready' ||
        (state.kind === 'failed' && !!opts.cacheFailure?.(state.error));
      const fresh =
        loadedAt !== null && cacheable && now() - loadedAt < opts.maxAgeMs;
      return fresh ? Promise.resolve(state) : load();
    },
    refresh: load,
    set(value) {
      loadedAt = now();
      emit({ kind: 'ready', value });
    },
    reset() {
      generation += 1;
      inflight = null;
      loadedAt = null;
      emit({ kind: 'loading' });
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}
