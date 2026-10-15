import { useState } from 'react';
import { useAsync } from '../../../kit';
import { Alert, Badge, Button, Card } from '../../../kit/ui';
import type {
  ParameterDecisionView,
  ParameterProposalView,
  ParameterView,
} from '../../../lib/publisher/core-api';
import {
  DEPENDENT_STAGES,
  PARAMETER_GROUPS,
  PARAMETER_STATUSES,
  type DependentStage,
  type ParameterGroup,
} from '../../../lib/publisher/states';
import { actorLabel, fmtText, statusLabel } from '../../../lib/publisher/view';
import { useMutation, usePubApis } from '../hooks';
import {
  DateText,
  EmptyState,
  Field,
  JsonView,
  Loadable,
  LoadMore,
  Notice,
  PubErrorAlert,
  Section,
  Select,
  StatusBadge,
  TextArea,
  TextInput,
} from '../parts';
import { usePublisher } from '../publisher-context';
import type { PublisherSectionProps } from '../registry';

/**
 * «Запуск» (§14.1 LaunchScreen; ТЗ Р-PUB-0 №4): параметры по группам со
 * статусами «не утверждено/утверждено/отклонено», открытые предложения,
 * предложение значения (PO, AN, AD), решение владельца с основанием (PO),
 * журнал решений. Статус `assumption` никогда не зелёный.
 */
export function LaunchScreen({ query }: PublisherSectionProps) {
  const { product, t, can } = usePublisher();
  const apis = usePubApis();
  const params = useAsync(
    () => apis.core.parameters(product.id),
    [apis, product.id]
  );
  const [statusFilter, setStatusFilter] = useState<string>(query.status ?? '');
  const [open, setOpen] = useState<string | null>(query.key ?? null);

  return (
    <div className="space-y-4">
      <Alert tone="neutral" title={t.params.title}>
        {t.params.hint}
      </Alert>
      <div className="flex flex-wrap gap-2 items-end">
        <Field label={t.common.status}>
          <Select
            value={statusFilter}
            options={PARAMETER_STATUSES}
            labels={t.params.statuses}
            empty={t.common.all}
            onChange={setStatusFilter}
          />
        </Field>
      </div>
      {!can('parameter.propose') && (
        <Alert tone="neutral">{t.params.noPropose}</Alert>
      )}
      <Loadable state={params}>
        {(items) => {
          const byKey = new Map(items.map((p) => [p.key, p]));
          return (
            <div className="space-y-4">
              {(Object.keys(PARAMETER_GROUPS) as ParameterGroup[]).map((g) => {
                const rows = PARAMETER_GROUPS[g]
                  .map((k) => byKey.get(k))
                  .filter((p): p is ParameterView => !!p)
                  .filter((p) => !statusFilter || p.status === statusFilter);
                if (!rows.length) return null;
                return (
                  <Section key={g} title={t.params.groups[g]}>
                    <ul className="divide-y divide-silver-200 dark:divide-silver-800">
                      {rows.map((p) => (
                        <li key={p.key} className="py-2 space-y-2">
                          <button
                            type="button"
                            className="w-full text-left flex flex-wrap items-center gap-2"
                            onClick={() =>
                              setOpen(open === p.key ? null : p.key)
                            }
                          >
                            <span className="font-medium flex-1 min-w-0">
                              {statusLabel(p.key, t.params.keys)}
                            </span>
                            <StatusBadge
                              status={p.status}
                              labels={t.params.statuses}
                            />
                            <span className="text-xs text-silver-500">
                              {fmtText(t.params.version, { n: p.version })}
                            </span>
                            {p.openProposals > 0 && (
                              <Badge tone="warning">
                                {fmtText(t.params.openProposals, {
                                  n: p.openProposals,
                                })}
                              </Badge>
                            )}
                          </button>
                          {p.gates.length > 0 && (
                            <div className="text-xs text-silver-500">
                              {fmtText(t.params.gatesOfKey, {
                                list: p.gates
                                  .map((x) => t.gates.names[x])
                                  .join(', '),
                              })}
                            </div>
                          )}
                          {open === p.key && (
                            <ParameterEditor
                              param={p}
                              onChanged={() => {
                                params.reload();
                              }}
                            />
                          )}
                        </li>
                      ))}
                    </ul>
                  </Section>
                );
              })}
              {items.length === 0 && <EmptyState />}
            </div>
          );
        }}
      </Loadable>
      <DecisionsJournal keyFilter={open} />
    </div>
  );
}

