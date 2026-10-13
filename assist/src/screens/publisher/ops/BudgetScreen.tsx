/**
 * F12 — бюджет (P-G2, §14.1 `budget`, `budget/:expenseId`): лимит,
 * net_paid, open_commitment, delivered_unpaid (внутри, не вычитается
 * второй раз), защищённый резерв, доступно; 80 %/100 %; касса отдельно от
 * экономики; переводы из резерва (решение владельца продукта); расходы и
 * записи движения со сверкой «ожидает/неизвестно» (AT-F12-01, AT-CORE-15,
 * AT-CORE-17).
 */
import { useState } from 'react';
import { Alert, Badge, Button, ScreenTitle } from '../../../kit/ui';
import { useAsync } from '../../../kit';
import {
  EXPENSE_CATEGORIES,
  EXPENSE_STATUSES,
  RESERVE_CATEGORIES,
  type BudgetView,
  type ExpenseEntryView,
  type ExpenseView,
  type ReserveCategory,
} from '../../../lib/publisher/distribution-api';
import {
  budgetFormulaHolds,
  budgetRows,
  budgetTone,
  paymentTone,
  usagePct,
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
  Notice,
  PubErrorAlert,
  RecordLink,
  Row,
  Section,
  Select,
  StatusBadge,
  TextInput,
} from '../parts';
import type { PublisherSectionProps } from '../registry';
import {
  ActionBlock,
  KindBadge,
  ListRow,
  MoneyInput,
  PagedFooter,
} from './ops-parts';
import { useOps, usePaged } from './ops-hooks';

export function BudgetSection({ id, query }: PublisherSectionProps) {
  const { o } = useOps();
  if (id) {
    return (
      <div className="space-y-4">
        <RecordLink section="budget">{o.common.back}</RecordLink>
        <ExpensePanel expenseId={id} />
      </div>
    );
  }
  return <BudgetOverview query={query} />;
}

function BudgetOverview({ query }: { query: PublisherSectionProps['query'] }) {
  const { o, dist, pid } = useOps();
  const state = useAsync(() => dist.budget(pid), [pid]);
  return (
    <div className="space-y-4">
      <ScreenTitle>{o.budget.title}</ScreenTitle>
      <p className="text-sm text-silver-500">{o.budget.intro}</p>
      <Loadable state={state}>
        {(b) => <BudgetNumbers b={b} onChange={(x) => state.setData(x)} />}
      </Loadable>
      <ExpensesList query={query} />
    </div>
  );
}

