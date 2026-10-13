/**
 * F17 — эксперименты (P-G2, §14.1 `experiments`, `experiments/:id`):
 * регистрация гипотезы до запуска, новая версия — новая запись (прежняя
 * «заменена»), применение, заключение — при открытом окне только
 * «не определено» (AT-F17-01/02; окончательно решает сервер,
 * `PUB_WINDOW_OPEN`).
 */
import { useState } from 'react';
import { Alert, Badge, Button, ScreenTitle } from '../../../kit/ui';
import { useAsync } from '../../../kit';
import {
  EXPERIMENT_DECISIONS,
  EXPERIMENT_STATUSES,
  type ExperimentConclusion,
  type ExperimentDecision,
  type ExperimentView,
} from '../../../lib/publisher/reports-api';
import {
  EXPERIMENT_TEXT_FIELDS,
  allowedConclusions,
  experimentVersionBody,
  experimentVersionMode,
  localToIso,
  parseMoneyInput,
} from '../../../lib/publisher/ops-view';
import { useListFilters, useMutation } from '../hooks';
import {
  DateText,
  Field,
  JsonView,
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
  StatusBadge,
  TextArea,
  TextInput,
} from '../parts';
import type { PublisherSectionProps } from '../registry';
import { ActionBlock, ListRow } from './ops-parts';
import { useOps } from './ops-hooks';

export function ExperimentsSection({ id, query }: PublisherSectionProps) {
  const { o, reports, pid } = useOps();
  const state = useAsync(() => reports.experiments(pid), [pid]);
  if (id) {
    return (
      <div className="space-y-4">
        <RecordLink section="experiments">{o.common.back}</RecordLink>
        <Loadable state={state}>
          {(list) => {
            const e = list.find((x) => x.id === id);
            return e ? (
              <ExperimentCard
                key={`${e.id}:${e.status}`}
                e={e}
                all={list}
                reload={state.reload}
              />
            ) : (
              <Alert tone="warning">{o.experiments.notFound}</Alert>
            );
          }}
        </Loadable>
      </div>
    );
  }
  return <ExperimentList query={query} state={state} />;
}

const TEXT_FIELDS = [
  'hypothesis',
  'change',
  'metric',
  'expectedSignal',
  'stopConditions',
] as const;

function ExperimentList({
  query,
  state,
}: {
  query: PublisherSectionProps['query'];
  state: ReturnType<typeof useAsync<ExperimentView[]>>;
}) {
  const { o, pid, can } = useOps();
  const f = useListFilters('experiments', query, ['status']);
  return (
    <div className="space-y-4">
      <ScreenTitle>{o.experiments.title}</ScreenTitle>
      <p className="text-sm text-silver-500">{o.experiments.intro}</p>
      <ListToolbar
        statuses={EXPERIMENT_STATUSES}
        status={f.values.status}
        onStatus={(v) => f.set('status', v)}
        statusLabels={o.experiments.statuses}
        csvPath={`products/${pid}/experiments`}
        extra={
          <span className="text-xs text-silver-500">
            {o.common.noOwnerField}
          </span>
        }
      />
      <Section title={o.nav.experiments}>
        <Loadable state={state}>
          {(list) => {
            const rows = list.filter(
              (e) => !f.values.status || e.status === f.values.status
            );
            return rows.length === 0 ? (
              <div className="text-sm text-silver-500">
                {o.experiments.empty}
              </div>
            ) : (
              <ul>
                {rows.map((e) => (
                  <ListRow
                    key={e.id}
                    title={
                      <RecordLink section="experiments" id={e.id}>
                        {e.key} v{e.version}
                      </RecordLink>
                    }
                    badges={
                      <>
                        <StatusBadge
                          status={e.status}
                          labels={o.experiments.statuses}
                        />
                        <Badge>{o.experiments.kinds[e.kind]}</Badge>
                        {e.conclusion && (
                          <Badge
                            tone={
                              e.conclusion === 'inconclusive'
                                ? 'warning'
                                : 'neutral'
                            }
                          >
                            {o.experiments.conclusions[e.conclusion]}
                          </Badge>
                        )}
                      </>
                    }
                  >
                    <div>{e.hypothesis}</div>
                    <div>
                      <DateText iso={e.windowStart} /> —{' '}
                      <DateText iso={e.windowEnd} />
                    </div>
                  </ListRow>
                ))}
              </ul>
            );
          }}
        </Loadable>
      </Section>
      {can('experiment.register') ? (
        <RegisterForm onDone={state.reload} />
      ) : (
        <NoPermission />
      )}
    </div>
  );
}

