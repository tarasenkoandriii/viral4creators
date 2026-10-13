import { useState } from 'react';
import { useAsync } from '../../../kit';
import { Alert, Badge, Button } from '../../../kit/ui';
import type {
  ActionTransitionIn,
  ChannelView,
  DistributionActionView,
} from '../../../lib/publisher/calendar-api';
import {
  DISTRIBUTION_BLOCK_REASONS,
  DISTRIBUTION_STATUSES,
  type DistributionBlockReason,
} from '../../../lib/publisher/states';
import { fmtDate, fmtTime } from '../../../lib/publisher/view';
import { decodeStart } from '../../../lib/publisher/ai-api';
import {
  useListFilters,
  useMutation,
  usePubApis,
  usePubContent,
} from '../hooks';
import {
  EmptyState,
  ExternalUrl,
  Field,
  ListToolbar,
  Loadable,
  LoadMore,
  NoPermission,
  Notice,
  PubErrorAlert,
  RecordLink,
  Section,
  Select,
  StatusBadge,
  TextInput,
} from '../parts';
import { usePublisher } from '../publisher-context';
import type { PublisherSectionProps } from '../registry';
import { AiRunner } from './AiRunner';
import { ChannelsPanel } from './ChannelsPanel';

/**
 * Календарь распространения F09 (§14.1 `calendar`): действия по датам и
 * каналам, фильтры (статус, ответственный, канал, период), выгрузка CSV,
 * «заблокировано» с причиной, «выполнено» — только с публикацией той же
 * версии в том же канале (решает сервер). AI-план в P0 выключен.
 */