function BudgetNumbers({
  b,
  onChange,
}: {
  b: BudgetView;
  onChange: (b: BudgetView) => void;
}) {
  const { o, locale, can, dist, pid } = useOps();
  const rows = budgetRows(b);
  const holds = budgetFormulaHolds(b);
  const cur = b.currency;
  const m = useMutation();
  const [to, setTo] = useState<ReserveCategory | ''>('');
  const [amount, setAmount] = useState({
    raw: '',
    minor: null as string | null,
  });
  const [basis, setBasis] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const labels: Record<(typeof rows)[number]['key'], string> = {
    total: o.budget.total,
    netPaid: o.budget.netPaid,
    openCommitment: o.budget.openCommitment,
    deliveredUnpaid: o.budget.deliveredUnpaid,
    protectedReserve: o.budget.protectedReserve,
    available: o.budget.available,
  };
  return (
    <>
      {!b.built && <Alert tone="danger">{o.budget.notBuilt}</Alert>}
      {b.warnings.map((w) => (
        <Alert key={w} tone={w === 'warn_80' ? 'warning' : 'danger'}>
          {o.budget.warnings[w]}
        </Alert>
      ))}
      <Section
        title={o.budget.title}
        action={
          <Badge tone={budgetTone(b)}>
            {fmtText(o.budget.usage, {
              pct: b.built ? usagePct(b.usageBp, locale) : o.common.unknown,
            })}
          </Badge>
        }
      >
        <table className="w-full text-sm" data-budget="">
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.key}
                className={
                  r.key === 'available'
                    ? 'font-semibold border-t border-silver-300 dark:border-silver-700'
                    : ''
                }
              >
                <td
                  className={`py-1 ${r.nested ? 'pl-6 text-silver-500' : ''}`}
                >
                  <span className="mr-1 text-silver-500">
                    {r.sign === 'in' ? '⊂' : r.sign}
                  </span>
                  {labels[r.key]}
                  {r.nested && (
                    <div className="text-xs">
                      {o.budget.deliveredUnpaidHint}
                    </div>
                  )}
                </td>
                <td className="py-1 text-right whitespace-nowrap">
                  <MoneyText minor={r.minor} currency={cur} />
                </td>
                <td className="py-1 pl-2 text-right">
                  <KindBadge kind={r.kind} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {holds === false && (
          <Alert tone="warning">{o.budget.formulaMismatch}</Alert>
        )}
        <p className="text-xs text-silver-500">{o.common.kindHint}</p>
        <Row label={o.budget.perPurchaseMax}>
          <MoneyText minor={b.built ? b.perPurchaseMax : null} currency={cur} />
        </Row>
        <div className="text-xs text-silver-500">
          {fmtText(o.budget.paramVersion, { n: b.paramVersion })}
        </div>
      </Section>

      <Section title={o.budget.categories}>
        {RESERVE_CATEGORIES.map((c) => (
          <div key={c} className="text-sm">
            <div className="font-medium">{o.budget.category[c]}</div>
            <div className="text-xs text-silver-500 flex flex-wrap gap-x-3">
              <span>
                {o.budget.used}:{' '}
                <MoneyText
                  minor={b.built ? b.byCategory[c].used : null}
                  currency={cur}
                />
              </span>
              <span>
                {o.budget.limit}:{' '}
                <MoneyText
                  minor={b.built ? b.byCategory[c].limit : null}
                  currency={cur}
                />
              </span>
              <span>
                {o.budget.available}:{' '}
                <MoneyText
                  minor={b.built ? b.byCategory[c].available : null}
                  currency={cur}
                />
              </span>
            </div>
          </div>
        ))}
      </Section>

      <Section title={o.budget.cashTitle}>
        <Row label={o.budget.cashPaid}>
          <MoneyText minor={b.cash.paid} currency={cur} />{' '}
          <KindBadge kind="fact" />
        </Row>
        <Row label={o.budget.economicDelivered}>
          <MoneyText minor={b.cash.economicDelivered} currency={cur} />{' '}
          <KindBadge kind="fact" />
        </Row>
        <Row label={o.budget.advances}>
          <MoneyText minor={b.cash.advances} currency={cur} />
        </Row>
      </Section>

      {can('budget.reserve_release') && (
        <RebuildCounters
          urgent={
            b.reconcileStopped || b.warnings.includes('reconcile_stopped')
          }
          onChange={onChange}
        />
      )}
      <Section title={o.budget.reserveMoves}>
        {b.reserveMoves.length === 0 ? (
          <div className="text-sm text-silver-500">
            {o.budget.reserveMovesEmpty}
          </div>
        ) : (
          <ul className="text-sm space-y-1">
            {b.reserveMoves.map((mv) => (
              <li key={mv.id}>
                <DateText iso={mv.movedAt} time /> →{' '}
                {o.budget.category[mv.toCategory]}:{' '}
                <MoneyText minor={mv.amountMinor} currency={cur} />
              </li>
            ))}
          </ul>
        )}
        {can('budget.reserve_release') ? (
          <ActionBlock title={o.budget.release}>
            <p className="text-xs text-silver-500">{o.budget.releaseHint}</p>
            <Field label={o.budget.toCategory}>
              <Select
                value={to}
                options={RESERVE_CATEGORIES}
                labels={o.budget.category}
                empty={o.common.choose}
                onChange={setTo}
              />
            </Field>
            <Field label={o.common.amount}>
              <MoneyInput
                value={amount.raw}
                onChange={(raw, minor) => setAmount({ raw, minor })}
              />
            </Field>
            <Field label={o.common.basis}>
              <TextInput value={basis} onChange={setBasis} />
            </Field>
            <PubErrorAlert error={m.error} />
            <Notice text={done} />
            <Button
              loading={m.busy}
              disabled={
                !to ||
                !amount.minor ||
                amount.minor === '0' ||
                basis.trim().length < 10
              }
              onClick={async () => {
                if (!to || !amount.minor) return;
                setDone(null);
                const x = await m.run((k) =>
                  dist.reserveRelease(pid, k, {
                    toCategory: to,
                    amountMinor: amount.minor as string,
                    basis: basis.trim(),
                  })
                );
                if (x) {
                  onChange(x);
                  setDone(o.common.done);
                }
              }}
            >
              {o.budget.release}
            </Button>
          </ActionBlock>
        ) : null}
      </Section>
    </>
  );
}

