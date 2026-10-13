/**
 * F17 — отчёты (P-G2, §14.1 `reports`, `reports/:id`): неизменяемые
 * снимки с `snapshot_at`, источники с `last_synced_at` и плашкой
 * неполноты (AT-CORE-12), `not_computable` с исходными числами и «не
 * менее» (AT-CORE-18), pending отдельно, окна размещений, история версий
 * (пересчёт и решение — наследники); текущие метрики «предварительно»;
 * источники данных: интеграции и ручной импорт метрик.
 */
import { useState } from 'react';
import { Alert, Badge, Button, ScreenTitle, Tabs } from '../../../kit/ui';
import { useAsync } from '../../../kit';
import {
  INTEGRATION_STATUSES,
  METRIC_IMPORT_SOURCES,
  REPORT_KINDS,
  type IntegrationView,
  type ReportCohort,
  type ReportCosts,
  type ReportKind,
  type ReportMetrics,
  type ReportView,
} from '../../../lib/publisher/reports-api';
import {
  integrationTone,
  kyivNoonIso,
  metricDays,
  localToIso,
} from '../../../lib/publisher/ops-view';
import { fmtDateTime, fmtMinor, fmtText } from '../../../lib/publisher/view';
import { useListFilters, useMutation } from '../hooks';
import {
  CompletenessBanner,
  ComputableText,
  DateText,
  Field,
  ListToolbar,
  Loadable,
  MoneyText,
  NoPermission,
  Notice,
  PubErrorAlert,
  RecordLink,
  Row,
  Section,
  Select,
  TextArea,
  TextInput,
} from '../parts';
import type { PublisherSectionProps } from '../registry';
import { ActionBlock, KindBadge, ListRow, PagedFooter } from './ops-parts';
import { useOps, usePaged } from './ops-hooks';

const TABS = ['snapshots', 'preview', 'sources'] as const;
type Tab = (typeof TABS)[number];

export function ReportsSection({ id, query }: PublisherSectionProps) {
  const { o, go, can } = useOps();
  if (id) return <ReportCard id={id} />;
  const visible: Tab[] = TABS.filter((tb) =>
    tb === 'snapshots'
      ? true
      : tb === 'preview'
        ? can('report.manage')
        : can('metrics.import')
  );
  const tab: Tab = (visible as string[]).includes(query.tab ?? '')
    ? (query.tab as Tab)
    : 'snapshots';
  return (
    <div className="space-y-4">
      <ScreenTitle>{o.reports.title}</ScreenTitle>
      <p className="text-sm text-silver-500">{o.reports.intro}</p>
      <Tabs
        tabs={visible.map((k) => ({ key: k, label: o.reports.tabs[k] }))}
        active={tab}
        onChange={(k) =>
          go('reports', null, k === 'snapshots' ? {} : { tab: k })
        }
      />
      {tab === 'snapshots' && <Snapshots query={query} />}
      {tab === 'preview' && <Preview />}
      {tab === 'sources' && <Sources />}
    </div>
  );
}

function Snapshots({ query }: { query: PublisherSectionProps['query'] }) {
  const { o, reports, pid, can } = useOps();
  const f = useListFilters('reports', query, ['kind', 'experimentId']);
  const kind = (REPORT_KINDS as readonly string[]).includes(f.values.kind)
    ? (f.values.kind as ReportKind)
    : undefined;
  const page = usePaged(
    (before) => reports.reports(pid, { kind, before }),
    [pid, kind]
  );
  const rows = page.items.filter(
    (r) => !f.values.experimentId || r.experimentId === f.values.experimentId
  );
  return (
    <>
      <ListToolbar
        statuses={REPORT_KINDS}
        status={f.values.kind}
        onStatus={(v) => f.set('kind', v)}
        statusLabels={o.reports.kinds}
        csvPath={`products/${pid}/reports`}
        csvQuery={{ kind }}
        extra={
          <span className="text-xs text-silver-500">
            {o.common.noOwnerField}
          </span>
        }
      />
      {f.values.experimentId && (
        <Alert tone="neutral">{o.common.loadedOnly}</Alert>
      )}
      <Section title={o.reports.tabs.snapshots}>
        <ul>
          {rows.map((r) => (
            <ListRow
              key={r.id}
              title={
                <RecordLink section="reports" id={r.id}>
                  {o.reports.kinds[r.kind]} ·{' '}
                  <DateText iso={r.snapshotAt} time />
                </RecordLink>
              }
              badges={
                <>
                  <Badge tone={r.superseded ? 'warning' : 'neutral'}>
                    {r.superseded ? o.reports.superseded : o.reports.latest}
                  </Badge>
                  {r.recomputeReason && (
                    <Badge>
                      {o.reports.recomputeReasons[
                        r.recomputeReason as keyof typeof o.reports.recomputeReasons
                      ] ?? r.recomputeReason}
                    </Badge>
                  )}
                  {r.decision && (
                    <Badge tone="accent">{o.reports.decision}</Badge>
                  )}
                </>
              }
            >
              <DateText iso={r.periodStart} /> — <DateText iso={r.periodEnd} />
              {r.experimentId && (
                <>
                  {' · '}
                  <RecordLink section="experiments" id={r.experimentId}>
                    {o.nav.experiments}
                  </RecordLink>
                </>
              )}
            </ListRow>
          ))}
        </ul>
        <PagedFooter page={page} empty={o.reports.empty} />
      </Section>
      {can('report.manage') ? (
        <CreateReport onDone={page.reload} />
      ) : (
        <NoPermission />
      )}
    </>
  );
}

