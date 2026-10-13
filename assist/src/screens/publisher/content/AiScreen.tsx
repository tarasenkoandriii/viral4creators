import { useState } from 'react';
import { Download } from 'lucide-react';
import { useAsync } from '../../../kit';
import { Alert, Badge, Button, Card } from '../../../kit/ui';
import {
  decodeHelperAnswer,
  latestFlagResolutions,
  type AiCallListItem,
  type EvalResultView,
} from '../../../lib/publisher/ai-api';
import { downloadCsv } from '../../../lib/publisher/common-api';
import {
  GENERATOR_IDS,
  P0_ENABLED_GENERATORS,
  type GeneratorId,
} from '../../../lib/publisher/states';
import {
  actorLabel,
  fmtMicroUsd,
  fmtText,
  statusLabel,
  statusTone,
} from '../../../lib/publisher/view';
import {
  useListFilters,
  useMutation,
  usePubApis,
  usePubContent,
} from '../hooks';
import {
  ConfirmButton,
  DateText,
  EmptyState,
  Field,
  JsonView,
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
  TextArea,
  TextInput,
} from '../parts';
import { usePublisher } from '../publisher-context';
import type { PublisherSectionProps } from '../registry';
import { AcceptCallButton, AiRunner } from './AiRunner';

/**
 * AI (§14.1 AiScreen): журнал вызовов (назначение, версия инструкции,
 * источники, модель, стоимость или «неизвестно»), месячный потолок,
 * внутренний помощник; в рабочем продукте — привязка конфигурации; в
 * eval-продукте — конфигурации, прогоны, разбор автофлагов и оценка 30
 * задач человеком, протокол (`ai/<runId>`).
 */
export function AiScreen({ id, query }: PublisherSectionProps) {
  const { product, can } = usePublisher();
  if (id) return <EvalRunView runId={id} />;
  const evalProduct = product.kind === 'eval';
  return (
    <div className="space-y-4">
      <AiIntro />
      {can('ai.helper') && <HelperCard />}
      {(can('ai.generate') || can('ai.helper')) && (
        <CallsJournal query={query} />
      )}
      {!evalProduct && can('ai.bind') && <BindingsCard />}
      {evalProduct && can('ai.eval.review') && <EvalCard />}
      {!can('ai.generate') && !can('ai.helper') && !can('ai.bind') && (
        <NoPermission />
      )}
    </div>
  );
}

function AiIntro() {
  const { product, t } = usePublisher();
  const c = usePubContent();
  const apis = usePubApis();
  const params = useAsync(
    () => apis.core.parameters(product.id),
    [apis, product.id]
  );
  const cap = params.data?.find((p) => p.key === 'ai_budget_usd_month');
  const micro =
    cap &&
    cap.value &&
    typeof cap.value === 'object' &&
    typeof (cap.value as { microUsd?: unknown }).microUsd === 'number'
      ? String((cap.value as { microUsd: number }).microUsd)
      : null;
  return (
    <Section title={c.ai.title}>
      <p className="text-xs text-silver-500">{c.ai.hint}</p>
      <div className="flex flex-wrap gap-1">
        {GENERATOR_IDS.map((g) => (
          <Badge
            key={g}
            tone={
              (P0_ENABLED_GENERATORS as readonly string[]).includes(g)
                ? 'neutral'
                : 'warning'
            }
          >
            {c.ai.generators[g]}
            {(P0_ENABLED_GENERATORS as readonly string[]).includes(g)
              ? ''
              : ` · ${c.ai.disabledP0}`}
          </Badge>
        ))}
      </div>
      <div className="text-sm">
        <span className="font-medium">{c.ai.capTitle}: </span>
        {cap ? (
          <>
            {fmtText(c.ai.cap, {
              usd: fmtMicroUsd(micro, t.common.unknown),
              status: t.params.statuses[cap.status],
            })}
          </>
        ) : (
          <span className="text-amber-700">{c.ai.capUnknown}</span>
        )}
      </div>
      <div className="text-xs text-silver-500">{c.ai.capNote}</div>
    </Section>
  );
}

