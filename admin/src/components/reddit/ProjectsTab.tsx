'use client';

// «Проекты»: список, создание, карточка с правкой (только изменённые поля,
// CAS `expectedRevision`; 409 — перечитать без потери ввода), архивом и
// восстановлением архивного (Р-RD-AUD-1).
// Выбранный проект — фильтр остальных вкладок (`?project=`).

import { useState } from 'react';
import { R, fmtDateTime } from '../../lib/reddit';
import { REDDIT_PROJECT_STATUSES, type RedditProjectView } from '../../lib/reddit-shared/lib/publisher/reddit-api';
import {
  BCP47_RE,
  projectBody,
  projectForm,
  projectPatchBody,
  type ProjectForm,
} from '../../lib/reddit-shared/lib/publisher/reddit-view';
import {
  Badge,
  ConfirmButton,
  CsvButton,
  ConflictPanel,
  ErrorAlert,
  Field,
  Loading,
  Notice,
  PagedFooter,
  Row,
  Section,
  Select,
  useLoad,
  useMutation,
  usePaged,
  useRebaseForm,
  useRx,
} from './ui';

/** Строка выбора проекта над вкладками. */
export function ProjectBar({ projects }: { projects: RedditProjectView[] }) {
  const { route, go } = useRx();
  return (
    <div className="rx-row rx-projectbar">
      <label className="rx-field rx-grow">
        <span className="rx-label">{R.common.project}</span>
        <select value={route.project} onChange={(e) => go({ project: e.target.value, id: '' })}>
          <option value="">{R.common.allProjects}</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
              {p.status === 'archived' ? ` (${R.statuses.archived})` : ''}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

export function ProjectsTab({ onChanged }: { onChanged: () => void }) {
  const { route } = useRx();
  if (route.id) return <ProjectCard id={route.id} onChanged={onChanged} />;
  return <ProjectList onChanged={onChanged} />;
}

function ProjectList({ onChanged }: { onChanged: () => void }) {
  const { api, go } = useRx();
  const [status, setStatus] = useState<'' | 'active' | 'archived'>('');
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  const page = usePaged(
    (before) => api.reddit.projects({ status: status || undefined, q: applied || undefined, before, limit: 50 }),
    [api, status, applied],
  );
  return (
    <div className="rx-stack">
      <form
        className="rx-row"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(q.trim());
        }}
      >
        <Select ariaLabel={R.common.status} value={status} options={REDDIT_PROJECT_STATUSES} labels={R.statuses} empty="все статусы" onChange={setStatus} />
        <input aria-label={R.common.search} placeholder={R.common.searchHint} value={q} onChange={(e) => setQ(e.target.value)} className="rx-grow" />
        <button type="submit">{R.common.apply}</button>
        <CsvButton list="projects" query={{ status: status || undefined, q: applied || undefined }} />
      </form>
      <Section title={R.projects.title}>
        <ul className="rx-items">
          {page.items.map((p) => (
            <li key={p.id} className="rx-item">
              <div className="rx-row">
                <button type="button" className="rx-linkbtn" onClick={() => go({ tab: 'projects', id: p.id })}>
                  {p.title}
                </button>
                <Badge tone={p.status === 'active' ? 'neutral' : 'warning'}>{R.statuses[p.status]}</Badge>
              </div>
              <div className="muted">
                {p.locale} · {p.market}
              </div>
              <div className="rx-row">
                <button type="button" className="rx-linkbtn" onClick={() => go({ tab: 'communities', project: p.id, id: '' })}>
                  {R.tabs.communities}
                </button>
                <button type="button" className="rx-linkbtn" onClick={() => go({ tab: 'opportunities', project: p.id, id: '' })}>
                  {R.tabs.opportunities}
                </button>
                <button type="button" className="rx-linkbtn" onClick={() => go({ tab: 'keywords', project: p.id, id: '' })}>
                  {R.tabs.keywords}
                </button>
              </div>
            </li>
          ))}
        </ul>
        <PagedFooter page={page} empty={R.projects.empty} />
      </Section>
      <CreateProject
        onDone={(id) => {
          page.reload();
          onChanged();
          go({ tab: 'communities', project: id, id: '' });
        }}
      />
    </div>
  );
}

function ProjectFields({ v, set }: { v: ProjectForm; set: (v: ProjectForm) => void }) {
  const badLocale = v.locale.trim() !== '' && !BCP47_RE.test(v.locale.trim());
  return (
    <>
      <Field label={R.projects.fields.title}>
        <input value={v.title} maxLength={120} onChange={(e) => set({ ...v, title: e.target.value })} />
      </Field>
      <div className="rx-grid2">
        <Field label={R.projects.fields.locale} hint={badLocale ? R.projects.localeInvalid : undefined}>
          <input value={v.locale} maxLength={16} onChange={(e) => set({ ...v, locale: e.target.value })} />
        </Field>
        <Field label={R.projects.fields.market}>
          <input value={v.market} maxLength={64} onChange={(e) => set({ ...v, market: e.target.value })} />
        </Field>
      </div>
    </>
  );
}