function CreateReport({ onDone }: { onDone: () => void }) {
  const { o, reports, pid, go } = useOps();
  const m = useMutation();
  const [kind, setKind] = useState<ReportKind | ''>('');
  const [v, setV] = useState({
    periodStart: '',
    periodEnd: '',
    snapshotAt: '',
    experimentId: '',
  });
  return (
    <Section title={o.reports.create}>
      <Field label={o.reports.kinds.weekly}>
        <Select
          value={kind}
          options={REPORT_KINDS}
          labels={o.reports.kinds}
          empty={o.common.choose}
          onChange={setKind}
        />
      </Field>
      {(kind === 'weekly' || kind === 'ad_hoc') && (
        <>
          <Field label={o.reports.periodStart}>
            <TextInput
              type="datetime-local"
              value={v.periodStart}
              onChange={(x) => setV({ ...v, periodStart: x })}
            />
          </Field>
          <Field label={o.reports.periodEnd}>
            <TextInput
              type="datetime-local"
              value={v.periodEnd}
              onChange={(x) => setV({ ...v, periodEnd: x })}
            />
          </Field>
        </>
      )}
      <Field label={o.reports.snapshotAt}>
        <TextInput
          type="datetime-local"
          value={v.snapshotAt}
          onChange={(x) => setV({ ...v, snapshotAt: x })}
        />
      </Field>
      <Field label={o.reports.experimentId}>
        <TextInput
          value={v.experimentId}
          onChange={(x) => setV({ ...v, experimentId: x.trim() })}
        />
      </Field>
      <PubErrorAlert error={m.error} />
      <Button
        loading={m.busy}
        disabled={!kind}
        onClick={async () => {
          if (!kind) return;
          const ps = localToIso(v.periodStart);
          const pe = localToIso(v.periodEnd);
          const sa = localToIso(v.snapshotAt);
          const x = await m.run((k) =>
            reports.createReport(pid, k, {
              kind,
              ...(ps ? { periodStart: ps } : {}),
              ...(pe ? { periodEnd: pe } : {}),
              ...(sa ? { snapshotAt: sa } : {}),
              ...(v.experimentId ? { experimentId: v.experimentId } : {}),
            })
          );
          if (x) {
            onDone();
            go('reports', x.id);
          }
        }}
      >
        {o.reports.create}
      </Button>
    </Section>
  );
}

function ReportCard({ id }: { id: string }) {
  const { o, reports, pid } = useOps();
  const state = useAsync(() => reports.report(pid, id), [pid, id]);
  return (
    <div className="space-y-4">
      <RecordLink section="reports">{o.common.back}</RecordLink>
      <Loadable state={state}>{(r) => <ReportBody r={r} />}</Loadable>
    </div>
  );
}

