/**
 * F11 — заявки (P-G2, §14.1 `leads`, `leads/:id`): очередь без контактов
 * (новые сверху, срок первого контакта и просрочка, «очередь проверена
 * сегодня»), карточка с раскрытием контакта ПО КНОПКЕ с целью (GET, аудит
 * на сервере; в состоянии — только на время показа), квалификация с кодом
 * причины и шифрованной заметкой, тест-флаг, дубль, проспект, ретенция;
 * вкладки проспектов, оплат клиентов, хранения и уведомлений.
 */
import { useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, ScreenTitle, Tabs } from '../../../kit/ui';
import { useAsync } from '../../../kit';
import {
  CONTACT_PURPOSES,
  LEAD_REASON_CODES,
  LEAD_STATUSES,
  LEAD_TEST_FILTERS,
  NOTIFICATION_STATUSES,
  PAYER_KINDS,
  PAYMENT_RECORD_TYPES,
  PRIOR_EXTERNAL_PAYMENT,
  type ContactPurpose,
  type LeadCardView,
  type LeadContactView,
  type LeadNotesView,
  type LeadStatus,
  type LeadTestFilter,
  type PaymentView,
  type PaymentsPage,
  type PriorExternalPayment,
  type ProspectView,
} from '../../../lib/publisher/leads-api';
import {
  CONTACT_SHOW_SECONDS,
  revealedFor,
  type Revealed,
  kyivToday,
  leadTargets,
  localToIso,
  transitionNeedsReason,
} from '../../../lib/publisher/ops-view';
import { fmtText } from '../../../lib/publisher/view';
import { useListFilters, useMutation } from '../hooks';
import {
  ConfirmButton,
  DateText,
  Field,
  ListToolbar,
  Loadable,
  MoneyText,
  NoPermission,
  PubErrorAlert,
  RecordLink,
  Row,
  Section,
  Select,
  StatusBadge,
  TextArea,
  TextInput,
} from '../parts';
import type { PublisherSectionProps } from '../registry';
import {
  ActionBlock,
  ListRow,
  MemberPicker,
  MoneyInput,
  PagedFooter,
} from './ops-parts';
import { useOps, usePaged } from './ops-hooks';

const TABS = [
  'queue',
  'prospects',
  'payments',
  'retention',
  'notifications',
] as const;
type Tab = (typeof TABS)[number];

export function LeadsSection({ id, query }: PublisherSectionProps) {
  const { o, go, can } = useOps();
  if (id) return <LeadCard id={id} />;
  const visible: Tab[] = TABS.filter((tb) =>
    tb === 'queue'
      ? true
      : tb === 'payments'
        ? can('payment.manage')
        : tb === 'retention'
          ? can('retention.manage')
          : can('lead.manage')
  );
  const tab: Tab = (visible as string[]).includes(query.tab ?? '')
    ? (query.tab as Tab)
    : 'queue';
  return (
    <div className="space-y-4">
      <ScreenTitle>{o.leads.title}</ScreenTitle>
      <Tabs
        tabs={visible.map((k) => ({ key: k, label: o.leads.tabs[k] }))}
        active={tab}
        onChange={(k) => go('leads', null, k === 'queue' ? {} : { tab: k })}
      />
      {tab === 'queue' && <Queue query={query} />}
      {tab === 'prospects' && <Prospects />}
      {tab === 'payments' && <Payments query={query} />}
      {tab === 'retention' && <Retention />}
      {tab === 'notifications' && <Notifications query={query} />}
    </div>
  );
}

// ── Очередь ──────────────────────────────────────────────────────────────

function Queue({ query }: { query: PublisherSectionProps['query'] }) {
  const { o, leads, pid, can } = useOps();
  const f = useListFilters('leads', query, ['status', 'owner', 'test']);
  const test = (LEAD_TEST_FILTERS as readonly string[]).includes(f.values.test)
    ? (f.values.test as LeadTestFilter)
    : 'include';
  const page = usePaged(
    (before) =>
      leads.leads(pid, {
        status: (f.values.status || undefined) as LeadStatus | undefined,
        responsible: f.values.owner || undefined,
        test,
        before,
      }),
    [pid, f.values.status, f.values.owner, test]
  );
  return (
    <>
      <p className="text-sm text-silver-500">{o.leads.intro}</p>
      {can('queue.check') && <QueueCheck />}
      <ListToolbar
        statuses={LEAD_STATUSES}
        status={f.values.status}
        onStatus={(v) => f.set('status', v)}
        statusLabels={o.leads.statuses}
        owner={f.values.owner}
        onOwner={(v) => f.set('owner', v)}
        ownerNone
        csvPath={`products/${pid}/leads`}
        csvQuery={{
          status: f.values.status,
          responsible: f.values.owner,
          test,
        }}
        extra={
          <label className="text-xs text-silver-500 flex flex-col gap-1">
            {o.common.test}
            <Select
              value={test}
              options={LEAD_TEST_FILTERS}
              labels={o.leads.testFilter}
              onChange={(v) => f.set('test', v === 'include' ? '' : v)}
            />
          </label>
        }
      />
      <Section title={o.leads.tabs.queue}>
        <ul>
          {page.items.map((l) => (
            <ListRow
              key={l.id}
              title={
                <RecordLink section="leads" id={l.id}>
                  {l.publicRef}
                </RecordLink>
              }
              badges={
                <>
                  <StatusBadge status={l.status} labels={o.leads.statuses} />
                  {l.overdue && <Badge tone="danger">{o.leads.overdue}</Badge>}
                  {l.testFlag && <Badge tone="warning">{o.common.test}</Badge>}
                  {l.suspectedSpam && (
                    <Badge tone="warning">{o.leads.spam}</Badge>
                  )}
                  {l.erased && <Badge>{o.leads.erased}</Badge>}
                </>
              }
            >
              <div>
                {o.leads.received}: <DateText iso={l.receivedAt} time /> ·{' '}
                {o.leads.contactMethods[l.contactMethod]}
              </div>
              <div>
                {o.leads.contactDue}:{' '}
                {l.contactDueAt ? (
                  <DateText iso={l.contactDueAt} time />
                ) : (
                  <span className="text-amber-700 dark:text-amber-400">
                    {o.leads.contactDueUnknown}
                  </span>
                )}
              </div>
              <div>
                {o.leads.responsible}:{' '}
                {l.responsibleDisplayName ??
                  l.responsibleMemberId ??
                  o.common.nobody}
                {l.prospectCode && (
                  <>
                    {' · '}
                    {o.leads.prospect}: {l.prospectCode}
                  </>
                )}
                {!l.enriched && <> · {o.leads.notEnriched}</>}
              </div>
            </ListRow>
          ))}
        </ul>
        <PagedFooter page={page} empty={o.leads.empty} />
      </Section>
    </>
  );
}

