import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Tiny data-loading hook: runs `fn` on mount (and when `deps` change),
 * exposes data/loading/error and a `reload`. Ignores results from a
 * superseded run so a slow earlier response can't overwrite a newer one.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const run = useRef(0);

  const load = useCallback(async () => {
    const id = ++run.current;
    setLoading(true);
    setError(null);
    try {
      const result = await fn();
      if (id === run.current) setData(result);
    } catch (e) {
      if (id === run.current) setError(e);
    } finally {
      if (id === run.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, setData, loading, error, reload: load };
}
