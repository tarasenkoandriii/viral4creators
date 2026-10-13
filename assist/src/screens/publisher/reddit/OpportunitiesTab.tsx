/**
 * P-R — вкладка «Возможности» (§M1.4): ввод треда вручную (URL → канон,
 * сообщество в ссылке должно совпасть с выбранным — A15; дубль — 409 со
 * ссылкой на запись — A05), выдержка ТОЛЬКО текстом (A14), факторы 0..100
 * с обоснованием `why` (пусто = «не оценено», не 0; `policy_risk` — из
 * снимка правил, не вводится), score v1 (relevance/risk/priority +
 * `missing`), политика с причинами и переходы qualify/skip/archive по
 * машине сервера (409 `policy_block`/`policy_recheck` — словами). Высокий
 * score блокировку не снимает (A03) — решает сервер.
 */
import { useState } from 'react';
import { Alert, Badge, Button, inputClass } from '../../../kit/ui';
import type * as R from '../../../lib/publisher/reddit-api';
import { useAsync } from '../../../kit';
import {
  REDDIT_INTENTS,
  REDDIT_OPERATOR_FACTORS,
  REDDIT_OPPORTUNITY_STATUSES,
  REDDIT_POLICY_VERDICTS,
  redditListPath,
  type RedditCommunityView,
  type RedditKeywordView,
  type RedditOpportunityView,
  type RedditScoreFactor,
  type RedditTransition,
} from '../../../lib/publisher/reddit-api';
import {
  emptyOpportunityForm,
  excerptEditable,
  historicVerdictTone,
  excerptPatchBody,
  NEED_RESCORE,
  policyRiskText,
  factorForm,
  factorsBody,
  normalizeThreadUrl,
  opportunityActions,
  opportunityBody,
  opportunityEditForm,
  opportunityPatchBody,
  opportunityTone,
  threadMismatch,
  transitionBody,
  TRANSITIONS,
  type FactorForm,
  type FactorIssue,
  type OpportunityEditForm,
  type OpportunityForm,
} from '../../../lib/publisher/reddit-view';
import { fmtText } from '../../../lib/publisher/view';
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
  Select,
  StatusBadge,
  TextArea,
  TextInput,
} from '../parts';
import { ActionBlock, ListRow, PagedFooter } from '../ops/ops-parts';
import { usePaged } from '../ops/ops-hooks';
import type { PublisherSectionProps } from '../registry';
import {
  useProjectScope,
  useRebaseForm,
  useReddit,
  useRedditCommunities,
} from './reddit-hooks';
import { ProjectBar } from './ProjectBar';
import {
  CommunitySelect,
  ConflictPanel,
  GateReasons,
  PlainQuote,
  ReadOnlyNote,
  RedditErrorAlert,
  RedditLink,
  SearchBox,
  RevokeEvidence,
  VerdictBadge,
  Wrap,
} from './reddit-parts';

/** «Отобрана», но гейт сейчас не ok — не зелёный, а предупреждение. */
function statusToneOf(o: RedditOpportunityView) {
  return opportunityActions(o).stale ? 'warning' : opportunityTone(o.status);
}

export function OpportunitiesTab({ id, query }: PublisherSectionProps) {
  if (id) return <OpportunityCard id={id} />;
  return <OpportunityList query={query} />;
}

/** Активные запросы проекта (до 100) — для выбора и подписи id. */
function useProjectKeywords(projectId: string) {
  const { api } = useReddit();
  return useAsync(
    async (): Promise<RedditKeywordView[]> =>
      projectId ? (await api.keywords({ projectId, limit: 100 })).items : [],
    [api, projectId]
  );
}

function ScoreLine({ o }: { o: RedditOpportunityView }) {
  const { r } = useReddit();
  const n = (v: number | null) =>
    v === null ? (
      <span className="text-amber-700 dark:text-amber-400">
        {r.opportunities.notComputed}
      </span>
    ) : (
      <span>{v}</span>
    );
  return (
    <span>
      {r.opportunities.relevance} {n(o.score.relevance)} ·{' '}
      {r.opportunities.risk} {n(o.score.risk)} · {r.opportunities.priority}{' '}
      {n(o.score.priority)}
    </span>
  );
}

