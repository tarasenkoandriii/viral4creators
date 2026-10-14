/**
 * P-R M2 — вкладка «Брифы» (Brief Builder, §M2.2): список с фильтрами и
 * CSV; создание поста или комментария (comment — только к треду
 * возможности и с контекстом уже при создании, A13; из карточки возможности
 * — `?opportunityId=`, контекст по умолчанию — её выдержка); тезисы с
 * источниками продукта или «нужна проверка»; связь автора обязательна для
 * готовности; «чего не хватает» словами; ready/архив; материал брифа —
 * переход в студию. Правка — только изменённое (`useRebaseForm`).
 */
import { useState } from 'react';
import { Alert, Badge, Button } from '../../../kit/ui';
import { useAsync } from '../../../kit';
import {
  REDDIT_AFFILIATIONS,
  REDDIT_BRIEF_STATUSES,
  REDDIT_CONTENT_TYPES,
  redditStudioListPath,
  type RedditBriefView,
  type RedditContentType,
} from '../../../lib/publisher/reddit-studio-api';
import {
  briefCreateBody,
  briefForm,
  briefFormFromOpportunity,
  briefIssues,
  briefPatchBody,
  keyPointForm,
  missingText,
  type BriefForm,
} from '../../../lib/publisher/reddit-studio-view';
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
import { ListRow, PagedFooter } from '../ops/ops-parts';
import { usePaged } from '../ops/ops-hooks';
import type { PublisherSectionProps } from '../registry';
import {
  useProjectScope,
  useRebaseForm,
  useProductSources,
  useRedditCommunities,
  useRedditStudio,
} from './reddit-hooks';
import { ProjectBar } from './ProjectBar';
import {
  CommunitySelect,
  ConflictPanel,
  GateBlock,
  PlainQuote,
  ReadOnlyNote,
  RedditLink,
  SearchBox,
  Wrap,
} from './reddit-parts';
import { StudioErrorAlert } from './studio-parts';

const briefTone = (s: RedditBriefView['status']) =>
  s === 'ready' ? 'success' : s === 'archived' ? 'warning' : 'neutral';

export function BriefsTab({ id, query }: PublisherSectionProps) {
  return id ? <BriefCard id={id} /> : <BriefList query={query} />;
}

function BriefList({ query }: { query: PublisherSectionProps['query'] }) {
  const { r, studio, pid, canManage } = useRedditStudio();
  const scope = useProjectScope(query);
  const f = useListFilters('reddit', query, [
    'tab',
    'projectId',
    'status',
    'contentType',
    'opportunityId',
  ]);
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  const filter = {
    status: f.values.status || undefined,
    contentType: f.values.contentType || undefined,
    projectId: scope.projectId || undefined,
    q: applied || undefined,
  };
  const page = usePaged(
    (before) => studio.briefs({ ...filter, before }),
    [studio, filter.status, filter.contentType, filter.projectId, applied]
  );
  return (
    <div className="space-y-4">
      <ProjectBar scope={scope} tab="briefs" />
      <ListToolbar
        statuses={REDDIT_BRIEF_STATUSES}
        status={f.values.status}
        onStatus={(v) => f.set('status', v)}
        statusLabels={r.briefs.statuses}
        csvPath={redditStudioListPath(pid, 'briefs')}
        csvQuery={filter}
        extra={
          <>
            <label className="text-xs text-silver-500 flex flex-col gap-1">
              {r.briefs.filterType}
              <Select
                value={(f.values.contentType ?? '') as RedditContentType | ''}
                options={REDDIT_CONTENT_TYPES}
                labels={r.briefs.contentTypes}
                empty={r.common.none}
                onChange={(v) => f.set('contentType', v)}
              />
            </label>
            <SearchBox
              value={q}
              onChange={setQ}
              onApply={() => setApplied(q.trim())}
            />
          </>
        }
      />
      <Section title={r.briefs.title}>
        <ul>
          {page.items.map((b) => (
            <ListRow
              key={b.id}
              title={
                <RecordLink
                  section="reddit"
                  id={b.id}
                  query={{ tab: 'briefs' }}
                >
                  <Wrap>{b.objective}</Wrap>
                </RecordLink>
              }
              badges={
                <>
                  <StatusBadge
                    status={b.status}
                    labels={r.briefs.statuses}
                    tone={briefTone(b.status)}
                  />
                  <Badge tone="neutral">
                    {r.briefs.contentTypes[b.contentType]}
                  </Badge>
                </>
              }
            >
              <div>
                r/{b.subreddit}
                {b.missing.length > 0 &&
                  ` · ${r.briefs.missingTitle}: ${b.missing
                    .map((x) => missingText(x, r))
                    .join(', ')}`}
              </div>
            </ListRow>
          ))}
        </ul>
        <PagedFooter page={page} empty={r.briefs.empty} />
      </Section>
      {!canManage ? (
        <ReadOnlyNote />
      ) : scope.projectId && scope.project?.status === 'active' ? (
        <AddBrief
          projectId={scope.projectId}
          opportunityId={query.opportunityId ?? ''}
        />
      ) : null}
    </div>
  );
}