function QueueCheck() {
  const { o, leads, pid } = useOps();
  const today = kyivToday();
  const state = useAsync(() => leads.queueChecks(pid), [pid]);
  const m = useMutation();
  const mine = state.data?.items.find((c) => c.workDate === today) ?? null;
  return (
    <Section
      title={o.leads.queueCheck}
      action={
        <Button
          loading={m.busy}
          variant={mine ? 'outline' : 'solid'}
          onClick={async () => {
            const x = await m.run((k) => leads.markQueueChecked(pid, k));
            if (x) state.reload();
          }}
        >
          {o.leads.queueCheck}
        </Button>
      }
    >
      {mine ? (
        <div className="text-sm">
          {fmtText(o.leads.queueChecked, {
            date: mine.workDate,
            open: mine.openCount,
            overdue: mine.overdueCount,
          })}
        </div>
      ) : (
        <Alert tone="warning">{o.leads.queueNotChecked}</Alert>
      )}
      {state.data && state.data.missingWorkDates.length > 0 && (
        <div className="text-xs text-amber-700 dark:text-amber-400">
          {fmtText(o.leads.queueMissing, {
            list: state.data.missingWorkDates.join(', '),
          })}
        </div>
      )}
      <PubErrorAlert error={m.error ?? state.error} />
    </Section>
  );
}

// ── Карточка ─────────────────────────────────────────────────────────────

function LeadCard({ id }: { id: string }) {
  const { o, leads, pid } = useOps();
  const state = useAsync(() => leads.lead(pid, id), [pid, id]);
  return (
    <div className="space-y-4">
      <RecordLink section="leads">{o.common.back}</RecordLink>
      <Loadable state={state}>
        {(l) => (
          <LeadBody
            key={`${l.id}:${l.revision}`}
            l={l}
            onChange={(x) => state.setData(x)}
            reload={state.reload}
          />
        )}
      </Loadable>
    </div>
  );
}

