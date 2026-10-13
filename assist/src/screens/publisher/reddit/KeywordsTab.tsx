/**
 * P-R — вкладка «Запросы»: ключевые запросы проекта (фраза, намерение,
 * язык, приоритет 1–5), дубль нормальной формы — 409 со ссылкой; правка и
 * архив/возврат в строке (`PATCH`, CAS `expectedRevision`).
 */
import { useState } from 'react';
import { Button } from '../../../kit/ui';
import {
  REDDIT_INTENTS,
  REDDIT_KEYWORD_STATUSES,
  type RedditIntent,
  redditListPath,
  type RedditKeywordView,
} from '../../../lib/publisher/reddit-api';
import {
  emptyKeywordForm,
  keywordBody,
  keywordForm,
  keywordPatchBody,
  type KeywordForm,
} from '../../../lib/publisher/reddit-view';
import { useListFilters, useMutation } from '../hooks';
import {
  ConfirmButton,
  Field,
  ListToolbar,
  Section,
  Select,
  StatusBadge,
  TextInput,
} from '../parts';
import { ActionBlock, ListRow, PagedFooter } from '../ops/ops-parts';
import { usePaged } from '../ops/ops-hooks';
import type { PublisherSectionProps } from '../registry';
import { useProjectScope, useRebaseForm, useReddit } from './reddit-hooks';
import { ProjectBar } from './ProjectBar';
import {
  ConflictPanel,
  ReadOnlyNote,
  RedditErrorAlert,
  SearchBox,
} from './reddit-parts';

const PRIORITIES = ['1', '2', '3', '4', '5'] as const;

export function KeywordsTab({
  query,
}: {
  query: PublisherSectionProps['query'];
}) {
  const { r, api, pid, canManage } = useReddit();
  const scope = useProjectScope(query);
  const f = useListFilters('reddit', query, ['tab', 'projectId', 'status']);
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  const filter = {
    status: f.values.status || undefined,
    projectId: scope.projectId || undefined,
    q: applied || undefined,
  };
  const page = usePaged(
    (before) => api.keywords({ ...filter, before }),
    [api, filter.status, filter.projectId, applied]
  );
  return (
    <div className="space-y-4">
      <ProjectBar scope={scope} tab="keywords" />
      <ListToolbar
        statuses={REDDIT_KEYWORD_STATUSES}
        status={f.values.status}
        onStatus={(v) => f.set('status', v)}
        statusLabels={r.keywords.statuses}
        csvPath={redditListPath(pid, 'keywords')}
        csvQuery={filter}
        extra={
          <SearchBox
            value={q}
            onChange={setQ}
            onApply={() => setApplied(q.trim())}
          />
        }
      />
      <Section title={r.keywords.title}>
        <ul>
          {page.items.map((k) => (
            <ListRow
              key={k.id}
              title={k.phrase}
              badges={
                <StatusBadge
                  status={k.status}
                  labels={r.keywords.statuses}
                  tone={k.status === 'active' ? 'neutral' : 'warning'}
                />
              }
            >
              <div>
                {r.opportunities.intents[k.intent]} ·{' '}
                {r.keywords.fields.priority}: {k.priority}
                {k.locale ? ` · ${k.locale}` : ''}
              </div>
              {canManage && (
                <KeywordEdit
                  k={k}
                  onSaved={(x) => page.replace((y) => y.id === x.id, x)}
                  onReload={page.reload}
                />
              )}
            </ListRow>
          ))}
        </ul>
        <PagedFooter page={page} empty={r.keywords.empty} />
      </Section>
      {!canManage ? (
        <ReadOnlyNote />
      ) : scope.projectId && scope.project?.status === 'active' ? (
        <AddKeyword projectId={scope.projectId} onDone={page.reload} />
      ) : null}
    </div>
  );
}