/** Возможности проекта, к которым можно писать бриф (`qualified`/`in_brief`). */
function useBriefOpportunities(projectId: string) {
  const { api } = useRedditStudio();
  return useAsync(async () => {
    if (!projectId) return [];
    const [a, b] = await Promise.all([
      api.opportunities({ projectId, status: 'qualified', limit: 100 }),
      api.opportunities({ projectId, status: 'in_brief', limit: 100 }),
    ]);
    return [...a.items, ...b.items];
  }, [api, projectId]);
}

function BriefFields({
  v,
  set,
  create,
  projectId,
}: {
  v: BriefForm;
  set: (v: BriefForm) => void;
  /** Тип, тред и сообщество задаются только при создании. */
  create: boolean;
  projectId: string;
}) {
  const { r } = useRedditStudio();
  const opps = useBriefOpportunities(create ? projectId : '');
  const comms = useRedditCommunities(create ? projectId : '');
  const issues = briefIssues(v);
  const pickOpportunity = (id: string) => {
    const o = (opps.data ?? []).find((x) => x.id === id);
    if (!o) {
      set({ ...v, opportunityId: '' });
      return;
    }
    const d = briefFormFromOpportunity(o);
    set({
      ...v,
      opportunityId: o.id,
      communityId: o.communityId,
      context: v.context.trim() ? v.context : d.context,
    });
  };
  return (
    <>
      {create && (
        <>
          <Field label={r.briefs.fields.contentType}>
            <Select
              value={v.contentType}
              options={REDDIT_CONTENT_TYPES}
              labels={r.briefs.contentTypes}
              empty={r.common.choose}
              onChange={(x) => set({ ...v, contentType: x })}
            />
          </Field>
          <label className="text-xs text-silver-500 flex flex-col gap-1">
            {r.briefs.fields.opportunity}
            <select
              className="w-full rounded-lg border border-silver-300 dark:border-silver-700 bg-transparent px-3 py-2 min-h-[44px] text-sm"
              value={v.opportunityId}
              onChange={(e) => pickOpportunity(e.target.value)}
            >
              <option value="">{r.common.choose}</option>
              {(opps.data ?? []).map((o) => (
                <option key={o.id} value={o.id}>
                  r/{o.subreddit} · {o.titleManual}
                </option>
              ))}
            </select>
          </label>
          <div className="text-xs text-silver-500">
            {r.briefs.opportunityHint}
          </div>
          {v.contentType === 'post' && !v.opportunityId && (
            <CommunitySelect
              communities={comms.data ?? []}
              value={v.communityId}
              onChange={(x) => set({ ...v, communityId: x })}
              empty={r.common.choose}
              label={r.briefs.fields.community}
              activeOnly
            />
          )}
        </>
      )}
      <Field label={r.briefs.fields.objective}>
        <TextArea
          value={v.objective}
          maxLength={500}
          rows={2}
          onChange={(x) => set({ ...v, objective: x })}
        />
      </Field>
      <Field label={r.briefs.fields.audience}>
        <TextInput
          value={v.audience}
          maxLength={500}
          onChange={(x) => set({ ...v, audience: x })}
        />
      </Field>
      <Field
        label={r.briefs.fields.context}
        hint={create && v.opportunityId ? r.briefs.contextDefault : undefined}
      >
        <TextArea
          value={v.context}
          maxLength={2000}
          rows={4}
          onChange={(x) => set({ ...v, context: x })}
        />
      </Field>
      <fieldset className="space-y-2">
        <legend className="text-xs text-silver-500">
          {r.briefs.fields.keyPoints}
        </legend>
        {v.keyPoints.map((k, i) => {
          const put = (patch: Partial<typeof k>) =>
            set({
              ...v,
              keyPoints: v.keyPoints.map((x, j) =>
                j === i ? { ...x, ...patch } : x
              ),
            });
          return (
            <div
              key={i}
              className="rounded-lg border border-silver-200 dark:border-silver-800 p-2 space-y-2"
            >
              <div className="text-xs font-medium">
                {fmtText(r.briefs.keyPoint, { n: i + 1 })}
              </div>
              <Field label={r.briefs.keyPointText}>
                <TextInput
                  value={k.text}
                  maxLength={300}
                  onChange={(x) => put({ text: x })}
                />
              </Field>
              <label className="flex items-center gap-2 text-sm min-h-[44px]">
                <input
                  type="checkbox"
                  checked={k.needsVerification}
                  onChange={(e) => put({ needsVerification: e.target.checked })}
                />
                {r.briefs.needsVerification}
              </label>
              {!k.needsVerification && (
                <SourcePicker
                  value={k.sources}
                  onChange={(x) => put({ sources: x })}
                  n={i + 1}
                />
              )}
              <Button
                variant="ghost"
                onClick={() =>
                  set({
                    ...v,
                    keyPoints: v.keyPoints.filter((_, j) => j !== i),
                  })
                }
              >
                {fmtText(r.briefs.removeKeyPoint, { n: i + 1 })}
              </Button>
            </div>
          );
        })}
        {v.keyPoints.length < 5 && (
          <Button
            variant="outline"
            onClick={() =>
              set({ ...v, keyPoints: [...v.keyPoints, keyPointForm()] })
            }
          >
            {r.briefs.addKeyPoint}
          </Button>
        )}
      </fieldset>
      <Field label={r.briefs.fields.affiliation}>
        <Select
          value={v.affiliation}
          options={REDDIT_AFFILIATIONS}
          labels={r.briefs.affiliations}
          empty={r.common.choose}
          onChange={(x) => set({ ...v, affiliation: x })}
        />
      </Field>
      <Field label={r.briefs.fields.brand} hint={r.briefs.brandHint}>
        <TextInput
          value={v.brand}
          maxLength={64}
          onChange={(x) => set({ ...v, brand: x })}
        />
      </Field>
      <label className="flex items-center gap-2 text-sm min-h-[44px]">
        <input
          type="checkbox"
          checked={v.linksAllowed}
          onChange={(e) => set({ ...v, linksAllowed: e.target.checked })}
        />
        {r.briefs.fields.linksAllowed}
      </label>
      <Field label={r.briefs.fields.tone}>
        <TextInput
          value={v.tone}
          maxLength={64}
          onChange={(x) => set({ ...v, tone: x })}
        />
      </Field>
      <Field label={r.briefs.fields.language}>
        <TextInput
          value={v.language}
          maxLength={16}
          onChange={(x) => set({ ...v, language: x })}
        />
      </Field>
      <Field label={r.briefs.fields.constraints}>
        <TextArea
          value={v.constraints}
          rows={2}
          onChange={(x) => set({ ...v, constraints: x })}
        />
      </Field>
      <Field label={r.briefs.fields.forbiddenClaims}>
        <TextArea
          value={v.forbiddenClaims}
          rows={2}
          onChange={(x) => set({ ...v, forbiddenClaims: x })}
        />
      </Field>
      <Field label={r.briefs.fields.cta}>
        <TextInput
          value={v.cta}
          maxLength={300}
          onChange={(x) => set({ ...v, cta: x })}
        />
      </Field>
      {issues.length > 0 && (
        <ul className="text-xs list-disc pl-5 text-amber-700 dark:text-amber-400">
          {issues.map((x) => (
            <li key={x}>{r.briefs.issues[x]}</li>
          ))}
        </ul>
      )}
    </>
  );
}