function OpportunityList({ query }: { query: PublisherSectionProps['query'] }) {
  const { r, t, api, pid, canManage } = useReddit();
  const scope = useProjectScope(query);
  const communities = useRedditCommunities(scope.projectId);
  const f = useListFilters('reddit', query, [
    'tab',
    'projectId',
    'communityId',
    'status',
    'policyNow',
  ]);
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  const filter = {
    status: f.values.status || undefined,
    projectId: scope.projectId || undefined,
    communityId: f.values.communityId || undefined,
    q: applied || undefined,
    policyNow: (REDDIT_POLICY_VERDICTS as readonly string[]).includes(
      f.values.policyNow
    )
      ? (f.values.policyNow as R.RedditPolicyVerdict)
      : undefined,
  };
  const page = usePaged(
    (before) => api.opportunities({ ...filter, before }),
    [
      api,
      filter.status,
      filter.projectId,
      filter.communityId,
      filter.policyNow,
      applied,
    ]
  );
  return (
    <div className="space-y-4">
      <ProjectBar scope={scope} tab="opportunities" />
      <ListToolbar
        statuses={REDDIT_OPPORTUNITY_STATUSES}
        status={f.values.status}
        onStatus={(v) => f.set('status', v)}
        statusLabels={r.opportunities.statuses}
        csvPath={redditListPath(pid, 'opportunities')}
        csvQuery={filter}
        extra={
          <>
            {scope.projectId && (
              <CommunitySelect
                communities={communities.data ?? []}
                value={f.values.communityId}
                label={r.common.community}
                empty={r.common.allCommunities}
                onChange={(v) => f.set('communityId', v)}
              />
            )}
            <label className="text-xs text-silver-500 flex flex-col gap-1 min-w-0">
              {r.opportunities.policyFilter}
              <select
                className={`${inputClass} w-auto max-w-full`}
                value={filter.policyNow ?? ''}
                onChange={(e) => f.set('policyNow', e.target.value)}
              >
                <option value="">{t.common.all}</option>
                {REDDIT_POLICY_VERDICTS.map((v) => (
                  <option key={v} value={v}>
                    {r.gate.verdicts[v]}
                  </option>
                ))}
              </select>
            </label>
            <SearchBox
              value={q}
              onChange={setQ}
              onApply={() => setApplied(q.trim())}
            />
          </>
        }
      />
      <div className="flex flex-wrap gap-x-3 text-sm">
        {NEED_RESCORE.map((x) => (
          <RecordLink
            key={x.policyNow}
            section="reddit"
            query={{
              tab: 'opportunities',
              ...(scope.projectId ? { projectId: scope.projectId } : {}),
              status: x.status,
              policyNow: x.policyNow,
            }}
          >
            {r.opportunities.needRescore}: {r.gate.verdicts[x.policyNow]}
          </RecordLink>
        ))}
      </div>
      <Section title={r.opportunities.title}>
        <ul>
          {page.items.map((o) => (
            <ListRow
              key={o.id}
              title={
                <RecordLink
                  section="reddit"
                  id={o.id}
                  query={{ tab: 'opportunities' }}
                >
                  {o.titleManual}
                </RecordLink>
              }
              badges={
                <>
                  <StatusBadge
                    status={o.status}
                    labels={r.opportunities.statuses}
                    tone={statusToneOf(o)}
                  />
                  <VerdictBadge
                    verdict={o.policyNow}
                    label={r.opportunities.policyNow}
                  />
                  {opportunityActions(o).stale && (
                    <Badge tone="warning">{r.opportunities.staleBadge}</Badge>
                  )}
                </>
              }
            >
              <div>
                r/{o.subreddit} · {r.opportunities.intents[o.intent]}
              </div>
              <ScoreLine o={o} />
              <GateReasons reasons={o.policyNowReasons} />
              <RedditLink url={o.threadUrl} />
            </ListRow>
          ))}
        </ul>
        <PagedFooter page={page} empty={r.opportunities.empty} />
      </Section>
      {!canManage ? (
        <ReadOnlyNote />
      ) : scope.projectId && scope.project?.status === 'active' ? (
        <AddOpportunity
          projectId={scope.projectId}
          communities={(communities.data ?? []).filter(
            (c) => c.status === 'active'
          )}
          initialCommunity={f.values.communityId}
          onDone={page.reload}
        />
      ) : null}
    </div>
  );
}

