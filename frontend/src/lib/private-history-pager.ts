/** Private in-memory pagination. Reset invalidates all earlier responses. */
export interface HistoryPage<T> {
  items: T[];
  nextCursor: string | null;
}
export interface HistoryView<T> extends HistoryPage<T> {
  loading: boolean;
  error: 'auth' | 'load' | null;
}
export function createPrivateHistoryPager<T extends { id: string }>(
  fetchPage: (before?: string) => Promise<HistoryPage<T>>
) {
  let state: HistoryView<T> = {
    items: [],
    nextCursor: null,
    loading: false,
    error: null,
  };
  let epoch = 0;
  let disposed = false;
  const listeners = new Set<(view: HistoryView<T>) => void>();
  const emit = (next: HistoryView<T>) => {
    state = next;
    for (const fn of listeners) fn(state);
  };
  const reset = () => {
    epoch++;
    emit({ items: [], nextCursor: null, loading: false, error: null });
  };
  const load = async (append: boolean) => {
    if (disposed || state.loading || (append && !state.nextCursor)) return;
    const token = ++epoch;
    const cursor = append ? state.nextCursor! : undefined;
    emit({
      ...(append ? state : { items: [], nextCursor: null }),
      loading: true,
      error: null,
    });
    try {
      const page = await fetchPage(cursor);
      if (disposed || token !== epoch) return;
      const seen = new Set<string>();
      const items = [...(append ? state.items : []), ...page.items].filter(
        (item) => {
          if (seen.has(item.id)) return false;
          seen.add(item.id);
          return true;
        }
      );
      emit({
        items,
        nextCursor: page.nextCursor === cursor ? null : page.nextCursor,
        loading: false,
        error: null,
      });
    } catch (error) {
      if (disposed || token !== epoch) return;
      const status = (error as { response?: { status?: number } } | null)
        ?.response?.status;
      const auth = status === 401 || status === 403;
      emit({
        ...(auth ? { items: [], nextCursor: null } : state),
        loading: false,
        error: auth ? 'auth' : 'load',
      });
    }
  };
  return {
    get snapshot() {
      return state;
    },
    subscribe(fn: (view: HistoryView<T>) => void) {
      listeners.add(fn);
      fn(state);
      return () => {
        listeners.delete(fn);
      };
    },
    reload: () => load(false),
    more: () => load(true),
    reset,
    dispose() {
      disposed = true;
      reset();
      listeners.clear();
    },
  };
}
