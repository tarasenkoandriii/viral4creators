'use client';

// «Возможности»: треды, внесённые вручную (ссылка + своя выдержка), факторы
// оценки 0–100 с обоснованием (пусто — «не оценено», `policy_risk` считает
// сервер), score v1, гейт «сейчас» и «на момент оценки», переходы
// qualify/skip/archive (машина сервера), выдержка и её редакции (отзыв), бриф
// из карточки. Правки — только изменённые поля, 409 — перечитать без потери
// ввода.

import { useState } from 'react';
import { fmtDateTime, R, T } from '../../lib/reddit';
import {
  REDDIT_INTENTS,
  REDDIT_OPERATOR_FACTORS,
  REDDIT_OPPORTUNITY_STATUSES,
  REDDIT_POLICY_VERDICTS,
  type RedditCommunityView,
  type RedditFactorValue,
  type RedditKeywordView,
  type RedditOpportunityView,
  type RedditPolicyVerdict,
  type RedditScoreFactor,
  type RedditTransition,
} from '../../lib/reddit-shared/lib/publisher/reddit-api';
import {
  emptyOpportunityForm,
  excerptEditable,
  excerptPatchBody,
  factorForm,
  factorsBody,
  historicVerdictTone,
  NEED_RESCORE,
  normalizeThreadUrl,
  opportunityActions,
  opportunityBody,
  opportunityEditForm,
  opportunityPatchBody,
  opportunityTone,
  policyRiskText,
  threadMismatch,
  transitionBody,
  type FactorForm,
  type FactorIssue,
  type OpportunityEditForm,
  type OpportunityForm,
} from '../../lib/reddit-shared/lib/publisher/reddit-view';
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
  RevokeEvidence,
  Row,
  Section,
  Select,
  useLoad,
  useMutation,
  usePaged,
  useRebaseForm,
  useRx,
} from './ui';

const RELEVANCE: readonly string[] = ['topic_fit', 'intent_fit', 'audience_fit', 'answerability'];

function useCommunities(projectId: string) {
  const { api } = useRx();
  return useLoad(async (): Promise<RedditCommunityView[]> => (projectId ? (await api.reddit.communities({ projectId, limit: 100 })).items : []), [api, projectId]);
}

function useKeywords(projectId: string) {
  const { api } = useRx();
  return useLoad(async (): Promise<RedditKeywordView[]> => (projectId ? (await api.reddit.keywords({ projectId, limit: 100 })).items : []), [api, projectId]);
}

function ScoreLine({ o }: { o: RedditOpportunityView }) {
  const n = (v: number | null) => (v === null ? <span className="rx-warn">{R.opportunities.notComputed}</span> : <span>{v}</span>);
  return (
    <span>
      {R.opportunities.relevance} {n(o.score.relevance)} · {R.opportunities.risk} {n(o.score.risk)} · {R.opportunities.priority}{' '}
      {n(o.score.priority)}
    </span>
  );
}

export function OpportunitiesTab() {
  const { route } = useRx();
  if (route.id) return <OpportunityCard id={route.id} />;
  return <OpportunityList />;
}

