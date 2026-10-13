/**
 * F17 — учёт часов (P-G2, §14.1 `time`): записи по ролям и категориям,
 * настройка/разработка (инвестиции) отдельно от операций, ставка «не
 * утверждена» — не ноль. Свои записи — все роли, чужие — владелец продукта.
 */
import { useState } from 'react';
import { Badge, Button, ScreenTitle } from '../../../kit/ui';
import {
  TIME_ENTRY_CATEGORIES,
  TIME_ENTRY_ROLES,
  type TimeCategory,
  type TimeEntryView,
  type TimeRole,
} from '../../../lib/publisher/reports-api';
import { hours, kyivToday, timeTotals } from '../../../lib/publisher/ops-view';
import { fmtMinor, fmtText } from '../../../lib/publisher/view';
import { useListFilters, useMutation } from '../hooks';
import {
  DateText,
  Field,
  ListToolbar,
  NoPermission,
  PubErrorAlert,
  RecordLink,
  Row,
  Section,
  Select,
  TextInput,
} from '../parts';
import type { PublisherSectionProps } from '../registry';
import { ActionBlock, ListRow, MemberPicker, PagedFooter } from './ops-parts';
import { useOps, usePaged } from './ops-hooks';

export function TimeSection({ query }: PublisherSectionProps) {
  const { o, reports, pid, can } = useOps();
  const others = can('time.others');
  const f = useListFilters('time', query, ['owner', 'status']);
  const page = usePaged(
    (before) =>
      reports.timeEntries(pid, {
        member: others ? f.values.owner || undefined : undefined,
        before,
      }),
    [pid, f.values.owner, others]
  );
  // «Статус» записи часов — категория (у записи нет машины состояний).
  const rows = page.items.filter(
    (e) => !f.values.status || e.category === f.values.status
  );
  const tot = timeTotals(rows);
  return (
    <div className="space-y-4">
      <ScreenTitle>{o.time.title}</ScreenTitle>
      <p className="text-sm text-silver-500">{o.time.intro}</p>
      <ListToolbar
        statuses={TIME_ENTRY_CATEGORIES}
        status={f.values.status}
        onStatus={(v) => f.set('status', v)}
        statusLabels={o.time.categories}
        owner={others ? f.values.owner : undefined}
        onOwner={others ? (v) => f.set('owner', v) : undefined}
        csvPath={`products/${pid}/time-entries`}
        csvQuery={{ member: others ? f.values.owner : undefined }}
      />
      <Section title={o.time.byRole}>
        <div className="text-sm">
          {fmtText(o.time.totals, {
            h: hours(tot.minutes),
            op: hours(tot.operations),
            inv: hours(tot.investment),
          })}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <div>
            <div className="text-xs text-silver-500">{o.time.byRole}</div>
            {Object.entries(tot.byRole).map(([k, m]) => (
              <Row key={k} label={o.time.roles[k as TimeRole] ?? k}>
                {hours(m)}
              </Row>
            ))}
          </div>
          <div>
            <div className="text-xs text-silver-500">{o.time.byCategory}</div>
            {Object.entries(tot.byCategory).map(([k, m]) => (
              <Row key={k} label={o.time.categories[k as TimeCategory] ?? k}>
                {hours(m)}
              </Row>
            ))}
          </div>
        </div>
      </Section>
      <Section title={o.nav.time}>
        <ul>
          {rows.map((e) => (
            <TimeRow
              key={e.id}
              e={e}
              onSaved={(x) => page.replace((y) => y.id === x.id, x)}
            />
          ))}
        </ul>
        <PagedFooter page={page} empty={o.time.empty} />
      </Section>
      {can('time.own') ? (
        <CreateEntry others={others} onDone={page.reload} />
      ) : (
        <NoPermission />
      )}
    </div>
  );
}

