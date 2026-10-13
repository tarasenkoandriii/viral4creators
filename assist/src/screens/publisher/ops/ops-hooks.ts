/**
 * AI Publisher (P-G2) — хуки экранов денег, заявок и отчётов: клиенты
 * API поверх `PublisherHttp` оболочки, словарь `publisher-ops-*`, списки
 * с курсором «показать ещё», участники кабинета для выбора ответственного.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useKit } from '../../../kit';
import { createDistributionApi } from '../../../lib/publisher/distribution-api';
import { createLeadsApi } from '../../../lib/publisher/leads-api';
import { createReportsApi } from '../../../lib/publisher/reports-api';
import type { ListPage } from '../../../lib/publisher/decode';
import { getOpsDict } from '../../../lib/publisher/ops-view';
import { usePublisher } from '../publisher-context';

export function useOps() {
  const pub = usePublisher();
  const { http, locale } = pub;
  const apis = useMemo(
    () => ({
      dist: createDistributionApi(http),
      leads: createLeadsApi(http),
      reports: createReportsApi(http),
    }),
    [http]
  );
  const o = useMemo(() => getOpsDict(locale), [locale]);
  return { ...pub, ...apis, o, pid: pub.product.id };
}

export interface Paged<T> {
  items: T[];
  next: string | null;
  loading: boolean;
  error: unknown;
  reload: () => void;
  more: () => void;
  /** Заменить строку после мутации (без перезагрузки списка). */
  replace: (match: (x: T) => boolean, next: T) => void;
}

/**
 * Список с курсором `nextBefore` (§11.1). Новые фильтры (`deps`) —
 * загрузка с начала; ответ устаревшего запроса отбрасывается.
 */
export function usePaged<T>(
  load: (before?: string) => Promise<ListPage<T>>,
  deps: unknown[]
): Paged<T> {
  const [items, setItems] = useState<T[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [tick, setTick] = useState(0);
  const gen = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    const my = ++gen.current;
    setLoading(true);
    setError(null);
    loadRef.current().then(
      (p) => {
        if (gen.current !== my) return;
        setItems(p.items);
        setNext(p.nextBefore);
        setLoading(false);
      },
      (e: unknown) => {
        if (gen.current !== my) return;
        setItems([]);
        setNext(null);
        setError(e);
        setLoading(false);
      }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const more = useCallback(() => {
    if (!next) return;
    const my = gen.current;
    setLoading(true);
    loadRef.current(next).then(
      (p) => {
        if (gen.current !== my) return;
        setItems((xs) => [...xs, ...p.items]);
        setNext(p.nextBefore);
        setLoading(false);
      },
      (e: unknown) => {
        if (gen.current !== my) return;
        setError(e);
        setLoading(false);
      }
    );
  }, [next]);

  const reload = useCallback(() => setTick((x) => x + 1), []);
  const replace = useCallback((match: (x: T) => boolean, v: T) => {
    setItems((xs) => xs.map((x) => (match(x) ? v : x)));
  }, []);
  return { items, next, loading, error, reload, more, replace };
}

export interface MemberOption {
  memberId: string;
  label: string;
}

/**
 * Участники кабинета для выбора ответственного. Оператору сервер список не
 * отдаёт (`members: null`) — тогда только «я» и ручной ввод id.
 */
export function useMembers(): MemberOption[] | null {
  const { account } = useKit();
  return useMemo(() => {
    if (!account.members) return null;
    return account.members
      .filter((m) => m.memberId)
      .map((m) => ({
        memberId: m.memberId,
        label: m.telegramId ? `tg ${m.telegramId}` : m.memberId,
      }));
  }, [account.members]);
}
