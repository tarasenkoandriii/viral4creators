'use client';

// «Запросы»: ключевые фразы проекта (намерение, язык, приоритет 1–5),
// добавление (дубль по нормальной форме — ссылка на существующий), правка
// только изменённых полей и архив/возврат.

import { useState } from 'react';
import { R } from '../../lib/reddit';
import {
  REDDIT_INTENTS,
  REDDIT_KEYWORD_STATUSES,
  type RedditKeywordView,
} from '../../lib/reddit-shared/lib/publisher/reddit-api';
import {
  emptyKeywordForm,
  keywordBody,
  keywordForm,
  keywordPatchBody,
  type KeywordForm,
} from '../../lib/reddit-shared/lib/publisher/reddit-view';
import {
  Alert,
  Badge,
  ConfirmButton,
  ConflictPanel,
  CsvButton,
  ErrorAlert,
  Field,
  Notice,
  PagedFooter,
  Section,
  Select,
  useMutation,
  usePaged,
  useRebaseForm,
  useRx,
} from './ui';

export function KeywordsTab() {
  const { api, route } = useRx();
  const [status, setStatus] = useState<'' | 'active' | 'archived'>('active');
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  const [open, setOpen] = useState('');
  const page = usePaged(
    (before) => api.reddit.keywords({ projectId: route.project || undefined, status: status || undefined, q: applied || undefined, before, limit: 50 }),
    [api, route.project, status, applied],
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
        <Select ariaLabel={R.common.status} value={status} options={REDDIT_KEYWORD_STATUSES} labels={R.keywords.statuses} empty="все статусы" onChange={setStatus} />
        <input aria-label={R.common.search} placeholder={R.common.searchHint} value={q} onChange={(e) => setQ(e.target.value)} className="rx-grow" />
        <button type="submit">{R.common.apply}</button>
        <CsvButton list="keywords" query={{ projectId: route.project || undefined, status: status || undefined, q: applied || undefined }} />
      </form>
      <Section title={R.keywords.title}>
        <ul className="rx-items">
          {page.items.map((k) => (
            <li key={k.id} className="rx-item" id={`kw-${k.id}`}>
              <div className="rx-row">
                <b className="rx-wrap">{k.phrase}</b>
                <Badge>{R.opportunities.intents[k.intent]}</Badge>
                <span className="muted">
                  {R.keywords.fields.priority}: {k.priority}
                  {k.locale ? ` · ${k.locale}` : ''}
                </span>
                {k.status !== 'active' && <Badge tone="warning">{R.keywords.statuses[k.status]}</Badge>}
                <button type="button" className="rx-linkbtn" aria-expanded={open === k.id} onClick={() => setOpen(open === k.id ? '' : k.id)}>
                  {open === k.id ? R.common.cancel : R.common.edit}
                </button>
              </div>
              {open === k.id && <KeywordEdit k={k} onSaved={page.reload} />}
            </li>
          ))}
        </ul>
        <PagedFooter page={page} empty={R.keywords.empty} />
      </Section>
      {route.project ? (
        <AddKeyword projectId={route.project} onDone={page.reload} onExisting={setOpen} />
      ) : (
        <Alert tone="neutral">Чтобы добавить запрос, выберите проект выше.</Alert>
      )}
    </div>
  );
}

function KeywordFields({ v, set }: { v: KeywordForm; set: (v: KeywordForm) => void }) {
  return (
    <>
      <Field label={R.keywords.fields.phrase}>
        <input value={v.phrase} maxLength={200} onChange={(e) => set({ ...v, phrase: e.target.value })} />
      </Field>
      <div className="rx-grid3">
        <Field label={R.keywords.fields.intent}>
          <Select value={v.intent} options={REDDIT_INTENTS} labels={R.opportunities.intents} empty={R.common.choose} onChange={(x) => set({ ...v, intent: x })} />
        </Field>
        <Field label={R.keywords.fields.locale}>
          <input value={v.locale} maxLength={16} onChange={(e) => set({ ...v, locale: e.target.value })} />
        </Field>
        <Field label={R.keywords.fields.priority}>
          <Select value={v.priority} options={['1', '2', '3', '4', '5'] as const} labels={{}} onChange={(x) => x && set({ ...v, priority: x })} />
        </Field>
      </div>
    </>
  );
}

function AddKeyword({ projectId, onDone, onExisting }: { projectId: string; onDone: () => void; onExisting: (id: string) => void }) {
  const { api } = useRx();
  const m = useMutation();
  const [v, setV] = useState<KeywordForm>(emptyKeywordForm());
  const [done, setDone] = useState<string | null>(null);
  const body = keywordBody(projectId, v);
  return (
    <Section title={R.keywords.add}>
      <KeywordFields v={v} set={setV} />
      <ErrorAlert error={m.error} onExisting={onExisting} />
      <Notice text={done} />
      <button
        type="button"
        disabled={!body || m.busy}
        onClick={async () => {
          if (!body) return;
          setDone(null);
          const x = await m.run((k) => api.reddit.createKeyword(k, body), `createKeyword:${JSON.stringify(body)}`);
          if (x) {
            setV(emptyKeywordForm());
            setDone(R.common.saved);
            onDone();
          }
        }}
      >
        {R.keywords.add}
      </button>
    </Section>
  );
}

function KeywordEdit({ k: initial, onSaved }: { k: RedditKeywordView; onSaved: () => void }) {
  const { api } = useRx();
  const m = useMutation();
  const ms = useMutation();
  const [k, setK] = useState(initial);
  const f = useRebaseForm<KeywordForm>(keywordForm(k), k.revision);
  const patch = f.conflicts.length ? null : keywordPatchBody(k, f.v, f.base);
  const active = k.status === 'active';
  const reload = async () => {
    // Списка по id нет — свежая строка берётся из первой страницы фильтра проекта.
    const page = await api.reddit.keywords({ projectId: k.projectId, q: k.phrase.slice(0, 200), limit: 100 }).catch(() => null);
    const fresh = page?.items.find((x) => x.id === k.id);
    if (fresh) setK(fresh);
  };
  return (
    <div className="rx-stack rx-inner">
      <KeywordFields v={f.v} set={f.set} />
      <ConflictPanel conflicts={f.conflicts} label={(key) => R.keywords.fields[key]} resolve={f.resolve} />
      <ErrorAlert error={m.error ?? ms.error} onReload={() => void reload()} />
      <div className="rx-row">
        <button
          type="button"
          disabled={!patch || m.busy}
          onClick={async () => {
            if (!patch) return;
            const x = await m.run((key) => api.reddit.patchKeyword(k.id, key, patch), `patchKeyword:${k.id}:${JSON.stringify(patch)}`);
            if (x) {
              setK(x);
              onSaved();
            }
          }}
        >
          {R.common.save}
        </button>
        <ConfirmButton
          danger={active}
          busy={ms.busy}
          onConfirm={async () => {
            const body = { expectedRevision: k.revision, status: active ? ('archived' as const) : ('active' as const) };
            const x = await ms.run((key) => api.reddit.patchKeyword(k.id, key, body), `statusKeyword:${k.id}:${JSON.stringify(body)}`);
            if (x) {
              setK(x);
              onSaved();
            }
          }}
        >
          {active ? R.common.archive : R.common.restore}
        </ConfirmButton>
      </div>
    </div>
  );
}