function ExpensesList({ query }: { query: PublisherSectionProps['query'] }) {
  const { o, dist, pid, can, t } = useOps();
  const f = useListFilters('budget', query, ['status', 'category']);
  const page = usePaged(
    (before) =>
      dist.expenses(pid, {
        status: f.values.status,
        category: f.values.category,
        before,
      }),
    [pid, f.values.status, f.values.category]
  );
  const m = useMutation();
  const [cat, setCat] = useState<'tools' | 'other' | ''>('');
  const [desc, setDesc] = useState('');
  const [currency, setCurrency] = useState('UAH');
  const [amount, setAmount] = useState({
    raw: '',
    minor: null as string | null,
  });
  const [doc, setDoc] = useState('');
  return (
    <Section title={o.budget.expenses}>
      <ListToolbar
        statuses={EXPENSE_STATUSES}
        status={f.values.status}
        onStatus={(v) => f.set('status', v)}
        csvPath={`products/${pid}/expenses`}
        csvQuery={{ status: f.values.status, category: f.values.category }}
        extra={
          <label className="text-xs text-silver-500 flex flex-col gap-1">
            {o.budget.categories}
            <Select
              value={
                f.values.category as (typeof EXPENSE_CATEGORIES)[number] | ''
              }
              options={EXPENSE_CATEGORIES}
              labels={o.budget.category}
              empty={t.common.all}
              onChange={(v) => f.set('category', v)}
            />
          </label>
        }
      />
      <ul>
        {page.items.map((x) => (
          <ListRow
            key={x.id}
            title={
              <RecordLink section="budget" id={x.id}>
                {x.description}
              </RecordLink>
            }
            badges={
              <>
                <Badge>{o.budget.category[x.category]}</Badge>
                <Badge tone={paymentTone(x.paymentStatus)}>
                  {o.purchases.payment[x.paymentStatus]}
                </Badge>
                {x.reconcileRequired && (
                  <Badge tone="warning">{o.budget.reconcileRequired}</Badge>
                )}
              </>
            }
          >
            <ExpenseSums x={x} />
            {x.placementId && (
              <RecordLink section="purchases" id={x.placementId}>
                {o.nav.purchases}
              </RecordLink>
            )}
          </ListRow>
        ))}
      </ul>
      <PagedFooter page={page} empty={o.budget.expensesEmpty} />
      {can('budget.operate') ? (
        <ActionBlock title={o.budget.newExpense}>
          <Field label={o.budget.categories}>
            <Select
              value={cat}
              options={['tools', 'other'] as const}
              labels={o.budget.category}
              empty={o.common.choose}
              onChange={setCat}
            />
          </Field>
          <Field label={o.budget.description} hint={o.common.hintPii}>
            <TextInput value={desc} onChange={setDesc} maxLength={500} />
          </Field>
          <Field label={o.common.currency}>
            <TextInput
              value={currency}
              onChange={(v) => setCurrency(v.toUpperCase())}
              maxLength={3}
            />
          </Field>
          <Field label={o.common.amount}>
            <MoneyInput
              value={amount.raw}
              onChange={(raw, minor) => setAmount({ raw, minor })}
            />
          </Field>
          <Field label={o.budget.sourceDocument}>
            <TextInput value={doc} onChange={setDoc} />
          </Field>
          <PubErrorAlert error={m.error} />
          <Button
            loading={m.busy}
            disabled={
              !cat ||
              !desc.trim() ||
              !amount.minor ||
              !/^[A-Z]{3}$/.test(currency)
            }
            onClick={async () => {
              if (!cat || !amount.minor) return;
              const x = await m.run((k) =>
                dist.createExpense(pid, k, {
                  category: cat,
                  description: desc.trim(),
                  amount: { currency, minor: amount.minor as string },
                  ...(doc.trim() ? { sourceDocument: doc.trim() } : {}),
                })
              );
              if (x) {
                setDesc('');
                setAmount({ raw: '', minor: null });
                page.reload();
              }
            }}
          >
            {o.budget.newExpense}
          </Button>
        </ActionBlock>
      ) : (
        <NoPermission />
      )}
    </Section>
  );
}

