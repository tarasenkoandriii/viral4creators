'use client';

// «Брифы»: список (статус, тип, поиск), создание (comment — только к треду
// возможности и с контекстом; из карточки возможности — с подставленной
// выдержкой), карточка: «чего не хватает» словами, гейт правил, материал
// (создать → студия), правка только изменённых полей, «готов», архив.

import { useState } from 'react';
import { conflictValueText, fmtDateTime, R } from '../../lib/reddit';
import {
  REDDIT_AFFILIATIONS,
  REDDIT_BRIEF_STATUSES,
  REDDIT_CONTENT_TYPES,
  type RedditBriefView,
} from '../../lib/reddit-shared/lib/publisher/reddit-studio-api';
import type { RedditOpportunityView } from '../../lib/reddit-shared/lib/publisher/reddit-api';
import {
  briefCreateBody,
  briefForm,
  briefFormFromOpportunity,
  briefIssues,
  briefPatchBody,
  keyPointForm,
  missingText,
  type BriefForm,
} from '../../lib/reddit-shared/lib/publisher/reddit-studio-view';
import { fmtText } from '../../lib/reddit-shared/lib/publisher/view';
import {
  Alert,
  Badge,
  ConfirmButton,
  ConflictPanel,
  CsvButton,
  ErrorAlert,
  Field,
  GateBlock,
  Loading,
  Notice,
  PagedFooter,
  PlainQuote,
  RedditLink,
  Row,
  Section,
  Select,
  useLoad,
  useMutation,
  usePaged,
  useRebaseForm,
  useRx,
} from './ui';
import { SourcePicker } from './BrandSourcesPanels';

const briefTone = (s: RedditBriefView['status']) => (s === 'ready' ? 'success' : s === 'archived' ? 'neutral' : 'warning');

export function BriefsTab() {
  const { route } = useRx();
  if (route.id) return <BriefCard id={route.id} />;
  return <BriefList />;
}

function BriefList() {
  const { route, go } = useRx();
  const { api } = useRx();
  const [status, setStatus] = useState('');
  const [contentType, setContentType] = useState('');
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  const page = usePaged(
    (before) =>
      api.studio.briefs({
        projectId: route.project || undefined,
        status: status || undefined,
        contentType: contentType || undefined,
        q: applied || undefined,
        before,
        limit: 50,
      }),
    [api, route.project, status, contentType, applied],
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
        <Select ariaLabel={R.common.status} value={status} options={REDDIT_BRIEF_STATUSES} labels={R.briefs.statuses} empty="все статусы" onChange={setStatus} />
        <Select ariaLabel={R.briefs.filterType} value={contentType} options={REDDIT_CONTENT_TYPES} labels={R.briefs.contentTypes} empty="все типы" onChange={setContentType} />
        <input aria-label={R.common.search} placeholder={R.common.searchHint} value={q} onChange={(e) => setQ(e.target.value)} className="rx-grow" />
        <button type="submit">{R.common.apply}</button>
        <CsvButton
          list="briefs"
          query={{ projectId: route.project || undefined, status: status || undefined, contentType: contentType || undefined, q: applied || undefined }}
        />
      </form>
      <Section title={R.briefs.title}>
        <ul className="rx-items">
          {page.items.map((b) => (
            <li key={b.id} className="rx-item">
              <div className="rx-row">
                <button type="button" className="rx-linkbtn rx-wrap" onClick={() => go({ id: b.id, opp: '' })}>
                  {b.objective}
                </button>
                <Badge tone={briefTone(b.status)}>{R.briefs.statuses[b.status]}</Badge>
                <Badge>{R.briefs.contentTypes[b.contentType]}</Badge>
              </div>
              <div className="muted">r/{b.subreddit}</div>
              {b.missing.length > 0 && <span className="rx-hint rx-warn">{R.briefs.missingTitle}: {b.missing.map((x) => missingText(x, R)).join(', ')}</span>}
            </li>
          ))}
        </ul>
        <PagedFooter page={page} empty={R.briefs.empty} />
      </Section>
      {route.project ? (
        <AddBrief projectId={route.project} opportunityId={route.opp} />
      ) : (
        <Alert tone="neutral">Чтобы создать бриф, выберите проект выше.</Alert>
      )}
    </div>
  );
}

