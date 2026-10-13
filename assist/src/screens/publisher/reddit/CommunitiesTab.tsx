/**
 * P-R — вкладка «Сообщества»: ввод `r/name` или URL с нормализацией на
 * клиенте (подсказка) и сервере (решает), дубль — ссылкой на запись (409
 * `existingId`); в списке — дата последней проверки правил, `reviewState`
 * и `stale` (§M1.2). Карточка: правка описания/языка/тем, архив и возврат
 * (`PATCH status`, Р-RD-27). «Открыть на Reddit» — обычная ссылка.
 */
import { useState } from 'react';
import { Badge, Button } from '../../../kit/ui';
import { useAsync } from '../../../kit';
import {
  REDDIT_COMMUNITY_STATUSES,
  redditListPath,
  type RedditCommunityView,
} from '../../../lib/publisher/reddit-api';
import {
  communityBody,
  communityForm,
  communityPatchBody,
  normalizeSubreddit,
  snapshotStateTone,
  type CommunityForm,
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
  StatusBadge,
  TextArea,
  TextInput,
} from '../parts';
import { ListRow, PagedFooter } from '../ops/ops-parts';
import { usePaged } from '../ops/ops-hooks';
import type { PublisherSectionProps } from '../registry';
import { useProjectScope, useRebaseForm, useReddit } from './reddit-hooks';
import { ProjectBar } from './ProjectBar';
import {
  ConflictPanel,
  GateReasons,
  ReadOnlyNote,
  RedditErrorAlert,
  RedditLink,
  SearchBox,
  VerdictBadge,
} from './reddit-parts';

export function CommunitiesTab({ id, query }: PublisherSectionProps) {
  if (id) return <CommunityCard id={id} />;
  return <CommunityList query={query} />;
}

/** Сводка правил сообщества: версия, дата проверки, состояние, гейт. */
export function RulesSummaryLine({ c }: { c: RedditCommunityView }) {
  const { r } = useReddit();
  if (!c.rules) {
    return (
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-1">
          <Badge tone="danger">{r.communities.noRules}</Badge>
          <VerdictBadge verdict="block" />
        </div>
        <GateReasons reasons={['rules_missing']} />
      </div>
    );
  }
  const s = c.rules;
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1">
        <Badge>{fmtText(r.rules.version, { n: s.version })}</Badge>
        <Badge tone={snapshotStateTone(s.state, s.gate.reasons)}>
          {r.rules.states[s.state]}
        </Badge>
        {s.selfReview && <Badge tone="warning">{r.rules.selfReview}</Badge>}
        <VerdictBadge verdict={s.gate.verdict} />
      </div>
      <div>
        {r.communities.lastChecked}: <DateText iso={s.checkedAt} />
        {' · '}
        {r.rules.fields.promotionPolicy}: {r.rules.promotion[s.promotionPolicy]}
        {' · '}
        {r.rules.fields.linksPolicy}: {r.rules.links[s.linksPolicy]}
      </div>
      <GateReasons reasons={s.gate.reasons} warnings={s.gate.warnings} />
    </div>
  );
}

function CommunityList({ query }: { query: PublisherSectionProps['query'] }) {
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
    (before) => api.communities({ ...filter, before }),
    [api, filter.status, filter.projectId, applied]
  );
  return (
    <div className="space-y-4">
      <ProjectBar scope={scope} tab="communities" />
      <ListToolbar
        statuses={REDDIT_COMMUNITY_STATUSES}
        status={f.values.status}
        onStatus={(v) => f.set('status', v)}
        statusLabels={r.statuses}
        csvPath={redditListPath(pid, 'communities')}
        csvQuery={filter}
        extra={
          <SearchBox
            value={q}
            onChange={setQ}
            onApply={() => setApplied(q.trim())}
          />
        }
      />
      <Section title={r.communities.title}>
        <ul>
          {page.items.map((c) => (
            <ListRow
              key={c.id}
              title={
                <RecordLink
                  section="reddit"
                  id={c.id}
                  query={{ tab: 'communities' }}
                >
                  r/{c.subreddit}
                </RecordLink>
              }
              badges={
                <StatusBadge
                  status={c.status}
                  labels={r.statuses}
                  tone={c.status === 'active' ? 'neutral' : 'warning'}
                />
              }
            >
              <RulesSummaryLine c={c} />
              <div className="flex flex-wrap gap-x-3">
                <RecordLink section="reddit" id={c.id} query={{ tab: 'rules' }}>
                  {r.communities.openRules}
                </RecordLink>
                <RecordLink
                  section="reddit"
                  query={{
                    tab: 'opportunities',
                    projectId: c.projectId,
                    communityId: c.id,
                  }}
                >
                  {r.communities.openOpportunities}
                </RecordLink>
                <RedditLink url={c.canonicalUrl} />
              </div>
            </ListRow>
          ))}
        </ul>
        <PagedFooter page={page} empty={r.communities.empty} />
      </Section>
      {!canManage ? (
        <ReadOnlyNote />
      ) : scope.projectId && scope.project?.status === 'active' ? (
        <AddCommunity projectId={scope.projectId} onDone={page.reload} />
      ) : null}
    </div>
  );
}