/** Факторы оператора: значение 0..100 (пусто — «не оценено») + `why`. */
function FactorEditor({
  value,
  onChange,
  issues,
  policyRisk,
}: {
  value: FactorForm;
  onChange: (v: FactorForm) => void;
  issues: FactorIssue[];
  policyRisk?: R.RedditFactorValue | null;
}) {
  const { r } = useReddit();
  const issueOf = (k: string) => issues.find((x) => x.factor === k)?.code;
  return (
    <div className="space-y-3">
      <div className="text-sm font-medium">{r.opportunities.factorsTitle}</div>
      {(['relevance', 'risk'] as const).map((g) => (
        <fieldset key={g} className="space-y-2">
          <legend className="text-xs text-silver-500">
            {r.opportunities.groups[g]}
          </legend>
          {g === 'risk' && (
            <div className="rounded-lg border border-dashed border-silver-300 dark:border-silver-700 px-3 py-2 text-sm space-y-0.5">
              <div className="font-medium">
                {r.opportunities.factors.policy_risk}:{' '}
                {policyRisk?.value ?? r.opportunities.notRated}
              </div>
              {policyRiskText(policyRisk?.reasons, r).map((x) => (
                <div key={x} className="text-xs">
                  {x}
                </div>
              ))}
              <div className="text-xs text-silver-500">
                {r.opportunities.policyRiskDerived}
              </div>
            </div>
          )}
          {REDDIT_OPERATOR_FACTORS.filter((k) =>
            g === 'relevance'
              ? [
                  'topic_fit',
                  'intent_fit',
                  'audience_fit',
                  'answerability',
                ].includes(k)
              : ![
                  'topic_fit',
                  'intent_fit',
                  'audience_fit',
                  'answerability',
                ].includes(k)
          ).map((k) => {
            const code = issueOf(k);
            return (
              <div
                key={k}
                className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_6rem_minmax(0,2fr)] gap-2 items-start"
              >
                <div className="text-sm pt-2">{r.opportunities.factors[k]}</div>
                <Field
                  label={
                    <>
                      <span className="sr-only">
                        {r.opportunities.factors[k]}:{' '}
                      </span>
                      {r.opportunities.value}
                    </>
                  }
                >
                  <TextInput
                    value={value[k].value}
                    maxLength={3}
                    placeholder="0–100"
                    onChange={(x) =>
                      onChange({ ...value, [k]: { ...value[k], value: x } })
                    }
                  />
                </Field>
                <Field
                  label={
                    <>
                      <span className="sr-only">
                        {r.opportunities.factors[k]}:{' '}
                      </span>
                      {r.opportunities.why}
                    </>
                  }
                  hint={
                    code === 'value'
                      ? r.opportunities.valueInvalid
                      : code === 'why'
                        ? r.opportunities.whyRequired
                        : code === 'whyLength'
                          ? r.opportunities.whyTooLong
                          : undefined
                  }
                >
                  <TextInput
                    value={value[k].why}
                    maxLength={300}
                    onChange={(x) =>
                      onChange({ ...value, [k]: { ...value[k], why: x } })
                    }
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

function KeywordPicker({
  keywords,
  value,
  onChange,
}: {
  keywords: RedditKeywordView[];
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const { r } = useReddit();
  const list = keywords.filter(
    (k) => k.status === 'active' || value.includes(k.id)
  );
  if (!list.length) return null;
  return (
    <fieldset className="space-y-1">
      <legend className="text-xs text-silver-500">
        {r.opportunities.fields.keywords}
      </legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {list.map((k) => {
          const on = value.includes(k.id);
          return (
            <label
              key={k.id}
              className="inline-flex items-center gap-2 text-sm"
            >
              <input
                type="checkbox"
                checked={on}
                disabled={!on && value.length >= 10}
                onChange={() =>
                  onChange(
                    on ? value.filter((x) => x !== k.id) : [...value, k.id]
                  )
                }
              />
              {k.phrase}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

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
  const { r, api, go } = useReddit();
  const keywords = useProjectKeywords(projectId);
  const m = useMutation();
  const [v, setV] = useState<OpportunityForm>(
    emptyOpportunityForm(
      communities.some((c) => c.id === initialCommunity) ? initialCommunity : ''
    )
  );
  const community = communities.find((c) => c.id === v.communityId) ?? null;
  const res = opportunityBody(projectId, v, community);
  const thread = normalizeThreadUrl(v.threadUrl);
  const mismatch = threadMismatch(v.threadUrl, community);
  if (communities.length === 0) {
    return <Alert tone="neutral">{r.common.noCommunity}</Alert>;
  }
  return (
    <Section title={r.opportunities.add}>
      <div className="text-xs text-silver-500">{r.opportunities.addHint}</div>
      <CommunitySelect
        communities={communities}
        value={v.communityId}
        label={r.opportunities.newCommunity}
        empty={r.common.choose}
        activeOnly
        onChange={(x) => setV({ ...v, communityId: x })}
      />
      <Field
        label={r.opportunities.fields.threadUrl}
        hint={
          v.threadUrl.trim() === ''
            ? undefined
            : !thread
              ? r.opportunities.threadInvalid
              : mismatch
                ? fmtText(r.opportunities.threadMismatch, mismatch)
                : fmtText(r.opportunities.threadNormalized, { url: thread.url })
        }
      >
        <TextInput
          type="url"
          value={v.threadUrl}
          maxLength={2048}
          placeholder="https://www.reddit.com/r/…/comments/…"
          onChange={(x) => setV({ ...v, threadUrl: x })}
        />
      </Field>
      <Field label={r.opportunities.fields.titleManual}>
        <TextInput
          value={v.titleManual}
          maxLength={300}
          onChange={(x) => setV({ ...v, titleManual: x })}
        />
      </Field>
      <Field label={r.opportunities.fields.excerpt}>
        <TextArea
          value={v.excerpt}
          rows={4}
          maxLength={2000}
          onChange={(x) => setV({ ...v, excerpt: x })}
        />
      </Field>
      <Field label={r.opportunities.fields.intent}>
        <Select
          value={v.intent}
          options={REDDIT_INTENTS}
          labels={r.opportunities.intents}
          empty={r.common.choose}
          onChange={(x) => setV({ ...v, intent: x })}
        />
      </Field>
      <Field label={r.opportunities.fields.angle}>
        <TextArea
          value={v.angle}
          rows={2}
          maxLength={1000}
          onChange={(x) => setV({ ...v, angle: x })}
        />
      </Field>
      <KeywordPicker
        keywords={keywords.data ?? []}
        value={v.keywordIds}
        onChange={(x) => setV({ ...v, keywordIds: x })}
      />
      <ActionBlock title={r.opportunities.factorsTitle}>
        <FactorEditor
          value={v.factors}
          onChange={(x) => setV({ ...v, factors: x })}
          issues={res.factorIssues}
        />
      </ActionBlock>
      <RedditErrorAlert error={m.error} existingTab="opportunities" />
      <Button
        loading={m.busy}
        disabled={!res.body}
        onClick={async () => {
          const body = res.body;
          if (!body) return;
          const x = await m.run(
            (k) => api.createOpportunity(k, body),
            JSON.stringify(body)
          );
          if (x) {
            onDone();
            go('reddit', x.id, { tab: 'opportunities' });
          }
        }}
      >
        {r.opportunities.add}
      </Button>
    </Section>
  );
}

function OpportunityCard({ id }: { id: string }) {
  const { r, api } = useReddit();
  const state = useAsync(() => api.opportunity(id), [api, id]);
  return (
    <div className="space-y-4">
      <RecordLink section="reddit" query={{ tab: 'opportunities' }}>
        {r.common.back}
      </RecordLink>
      <Loadable state={state}>
        {(o) => (
          <OpportunityCardBody
            key={o.id}
            o={o}
            reload={state.reload}
            onSaved={state.setData}
          />
        )}
      </Loadable>
    </div>
  );
}

function OpportunityCardBody({
  o,
  reload,
  onSaved,
}: {
  o: RedditOpportunityView;
  reload: () => void;
  onSaved: (o: RedditOpportunityView) => void;
}) {
  const { r, canManage } = useReddit();
  const keywords = useProjectKeywords(o.projectId);
  const kwById = new Map((keywords.data ?? []).map((k) => [k.id, k.phrase]));
  const actions = opportunityActions(o);
  return (
    <>
      <Section
        title={<Wrap>{o.titleManual}</Wrap>}
        action={
          <StatusBadge
            status={o.status}
            labels={r.opportunities.statuses}
            tone={statusToneOf(o)}
          />
        }
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <RecordLink
            section="reddit"
            id={o.communityId}
            query={{ tab: 'communities' }}
          >
            r/{o.subreddit}
          </RecordLink>
          <RedditLink url={o.threadUrl} />
        </div>
        <Row label={r.opportunities.fields.intent}>
          {r.opportunities.intents[o.intent]}
        </Row>
        <Row label={r.opportunities.fields.angle}>
          <span className="whitespace-pre-wrap">
            {o.angle ?? r.common.none}
          </span>
        </Row>
        <Row label={r.opportunities.keywordIds}>
          {o.keywordIds.length
            ? o.keywordIds.map((k) => kwById.get(k) ?? k).join(', ')
            : r.common.none}
        </Row>
        <Row label={r.common.updatedAt}>
          <DateText iso={o.updatedAt} time />
        </Row>
        <div className="text-xs text-silver-500">
          {r.opportunities.fields.excerpt}
        </div>
        {o.excerpt ? (
          <PlainQuote
            text={o.excerpt.text}
            injectionFlag={o.excerpt.injectionFlag}
          />
        ) : (
          <div className="text-sm text-silver-500">
            {r.opportunities.excerptNone}
          </div>
        )}
      </Section>
      <ExcerptEvidence o={o} reload={reload} />
      <Section
        title={r.opportunities.policy}
        action={
          <VerdictBadge
            verdict={o.policyNow}
            label={r.opportunities.policyNow}
          />
        }
      >
        {actions.stale && (
          <Alert tone="warning">{r.opportunities.staleQualified}</Alert>
        )}
        <GateReasons reasons={o.policyNowReasons} />
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-silver-500">
            {r.opportunities.policyAtScore}:
          </span>
          <VerdictBadge
            verdict={o.policy}
            label={r.opportunities.policy}
            tone={historicVerdictTone(o.policy)}
          />
        </div>
        <GateReasons reasons={o.policyReasons} />
        <Row label={r.opportunities.snapshot}>
          {o.ruleSnapshotVersion !== null ? (
            <RecordLink
              section="reddit"
              id={o.communityId}
              query={{ tab: 'rules' }}
            >
              {fmtText(r.rules.version, { n: o.ruleSnapshotVersion })}
            </RecordLink>
          ) : (
            r.opportunities.snapshotNone
          )}
        </Row>
      </Section>
      <ScoreSection o={o} />
      {!canManage ? (
        <ReadOnlyNote />
      ) : (
        <>
          {actions.edit &&
            (excerptEditable(o) ? (
              <ExcerptEdit o={o} reload={reload} onSaved={onSaved} />
            ) : o.excerpt?.usage === 'revoked' ? (
              <Alert tone="neutral">{r.opportunities.excerptRevokedNote}</Alert>
            ) : null)}
          {actions.edit && (
            <FactorsEdit o={o} reload={reload} onSaved={onSaved} />
          )}
          {actions.edit && (
            <BasicsEdit
              o={o}
              keywords={keywords.data ?? []}
              reload={reload}
              onSaved={onSaved}
            />
          )}
          <Transitions o={o} reload={reload} onSaved={onSaved} />
        </>
      )}
    </>
  );
}

function ScoreSection({ o }: { o: RedditOpportunityView }) {
  const { r } = useReddit();
  const missing = o.score.missing.map(
    (k: RedditScoreFactor) => r.opportunities.factors[k]
  );
  return (
    <Section title={r.opportunities.score}>
      <ScoreLine o={o} />
      {missing.length > 0 && (
        <Alert tone="warning">
          {fmtText(r.opportunities.missing, { list: missing.join(', ') })}
        </Alert>
      )}
      <div className="text-xs text-silver-500">{r.opportunities.scoreNote}</div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm table-fixed">
          <colgroup>
            <col className="w-[40%]" />
            <col className="w-[18%]" />
            <col />
          </colgroup>
          <thead>
            <tr className="text-left text-xs text-silver-500">
              <th className="font-normal py-1 pr-2">
                {r.opportunities.groups.relevance} /{' '}
                {r.opportunities.groups.risk}
              </th>
              <th className="font-normal py-1 pr-2">{r.opportunities.value}</th>
              <th className="font-normal py-1">{r.opportunities.why}</th>
            </tr>
          </thead>
          <tbody>
            {(Object.keys(o.factors) as RedditScoreFactor[]).map((k) => (
              <tr
                key={k}
                className="align-top border-t border-silver-200/60 dark:border-silver-800"
              >
                <td className="py-1 pr-2 break-words">
                  {r.opportunities.factors[k]}
                </td>
                <td className="py-1 pr-2">
                  {o.factors[k].value === null ? (
                    <span className="text-amber-700 dark:text-amber-400">
                      {r.opportunities.notRated}
                    </span>
                  ) : (
                    o.factors[k].value
                  )}
                </td>
                <td className="py-1 whitespace-pre-wrap break-words">
                  {k === 'policy_risk'
                    ? [
                        r.opportunities.policyRiskFrom,
                        ...policyRiskText(o.factors[k].reasons, r),
                      ].join('; ')
                    : (o.factors[k].why ?? r.common.none)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function FactorsEdit({
  o,
  reload,
  onSaved,
}: {
  o: RedditOpportunityView;
  reload: () => void;
  onSaved: (o: RedditOpportunityView) => void;
}) {
  const { r, api } = useReddit();
  const m = useMutation();
  const ms = useMutation();
  const f = useRebaseForm<FactorForm>(factorForm(o.factors), o.revision);
  const v = f.v;
  const setV = f.set;
  const [done, setDone] = useState<string | null>(null);
  // Только факторы, изменённые относительно исходного снимка формы (S2-1).
  const { body, issues } = factorsBody(v, f.base);
  const changed = Object.keys(body).length > 0 && f.conflicts.length === 0;
  return (
    <Section title={r.opportunities.saveFactors}>
      <FactorEditor
        value={v}
        onChange={setV}
        issues={issues}
        policyRisk={o.factors.policy_risk}
      />
      <ConflictPanel
        conflicts={f.conflicts}
        label={(k) => r.opportunities.factors[k]}
        show={(_k, x) =>
          `${x.value.trim() || r.opportunities.notRated} · ${x.why.trim() || r.common.none}`
        }
        resolve={f.resolve}
      />
      <RedditErrorAlert error={m.error} onReload={reload} />
      <Notice text={done} />
      <Button
        loading={m.busy}
        disabled={!changed || issues.length > 0}
        onClick={async () => {
          setDone(null);
          const patch = { expectedRevision: o.revision, factors: body };
          const x = await m.run(
            (k) => api.patchOpportunity(o.id, k, patch),
            JSON.stringify(patch)
          );
          if (x) onSaved(x);
        }}
      >
        {r.opportunities.saveFactors}
      </Button>
      <div className="pt-2 space-y-2">
        <div className="text-xs text-silver-500">
          {r.opportunities.rescoreHint}
        </div>
        <RedditErrorAlert error={ms.error} onReload={reload} />
        <Button
          variant="outline"
          loading={ms.busy}
          onClick={async () => {
            const x = await ms.run(
              (k) => api.scoreOpportunity(o.id, k, o.revision),
              `score:${o.id}:${o.revision}`
            );
            if (x) onSaved(x);
          }}
        >
          {r.opportunities.rescore}
        </Button>
      </div>
    </Section>
  );
}

/**
 * Редакции выдержки треда для отзыва (UI-аудит S2-2): при ЛЮБОМ статусе
 * возможности, включая архив и прежние редакции; отозванные — с пометкой и
 * причиной, без повторного отзыва. Текст — только текстом.
 */
function ExcerptEvidence({
  o,
  reload,
}: {
  o: RedditOpportunityView;
  reload: () => void;
}) {
  const { r, api } = useReddit();
  const state = useAsync(() => api.excerpts(o.id), [api, o.id, o.revision]);
  const after = () => {
    state.reload();
    reload();
  };
  return (
    <Section title={r.opportunities.excerptsTitle}>
      <Loadable state={state}>
        {(ev) =>
          ev.items.length === 0 ? (
            <div className="text-sm text-silver-500">
              {r.opportunities.excerptsEmpty}
            </div>
          ) : (
            <ul className="space-y-3" data-reddit-evidence="">
              {[...ev.items].reverse().map((x) => (
                <li
                  key={x.sourceId}
                  className="rounded-xl border border-silver-200/70 dark:border-silver-800 p-3 space-y-2"
                >
                  <div className="flex flex-wrap items-center gap-1 text-sm">
                    <span className="font-medium mr-1">
                      {fmtText(r.opportunities.evidenceRevision, {
                        n: x.revision,
                      })}
                    </span>
                    {x.current && (
                      <Badge tone="accent">
                        {r.opportunities.evidenceCurrent}
                      </Badge>
                    )}
                    <Badge tone={x.usage === 'revoked' ? 'danger' : 'neutral'}>
                      {r.rules.usage[x.usage]}
                    </Badge>
                    <span className="text-xs text-silver-500">
                      <DateText iso={x.createdAt} time />
                    </span>
                  </div>
                  {x.usage === 'revoked' && (
                    <div className="text-xs">
                      {r.opportunities.evidenceRevokedAt}:{' '}
                      <DateText iso={x.revokedAt} time />
                      {' · '}
                      {r.opportunities.evidenceRevokeReason}:{' '}
                      {x.revokeReason ?? r.common.none}
                    </div>
                  )}
                  <PlainQuote
                    text={x.fragment}
                    injectionFlag={x.injectionFlag}
                  />
                  {x.usage !== 'revoked' && (
                    <RevokeEvidence
                      sourceId={x.sourceId}
                      label={r.common.revokeExcerpt}
                      onDone={after}
                      context={fmtText(r.opportunities.evidenceRevision, {
                        n: x.revision,
                      })}
                    />
                  )}
                </li>
              ))}
            </ul>
          )
        }
      </Loadable>
    </Section>
  );
}

function ExcerptEdit({
  o,
  reload,
  onSaved,
}: {
  o: RedditOpportunityView;
  reload: () => void;
  onSaved: (o: RedditOpportunityView) => void;
}) {
  const { r, api } = useReddit();
  const m = useMutation();
  const f = useRebaseForm({ excerpt: o.excerpt?.text ?? '' }, o.revision);
  const text = f.v.excerpt;
  const setText = (x: string) => f.set({ excerpt: x });
  const body = f.conflicts.length
    ? null
    : excerptPatchBody(o, text, f.base.excerpt);
  return (
    <ActionBlock title={r.opportunities.editExcerpt}>
      <div className="text-xs text-silver-500">
        {r.opportunities.excerptHint}
      </div>
      <Field label={r.opportunities.fields.excerpt}>
        <TextArea value={text} rows={4} maxLength={2000} onChange={setText} />
      </Field>
      <ConflictPanel
        conflicts={f.conflicts}
        label={() => r.opportunities.fields.excerpt}
        resolve={f.resolve}
      />
      <RedditErrorAlert error={m.error} onReload={reload} />
      <Button
        loading={m.busy}
        disabled={!body}
        onClick={async () => {
          if (!body) return;
          const x = await m.run(
            (k) => api.patchOpportunity(o.id, k, body),
            JSON.stringify(body)
          );
          if (x) onSaved(x);
        }}
      >
        {body && body.excerpt === null
          ? r.opportunities.unlinkExcerpt
          : r.opportunities.saveExcerpt}
      </Button>
    </ActionBlock>
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
  const { r, api } = useReddit();
  const m = useMutation();
  const f = useRebaseForm<OpportunityEditForm>(
    opportunityEditForm(o),
    o.revision
  );
  const v = f.v;
  const setV = f.set;
  const patch = f.conflicts.length ? null : opportunityPatchBody(o, v, f.base);
  const kwName = new Map(keywords.map((k) => [k.id, k.phrase]));
  const basicsLabel = (k: keyof OpportunityEditForm) =>
    k === 'keywordIds'
      ? r.opportunities.fields.keywords
      : r.opportunities.fields[k];
  return (
    <ActionBlock title={r.opportunities.edit}>
      <Field label={r.opportunities.fields.titleManual}>
        <TextInput
          value={v.titleManual}
          maxLength={300}
          onChange={(x) => setV({ ...v, titleManual: x })}
        />
      </Field>
      <Field label={r.opportunities.fields.intent}>
        <Select
          value={v.intent}
          options={REDDIT_INTENTS}
          labels={r.opportunities.intents}
          onChange={(x) => x && setV({ ...v, intent: x })}
        />
      </Field>
      <Field label={r.opportunities.fields.angle}>
        <TextArea
          value={v.angle}
          rows={2}
          maxLength={1000}
          onChange={(x) => setV({ ...v, angle: x })}
        />
      </Field>
      <KeywordPicker
        keywords={keywords}
        value={v.keywordIds}
        onChange={(x) => setV({ ...v, keywordIds: x })}
      />
      <ConflictPanel
        conflicts={f.conflicts}
        label={basicsLabel}
        show={(k, x) =>
          k === 'keywordIds'
            ? (x as string[]).map((id) => kwName.get(id) ?? id).join(', ')
            : k === 'intent'
              ? r.opportunities.intents[x as R.RedditIntent]
              : String(x)
        }
        resolve={f.resolve}
      />
      <RedditErrorAlert error={m.error} onReload={reload} />
      <Button
        loading={m.busy}
        disabled={!patch}
        onClick={async () => {
          if (!patch) return;
          const x = await m.run(
            (k) => api.patchOpportunity(o.id, k, patch),
            JSON.stringify(patch)
          );
          if (x) onSaved(x);
        }}
      >
        {r.common.save}
      </Button>
    </ActionBlock>
  );
}

function Transitions({
  o,
  reload,
  onSaved,
}: {
  o: RedditOpportunityView;
  reload: () => void;
  onSaved: (o: RedditOpportunityView) => void;
}) {
  const { r, api } = useReddit();
  const m = useMutation();
  const [reason, setReason] = useState('');
  const actions = opportunityActions(o);
  const canTryQualify = ['new', 'blocked', 'recheck_required'].includes(
    o.status
  );
  const label: Record<RedditTransition, string> = {
    qualify: r.opportunities.qualify,
    skip: r.opportunities.skip,
    archive: r.opportunities.archive,
  };
  const run = async (to: RedditTransition) => {
    const body = transitionBody(o, reason);
    const x = await m.run(
      (k) => api.transitionOpportunity(o.id, to, k, body),
      `${to}:${o.id}:${JSON.stringify(body)}`
    );
    if (x) {
      setReason('');
      onSaved(x);
    }
  };
  // Отобранная, но гейт сейчас не ok: переходы скрыты до пересчёта.
  if (!TRANSITIONS.some((x) => actions[x])) return null;
  return (
    <Section title={r.opportunities.actions}>
      {!actions.qualify && o.status !== 'archived' && (
        <Badge tone="warning">{r.opportunities.qualifyBlocked}</Badge>
      )}
      <Field label={r.common.reason}>
        <TextArea
          value={reason}
          rows={2}
          maxLength={2000}
          onChange={setReason}
        />
      </Field>
      <RedditErrorAlert
        error={m.error}
        onReload={reload}
        statusLabels={r.opportunities.statuses}
      />
      <div className="flex flex-wrap gap-2">
        {/* «Подходит» видна и при BLOCK (сервер ответит 409 policy_block),
            но доступна только из `new` с гейтом ok — подсказка выше. */}
        <Button
          loading={m.busy}
          disabled={!canTryQualify}
          onClick={() => void run('qualify')}
        >
          {label.qualify}
        </Button>
        {actions.skip && (
          <Button
            variant="outline"
            loading={m.busy}
            onClick={() => void run('skip')}
          >
            {label.skip}
          </Button>
        )}
        {actions.archive && (
          <ConfirmButton
            variant="outline"
            loading={m.busy}
            onConfirm={() => void run('archive')}
          >
            {label.archive}
          </ConfirmButton>
        )}
      </div>
    </Section>
  );
}