function AddBrief({
  projectId,
  opportunityId,
}: {
  projectId: string;
  opportunityId: string;
}) {
  const { r, api, studio, go, product } = useRedditStudio();
  const m = useMutation();
  // Бренд по умолчанию — имя продукта (как у сервера, §9.1).
  const withBrand = (f: BriefForm): BriefForm => ({
    ...f,
    brand: f.brand || product.name.slice(0, 64),
  });
  const [v, setV] = useState<BriefForm>(() => withBrand(briefForm()));
  // Из карточки возможности (`?opportunityId=`): comment к её треду.
  const from = useAsync(
    async () => (opportunityId ? api.opportunity(opportunityId) : null),
    [api, opportunityId]
  );
  const [prefilled, setPrefilled] = useState('');
  if (from.data && prefilled !== from.data.id) {
    setPrefilled(from.data.id);
    setV(withBrand(briefFormFromOpportunity(from.data)));
  }
  const body = briefCreateBody(projectId, v);
  return (
    <Section title={r.briefs.create}>
      <BriefFields v={v} set={setV} create projectId={projectId} />
      <StudioErrorAlert error={m.error} />
      <Button
        loading={m.busy}
        disabled={!body}
        onClick={async () => {
          if (!body) return;
          const x = await m.run(
            (k) => studio.createBrief(k, body),
            JSON.stringify(body)
          );
          if (x) go('reddit', x.id, { tab: 'briefs' });
        }}
      >
        {r.briefs.create}
      </Button>
    </Section>
  );
}