function LeadBody({
  l,
  onChange,
  reload,
}: {
  l: LeadCardView;
  onChange: (l: LeadCardView) => void;
  reload: () => void;
}) {
  const { o, can } = useOps();
  const manage = can('lead.manage');
  return (
    <div className="space-y-4">
      <ScreenTitle>
        {fmtText(o.leads.card, { ref: l.publicRef })}{' '}
        <StatusBadge status={l.status} labels={o.leads.statuses} />
      </ScreenTitle>
      <div className="flex flex-wrap gap-1">
        {l.overdue && <Badge tone="danger">{o.leads.overdue}</Badge>}
        {l.testFlag && (
          <Badge tone="warning">
            {o.common.test}
            {l.testReason
              ? ` · ${o.leads.testReasons[l.testReason as keyof typeof o.leads.testReasons] ?? l.testReason}`
              : ''}
          </Badge>
        )}
        {l.suspectedSpam && <Badge tone="warning">{o.leads.spam}</Badge>}
        {l.erased && <Badge>{o.leads.erased}</Badge>}
      </div>

      <Section title={o.leads.contact.contact}>
        <p className="text-xs text-silver-500">{o.leads.noContactHint}</p>
        {can('lead.contact.reveal') ? (
          <>
            {!l.erased && <ContactReveal leadId={l.id} />}
            <NotesReveal leadId={l.id} />
          </>
        ) : (
          <NoPermission />
        )}
      </Section>

      <Section title={o.common.links}>
        <Row label={o.leads.received}>
          <DateText iso={l.receivedAt} time />
        </Row>
        <Row label={o.leads.contactDue}>
          {l.contactDueAt ? (
            <DateText iso={l.contactDueAt} time />
          ) : (
            o.leads.contactDueUnknown
          )}
        </Row>
        <Row label={o.leads.contact.method}>
          {o.leads.contactMethods[l.contactMethod]}
        </Row>
        <Row label={o.leads.budgetRange}>
          {l.budgetRange ?? o.common.unknown}
        </Row>
        <Row label={o.leads.selfReported}>
          {l.selfReportedChannel ?? o.common.unknown}
        </Row>
        <Row label={o.leads.responsible}>
          {l.responsibleDisplayName ?? l.responsibleMemberId ?? o.common.nobody}
        </Row>
        {l.contentId && (
          <Row label={o.traffic.contentId}>
            <RecordLink section="materials" id={l.contentId}>
              {l.contentId}
            </RecordLink>
          </Row>
        )}
        {l.placementId && (
          <Row label={o.traffic.placementId}>
            <RecordLink section="purchases" id={l.placementId}>
              {l.placementId}
            </RecordLink>
          </Row>
        )}
        {l.duplicateOfLeadId && (
          <Row label={o.leads.duplicate}>
            <RecordLink section="leads" id={l.duplicateOfLeadId}>
              {l.duplicateOfLeadId}
            </RecordLink>
          </Row>
        )}
        {l.possibleDuplicates.length > 0 && (
          <Row label={o.leads.possibleDuplicates}>
            {l.possibleDuplicates.map((d) => (
              <span key={d} className="mr-2">
                <RecordLink section="leads" id={d}>
                  {d}
                </RecordLink>
              </span>
            ))}
          </Row>
        )}
      </Section>

      <Section title={o.leads.attribution}>
        {!l.enriched ? (
          <Alert tone="warning">{o.leads.notEnriched}</Alert>
        ) : !l.attribution || l.attribution.coverage === 'unknown' ? (
          <Alert tone="warning">{o.leads.attrUnknown}</Alert>
        ) : null}
        {l.attribution &&
          (['last', 'first'] as const).map((k) => {
            const a = l.attribution?.[k];
            return (
              <Row
                key={k}
                label={k === 'last' ? o.leads.attrLast : o.leads.attrFirst}
              >
                {a ? (
                  <>
                    {o.leads.channelGroups[a.group]}
                    {a.source ? ` · ${a.source}` : ''} ·{' '}
                    <DateText iso={a.at} time />
                    {a.placementId && (
                      <>
                        {' · '}
                        <RecordLink section="purchases" id={a.placementId}>
                          {a.placementId}
                        </RecordLink>
                      </>
                    )}
                  </>
                ) : (
                  o.common.unknown
                )}
              </Row>
            );
          })}
      </Section>

      {manage ? (
        <Section title={o.leads.transition}>
          <TransitionForm l={l} onChange={onChange} reload={reload} />
          <AssignForm l={l} onChange={onChange} reload={reload} />
          <DuplicateForm l={l} onChange={onChange} reload={reload} />
          <ProspectForm l={l} onChange={onChange} reload={reload} />
        </Section>
      ) : null}
      {can('lead.test_flag') && (
        <TestFlagForm l={l} onChange={onChange} reload={reload} />
      )}

      <Section title={o.leads.decisions}>
        {l.decisions.length === 0 ? (
          <div className="text-sm text-silver-500">
            {o.leads.decisionsEmpty}
          </div>
        ) : (
          <ul className="text-sm space-y-1">
            {l.decisions.map((d) => (
              <li key={d.id}>
                <DateText iso={d.decidedAt} time /> ·{' '}
                {o.leads.statuses[d.fromStatus]} →{' '}
                {o.leads.statuses[d.toStatus]}
                {d.reasonCode
                  ? ` · ${o.leads.reasonCodes[d.reasonCode as keyof typeof o.leads.reasonCodes] ?? d.reasonCode}`
                  : ''}
                {d.hasNote ? ` · ${o.leads.hasNote}` : ''}
                {d.confirmedInterestAt && (
                  <>
                    {' · '}
                    {o.leads.confirmedInterestAt}:{' '}
                    <DateText iso={d.confirmedInterestAt} />
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={o.leads.prospectLinks}>
        {l.prospectLinks.length === 0 ? (
          <div className="text-sm text-silver-500">{o.leads.notEnriched}</div>
        ) : (
          <ul className="text-sm space-y-1">
            {l.prospectLinks.map((p, i) => (
              <li key={`${p.prospectId}:${i}`}>
                <DateText iso={p.validFrom} time /> · {p.prospectCode} ·{' '}
                {o.leads.linkReasons[
                  p.reason as keyof typeof o.leads.linkReasons
                ] ?? p.reason}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={o.leads.delivery}>
        {l.outbox && (
          <Row label={o.leads.outbox}>
            <StatusBadge
              status={l.outbox.status}
              labels={o.notifications.outboxStatuses}
            />{' '}
            {fmtText(o.notifications.attempts, { n: l.outbox.attempts })}
            {l.outbox.lastErrorCode ? ` · ${l.outbox.lastErrorCode}` : ''}
          </Row>
        )}
        {l.notifications.map((n) => (
          <Row
            key={n.id}
            label={
              o.notifications.kinds[
                n.kind as keyof typeof o.notifications.kinds
              ] ?? n.kind
            }
          >
            <StatusBadge status={n.status} labels={o.notifications.statuses} />
          </Row>
        ))}
      </Section>

      <RetentionBlock l={l} onChange={onChange} reload={reload} />
    </div>
  );
}

/**
 * Раскрытие контакта: GET с целью (аудит на сервере), результат — только
 * в состоянии этого компонента и только на время показа: таймер, «скрыть»
 * и уход с экрана стирают его. В хранилище и кэш не пишется.
 */
function ContactReveal({ leadId }: { leadId: string }) {
  const { o, leads, pid } = useOps();
  const [purpose, setPurpose] = useState<ContactPurpose | ''>('');
  // Раскрытое — только с id заявки и сроком показа: другая заявка или
  // истёкший срок — не показывается и стирается (`revealedFor`).
  const [rev, setRev] = useState<Revealed<LeadContactView> | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const shown = revealedFor(rev, leadId, now);
  useEffect(() => {
    if (!rev) return;
    if (!shown) {
      setRev(null);
      return;
    }
    const t = setTimeout(() => setNow(Date.now()), 1000);
    return () => clearTimeout(t);
  }, [rev, shown, now]);
  const left = rev ? Math.max(0, Math.ceil((rev.until - now) / 1000)) : 0;
  const setShown = (v: null) => setRev(v);

  if (shown) {
    return (
      <div className="space-y-1" data-revealed="">
        <Row label={o.leads.contact.name}>{shown.name}</Row>
        <Row label={o.leads.contact.method}>
          {o.leads.contactMethods[shown.contactMethod]}
        </Row>
        <Row label={o.leads.contact.contact}>
          <span className="select-all">{shown.contact}</span>
        </Row>
        {shown.business && (
          <Row label={o.leads.contact.business}>{shown.business}</Row>
        )}
        <Row label={o.leads.contact.task}>
          <span className="whitespace-pre-wrap">{shown.task}</span>
        </Row>
        {shown.selfReported && (
          <Row label={o.leads.contact.selfReported}>{shown.selfReported}</Row>
        )}
        <Row label={o.leads.dataNotice}>
          {!shown.dataNotice ? (
            <span className="text-amber-700 dark:text-amber-400">
              {o.leads.dataNoticeUnknown}
            </span>
          ) : shown.dataNotice.matches ? (
            fmtText(o.leads.dataNoticeOk, { v: shown.dataNotice.version })
          ) : (
            <span className="text-amber-700 dark:text-amber-400">
              {fmtText(o.leads.dataNoticeMismatch, {
                v: shown.dataNotice.version,
                expected: shown.dataNotice.expected ?? o.common.unknown,
              })}
            </span>
          )}
        </Row>
        <div className="text-xs text-silver-500">
          {fmtText(o.leads.revealAuto, { sec: left })}
        </div>
        <Button variant="outline" onClick={() => setShown(null)}>
          {o.leads.revealHidden}
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <Field label={o.leads.revealPurpose}>
        <Select
          value={purpose}
          options={CONTACT_PURPOSES}
          labels={o.leads.purposes}
          empty={o.common.choose}
          onChange={setPurpose}
        />
      </Field>
      <PubErrorAlert error={error} />
      <Button
        loading={busy}
        disabled={!purpose}
        onClick={async () => {
          if (!purpose) return;
          setBusy(true);
          setError(null);
          try {
            const c = await leads.revealContact(pid, leadId, purpose);
            if (!alive.current) return;
            const t0 = Date.now();
            setNow(t0);
            setRev({
              leadId,
              value: c,
              until: t0 + CONTACT_SHOW_SECONDS * 1000,
            });
            setPurpose('');
          } catch (e) {
            if (alive.current) setError(e);
          } finally {
            if (alive.current) setBusy(false);
          }
        }}
      >
        {o.leads.reveal}
      </Button>
    </div>
  );
}

/** Заметки решений и проспекта: так же — только на время показа. */
function NotesReveal({ leadId }: { leadId: string }) {
  const { o, leads, pid } = useOps();
  const [shown, setShown] = useState<LeadNotesView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(() => setShown(null), CONTACT_SHOW_SECONDS * 1000);
    return () => clearTimeout(t);
  }, [shown]);
  useEffect(() => setShown(null), [leadId]);
  if (shown) {
    return (
      <div className="space-y-1">
        {shown.decisions.length === 0 && !shown.prospect && (
          <div className="text-sm text-silver-500">{o.leads.notesEmpty}</div>
        )}
        {shown.decisions.map((d) => (
          <Row
            key={d.decisionId}
            label={fmtText(o.leads.noteFor, {
              status: o.leads.statuses[d.toStatus],
            })}
          >
            <span className="whitespace-pre-wrap">{d.note}</span>
          </Row>
        ))}
        {shown.prospect && (
          <Row label={o.leads.prospectNote}>
            <span className="whitespace-pre-wrap">{shown.prospect.note}</span>
          </Row>
        )}
        <Button variant="outline" onClick={() => setShown(null)}>
          {o.leads.notesHidden}
        </Button>
      </div>
    );
  }
  return (
    <div>
      <PubErrorAlert error={error} />
      <Button
        variant="outline"
        loading={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            setShown(await leads.revealNotes(pid, leadId));
          } catch (e) {
            setError(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        {o.leads.notes}
      </Button>
    </div>
  );
}

type FormProps = {
  l: LeadCardView;
  onChange: (l: LeadCardView) => void;
  reload: () => void;
};

function TransitionForm({ l, onChange, reload }: FormProps) {
  const { o, leads, pid } = useOps();
  const m = useMutation();
  const targets = leadTargets(l.status);
  const [to, setTo] = useState<LeadStatus | ''>('');
  const [reasonCode, setReasonCode] = useState<
    (typeof LEAD_REASON_CODES)[number] | ''
  >('');
  const [note, setNote] = useState('');
  const [interest, setInterest] = useState('');
  if (targets.length === 0) return null;
  const needsReason = !!to && transitionNeedsReason(l.status, to);
  return (
    <ActionBlock title={o.leads.transition} defaultOpen>
      <Field label={o.leads.to}>
        <Select
          value={to}
          options={targets}
          labels={o.leads.statuses}
          empty={o.common.choose}
          onChange={setTo}
        />
      </Field>
      {to === 'qualified' && (
        <>
          <p className="text-xs text-silver-500">{o.leads.qualifyHint}</p>
          <Field label={o.leads.confirmedInterestAt}>
            <TextInput
              type="datetime-local"
              value={interest}
              onChange={setInterest}
            />
          </Field>
        </>
      )}
      {(needsReason || to === 'rejected' || to === 'lost') && (
        <Field label={o.leads.reasonCode}>
          <Select
            value={reasonCode}
            options={LEAD_REASON_CODES}
            labels={o.leads.reasonCodes}
            empty={o.common.choose}
            onChange={setReasonCode}
          />
        </Field>
      )}
      <Field label={o.leads.note} hint={o.common.hintPii}>
        <TextArea value={note} onChange={setNote} maxLength={2000} />
      </Field>
      <PubErrorAlert error={m.error} onReload={reload} />
      <Button
        loading={m.busy}
        disabled={
          !to ||
          (needsReason && !reasonCode) ||
          (to === 'qualified' && !localToIso(interest))
        }
        onClick={async () => {
          if (!to) return;
          const x = await m.run((k) =>
            leads.transition(pid, l.id, k, {
              expectedRevision: l.revision,
              to,
              ...(reasonCode ? { reasonCode } : {}),
              ...(note.trim() ? { note: note.trim() } : {}),
              ...(to === 'qualified' && localToIso(interest)
                ? { confirmedInterestAt: localToIso(interest) as string }
                : {}),
            })
          );
          if (x) {
            // Текст заметки после отправки не держим: он только в шифре сервера.
            setNote('');
            onChange(x);
          }
        }}
      >
        {o.leads.transition}
      </Button>
    </ActionBlock>
  );
}

function AssignForm({ l, onChange, reload }: FormProps) {
  const { o, leads, pid } = useOps();
  const m = useMutation();
  const [who, setWho] = useState(l.responsibleMemberId ?? '');
  return (
    <ActionBlock title={o.leads.assign}>
      <MemberPicker value={who} onChange={setWho} allowNone />
      <PubErrorAlert error={m.error} onReload={reload} />
      <Button
        loading={m.busy}
        disabled={(who || null) === l.responsibleMemberId}
        onClick={async () => {
          const x = await m.run((k) =>
            leads.assign(pid, l.id, k, {
              expectedRevision: l.revision,
              responsibleMemberId: who || null,
            })
          );
          if (x) onChange(x);
        }}
      >
        {o.leads.assign}
      </Button>
    </ActionBlock>
  );
}

function TestFlagForm({ l, onChange, reload }: FormProps) {
  const { o, leads, pid } = useOps();
  const m = useMutation();
  const [reason, setReason] = useState('');
  const [testReason, setTestReason] = useState<'team' | 'manual'>('manual');
  return (
    <Section title={o.leads.testFlag}>
      {!l.testFlag && (
        <Field label={o.common.reason}>
          <Select
            value={testReason}
            options={['team', 'manual'] as const}
            labels={o.leads.testReasons}
            onChange={(v) => v && setTestReason(v)}
          />
        </Field>
      )}
      <Field label={o.common.basis} hint={o.common.hintPii}>
        <TextInput value={reason} onChange={setReason} />
      </Field>
      <PubErrorAlert error={m.error} onReload={reload} />
      <Button
        variant="outline"
        loading={m.busy}
        disabled={!reason.trim()}
        onClick={async () => {
          const x = await m.run((k) =>
            leads.testFlag(pid, l.id, k, {
              expectedRevision: l.revision,
              testFlag: !l.testFlag,
              ...(!l.testFlag ? { testReason } : {}),
              reason: reason.trim(),
            })
          );
          if (x) {
            setReason('');
            onChange(x);
          }
        }}
      >
        {l.testFlag ? o.leads.testFlagOff : o.leads.testFlagOn}
      </Button>
    </Section>
  );
}

function DuplicateForm({ l, onChange, reload }: FormProps) {
  const { o, leads, pid } = useOps();
  const m = useMutation();
  const [of, setOf] = useState(l.duplicateOfLeadId ?? '');
  const [reason, setReason] = useState('');
  return (
    <ActionBlock title={o.leads.duplicate}>
      <Field label={o.leads.duplicateOf}>
        <TextInput value={of} onChange={(v) => setOf(v.trim())} />
      </Field>
      <Field label={o.common.reason} hint={o.common.hintPii}>
        <TextInput value={reason} onChange={setReason} />
      </Field>
      <PubErrorAlert error={m.error} onReload={reload} />
      <Button
        loading={m.busy}
        disabled={!reason.trim()}
        onClick={async () => {
          const x = await m.run((k) =>
            leads.duplicate(pid, l.id, k, {
              expectedRevision: l.revision,
              duplicateOfLeadId: of || null,
              reason: reason.trim(),
            })
          );
          if (x) onChange(x);
        }}
      >
        {o.leads.duplicate}
      </Button>
    </ActionBlock>
  );
}

function ProspectForm({ l, onChange, reload }: FormProps) {
  const { o, leads, pid } = useOps();
  const m = useMutation();
  const [prospectId, setProspectId] = useState('');
  const [reason, setReason] = useState('');
  return (
    <ActionBlock title={o.leads.prospectSet}>
      <Field label={o.leads.prospect} hint={o.leads.prospectNew}>
        <TextInput
          value={prospectId}
          onChange={(v) => setProspectId(v.trim())}
        />
      </Field>
      <Field label={o.common.reason} hint={o.common.hintPii}>
        <TextInput value={reason} onChange={setReason} />
      </Field>
      <PubErrorAlert error={m.error} onReload={reload} />
      <Button
        loading={m.busy}
        disabled={!prospectId || !reason.trim()}
        onClick={async () => {
          const x = await m.run((k) =>
            leads.setProspect(pid, l.id, k, {
              expectedRevision: l.revision,
              prospectId,
              reason: reason.trim(),
            })
          );
          if (x) onChange(x);
        }}
      >
        {o.leads.prospectSet}
      </Button>
    </ActionBlock>
  );
}

function RetentionBlock({ l, onChange, reload }: FormProps) {
  const { o, leads, pid, can } = useOps();
  const m = useMutation();
  const [basis, setBasis] = useState('');
  const [next, setNext] = useState('');
  return (
    <Section title={o.leads.retention}>
      <Row label={o.leads.reviewDue}>
        <DateText iso={l.reviewDueAt} />
      </Row>
      <Row label={o.leads.retentionBasis}>
        {l.retentionBasis ?? o.common.unknown}
      </Row>
      {l.erasedAt && (
        <Row label={o.leads.erased}>
          <DateText iso={l.erasedAt} time />
        </Row>
      )}
      {can('retention.manage') && !l.erased && (
        <>
          <Field label={o.common.basis} hint={o.common.hintPii}>
            <TextInput value={basis} onChange={setBasis} />
          </Field>
          <Field label={o.leads.nextReviewAt}>
            <TextInput type="date" value={next} onChange={setNext} />
          </Field>
          <PubErrorAlert error={m.error} onReload={reload} />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              loading={m.busy}
              disabled={!basis.trim() || !next}
              onClick={async () => {
                const body = {
                  expectedRevision: l.revision,
                  basis: basis.trim(),
                  nextReviewAt: new Date(`${next}T12:00:00Z`).toISOString(),
                };
                const x = await m.run(
                  (k) => leads.retain(pid, l.id, k, body),
                  JSON.stringify(['retain', body])
                );
                if (x) onChange(x);
              }}
            >
              {o.leads.retain}
            </Button>
            <ConfirmButton
              loading={m.busy}
              disabled={!basis.trim()}
              onConfirm={async () => {
                const body = {
                  expectedRevision: l.revision,
                  basis: basis.trim(),
                };
                const x = await m.run(
                  (k) => leads.erase(pid, l.id, k, body),
                  JSON.stringify(['erase', body])
                );
                if (x) onChange(x);
              }}
            >
              {o.leads.erase}
            </ConfirmButton>
          </div>
          <p className="text-xs text-silver-500">{o.leads.eraseHint}</p>
        </>
      )}
    </Section>
  );
}

// ── Проспекты ────────────────────────────────────────────────────────────

function Prospects() {
  const { o, leads, pid } = useOps();
  const page = usePaged((before) => leads.prospects(pid, before), [pid]);
  const m = useMutation();
  const [flags, setFlags] = useState({
    isExternal: true,
    isTeamOrPartner: false,
    prior: 'unknown' as PriorExternalPayment,
  });
  const [note, setNote] = useState('');
  const [merge, setMerge] = useState({ fromId: '', intoId: '', reason: '' });
  return (
    <>
      <Section title={o.leads.tabs.prospects}>
        <ul>
          {page.items.map((p) => (
            <ProspectRow
              key={p.id}
              p={p}
              onSaved={(x) => page.replace((y) => y.id === x.id, x)}
            />
          ))}
        </ul>
        <PagedFooter page={page} empty={o.prospects.empty} />
      </Section>
      <Section title={o.prospects.create}>
        <ProspectFlags value={flags} onChange={setFlags} />
        <Field label={o.prospects.note} hint={o.common.hintPii}>
          <TextArea value={note} onChange={setNote} maxLength={2000} />
        </Field>
        <PubErrorAlert error={m.error} />
        <Button
          loading={m.busy}
          onClick={async () => {
            const x = await m.run((k) =>
              leads.createProspect(pid, k, {
                isExternal: flags.isExternal,
                isTeamOrPartner: flags.isTeamOrPartner,
                priorExternalPayment: flags.prior,
                ...(note.trim() ? { note: note.trim() } : {}),
              })
            );
            if (x) {
              setNote('');
              page.reload();
            }
          }}
        >
          {o.prospects.create}
        </Button>
      </Section>
      <Section title={o.prospects.merge}>
        <Field label={o.prospects.fromId}>
          <TextInput
            value={merge.fromId}
            onChange={(v) => setMerge({ ...merge, fromId: v.trim() })}
          />
        </Field>
        <Field label={o.prospects.intoId}>
          <TextInput
            value={merge.intoId}
            onChange={(v) => setMerge({ ...merge, intoId: v.trim() })}
          />
        </Field>
        <Field label={o.common.reason} hint={o.common.hintPii}>
          <TextInput
            value={merge.reason}
            onChange={(v) => setMerge({ ...merge, reason: v })}
          />
        </Field>
        <MergeButton merge={merge} onDone={page.reload} />
      </Section>
    </>
  );
}

function MergeButton({
  merge,
  onDone,
}: {
  merge: { fromId: string; intoId: string; reason: string };
  onDone: () => void;
}) {
  const { o, leads, pid } = useOps();
  const m = useMutation();
  return (
    <>
      <PubErrorAlert error={m.error} />
      <ConfirmButton
        variant="outline"
        loading={m.busy}
        disabled={
          !merge.fromId ||
          !merge.intoId ||
          merge.fromId === merge.intoId ||
          !merge.reason.trim()
        }
        onConfirm={async () => {
          const x = await m.run((k) =>
            leads.mergeProspects(pid, k, {
              fromId: merge.fromId,
              intoId: merge.intoId,
              reason: merge.reason.trim(),
            })
          );
          if (x) onDone();
        }}
      >
        {o.prospects.merge}
      </ConfirmButton>
    </>
  );
}

function ProspectFlags({
  value,
  onChange,
}: {
  value: {
    isExternal: boolean;
    isTeamOrPartner: boolean;
    prior: PriorExternalPayment;
  };
  onChange: (v: {
    isExternal: boolean;
    isTeamOrPartner: boolean;
    prior: PriorExternalPayment;
  }) => void;
}) {
  const { o } = useOps();
  return (
    <>
      <label className="flex items-center gap-2 text-sm min-h-[36px]">
        <input
          type="checkbox"
          checked={value.isExternal}
          onChange={(e) => onChange({ ...value, isExternal: e.target.checked })}
        />
        {o.prospects.external}
      </label>
      <label className="flex items-center gap-2 text-sm min-h-[36px]">
        <input
          type="checkbox"
          checked={value.isTeamOrPartner}
          onChange={(e) =>
            onChange({ ...value, isTeamOrPartner: e.target.checked })
          }
        />
        {o.prospects.teamOrPartner}
      </label>
      <Field label={o.prospects.priorPayment}>
        <Select
          value={value.prior}
          options={PRIOR_EXTERNAL_PAYMENT}
          labels={o.prospects.prior}
          onChange={(v) => v && onChange({ ...value, prior: v })}
        />
      </Field>
    </>
  );
}

function ProspectRow({
  p,
  onSaved,
}: {
  p: ProspectView;
  onSaved: (p: ProspectView) => void;
}) {
  const { o, leads, pid } = useOps();
  const m = useMutation();
  const [flags, setFlags] = useState({
    isExternal: p.isExternal,
    isTeamOrPartner: p.isTeamOrPartner,
    prior: p.priorExternalPayment,
  });
  const [note, setNote] = useState('');
  const save = async (extra: { note?: string | null }) => {
    const x = await m.run((k) =>
      leads.updateProspect(pid, p.id, k, {
        expectedRevision: p.revision,
        isExternal: flags.isExternal,
        isTeamOrPartner: flags.isTeamOrPartner,
        priorExternalPayment: flags.prior,
        ...extra,
      })
    );
    if (x) {
      setNote('');
      onSaved(x);
    }
  };
  return (
    <ListRow
      title={p.code}
      badges={
        <>
          {p.isExternal ? <Badge>{o.prospects.external}</Badge> : null}
          {p.isTeamOrPartner ? (
            <Badge tone="warning">{o.prospects.teamOrPartner}</Badge>
          ) : null}
          <Badge
            tone={p.priorExternalPayment === 'unknown' ? 'warning' : 'neutral'}
          >
            {o.prospects.priorPayment}:{' '}
            {o.prospects.prior[p.priorExternalPayment]}
          </Badge>
          {p.hasNote && <Badge>{o.leads.hasNote}</Badge>}
        </>
      }
    >
      {p.mergedIntoId && (
        <div>{fmtText(o.prospects.merged, { id: p.mergedIntoId })}</div>
      )}
      <div>
        {fmtText(o.prospects.leads, { n: p.leadIds.length })}{' '}
        {p.leadIds.slice(0, 5).map((id) => (
          <span key={id} className="mr-1">
            <RecordLink section="leads" id={id}>
              {id.slice(-6)}
            </RecordLink>
          </span>
        ))}
        <RecordLink
          section="leads"
          query={{ tab: 'payments', prospectId: p.id }}
        >
          {o.leads.tabs.payments}
        </RecordLink>
      </div>
      <ActionBlock title={o.prospects.edit}>
        <ProspectFlags value={flags} onChange={setFlags} />
        <Field label={o.prospects.note} hint={o.common.hintPii}>
          <TextArea value={note} onChange={setNote} maxLength={2000} />
        </Field>
        <PubErrorAlert error={m.error} />
        <div className="flex flex-wrap gap-2">
          <Button
            loading={m.busy}
            onClick={() => void save(note.trim() ? { note: note.trim() } : {})}
          >
            {o.prospects.edit}
          </Button>
          {p.hasNote && (
            <ConfirmButton
              variant="outline"
              loading={m.busy}
              onConfirm={() => void save({ note: null })}
            >
              {o.prospects.clearNote}
            </ConfirmButton>
          )}
        </div>
      </ActionBlock>
    </ListRow>
  );
}

// ── Оплаты клиентов ──────────────────────────────────────────────────────

function Payments({ query }: { query: PublisherSectionProps['query'] }) {
  const { o, leads, pid } = useOps();
  const prospectId = query.prospectId ?? '';
  const [summary, setSummary] = useState<PaymentsPage['summary'] | null>(null);
  const page = usePaged(
    async (before) => {
      const pg = await leads.payments(pid, {
        prospectId: prospectId || undefined,
        before,
      });
      if (!before) setSummary(pg.summary);
      return pg;
    },
    [pid, prospectId]
  );
  return (
    <>
      {summary && (
        <>
          <Alert tone={summary.commercialValidation ? 'success' : 'warning'}>
            {summary.commercialValidation
              ? o.payments.commercialOk
              : o.payments.commercialNo}
          </Alert>
          <Section title={o.payments.revenue}>
            {Object.keys(summary.revenueByCurrency).length === 0 ? (
              <div className="text-sm text-silver-500">
                {o.reports.revenueEmpty}
              </div>
            ) : (
              Object.entries(summary.revenueByCurrency).map(([c, v]) => (
                <div key={c} className="text-sm">
                  <MoneyText minor={v} currency={c} />
                </div>
              ))
            )}
            {Object.keys(summary.nonRevenueCount).length > 0 && (
              <div className="text-xs text-silver-500">
                {fmtText(o.payments.nonRevenue, {
                  list: Object.entries(summary.nonRevenueCount)
                    .map(([k, n]) => `${nonRevenueLabel(o, k)}: ${n}`)
                    .join(', '),
                })}
              </div>
            )}
          </Section>
        </>
      )}
      <Section title={o.leads.tabs.payments}>
        {prospectId && (
          <div className="text-xs text-silver-500">
            {o.payments.prospectId}: {prospectId}
          </div>
        )}
        <ul>
          {page.items.map((p) => (
            <PaymentRow key={p.id} p={p} onChanged={page.reload} />
          ))}
        </ul>
        <PagedFooter page={page} empty={o.payments.empty} />
      </Section>
      <CreatePayment prospectId={prospectId} onDone={page.reload} />
    </>
  );
}

function nonRevenueLabel(o: ReturnType<typeof useOps>['o'], k: string): string {
  const maps: Array<Record<string, string>> = [
    o.payments.payerKinds,
    o.payments.recordTypes,
    o.payments.statuses,
  ];
  for (const m of maps) {
    if (Object.prototype.hasOwnProperty.call(m, k)) return m[k];
  }
  return k;
}

function PaymentRow({
  p,
  onChanged,
}: {
  p: PaymentView;
  onChanged: () => void;
}) {
  const { o, leads, pid } = useOps();
  const m = useMutation();
  const [confirmation, setConfirmation] = useState('');
  const step = async (s: 'confirm' | 'refund' | 'cancel') => {
    const body =
      s === 'confirm' && confirmation.trim()
        ? { confirmation: confirmation.trim() }
        : {};
    const x = await m.run(
      (k) => leads.paymentStep(pid, p.id, s, k, body),
      JSON.stringify([s, body])
    );
    if (x) onChanged();
  };
  return (
    <ListRow
      title={
        <>
          {o.payments.recordTypes[p.recordType]} ·{' '}
          <MoneyText minor={p.amountMinor} currency={p.currency} />
        </>
      }
      badges={
        <>
          <StatusBadge status={p.status} labels={o.payments.statuses} />
          <Badge>{o.payments.payerKinds[p.payerKind]}</Badge>
          <Badge tone={p.revenue ? 'success' : 'neutral'}>
            {p.revenue ? o.payments.isRevenue : o.payments.notRevenue}
          </Badge>
          <Badge tone={p.isNewCustomer === 'unknown' ? 'warning' : 'neutral'}>
            {o.payments.newCustomer}: {o.prospects.prior[p.isNewCustomer]}
          </Badge>
        </>
      }
    >
      <div>
        <DateText iso={p.occurredAt} /> · {p.paymentRef}
        {p.confirmation ? ` · ${p.confirmation}` : ''}
      </div>
      <div>
        {o.payments.prospectId}: {p.prospectId}
        {p.leadId && (
          <>
            {' · '}
            <RecordLink section="leads" id={p.leadId}>
              {p.leadId}
            </RecordLink>
          </>
        )}
      </div>
      {p.status === 'pending' && (
        <div className="space-y-1 pt-1">
          <TextInput
            value={confirmation}
            placeholder={o.payments.confirmation}
            onChange={setConfirmation}
          />
          <div className="flex flex-wrap gap-2">
            <Button loading={m.busy} onClick={() => void step('confirm')}>
              {o.payments.confirm}
            </Button>
            <ConfirmButton
              variant="outline"
              loading={m.busy}
              onConfirm={() => void step('cancel')}
            >
              {o.payments.cancel}
            </ConfirmButton>
          </div>
        </div>
      )}
      {p.status === 'confirmed' && p.recordType === 'payment_received' && (
        <ConfirmButton
          variant="outline"
          loading={m.busy}
          onConfirm={() => void step('refund')}
        >
          {o.payments.refund}
        </ConfirmButton>
      )}
      <PubErrorAlert error={m.error} onReload={onChanged} />
    </ListRow>
  );
}

function CreatePayment({
  prospectId,
  onDone,
}: {
  prospectId: string;
  onDone: () => void;
}) {
  const { o, leads, pid } = useOps();
  const m = useMutation();
  const [v, setV] = useState({
    prospectId,
    leadId: '',
    recordType: 'payment_received' as (typeof PAYMENT_RECORD_TYPES)[number],
    payerKind: 'external' as (typeof PAYER_KINDS)[number],
    currency: 'UAH',
    occurredAt: '',
    paymentRef: '',
    confirmation: '',
  });
  const [amt, setAmt] = useState({ raw: '', minor: null as string | null });
  return (
    <Section title={o.payments.create}>
      <Field label={o.payments.prospectId}>
        <TextInput
          value={v.prospectId}
          onChange={(x) => setV({ ...v, prospectId: x.trim() })}
        />
      </Field>
      <Field label={o.payments.leadId}>
        <TextInput
          value={v.leadId}
          onChange={(x) => setV({ ...v, leadId: x.trim() })}
        />
      </Field>
      <Field label={o.budget.entryKind}>
        <Select
          value={v.recordType}
          options={PAYMENT_RECORD_TYPES}
          labels={o.payments.recordTypes}
          onChange={(x) => x && setV({ ...v, recordType: x })}
        />
      </Field>
      <Field label={o.payments.payerKinds.external}>
        <Select
          value={v.payerKind}
          options={PAYER_KINDS}
          labels={o.payments.payerKinds}
          onChange={(x) => x && setV({ ...v, payerKind: x })}
        />
      </Field>
      <Field label={o.common.currency}>
        <TextInput
          value={v.currency}
          onChange={(x) => setV({ ...v, currency: x.toUpperCase() })}
          maxLength={3}
        />
      </Field>
      <Field label={o.common.amount}>
        <MoneyInput
          value={amt.raw}
          onChange={(raw, minor) => setAmt({ raw, minor })}
        />
      </Field>
      <Field label={o.budget.occurredAt}>
        <TextInput
          type="datetime-local"
          value={v.occurredAt}
          onChange={(x) => setV({ ...v, occurredAt: x })}
        />
      </Field>
      <Field label={o.payments.paymentRef}>
        <TextInput
          value={v.paymentRef}
          onChange={(x) => setV({ ...v, paymentRef: x })}
        />
      </Field>
      <Field label={o.payments.confirmation}>
        <TextInput
          value={v.confirmation}
          onChange={(x) => setV({ ...v, confirmation: x })}
        />
      </Field>
      <PubErrorAlert error={m.error} />
      <Button
        loading={m.busy}
        disabled={
          !v.prospectId ||
          !amt.minor ||
          !localToIso(v.occurredAt) ||
          !v.paymentRef.trim() ||
          !/^[A-Z]{3}$/.test(v.currency)
        }
        onClick={async () => {
          if (!amt.minor) return;
          const x = await m.run((k) =>
            leads.createPayment(pid, k, {
              prospectId: v.prospectId,
              leadId: v.leadId || null,
              recordType: v.recordType,
              payerKind: v.payerKind,
              amountMinor: amt.minor as string,
              currency: v.currency,
              occurredAt: localToIso(v.occurredAt) as string,
              paymentRef: v.paymentRef.trim(),
              confirmation: v.confirmation.trim() || null,
            })
          );
          if (x) {
            setAmt({ raw: '', minor: null });
            onDone();
          }
        }}
      >
        {o.payments.create}
      </Button>
    </Section>
  );
}

// ── Хранение и уведомления ───────────────────────────────────────────────

function Retention() {
  const { o, leads, pid } = useOps();
  const state = useAsync(() => leads.retentionDue(pid), [pid]);
  return (
    <Section title={o.leads.tabs.retention}>
      <Loadable state={state}>
        {(list) =>
          list.length === 0 ? (
            <div className="text-sm text-silver-500">
              {o.leads.retentionEmpty}
            </div>
          ) : (
            <ul>
              {list.map((r) => (
                <ListRow
                  key={r.leadId}
                  title={
                    <RecordLink section="leads" id={r.leadId}>
                      {r.publicRef}
                    </RecordLink>
                  }
                  badges={
                    <>
                      <StatusBadge
                        status={r.status}
                        labels={o.leads.statuses}
                      />
                      {r.overdue && (
                        <Badge tone="danger">{o.leads.reviewDue}</Badge>
                      )}
                    </>
                  }
                >
                  {o.leads.reviewDue}: <DateText iso={r.reviewDueAt} /> ·{' '}
                  {o.leads.retentionBasis}:{' '}
                  {r.retentionBasis ?? o.common.unknown}
                </ListRow>
              ))}
            </ul>
          )
        }
      </Loadable>
    </Section>
  );
}

function Notifications({ query }: { query: PublisherSectionProps['query'] }) {
  const { o, leads, pid } = useOps();
  const f = useListFilters('leads', query, ['tab', 'status']);
  const page = usePaged(
    (before) => leads.notifications(pid, f.values.status || undefined, before),
    [pid, f.values.status]
  );
  const outbox = usePaged(
    (before) => leads.outbox(pid, undefined, before),
    [pid]
  );
  const m = useMutation();
  return (
    <>
      <ListToolbar
        statuses={NOTIFICATION_STATUSES}
        status={f.values.status}
        onStatus={(v) => f.set('status', v)}
        statusLabels={o.notifications.statuses}
      />
      <PubErrorAlert error={m.error} />
      <Section title={o.leads.tabs.notifications}>
        <ul>
          {page.items.map((n) => (
            <ListRow
              key={n.id}
              title={
                <RecordLink section="leads" id={n.leadId}>
                  {n.leadRef}
                </RecordLink>
              }
              badges={
                <>
                  <Badge>{o.notifications.kinds[n.kind]}</Badge>
                  <StatusBadge
                    status={n.status}
                    labels={o.notifications.statuses}
                  />
                </>
              }
            >
              <div>
                {fmtText(o.notifications.attempts, { n: n.attempts })}
                {n.lastErrorCode ? ` · ${n.lastErrorCode}` : ''} ·{' '}
                <DateText iso={n.createdAt} time />
              </div>
              {(n.status === 'failed' || n.status === 'dead') && (
                <Button
                  variant="outline"
                  loading={m.busy}
                  onClick={async () => {
                    const x = await m.run(
                      (k) => leads.retryNotification(pid, n.id, k),
                      `retry:${n.id}`
                    );
                    if (x) page.replace((y) => y.id === x.id, x);
                  }}
                >
                  {o.notifications.retry}
                </Button>
              )}
            </ListRow>
          ))}
        </ul>
        <PagedFooter page={page} empty={o.notifications.empty} />
      </Section>
      <Section title={o.notifications.outboxTitle}>
        <ul>
          {outbox.items.map((x) => (
            <ListRow
              key={x.id}
              title={
                <RecordLink section="leads" id={x.leadId}>
                  {x.leadRef}
                </RecordLink>
              }
              badges={
                <StatusBadge
                  status={x.status}
                  labels={o.notifications.outboxStatuses}
                />
              }
            >
              {fmtText(o.notifications.attempts, { n: x.attempts })}
              {x.lastErrorCode ? ` · ${x.lastErrorCode}` : ''}
            </ListRow>
          ))}
        </ul>
        <PagedFooter page={outbox} empty={o.notifications.outboxEmpty} />
      </Section>
    </>
  );
}
