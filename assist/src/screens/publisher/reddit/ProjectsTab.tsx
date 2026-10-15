/**
 * P-R — вкладка «Проекты»: список (статус, поиск, CSV), создание,
 * карточка с правкой (CAS `expectedRevision`, 409 — перезагрузка) и
 * архивом (глагол `…/archive`, двойным нажатием) и восстановлением
 * архивного (`…/restore`, Р-RD-AUD-1).
 */
import { useState } from 'react';
import { Badge, Button } from '../../../kit/ui';
import { useAsync } from '../../../kit';
import {
  REDDIT_PROJECT_STATUSES,
  redditListPath,
  type RedditProjectView,
} from '../../../lib/publisher/reddit-api';
import {
  BCP47_RE,
  projectBody,
  projectForm,
  projectPatchBody,
  type ProjectForm,
} from '../../../lib/publisher/reddit-view';
import { useListFilters, useMutation } from '../hooks';
import {
  ConfirmButton,
  DateText,
  Field,
  ListToolbar,
  Loadable,
  Notice,
  RecordLink,
  Row,
  Section,
  StatusBadge,
  TextInput,
} from '../parts';
import { ListRow, PagedFooter } from '../ops/ops-parts';
import { usePaged } from '../ops/ops-hooks';
import type { PublisherSectionProps } from '../registry';
import { useRebaseForm, useReddit } from './reddit-hooks';
import {
  ConflictPanel,
  ReadOnlyNote,
  RedditErrorAlert,
  SearchBox,
  Wrap,
} from './reddit-parts';

export function ProjectsTab({ id, query }: PublisherSectionProps) {
  if (id) return <ProjectCard id={id} />;
  return <ProjectList query={query} />;
}

function ProjectList({ query }: { query: PublisherSectionProps['query'] }) {
  const { r, api, pid, canManage } = useReddit();
  const f = useListFilters('reddit', query, ['tab', 'status']);
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  const page = usePaged(
    (before) =>
      api.projects({
        status: f.values.status || undefined,
        q: applied || undefined,
        before,
      }),
    [api, f.values.status, applied]
  );
  return (
    <div className="space-y-4">
      <ListToolbar
        statuses={REDDIT_PROJECT_STATUSES}
        status={f.values.status}
        onStatus={(v) => f.set('status', v)}
        statusLabels={r.statuses}
        csvPath={redditListPath(pid, 'projects')}
        csvQuery={{
          status: f.values.status || undefined,
          q: applied || undefined,
        }}
        extra={
          <SearchBox
            value={q}
            onChange={setQ}
            onApply={() => setApplied(q.trim())}
          />
        }
      />
      <Section title={r.projects.title}>
        <ul>
          {page.items.map((p) => (
            <ListRow
              key={p.id}
              title={
                <RecordLink
                  section="reddit"
                  id={p.id}
                  query={{ tab: 'projects' }}
                >
                  {p.title}
                </RecordLink>
              }
              badges={<ProjectStatus p={p} />}
            >
              <div>
                {p.locale} · {p.market}
              </div>
              <div className="flex flex-wrap gap-x-3">
                <RecordLink
                  section="reddit"
                  query={{ tab: 'communities', projectId: p.id }}
                >
                  {r.tabs.communities}
                </RecordLink>
                <RecordLink
                  section="reddit"
                  query={{ tab: 'opportunities', projectId: p.id }}
                >
                  {r.tabs.opportunities}
                </RecordLink>
                <RecordLink
                  section="reddit"
                  query={{ tab: 'keywords', projectId: p.id }}
                >
                  {r.tabs.keywords}
                </RecordLink>
              </div>
            </ListRow>
          ))}
        </ul>
        <PagedFooter page={page} empty={r.projects.empty} />
      </Section>
      {canManage ? <CreateProject onDone={page.reload} /> : <ReadOnlyNote />}
    </div>
  );
}

function ProjectStatus({ p }: { p: RedditProjectView }) {
  const { r } = useReddit();
  return (
    <StatusBadge
      status={p.status}
      labels={r.statuses}
      tone={p.status === 'active' ? 'neutral' : 'warning'}
    />
  );
}

function ProjectFields({
  v,
  set,
}: {
  v: ProjectForm;
  set: (v: ProjectForm) => void;
}) {
  const { r } = useReddit();
  const badLocale = v.locale.trim() !== '' && !BCP47_RE.test(v.locale.trim());
  return (
    <>
      <Field label={r.projects.fields.title}>
        <TextInput
          value={v.title}
          maxLength={120}
          onChange={(x) => set({ ...v, title: x })}
        />
      </Field>
      <Field
        label={r.projects.fields.locale}
        hint={badLocale ? r.projects.localeInvalid : undefined}
      >
        <TextInput
          value={v.locale}
          maxLength={16}
          onChange={(x) => set({ ...v, locale: x })}
        />
      </Field>
      <Field label={r.projects.fields.market}>
        <TextInput
          value={v.market}
          maxLength={64}
          onChange={(x) => set({ ...v, market: x })}
        />
      </Field>
    </>
  );
}