function HelperCard() {
  const c = usePubContent();
  const apis = usePubApis();
  const [question, setQuestion] = useState('');
  const [audience, setAudience] = useState<'internal' | 'public' | ''>(
    'internal'
  );
  return (
    <Section title={c.ai.helper}>
      <AiRunner
        generator="pub.helper.answer"
        label={c.ai.helper}
        manualHint={c.ai.manualPath}
        disabled={!question.trim() || !audience}
        extraInput={
          <div className="space-y-2">
            <Field label={c.ai.helperQuestion}>
              <TextArea value={question} onChange={setQuestion} rows={2} />
            </Field>
            <Field label={c.ai.helperAudience}>
              <Select
                value={audience}
                options={['internal', 'public'] as const}
                labels={c.sources.contextAudience}
                onChange={setAudience}
              />
            </Field>
          </div>
        }
        start={(k) =>
          apis.ai.helperAnswer(
            { question: question.trim(), ...(audience ? { audience } : {}) },
            k
          )
        }
        render={(call) => {
          let d: ReturnType<typeof decodeHelperAnswer> | null = null;
          try {
            d = decodeHelperAnswer(call.output);
          } catch {
            d = null;
          }
          if (!d) return <Alert tone="warning">{c.ai.manualPath}</Alert>;
          return (
            <div className="space-y-2 text-sm">
              <div className="whitespace-pre-wrap">{d.answer}</div>
              {d.unknowns.length > 0 && (
                <Alert tone="warning" title={c.ai.unknowns}>
                  <ul className="list-disc pl-5">
                    {d.unknowns.map((u, i) => (
                      <li key={i}>{u}</li>
                    ))}
                  </ul>
                </Alert>
              )}
              <div>
                <b>{c.ai.nextAction}:</b> {d.next_action}
              </div>
              <div className="text-xs text-silver-500">
                {fmtText(c.ai.usedSources, {
                  list: d.used_source_ids.join(', ') || '—',
                })}
              </div>
              <AcceptCallButton call={call} />
            </div>
          );
        }}
      />
    </Section>
  );
}

