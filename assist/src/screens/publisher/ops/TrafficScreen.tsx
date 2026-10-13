/**
 * F11 — паспорт трафика (P-G2, §14.1 `traffic`): публикация → сессии →
 * события → заявки обезличенно; покрытие, неизвестные отдельно; прямой и
 * продуктовый CPL рядом (`not_computable` с числителем, AT-CORE-18);
 * «сессии не измеряются» — не ноль. Диагностика событий — аналитик/админ.
 */
import { useState } from 'react';
import { Alert, Badge, Button, ScreenTitle } from '../../../kit/ui';
import { useAsync } from '../../../kit';
import {
  CHANNEL_GROUPS,
  EVENT_NAMES,
  LEAD_TEST_FILTERS,
  type LeadTestFilter,
} from '../../../lib/publisher/leads-api';
import { localToIso } from '../../../lib/publisher/ops-view';
import { fmtMinor, fmtText, placementTone } from '../../../lib/publisher/view';
import { useListFilters } from '../hooks';
import {
  ComputableText,
  DateText,
  ExternalUrl,
  Field,
  Loadable,
  NoPermission,
  RecordLink,
  Row,
  Section,
  Select,
  StatusBadge,
  TextInput,
} from '../parts';
import type { PublisherSectionProps } from '../registry';
import { KindBadge, ListRow, PagedFooter } from './ops-parts';
import { useOps, usePaged } from './ops-hooks';

export function TrafficSection({ query }: PublisherSectionProps) {
  const { o, leads, pid, can, locale, t, go } = useOps();
  const f = useListFilters('traffic', query, [
    'contentId',
    'placementId',
    'from',
    'to',
  ]);
  const [draft, setDraft] = useState(f.values);
  const state = useAsync(
    () =>
      can('traffic.read')
        ? leads.passport(pid, {
            contentId: f.values.contentId || undefined,
            placementId: f.values.placementId || undefined,
            from: f.values.from
              ? (localToIso(`${f.values.from}T00:00`) ?? undefined)
              : undefined,
            to: f.values.to
              ? (localToIso(`${f.values.to}T23:59`) ?? undefined)
              : undefined,
          })
        : Promise.resolve(null),
    [pid, f.values.contentId, f.values.placementId, f.values.from, f.values.to]
  );
  const money = (cur: string | null) => (v: string) =>
    fmtMinor(v, cur, locale, t.common.unknown);
  const pct = (v: number) => `${Math.round(v * 1000) / 10} %`;

  return (
    <div className="space-y-4">
      <ScreenTitle>{o.traffic.title}</ScreenTitle>
      <p className="text-sm text-silver-500">{o.traffic.intro}</p>
      {!can('traffic.read') ? (
        <NoPermission />
      ) : (
        <>
          <Section title={t.common.filters}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <Field label={o.traffic.contentId}>
                <TextInput
                  value={draft.contentId}
                  onChange={(v) => setDraft({ ...draft, contentId: v.trim() })}
                />
              </Field>
              <Field label={o.traffic.placementId}>
                <TextInput
                  value={draft.placementId}
                  onChange={(v) =>
                    setDraft({ ...draft, placementId: v.trim() })
                  }
                />
              </Field>
              <Field label={o.common.from}>
                <TextInput
                  type="date"
                  value={draft.from}
                  onChange={(v) => setDraft({ ...draft, from: v })}
                />
              </Field>
              <Field label={o.common.to}>
                <TextInput
                  type="date"
                  value={draft.to}
                  onChange={(v) => setDraft({ ...draft, to: v })}
                />
              </Field>
            </div>
            <Button
              variant="outline"
              onClick={() => {
                // Все четыре фильтра — одной навигацией.
                const q: Record<string, string> = {};
                for (const [k, v] of Object.entries(draft)) if (v) q[k] = v;
                go('traffic', null, q);
              }}
            >
              {o.common.apply}
            </Button>
          </Section>
          <Loadable state={state}>
            {(p) =>
              !p ? null : (
                <>
                  <Section title={o.traffic.publications}>
                    {p.publications.length === 0 ? (
                      <div className="text-sm text-silver-500">
                        {o.traffic.publicationsEmpty}
                      </div>
                    ) : (
                      <ul>
                        {p.publications.map((x) => (
                          <ListRow
                            key={x.id}
                            title={<ExternalUrl url={x.finalUrl} />}
                            badges={
                              <>
                                <StatusBadge status={x.status} tone="neutral" />
                                <Badge>{x.stage}</Badge>
                              </>
                            }
                          >
                            <DateText iso={x.publishedAt} time />
                          </ListRow>
                        ))}
                      </ul>
                    )}
                    {p.placement && (
                      <Row label={o.traffic.placement}>
                        <RecordLink section="purchases" id={p.placement.id}>
                          {p.placement.placementCode}
                        </RecordLink>{' '}
                        <StatusBadge
                          status={p.placement.status}
                          labels={o.purchases.statuses}
                          tone={placementTone(p.placement.status)}
                        />{' '}
                        <DateText iso={p.placement.publishedAt} time />
                      </Row>
                    )}
                  </Section>
                  <Section title={o.traffic.sessions}>
                    {p.sessions === null ? (
                      <Alert tone="warning">{o.traffic.sessionsNone}</Alert>
                    ) : (
                      <div className="text-2xl font-semibold">
                        {p.sessions} <KindBadge kind="fact" />
                      </div>
                    )}
                  </Section>
                  <Section title={o.traffic.events}>
                    {EVENT_NAMES.map((n) => (
                      <Row key={n} label={o.traffic.eventNames[n]}>
                        {p.events[n]}
                      </Row>
                    ))}
                    <div className="text-xs text-silver-500 pt-1">
                      {o.traffic.byChannel}
                    </div>
                    {CHANNEL_GROUPS.map((g) => (
                      <Row key={g} label={o.leads.channelGroups[g]}>
                        {p.byChannel[g] ?? 0}
                      </Row>
                    ))}
                  </Section>
                  <Section title={o.leads.title}>
                    <div className="text-sm">
                      {fmtText(o.traffic.leads, {
                        total: p.leads.total,
                        test: p.leads.test,
                        pending: p.leads.pendingEnrichment,
                      })}
                    </div>
                    <div className="text-xs text-silver-500">
                      {p.leads.trapHitsLastHour === null
                        ? o.traffic.trapHitsUnknown
                        : fmtText(o.traffic.trapHits, {
                            n: p.leads.trapHitsLastHour,
                          })}
                    </div>
                    <div className="text-xs text-silver-500 pt-1">
                      {o.traffic.qualified}
                    </div>
                    <Row label={o.traffic.qualifiedAll}>
                      {p.qualified.allExternal}
                    </Row>
                    <Row label={o.traffic.qualifiedLinked}>
                      {p.qualified.linked}
                    </Row>
                    <Row label={o.traffic.qualifiedUnknown}>
                      <span
                        className={
                          p.qualified.unknown
                            ? 'text-amber-700 dark:text-amber-400'
                            : ''
                        }
                      >
                        {p.qualified.unknown}
                      </span>
                    </Row>
                    <Row label={o.traffic.coverage}>
                      <ComputableText value={p.coverage} format={pct} />
                    </Row>
                    <RecordLink section="leads">{o.nav.leads}</RecordLink>
                  </Section>
                  <Section title="CPL">
                    <Row label={o.traffic.directCpl}>
                      <ComputableText
                        value={p.directCpl}
                        format={money(p.currency)}
                      />
                    </Row>
                    <div className="text-xs text-silver-500">
                      {o.traffic.directCplHint}
                    </div>
                    <Row label={o.traffic.productCpl}>
                      <ComputableText
                        value={p.productCpl}
                        format={money(p.currency)}
                      />
                    </Row>
                    <div className="text-xs text-silver-500">
                      {o.traffic.productCplHint}
                    </div>
                  </Section>
                </>
              )
            }
          </Loadable>
        </>
      )}
      {can('traffic.diagnostics') && <Diagnostics />}
    </div>
  );
}

