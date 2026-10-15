'use client';

// «Сообщества и правила»: список сообществ проекта, добавление (r/name или
// ссылка — нормализация как у сервера), карточка (правка только
// изменённых полей, архив/возврат) и снимки правил: версии, первоисточник
// (https, не загружается), выдержка только текстом, «проверено человеком»
// (подтверждение автором — пометка selfReview), отзыв первоисточника и новый
// снимок.

import { useState } from 'react';
import { fmtDateTime, isOwnActor, R } from '../../lib/reddit';
import {
  REDDIT_COMMUNITY_STATUSES,
  REDDIT_LINKS_POLICIES,
  REDDIT_PROMOTION_POLICIES,
  type RedditCommunityView,
  type RedditRuleSnapshotView,
} from '../../lib/reddit-shared/lib/publisher/reddit-api';
import {
  canReviewSnapshot,
  communityBody,
  communityForm,
  communityPatchBody,
  emptyRulesForm,
  normalizeSubreddit,
  rulesBody,
  snapshotStateTone,
  type CommunityForm,
  type Flair,
  type RulesForm,
} from '../../lib/reddit-shared/lib/publisher/reddit-view';
import { fmtText } from '../../lib/reddit-shared/lib/publisher/view';
import {
  ActorText,
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
  RevokeEvidence,
  Row,
  Section,
  Select,
  SourceLink,
  useLoad,
  useMutation,
  usePaged,
  useRebaseForm,
  useRx,
} from './ui';

export function RulesSummaryLine({ c }: { c: RedditCommunityView }) {
  if (!c.rules) {
    return (
      <div className="rx-stack">
        <div className="rx-row">
          <Badge tone="danger">{R.communities.noRules}</Badge>
        </div>
        <GateBlock gate={{ verdict: 'block', reasons: ['rules_missing'], warnings: [] }} />
      </div>
    );
  }
  const s = c.rules;
  return (
    <div className="rx-stack">
      <div className="rx-row">
        <Badge>{fmtText(R.rules.version, { n: s.version })}</Badge>
        <Badge tone={snapshotStateTone(s.state, s.gate.reasons)}>{R.rules.states[s.state]}</Badge>
        {s.selfReview && <Badge tone="warning">{R.rules.selfReview}</Badge>}
      </div>
      <span className="muted rx-hint">
        {R.communities.lastChecked}: {fmtDateTime(s.checkedAt)} · {R.rules.fields.promotionPolicy}: {R.rules.promotion[s.promotionPolicy]} ·{' '}
        {R.rules.fields.linksPolicy}: {R.rules.links[s.linksPolicy]}
      </span>
      <GateBlock gate={s.gate} />
    </div>
  );
}

export function CommunitiesTab() {
  const { route } = useRx();
  if (route.id) return <CommunityCard id={route.id} />;
  return <CommunityList />;
}

function CommunityList() {
  const { api, route, go } = useRx();
  const [status, setStatus] = useState<'' | 'active' | 'archived'>('');
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  const page = usePaged(
    (before) =>
      api.reddit.communities({
        projectId: route.project || undefined,
        status: status || undefined,
        q: applied || undefined,
        before,
        limit: 50,
      }),
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
        <Select ariaLabel={R.common.status} value={status} options={REDDIT_COMMUNITY_STATUSES} labels={R.statuses} empty="все статусы" onChange={setStatus} />
        <input aria-label={R.common.search} placeholder={R.common.searchHint} value={q} onChange={(e) => setQ(e.target.value)} className="rx-grow" />
        <button type="submit">{R.common.apply}</button>
        <CsvButton list="communities" query={{ projectId: route.project || undefined, status: status || undefined, q: applied || undefined }} />
      </form>
      <Section title={R.communities.title}>
        <ul className="rx-items">
          {page.items.map((c) => (
            <li key={c.id} className="rx-item">
              <div className="rx-row">
                <button type="button" className="rx-linkbtn" onClick={() => go({ id: c.id })}>
                  r/{c.subreddit}
                </button>
                {c.status !== 'active' && <Badge tone="warning">{R.statuses[c.status]}</Badge>}
                <RedditLink url={c.canonicalUrl}>{R.common.openOnReddit}</RedditLink>
              </div>
              <RulesSummaryLine c={c} />
            </li>
          ))}
        </ul>
        <PagedFooter page={page} empty={R.communities.empty} />
      </Section>
      {route.project ? (
        <AddCommunity projectId={route.project} onDone={page.reload} />
      ) : (
        <Alert tone="neutral">Чтобы добавить сообщество, выберите проект выше.</Alert>
      )}
    </div>
  );
}