function OpportunityList() {
  const { api, route, go } = useRx();
  const communities = useCommunities(route.project);
  const [status, setStatus] = useState<string>('');
  const [communityId, setCommunityId] = useState('');
  const [policyNow, setPolicyNow] = useState<RedditPolicyVerdict | ''>('');
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  const page = usePaged(
    (before) =>
      api.reddit.opportunities({
        status: status || undefined,
        projectId: route.project || undefined,
        communityId: communityId || undefined,
        policyNow: policyNow || undefined,
        q: applied || undefined,
        before,
        limit: 50,
      }),
    [api, status, route.project, communityId, policyNow, applied],
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
        <Select
          ariaLabel={R.opportunities.filterStatus}
          value={status}
          options={REDDIT_OPPORTUNITY_STATUSES}
          labels={R.opportunities.statuses}
          empty="все статусы"
          onChange={setStatus}
        />
        {route.project && (
          <select aria-label={R.common.community} value={communityId} onChange={(e) => setCommunityId(e.target.value)}>
            <option value="">{R.common.allCommunities}</option>
            {(communities.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                r/{c.subreddit}
              </option>
            ))}
          </select>
        )}
        <Select
          ariaLabel={R.opportunities.policyFilter}
          value={policyNow}
          options={REDDIT_POLICY_VERDICTS}
          labels={R.gate.verdicts}
          empty={`${R.opportunities.policyFilter}: ${T.common.all.toLowerCase()}`}
          onChange={setPolicyNow}
        />
        <input aria-label={R.common.search} placeholder={R.common.searchHint} value={q} onChange={(e) => setQ(e.target.value)} className="rx-grow" />
        <button type="submit">{R.common.apply}</button>
        <CsvButton
          list="opportunities"
          query={{ status: status || undefined, projectId: route.project || undefined, communityId: communityId || undefined, policyNow: policyNow || undefined, q: applied || undefined }}
        />
      </form>
      <div className="rx-row">
        {NEED_RESCORE.map((x) => (
          <button
            key={x.policyNow}
            type="button"
            className="rx-linkbtn"
            onClick={() => {
              setStatus(x.status);
              setPolicyNow(x.policyNow);
            }}
          >
            {R.opportunities.needRescore}: {R.gate.verdicts[x.policyNow]}
          </button>
        ))}
      </div>
      <Section title={R.opportunities.title}>
        <ul className="rx-items">
          {page.items.map((o) => (
            <li key={o.id} className="rx-item">
              <div className="rx-row">
                <button type="button" className="rx-linkbtn rx-wrap" onClick={() => go({ id: o.id })}>
                  {o.titleManual}
                </button>
                <Badge tone={opportunityTone(o.status)}>{R.opportunities.statuses[o.status]}</Badge>
                {opportunityActions(o).stale && <Badge tone="warning">{R.opportunities.staleBadge}</Badge>}
              </div>
              <div className="muted">
                r/{o.subreddit} · {R.opportunities.intents[o.intent]}
              </div>
              <ScoreLine o={o} />
              <GateBlock gate={{ verdict: o.policyNow, reasons: o.policyNowReasons, warnings: [] }} label={R.opportunities.policyNow} />
              <RedditLink url={o.threadUrl}>{R.common.openOnReddit}</RedditLink>
            </li>
          ))}
        </ul>
        <PagedFooter page={page} empty={R.opportunities.empty} />
      </Section>
      {route.project ? (
        <AddOpportunity
          projectId={route.project}
          communities={(communities.data ?? []).filter((c) => c.status === 'active')}
          initialCommunity={communityId}
          onDone={page.reload}
        />
      ) : (
        <Alert tone="neutral">Чтобы добавить тред, выберите проект выше.</Alert>
      )}
    </div>
  );
}

function FactorEditor({
  value,
  onChange,
  issues,
  policyRisk,
}: {
  value: FactorForm;
  onChange: (v: FactorForm) => void;
  issues: FactorIssue[];
  policyRisk?: RedditFactorValue | null;
}) {
  const issueOf = (k: string) => issues.find((x) => x.factor === k)?.code;
  return (
    <div className="rx-stack">
      <b>{R.opportunities.factorsTitle}</b>
      {(['relevance', 'risk'] as const).map((g) => (
        <fieldset key={g} className="rx-fieldset rx-stack">
          <legend className="muted">{R.opportunities.groups[g]}</legend>
          {g === 'risk' && (
            <div className="rx-derived">
              <b>
                {R.opportunities.factors.policy_risk}: {policyRisk?.value ?? R.opportunities.notRated}
              </b>
              {policyRiskText(policyRisk?.reasons, R).map((x) => (
                <div key={x} className="rx-hint">
                  {x}
                </div>
              ))}
              <div className="muted rx-hint">{R.opportunities.policyRiskDerived}</div>
            </div>
          )}
          {REDDIT_OPERATOR_FACTORS.filter((k) => (g === 'relevance' ? RELEVANCE.includes(k) : !RELEVANCE.includes(k))).map((k) => {
            const code = issueOf(k);
            return (
              <div key={k} className="rx-factor">
                <span className="rx-factor-name">{R.opportunities.factors[k]}</span>
                <Field label={R.opportunities.value}>
                  <input
                    aria-label={`${R.opportunities.factors[k]}: ${R.opportunities.value}`}
                    inputMode="numeric"
                    value={value[k].value}
                    maxLength={3}
                    placeholder="0–100"
                    onChange={(e) => onChange({ ...value, [k]: { ...value[k], value: e.target.value } })}
                  />
                </Field>
                <Field
                  label={R.opportunities.why}
                  hint={
                    code === 'value'
                      ? R.opportunities.valueInvalid
                      : code === 'why'
                        ? R.opportunities.whyRequired
                        : code === 'whyLength'
                          ? R.opportunities.whyTooLong
                          : undefined
                  }
                >
                  <input
                    aria-label={`${R.opportunities.factors[k]}: ${R.opportunities.why}`}
                    value={value[k].why}
                    maxLength={300}
                    onChange={(e) => onChange({ ...value, [k]: { ...value[k], why: e.target.value } })}
                  />
                </Field>
              </div>
            );
          })}
        </fieldset>
      ))}
    </div>
  );
}

