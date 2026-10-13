/**
 * F10 — площадки (P-G2, §14.1 `venues`, `venues/:id`): карточки по пяти
 * одинаковым критериям 0–2/«невідомо», балл отдельно от полноты
 * (AT-F10-01), обязательные проверки и доказательства для «проверена»,
 * сравнение кандидатов таблицей. AI-сравнение в P0 выключено.
 */
import { useEffect, useState } from 'react';
import { Alert, Badge, Button, ScreenTitle } from '../../../kit/ui';
import { useAsync } from '../../../kit';
import {
  VENUE_CHECK_KEYS,
  VENUE_CRITERIA,
  VENUE_LINK_MARKINGS,
  VENUE_STATUSES,
  type CriterionScore,
  type VenueCriterion,
  type VenueView,
} from '../../../lib/publisher/distribution-api';
import { venueScoreView } from '../../../lib/publisher/ops-view';
import { fmtText, statusLabel } from '../../../lib/publisher/view';
import { useListFilters, useMutation } from '../hooks';
import {
  ConfirmButton,
  DateText,
  ExternalUrl,
  Field,
  ListToolbar,
  Loadable,
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
import { ActionBlock, ListRow, PagedFooter } from './ops-parts';
import { AiRunner } from '../content/AiRunner';
import { decodeStart } from '../../../lib/publisher/ai-api';
import { useOps, usePaged } from './ops-hooks';

export function VenuesSection({ id, query }: PublisherSectionProps) {
  return id ? <VenueCard id={id} /> : <VenueList query={query} />;
}

function ScoreLine({ v }: { v: VenueView }) {
  const { o } = useOps();
  const s = venueScoreView(v);
  return (
    <span className="inline-flex flex-wrap gap-1">
      <Badge tone={s.score ? 'neutral' : 'warning'}>
        {s.score
          ? `${fmtText(o.venues.score, { sum: s.score.sum, max: s.score.max })} · ${fmtText(o.venues.scoreKnown, { known: s.score.known })}`
          : o.venues.scoreNone}
      </Badge>
      <Badge
        tone={
          s.completeness.rated < s.completeness.total ? 'warning' : 'neutral'
        }
      >
        {fmtText(o.venues.completeness, { n: s.completeness.rated })}
      </Badge>
    </span>
  );
}

function VenueList({ query }: { query: PublisherSectionProps['query'] }) {
  const { o, dist, pid, can } = useOps();
  const f = useListFilters('venues', query, ['status']);
  const page = usePaged(
    (before) => dist.venues(pid, { status: f.values.status, before }),
    [pid, f.values.status]
  );
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const m = useMutation();
  const [done, setDone] = useState<string | null>(null);
  const canManage = can('venue.manage');

  return (
    <div className="space-y-4">
      <ScreenTitle>{o.venues.title}</ScreenTitle>
      <p className="text-sm text-silver-500">{o.venues.intro}</p>
      <ListToolbar
        statuses={VENUE_STATUSES}
        status={f.values.status}
        onStatus={(v) => f.set('status', v)}
        statusLabels={o.venues.statuses}
        csvPath={`products/${pid}/venues`}
        csvQuery={{ status: f.values.status }}
        extra={
          <span className="text-xs text-silver-500">
            {o.common.noOwnerField}
          </span>
        }
      />
      <Section title={o.venues.compareTitle}>
        <div className="overflow-x-auto -mx-1">
          <table className="text-xs min-w-full">
            <thead>
              <tr className="text-left text-silver-500">
                <th className="px-1 py-1">{o.venues.fields.title}</th>
                {VENUE_CRITERIA.map((c) => (
                  <th key={c} className="px-1 py-1">
                    {o.venues.criteria[c]}
                  </th>
                ))}
                <th className="px-1 py-1">%</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((v) => {
                const s = venueScoreView(v);
                return (
                  <tr
                    key={v.id}
                    className="border-t border-silver-200/60 dark:border-silver-800"
                  >
                    <td className="px-1 py-1">
                      <RecordLink section="venues" id={v.id}>
                        {v.title}
                      </RecordLink>{' '}
                      <StatusBadge
                        status={v.status}
                        labels={o.venues.statuses}
                      />
                    </td>
                    {s.cells.map((c) => (
                      <td
                        key={c.criterion}
                        className={`px-1 py-1 ${c.value === 'unknown' ? 'text-amber-700 dark:text-amber-400' : ''}`}
                        title={c.why}
                      >
                        {o.venues.scores[c.value]}
                      </td>
                    ))}
                    <td className="px-1 py-1 whitespace-nowrap">
                      {s.score
                        ? `${s.score.sum}/${s.score.max}`
                        : o.common.unknown}
                      {' · '}
                      {s.completeness.rated}/{s.completeness.total}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {can('venue.manage') && page.items.length > 1 ? (
          <AiRunner
            generator="pub.venues.compare"
            label={o.venues.aiCompareRun}
            manualHint={o.venues.aiCompare}
            // В P0 маршрут всегда 409 PUB_AI_DISABLED — ручной путь выше.
            start={async (k) =>
              decodeStart(
                await dist.aiCompareVenues(
                  pid,
                  k,
                  page.items.slice(0, 10).map((v) => v.id)
                )
              )
            }
            render={() => null}
          />
        ) : (
          <Alert tone="neutral">{o.venues.aiCompare}</Alert>
        )}
      </Section>
      <Section title={o.nav.venues}>
        <ul>
          {page.items.map((v) => (
            <ListRow
              key={v.id}
              title={
                <RecordLink section="venues" id={v.id}>
                  {v.title}
                </RecordLink>
              }
              badges={
                <>
                  <StatusBadge status={v.status} labels={o.venues.statuses} />
                  <ScoreLine v={v} />
                </>
              }
            >
              <ExternalUrl url={v.url} />
              {v.missingForVerified.length > 0 && v.status !== 'rejected' && (
                <div>{missingText(o, v.missingForVerified)}</div>
              )}
            </ListRow>
          ))}
        </ul>
        <PagedFooter page={page} empty={o.venues.empty} />
      </Section>
      {canManage ? (
        <Section title={o.venues.create}>
          <Field label={o.venues.fields.title}>
            <TextInput value={title} onChange={setTitle} maxLength={200} />
          </Field>
          <Field label={o.venues.fields.url}>
            <TextInput value={url} onChange={setUrl} type="url" />
          </Field>
          <PubErrorAlert error={m.error} />
          <Notice text={done} />
          <Button
            loading={m.busy}
            disabled={!title.trim() || !/^https:\/\//i.test(url.trim())}
            onClick={async () => {
              setDone(null);
              const v = await m.run((k) =>
                dist.createVenue(pid, k, {
                  title: title.trim(),
                  url: url.trim(),
                })
              );
              if (v) {
                setTitle('');
                setUrl('');
                setDone(o.common.done);
                page.reload();
              }
            }}
          >
            {o.venues.create}
          </Button>
        </Section>
      ) : (
        <NoPermission />
      )}
    </div>
  );
}

function missingText(
  o: ReturnType<typeof useOps>['o'],
  list: string[]
): string {
  const label = (code: string) => {
    if (code.startsWith('checks.')) {
      const k = code.slice(7) as keyof typeof o.venues.checks;
      return statusLabel(
        k,
        o.venues.checks as unknown as Record<string, string>
      );
    }
    return statusLabel(code, o.venues.missingCodes);
  };
  return fmtText(o.venues.missing, { list: list.map(label).join(', ') });
}

type ScoreChoice = '' | '0' | '1' | '2';

function VenueCard({ id }: { id: string }) {
  const { o, dist, pid, can, t } = useOps();
  const state = useAsync(() => dist.venue(pid, id), [pid, id]);
  return (
    <div className="space-y-4">
      <RecordLink section="venues">{o.common.back}</RecordLink>
      <Loadable state={state}>
        {(v) => (
          <VenueBody
            key={`${v.id}:${v.revision}`}
            v={v}
            canManage={can('venue.manage')}
            onSaved={(x) => state.setData(x)}
            reload={state.reload}
            t={t}
          />
        )}
      </Loadable>
    </div>
  );
}

function VenueBody({
  v,
  canManage,
  onSaved,
  reload,
}: {
  v: VenueView;
  canManage: boolean;
  onSaved: (v: VenueView) => void;
  reload: () => void;
  t: ReturnType<typeof useOps>['t'];
}) {
  const { o, dist, pid } = useOps();
  const m = useMutation();
  const [done, setDone] = useState<string | null>(null);
  const [fields, setFields] = useState({
    title: v.title,
    url: v.url,
    topic: v.topic ?? '',
    market: v.market ?? '',
    language: v.language ?? '',
    audienceNote: v.audienceNote ?? '',
    riskNote: v.riskNote ?? '',
  });
  const [criteria, setCriteria] = useState<
    Record<VenueCriterion, { score: ScoreChoice; why: string }>
  >(() => {
    const out = {} as Record<
      VenueCriterion,
      { score: ScoreChoice; why: string }
    >;
    for (const c of VENUE_CRITERIA) {
      const s = v.criteria[c];
      out[c] = {
        score: s && s.score !== null ? (String(s.score) as ScoreChoice) : '',
        why: s?.why ?? '',
      };
    }
    return out;
  });
  const [checks, setChecks] = useState(v.checks);
  const [marking, setMarking] = useState(v.linkMarking);
  const [ev, setEv] = useState({
    criterion: '' as VenueCriterion | '',
    sourceId: '',
    checkedAt: '',
  });
  const [reason, setReason] = useState('');
  useEffect(() => setDone(null), [v.revision]);

  const save = async (body: Parameters<typeof dist.patchVenue>[4]) => {
    setDone(null);
    const x = await m.run(
      (k) => dist.patchVenue(pid, v.id, k, v.revision, body),
      JSON.stringify(['patch', v.revision, body])
    );
    if (x) {
      onSaved(x);
      setDone(o.common.done);
    }
  };
  const transition = async (to: 'verified' | 'rejected' | 'candidate') => {
    setDone(null);
    const body = {
      expectedRevision: v.revision,
      to,
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    };
    const x = await m.run(
      (k) => dist.venueTransition(pid, v.id, k, body),
      JSON.stringify(['transition', body])
    );
    if (x) onSaved(x);
  };
  const nullable = (s: string) => (s.trim() ? s.trim() : null);

  return (
    <div className="space-y-4">
      <ScreenTitle>
        {v.title} <StatusBadge status={v.status} labels={o.venues.statuses} />
      </ScreenTitle>
      <ScoreLine v={v} />
      {v.missingForVerified.length > 0 && (
        <Alert tone="warning">{missingText(o, v.missingForVerified)}</Alert>
      )}
      <PubErrorAlert error={m.error} onReload={reload} />
      <Notice text={done} />

      <Section title={o.venues.fields.title}>
        <Row label="URL">
          <ExternalUrl url={v.url} />
        </Row>
        {v.rejectReason && (
          <Row label={o.venues.fields.rejectReason}>{v.rejectReason}</Row>
        )}
        {canManage &&
          (
            [
              'title',
              'url',
              'topic',
              'market',
              'language',
              'audienceNote',
              'riskNote',
            ] as const
          ).map((k) => (
            <Field key={k} label={o.venues.fields[k]}>
              {k === 'audienceNote' || k === 'riskNote' ? (
                <TextArea
                  value={fields[k]}
                  onChange={(x) => setFields({ ...fields, [k]: x })}
                />
              ) : (
                <TextInput
                  value={fields[k]}
                  onChange={(x) => setFields({ ...fields, [k]: x })}
                />
              )}
            </Field>
          ))}
        {canManage && (
          <Button
            loading={m.busy}
            onClick={() =>
              void save({
                title: fields.title.trim(),
                url: fields.url.trim(),
                topic: nullable(fields.topic),
                market: nullable(fields.market),
                language: nullable(fields.language),
                audienceNote: nullable(fields.audienceNote),
                riskNote: nullable(fields.riskNote),
              })
            }
          >
            {o.common.apply}
          </Button>
        )}
      </Section>

      <Section title={o.venues.compareTitle}>
        <div className="space-y-3">
          {VENUE_CRITERIA.map((c) => (
            <div key={c} className="space-y-1">
              <div className="flex items-center gap-2 text-sm">
                <span className="flex-1">{o.venues.criteria[c]}</span>
                {canManage ? (
                  <select
                    aria-label={o.venues.criteria[c]}
                    className="rounded-lg border border-silver-300 dark:border-silver-700 bg-transparent px-2 py-1 text-sm"
                    value={criteria[c].score}
                    onChange={(e) =>
                      setCriteria({
                        ...criteria,
                        [c]: {
                          ...criteria[c],
                          score: e.target.value as ScoreChoice,
                        },
                      })
                    }
                  >
                    <option value="">{o.venues.scores.unknown}</option>
                    <option value="0">0</option>
                    <option value="1">1</option>
                    <option value="2">2</option>
                  </select>
                ) : (
                  <Badge
                    tone={criteria[c].score === '' ? 'warning' : 'neutral'}
                  >
                    {criteria[c].score === ''
                      ? o.venues.scores.unknown
                      : criteria[c].score}
                  </Badge>
                )}
              </div>
              {canManage ? (
                <TextInput
                  value={criteria[c].why}
                  placeholder={o.venues.why}
                  onChange={(x) =>
                    setCriteria({
                      ...criteria,
                      [c]: { ...criteria[c], why: x },
                    })
                  }
                />
              ) : (
                criteria[c].why && (
                  <div className="text-xs text-silver-500">
                    {criteria[c].why}
                  </div>
                )
              )}
            </div>
          ))}
        </div>
        {canManage && (
          <Button
            loading={m.busy}
            onClick={() => {
              const body: Partial<Record<VenueCriterion, CriterionScore>> = {};
              for (const c of VENUE_CRITERIA) {
                const s = criteria[c];
                body[c] = {
                  score: s.score === '' ? null : (Number(s.score) as 0 | 1 | 2),
                  why: s.why.trim(),
                };
              }
              void save({ criteria: body });
            }}
          >
            {o.common.apply}
          </Button>
        )}
      </Section>

      <Section title={o.venues.checks.title}>
        {VENUE_CHECK_KEYS.map((k) => (
          <label
            key={k}
            className="flex items-center gap-2 text-sm min-h-[36px]"
          >
            <input
              type="checkbox"
              checked={checks[k]}
              disabled={!canManage}
              onChange={(e) => setChecks({ ...checks, [k]: e.target.checked })}
            />
            {o.venues.checks[k]}
          </label>
        ))}
        <Field label={o.venues.fields.linkMarking}>
          {canManage ? (
            <Select
              value={marking}
              options={VENUE_LINK_MARKINGS}
              labels={o.venues.markings}
              onChange={(x) => x && setMarking(x)}
            />
          ) : (
            <StatusBadge status={v.linkMarking} labels={o.venues.markings} />
          )}
        </Field>
        {canManage && (
          <Button
            loading={m.busy}
            onClick={() => void save({ checks, linkMarking: marking })}
          >
            {o.common.apply}
          </Button>
        )}
      </Section>

      <Section title={o.venues.evidence}>
        {v.evidence.length === 0 ? (
          <div className="text-sm text-amber-700 dark:text-amber-400">
            {o.venues.evidenceEmpty}
          </div>
        ) : (
          <ul className="text-sm space-y-1">
            {v.evidence.map((e) => (
              <li key={e.id}>
                {o.venues.criteria[e.criterion]} ·{' '}
                <RecordLink section="sources" id={e.sourceId}>
                  {e.sourceId}
                </RecordLink>{' '}
                · {o.venues.checkedAt}: <DateText iso={e.checkedAt} />
              </li>
            ))}
          </ul>
        )}
        {canManage && (
          <ActionBlock title={o.venues.evidenceAdd}>
            <Select
              value={ev.criterion}
              options={VENUE_CRITERIA}
              labels={o.venues.criteria}
              empty={o.common.choose}
              onChange={(x) => setEv({ ...ev, criterion: x })}
            />
            <Field label={o.venues.sourceId}>
              <TextInput
                value={ev.sourceId}
                onChange={(x) => setEv({ ...ev, sourceId: x.trim() })}
              />
            </Field>
            <Field label={o.venues.checkedAt}>
              <TextInput
                type="date"
                value={ev.checkedAt}
                onChange={(x) => setEv({ ...ev, checkedAt: x })}
              />
            </Field>
            <Button
              loading={m.busy}
              disabled={!ev.criterion || !ev.sourceId || !ev.checkedAt}
              onClick={() =>
                ev.criterion &&
                void save({
                  evidence: [
                    {
                      criterion: ev.criterion,
                      sourceId: ev.sourceId,
                      checkedAt: new Date(
                        `${ev.checkedAt}T12:00:00Z`
                      ).toISOString(),
                    },
                  ],
                })
              }
            >
              {o.venues.evidenceAdd}
            </Button>
          </ActionBlock>
        )}
      </Section>

      {canManage && (
        <Section title={o.common.actions}>
          <Field label={o.common.reason}>
            <TextInput value={reason} onChange={setReason} />
          </Field>
          <div className="flex flex-wrap gap-2">
            {v.status === 'candidate' && (
              <Button
                loading={m.busy}
                disabled={v.missingForVerified.length > 0}
                onClick={() => void transition('verified')}
              >
                {o.venues.toVerified}
              </Button>
            )}
            {v.status === 'verified' && (
              <Button
                variant="outline"
                loading={m.busy}
                onClick={() => void transition('candidate')}
              >
                {o.venues.toCandidate}
              </Button>
            )}
            {v.status !== 'rejected' && (
              <ConfirmButton
                loading={m.busy}
                disabled={!reason.trim()}
                onConfirm={() => void transition('rejected')}
              >
                {o.venues.toRejected}
              </ConfirmButton>
            )}
          </div>
          <RecordLink section="purchases" query={{ venueId: v.id }}>
            {o.common.links}: {o.nav.purchases}
          </RecordLink>
        </Section>
      )}
    </div>
  );
}