function Diagnostics() {
  const { o, leads, pid } = useOps();
  const [test, setTest] = useState<LeadTestFilter>('include');
  const [name, setName] = useState<(typeof EVENT_NAMES)[number] | ''>('');
  const page = usePaged(
    (before) => leads.events(pid, { test, name: name || undefined, before }),
    [pid, test, name]
  );
  return (
    <Section title={o.traffic.diagnostics}>
      <p className="text-xs text-silver-500">{o.traffic.diagnosticsHint}</p>
      <div className="flex flex-wrap gap-2">
        <Select
          ariaLabel={o.common.test}
          value={test}
          options={LEAD_TEST_FILTERS}
          labels={o.leads.testFilter}
          onChange={(v) => v && setTest(v)}
        />
        <Select
          ariaLabel={o.traffic.events}
          value={name}
          options={EVENT_NAMES}
          labels={o.traffic.eventNames}
          empty={o.common.anyone}
          onChange={setName}
        />
      </div>
      <ul>
        {page.items.map((e) => (
          <ListRow
            key={e.id}
            title={
              <>
                {o.traffic.eventNames[
                  e.name as keyof typeof o.traffic.eventNames
                ] ?? e.name}{' '}
                · <DateText iso={e.occurredAt} time />
              </>
            }
            badges={
              <>
                {e.testFlag && <Badge tone="warning">{o.common.test}</Badge>}
                {e.utmRedacted && (
                  <Badge tone="warning">{o.traffic.redacted}</Badge>
                )}
                {e.channelGroup && (
                  <Badge>
                    {o.leads.channelGroups[
                      e.channelGroup as keyof typeof o.leads.channelGroups
                    ] ?? e.channelGroup}
                  </Badge>
                )}
              </>
            }
          >
            <div>
              {e.contentSlugRaw ?? '—'} · {e.placementCodeRaw ?? '—'} ·{' '}
              {e.referrerHost ?? '—'}
            </div>
            {e.leadId && (
              <RecordLink section="leads" id={e.leadId}>
                {e.leadId}
              </RecordLink>
            )}
          </ListRow>
        ))}
      </ul>
      <PagedFooter page={page} empty={o.traffic.eventsEmpty} />
    </Section>
  );
}