function CallsJournal({ query }: { query: PublisherSectionProps['query'] }) {
  const { product, t } = usePublisher();
  const c = usePubContent();
  const apis = usePubApis();
  const f = useListFilters('ai', query, ['generator', 'objectId']);
  const q = {
    generator: f.values.generator || undefined,
    objectId: f.values.objectId || undefined,
  };
  const [extra, setExtra] = useState<AiCallListItem[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const list = useAsync(async () => {
    const page = await apis.ai.calls({ ...q, limit: 50 });
    setExtra([]);
    setNext(page.nextBefore);
    return page.items;
  }, [apis, product.id, q.generator, q.objectId]);
  return (
    <Section title={c.ai.journal}>
      <ListToolbar
        csvPath={`products/${product.id}/ai/calls`}
        csvQuery={q}
        extra={
          <>
            <Field label={c.ai.generator}>
              <Select
                value={f.values.generator as GeneratorId | ''}
                options={GENERATOR_IDS}
                labels={c.ai.generators}
                empty="—"
                onChange={(v) => f.set('generator', v)}
              />
            </Field>
            <Field label={c.ai.object}>
              <TextInput
                value={f.values.objectId}
                onChange={(v) => f.set('objectId', v)}
              />
            </Field>
          </>
        }
      />
      <Loadable state={list}>
        {(items) =>
          items.length + extra.length ? (
            <ul className="divide-y divide-silver-200 dark:divide-silver-800">
              {[...items, ...extra].map((x) => (
                <li key={x.callId} className="py-2 space-y-1">
                  <button
                    type="button"
                    className="w-full text-left flex flex-wrap items-center gap-2"
                    onClick={() => setOpen(open === x.callId ? null : x.callId)}
                  >
                    <span className="font-medium">
                      {c.ai.generators[x.generator]}
                    </span>
                    <Badge tone={statusTone(x.status)}>
                      {c.ai.callStatuses[x.status]}
                    </Badge>
                    <span className="text-xs text-silver-500">
                      #{x.attemptNo}
                    </span>
                    <span className="text-xs">
                      {c.ai.cost}:{' '}
                      <span
                        className={
                          x.costMicroUsd === null ? 'text-amber-700' : ''
                        }
                      >
                        {fmtMicroUsd(x.costMicroUsd, t.common.unknown)}
                      </span>{' '}
                      ({c.ai.costStatuses[x.costStatus]})
                    </span>
                  </button>
                  <div className="text-xs text-silver-500 flex flex-wrap gap-3">
                    <span>
                      {c.ai.model}: {x.model}
                    </span>
                    <span>
                      {c.ai.instruction}: {x.instructionVersion}
                    </span>
                    <span>
                      {c.ai.object}: {x.objectRef}
                    </span>
                    <span>
                      {actorLabel(x.requestedBy)} ·{' '}
                      <DateText iso={x.requestedAt} time />
                    </span>
                    {x.errorCode && (
                      <span className="text-rose-600">
                        {c.ai.error}: {x.errorCode}
                      </span>
                    )}
                  </div>
                  {open === x.callId && (
                    <CallDetails callId={x.callId} taskId={x.taskId} />
                  )}
                </li>
              ))}
              <LoadMore
                next={next}
                onMore={async (before) => {
                  const page = await apis.ai.calls({ ...q, before, limit: 50 });
                  setExtra((e) => [...e, ...page.items]);
                  setNext(page.nextBefore);
                }}
              />
            </ul>
          ) : (
            <EmptyState />
          )
        }
      </Loadable>
    </Section>
  );
}

function CallDetails({ callId, taskId }: { callId: string; taskId: string }) {
  const c = usePubContent();
  const apis = usePubApis();
  const call = useAsync(() => apis.ai.call(callId), [apis, callId]);
  const task = useAsync(() => apis.ai.task(taskId), [apis, taskId]);
  return (
    <Card className="space-y-2">
      <Loadable state={call}>
        {(x) => (
          <div className="space-y-1 text-sm">
            <div className="text-xs text-silver-500">
              {fmtText(c.ai.contextSources, {
                list: x.contextSourceIds.join(', ') || '—',
              })}
            </div>
            <div className="text-xs text-silver-500">
              {fmtText(c.ai.contextFacts, {
                list: x.contextFactIds.join(', ') || '—',
              })}
            </div>
            {x.findings.length > 0 && (
              <ul className="list-disc pl-5 text-amber-700">
                {x.findings.map((f, i) => (
                  <li key={i}>{f.text}</li>
                ))}
              </ul>
            )}
            {x.output !== null && <JsonView value={x.output} />}
          </div>
        )}
      </Loadable>
      <Loadable state={task}>
        {(tk) => (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <StatusBadge status={tk.status} labels={c.ai.taskStatuses} />
            {fmtText(c.ai.task, {
              used: tk.generationsUsed,
              remaining: tk.remaining,
            })}
          </div>
        )}
      </Loadable>
    </Card>
  );
}

function BindingsCard() {
  const c = usePubContent();
  const apis = usePubApis();
  const b = useAsync(() => apis.ai.bindings(), [apis]);
  const [basis, setBasis] = useState('');
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const m = useMutation();
  return (
    <Section title={c.ai.bindings}>
      <p className="text-xs text-silver-500">{c.ai.bindingsHint}</p>
      <Notice text={notice} />
      <Loadable state={b}>
        {(data) => {
          const active = data.items.filter((x) => x.active);
          return (
            <div className="space-y-3">
              {active.length === 0 && (
                <Alert tone="warning">{c.ai.noBinding}</Alert>
              )}
              {data.items.map((x) => (
                <div key={x.id} className="text-sm space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="text-xs break-all">
                      {x.config?.configHash.slice(0, 12) ?? x.configId}
                    </code>
                    <span>
                      {x.config?.provider} {x.config?.model}
                    </span>
                    {x.config && (
                      <StatusBadge
                        status={x.config.evalStatus}
                        labels={c.ai.evalStatuses}
                      />
                    )}
                    <Badge tone={x.active ? 'success' : 'neutral'}>
                      {x.active ? c.ai.bind : c.ai.unbind}
                    </Badge>
                  </div>
                  <div className="text-xs text-silver-500">
                    {x.basis} · <DateText iso={x.boundAt} />
                  </div>
                  {x.active && (
                    <div className="flex flex-wrap gap-2">
                      <TextInput
                        value={reason}
                        onChange={setReason}
                        placeholder={c.ai.unbindReason}
                        maxLength={500}
                      />
                      <ConfirmButton
                        loading={m.busy}
                        disabled={!reason.trim()}
                        onConfirm={async () => {
                          const r = await m.run((k) =>
                            apis.ai.unbind(x.id, reason.trim(), k)
                          );
                          if (r) {
                            setNotice(c.ai.unbound);
                            b.reload();
                          }
                        }}
                      >
                        {c.ai.unbind}
                      </ConfirmButton>
                    </div>
                  )}
                </div>
              ))}
              <div className="font-medium text-sm">{c.ai.available}</div>
              {data.available.length === 0 ? (
                <EmptyState />
              ) : (
                <>
                  <TextInput
                    value={basis}
                    onChange={setBasis}
                    placeholder={c.ai.bindBasis}
                    maxLength={1000}
                  />
                  {data.available.map((cfg) => (
                    <div
                      key={cfg.id}
                      className="flex flex-wrap items-center gap-2 text-sm"
                    >
                      <code className="text-xs break-all">
                        {cfg.configHash.slice(0, 12)}
                      </code>
                      <span>
                        {cfg.provider} {cfg.model}
                      </span>
                      <StatusBadge
                        status={cfg.evalStatus}
                        labels={c.ai.evalStatuses}
                      />
                      <Button
                        variant="outline"
                        loading={m.busy}
                        disabled={!basis.trim()}
                        onClick={async () => {
                          const r = await m.run((k) =>
                            apis.ai.bind(cfg.id, basis.trim(), k)
                          );
                          if (r) {
                            setNotice(c.ai.bound);
                            b.reload();
                          }
                        }}
                      >
                        {c.ai.bind}
                      </Button>
                    </div>
                  ))}
                </>
              )}
            </div>
          );
        }}
      </Loadable>
      <PubErrorAlert error={m.error} onReload={b.reload} />
    </Section>
  );
}

function EvalCard() {
  const { can } = usePublisher();
  const c = usePubContent();
  const apis = usePubApis();
  const configs = useAsync(() => apis.ai.configs(), [apis]);
  const runs = useAsync(() => apis.ai.evalRuns(), [apis]);
  return (
    <>
      <Section title={c.ai.configs}>
        <Loadable state={configs}>
          {(items) =>
            items.length ? (
              <ul className="divide-y divide-silver-200 dark:divide-silver-800">
                {items.map((cfg) => (
                  <ConfigRow
                    key={cfg.id}
                    cfg={cfg}
                    canDecide={can('ai.bind')}
                    onChanged={configs.reload}
                  />
                ))}
              </ul>
            ) : (
              <EmptyState />
            )
          }
        </Loadable>
      </Section>
      <Section title={c.ai.runs}>
        <Loadable state={runs}>
          {(items) =>
            items.length ? (
              <ul className="space-y-1">
                {items.map((r) => (
                  <li
                    key={r.id}
                    className="flex flex-wrap items-center gap-2 text-sm"
                  >
                    <RecordLink section="ai" id={r.id}>
                      {fmtText(c.ai.run, { id: r.id.slice(-8) })}
                    </RecordLink>
                    <Badge tone={r.mode === 'live' ? 'accent' : 'neutral'}>
                      {c.ai.runModes[r.mode]}
                    </Badge>
                    <DateText iso={r.startedAt} time />
                    {!r.finishedAt && (
                      <Badge tone="warning">{c.ai.callStatuses.running}</Badge>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState />
            )
          }
        </Loadable>
      </Section>
    </>
  );
}

function ConfigRow({
  cfg,
  canDecide,
  onChanged,
}: {
  cfg: Awaited<
    ReturnType<ReturnType<typeof usePubApis>['ai']['configs']>
  >[number];
  canDecide: boolean;
  onChanged: () => void;
}) {
  const c = usePubContent();
  const apis = usePubApis();
  const [status, setStatus] = useState<'passed' | 'failed' | 'blocked' | ''>(
    ''
  );
  const [runId, setRunId] = useState('');
  const [basis, setBasis] = useState('');
  const m = useMutation();
  return (
    <li className="py-2 space-y-1">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <code className="text-xs break-all">{cfg.configHash.slice(0, 12)}</code>
        <span>
          {cfg.provider} {cfg.model}
        </span>
        <StatusBadge status={cfg.evalStatus} labels={c.ai.evalStatuses} />
        <span className="text-xs text-silver-500">{cfg.evalSetVersion}</span>
      </div>
      {cfg.basis && <div className="text-xs text-silver-500">{cfg.basis}</div>}
      {canDecide && cfg.evalStatus === 'not_run' && (
        <div className="grid gap-2 md:grid-cols-3 items-end">
          <Field label={c.ai.decision}>
            <Select
              value={status}
              options={['passed', 'failed', 'blocked'] as const}
              labels={c.ai.evalStatuses}
              empty="—"
              onChange={setStatus}
            />
          </Field>
          <Field label={c.ai.evalRunId}>
            <select
              className="w-full rounded-lg border border-silver-300 dark:border-silver-700 bg-transparent px-3 py-2 min-h-[44px] text-sm"
              value={runId}
              onChange={(e) => setRunId(e.target.value)}
            >
              <option value="">—</option>
              {cfg.runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {c.ai.runModes[r.mode]} · {r.id.slice(-8)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={c.ai.bindBasis}>
            <TextInput value={basis} onChange={setBasis} maxLength={1000} />
          </Field>
          <PubErrorAlert error={m.error} onReload={onChanged} />
          <Button
            loading={m.busy}
            disabled={
              !status || !basis.trim() || (status === 'passed' && !runId)
            }
            onClick={async () => {
              if (!status) return;
              const r = await m.run((k) =>
                apis.ai.configDecision(
                  cfg.id,
                  {
                    evalStatus: status,
                    basis: basis.trim(),
                    ...(runId ? { evalRunId: runId } : {}),
                  },
                  k
                )
              );
              if (r) onChanged();
            }}
          >
            {c.ai.decision}
          </Button>
        </div>
      )}
    </li>
  );
}

/** Разбор прогона: автофлаги и оценка человека по каждой задаче. */
function EvalRunView({ runId }: { runId: string }) {
  const { product, can } = usePublisher();
  const c = usePubContent();
  const apis = usePubApis();
  const proto = useAsync(
    async () => (product.kind === 'eval' ? apis.ai.evalRun(runId) : null),
    [apis, runId, product.kind]
  );
  const md = useMutation();
  if (product.kind !== 'eval')
    return <Alert tone="neutral">{c.ai.noEval}</Alert>;
  return (
    <div className="space-y-4">
      <Section
        title={fmtText(c.ai.run, { id: runId.slice(-8) })}
        action={
          <Button
            variant="outline"
            icon={<Download size={16} />}
            loading={md.busy}
            onClick={async () => {
              const f = await md.run(() => apis.ai.protocolMd(runId));
              if (f) downloadCsv(f);
            }}
          >
            {c.ai.protocol}
          </Button>
        }
      >
        <PubErrorAlert error={md.error} />
        <Loadable state={proto}>
          {(p) => (p ? <JsonView value={p.totals} /> : null)}
        </Loadable>
      </Section>
      <Loadable state={proto}>
        {(p) =>
          p ? (
            <div className="space-y-3">
              {p.tasks.map((task) => (
                <Section
                  key={task.code}
                  title={fmtText(c.ai.taskCode, { code: task.code })}
                >
                  <div className="text-xs text-silver-500">
                    {task.group} · {task.schema} ·{' '}
                    {statusLabel(task.generator, c.ai.generators)}
                  </div>
                  {task.results.length === 0 ? (
                    <EmptyState />
                  ) : (
                    task.results.map((r) => (
                      <EvalResultCard
                        key={r.id}
                        runId={runId}
                        result={r}
                        canReview={can('ai.eval.review')}
                        onChanged={proto.reload}
                      />
                    ))
                  )}
                </Section>
              ))}
            </div>
          ) : null
        }
      </Loadable>
    </div>
  );
}

function EvalResultCard({
  runId,
  result: r,
  canReview,
  onChanged,
}: {
  runId: string;
  result: EvalResultView;
  canReview: boolean;
  onChanged: () => void;
}) {
  const { t } = usePublisher();
  const c = usePubContent();
  const apis = usePubApis();
  const decided = latestFlagResolutions(r);
  const [explanation, setExplanation] = useState(r.explanation ?? '');
  const [critical, setCritical] = useState<boolean>(r.criticalPass ?? false);
  const [useful, setUseful] = useState<boolean>(r.usefulnessPass ?? false);
  const [flagNote, setFlagNote] = useState('');
  const m = useMutation();
  return (
    <Card className="space-y-2">
      <div className="text-xs text-silver-500">
        {c.ai.cost}: {fmtMicroUsd(r.costMicroUsd, t.common.unknown)} ·{' '}
        <DateText iso={r.createdAt} time />
      </div>
      <div className="text-xs font-medium">{c.ai.firstAnswer}</div>
      <JsonView value={r.firstAnswer ?? r.firstAnswerRaw} />
      {r.autoHardFail.length > 0 && (
        <Alert tone="danger" title={c.ai.hardFails}>
          <ul className="list-disc pl-5">
            {r.autoHardFail.map((h, i) => (
              <li key={i}>
                <code className="break-all">{h.code}</code>: {h.text}
              </li>
            ))}
          </ul>
        </Alert>
      )}
      {r.autoFlags.length > 0 && (
        <div className="space-y-1">
          <div className="text-xs font-medium">{c.ai.flags}</div>
          {canReview && (
            <TextInput
              value={flagNote}
              onChange={setFlagNote}
              placeholder={c.ai.explanation}
              maxLength={1000}
            />
          )}
          {r.autoFlags.map((f) => {
            const d = decided.get(f.id);
            return (
              <div
                key={f.id}
                className="flex flex-wrap items-center gap-2 text-sm"
              >
                <code className="text-xs break-all">{f.code}</code>
                <span className="flex-1 min-w-0">{f.text}</span>
                {d ? (
                  <Badge
                    tone={d.resolution === 'confirmed' ? 'danger' : 'neutral'}
                  >
                    {d.resolution === 'confirmed'
                      ? c.ai.flagConfirmed
                      : c.ai.flagDismissed}
                  </Badge>
                ) : (
                  <Badge tone="warning">{c.ai.flagResolve}</Badge>
                )}
                {canReview &&
                  (['confirmed', 'dismissed'] as const).map((res) => (
                    <Button
                      key={res}
                      variant="ghost"
                      loading={m.busy}
                      disabled={!flagNote.trim()}
                      onClick={async () => {
                        const out = await m.run((k) =>
                          apis.ai.resolveFlag(
                            runId,
                            r.id,
                            f.id,
                            { resolution: res, explanation: flagNote.trim() },
                            k
                          )
                        );
                        if (out) onChanged();
                      }}
                    >
                      {res === 'confirmed'
                        ? c.ai.flagConfirmed
                        : c.ai.flagDismissed}
                    </Button>
                  ))}
              </div>
            );
          })}
        </div>
      )}
      <div className="text-xs font-medium">{c.ai.review}</div>
      {r.criticalPass !== null && (
        <div className="text-xs">
          {c.ai.criticalPass}: {r.criticalPass ? t.common.yes : t.common.no} ·{' '}
          {c.ai.usefulnessPass}: {r.usefulnessPass ? t.common.yes : t.common.no}
          {r.reviewerMemberId
            ? ` · ${c.ai.reviewer}: ${r.reviewerMemberId}`
            : ''}
        </div>
      )}
      {canReview && (
        <div className="space-y-2">
          <label className="text-sm flex items-center gap-2">
            <input
              type="checkbox"
              checked={critical}
              onChange={(e) => setCritical(e.target.checked)}
            />
            {c.ai.criticalPass}
          </label>
          <label className="text-sm flex items-center gap-2">
            <input
              type="checkbox"
              checked={useful}
              onChange={(e) => setUseful(e.target.checked)}
            />
            {c.ai.usefulnessPass}
          </label>
          <TextArea
            value={explanation}
            onChange={setExplanation}
            rows={2}
            placeholder={c.ai.explanation}
          />
          <Button
            variant="outline"
            loading={m.busy}
            disabled={!explanation.trim()}
            onClick={async () => {
              const out = await m.run((k) =>
                apis.ai.reviewResult(
                  runId,
                  r.id,
                  {
                    criticalPass: critical,
                    usefulnessPass: useful,
                    explanation: explanation.trim(),
                  },
                  k
                )
              );
              if (out) onChanged();
            }}
          >
            {c.ai.review}
          </Button>
        </div>
      )}
      <PubErrorAlert error={m.error} onReload={onChanged} />
    </Card>
  );
}