function useBriefOpportunities(projectId: string) {
  const { api } = useRx();
  return useLoad(async (): Promise<RedditOpportunityView[]> => {
    if (!projectId) return [];
    const [a, b] = await Promise.all([
      api.reddit.opportunities({ projectId, status: 'qualified', limit: 100 }),
      api.reddit.opportunities({ projectId, status: 'in_brief', limit: 100 }),
    ]);
    return [...a.items, ...b.items];
  }, [api, projectId]);
}

function useActiveCommunities(projectId: string) {
  const { api } = useRx();
  return useLoad(async () => (projectId ? (await api.reddit.communities({ projectId, status: 'active', limit: 100 })).items : []), [api, projectId]);
}

function BriefFields({ v, set, create, projectId }: { v: BriefForm; set: (v: BriefForm) => void; create: boolean; projectId: string }) {
  const { api } = useRx();
  const sources = useLoad(async () => (await api.content.sources({ limit: 100 })).items, [api]);
  const opps = useBriefOpportunities(create ? projectId : '');
  const comms = useActiveCommunities(create ? projectId : '');
  const issues = briefIssues(v);
  const pickOpportunity = (id: string) => {
    const o = (opps.data ?? []).find((x) => x.id === id);
    if (!o) {
      set({ ...v, opportunityId: '' });
      return;
    }
    const d = briefFormFromOpportunity(o);
    set({ ...v, opportunityId: o.id, communityId: o.communityId, context: v.context.trim() ? v.context : d.context });
  };
  return (
    <>
      {create && (
        <>
          <Field label={R.briefs.fields.contentType}>
            <Select value={v.contentType} options={REDDIT_CONTENT_TYPES} labels={R.briefs.contentTypes} empty={R.common.choose} onChange={(x) => set({ ...v, contentType: x })} />
          </Field>
          <Field label={R.briefs.fields.opportunity} hint={R.briefs.opportunityHint}>
            <select value={v.opportunityId} onChange={(e) => pickOpportunity(e.target.value)}>
              <option value="">{R.common.choose}</option>
              {(opps.data ?? []).map((o) => (
                <option key={o.id} value={o.id}>
                  r/{o.subreddit} · {o.titleManual}
                </option>
              ))}
            </select>
          </Field>
          {v.contentType === 'post' && !v.opportunityId && (
            <Field label={R.briefs.fields.community}>
              <select value={v.communityId} onChange={(e) => set({ ...v, communityId: e.target.value })}>
                <option value="">{R.common.choose}</option>
                {(comms.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    r/{c.subreddit}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </>
      )}
      <Field label={R.briefs.fields.objective}>
        <textarea rows={2} maxLength={500} value={v.objective} onChange={(e) => set({ ...v, objective: e.target.value })} />
      </Field>
      <Field label={R.briefs.fields.audience}>
        <input value={v.audience} maxLength={500} onChange={(e) => set({ ...v, audience: e.target.value })} />
      </Field>
      <Field label={R.briefs.fields.context} hint={create && v.opportunityId ? R.briefs.contextDefault : undefined}>
        <textarea rows={4} maxLength={2000} value={v.context} onChange={(e) => set({ ...v, context: e.target.value })} />
      </Field>
      <fieldset className="rx-fieldset rx-stack">
        <legend className="muted">{R.briefs.fields.keyPoints}</legend>
        {v.keyPoints.map((k, i) => {
          const put = (patch: Partial<typeof k>) => set({ ...v, keyPoints: v.keyPoints.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
          return (
            <div key={i} className="rx-inner rx-stack">
              <b>{fmtText(R.briefs.keyPoint, { n: i + 1 })}</b>
              <Field label={R.briefs.keyPointText}>
                <input value={k.text} maxLength={300} onChange={(e) => put({ text: e.target.value })} />
              </Field>
              <label className="rx-check">
                <input type="checkbox" checked={k.needsVerification} onChange={(e) => put({ needsVerification: e.target.checked })} />
                {R.briefs.needsVerification}
              </label>
              {!k.needsVerification && (
                <SourcePicker value={k.sources} onChange={(x) => put({ sources: x })} sources={sources.data ?? []} label={R.briefs.sourcesPick} />
              )}
              <button type="button" className="rx-linkbtn" onClick={() => set({ ...v, keyPoints: v.keyPoints.filter((_, j) => j !== i) })}>
                {fmtText(R.briefs.removeKeyPoint, { n: i + 1 })}
              </button>
            </div>
          );
        })}
        {v.keyPoints.length < 5 && (
          <button type="button" onClick={() => set({ ...v, keyPoints: [...v.keyPoints, keyPointForm()] })}>
            {R.briefs.addKeyPoint}
          </button>
        )}
      </fieldset>
      <div className="rx-grid2">
        <Field label={R.briefs.fields.affiliation}>
          <Select value={v.affiliation} options={REDDIT_AFFILIATIONS} labels={R.briefs.affiliations} empty={R.common.choose} onChange={(x) => set({ ...v, affiliation: x })} />
        </Field>
        <Field label={R.briefs.fields.brand} hint={R.briefs.brandHint}>
          <input value={v.brand} maxLength={64} onChange={(e) => set({ ...v, brand: e.target.value })} />
        </Field>
        <Field label={R.briefs.fields.tone}>
          <input value={v.tone} maxLength={64} onChange={(e) => set({ ...v, tone: e.target.value })} />
        </Field>
        <Field label={R.briefs.fields.language}>
          <input value={v.language} maxLength={16} onChange={(e) => set({ ...v, language: e.target.value })} />
        </Field>
      </div>
      <label className="rx-check">
        <input type="checkbox" checked={v.linksAllowed} onChange={(e) => set({ ...v, linksAllowed: e.target.checked })} />
        {R.briefs.fields.linksAllowed}
      </label>
      <Field label={R.briefs.fields.constraints}>
        <textarea rows={2} value={v.constraints} onChange={(e) => set({ ...v, constraints: e.target.value })} />
      </Field>
      <Field label={R.briefs.fields.forbiddenClaims}>
        <textarea rows={2} value={v.forbiddenClaims} onChange={(e) => set({ ...v, forbiddenClaims: e.target.value })} />
      </Field>
      <Field label={R.briefs.fields.cta}>
        <input value={v.cta} maxLength={300} onChange={(e) => set({ ...v, cta: e.target.value })} />
      </Field>
      {issues.length > 0 && (
        <ul className="rx-list rx-warn">
          {issues.map((x) => (
            <li key={x}>{R.briefs.issues[x]}</li>
          ))}
        </ul>
      )}
    </>
  );
}

function AddBrief({ projectId, opportunityId }: { projectId: string; opportunityId: string }) {
  const { api, go } = useRx();
  const m = useMutation();
  const [v, setV] = useState<BriefForm>(() => briefForm());
  // Из карточки возможности (`?opp=`): comment к её треду, контекст — выдержка.
  const from = useLoad(async () => (opportunityId ? api.reddit.opportunity(opportunityId) : null), [api, opportunityId]);
  const [prefilled, setPrefilled] = useState('');
  if (from.data && prefilled !== from.data.id) {
    setPrefilled(from.data.id);
    setV(briefFormFromOpportunity(from.data));
  }
  const body = briefCreateBody(projectId, v);
  return (
    <Section title={R.briefs.create}>
      {from.error ? <ErrorAlert error={from.error} /> : null}
      <BriefFields v={v} set={setV} create projectId={projectId} />
      <ErrorAlert error={m.error} />
      <button
        type="button"
        disabled={!body || m.busy}
        onClick={async () => {
          if (!body) return;
          const x = await m.run((k) => api.studio.createBrief(k, body), `createBrief:${JSON.stringify(body)}`);
          if (x) go({ id: x.id, opp: '' });
        }}
      >
        {R.briefs.create}
      </button>
    </Section>
  );
}

function BriefCard({ id }: { id: string }) {
  const { api, go } = useRx();
  const state = useLoad(() => api.studio.brief(id), [api, id]);
  const [fresh, setFresh] = useState<RedditBriefView | null>(null);
  const b = fresh && fresh.id === id && (!state.data || fresh.revision >= state.data.revision) ? fresh : state.data;
  const reload = () => {
    setFresh(null);
    state.reload();
  };
  return (
    <div className="rx-stack">
      <button type="button" className="rx-linkbtn" onClick={() => go({ id: '' })}>
        {R.common.back}
      </button>
      {state.error ? <ErrorAlert error={state.error} /> : null}
      {!b ? state.loading ? <Loading /> : null : <BriefCardBody b={b} reload={reload} onSaved={setFresh} />}
    </div>
  );
}

function BriefCardBody({ b, reload, onSaved }: { b: RedditBriefView; reload: () => void; onSaved: (b: RedditBriefView) => void }) {
  const { api, go } = useRx();
  const contents = useLoad(() => api.studio.briefContents(b.id), [api, b.id, b.revision]);
  const sources = useLoad(async () => (await api.content.sources({ limit: 100 })).items, [api]);
  const title = (id: string) => sources.data?.find((x) => x.id === id)?.title ?? fmtText(R.briefs.sourceUnknown, { id });
  return (
    <>
      <Section title={<span className="rx-wrap">{b.objective}</span>} action={<Badge tone={briefTone(b.status)}>{R.briefs.statuses[b.status]}</Badge>}>
        <div className="rx-row">
          <Badge>{R.briefs.contentTypes[b.contentType]}</Badge>
          <button type="button" className="rx-linkbtn" onClick={() => go({ tab: 'communities', id: b.communityId })}>
            r/{b.subreddit}
          </button>
          {b.opportunityId && (
            <button type="button" className="rx-linkbtn" onClick={() => go({ tab: 'opportunities', id: b.opportunityId as string })}>
              {R.briefs.fields.opportunity}
            </button>
          )}
          {b.threadUrl && <RedditLink url={b.threadUrl}>{R.studio.openThread}</RedditLink>}
        </div>
        <Row label={R.briefs.fields.affiliation}>{b.affiliation ? R.briefs.affiliations[b.affiliation] : R.common.none}</Row>
        <Row label={R.briefs.fields.brand}>{b.brand ?? R.common.none}</Row>
        <Row label={R.briefs.fields.linksAllowed}>{b.linksAllowed ? R.common.yes : R.common.no}</Row>
        <Row label={R.briefs.fields.language}>{b.language}</Row>
        <Row label={R.common.updatedAt}>{fmtDateTime(b.updatedAt)}</Row>
        {b.context && (
          <>
            <span className="muted rx-hint">{R.briefs.fields.context}</span>
            <PlainQuote text={b.context} injectionFlag={b.injectionFlag} label={R.briefs.fields.context} />
          </>
        )}
        {b.keyPoints.length > 0 && (
          <ol className="rx-list">
            {b.keyPoints.map((k, i) => (
              <li key={i} className="rx-wrap">
                {k.text}{' '}
                <span className="muted rx-hint">
                  ({k.sourceIds === 'needs_verification' ? R.studio.evidence.needsVerification : k.sourceIds.map(title).join(', ')})
                </span>
              </li>
            ))}
          </ol>
        )}
        {b.missing.length > 0 && (
          <Alert tone="warning" title={R.briefs.missingTitle}>
            <ul className="rx-list">
              {b.missing.map((x) => (
                <li key={x}>{missingText(x, R)}</li>
              ))}
            </ul>
          </Alert>
        )}
        {!b.ai.available && b.ai.reason && <Alert tone="neutral">{R.briefs.ai[b.ai.reason]}</Alert>}
      </Section>
      <Section title={R.briefs.gate}>
        <GateBlock gate={b.gate} />
      </Section>
      <Section title={R.briefs.material}>
        {contents.error ? <ErrorAlert error={contents.error} onReload={contents.reload} /> : null}
        {!contents.data ? (
          contents.loading ? <Loading /> : null
        ) : contents.data.length ? (
          <ul className="rx-items">
            {contents.data.map((m) => (
              <li key={m.content.id} className="rx-row">
                <button type="button" onClick={() => go({ tab: 'studio', id: m.content.id })}>
                  {R.briefs.openStudio}
                </button>
                <Badge>{R.studio.statuses[m.content.status as keyof typeof R.studio.statuses] ?? m.content.status}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <span className="muted">{R.briefs.noMaterial}</span>
        )}
        {b.status === 'ready' && b.missing.length === 0 && contents.data?.length === 0 && <CreateMaterial b={b} />}
      </Section>
      {b.status !== 'archived' ? (
        <>
          <BriefEdit b={b} reload={reload} onSaved={onSaved} />
          <BriefStatusActions b={b} reload={reload} onSaved={onSaved} />
        </>
      ) : (
        <Alert tone="neutral">{R.briefs.archiveHint}</Alert>
      )}
    </>
  );
}

function CreateMaterial({ b }: { b: RedditBriefView }) {
  const { api, go } = useRx();
  const m = useMutation();
  return (
    <div className="rx-stack">
      <ErrorAlert error={m.error} />
      <button
        type="button"
        disabled={m.busy}
        onClick={async () => {
          const x = await m.run((k) => api.studio.createContent(b.id, k, {}), `content:${b.id}`);
          if (x) go({ tab: 'studio', id: x.content.id });
        }}
      >
        {R.briefs.createMaterial}
      </button>
    </div>
  );
}

function BriefEdit({ b, reload, onSaved }: { b: RedditBriefView; reload: () => void; onSaved: (b: RedditBriefView) => void }) {
  const { api } = useRx();
  const m = useMutation();
  const [notice, setNotice] = useState<string | null>(null);
  const f = useRebaseForm<BriefForm>(briefForm(b), b.revision);
  const patch = f.conflicts.length ? null : briefPatchBody(b, f.v, f.base);
  return (
    <Section title={R.common.edit}>
      <BriefFields v={f.v} set={f.set} create={false} projectId={b.projectId} />
      <ConflictPanel
        conflicts={f.conflicts}
        label={(key) => (R.briefs.fields as Record<string, string>)[key as string] ?? String(key)}
        show={(key, x) =>
          key === 'keyPoints'
            ? (x as BriefForm['keyPoints'])
                .map((k, i) => `${fmtText(R.briefs.keyPoint, { n: i + 1 })}: ${k.text} (${k.needsVerification ? R.briefs.needsVerification : k.sources || R.common.none})`)
                .join('; ')
            : conflictValueText(x)
        }
        resolve={f.resolve}
      />
      <Notice text={notice} />
      <ErrorAlert error={m.error} onReload={reload} />
      <button
        type="button"
        disabled={!patch || m.busy}
        onClick={async () => {
          if (!patch) return;
          const x = await m.run((k) => api.studio.patchBrief(b.id, k, patch), `patchBrief:${b.id}:${JSON.stringify(patch)}`);
          if (x) {
            setNotice(R.briefs.saved);
            onSaved(x);
          }
        }}
      >
        {R.common.save}
      </button>
    </Section>
  );
}

function BriefStatusActions({ b, reload, onSaved }: { b: RedditBriefView; reload: () => void; onSaved: (b: RedditBriefView) => void }) {
  const { api } = useRx();
  const ready = useMutation();
  const arch = useMutation();
  return (
    <Section title={R.common.status}>
      {b.status === 'draft' && (
        <>
          <span className="muted rx-hint">{R.briefs.readyHint}</span>
          <ErrorAlert error={ready.error} onReload={reload} />
          <button
            type="button"
            disabled={ready.busy}
            onClick={async () => {
              const x = await ready.run((k) => api.studio.briefReady(b.id, k, b.revision), `ready:${b.id}:${b.revision}`);
              if (x) onSaved(x);
            }}
          >
            {R.briefs.ready}
          </button>
        </>
      )}
      <span className="muted rx-hint">{R.briefs.archiveHint}</span>
      <ErrorAlert error={arch.error} onReload={reload} />
      <ConfirmButton
        danger
        busy={arch.busy}
        onConfirm={async () => {
          const x = await arch.run((k) => api.studio.archiveBrief(b.id, k, b.revision), `archiveBrief:${b.id}:${b.revision}`);
          if (x) onSaved(x);
        }}
      >
        {R.common.archive}
      </ConfirmButton>
    </Section>
  );
}