function KeywordPicker({ keywords, value, onChange }: { keywords: RedditKeywordView[]; value: string[]; onChange: (v: string[]) => void }) {
  const active = keywords.filter((k) => k.status === 'active' || value.includes(k.id));
  if (!active.length) return null;
  return (
    <fieldset className="rx-fieldset">
      <legend className="muted">{R.opportunities.fields.keywords}</legend>
      <div className="rx-row">
        {active.map((k) => (
          <label key={k.id} className="rx-check">
            <input
              type="checkbox"
              checked={value.includes(k.id)}
              disabled={!value.includes(k.id) && value.length >= 10}
              onChange={(e) => onChange(e.target.checked ? [...value, k.id] : value.filter((x) => x !== k.id))}
            />
            {k.phrase}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const OPP_ISSUES: Partial<Record<string, string>> = {
  thread: R.opportunities.threadInvalid,
  title: R.opportunities.fields.titleManual,
  intent: R.opportunities.fields.intent,
};

function AddOpportunity({
  projectId,
  communities,
  initialCommunity,
  onDone,
}: {
  projectId: string;
  communities: RedditCommunityView[];
  initialCommunity: string;
  onDone: () => void;
}) {
  const { api, go } = useRx();
  const keywords = useKeywords(projectId);
  const m = useMutation();
  const [v, setV] = useState<OpportunityForm>(() => emptyOpportunityForm(initialCommunity));
  const [done, setDone] = useState<string | null>(null);
  if (!communities.length) return <Alert tone="neutral">{R.common.noCommunity}</Alert>;
  const community = communities.find((c) => c.id === v.communityId) ?? null;
  const { body, issues, factorIssues } = opportunityBody(projectId, v, community);
  const norm = normalizeThreadUrl(v.threadUrl);
  const mismatch = threadMismatch(v.threadUrl, community);
  const touched = v.threadUrl.trim() !== '';
  return (
    <Section title={R.opportunities.add}>
      <span className="muted rx-hint">{R.opportunities.addHint}</span>
      <Field label={R.opportunities.newCommunity}>
        <select value={v.communityId} onChange={(e) => setV({ ...v, communityId: e.target.value })}>
          <option value="">{R.common.choose}</option>
          {communities.map((c) => (
            <option key={c.id} value={c.id}>
              r/{c.subreddit}
            </option>
          ))}
        </select>
      </Field>
      <Field
        label={R.opportunities.fields.threadUrl}
        hint={
          !touched
            ? undefined
            : mismatch
              ? fmtText(R.opportunities.threadMismatch, mismatch)
              : norm
                ? fmtText(R.opportunities.threadNormalized, { url: norm.url })
                : R.opportunities.threadInvalid
        }
      >
        <input value={v.threadUrl} maxLength={2048} onChange={(e) => setV({ ...v, threadUrl: e.target.value })} />
      </Field>
      <Field label={R.opportunities.fields.titleManual}>
        <input value={v.titleManual} maxLength={300} onChange={(e) => setV({ ...v, titleManual: e.target.value })} />
      </Field>
      <Field label={R.opportunities.fields.excerpt}>
        <textarea rows={3} maxLength={2000} value={v.excerpt} onChange={(e) => setV({ ...v, excerpt: e.target.value })} />
      </Field>
      <div className="rx-grid2">
        <Field label={R.opportunities.fields.intent}>
          <Select value={v.intent} options={REDDIT_INTENTS} labels={R.opportunities.intents} empty={R.common.choose} onChange={(x) => setV({ ...v, intent: x })} />
        </Field>
        <Field label={R.opportunities.fields.angle}>
          <input value={v.angle} maxLength={1000} onChange={(e) => setV({ ...v, angle: e.target.value })} />
        </Field>
      </div>
      <KeywordPicker keywords={keywords.data ?? []} value={v.keywordIds} onChange={(x) => setV({ ...v, keywordIds: x })} />
      <FactorEditor value={v.factors} onChange={(x) => setV({ ...v, factors: x })} issues={factorIssues} />
      {touched && issues.filter((x) => OPP_ISSUES[x] && x !== 'thread').length > 0 && (
        <span className="muted rx-hint">
          Заполните: {issues.filter((x) => OPP_ISSUES[x] && x !== 'thread').map((x) => OPP_ISSUES[x]).join(', ')}
        </span>
      )}
      <ErrorAlert error={m.error} onExisting={(id) => go({ id })} />
      <Notice text={done} />
      <button
        type="button"
        disabled={!body || m.busy}
        onClick={async () => {
          if (!body) return;
          setDone(null);
          const x = await m.run((k) => api.reddit.createOpportunity(k, body), `createOpportunity:${JSON.stringify(body)}`);
          if (x) {
            setV(emptyOpportunityForm(v.communityId));
            setDone(R.common.saved);
            onDone();
          }
        }}
      >
        {R.opportunities.add}
      </button>
    </Section>
  );
}

function OpportunityCard({ id }: { id: string }) {
  const { api, go } = useRx();
  const state = useLoad(() => api.reddit.opportunity(id), [api, id]);
  const [fresh, setFresh] = useState<RedditOpportunityView | null>(null);
  const o = fresh && fresh.id === id && (!state.data || fresh.revision >= state.data.revision) ? fresh : state.data;
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
      {!o ? state.loading ? <Loading /> : null : <OpportunityCardBody o={o} reload={reload} onSaved={setFresh} />}
    </div>
  );
}

function OpportunityCardBody({ o, reload, onSaved }: { o: RedditOpportunityView; reload: () => void; onSaved: (o: RedditOpportunityView) => void }) {
  const { go } = useRx();
  const keywords = useKeywords(o.projectId);
  const kwById = new Map((keywords.data ?? []).map((k) => [k.id, k.phrase]));
  const actions = opportunityActions(o);
  return (
    <>
      <Section title={<span className="rx-wrap">{o.titleManual}</span>} action={<Badge tone={opportunityTone(o.status)}>{R.opportunities.statuses[o.status]}</Badge>}>
        <div className="rx-row">
          <button type="button" className="rx-linkbtn" onClick={() => go({ tab: 'communities', id: o.communityId })}>
            r/{o.subreddit}
          </button>
          <RedditLink url={o.threadUrl}>{R.common.openOnReddit}</RedditLink>
        </div>
        <Row label={R.opportunities.fields.intent}>{R.opportunities.intents[o.intent]}</Row>
        <Row label={R.opportunities.fields.angle}>{o.angle ?? R.common.none}</Row>
        <Row label={R.opportunities.keywordIds}>{o.keywordIds.length ? o.keywordIds.map((k) => kwById.get(k) ?? k).join(', ') : R.common.none}</Row>
        <Row label={R.common.updatedAt}>{fmtDateTime(o.updatedAt)}</Row>
        <span className="muted rx-hint">{R.opportunities.fields.excerpt}</span>
        {o.excerpt ? (
          <PlainQuote text={o.excerpt.text} injectionFlag={o.excerpt.injectionFlag} label={R.opportunities.fields.excerpt} />
        ) : (
          <span className="muted">{R.opportunities.excerptNone}</span>
        )}
      </Section>
      <ExcerptEvidence o={o} reload={reload} />
      <Section title={R.opportunities.policy}>
        {actions.stale && <Alert tone="warning">{R.opportunities.staleQualified}</Alert>}
        <GateBlock gate={{ verdict: o.policyNow, reasons: o.policyNowReasons, warnings: [] }} label={R.opportunities.policyNow} />
        <div className="rx-row">
          <span className="muted">{R.opportunities.policyAtScore}:</span>
          <Badge tone={historicVerdictTone(o.policy)}>{R.gate.verdicts[o.policy]}</Badge>
        </div>
        {o.policyReasons.length > 0 && (
          <ul className="rx-list">
            {o.policyReasons.map((x) => (
              <li key={x}>{R.gate.reasons[x] ?? x}</li>
            ))}
          </ul>
        )}
        <Row label={R.opportunities.snapshot}>
          {o.ruleSnapshotVersion !== null ? fmtText(R.rules.version, { n: o.ruleSnapshotVersion }) : R.opportunities.snapshotNone}
        </Row>
      </Section>
      <ScoreSection o={o} />
      {actions.edit &&
        (excerptEditable(o) ? (
          <ExcerptEdit o={o} reload={reload} onSaved={onSaved} />
        ) : o.excerpt?.usage === 'revoked' ? (
          <Alert tone="neutral">{R.opportunities.excerptRevokedNote}</Alert>
        ) : null)}
      {actions.edit && <FactorsEdit o={o} reload={reload} onSaved={onSaved} />}
      {actions.edit && <BasicsEdit o={o} keywords={keywords.data ?? []} reload={reload} onSaved={onSaved} />}
      <Transitions o={o} reload={reload} onSaved={onSaved} />
      {(o.status === 'qualified' || o.status === 'in_brief') && o.policyNow === 'ok' && (
        <Section title={R.briefs.title}>
          <span className="muted rx-hint">{R.briefs.opportunityHint}</span>
          <button type="button" onClick={() => go({ tab: 'briefs', id: '', project: o.projectId, opp: o.id })}>
            {R.briefs.createFromOpportunity}
          </button>
        </Section>
      )}
    </>
  );
}

function ScoreSection({ o }: { o: RedditOpportunityView }) {
  const missing = o.score.missing.map((k: RedditScoreFactor) => R.opportunities.factors[k]);
  return (
    <Section title={R.opportunities.score}>
      <ScoreLine o={o} />
      {missing.length > 0 && <Alert tone="warning">{fmtText(R.opportunities.missing, { list: missing.join(', ') })}</Alert>}
      <span className="muted rx-hint">{R.opportunities.scoreNote}</span>
      <div className="table-scroll">
        <table className="table-narrow">
          <thead>
            <tr>
              <th>
                {R.opportunities.groups.relevance} / {R.opportunities.groups.risk}
              </th>
              <th>{R.opportunities.value}</th>
              <th>{R.opportunities.why}</th>
            </tr>
          </thead>
          <tbody>
            {(Object.keys(o.factors) as RedditScoreFactor[]).map((k) => (
              <tr key={k}>
                <td>{R.opportunities.factors[k]}</td>
                <td>{o.factors[k].value === null ? <span className="rx-warn">{R.opportunities.notRated}</span> : o.factors[k].value}</td>
                <td className="rx-wrap">
                  {k === 'policy_risk'
                    ? [R.opportunities.policyRiskFrom, ...policyRiskText(o.factors[k].reasons, R)].join('; ')
                    : (o.factors[k].why ?? R.common.none)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function FactorsEdit({ o, reload, onSaved }: { o: RedditOpportunityView; reload: () => void; onSaved: (o: RedditOpportunityView) => void }) {
  const { api } = useRx();
  const m = useMutation();
  const ms = useMutation();
  const f = useRebaseForm<FactorForm>(factorForm(o.factors), o.revision);
  const [done, setDone] = useState<string | null>(null);
  // Только факторы, изменённые относительно исходного снимка формы.
  const { body, issues } = factorsBody(f.v, f.base);
  const changed = Object.keys(body).length > 0 && f.conflicts.length === 0;
  return (
    <Section title={R.opportunities.saveFactors}>
      <FactorEditor value={f.v} onChange={f.set} issues={issues} policyRisk={o.factors.policy_risk} />
      <ConflictPanel conflicts={f.conflicts} label={(k) => R.opportunities.factors[k]} resolve={f.resolve} />
      <ErrorAlert error={m.error} onReload={reload} />
      <Notice text={done} />
      <button
        type="button"
        disabled={!changed || issues.length > 0 || m.busy}
        onClick={async () => {
          setDone(null);
          const patch = { expectedRevision: o.revision, factors: body };
          const x = await m.run((k) => api.reddit.patchOpportunity(o.id, k, patch), `factors:${o.id}:${JSON.stringify(patch)}`);
          if (x) {
            setDone(R.common.saved);
            onSaved(x);
          }
        }}
      >
        {R.opportunities.saveFactors}
      </button>
      <span className="muted rx-hint">{R.opportunities.rescoreHint}</span>
      <ErrorAlert error={ms.error} onReload={reload} />
      <button
        type="button"
        disabled={ms.busy}
        onClick={async () => {
          const x = await ms.run((k) => api.reddit.scoreOpportunity(o.id, k, o.revision), `score:${o.id}:${o.revision}`);
          if (x) onSaved(x);
        }}
      >
        {R.opportunities.rescore}
      </button>
    </Section>
  );
}

function ExcerptEvidence({ o, reload }: { o: RedditOpportunityView; reload: () => void }) {
  const { api } = useRx();
  const state = useLoad(() => api.reddit.excerpts(o.id), [api, o.id, o.revision]);
  const after = () => {
    state.reload();
    reload();
  };
  return (
    <Section title={R.opportunities.excerptsTitle}>
      {state.error ? <ErrorAlert error={state.error} onReload={state.reload} /> : null}
      {!state.data ? (
        state.loading ? <Loading /> : null
      ) : state.data.items.length === 0 ? (
        <span className="muted">{R.opportunities.excerptsEmpty}</span>
      ) : (
        <ul className="rx-items" data-reddit-evidence="">
          {[...state.data.items].reverse().map((x) => (
            <li key={x.sourceId} className="rx-item">
              <div className="rx-row">
                <b>{fmtText(R.opportunities.evidenceRevision, { n: x.revision })}</b>
                {x.current && <Badge tone="accent">{R.opportunities.evidenceCurrent}</Badge>}
                <Badge tone={x.usage === 'revoked' ? 'danger' : 'neutral'}>{R.rules.usage[x.usage]}</Badge>
                <span className="muted rx-hint">{fmtDateTime(x.createdAt)}</span>
              </div>
              {x.usage === 'revoked' && (
                <span className="rx-hint">
                  {R.opportunities.evidenceRevokedAt}: {fmtDateTime(x.revokedAt)} · {R.opportunities.evidenceRevokeReason}: {x.revokeReason ?? R.common.none}
                </span>
              )}
              <PlainQuote text={x.fragment} injectionFlag={x.injectionFlag} label={fmtText(R.opportunities.evidenceRevision, { n: x.revision })} />
              {x.usage !== 'revoked' && <RevokeEvidence sourceId={x.sourceId} label={R.common.revokeExcerpt} onDone={after} />}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function ExcerptEdit({ o, reload, onSaved }: { o: RedditOpportunityView; reload: () => void; onSaved: (o: RedditOpportunityView) => void }) {
  const { api } = useRx();
  const m = useMutation();
  const f = useRebaseForm({ excerpt: o.excerpt?.text ?? '' }, o.revision);
  const body = f.conflicts.length ? null : excerptPatchBody(o, f.v.excerpt, f.base.excerpt);
  return (
    <Section title={R.opportunities.editExcerpt}>
      <span className="muted rx-hint">{R.opportunities.excerptHint}</span>
      <Field label={R.opportunities.fields.excerpt}>
        <textarea rows={4} maxLength={2000} value={f.v.excerpt} onChange={(e) => f.set({ excerpt: e.target.value })} />
      </Field>
      <ConflictPanel conflicts={f.conflicts} label={() => R.opportunities.fields.excerpt} resolve={f.resolve} />
      <ErrorAlert error={m.error} onReload={reload} />
      <button
        type="button"
        disabled={!body || m.busy}
        onClick={async () => {
          if (!body) return;
          const x = await m.run((k) => api.reddit.patchOpportunity(o.id, k, body), `excerpt:${o.id}:${JSON.stringify(body)}`);
          if (x) onSaved(x);
        }}
      >
        {body && body.excerpt === null ? R.opportunities.unlinkExcerpt : R.opportunities.saveExcerpt}
      </button>
    </Section>
  );
}

function BasicsEdit({
  o,
  keywords,
  reload,
  onSaved,
}: {
  o: RedditOpportunityView;
  keywords: RedditKeywordView[];
  reload: () => void;
  onSaved: (o: RedditOpportunityView) => void;
}) {
  const { api } = useRx();
  const m = useMutation();
  const f = useRebaseForm<OpportunityEditForm>(opportunityEditForm(o), o.revision);
  const v = f.v;
  const patch = f.conflicts.length ? null : opportunityPatchBody(o, v, f.base);
  const basicsLabel = (k: keyof OpportunityEditForm) => (k === 'keywordIds' ? R.opportunities.fields.keywords : R.opportunities.fields[k]);
  return (
    <Section title={R.opportunities.edit}>
      <Field label={R.opportunities.fields.titleManual}>
        <input value={v.titleManual} maxLength={300} onChange={(e) => f.set({ ...v, titleManual: e.target.value })} />
      </Field>
      <Field label={R.opportunities.fields.intent}>
        <Select value={v.intent} options={REDDIT_INTENTS} labels={R.opportunities.intents} onChange={(x) => x && f.set({ ...v, intent: x })} />
      </Field>
      <Field label={R.opportunities.fields.angle}>
        <textarea rows={2} maxLength={1000} value={v.angle} onChange={(e) => f.set({ ...v, angle: e.target.value })} />
      </Field>
      <KeywordPicker keywords={keywords} value={v.keywordIds} onChange={(x) => f.set({ ...v, keywordIds: x })} />
      <ConflictPanel conflicts={f.conflicts} label={basicsLabel} resolve={f.resolve} />
      <ErrorAlert error={m.error} onReload={reload} />
      <button
        type="button"
        disabled={!patch || m.busy}
        onClick={async () => {
          if (!patch) return;
          const x = await m.run((k) => api.reddit.patchOpportunity(o.id, k, patch), `basics:${o.id}:${JSON.stringify(patch)}`);
          if (x) onSaved(x);
        }}
      >
        {R.common.save}
      </button>
    </Section>
  );
}

function Transitions({ o, reload, onSaved }: { o: RedditOpportunityView; reload: () => void; onSaved: (o: RedditOpportunityView) => void }) {
  const { api } = useRx();
  const m = useMutation();
  const [reason, setReason] = useState('');
  const actions = opportunityActions(o);
  const canTryQualify = ['new', 'blocked', 'recheck_required'].includes(o.status);
  const run = async (to: RedditTransition) => {
    const body = transitionBody(o, reason);
    const x = await m.run((k) => api.reddit.transitionOpportunity(o.id, to, k, body), `${to}:${o.id}:${JSON.stringify(body)}`);
    if (x) {
      setReason('');
      onSaved(x);
    }
  };
  if (!canTryQualify && !actions.skip && !actions.archive) return null;
  return (
    <Section title={R.opportunities.actions}>
      {!actions.qualify && o.status !== 'archived' && <Alert tone="warning">{R.opportunities.qualifyBlocked}</Alert>}
      <Field label={R.common.reason}>
        <textarea rows={2} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <ErrorAlert error={m.error} onReload={reload} statusLabels={R.opportunities.statuses} />
      <div className="rx-row">
        <button type="button" disabled={!canTryQualify || m.busy} onClick={() => void run('qualify')}>
          {R.opportunities.qualify}
        </button>
        {actions.skip && (
          <button type="button" disabled={m.busy} onClick={() => void run('skip')}>
            {R.opportunities.skip}
          </button>
        )}
        {actions.archive && (
          <ConfirmButton danger busy={m.busy} onConfirm={() => void run('archive')}>
            {R.opportunities.archive}
          </ConfirmButton>
        )}
      </div>
    </Section>
  );
}