function ParameterEditor({
  param,
  onChanged,
}: {
  param: ParameterView;
  onChanged: () => void;
}) {
  const { product, t, can, reloadProduct } = usePublisher();
  const apis = usePubApis();
  const [json, setJson] = useState(() => JSON.stringify(param.value, null, 2));
  const [jsonError, setJsonError] = useState(false);
  const [proposalId, setProposalId] = useState('');
  const [toStatus, setToStatus] = useState<
    'approved' | 'rejected' | 'revoked' | 'assumption' | ''
  >('approved');
  const [basis, setBasis] = useState('');
  // Гейты ключа — подмножество этапов (GateName ⊂ DependentStage).
  const [stages, setStages] = useState<DependentStage[]>(() => [
    ...param.gates,
  ]);
  const [notice, setNotice] = useState<string | null>(null);
  const propose = useMutation();
  const decide = useMutation();

  return (
    <Card className="space-y-3">
      <div>
        <div className="text-xs text-silver-500 mb-1">{t.params.value}</div>
        <JsonView value={param.value} />
        {param.approvedAt && (
          <div className="text-xs text-silver-500 mt-1">
            {t.params.statuses.approved}:{' '}
            <DateText iso={param.approvedAt} time />
          </div>
        )}
      </div>
      <Notice text={notice} />
      <ProposalsList
        param={param}
        onChanged={onChanged}
        onUse={can('parameter.decide') ? setProposalId : undefined}
      />
      {can('parameter.propose') && (
        <div className="space-y-2">
          <Field label={t.params.propose} hint={t.params.proposeHint}>
            <TextArea value={json} onChange={setJson} rows={6} />
          </Field>
          {jsonError && <Alert tone="danger">{t.params.jsonInvalid}</Alert>}
          <PubErrorAlert error={propose.error} onReload={onChanged} />
          <Button
            variant="outline"
            loading={propose.busy}
            onClick={async () => {
              let value: unknown;
              try {
                value = JSON.parse(json);
                setJsonError(false);
              } catch {
                setJsonError(true);
                return;
              }
              const r = await propose.run((k) =>
                apis.core.propose(product.id, param.key, value, k)
              );
              if (r) {
                setProposalId(r.proposalId);
                setNotice(t.params.proposed);
                onChanged();
              }
            }}
          >
            {t.params.propose}
          </Button>
        </div>
      )}
      {can('parameter.decide') ? (
        <div className="space-y-2 border-t border-silver-200 dark:border-silver-800 pt-3">
          <div className="font-medium">{t.params.decide}</div>
          <p className="text-xs text-silver-500">{t.params.decideHint}</p>
          <Field label={t.params.toStatus}>
            <Select
              value={toStatus}
              options={
                ['approved', 'rejected', 'revoked', 'assumption'] as const
              }
              labels={t.params.toStatuses}
              onChange={setToStatus}
            />
          </Field>
          <Field label={t.params.proposalId}>
            <TextInput value={proposalId} onChange={setProposalId} />
          </Field>
          <Field label={t.params.basis}>
            <TextArea value={basis} onChange={setBasis} maxLength={2000} />
          </Field>
          <fieldset className="space-y-1">
            <legend className="text-xs text-silver-500">
              {t.params.stages}
            </legend>
            <div className="flex flex-wrap gap-3">
              {DEPENDENT_STAGES.map((s) => (
                <label key={s} className="text-sm flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={stages.includes(s)}
                    onChange={(e) =>
                      setStages((x) =>
                        e.target.checked ? [...x, s] : x.filter((y) => y !== s)
                      )
                    }
                  />
                  {s === 'reports' ? t.params.stageReports : t.gates.names[s]}
                </label>
              ))}
            </div>
          </fieldset>
          <PubErrorAlert error={decide.error} onReload={onChanged} />
          <Button
            loading={decide.busy}
            disabled={!toStatus || !basis.trim()}
            onClick={async () => {
              if (!toStatus) return;
              const r = await decide.run((k) =>
                apis.core.decide(
                  product.id,
                  param.key,
                  {
                    toStatus,
                    proposalId: proposalId.trim() || null,
                    basis: basis.trim(),
                    dependentStages: stages,
                    expectedRevision: param.revision,
                  },
                  k
                )
              );
              if (r) {
                setNotice(t.params.decided);
                setBasis('');
                onChanged();
                reloadProduct();
              }
            }}
          >
            {t.params.decide}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-silver-500">{t.params.onlyPo}</p>
      )}
    </Card>
  );
}

/**
 * Предложения ключа (`GET …/parameters/:key/proposals`, Р-PUB-Z2-6): автор,
 * статус, значение; «Отозвать» — только при `canWithdraw` (правило сервера:
 * своё или — владельцу продукта/админу — чужое открытое); «Выбрать для
 * решения» подставляет id в форму решения владельца.
 */