function CreateProject({ onDone }: { onDone: (id: string) => void }) {
  const { api } = useRx();
  const m = useMutation();
  const [v, setV] = useState<ProjectForm>(projectForm(null));
  const body = projectBody(v);
  return (
    <Section title={R.projects.create}>
      <ProjectFields v={v} set={setV} />
      <ErrorAlert error={m.error} />
      <button
        type="button"
        disabled={!body || m.busy}
        onClick={async () => {
          if (!body) return;
          const x = await m.run((k) => api.reddit.createProject(k, body), `createProject:${JSON.stringify(body)}`);
          if (x) {
            setV(projectForm(null));
            onDone(x.id);
          }
        }}
      >
        {R.common.create}
      </button>
    </Section>
  );
}

function ProjectCard({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { api, go } = useRx();
  const state = useLoad(() => api.reddit.project(id), [api, id]);
  const [fresh, setFresh] = useState<RedditProjectView | null>(null);
  // Пока грузится другая запись, прежняя не показывается (аудит ui-9).
  const loaded = state.data?.id === id ? state.data : null;
  const p = fresh && fresh.id === id && (!loaded || fresh.revision >= loaded.revision) ? fresh : loaded;
  return (
    <div className="rx-stack">
      <button type="button" className="rx-linkbtn" onClick={() => go({ tab: 'projects', id: '' })}>
        {R.common.back}
      </button>
      {state.error ? <ErrorAlert error={state.error} onRetry={state.reload} /> : null}
      {!p ? (
        state.loading ? <Loading /> : null
      ) : (
        <ProjectCardBody
          key={p.id}
          p={p}
          reload={() => {
            setFresh(null);
            state.reload();
          }}
          onSaved={(x) => {
            setFresh(x);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function ProjectCardBody({ p, reload, onSaved }: { p: RedditProjectView; reload: () => void; onSaved: (p: RedditProjectView) => void }) {
  const { api } = useRx();
  const m = useMutation();
  const ma = useMutation();
  const f = useRebaseForm<ProjectForm>(projectForm(p), p.revision);
  const [done, setDone] = useState<string | null>(null);
  const patch = f.conflicts.length ? null : projectPatchBody(p, f.v, f.base);
  const active = p.status === 'active';
  return (
    <Section title={p.title} action={<Badge tone={active ? 'neutral' : 'warning'}>{R.statuses[p.status]}</Badge>}>
      <Row label={R.common.revision}>{p.revision}</Row>
      <Row label={R.common.updatedAt}>{fmtDateTime(p.updatedAt)}</Row>
      {active ? (
        <>
          <ProjectFields v={f.v} set={f.set} />
          <ConflictPanel conflicts={f.conflicts} label={(k) => R.projects.fields[k]} resolve={f.resolve} />
          <ErrorAlert error={m.error} onReload={reload} />
          <Notice text={done} />
          <div className="rx-row">
            <button
              type="button"
              disabled={!patch || m.busy}
              onClick={async () => {
                if (!patch) return;
                const x = await m.run((k) => api.reddit.patchProject(p.id, k, patch), `patchProject:${p.id}:${JSON.stringify(patch)}`);
                if (x) {
                  setDone(R.common.saved);
                  onSaved(x);
                }
              }}
            >
              {R.common.save}
            </button>
            <ConfirmButton
              danger
              busy={ma.busy}
              onConfirm={async () => {
                const x = await ma.run((k) => api.reddit.archiveProject(p.id, k, p.revision), `archiveProject:${p.id}:${p.revision}`);
                if (x) onSaved(x);
              }}
            >
              {R.common.archive}
            </ConfirmButton>
          </div>
          <ErrorAlert error={ma.error} onReload={reload} />
          <p className="muted rx-hint">{R.projects.archiveHint}</p>
        </>
      ) : (
        <>
          <Row label={R.projects.fields.locale}>{p.locale}</Row>
          <Row label={R.projects.fields.market}>{p.market}</Row>
          <p className="muted rx-hint">{R.projects.archiveHint}</p>
          {/* Р-RD-AUD-1: восстановление архивного проекта (archived → active). */}
          <div className="rx-row">
            <ConfirmButton
              busy={ma.busy}
              onConfirm={async () => {
                const x = await ma.run((k) => api.reddit.restoreProject(p.id, k, p.revision), `restoreProject:${p.id}:${p.revision}`);
                if (x) onSaved(x);
              }}
            >
              {R.projects.restore}
            </ConfirmButton>
          </div>
          <ErrorAlert error={ma.error} onReload={reload} />
          <p className="muted rx-hint">{R.projects.restoreHint}</p>
        </>
      )}
    </Section>
  );
}
