/**
 * AI Publisher (P-R) — хуки раздела «Reddit»: клиент `reddit-api` для
 * текущего продукта, словарь `publisher-reddit-*`, права раздела
 * (подсказка; решает сервер, AT-CORE-11) и проекты продукта для выбора.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAsync } from '../../../kit';
import {
  createRedditApi,
  type RedditProjectView,
} from '../../../lib/publisher/reddit-api';
import {
  getRedditDict,
  rebaseForm,
  type FieldConflict,
} from '../../../lib/publisher/reddit-view';
import { usePublisher, type PubQuery } from '../publisher-context';

export const REDDIT_TABS = [
  'projects',
  'communities',
  'rules',
  'opportunities',
  'keywords',
] as const;
export type RedditTab = (typeof REDDIT_TABS)[number];

export function useReddit() {
  const pub = usePublisher();
  const { http, locale, product, can } = pub;
  const api = useMemo(
    () => createRedditApi(http, product.id),
    [http, product.id]
  );
  const r = useMemo(() => getRedditDict(locale), [locale]);
  return {
    ...pub,
    api,
    r,
    pid: product.id,
    canManage: can('reddit.manage'),
    canReview: can('reddit.rules.review'),
  };
}

/**
 * Проекты продукта (первые 100 — для выбора в фильтрах и формах; проектов
 * у продукта единицы). Ошибка — как у любого списка (`Loadable`).
 */
export function useRedditProjects() {
  const { api } = useReddit();
  return useAsync(
    async () => (await api.projects({ limit: 100 })).items,
    [api]
  );
}

/** Сообщества проекта (до 100) — выбор в правилах и возможностях. */
export function useRedditCommunities(projectId: string) {
  const { api } = useReddit();
  return useAsync(
    async () =>
      projectId ? (await api.communities({ projectId, limit: 100 })).items : [],
    [api, projectId]
  );
}

export interface ProjectScope {
  list: RedditProjectView[];
  /** Выбранный в маршруте или единственный проект; '' — все. */
  projectId: string;
  project: RedditProjectView | null;
  loading: boolean;
  error: unknown;
}

export function useProjectScope(query: PubQuery): ProjectScope {
  const projects = useRedditProjects();
  const list = projects.data ?? [];
  const chosen = query.projectId ?? '';
  const projectId = chosen || (list.length === 1 ? list[0].id : '');
  return {
    list,
    projectId,
    project: list.find((p) => p.id === projectId) ?? null,
    loading: projects.loading,
    error: projects.error,
  };
}

export interface RebaseForm<F extends object> {
  /** Значения формы (ввод пользователя). */
  v: F;
  set: (v: F) => void;
  /** Исходный снимок формы — от него считается «что изменил пользователь». */
  base: F;
  /** Поля, изменённые и пользователем, и сервером (после перечитывания). */
  conflicts: FieldConflict<F>[];
  resolve: (key: keyof F, pick: 'mine' | 'theirs') => void;
}

/**
 * Форма правки поверх серверного состояния (UI-аудит S2-1): тело правки
 * считается от `base` (снимка на момент начала правки), а не от свежего
 * ответа. Когда `version` меняется (перечитали после 409 или сохранили),
 * форма перебазируется: нетронутые поля — свежие, свои правки остаются,
 * конфликты по одному полю — явно, до выбора сохранение недоступно.
 */
export function useRebaseForm<F extends object>(
  server: F,
  version: string | number
): RebaseForm<F> {
  const [base, setBase] = useState<F>(server);
  const [v, setV] = useState<F>(server);
  const [conflicts, setConflicts] = useState<FieldConflict<F>[]>([]);
  const seen = useRef(version);
  const latest = useRef({ base, v });
  latest.current = { base, v };
  useEffect(() => {
    if (seen.current === version) return;
    seen.current = version;
    const res = rebaseForm(latest.current.base, latest.current.v, server);
    setBase(server);
    setV(res.mine);
    setConflicts(res.conflicts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
  const resolve = useCallback(
    (key: keyof F, pick: 'mine' | 'theirs') => {
      const c = conflicts.find((x) => x.key === key);
      if (c && pick === 'theirs') setV((cur) => ({ ...cur, [key]: c.theirs }));
      setConflicts((cs) => cs.filter((x) => x.key !== key));
    },
    [conflicts]
  );
  return { v, set: setV, base, conflicts, resolve };
}