function KeywordFields({
  v,
  set,
}: {
  v: KeywordForm;
  set: (v: KeywordForm) => void;
}) {
  const { r } = useReddit();
  return (
    <>
      <Field label={r.keywords.fields.phrase}>
        <TextInput
          value={v.phrase}
          maxLength={200}
          onChange={(x) => set({ ...v, phrase: x })}
        />
      </Field>
      <Field label={r.keywords.fields.intent}>
        <Select
          value={v.intent}
          options={REDDIT_INTENTS}
          labels={r.opportunities.intents}
          empty={r.common.choose}
          onChange={(x) => set({ ...v, intent: x })}
        />
      </Field>
      <Field label={r.keywords.fields.locale}>
        <TextInput
          value={v.locale}
          maxLength={16}
          onChange={(x) => set({ ...v, locale: x })}
        />
      </Field>
      <Field label={r.keywords.fields.priority}>
        <Select
          value={v.priority as (typeof PRIORITIES)[number]}
          options={PRIORITIES}
          onChange={(x) => set({ ...v, priority: x || '3' })}
        />
      </Field>
    </>
  );
}

function AddKeyword({
  projectId,
  onDone,
}: {
  projectId: string;
  onDone: () => void;
}) {
  const { r, api } = useReddit();
  const m = useMutation();
  const [v, setV] = useState<KeywordForm>(emptyKeywordForm());
  const body = keywordBody(projectId, v);
  return (
    <Section title={r.keywords.add}>
      <KeywordFields v={v} set={setV} />
      <RedditErrorAlert error={m.error} />
      <Button
        loading={m.busy}
        disabled={!body}
        onClick={async () => {
          if (!body) return;
          const x = await m.run(
            (k) => api.createKeyword(k, body),
            JSON.stringify(body)
          );
          if (x) {
            setV(emptyKeywordForm());
            onDone();
          }
        }}
      >
        {r.keywords.add}
      </Button>
    </Section>
  );
}

function KeywordEdit({
  k,
  onSaved,
  onReload,
}: {
  k: RedditKeywordView;
  onSaved: (k: RedditKeywordView) => void;
  /** 409 → перечитать список (ввод формы сохраняется и перебазируется). */
  onReload: () => void;
}) {
  const { r, api } = useReddit();
  const m = useMutation();
  const ms = useMutation();
  const f = useRebaseForm<KeywordForm>(keywordForm(k), k.revision);
  const v = f.v;
  const setV = f.set;
  const patch = f.conflicts.length ? null : keywordPatchBody(k, v, f.base);
  const active = k.status === 'active';
  return (
    <div className="pt-1 text-silver-700 dark:text-silver-200">
      <ActionBlock title={r.common.edit}>
        {active && (
          <>
            <KeywordFields v={v} set={setV} />
            <ConflictPanel
              conflicts={f.conflicts}
              label={(key) => r.keywords.fields[key]}
              show={(key, x) =>
                key === 'intent' && x
                  ? r.opportunities.intents[x as RedditIntent]
                  : String(x)
              }
              resolve={f.resolve}
            />
            <RedditErrorAlert error={m.error} onReload={onReload} />
            <Button
              loading={m.busy}
              disabled={!patch}
              onClick={async () => {
                if (!patch) return;
                const x = await m.run(
                  (key) => api.patchKeyword(k.id, key, patch),
                  JSON.stringify(patch)
                );
                if (x) onSaved(x);
              }}
            >
              {r.common.save}
            </Button>
          </>
        )}
        <RedditErrorAlert error={ms.error} onReload={onReload} />
        <ConfirmButton
          loading={ms.busy}
          variant="outline"
          onConfirm={async () => {
            const status = active ? 'archived' : 'active';
            const x = await ms.run(
              (key) =>
                api.patchKeyword(k.id, key, {
                  expectedRevision: k.revision,
                  status,
                }),
              `status:${k.id}:${k.revision}:${status}`
            );
            if (x) onSaved(x);
          }}
        >
          {active ? r.common.archive : r.common.restore}
        </ConfirmButton>
      </ActionBlock>
    </div>
  );
}