function CommunityFields({
  v,
  set,
  withName,
}: {
  v: CommunityForm;
  set: (v: CommunityForm) => void;
  withName: boolean;
}) {
  const { r } = useReddit();
  const norm = normalizeSubreddit(v.community);
  return (
    <>
      {withName && (
        <Field
          label={r.communities.fields.community}
          hint={
            v.community.trim() === ''
              ? undefined
              : norm
                ? fmtText(r.communities.normalized, { name: norm })
                : r.communities.invalid
          }
        >
          <TextInput
            value={v.community}
            maxLength={300}
            placeholder="r/name"
            onChange={(x) => set({ ...v, community: x })}
          />
        </Field>
      )}
      <Field label={r.communities.fields.descriptionManual}>
        <TextArea
          value={v.descriptionManual}
          rows={2}
          maxLength={2000}
          onChange={(x) => set({ ...v, descriptionManual: x })}
        />
      </Field>
      <Field label={r.communities.fields.language}>
        <TextInput
          value={v.language}
          maxLength={16}
          onChange={(x) => set({ ...v, language: x })}
        />
      </Field>
      <Field label={r.communities.fields.topics}>
        <TextInput
          value={v.topics}
          onChange={(x) => set({ ...v, topics: x })}
        />
      </Field>
    </>
  );
}

function AddCommunity({
  projectId,
  onDone,
}: {
  projectId: string;
  onDone: () => void;
}) {
  const { r, api } = useReddit();
  const m = useMutation();
  const [v, setV] = useState<CommunityForm>(communityForm(null));
  const [done, setDone] = useState<string | null>(null);
  const body = communityBody(projectId, v);
  return (
    <Section title={r.communities.add}>
      <CommunityFields v={v} set={setV} withName />
      <RedditErrorAlert error={m.error} existingTab="communities" />
      <Notice text={done} />
      <Button
        loading={m.busy}
        disabled={!body}
        onClick={async () => {
          if (!body) return;
          setDone(null);
          const x = await m.run(
            (k) => api.createCommunity(k, body),
            JSON.stringify(body)
          );
          if (x) {
            setV(communityForm(null));
            setDone(fmtText(r.communities.normalized, { name: x.subreddit }));
            onDone();
          }
        }}
      >
        {r.communities.add}
      </Button>
    </Section>
  );
}

function CommunityCard({ id }: { id: string }) {
  const { r, api } = useReddit();
  const state = useAsync(() => api.community(id), [api, id]);
  return (
    <div className="space-y-4">
      <RecordLink section="reddit" query={{ tab: 'communities' }}>
        {r.common.back}
      </RecordLink>
      <Loadable state={state}>
        {(c) => (
          <CommunityCardBody
            key={c.id}
            c={c}
            reload={state.reload}
            onSaved={state.setData}
          />
        )}
      </Loadable>
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
  const { r, api, canManage } = useReddit();
  const m = useMutation();
  const ms = useMutation();
  const f = useRebaseForm<CommunityForm>(communityForm(c), c.revision);
  const v = f.v;
  const setV = f.set;
  const [done, setDone] = useState<string | null>(null);
  const patch = f.conflicts.length ? null : communityPatchBody(c, v, f.base);
  const active = c.status === 'active';
  return (
    <>
      <Section
        title={`r/${c.subreddit}`}
        action={
          <StatusBadge
            status={c.status}
            labels={r.statuses}
            tone={active ? 'neutral' : 'warning'}
          />
        }
      >
        <RedditLink url={c.canonicalUrl} />
        <Row label={r.communities.rules}>
          <RulesSummaryLine c={c} />
        </Row>
        <Row label={fmtText(r.communities.staleDays, { n: c.staleDays })}>
          <span className="text-xs">
            {fmtText(r.communities.staleHint, { n: c.staleDays })}
          </span>
        </Row>
        <Row label={r.communities.fields.descriptionManual}>
          <span className="whitespace-pre-wrap">
            {c.descriptionManual ?? r.common.none}
          </span>
        </Row>
        <Row label={r.communities.fields.language}>
          {c.language ?? r.common.none}
        </Row>
        <Row label={r.communities.fields.topics}>
          {c.topics.length ? c.topics.join(', ') : r.common.none}
        </Row>
        <Row label={r.communities.channel}>
          <RecordLink section="calendar">{c.channelId}</RecordLink>
        </Row>
        <Row label={r.common.updatedAt}>
          <DateText iso={c.updatedAt} time />
        </Row>
        <div className="flex flex-wrap gap-x-3 text-sm">
          <RecordLink section="reddit" id={c.id} query={{ tab: 'rules' }}>
            {r.communities.openRules}
          </RecordLink>
          <RecordLink
            section="reddit"
            query={{
              tab: 'opportunities',
              projectId: c.projectId,
              communityId: c.id,
            }}
          >
            {r.communities.openOpportunities}
          </RecordLink>
        </div>
      </Section>
      <Notice text={done} />
      {!canManage ? (
        <ReadOnlyNote />
      ) : (
        <Section title={r.common.edit}>
          {active && (
            <>
              <CommunityFields v={v} set={setV} withName={false} />
              <ConflictPanel
                conflicts={f.conflicts}
                label={(k) => r.communities.fields[k]}
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
                    (k) => api.patchCommunity(c.id, k, patch),
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
            </>
          )}
          <div className="pt-2 space-y-2">
            <div className="text-xs text-silver-500">
              {r.communities.archiveHint}
            </div>
            <RedditErrorAlert error={ms.error} onReload={reload} />
            <ConfirmButton
              loading={ms.busy}
              variant="outline"
              onConfirm={async () => {
                const status = active ? 'archived' : 'active';
                const x = await ms.run(
                  (k) =>
                    api.patchCommunity(c.id, k, {
                      expectedRevision: c.revision,
                      status,
                    }),
                  `status:${c.id}:${c.revision}:${status}`
                );
                if (x) {
                  setDone(r.common.saved);
                  onSaved(x);
                }
              }}
            >
              {active ? r.common.archive : r.common.restore}
            </ConfirmButton>
          </div>
        </Section>
      )}
    </>
  );
}