function ReportBody({ r }: { r: ReportView }) {
  const { o, reports, pid, can, go, locale } = useOps();
  // Решение и пересчёт — разные действия: свой ключ попытки у каждого.
  const m = useMutation();
  const mr = useMutation();
  const [decision, setDecision] = useState('');
  const [done, setDone] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      <ScreenTitle>
        {fmtText(o.reports.snapshot, {
          kind: o.reports.kinds[r.kind],
          at: fmtDateTime(r.snapshotAt, locale),
        })}
      </ScreenTitle>
      <div className="flex flex-wrap gap-1">
        <KindBadge kind="fact" />
        <Badge tone={r.superseded ? 'warning' : 'neutral'}>
          {r.superseded ? o.reports.superseded : o.reports.latest}
        </Badge>
        {r.recomputeReason && (
          <Badge>
            {o.reports.recomputeReasons[
              r.recomputeReason as keyof typeof o.reports.recomputeReasons
            ] ?? r.recomputeReason}
          </Badge>
        )}
      </div>
      <Section title={o.common.details}>
        <Row label={o.reports.periodStart}>
          <DateText iso={r.periodStart} time />
        </Row>
        <Row label={o.reports.periodEnd}>
          <DateText iso={r.periodEnd} time />
        </Row>
        <Row label={o.reports.snapshotAt}>
          <DateText iso={r.snapshotAt} time />
        </Row>
        <Row label={o.reports.inputsHash}>
          <code className="text-xs break-all">{r.inputsHash}</code>
        </Row>
        {r.supersedesReportId && (
          <Row label={o.reports.supersedes}>
            <RecordLink section="reports" id={r.supersedesReportId}>
              {r.supersedesReportId}
            </RecordLink>
          </Row>
        )}
        {r.experimentId && (
          <Row label={o.nav.experiments}>
            <RecordLink section="experiments" id={r.experimentId}>
              {r.experimentId}
            </RecordLink>
          </Row>
        )}
        {r.decision && <Row label={o.reports.decision}>{r.decision}</Row>}
        {r.assumptions && (
          <Row label={o.reports.assumptions}>{r.assumptions}</Row>
        )}
      </Section>
      <MetricsView
        cohort={r.cohort}
        sources={r.sources}
        metrics={r.metrics}
        costs={r.costs}
      />
      {can('report.manage') && !r.superseded && (
        <Section title={o.reports.decision}>
          <PubErrorAlert error={m.error} />
          <Notice text={done} />
          <ActionBlock title={o.reports.decision}>
            <p className="text-xs text-silver-500">{o.reports.decisionHint}</p>
            <TextArea value={decision} onChange={setDecision} rows={2} />
            <Button
              loading={m.busy}
              disabled={!decision.trim()}
              onClick={async () => {
                const x = await m.run((k) =>
                  reports.reportDecision(pid, r.id, k, decision.trim())
                );
                if (x) go('reports', x.id);
              }}
            >
              {o.reports.decision}
            </Button>
          </ActionBlock>
          <ActionBlock title={o.reports.recompute}>
            <p className="text-xs text-silver-500">
              {o.reports.recomputeManualOnly}
            </p>
            <PubErrorAlert error={mr.error} />
            <Button
              loading={mr.busy}
              onClick={async () => {
                setDone(null);
                const x = await mr.run((k) =>
                  reports.recomputeReport(pid, r.id, k, 'manual')
                );
                if (x) go('reports', x.id);
              }}
            >
              {o.reports.recompute}
            </Button>
          </ActionBlock>
        </Section>
      )}
    </div>
  );
}