function RegisterForm({ onDone }: { onDone: () => void }) {
  const { o, reports, pid, go } = useOps();
  const m = useMutation();
  const [v, setV] = useState<Record<string, string>>({});
  const set = (k: string) => (x: string) => setV({ ...v, [k]: x });
  const limit = v.limit ? parseMoneyInput(v.limit) : undefined;
  const ok =
    /^[a-z0-9][a-z0-9-]{0,62}$/.test(v.key ?? '') &&
    TEXT_FIELDS.every((k) => (v[k] ?? '').trim()) &&
    localToIso(v.windowStart ?? '') &&
    localToIso(v.windowEnd ?? '') &&
    limit !== null;
  return (
    <Section title={o.experiments.register}>
      <Field label={o.experiments.fields.key}>
        <TextInput
          value={v.key ?? ''}
          onChange={(x) => set('key')(x.trim().toLowerCase())}
        />
      </Field>
      {TEXT_FIELDS.map((k) => (
        <Field key={k} label={o.experiments.fields[k]}>
          <TextArea value={v[k] ?? ''} onChange={set(k)} rows={2} />
        </Field>
      ))}
      <Field label={o.experiments.fields.windowStart}>
        <TextInput
          type="datetime-local"
          value={v.windowStart ?? ''}
          onChange={set('windowStart')}
        />
      </Field>
      <Field label={o.experiments.fields.windowEnd}>
        <TextInput
          type="datetime-local"
          value={v.windowEnd ?? ''}
          onChange={set('windowEnd')}
        />
      </Field>
      <Field label={o.experiments.fields.limitMinor}>
        <TextInput value={v.limit ?? ''} onChange={set('limit')} />
      </Field>
      <Field label={o.experiments.fields.baselineVersionId}>
        <TextInput
          value={v.baseline ?? ''}
          onChange={(x) => set('baseline')(x.trim())}
        />
      </Field>
      <Field label={o.experiments.fields.newVersionId}>
        <TextInput
          value={v.newVersion ?? ''}
          onChange={(x) => set('newVersion')(x.trim())}
        />
      </Field>
      <PubErrorAlert error={m.error} />
      <Button
        loading={m.busy}
        disabled={!ok}
        onClick={async () => {
          const x = await m.run((k) =>
            reports.registerExperiment(pid, k, {
              key: v.key,
              hypothesis: v.hypothesis.trim(),
              change: v.change.trim(),
              metric: v.metric.trim(),
              expectedSignal: v.expectedSignal.trim(),
              stopConditions: v.stopConditions.trim(),
              windowStart: localToIso(v.windowStart) as string,
              windowEnd: localToIso(v.windowEnd) as string,
              ...(limit ? { limitMinor: limit } : {}),
              ...(v.baseline ? { baselineVersionId: v.baseline } : {}),
              ...(v.newVersion ? { newVersionId: v.newVersion } : {}),
            })
          );
          if (x) {
            onDone();
            go('experiments', x.id);
          }
        }}
      >
        {o.experiments.register}
      </Button>
    </Section>
  );
}

