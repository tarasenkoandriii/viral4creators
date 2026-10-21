'use client';

// Автообновление вкладки «FFmpeg» (ТЗ §13.1): только пока вкладка браузера
// видна, раз в 10 с; при ошибке — backoff ×2 до 160 с; при скрытии вкладки
// и уходе со страницы запрос в полёте отменяется. Только GET: опрос
// ничего не создаёт и не меняет.
import { useCallback, useEffect, useRef, useState } from 'react';
import { isAbortError, nextPollDelay } from '../../lib/ffmpeg';

export interface PollState<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  /** Когда пришёл последний успешный ответ (epoch ms). */
  okAt: number | null;
  failures: number;
  refresh: () => void;
}

/**
 * `key === null` — не опрашивать. Смена ключа (фильтры, курсор, другая
 * задача) сбрасывает данные: старый список не выдаётся за новый.
 * `isFailure` — ответ пришёл, но источник недоступен (`stale`): тоже backoff.
 */
export function usePoll<T>(
  key: string | null,
  fetcher: (signal: AbortSignal) => Promise<T>,
  isFailure?: (data: T) => boolean,
): PollState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [okAt, setOkAt] = useState<number | null>(null);
  const [failures, setFailures] = useState(0);
  const [tick, setTick] = useState(0);
  const fetcherRef = useRef(fetcher);
  const failureRef = useRef(isFailure);
  const lastKey = useRef<string | null>(null);

  useEffect(() => {
    fetcherRef.current = fetcher;
    failureRef.current = isFailure;
  });

  useEffect(() => {
    if (lastKey.current !== key) {
      lastKey.current = key;
      setData(null);
      setError(null);
      setOkAt(null);
      setFailures(0);
    }
    if (key === null) return;
    let disposed = false;
    let ctrl: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let fails = 0;

    const schedule = (ms: number) => {
      clearTimeout(timer);
      if (!disposed && document.visibilityState === 'visible') timer = setTimeout(() => void run(), ms);
    };
    const run = async () => {
      clearTimeout(timer);
      if (disposed || document.visibilityState !== 'visible') return;
      ctrl?.abort();
      const mine = new AbortController();
      ctrl = mine;
      setLoading(true);
      try {
        const d = await fetcherRef.current(mine.signal);
        if (disposed || mine.signal.aborted) return;
        setData(d);
        setError(null);
        setOkAt(Date.now());
        fails = failureRef.current?.(d) ? fails + 1 : 0;
      } catch (e) {
        if (disposed || (mine.signal.aborted && isAbortError(e))) return;
        fails += 1;
        setError(e);
      }
      if (disposed || ctrl !== mine) return;
      setFailures(fails);
      setLoading(false);
      schedule(nextPollDelay(fails));
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void run();
      else {
        clearTimeout(timer);
        ctrl?.abort();
        setLoading(false);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    void run();
    return () => {
      disposed = true;
      clearTimeout(timer);
      ctrl?.abort();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [key, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, okAt, failures, refresh };
}