function ExpenseSums({ x }: { x: ExpenseView }) {
  const { o } = useOps();
  const c = x.currency;
  return (
    <div className="flex flex-wrap gap-x-3">
      <span>
        {o.budget.amountTotal}:{' '}
        <MoneyText minor={x.amountTotalMinor} currency={c} />
      </span>
      <span>
        {o.budget.paid}: <MoneyText minor={x.paidMinor} currency={c} />
      </span>
      <span>
        {o.budget.openCommitment}:{' '}
        <MoneyText minor={x.openCommitmentMinor} currency={c} />
      </span>
      <span>
        {o.budget.deliveredUnpaid}:{' '}
        <MoneyText minor={x.deliveredUnpaidMinor} currency={c} />
      </span>
      {x.refundedMinor !== '0' && (
        <span>
          {o.budget.refunded}:{' '}
          <MoneyText minor={x.refundedMinor} currency={c} />
        </span>
      )}
      {x.cancelledMinor !== '0' && (
        <span>
          {o.budget.cancelled}:{' '}
          <MoneyText minor={x.cancelledMinor} currency={c} />
        </span>
      )}
    </div>
  );
}

/**
 * Расход и записи движения: оплата (подтверждена/ожидает/неизвестно),
 * сверка ответственным с документом, возврат (обещанный — `pending`, деньги
 * не двигает), оказано, корректировка. Используется и в карточке закупки.
 */
export function ExpensePanel({
  expenseId,
  onChanged,
  embedded,
}: {
  expenseId: string;
  onChanged?: () => void;
  /** Внутри карточки закупки — без заголовка экрана. */
  embedded?: boolean;
}) {
  const { o, dist, pid, can } = useOps();
  const state = useAsync(() => dist.expense(pid, expenseId), [pid, expenseId]);
  return (
    <Loadable state={state}>
      {(x) => (
        <ExpenseBody
          x={x}
          canOperate={can('budget.operate')}
          onChange={(v) => {
            state.setData(v);
            onChanged?.();
          }}
          reload={state.reload}
          embedded={embedded}
          o={o}
          dist={dist}
          pid={pid}
        />
      )}
    </Loadable>
  );
}

type Ops = ReturnType<typeof useOps>;