function CreateProject({ onDone }: { onDone: () => void }) {
  const { r, api, go } = useReddit();
  const m = useMutation();
  const [v, setV] = useState<ProjectForm>(projectForm(null));
  const body = projectBody(v);
  return (
    <Section title={r.projects.create}>
      <ProjectFields v={v} set={setV} />
      <RedditErrorAlert error={m.error} />
      <Button
        loading={m.busy}
        disabled={!body}
        onClick={async () => {
          if (!body) return;
          const x = await m.run(
            (k) => api.createProject(k, body),
            JSON.stringify(body)
          );
          if (x) {
            setV(projectForm(null));
            onDone();
            go('reddit', null, { tab: 'communities', projectId: x.id });
          }
        }}
      >
        {r.common.create}
      </Button>
    </Section>
  );
}

function ProjectCard({ id }: { id: string }) {
  const { r, api } = useReddit();
  const state = useAsync(() => api.project(id), [api, id]);
  return (
    <div className="space-y-4">
      <RecordLink section="reddit" query={{ tab: 'projects' }}>
        {r.common.back}
      </RecordLink>
      <Loadable state={state}>
        {(p) => (
          <ProjectCardBody
            key={p.id}
            p={p}
            reload={state.reload}
            onSaved={state.setData}
          />
        )}
      </Loadable>
    </div>
  );
}

function ProjectCardBody({
  p,
  reload,
  onSaved,
}: {
  p: RedditProjectView;
  reload: () => void;
  onSaved: (p: RedditProjectView) => void;
}) {
  const { r, api, canManage } = useReddit();
  const m = useMutation();
  const ma = useMutation();
  const f = useRebaseForm<ProjectForm>(projectForm(p), p.revision);
  const v = f.v;
  const setV = f.set;
  const [done, setDone] = useState<string | null>(null);
  const patch = f.conflicts.length ? null : projectPatchBody(p, v, f.base);
  const active = p.status === 'active';
  return (
    <>
      <Section title={<Wrap>{p.title}</Wrap>} action={<ProjectStatus p={p} />}>
        <Row label={r.projects.fields.locale}>{p.locale}</Row>
        <Row label={r.projects.fields.market}>{p.market}</Row>
        <Row label={r.common.revision}>{p.revision}</Row>
        <Row label={r.common.createdAt}>
          <DateText iso={p.createdAt} time />
        </Row>
        <Row label={r.common.updatedAt}>
          <DateText iso={p.updatedAt} time />
        </Row>
        <div className="flex flex-wrap gap-x-3 text-sm">
          <RecordLink
            section="reddit"
            query={{ tab: 'communities', projectId: p.id }}
          >
            {r.tabs.communities}
          </RecordLink>
          <RecordLink
            section="reddit"
            query={{ tab: 'opportunities', projectId: p.id }}
          >
            {r.tabs.opportunities}
          </RecordLink>
          <RecordLink
            section="reddit"
            query={{ tab: 'keywords', projectId: p.id }}
          >
            {r.tabs.keywords}
          </RecordLink>
        </div>
      </Section>
      <Notice text={done} />
      {!canManage ? (
        <ReadOnlyNote />
      ) : !active ? (
        <Section title={r.projects.restore}>
          <Badge tone="warning">{r.projects.archiveHint}</Badge>
          <div className="text-xs text-silver-500">
            {r.projects.restoreHint}
          </div>
          <RedditErrorAlert error={ma.error} onReload={reload} />
          <ConfirmButton
            variant="outline"
            loading={ma.busy}
            onConfirm={async () => {
              const x = await ma.run(
                (k) => api.restoreProject(p.id, k, p.revision),
                `restore:${p.id}:${p.revision}`
              );
              if (x) onSaved(x);
            }}
          >
            {r.projects.restore}
          </ConfirmButton>
        </Section>
      ) : (
        <Section title={r.common.edit}>
          <ProjectFields v={v} set={setV} />
          <ConflictPanel
            conflicts={f.conflicts}
            label={(k) => r.projects.fields[k]}
            resolve={f.resolve}
          />
          <RedditErrorAlert error={m.error} onReload={reload} />
          <Button
            loading={m.busy}
            disabled={!patch}
            onClick={async () => {
              if (!patch) return;
              setDone(null);
              const x = await m.run(
                (k) => api.patchProject(p.id, k, patch),
                JSON.stringify(patch)
              );
              if (x) {
                setDone(r.common.saved);
                onSaved(x);
              }
            }}
          >
            {r.common.save}
          </Button>
          <div className="pt-2 space-y-2">
            <div className="text-xs text-silver-500">
              {r.projects.archiveHint}
            </div>
            <RedditErrorAlert error={ma.error} onReload={reload} />
            <ConfirmButton
              variant="outline"
              loading={ma.busy}
              onConfirm={async () => {
                const x = await ma.run(
                  (k) => api.archiveProject(p.id, k, p.revision),
                  `archive:${p.id}:${p.revision}`
                );
                if (x) onSaved(x);
              }}
            >
              {r.common.archive}
            </ConfirmButton>
          </div>
        </Section>
      )}
    </>
  );
}