function TimeRow({
  e,
  onSaved,
}: {
  e: TimeEntryView;
  onSaved: (e: TimeEntryView) => void;
}) {
  const { o, reports, pid, memberId, can, locale } = useOps();
  const m = useMutation();
  const [minutes, setMinutes] = useState(String(e.minutes));
  const [task, setTask] = useState(e.task);
  const editable = e.memberId === memberId || can('time.others');
  return (
    <ListRow
      title={
        <>
          <DateText iso={`${e.workDate}T12:00:00+02:00`} /> · {hours(e.minutes)}{' '}
          · {o.time.categories[e.category]}
        </>
      }
      badges={
        <>
          <Badge>{o.time.roles[e.role]}</Badge>
          <Badge tone={e.isInvestment ? 'accent' : 'neutral'}>
            {e.isInvestment ? o.time.investment : o.time.operations}
          </Badge>
          <Badge tone={e.rateMinorPerHour ? 'neutral' : 'warning'}>
            {e.rateMinorPerHour
              ? fmtText(o.time.rate, {
                  v: fmtMinor(
                    e.rateMinorPerHour,
                    null,
                    locale,
                    o.common.unknown
                  ),
                })
              : o.time.rateUnknown}
          </Badge>
        </>
      }
    >
      <div>
        {e.memberDisplayName} · {e.task}
      </div>
      {e.contentId && (
        <RecordLink section="materials" id={e.contentId}>
          {e.contentId}
        </RecordLink>
      )}
      {editable && (
        <ActionBlock title={o.common.open}>
          <Field label={o.time.task} hint={o.common.hintPii}>
            <TextInput value={task} onChange={setTask} maxLength={500} />
          </Field>
          <Field label={o.time.minutes}>
            <TextInput type="number" value={minutes} onChange={setMinutes} />
          </Field>
          <PubErrorAlert error={m.error} />
          <Button
            loading={m.busy}
            disabled={!/^\d{1,4}$/.test(minutes) || !task.trim()}
            onClick={async () => {
              const x = await m.run((k) =>
                reports.patchTimeEntry(pid, e.id, k, {
                  expectedRevision: e.revision,
                  task: task.trim(),
                  minutes: Number(minutes),
                })
              );
              if (x) onSaved(x);
            }}
          >
            {o.common.apply}
          </Button>
        </ActionBlock>
      )}
    </ListRow>
  );
}

function CreateEntry({
  others,
  onDone,
}: {
  others: boolean;
  onDone: () => void;
}) {
  const { o, reports, pid, roles } = useOps();
  const m = useMutation();
  const myRoles: TimeRole[] = [
    ...roles.roles,
    ...(roles.admin ? (['admin'] as const) : []),
  ].filter((r): r is TimeRole =>
    (TIME_ENTRY_ROLES as readonly string[]).includes(r)
  );
  const [v, setV] = useState({
    member: '',
    role: (myRoles[0] ?? '') as TimeRole | '',
    task: '',
    minutes: '',
    workDate: kyivToday(),
    category: '' as TimeCategory | '',
  });
  const roleOptions = v.member ? TIME_ENTRY_ROLES : myRoles;
  return (
    <Section title={o.time.create}>
      {others && (
        <Field label={o.time.forMember}>
          <MemberPicker
            value={v.member}
            onChange={(x) => setV({ ...v, member: x })}
            allowNone
          />
        </Field>
      )}
      <Field label={o.time.role}>
        <Select
          value={v.role}
          options={roleOptions}
          labels={o.time.roles}
          empty={o.common.choose}
          onChange={(x) => setV({ ...v, role: x })}
        />
      </Field>
      <Field label={o.time.category}>
        <Select
          value={v.category}
          options={TIME_ENTRY_CATEGORIES}
          labels={o.time.categories}
          empty={o.common.choose}
          onChange={(x) => setV({ ...v, category: x })}
        />
      </Field>
      <Field label={o.time.task} hint={o.common.hintPii}>
        <TextInput
          value={v.task}
          onChange={(x) => setV({ ...v, task: x })}
          maxLength={500}
        />
      </Field>
      <Field label={o.time.minutes}>
        <TextInput
          type="number"
          value={v.minutes}
          onChange={(x) => setV({ ...v, minutes: x })}
        />
      </Field>
      <Field label={o.time.workDate}>
        <TextInput
          type="date"
          value={v.workDate}
          onChange={(x) => setV({ ...v, workDate: x })}
        />
      </Field>
      <PubErrorAlert error={m.error} />
      <Button
        loading={m.busy}
        disabled={
          !v.role ||
          !v.category ||
          !v.task.trim() ||
          !/^\d{1,4}$/.test(v.minutes) ||
          !v.workDate
        }
        onClick={async () => {
          if (!v.role || !v.category) return;
          const x = await m.run((k) =>
            reports.createTimeEntry(pid, k, {
              ...(v.member ? { memberId: v.member } : {}),
              role: v.role as TimeRole,
              task: v.task.trim(),
              minutes: Number(v.minutes),
              workDate: v.workDate,
              category: v.category as TimeCategory,
            })
          );
          if (x) {
            setV({ ...v, task: '', minutes: '' });
            onDone();
          }
        }}
      >
        {o.time.create}
      </Button>
    </Section>
  );
}