function ExpenseBody({
  x,
  canOperate,
  onChange,
  reload,
  embedded,
  o,
  dist,
  pid,
}: {
  embedded?: boolean;
  x: ExpenseView;
  canOperate: boolean;
  onChange: (x: ExpenseView) => void;
  reload: () => void;
  o: Ops['o'];
  dist: Ops['dist'];
  pid: string;
}) {
  const m = useMutation();
  const [kind, setKind] = useState<
    'pay' | 'refund' | 'deliver' | 'adjust' | 'cancel' | ''
  >('');
  const [status, setStatus] = useState<'confirmed' | 'pending' | 'unknown'>(
    'confirmed'
  );
  const [amount, setAmount] = useState({
    raw: '',
    minor: null as string | null,
  });
  const [extRef, setExtRef] = useState('');
  const [doc, setDoc] = useState('');
  const [note, setNote] = useState('');
  const [approvalId, setApprovalId] = useState('');
  const [recDoc, setRecDoc] = useState<Record<string, string>>({});
  const kinds = (
    x.placementId
      ? (['pay', 'refund', 'deliver', 'adjust'] as const)
      : (['pay', 'refund', 'deliver', 'adjust', 'cancel'] as const)
  ) as readonly ('pay' | 'refund' | 'deliver' | 'adjust' | 'cancel')[];
  const statuses =
    kind === 'pay'
      ? (['confirmed', 'pending', 'unknown'] as const)
      : kind === 'refund'
        ? (['confirmed', 'pending'] as const)
        : (['confirmed'] as const);

  const reconcilable = (e: ExpenseEntryView) =>
    (e.kind === 'pay' && (e.status === 'pending' || e.status === 'unknown')) ||
    (e.kind === 'refund' && e.status === 'pending');

  return (
    <div className="space-y-3">
      {embedded ? (
        <div className="font-medium">{x.description}</div>
      ) : (
        <ScreenTitle>
          {o.budget.expenseCard}: {x.description}
        </ScreenTitle>
      )}
      <div className="flex flex-wrap gap-1">
        <Badge>{o.budget.category[x.category]}</Badge>
        <Badge tone={paymentTone(x.paymentStatus)}>
          {o.purchases.payment[x.paymentStatus]}
        </Badge>
        {x.paymentPartial && (
          <Badge tone="warning">{o.purchases.payment.partial}</Badge>
        )}
        {x.reconcileRequired && (
          <Badge tone="warning">{o.budget.reconcileRequired}</Badge>
        )}
        <StatusBadge status={x.status} />
      </div>
      <ExpenseSums x={x} />
      {x.orig && (
        <div className="text-xs text-silver-500">
          {fmtText(o.purchases.orig, {
            amount: `${x.orig.amountMinor} ${x.orig.currency}`,
            rate: x.orig.fxRate,
            source: x.orig.fxSource,
            at: x.orig.fxAt,
          })}
        </div>
      )}
      {x.sourceDocument && (
        <Row label={o.budget.sourceDocument}>{x.sourceDocument}</Row>
      )}
      {x.placementId && (
        <RecordLink section="purchases" id={x.placementId}>
          {o.common.links}: {o.nav.purchases}
        </RecordLink>
      )}
      <PubErrorAlert error={m.error} onReload={reload} />
      <Section title={o.budget.entries}>
        {!x.entries || x.entries.length === 0 ? (
          <div className="text-sm text-silver-500">{o.budget.entriesEmpty}</div>
        ) : (
          <ul>
            {x.entries.map((e) => (
              <ListRow
                key={e.id}
                title={
                  <>
                    {o.budget.entryKinds[e.kind]} ·{' '}
                    <MoneyText minor={e.amountMinor} currency={x.currency} />
                  </>
                }
                badges={
                  <>
                    <StatusBadge
                      status={e.status}
                      labels={o.budget.entryStatuses}
                    />
                    {e.kind === 'refund' && e.status === 'pending' && (
                      <Badge tone="warning">{o.common.kinds.forecast}</Badge>
                    )}
                  </>
                }
              >
                <div>
                  <DateText iso={e.occurredAt} time />
                  {e.externalRef ? ` · ${e.externalRef}` : ''}
                  {e.sourceDocument ? ` · ${e.sourceDocument}` : ''}
                </div>
                {e.note && <div>{e.note}</div>}
                {canOperate && reconcilable(e) && (
                  <div className="pt-1 space-y-1">
                    <p>{o.budget.reconcileHint}</p>
                    <TextInput
                      value={recDoc[e.id] ?? ''}
                      placeholder={o.common.document}
                      onChange={(v) => setRecDoc({ ...recDoc, [e.id]: v })}
                    />
                    <div className="flex flex-wrap gap-2">
                      {(['confirmed', 'void'] as const).map((st) => (
                        <Button
                          key={st}
                          variant={st === 'confirmed' ? 'solid' : 'outline'}
                          loading={m.busy}
                          disabled={!(recDoc[e.id] ?? '').trim()}
                          onClick={async () => {
                            const body = {
                              status: st,
                              document: (recDoc[e.id] ?? '').trim(),
                            };
                            const v = await m.run(
                              (k) =>
                                dist.reconcileEntry(pid, x.id, e.id, k, body),
                              JSON.stringify(['reconcile', e.id, body])
                            );
                            if (v) onChange(v);
                          }}
                        >
                          {e.kind === 'refund'
                            ? st === 'confirmed'
                              ? o.budget.reconcileRefundConfirmed
                              : o.budget.reconcileRefundVoid
                            : st === 'confirmed'
                              ? o.budget.reconcileConfirmed
                              : o.budget.reconcileVoid}
                        </Button>
                      ))}
                    </div>
                  </div>
                )}
              </ListRow>
            ))}
          </ul>
        )}
      </Section>
      {canOperate ? (
        <ActionBlock title={o.budget.newEntry}>
          <Field label={o.budget.entryKind}>
            <Select
              value={kind}
              options={kinds}
              labels={o.budget.entryKinds}
              empty={o.common.choose}
              onChange={(v) => {
                setKind(v);
                setStatus('confirmed');
              }}
            />
          </Field>
          {kind && (
            <Field label={o.budget.entryStatus}>
              <Select
                value={status}
                options={statuses}
                labels={o.budget.entryStatuses}
                onChange={(v) => v && setStatus(v)}
              />
            </Field>
          )}
          {kind === 'refund' && status === 'pending' && (
            <Alert tone="warning">{o.budget.refundPendingHint}</Alert>
          )}
          <Field
            label={o.common.amount}
            hint={kind === 'adjust' ? o.budget.adjustHint : undefined}
          >
            <MoneyInput
              value={amount.raw}
              allowNegative={kind === 'adjust'}
              onChange={(raw, minor) => setAmount({ raw, minor })}
            />
          </Field>
          <Field label={o.budget.externalRef}>
            <TextInput value={extRef} onChange={setExtRef} />
          </Field>
          <Field label={o.common.document}>
            <TextInput value={doc} onChange={setDoc} />
          </Field>
          <Field label={o.common.note} hint={o.common.hintPii}>
            <TextInput value={note} onChange={setNote} />
          </Field>
          {kind === 'adjust' && x.placementId && (
            <Field label={o.budget.approvalId}>
              <TextInput
                value={approvalId}
                onChange={(v) => setApprovalId(v.trim())}
              />
            </Field>
          )}
          <Button
            loading={m.busy}
            disabled={!kind || !amount.minor || amount.minor === '0'}
            onClick={async () => {
              if (!kind || !amount.minor) return;
              const body = {
                kind,
                amountMinor: amount.minor as string,
                ...(kind === 'pay' || kind === 'refund' ? { status } : {}),
                ...(extRef.trim() ? { externalRef: extRef.trim() } : {}),
                ...(doc.trim() ? { sourceDocument: doc.trim() } : {}),
                ...(note.trim() ? { note: note.trim() } : {}),
                ...(approvalId ? { approvalId } : {}),
              };
              const v = await m.run(
                (k) => dist.createEntry(pid, x.id, k, body),
                JSON.stringify(['entry', body])
              );
              if (v) {
                onChange(v);
                setAmount({ raw: '', minor: null });
                setExtRef('');
                setDoc('');
                setNote('');
              }
            }}
          >
            {o.budget.newEntry}
          </Button>
        </ActionBlock>
      ) : (
        <NoPermission />
      )}
    </div>
  );
}

