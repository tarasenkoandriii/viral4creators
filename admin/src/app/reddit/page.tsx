'use client';

// Вкладка «Reddit» (пакет P-R-ADM, 14.10.2026; решение владельца — полная
// работа с Reddit-разделом из Админки). Данные — в sites-backend
// (платформенный продукт Publisher), Админка ходит через backend
// (`/admin/reddit/*`). Режим — только MANUAL_COPY: ни Админка, ни сервер не
// обращаются к Reddit; текст копирует человек, публикацию отмечает «со слов
// пользователя». Кабинет assist — второй вход к тем же данным.
//
// Под-вкладки — состояние в адресе (`?tab=&project=&id=`): карточку можно
// открыть ссылкой и перезагрузить страницу, не теряя места.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAdminAuth } from '../../lib/admin-auth-context';
import {
  createRedditClients,
  parseRedditRoute,
  REDDIT_TABS,
  redditRouteSearch,
  sectionState,
  type AdminRedditStatus,
  type RedditRoute,
} from '../../lib/reddit';
import { ErrorAlert, Loading, RedditCtx, useLoad, type RedditCtxValue } from '../../components/reddit/ui';
import { SetupTab } from '../../components/reddit/SetupTab';
import { ImportTab } from '../../components/reddit/ImportTab';
import { ProjectBar, ProjectsTab } from '../../components/reddit/ProjectsTab';
import { CommunitiesTab } from '../../components/reddit/CommunitiesTab';
import { OpportunitiesTab } from '../../components/reddit/OpportunitiesTab';
import { KeywordsTab } from '../../components/reddit/KeywordsTab';
import { BriefsTab } from '../../components/reddit/BriefsTab';
import { StudioTab } from '../../components/reddit/StudioTab';
import { PublicationsTab } from '../../components/reddit/PublicationsTab';

const WITH_PROJECT = new Set(['communities', 'opportunities', 'keywords', 'briefs']);

export default function RedditPage() {
  const { me } = useAdminAuth();
  const api = useMemo(() => createRedditClients(), []);
  const [route, setRoute] = useState<RedditRoute>({ tab: 'setup', project: '', id: '', opp: '' });
  const [ready, setReady] = useState(false);

  // Адрес → состояние при входе и при «Назад» браузера.
  useEffect(() => {
    const read = () => setRoute(parseRedditRoute(window.location.search));
    read();
    setReady(true);
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, []);

  const go = useCallback((patch: Partial<RedditRoute>) => {
    setRoute((cur) => {
      const tabChanged = patch.tab !== undefined && patch.tab !== cur.tab;
      const next: RedditRoute = {
        ...cur,
        ...(tabChanged ? { id: '', opp: '' } : {}),
        ...patch,
      };
      const search = redditRouteSearch(next);
      if (search !== window.location.search) window.history.pushState(null, '', search);
      return next;
    });
    window.scrollTo({ top: 0 });
  }, []);

  const status = useLoad(() => api.admin.status(), [api]);
  // Ответ `setup` — до следующего чтения статуса (без мигания вкладки:
  // старый статус «нет продукта» не возвращается, пока идёт перечитывание).
  const [override, setOverride] = useState<AdminRedditStatus | null>(null);
  useEffect(() => setOverride(null), [status.data]);
  const st = override ?? status.data;
  const usable = !!st && sectionState(st) === 'ready';
  const projects = useProjectList(api, usable);

  const ctx: RedditCtxValue = useMemo(
    () => ({ api, userId: me?.userId ?? null, route, go, aiEnabled: !!st?.aiEnabled, status: st ?? null }),
    [api, me?.userId, route, go, st],
  );

  return (
    <RedditCtx.Provider value={ctx}>
      <div className="page rx-page">
        <h1 style={{ fontSize: 20, marginBottom: 4 }}>Reddit</h1>
        <p className="muted" style={{ marginBottom: 16 }}>
          Исследование и ручная публикация в Reddit от имени платформы: импорт, сообщества и правила, возможности, брифы, студия,
          отметки о публикации. Только ручной режим — к Reddit не обращаемся.
        </p>
        <nav className="rx-tabs" aria-label="Разделы Reddit">
          {REDDIT_TABS.map((t) => {
            const disabled = t.key !== 'setup' && !usable;
            return (
              <button
                key={t.key}
                type="button"
                className={route.tab === t.key ? 'rx-tab rx-tab-on' : 'rx-tab'}
                aria-current={route.tab === t.key ? 'page' : undefined}
                disabled={disabled}
                onClick={() => go({ tab: t.key, id: '', opp: '' })}
              >
                {t.label}
              </button>
            );
          })}
        </nav>
        {!ready ? null : route.tab === 'setup' || !usable ? (
          <SetupTab
            status={st ?? null}
            statusError={status.error}
            onStatus={setOverride}
            reloadStatus={() => {
              status.reload();
              projects.reload();
            }}
          />
        ) : (
          <>
            {WITH_PROJECT.has(route.tab) && !route.id && (
              <>
                {projects.loading && !projects.data && <Loading />}
                <ErrorAlert error={projects.error} onReload={projects.reload} />
                <ProjectBar projects={projects.data ?? []} />
              </>
            )}
            {route.tab === 'import' && <ImportTab onApplied={projects.reload} />}
            {route.tab === 'projects' && <ProjectsTab onChanged={projects.reload} />}
            {route.tab === 'communities' && <CommunitiesTab key={`c:${route.project}`} />}
            {route.tab === 'opportunities' && <OpportunitiesTab key={`o:${route.project}`} />}
            {route.tab === 'keywords' && <KeywordsTab key={`k:${route.project}`} />}
            {route.tab === 'briefs' && <BriefsTab key={`b:${route.project}:${route.opp}`} />}
            {route.tab === 'studio' && <StudioTab key={`s:${route.id}`} />}
            {route.tab === 'publications' && <PublicationsTab />}
          </>
        )}
      </div>
    </RedditCtx.Provider>
  );
}

/** Проекты для строки выбора — только когда раздел готов (иначе 404). */
function useProjectList(api: ReturnType<typeof createRedditClients>, usable: boolean) {
  return useLoad(async () => (usable ? (await api.reddit.projects({ limit: 100 })).items : []), [api, usable]);
}