function ExperimentCard({
  e,
  all,
  reload,
}: {
  e: ExperimentView;
  all: ExperimentView[];
  reload: () => void;
}) {
  const { o, reports, pid, can } = useOps();
  const m = useMutation();
  const mc = useMutation();
  const [done, setDone] = useState<string | null>(null);
  const conclusions = allowedConclusions(e, new Date());
  const [conclusion, setConclusion] = useState<ExperimentConclusion | ''>('');
  const [decision, setDecision] = useState<ExperimentDecision | ''>('');
  const [reason, setReason] = useState('');
  const newer = all.find((x) => x.supersedesId === e.id);
  const active = e.status === 'registered' || e.status === 'running';
  return (
    <div className="space-y-4">
      <ScreenTitle>
        {e.key} v{e.version}{' '}
        <StatusBadge status={e.status} labels={o.experiments.statuses} />
      </ScreenTitle>
      {newer && (
        <Alert tone="warning">
          {o.experiments.statuses.superseded}:{' '}
          <RecordLink section="experiments" id={newer.id}>
            v{newer.version}
          </RecordLink>
        </Alert>
      )}
      <PubErrorAlert error={m.error} onReload={reload} />
      <Notice text={done} />
      <Section title={o.experiments.fields.hypothesis}>
        {TEXT_FIELDS.map((k) => (
          <Row key={k} label={o.experiments.fields[k]}>
            <span className="whitespace-pre-wrap">{e[k]}</span>
          </Row>
        ))}
        <Row label={o.experiments.fields.limitMinor}>
          <MoneyText minor={e.limitMinor} />
        </Row>
        {e.supersedesId && (
          <Row label={o.experiments.supersedes}>
            <RecordLink section="experiments" id={e.supersedesId}>
              {e.supersedesId}
            </RecordLink>
          </Row>
        )}
        {e.contentIds.length > 0 && (
          <Row label={o.experiments.contents}>
            {e.contentIds.map((c) => (
              <span key={c} className="mr-2">
                <RecordLink section="materials" id={c}>
                  {c}
                </RecordLink>
              </span>
            ))}
          </Row>
        )}
        <RecordLink section="reports" query={{ experimentId: e.id }}>
          {o.nav.reports}
        </RecordLink>
      </Section>
      <Section title={o.experiments.timeline}>
        {(
          [
            ['windowStart', e.windowStart],
            ['windowEnd', e.windowEnd],
            ['t0Planned', e.t0Planned],
            ['t0', e.t0],
            ['t42', e.t42],
            ['t72', e.t72],
            ['t90', e.t90],
            ['lateCohortEnd', e.lateCohortEnd],
            ['registeredAt', e.registeredAt],
            ['appliedAt', e.appliedAt],
          ] as const
        ).map(([k, val]) => (
          <Row key={k} label={o.experiments.milestones[k]}>
            {val ? (
              <DateText iso={val} time />
            ) : (
              <span className="text-amber-700 dark:text-amber-400">
                {o.common.unknown}
              </span>
            )}
          </Row>
        ))}
      </Section>
      <Section title={o.experiments.thresholds}>
        {e.thresholds ? (
          <JsonView value={e.thresholds} />
        ) : (
          <div className="text-sm text-amber-700 dark:text-amber-400">
            {o.common.unknown}
          </div>
        )}
      </Section>
      {e.conclusion && (
        <Section title={o.experiments.conclusion}>
          <Row label={o.experiments.conclusion}>
            {o.experiments.conclusions[e.conclusion]}
          </Row>
          {e.conclusionReason && (
            <Row label={o.common.reason}>{e.conclusionReason}</Row>
          )}
          {e.decision && (
            <Row label={o.experiments.decision}>
              {o.experiments.decisions[e.decision as ExperimentDecision] ??
                e.decision}
            </Row>
          )}
          <Row label={o.common.when}>
            <DateText iso={e.decidedAt} time />
          </Row>
        </Section>
      )}
      {active && can('experiment.register') && (
        <Section title={o.common.actions}>
          {e.kind === 'change' && e.status === 'registered' && (
            <Button
              loading={m.busy}
              onClick={async () => {
                setDone(null);
                const x = await m.run((k) =>
                  reports.applyExperiment(pid, e.id, k)
                );
                if (x) {
                  setDone(o.common.done);
                  reload();
                }
              }}
            >
              {o.experiments.apply}
            </Button>
          )}
          <NewVersionBlock e={e} reload={reload} />
        </Section>
      )}
      {active && can('experiment.conclude') && (
        <Section title={o.experiments.conclude}>
          {conclusions.length === 1 && (
            <Alert tone="warning">{o.experiments.windowOpen}</Alert>
          )}
          <Field label={o.experiments.conclusion}>
            <Select
              value={conclusion}
              options={conclusions}
              labels={o.experiments.conclusions}
              empty={o.common.choose}
              onChange={setConclusion}
            />
          </Field>
          <Field label={o.experiments.decision}>
            <Select
              value={decision}
              options={EXPERIMENT_DECISIONS}
              labels={o.experiments.decisions}
              empty={o.common.choose}
              onChange={setDecision}
            />
          </Field>
          <Field label={o.common.reason} hint={o.common.hintPii}>
            <TextArea value={reason} onChange={setReason} rows={2} />
          </Field>
          <Button
            loading={mc.busy}
            disabled={!conclusion || !decision || !reason.trim()}
            onClick={async () => {
              if (!conclusion || !decision) return;
              const x = await mc.run((k) =>
                reports.concludeExperiment(pid, e.id, k, {
                  conclusion,
                  decision,
                  reason: reason.trim(),
                })
              );
              if (x) reload();
            }}
          >
            {o.experiments.conclude}
          </Button>
        </Section>
      )}
    </div>
  );
}