/** Метрики снимка или предварительной экономики: неизвестное ≠ 0. */
function MetricsView({
  cohort,
  sources,
  metrics,
  costs,
}: {
  cohort: ReportCohort;
  sources: ReportView['sources'];
  metrics: ReportMetrics;
  costs: ReportCosts;
}) {
  const { o, locale, t } = useOps();
  const cur = costs.currency;
  const money = (v: string) => fmtMinor(v, cur, locale, t.common.unknown);
  const pct = (v: number) => `${Math.round(v * 1000) / 10} %`;
  const num = (v: number) => String(Math.round(v * 100) / 100);
  const missing = (
    <span className="text-amber-700 dark:text-amber-400">
      {o.common.notInSnapshot}
    </span>
  );
  return (
    <>
      <CompletenessBanner completeness={sources.completeness} />
      <Section title={o.reports.sources}>
        {sources.list.length === 0 ? (
          missing
        ) : (
          <ul className="text-sm space-y-1">
            {sources.list.map((s) => (
              <li key={s.kind} className="flex flex-wrap items-center gap-1">
                <span>
                  {o.reports.integrationKinds[
                    s.kind as keyof typeof o.reports.integrationKinds
                  ] ?? s.kind}
                </span>
                <Badge
                  tone={integrationTone({
                    exists: true,
                    status: s.status,
                    stale: s.stale,
                  })}
                >
                  {t.status[s.status]}
                </Badge>
                {s.stale && <Badge tone="warning">{o.reports.stale}</Badge>}
                {s.manual && <Badge>{o.reports.manual}</Badge>}
                <span className="text-xs text-silver-500">
                  {s.lastSyncedAt
                    ? fmtText(o.reports.lastSynced, {
                        at: fmtDateTime(s.lastSyncedAt, locale),
                      })
                    : o.reports.neverSynced}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title={o.reports.cohort}>
        {cohort.start && cohort.end ? (
          <div className="text-sm">
            {fmtText(o.reports.cohortRange, {
              start: fmtDateTime(cohort.start, locale),
              end: fmtDateTime(cohort.end, locale),
              close: cohort.closeAt
                ? fmtDateTime(cohort.closeAt, locale)
                : o.common.unknown,
            })}
          </div>
        ) : (
          missing
        )}
        <Row label={o.reports.window}>
          {metrics.windowClosed === null ? (
            missing
          ) : metrics.windowClosed ? (
            o.reports.windowClosed
          ) : (
            <span className="text-amber-700 dark:text-amber-400">
              {o.reports.windowOpen}
            </span>
          )}
        </Row>
        {metrics.experimentConclusion && (
          <Row label={o.nav.experiments}>
            {o.reports.conclusionAllowed[metrics.experimentConclusion]}
          </Row>
        )}
      </Section>
      <Section title={o.reports.sessions}>
        {!metrics.sessions ? (
          missing
        ) : metrics.sessions.value === null ? (
          <Alert tone="warning">{o.common.notMeasured}</Alert>
        ) : (
          <div className="text-xl font-semibold">{metrics.sessions.value}</div>
        )}
        {metrics.sessions && metrics.sessions.complete === false && (
          <Alert tone="warning">{o.reports.sessionsIncomplete}</Alert>
        )}
        {metrics.sessions && metrics.sessions.partialDays.length > 0 && (
          <div className="text-xs text-amber-700 dark:text-amber-400">
            {fmtText(o.reports.partialDays, {
              list: metrics.sessions.partialDays.join(', '),
            })}
          </div>
        )}
        {metrics.sessions && metrics.sessions.missingDays.length > 0 && (
          <div className="text-xs text-amber-700 dark:text-amber-400">
            {fmtText(o.reports.missingDays, {
              list: metrics.sessions.missingDays.join(', '),
            })}
          </div>
        )}
      </Section>
      <Section title={o.reports.leads}>
        {!metrics.leads ? (
          missing
        ) : (
          <>
            <Row label={o.reports.leadsInPeriod}>{metrics.leads.inPeriod}</Row>
            <Row label={o.reports.leadsLinked}>{metrics.leads.linked}</Row>
            <Row label={o.reports.leadsPending}>
              <span className="text-amber-700 dark:text-amber-400">
                {metrics.leads.pending}
              </span>
            </Row>
            <Row label={o.reports.qualifiedUnique}>
              {metrics.leads.qualifiedUnique}
            </Row>
            <Row label={o.reports.linkedQualified}>
              {metrics.leads.linkedQualified}
            </Row>
            <Row label={o.reports.unknownQualified}>
              {metrics.leads.unknownQualified}
            </Row>
            <Row label={o.reports.proposals}>
              {metrics.leads.proposalsToDistinct}
            </Row>
            <Row label={o.reports.coverage}>
              <ComputableText value={metrics.leads.coverage} format={pct} />
            </Row>
            {metrics.leads.outsideCohort && (
              <>
                <Row label={o.reports.outsideNext}>
                  {metrics.leads.outsideCohort.nextPeriod}
                </Row>
                <Row label={o.reports.outsideAfterWindow}>
                  {metrics.leads.outsideCohort.afterSessionWindow}
                </Row>
              </>
            )}
          </>
        )}
        {metrics.qualifiedPer100Sessions && (
          <Row label={o.reports.per100}>
            <ComputableText
              value={metrics.qualifiedPer100Sessions.value}
              format={num}
            />{' '}
            <span className="text-xs text-silver-500">
              (
              {o.reports.basis[
                metrics.qualifiedPer100Sessions
                  .basis as keyof typeof o.reports.basis
              ] ?? metrics.qualifiedPer100Sessions.basis}
              )
            </span>
          </Row>
        )}
      </Section>
      <Section title={o.reports.signalD42}>
        {!metrics.signalD42 ? (
          missing
        ) : (
          <>
            <Badge
              tone={metrics.signalD42.verdict === 'met' ? 'success' : 'warning'}
            >
              {o.reports.verdicts[metrics.signalD42.verdict]}
            </Badge>
            {(['sessions', 'qualified', 'proposals'] as const).map((k) => {
              const p = metrics.signalD42?.parts[k];
              if (!p) return null;
              return (
                <Row key={k} label={o.reports.signalParts[k]}>
                  {p.value === null ? o.common.unknown : p.value} (
                  {fmtText(o.reports.threshold, { v: p.threshold })}) —{' '}
                  {o.reports.parts[p.state]}
                </Row>
              );
            })}
          </>
        )}
        {metrics.searchSignalD90 && (
          <>
            <div className="text-xs text-silver-500 pt-1">
              {o.reports.signalD90}
            </div>
            <Badge
              tone={
                metrics.searchSignalD90.verdict === 'met'
                  ? 'success'
                  : 'warning'
              }
            >
              {o.reports.verdicts[metrics.searchSignalD90.verdict]}
            </Badge>
            {Object.entries(metrics.searchSignalD90.parts).map(([k, st]) => (
              <Row
                key={k}
                label={
                  o.reports.signalParts[
                    k as keyof typeof o.reports.signalParts
                  ] ?? k
                }
              >
                {o.reports.parts[st]}
              </Row>
            ))}
          </>
        )}
      </Section>
      <Section title={o.reports.economics}>
        {!metrics.economics ? (
          missing
        ) : (
          <>
            {(
              [
                'directCpl',
                'fullOperationalCplTechnical',
                'productCpl',
                'investmentCpl',
                'allowedOperationalCpl',
                'operationalCac',
                'investmentCac',
              ] as const
            ).map((k) => (
              <Row key={k} label={o.reports.econ[k]}>
                <ComputableText value={metrics.economics?.[k]} format={money} />
              </Row>
            ))}
            <Row label={o.reports.econ.economicSignal}>
              <ComputableText
                value={metrics.economics.economicSignal}
                format={(v) => o.reports.signalValues[v]}
              />
            </Row>
            <div className="text-xs text-silver-500">
              {fmtText(o.reports.newPaying, {
                n: metrics.economics.newPayingLinked,
                u: metrics.economics.newCustomerUnknown,
              })}
            </div>
          </>
        )}
      </Section>
      <Section title={o.reports.costs}>
        <Row label={o.reports.costsOperational}>
          <ComputableText value={costs.operational} format={money} />
        </Row>
        <Row label={o.reports.costsInvestment}>
          <ComputableText value={costs.investment} format={money} />
        </Row>
        <Row label={o.reports.costsTotal}>
          <ComputableText value={costs.total} format={money} />
        </Row>
        <Row label={o.reports.cashNet}>
          <MoneyText minor={costs.cashNetPaidMinor} currency={cur} />
        </Row>
        <Row label={o.reports.advances}>
          <MoneyText minor={costs.advancesMinor} currency={cur} />
        </Row>
        {costs.minutesWithoutRate &&
          (costs.minutesWithoutRate.operational > 0 ||
            costs.minutesWithoutRate.investment > 0) && (
            <Alert tone="warning">
              {fmtText(o.reports.minutesWithoutRate, {
                op: costs.minutesWithoutRate.operational,
                inv: costs.minutesWithoutRate.investment,
              })}
            </Alert>
          )}
        {costs.aiCallsUnpriced ? (
          <Alert tone="warning">
            {fmtText(o.reports.aiUnpriced, { n: costs.aiCallsUnpriced })}
          </Alert>
        ) : null}
      </Section>
      <Section title={o.reports.revenue}>
        {!metrics.revenue ? (
          missing
        ) : (
          <>
            <Badge
              tone={
                metrics.revenue.commercialValidation === 'confirmed'
                  ? 'success'
                  : 'warning'
              }
            >
              {o.reports.commercial[metrics.revenue.commercialValidation]}
            </Badge>
            {Object.keys(metrics.revenue.byCurrency).length === 0 ? (
              <div className="text-sm text-silver-500">
                {o.reports.revenueEmpty}
              </div>
            ) : (
              Object.entries(metrics.revenue.byCurrency).map(([c, v]) => (
                <Row key={c} label={c}>
                  <MoneyText minor={v.netMinor} currency={c} /> (
                  <MoneyText minor={v.receivedMinor} currency={c} /> −{' '}
                  <MoneyText minor={v.refundedMinor} currency={c} />)
                </Row>
              ))
            )}
          </>
        )}
      </Section>
      <Section title={o.reports.placements}>
        {metrics.placements.length === 0 ? (
          <div className="text-sm text-silver-500">{t.common.empty}</div>
        ) : (
          <ul>
            {metrics.placements.map((p) => (
              <ListRow
                key={p.id}
                title={
                  <RecordLink section="purchases" id={p.id}>
                    {p.placementCode}
                  </RecordLink>
                }
                badges={
                  <>
                    <Badge
                      tone={p.windowState === 'closed' ? 'neutral' : 'warning'}
                    >
                      {o.reports.windowStates[p.windowState]}
                    </Badge>
                    {p.late && <Badge>{o.reports.late}</Badge>}
                    {p.deliveryUnconfirmed && (
                      <Badge tone="warning">
                        {o.reports.deliveryUnconfirmed}
                      </Badge>
                    )}
                  </>
                }
              >
                <MoneyText minor={p.deliveredMinor} currency={cur} /> ·{' '}
                {p.technicalQualified} ·{' '}
                <ComputableText value={p.directCpl} format={money} />
              </ListRow>
            ))}
          </ul>
        )}
      </Section>
      {metrics.diagnostics && (
        <Section title={o.reports.diagnostics}>
          {Object.entries(metrics.diagnostics).map(([k, v]) => (
            <Row
              key={k}
              label={
                Object.prototype.hasOwnProperty.call(
                  o.reports.diagnosticKeys,
                  k
                )
                  ? o.reports.diagnosticKeys[
                      k as keyof typeof o.reports.diagnosticKeys
                    ]
                  : k
              }
            >
              {v}
            </Row>
          ))}
        </Section>
      )}
    </>
  );
}

function Preview() {
  const { o, reports, pid, locale } = useOps();
  const state = useAsync(() => reports.economicsPreview(pid), [pid]);
  return (
    <Loadable state={state}>
      {(p) => (
        <>
          <Alert tone="warning">
            <KindBadge kind="preliminary" /> {o.reports.previewNote}{' '}
            {fmtDateTime(p.at, locale)}
          </Alert>
          <MetricsView
            cohort={p.cohort}
            sources={p.sources}
            metrics={p.metrics}
            costs={p.costs}
          />
        </>
      )}
    </Loadable>
  );
}

function Sources() {
  const { o, reports, pid, locale } = useOps();
  const state = useAsync(() => reports.integrations(pid), [pid]);
  const imports = usePaged(
    (before) => reports.metricImports(pid, before),
    [pid]
  );
  return (
    <>
      <Section title={o.reports.integrations}>
        <Loadable state={state}>
          {(list) => (
            <ul>
              {list.map((i) => (
                <IntegrationRow key={i.kind} i={i} onSaved={state.reload} />
              ))}
            </ul>
          )}
        </Loadable>
      </Section>
      <Section title={o.reports.imports}>
        <ul>
          {imports.items.map((x) => (
            <ListRow
              key={x.id}
              title={
                <>
                  {o.reports.importSources[
                    x.source as keyof typeof o.reports.importSources
                  ] ?? x.source}{' '}
                  · <DateText iso={x.periodStart} /> —{' '}
                  <DateText iso={x.periodEnd} />
                </>
              }
              badges={
                <Badge>{fmtText(o.reports.importDays, { n: x.days })}</Badge>
              }
            >
              {fmtDateTime(x.importedAt, locale)}
              {x.note ? ` · ${x.note}` : ''}
            </ListRow>
          ))}
        </ul>
        <PagedFooter page={imports} empty={o.reports.importsEmpty} />
        <ImportForm onDone={imports.reload} />
      </Section>
    </>
  );
}

function IntegrationRow({
  i,
  onSaved,
}: {
  i: IntegrationView;
  onSaved: () => void;
}) {
  const { o, reports, pid, locale, t } = useOps();
  const m = useMutation();
  const [status, setStatus] = useState<IntegrationView['status']>(i.status);
  const [note, setNote] = useState(i.note ?? '');
  return (
    <ListRow
      title={o.reports.integrationKinds[i.kind]}
      badges={
        <>
          <Badge tone={integrationTone(i)}>
            {i.exists ? t.status[i.status] : o.reports.notConnectedYet}
          </Badge>
          {i.stale && <Badge tone="warning">{o.reports.stale}</Badge>}
          {i.manual && <Badge>{o.reports.manual}</Badge>}
        </>
      }
    >
      <div>
        {o.reports.lastSuccess}:{' '}
        {i.lastSuccessAt
          ? fmtDateTime(i.lastSuccessAt, locale)
          : o.reports.neverSynced}{' '}
        · {o.reports.lastChecked}:{' '}
        {i.lastCheckedAt
          ? fmtDateTime(i.lastCheckedAt, locale)
          : o.common.unknown}{' '}
        · {fmtText(o.reports.staleAfter, { h: i.staleAfterHours })}
      </div>
      {i.note && <div>{i.note}</div>}
      <ActionBlock title={o.reports.setStatus}>
        <Select
          value={status}
          options={INTEGRATION_STATUSES}
          labels={t.status}
          onChange={(v) => v && setStatus(v)}
        />
        <TextInput
          value={note}
          placeholder={o.common.note}
          onChange={setNote}
        />
        <PubErrorAlert error={m.error} onReload={onSaved} />
        <Button
          loading={m.busy}
          onClick={async () => {
            const x = await m.run((k) =>
              reports.putIntegration(pid, i.kind, k, {
                status,
                ...(i.revision !== null
                  ? { expectedRevision: i.revision }
                  : {}),
                note: note.trim() || null,
              })
            );
            if (x) onSaved();
          }}
        >
          {o.reports.setStatus}
        </Button>
      </ActionBlock>
    </ListRow>
  );
}

function ImportForm({ onDone }: { onDone: () => void }) {
  const { o, reports, pid } = useOps();
  const m = useMutation();
  const [source, setSource] = useState<
    (typeof METRIC_IMPORT_SOURCES)[number] | ''
  >('');
  const [v, setV] = useState({ start: '', end: '', days: '', note: '' });
  const [bad, setBad] = useState(false);
  return (
    <ActionBlock title={o.reports.importNew}>
      <Select
        value={source}
        options={METRIC_IMPORT_SOURCES}
        labels={o.reports.importSources}
        empty={o.common.choose}
        onChange={setSource}
      />
      <Field label={o.reports.periodStart}>
        <TextInput
          type="date"
          value={v.start}
          onChange={(x) => setV({ ...v, start: x })}
        />
      </Field>
      <Field label={o.reports.periodEnd}>
        <TextInput
          type="date"
          value={v.end}
          onChange={(x) => setV({ ...v, end: x })}
        />
      </Field>
      <Field label={o.reports.importPayload} hint={o.reports.importPayloadHint}>
        <TextArea
          value={v.days}
          onChange={(x) => setV({ ...v, days: x })}
          rows={5}
        />
      </Field>
      <Field label={o.common.note}>
        <TextInput value={v.note} onChange={(x) => setV({ ...v, note: x })} />
      </Field>
      {bad && <Alert tone="danger">{o.reports.importBadJson}</Alert>}
      <PubErrorAlert error={m.error} />
      <Button
        loading={m.busy}
        disabled={!source || !v.start || !v.end || !v.days.trim()}
        onClick={async () => {
          if (!source) return;
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(v.days);
          } catch {
            parsed = null;
          }
          const days = metricDays(parsed);
          if (!days) {
            setBad(true);
            return;
          }
          setBad(false);
          const x = await m.run((k) =>
            reports.createMetricImport(pid, k, {
              source,
              periodStart: kyivNoonIso(v.start),
              periodEnd: kyivNoonIso(v.end),
              payload: { days },
              note: v.note.trim() || null,
            })
          );
          if (x) {
            setV({ start: '', end: '', days: '', note: '' });
            onDone();
          }
        }}
      >
        {o.reports.importNew}
      </Button>
    </ActionBlock>
  );
}