function CommunityFields({ v, set, withName }: { v: CommunityForm; set: (v: CommunityForm) => void; withName: boolean }) {
  const norm = normalizeSubreddit(v.community);
  return (
    <>
      {withName && (
        <Field
          label={R.communities.fields.community}
          hint={v.community.trim() === '' ? undefined : norm ? fmtText(R.communities.normalized, { name: norm }) : R.communities.invalid}
        >
          <input value={v.community} maxLength={300} placeholder="r/name" onChange={(e) => set({ ...v, community: e.target.value })} />
        </Field>
      )}
      <Field label={R.communities.fields.descriptionManual}>
        <textarea rows={2} maxLength={2000} value={v.descriptionManual} onChange={(e) => set({ ...v, descriptionManual: e.target.value })} />
      </Field>
      <div className="rx-grid2">
        <Field label={R.communities.fields.language}>
          <input value={v.language} maxLength={16} onChange={(e) => set({ ...v, language: e.target.value })} />
        </Field>
        <Field label={R.communities.fields.topics}>
          <input value={v.topics} onChange={(e) => set({ ...v, topics: e.target.value })} />
        </Field>
      </div>
    </>
  );
}

function AddCommunity({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const { api, go } = useRx();
  const m = useMutation();
  const [v, setV] = useState<CommunityForm>(communityForm(null));
  const [done, setDone] = useState<string | null>(null);
  const body = communityBody(projectId, v);
  return (
    <Section title={R.communities.add}>
      <CommunityFields v={v} set={setV} withName />
      <ErrorAlert error={m.error} onExisting={(id) => go({ id })} />
      <Notice text={done} />
      <button
        type="button"
        disabled={!body || m.busy}
        onClick={async () => {
          if (!body) return;
          setDone(null);
          const x = await m.run((k) => api.reddit.createCommunity(k, body), `createCommunity:${JSON.stringify(body)}`);
          if (x) {
            setV(communityForm(null));
            setDone(fmtText(R.communities.normalized, { name: x.subreddit }));
            onDone();
          }
        }}
      >
        {R.communities.add}
      </button>
    </Section>
  );
}

function CommunityCard({ id }: { id: string }) {
  const { api, go } = useRx();
  const state = useLoad(() => api.reddit.community(id), [api, id]);
  const rules = useLoad(() => api.reddit.rules(id), [api, id]);
  const [fresh, setFresh] = useState<RedditCommunityView | null>(null);
  const c = fresh && fresh.id === id && (!state.data || fresh.revision >= state.data.revision) ? fresh : state.data;
  const reloadAll = () => {
    setFresh(null);
    state.reload();
    rules.reload();
  };
  return (
    <div className="rx-stack">
      <button type="button" className="rx-linkbtn" onClick={() => go({ id: '' })}>
        {R.common.back}
      </button>
      {state.error ? <ErrorAlert error={state.error} /> : null}
      {!c ? (
        state.loading ? <Loading /> : null
      ) : (
        <>
          <CommunityCardBody c={c} reload={reloadAll} onSaved={setFresh} />
          <Section title={R.rules.versions}>
            {rules.error ? <ErrorAlert error={rules.error} onReload={rules.reload} /> : null}
            {!rules.data ? (
              rules.loading ? <Loading /> : null
            ) : rules.data.items.length === 0 ? (
              <Alert tone="warning">{R.rules.empty}</Alert>
            ) : (
              rules.data.items.map((s) => <SnapshotCard key={s.id} s={s} onChanged={reloadAll} />)
            )}
          </Section>
          <NewSnapshot c={c} onDone={reloadAll} />
        </>
      )}
    </div>
  );
}

function CommunityCardBody({
  c,
  reload,
  onSaved,
}: {
  c: RedditCommunityView;
  reload: () => void;
  onSaved: (c: RedditCommunityView) => void;
}) {
  const { api, go } = useRx();
  const m = useMutation();
  const ms = useMutation();
  const f = useRebaseForm<CommunityForm>(communityForm(c), c.revision);
  const [done, setDone] = useState<string | null>(null);
  const patch = f.conflicts.length ? null : communityPatchBody(c, f.v, f.base);
  const active = c.status === 'active';
  const fieldLabel = (k: keyof CommunityForm) => R.communities.fields[k];
  return (
    <Section title={`r/${c.subreddit}`} action={<Badge tone={active ? 'neutral' : 'warning'}>{R.statuses[c.status]}</Badge>}>
      <div className="rx-row">
        <RedditLink url={c.canonicalUrl}>{R.common.openOnReddit}</RedditLink>
        <button type="button" className="rx-linkbtn" onClick={() => go({ tab: 'opportunities', id: '', project: c.projectId })}>
          {R.communities.openOpportunities}
        </button>
      </div>
      <RulesSummaryLine c={c} />
      <span className="muted rx-hint">{fmtText(R.communities.staleHint, { n: c.staleDays })}</span>
      <CommunityFields v={f.v} set={f.set} withName={false} />
      <ConflictPanel conflicts={f.conflicts} label={fieldLabel} resolve={f.resolve} />
      <ErrorAlert error={m.error} onReload={reload} />
      <Notice text={done} />
      <div className="rx-row">
        <button
          type="button"
          disabled={!patch || m.busy}
          onClick={async () => {
            if (!patch) return;
            const x = await m.run((k) => api.reddit.patchCommunity(c.id, k, patch), `patchCommunity:${c.id}:${JSON.stringify(patch)}`);
            if (x) {
              setDone(R.common.saved);
              onSaved(x);
            }
          }}
        >
          {R.common.save}
        </button>
        <ConfirmButton
          danger={active}
          busy={ms.busy}
          onConfirm={async () => {
            const body = { expectedRevision: c.revision, status: active ? ('archived' as const) : ('active' as const) };
            const x = await ms.run((k) => api.reddit.patchCommunity(c.id, k, body), `statusCommunity:${c.id}:${JSON.stringify(body)}`);
            if (x) onSaved(x);
          }}
        >
          {active ? R.common.archive : R.common.restore}
        </ConfirmButton>
      </div>
      <ErrorAlert error={ms.error} onReload={reload} />
      <span className="muted rx-hint">{R.communities.archiveHint}</span>
    </Section>
  );
}

function SnapshotCard({ s, onChanged }: { s: RedditRuleSnapshotView; onChanged: () => void }) {
  const { api, userId } = useRx();
  const m = useMutation();
  const [done, setDone] = useState<string | null>(null);
  const own = isOwnActor(s.createdBy, userId);
  const current = s.status === 'current';
  return (
    <div className={`card rx-stack rx-inner${current ? '' : ' rx-dim'}`} data-snapshot={s.id}>
      <div className="rx-row">
        <b>{fmtText(R.rules.version, { n: s.version })}</b>
        <Badge tone={current ? 'accent' : 'neutral'}>{R.rules.snapshotStatuses[s.status]}</Badge>
        <Badge tone={snapshotStateTone(s.state, s.gate.reasons, s.source.usage)}>{R.rules.states[s.state]}</Badge>
        {s.selfReview && <Badge tone="warning">{R.rules.selfReview}</Badge>}
      </div>
      <GateBlock gate={s.gate} />
      <Row label={R.rules.fields.promotionPolicy}>{R.rules.promotion[s.promotionPolicy]}</Row>
      <Row label={R.rules.fields.linksPolicy}>{R.rules.links[s.linksPolicy]}</Row>
      <Row label={R.rules.fields.flairRequired}>
        {s.flairRequired === null ? R.rules.flair.unknown : s.flairRequired ? R.rules.flair.yes : R.rules.flair.no}
      </Row>
      {s.conditions.length > 0 && (
        <div>
          <span className="muted">{R.rules.fields.conditions}:</span>
          <ul className="rx-list">
            {s.conditions.map((x, i) => (
              <li key={i} className="rx-wrap">
                {x}
              </li>
            ))}
          </ul>
        </div>
      )}
      <Row label={R.rules.checkedAt}>{fmtDateTime(s.checkedAt)}</Row>
      <Row label={R.rules.createdBy}>
        <ActorText actor={s.createdBy} userId={userId} />
      </Row>
      {s.reviewedAt && (
        <Row label={R.rules.reviewedBy}>
          <ActorText actor={s.reviewedBy} userId={userId} /> · {fmtDateTime(s.reviewedAt)}
        </Row>
      )}
      <Row label={R.rules.source}>
        <SourceLink url={s.source.url} />
      </Row>
      <span className="muted rx-hint">
        {R.rules.excerpt} · {R.rules.usage[s.source.usage]}
      </span>
      <PlainQuote text={s.source.excerpt} injectionFlag={s.source.injectionFlag} label={R.rules.excerpt} />
      {s.source.usage === 'revoked' ? (
        <RevokedSourceNote communityId={s.communityId} snapshotId={s.id} />
      ) : (
        <RevokeEvidence sourceId={s.source.id} label={R.common.revokeRulesSource} onDone={onChanged} />
      )}
      {canReviewSnapshot(s) && (
        <div className="rx-stack">
          <span className="muted rx-hint">{R.rules.reviewHint}</span>
          {own && <Alert tone="warning">{R.rules.selfReviewWarning}</Alert>}
          <ErrorAlert error={m.error} onReload={onChanged} />
          <ConfirmButton
            busy={m.busy}
            onConfirm={async () => {
              setDone(null);
              const x = await m.run((k) => api.reddit.reviewRules(s.id, k), `review:${s.id}`);
              if (x) {
                setDone(x.selfReview ? `${R.rules.reviewed} (${R.rules.selfReview})` : R.rules.reviewed);
                onChanged();
              }
            }}
          >
            {R.rules.review}
          </ConfirmButton>
        </div>
      )}
      <Notice text={done} />
    </div>
  );
}

function RevokedSourceNote({ communityId, snapshotId }: { communityId: string; snapshotId: string }) {
  const { api } = useRx();
  const st = useLoad(() => api.reddit.rulesSource(communityId, snapshotId), [api, communityId, snapshotId]);
  return (
    <Alert tone="danger" title={R.rules.sourceRevokedNote}>
      {st.data ? (
        <span>
          {fmtDateTime(st.data.source.revokedAt)} · {R.opportunities.evidenceRevokeReason}: {st.data.source.revokeReason ?? R.common.none}
        </span>
      ) : st.error ? (
        <ErrorAlert error={st.error} />
      ) : null}
    </Alert>
  );
}

const ISSUE_TEXT: Partial<Record<string, string>> = {
  url: R.rules.urlInvalid,
  future: R.rules.future,
  conditions: R.rules.conditionsTooMany,
};

function NewSnapshot({ c, onDone }: { c: RedditCommunityView; onDone: () => void }) {
  const { api } = useRx();
  const m = useMutation();
  const [v, setV] = useState<RulesForm>(emptyRulesForm());
  const [done, setDone] = useState<string | null>(null);
  if (c.status !== 'active') return <Alert tone="warning">{R.communities.archiveHint}</Alert>;
  const { body, issues } = rulesBody(v);
  const touched = v.sourceUrl !== '' || v.sourceExcerpt !== '';
  const shown = touched ? issues.filter((x) => ISSUE_TEXT[x] && !(x === 'url' && !v.sourceUrl)) : [];
  return (
    <Section title={R.rules.newSnapshot}>
      <span className="muted rx-hint">{R.rules.newSnapshotHint}</span>
      <Field label={R.rules.fields.sourceUrl}>
        <input
          type="url"
          value={v.sourceUrl}
          maxLength={2048}
          placeholder={`${c.canonicalUrl}/about/rules`}
          onChange={(e) => setV({ ...v, sourceUrl: e.target.value })}
        />
      </Field>
      <Field label={R.rules.fields.sourceExcerpt}>
        <textarea rows={5} maxLength={5000} value={v.sourceExcerpt} onChange={(e) => setV({ ...v, sourceExcerpt: e.target.value })} />
      </Field>
      <div className="rx-grid2">
        <Field label={R.rules.fields.promotionPolicy}>
          <Select
            value={v.promotionPolicy}
            options={REDDIT_PROMOTION_POLICIES}
            labels={R.rules.promotion}
            empty={R.common.choose}
            onChange={(x) => setV({ ...v, promotionPolicy: x })}
          />
        </Field>
        <Field label={R.rules.fields.linksPolicy}>
          <Select value={v.linksPolicy} options={REDDIT_LINKS_POLICIES} labels={R.rules.links} empty={R.common.choose} onChange={(x) => setV({ ...v, linksPolicy: x })} />
        </Field>
        <Field label={R.rules.fields.flairRequired}>
          <Select
            value={v.flair}
            options={['unknown', 'yes', 'no'] as const}
            labels={R.rules.flair}
            onChange={(x) => setV({ ...v, flair: (x || 'unknown') as Flair })}
          />
        </Field>
        <Field label={R.rules.fields.checkedAt}>
          <input type="datetime-local" value={v.checkedAt} onChange={(e) => setV({ ...v, checkedAt: e.target.value })} />
        </Field>
      </div>
      <Field label={R.rules.fields.conditions}>
        <textarea rows={3} value={v.conditions} onChange={(e) => setV({ ...v, conditions: e.target.value })} />
      </Field>
      {shown.length > 0 && (
        <ul className="rx-list rx-warn">
          {shown.map((x) => (
            <li key={x}>{ISSUE_TEXT[x]}</li>
          ))}
        </ul>
      )}
      <ErrorAlert error={m.error} onReload={onDone} />
      <Notice text={done} />
      <button
        type="button"
        disabled={!body || m.busy}
        onClick={async () => {
          if (!body) return;
          setDone(null);
          const x = await m.run((k) => api.reddit.createRules(c.id, k, body), `createRules:${c.id}:${JSON.stringify(body)}`);
          if (x) {
            setV(emptyRulesForm());
            setDone(R.rules.created);
            onDone();
          }
        }}
      >
        {R.rules.newSnapshot}
      </button>
    </Section>
  );
}