function BriefCard({ id }: { id: string }) {
  const { r, studio } = useRedditStudio();
  const state = useAsync(() => studio.brief(id), [studio, id]);
  return (
    <div className="space-y-4">
      <RecordLink section="reddit" query={{ tab: 'briefs' }}>
        {r.common.back}
      </RecordLink>
      <Loadable state={state}>
        {(b) => (
          <BriefCardBody b={b} reload={state.reload} onSaved={state.setData} />
        )}
      </Loadable>
    </div>
  );
}

/**
 * Источники тезиса — выбор из РАЗРЕШЁННЫХ источников продукта по названию
 * (аудит S3-4: не ввод id). Значение формы — id через запятую.
 */
function SourcePicker({
  value,
  onChange,
  n,
}: {
  value: string;
  onChange: (v: string) => void;
  n: number;
}) {
  const { r } = useRedditStudio();
  const src = useProductSources();
  const chosen = new Set(
    value
      .split(/[\s,;]+/)
      .map((x) => x.trim())
      .filter(Boolean)
  );
  const allowed = src.list.filter((x) => x.usage === 'allowed');
  // Выбранные, которых нет в списке (отозваны/вне первых 100) — тоже видны.
  const extra = [...chosen].filter((id) => !allowed.some((x) => x.id === id));
  const toggle = (id: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(id);
    else next.delete(id);
    onChange([...next].join(', '));
  };
  return (
    <fieldset className="space-y-1">
      <legend className="text-xs text-silver-500">
        {r.briefs.sourcesPick} · {fmtText(r.briefs.keyPoint, { n })}
      </legend>
      {allowed.length === 0 && extra.length === 0 && (
        <div className="text-xs text-silver-500">{r.briefs.noSources}</div>
      )}
      {[
        ...allowed.map((x) => ({ id: x.id, title: x.title ?? x.id })),
        ...extra.map((id) => ({
          id,
          title: fmtText(r.briefs.sourceUnknown, { id }),
        })),
      ].map((x) => (
        <label
          key={x.id}
          className="flex items-start gap-2 text-sm min-h-[44px]"
        >
          <input
            type="checkbox"
            className="mt-1"
            checked={chosen.has(x.id)}
            onChange={(e) => toggle(x.id, e.target.checked)}
          />
          <span className="break-words min-w-0">{x.title}</span>
        </label>
      ))}
      <div className="text-xs text-silver-500">
        {fmtText(r.briefs.sourcesChosen, { n: chosen.size })}
      </div>
    </fieldset>
  );
}