/**
 * Пересборка счётчиков бюджета из записей (P-C S2-4) — единственный путь
 * снять `counters_mismatch`; решение владельца продукта с основанием,
 * в журнал аудита; в конце — строгая сверка на сервере.
 */
function RebuildCounters({
  urgent,
  onChange,
}: {
  urgent: boolean;
  onChange: (b: BudgetView) => void;
}) {
  const { o, dist, pid } = useOps();
  const m = useMutation();
  const [basis, setBasis] = useState('');
  const [done, setDone] = useState<string | null>(null);
  return (
    <Section title={o.budget.rebuild}>
      <Alert tone={urgent ? 'warning' : 'neutral'}>
        {o.budget.rebuildHint}
      </Alert>
      <Field label={o.budget.rebuildBasis} hint={o.common.hintPii}>
        <TextInput value={basis} onChange={setBasis} maxLength={500} />
      </Field>
      <PubErrorAlert error={m.error} />
      <Notice text={done} />
      <ConfirmButton
        variant="outline"
        loading={m.busy}
        disabled={basis.trim().length < 10}
        onConfirm={async () => {
          setDone(null);
          const x = await m.run((k) =>
            dist.rebuildCounters(pid, k, basis.trim())
          );
          if (x) {
            setBasis('');
            setDone(o.common.done);
            onChange(x);
          }
        }}
      >
        {o.budget.rebuild}
      </ConfirmButton>
    </Section>
  );
}