/**
 * Новая версия эксперимента по правилам сервера (P-E S1-1): пилот после
 * t0 — только конец поздней когорты; `change` — с новым будущим окном.
 */
function NewVersionBlock({
  e,
  reload,
}: {
  e: ExperimentView;
  reload: () => void;
}) {
  const { o, reports, pid, go } = useOps();
  const m = useMutation();
  const [ver, setVer] = useState<Record<string, string>>({});
  const mode = experimentVersionMode(e);
  const body = experimentVersionBody(e, ver, new Date());
  const dt = (k: 'windowStart' | 'windowEnd' | 'lateCohortEnd') => (
    <Field label={o.experiments.fields[k]}>
      <TextInput
        type="datetime-local"
        value={ver[k] ?? ''}
        onChange={(x) => setVer({ ...ver, [k]: x })}
      />
    </Field>
  );
  return (
    <ActionBlock title={o.experiments.newVersion}>
      {mode === 'pilot_started' ? (
        <>
          <Alert tone="neutral">{o.experiments.pilotStartedHint}</Alert>
          {dt('lateCohortEnd')}
        </>
      ) : (
        <>
          {mode === 'change' && (
            <Alert tone="neutral">{o.experiments.changeVersionHint}</Alert>
          )}
          {EXPERIMENT_TEXT_FIELDS.map((k) => (
            <Field key={k} label={o.experiments.fields[k]}>
              <TextArea
                value={ver[k] ?? ''}
                rows={2}
                onChange={(x) => setVer({ ...ver, [k]: x })}
              />
            </Field>
          ))}
          {dt('windowStart')}
          {dt('windowEnd')}
          {dt('lateCohortEnd')}
        </>
      )}
      <PubErrorAlert error={m.error} onReload={reload} />
      <Button
        loading={m.busy}
        disabled={!body}
        onClick={async () => {
          if (!body) return;
          const x = await m.run((k) =>
            reports.experimentVersion(pid, e.id, k, body)
          );
          if (x) {
            reload();
            go('experiments', x.id);
          }
        }}
      >
        {o.experiments.newVersion}
      </Button>
    </ActionBlock>
  );
}