function ProposalsList({
  param,
  onChanged,
  onUse,
}: {
  param: ParameterView;
  onChanged: () => void;
  onUse?: (id: string) => void;
}) {
  const { product, t } = usePublisher();
  const apis = usePubApis();
  const withdraw = useMutation();
  const [extra, setExtra] = useState<ParameterProposalView[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const list = useAsync(async () => {
    const page = await apis.core.proposals(product.id, param.key, {
      limit: 20,
    });
    setExtra([]);
    setNext(page.nextBefore);
    return page.items;
  }, [apis, product.id, param.key, param.revision, param.openProposals]);
  return (
    <div className="space-y-1">
      <div className="text-xs text-silver-500">{t.params.proposals}</div>
      <PubErrorAlert error={withdraw.error} onReload={onChanged} />
      <Loadable state={list}>
        {(items) =>
          items.length + extra.length ? (
            <ul className="divide-y divide-silver-200 dark:divide-silver-800 text-sm">
              {[...items, ...extra].map((x) => (
                <li key={x.id} className="py-2 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge
                      status={x.status}
                      labels={t.params.proposalStatuses}
                    />
                    {x.mine && (
                      <Badge tone="neutral">{t.params.proposalMine}</Badge>
                    )}
                    <span className="text-xs text-silver-500">
                      {t.params.proposalBy}{' '}
                      {actorLabel(x.proposedBy, t.common.adminActor)} ·{' '}
                      <DateText iso={x.proposedAt} time />
                    </span>
                  </div>
                  <JsonView value={x.value} />
                  <div className="flex flex-wrap gap-2">
                    {x.canWithdraw && (
                      <Button
                        variant="ghost"
                        loading={withdraw.busy}
                        onClick={async () => {
                          const r = await withdraw.run((k) =>
                            apis.core.withdraw(product.id, param.key, x.id, k)
                          );
                          if (r) onChanged();
                        }}
                      >
                        {t.params.withdraw}
                      </Button>
                    )}
                    {onUse && x.status === 'open' && (
                      <Button variant="outline" onClick={() => onUse(x.id)}>
                        {t.params.useProposal}
                      </Button>
                    )}
                  </div>
                </li>
              ))}
              <LoadMore
                next={next}
                onMore={async (before) => {
                  const page = await apis.core.proposals(
                    product.id,
                    param.key,
                    {
                      before,
                      limit: 20,
                    }
                  );
                  setExtra((y) => [...y, ...page.items]);
                  setNext(page.nextBefore);
                }}
              />
            </ul>
          ) : (
            <EmptyState>{t.params.proposalsEmpty}</EmptyState>
          )
        }
      </Loadable>
    </div>
  );
}

function DecisionsJournal({ keyFilter }: { keyFilter: string | null }) {
  const { product, t } = usePublisher();
  const apis = usePubApis();
  const [extra, setExtra] = useState<ParameterDecisionView[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const list = useAsync(async () => {
    const page = await apis.core.decisions(product.id, {
      key: keyFilter ?? undefined,
      limit: 30,
    });
    setExtra([]);
    setNext(page.nextBefore);
    return page.items;
  }, [apis, product.id, keyFilter]);
  return (
    <Section
      title={
        keyFilter
          ? `${t.params.journal}: ${statusLabel(keyFilter, t.params.keys)}`
          : t.params.journal
      }
    >
      <Loadable state={list}>
        {(items) =>
          items.length + extra.length ? (
            <ul className="divide-y divide-silver-200 dark:divide-silver-800 text-sm">
              {[...items, ...extra].map((d) => (
                <li key={d.id} className="py-2 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">
                      {statusLabel(d.parameterKey, t.params.keys)}
                    </span>
                    <span className="text-xs text-silver-500">
                      {t.params.from} {t.params.statuses[d.fromStatus]} →{' '}
                      {t.params.to}
                    </span>
                    <StatusBadge
                      status={d.toStatus}
                      labels={t.params.statuses}
                    />
                    <span className="text-xs text-silver-500">
                      {fmtText(t.params.version, { n: d.version })}
                    </span>
                  </div>
                  <div className="text-xs text-silver-500">
                    {actorLabel(d.decidedBy, t.common.adminActor)} ·{' '}
                    <DateText iso={d.decidedAt} time />
                  </div>
                  <div>{d.basis}</div>
                </li>
              ))}
              <LoadMore
                next={next}
                onMore={async (before) => {
                  const page = await apis.core.decisions(product.id, {
                    key: keyFilter ?? undefined,
                    before,
                    limit: 30,
                  });
                  setExtra((x) => [...x, ...page.items]);
                  setNext(page.nextBefore);
                }}
              />
            </ul>
          ) : (
            <EmptyState>{t.params.journalEmpty}</EmptyState>
          )
        }
      </Loadable>
    </Section>
  );
}
