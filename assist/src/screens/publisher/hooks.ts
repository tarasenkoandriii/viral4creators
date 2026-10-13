/**
 * AI Publisher (P-G1) — общие хуки экранов раздела (P-G1 и P-G2).
 *
 * `useMutation`: один `opKey` на попытку действия (§11.1). Повтор после
 * сетевой ошибки/`PUB_BUSY` идёт тем же ключом — сервер вернёт прежний
 * результат, а не выполнит действие второй раз; после успеха или явного
 * `reset()` ключ новый.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { createAiApi } from '../../lib/publisher/ai-api';
import { createCalendarApi } from '../../lib/publisher/calendar-api';
import { createContentApi } from '../../lib/publisher/content-api';
import { createCoreApi } from '../../lib/publisher/core-api';
import {
  getPublisherContentDict,
  type PublisherContentDict,
} from '../../lib/publisher/i18n';
import {
  downloadCsv,
  opKeyAfter,
  opKeyFor,
  type OpKeyState,
  type Query,
} from '../../lib/publisher/common-api';
import { usePublisher, type PubQuery } from './publisher-context';

export interface Mutation {
  /**
   * `sig` — подпись действия (например, JSON тела): при смене подписи
   * берётся новый ключ, при повторе того же действия после сети — прежний.
   */
  run: <T>(
    fn: (opKey: string) => Promise<T>,
    sig?: string
  ) => Promise<T | undefined>;
  busy: boolean;
  error: unknown;
  reset: () => void;
}

export function useMutation(): Mutation {
  const key = useRef<OpKeyState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = useCallback(
    async <T>(
      fn: (opKey: string) => Promise<T>,
      sig?: string
    ): Promise<T | undefined> => {
      // Без явной подписи — текст функции действия: другое действие той же
      // мутации (другой вызов в коде) получает новый ключ (аудит G S3-8).
      const state = opKeyFor(key.current, sig ?? fn.toString());
      key.current = state;
      setBusy(true);
      setError(null);
      try {
        const out = await fn(state.key);
        key.current = opKeyAfter(state, null);
        return out;
      } catch (e) {
        // Не повторяемая ошибка — следующая попытка будет новым действием.
        key.current = opKeyAfter(state, e);
        setError(e);
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    []
  );
  const reset = useCallback(() => {
    key.current = null;
    setError(null);
  }, []);
  return { run, busy, error, reset };
}

/**
 * Фильтры списка из `?status=&owner=…` маршрута: ссылка «на отфильтрованный
 * список» с другого экрана открывает его уже отфильтрованным.
 */
export function useListFilters(
  section: string,
  query: PubQuery,
  keys: readonly string[]
): {
  values: Record<string, string>;
  set: (k: string, v: string) => void;
} {
  const { go } = usePublisher();
  const values: Record<string, string> = {};
  for (const k of keys) values[k] = query[k] ?? '';
  const set = (k: string, v: string) => {
    const next: Record<string, string> = {};
    for (const kk of keys) {
      const val = kk === k ? v : (query[kk] ?? '');
      if (val) next[kk] = val;
    }
    go(section, null, next);
  };
  return { values, set };
}

/** «Вивантажити CSV»: тот же фильтр, что у списка (ТЗ §8.4). */
export function useCsvExport(path: string, query?: Query) {
  const { http } = usePublisher();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const run = async () => {
    setBusy(true);
    setError(null);
    setDone(false);
    setTruncated(false);
    try {
      const f = await http.csv(path, query);
      downloadCsv(f);
      setTruncated(f.truncated === true);
      setDone(true);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return { run, busy, error, done, truncated };
}

/** Клиенты P-G1 для текущего продукта (ядро, контент, AI, календарь). */
export function usePubApis() {
  const { http, aiHttp, product } = usePublisher();
  return useMemo(
    () => ({
      core: createCoreApi(http),
      content: createContentApi(http, product.id),
      ai: createAiApi(http, aiHttp, product.id),
      calendar: createCalendarApi(http, product.id),
    }),
    [http, aiHttp, product.id]
  );
}

/** Тексты экранов контента и AI. */
export function usePubContent(): PublisherContentDict {
  const { locale } = usePublisher();
  return getPublisherContentDict(locale);
}