export function CalendarScreen({ query }: PublisherSectionProps) {
  const { product, can, locale } = usePublisher();
  const c = usePubContent();
  const apis = usePubApis();
  const f = useListFilters('calendar', query, [
    'status',
    'owner',
    'channelId',
    'from',
    'to',
  ]);
  const q = {
    status: f.values.status || undefined,
    owner: f.values.owner || undefined,
    channelId: f.values.channelId || undefined,
    from: f.values.from || undefined,
    to: f.values.to || undefined,
  };
  const channels = useAsync(() => apis.calendar.channels(), [apis, product.id]);
  const [extra, setExtra] = useState<DistributionActionView[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const list = useAsync(async () => {
    const page = await apis.calendar.actions({ ...q, limit: 100 });
    setExtra([]);
    setNext(page.nextBefore);
    return page.items;
  }, [apis, product.id, q.status, q.owner, q.channelId, q.from, q.to]);
  const all = [...(list.data ?? []), ...extra].sort(
    (a, b) => Date.parse(a.plannedAt) - Date.parse(b.plannedAt)
  );
  const byDay = new Map<string, DistributionActionView[]>();
  for (const a of all) {
    const d = fmtDate(a.plannedAt, locale);
    byDay.set(d, [...(byDay.get(d) ?? []), a]);
  }

  return (
    <div className="space-y-4">
      <Alert tone="neutral" title={c.calendar.title}>
        {c.calendar.hint}
      </Alert>
      {can('distribution.manage') ? (
        <NewAction channels={channels.data ?? []} onDone={list.reload} />
      ) : (
        <NoPermission />
      )}
      <Section title={c.calendar.title}>
        <ListToolbar
          statuses={DISTRIBUTION_STATUSES}
          status={f.values.status}
          onStatus={(v) => f.set('status', v)}
          statusLabels={c.calendar.statuses}
          owner={f.values.owner}
          onOwner={(v) => f.set('owner', v)}
          csvPath={`products/${product.id}/distribution/actions`}
          csvQuery={q}
          extra={
            <>
              <Field label={c.calendar.channelFilter}>
                <select
                  className="w-full rounded-lg border border-silver-300 dark:border-silver-700 bg-transparent px-3 py-2 min-h-[44px] text-sm"
                  value={f.values.channelId}
                  onChange={(e) => f.set('channelId', e.target.value)}
                >
                  <option value="">—</option>
                  {(channels.data ?? []).map((ch) => (
                    <option key={ch.id} value={ch.id}>
                      {ch.title}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={c.calendar.from}>
                <TextInput
                  value={f.values.from}
                  onChange={(v) => f.set('from', v)}
                  type="date"
                />
              </Field>
              <Field label={c.calendar.to}>
                <TextInput
                  value={f.values.to}
                  onChange={(v) => f.set('to', v)}
                  type="date"
                />
              </Field>
            </>
          }
        />
        <Loadable state={list}>
          {() =>
            all.length ? (
              <div className="space-y-3">
                {[...byDay.entries()].map(([day, items]) => (
                  <div key={day}>
                    <div className="text-xs font-semibold text-silver-500 mb-1">
                      {day}
                    </div>
                    <ul className="divide-y divide-silver-200 dark:divide-silver-800">
                      {items.map((a) => (
                        <ActionRow
                          key={a.id}
                          action={a}
                          channel={
                            (channels.data ?? []).find(
                              (ch) => ch.id === a.channelId
                            ) ?? null
                          }
                          onChanged={list.reload}
                        />
                      ))}
                    </ul>
                  </div>
                ))}
                <LoadMore
                  next={next}
                  onMore={async (before) => {
                    const page = await apis.calendar.actions({
                      ...q,
                      before,
                      limit: 100,
                    });
                    setExtra((x) => [...x, ...page.items]);
                    setNext(page.nextBefore);
                  }}
                />
              </div>
            ) : (
              <EmptyState />
            )
          }
        </Loadable>
      </Section>
      <ChannelsPanel state={channels} />
    </div>
  );
}

function ActionRow({
  action: a,
  channel,
  onChanged,
}: {
  action: DistributionActionView;
  channel: ChannelView | null;
  onChanged: () => void;
}) {
  const { can, locale } = usePublisher();
  const c = usePubContent();
  const apis = usePubApis();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<DistributionBlockReason | ''>('');
  const [pubId, setPubId] = useState('');
  const m = useMutation();
  const pubs = useAsync(
    async () =>
      open
        ? (
            await apis.calendar.publications({
              versionId: a.versionId,
              channelId: a.channelId,
              limit: 20,
            })
          ).items
        : null,
    [apis, open, a.versionId, a.channelId]
  );
  const move = async (body: Omit<ActionTransitionIn, 'expectedRevision'>) => {
    const r = await m.run((k) =>
      apis.calendar.actionTransition(
        a.id,
        { ...body, expectedRevision: a.revision },
        k
      )
    );
    if (r) {
      setOpen(false);
      onChanged();
    }
  };
  const time = fmtTime(a.plannedAt, locale);
  return (
    <li className="py-2 space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-silver-500">{time}</span>
        <Badge tone="neutral">{channel?.title ?? a.channelId}</Badge>
        <span className="flex-1 min-w-0">
          {a.format} · {a.goal}
        </span>
        <StatusBadge status={a.status} labels={c.calendar.statuses} />
        {a.blockReason && (
          <Badge tone="danger">{c.calendar.blockReasons[a.blockReason]}</Badge>
        )}
      </div>
      <div className="text-xs text-silver-500 flex flex-wrap gap-3">
        <span>{a.ownerDisplayName}</span>
        <RecordLink section="materials" id={a.contentId}>
          {c.materials.title}
        </RecordLink>
      </div>
      <div className="text-xs">
        {c.calendar.measurableUrl}: <ExternalUrl url={a.measurableUrl} />
      </div>
      {a.doneUrl && (
        <div className="text-xs">
          {c.calendar.doneUrl}: <ExternalUrl url={a.doneUrl} />
        </div>
      )}
      {can('distribution.manage') &&
        (a.status === 'planned' || a.status === 'blocked') && (
          <Button variant="ghost" onClick={() => setOpen((v) => !v)}>
            {c.calendar.markDone} / {c.calendar.block}
          </Button>
        )}
      {open && (
        <div className="space-y-2 pl-2">
          <Loadable state={pubs}>
            {(items) =>
              items && items.length ? (
                <div className="flex flex-wrap items-end gap-2">
                  <Field label={c.calendar.publication}>
                    <select
                      className="w-full rounded-lg border border-silver-300 dark:border-silver-700 bg-transparent px-3 py-2 min-h-[44px] text-sm"
                      value={pubId}
                      onChange={(e) => setPubId(e.target.value)}
                    >
                      <option value="">—</option>
                      {items.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.finalUrl} ({p.status})
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Button
                    loading={m.busy}
                    disabled={!pubId}
                    onClick={() => move({ to: 'done', publicationId: pubId })}
                  >
                    {c.calendar.markDone}
                  </Button>
                </div>
              ) : (
                <div className="text-xs text-amber-700">
                  {c.calendar.noPublication}
                </div>
              )
            }
          </Loadable>
          <div className="flex flex-wrap items-end gap-2">
            <Field label={c.calendar.block}>
              <Select
                value={reason}
                options={DISTRIBUTION_BLOCK_REASONS}
                labels={c.calendar.blockReasons}
                empty="—"
                onChange={setReason}
              />
            </Field>
            <Button
              variant="outline"
              loading={m.busy}
              disabled={!reason}
              onClick={() => reason && move({ to: 'blocked', reason })}
            >
              {c.calendar.block}
            </Button>
            {a.status === 'blocked' && (
              <Button
                variant="ghost"
                loading={m.busy}
                onClick={() => move({ to: 'planned' })}
              >
                {c.calendar.unblock}
              </Button>
            )}
            <Button
              variant="danger"
              loading={m.busy}
              onClick={() => move({ to: 'cancelled' })}
            >
              {c.calendar.cancel}
            </Button>
          </div>
        </div>
      )}
      <PubErrorAlert error={m.error} onReload={onChanged} />
    </li>
  );
}

function NewAction({
  channels,
  onDone,
}: {
  channels: ChannelView[];
  onDone: () => void;
}) {
  const { memberId, can } = usePublisher();
  const c = usePubContent();
  const apis = usePubApis();
  const approved = useAsync(async () => {
    const page = await apis.content.contents({ limit: 100 });
    return page.items.filter((x) => x.approvedVersionId);
  }, [apis]);
  const [contentId, setContentId] = useState('');
  const [channelId, setChannelId] = useState('');
  const [format, setFormat] = useState('');
  const [goal, setGoal] = useState('');
  const [plannedAt, setPlannedAt] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const m = useMutation();
  const content = (approved.data ?? []).find((x) => x.id === contentId);
  return (
    <Section title={c.calendar.add}>
      {approved.data && approved.data.length === 0 && (
        <Alert tone="neutral">{c.calendar.noApproved}</Alert>
      )}
      <div className="grid gap-2 md:grid-cols-2">
        <Field label={c.calendar.version}>
          <select
            className="w-full rounded-lg border border-silver-300 dark:border-silver-700 bg-transparent px-3 py-2 min-h-[44px] text-sm"
            value={contentId}
            onChange={(e) => setContentId(e.target.value)}
          >
            <option value="">—</option>
            {(approved.data ?? []).map((x) => (
              <option key={x.id} value={x.id}>
                {c.materials.kinds[x.kind]} · {x.slug ?? x.id}
              </option>
            ))}
          </select>
        </Field>
        <Field label={c.materials.channel}>
          <select
            className="w-full rounded-lg border border-silver-300 dark:border-silver-700 bg-transparent px-3 py-2 min-h-[44px] text-sm"
            value={channelId}
            onChange={(e) => setChannelId(e.target.value)}
          >
            <option value="">—</option>
            {channels.map((ch) => (
              <option key={ch.id} value={ch.id}>
                {ch.title} ({ch.kind})
              </option>
            ))}
          </select>
        </Field>
        <Field label={c.calendar.format}>
          <TextInput value={format} onChange={setFormat} maxLength={64} />
        </Field>
        <Field label={c.calendar.goal}>
          <TextInput value={goal} onChange={setGoal} maxLength={300} />
        </Field>
        <Field label={c.calendar.plannedAt}>
          <TextInput
            value={plannedAt}
            onChange={setPlannedAt}
            type="datetime-local"
          />
        </Field>
        <Field label={c.materials.ownerName}>
          <TextInput value={ownerName} onChange={setOwnerName} maxLength={80} />
        </Field>
      </div>
      <Notice text={notice} />
      <PubErrorAlert error={m.error} />
      <Button
        loading={m.busy}
        disabled={
          !content ||
          !channelId ||
          !format.trim() ||
          !goal.trim() ||
          !plannedAt ||
          !memberId
        }
        onClick={async () => {
          const versionId = content?.approvedVersionId;
          if (!versionId) return;
          const r = await m.run((k) =>
            apis.calendar.createAction(
              {
                versionId,
                channelId,
                format: format.trim(),
                goal: goal.trim(),
                plannedAt: new Date(plannedAt).toISOString(),
                ownerMemberId: memberId,
                ...(ownerName.trim()
                  ? { ownerDisplayName: ownerName.trim() }
                  : {}),
              },
              k
            )
          );
          if (r) {
            setNotice(c.calendar.added);
            onDone();
          }
        }}
      >
        {c.calendar.add}
      </Button>
      {can('distribution.manage') && contentId && (
        <AiRunner
          generator="pub.distribution.plan"
          label={c.calendar.aiPlan}
          manualHint={c.calendar.aiPlanManual}
          // В P0 маршрут отвечает 409 PUB_AI_DISABLED — экран ведёт к ручному пути.
          start={async (k) =>
            decodeStart(await apis.calendar.aiPlan(contentId, k))
          }
          render={() => null}
        />
      )}
    </Section>
  );
}