function BriefCardBody({
  b,
  reload,
  onSaved,
}: {
  b: RedditBriefView;
  reload: () => void;
  onSaved: (b: RedditBriefView) => void;
}) {
  const { r, studio, canManage } = useRedditStudio();
  const src = useProductSources();
  const contents = useAsync(() => studio.briefContents(b.id), [studio, b.id]);
  return (
    <>
      <Section
        title={<Wrap>{b.objective}</Wrap>}
        action={
          <StatusBadge
            status={b.status}
            labels={r.briefs.statuses}
            tone={briefTone(b.status)}
          />
        }
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Badge tone="neutral">{r.briefs.contentTypes[b.contentType]}</Badge>
          <RecordLink
            section="reddit"
            id={b.communityId}
            query={{ tab: 'communities' }}
          >
            r/{b.subreddit}
          </RecordLink>
          {b.opportunityId && (
            <RecordLink
              section="reddit"
              id={b.opportunityId}
              query={{ tab: 'opportunities' }}
            >
              {r.briefs.fields.opportunity}
            </RecordLink>
          )}
          {b.threadUrl && <RedditLink url={b.threadUrl} />}
        </div>
        <Row label={r.briefs.fields.affiliation}>
          {b.affiliation ? r.briefs.affiliations[b.affiliation] : r.common.none}
        </Row>
        <Row label={r.briefs.fields.brand}>{b.brand ?? r.common.none}</Row>
        <Row label={r.briefs.fields.linksAllowed}>
          {b.linksAllowed ? r.common.yes : r.common.no}
        </Row>
        <Row label={r.briefs.fields.language}>{b.language}</Row>
        <Row label={r.common.updatedAt}>
          <DateText iso={b.updatedAt} time />
        </Row>
        {b.context && (
          <>
            <div className="text-xs text-silver-500">
              {r.briefs.fields.context}
            </div>
            <PlainQuote text={b.context} injectionFlag={b.injectionFlag} />
          </>
        )}
        {b.keyPoints.length > 0 && (
          <ol className="list-decimal pl-5 text-sm space-y-0.5">
            {b.keyPoints.map((k, i) => (
              <li key={i} className="break-words">
                {k.text}{' '}
                <span className="text-xs text-silver-500">
                  (
                  {k.sourceIds === 'needs_verification'
                    ? r.studio.evidence.needsVerification
                    : k.sourceIds.map((x) => src.titles.get(x) ?? x).join(', ')}
                  )
                </span>
              </li>
            ))}
          </ol>
        )}
        {b.missing.length > 0 && (
          <Alert tone="warning" title={r.briefs.missingTitle}>
            <ul className="list-disc pl-5">
              {b.missing.map((x) => (
                <li key={x}>{missingText(x, r)}</li>
              ))}
            </ul>
          </Alert>
        )}
        {!b.ai.available && b.ai.reason && (
          <Alert tone="neutral">{r.briefs.ai[b.ai.reason]}</Alert>
        )}
      </Section>
      <Section title={r.briefs.gate}>
        <GateBlock gate={b.gate} />
      </Section>
      <Section title={r.briefs.material}>
        <Loadable state={contents}>
          {(items) =>
            items.length ? (
              <ul className="space-y-1">
                {items.map((m) => (
                  <li
                    key={m.content.id}
                    className="flex flex-wrap gap-2 items-center"
                  >
                    <RecordLink
                      section="reddit"
                      id={m.content.id}
                      query={{ tab: 'studio' }}
                    >
                      {r.briefs.openStudio}
                    </RecordLink>
                    <StatusBadge
                      status={m.content.status}
                      labels={r.studio.statuses}
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-sm text-silver-500">
                {r.briefs.noMaterial}
              </div>
            )
          }
        </Loadable>
        {canManage &&
          b.status === 'ready' &&
          b.missing.length === 0 &&
          contents.data?.length === 0 && <CreateMaterial b={b} />}
      </Section>
      {!canManage ? (
        <ReadOnlyNote />
      ) : b.status !== 'archived' ? (
        <>
          <BriefEdit b={b} reload={reload} onSaved={onSaved} />
          <BriefStatusActions b={b} reload={reload} onSaved={onSaved} />
        </>
      ) : (
        <Alert tone="neutral">{r.briefs.archiveHint}</Alert>
      )}
    </>
  );
}

function CreateMaterial({ b }: { b: RedditBriefView }) {
  const { r, studio, go } = useRedditStudio();
  const m = useMutation();
  return (
    <div className="space-y-2">
      <StudioErrorAlert error={m.error} />
      <Button
        loading={m.busy}
        onClick={async () => {
          const x = await m.run(
            (k) => studio.createContent(b.id, k, {}),
            `content:${b.id}`
          );
          if (x) go('reddit', x.content.id, { tab: 'studio' });
        }}
      >
        {r.briefs.createMaterial}
      </Button>
    </div>
  );
}

function BriefEdit({
  b,
  reload,
  onSaved,
}: {
  b: RedditBriefView;
  reload: () => void;
  onSaved: (b: RedditBriefView) => void;
}) {
  const { r, studio } = useRedditStudio();
  const m = useMutation();
  const [notice, setNotice] = useState<string | null>(null);
  const f = useRebaseForm<BriefForm>(briefForm(b), b.revision);
  const patch = f.conflicts.length ? null : briefPatchBody(b, f.v, f.base);
  return (
    <Section title={r.common.edit}>
      <BriefFields v={f.v} set={f.set} create={false} projectId={b.projectId} />
      <ConflictPanel
        conflicts={f.conflicts}
        label={(key) =>
          (r.briefs.fields as Record<string, string>)[key as string] ??
          String(key)
        }
        show={(_k, x) =>
          Array.isArray(x)
            ? x
                .map((k) =>
                  typeof k === 'object' && k ? (k as { text: string }).text : ''
                )
                .join('; ')
            : String(x)
        }
        resolve={f.resolve}
      />
      <Notice text={notice} />
      <StudioErrorAlert error={m.error} onReload={reload} />
      <Button
        loading={m.busy}
        disabled={!patch}
        onClick={async () => {
          if (!patch) return;
          const x = await m.run(
            (k) => studio.patchBrief(b.id, k, patch),
            JSON.stringify(patch)
          );
          if (x) {
            setNotice(r.briefs.saved);
            onSaved(x);
          }
        }}
      >
        {r.common.save}
      </Button>
    </Section>
  );
}

function BriefStatusActions({
  b,
  reload,
  onSaved,
}: {
  b: RedditBriefView;
  reload: () => void;
  onSaved: (b: RedditBriefView) => void;
}) {
  const { r, studio } = useRedditStudio();
  const ready = useMutation();
  const arch = useMutation();
  return (
    <Section title={r.common.status}>
      {b.status === 'draft' && (
        <>
          <div className="text-xs text-silver-500">{r.briefs.readyHint}</div>
          <StudioErrorAlert error={ready.error} onReload={reload} />
          <Button
            loading={ready.busy}
            onClick={async () => {
              const x = await ready.run(
                (k) => studio.briefReady(b.id, k, b.revision),
                `ready:${b.id}:${b.revision}`
              );
              if (x) onSaved(x);
            }}
          >
            {r.briefs.ready}
          </Button>
        </>
      )}
      <div className="text-xs text-silver-500">{r.briefs.archiveHint}</div>
      <StudioErrorAlert error={arch.error} onReload={reload} />
      <ConfirmButton
        variant="outline"
        loading={arch.busy}
        onConfirm={async () => {
          const x = await arch.run(
            (k) => studio.archiveBrief(b.id, k, b.revision),
            `archive:${b.id}:${b.revision}`
          );
          if (x) onSaved(x);
        }}
      >
        {r.common.archive}
      </ConfirmButton>
    </Section>
  );
}
