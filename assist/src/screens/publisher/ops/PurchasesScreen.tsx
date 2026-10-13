/**
 * F12 — закупки (P-G2, §14.1 `purchases`, `purchases/:id`): машина 7.2
 * (предложение → согласование суммы и срока → атомарный резерв → заказ →
 * публикация → проверка; претензия; отмена/отклонение), оплата отдельно
 * от публикации со сверкой «неизвестно» (AT-CORE-13…17, AT-F12-01/02).
 * Кнопки — подсказка по ролям; решает сервер (AT-CORE-11).
 */
import { useState } from 'react';
import { Alert, Badge, Button, ScreenTitle } from '../../../kit/ui';
import { useAsync } from '../../../kit';
import {
  PLACEMENT_STATUSES,
  type PlacementView,
} from '../../../lib/publisher/distribution-api';
import {
  isHttps,
  linkMatchesCode,
  localToIso,
  parseMoneyInput,
  placementStepRequest,
  paymentNeedsReconcile,
  paymentTone,
  placementSteps,
  type PlacementUiStep,
} from '../../../lib/publisher/ops-view';
import { fmtText, placementTone } from '../../../lib/publisher/view';
import { useListFilters, useMutation } from '../hooks';
import {
  ConfirmButton,
  DateText,
  ExternalUrl,
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
  TextArea,
  TextInput,
} from '../parts';
import type { PublisherSectionProps } from '../registry';
import { ExpensePanel } from './BudgetScreen';
import {
  ActionBlock,
  KindBadge,
  ListRow,
  MemberPicker,
  MoneyInput,
  PagedFooter,
} from './ops-parts';
import { useOps, usePaged } from './ops-hooks';

export function PurchasesSection({ id, query }: PublisherSectionProps) {
  return id ? <PurchaseCard id={id} /> : <PurchaseList query={query} />;
}

function PurchaseList({ query }: { query: PublisherSectionProps['query'] }) {
  const { o, dist, pid, can } = useOps();
  const f = useListFilters('purchases', query, ['status', 'owner', 'venueId']);
  const page = usePaged(
    (before) => dist.placements(pid, { status: f.values.status, before }),
    [pid, f.values.status]
  );
  // Ответственного (владельца претензии) и площадку сервер для списка не
  // фильтрует — фильтр по загруженным строкам с явной подписью.
  const rows = page.items.filter(
    (p) =>
      (!f.values.owner || p.claimOwnerMemberId === f.values.owner) &&
      (!f.values.venueId || p.venueId === f.values.venueId)
  );
  return (
    <div className="space-y-4">
      <ScreenTitle>{o.purchases.title}</ScreenTitle>
      <p className="text-sm text-silver-500">{o.purchases.intro}</p>
      <ListToolbar
        statuses={PLACEMENT_STATUSES}
        status={f.values.status}
        onStatus={(v) => f.set('status', v)}
        statusLabels={o.purchases.statuses}
        owner={f.values.owner}
        onOwner={(v) => f.set('owner', v)}
        csvPath={`products/${pid}/placements`}
        csvQuery={{ status: f.values.status }}
      />
      {(f.values.owner || f.values.venueId) && (
        <Alert tone="neutral">{o.common.loadedOnly}</Alert>
      )}
      <Section title={o.nav.purchases}>
        <ul>
          {rows.map((p) => (
            <ListRow
              key={p.id}
              title={
                <RecordLink section="purchases" id={p.id}>
                  {p.placementCode} ·{' '}
                  <MoneyText minor={p.totalPriceMinor} currency={p.currency} />
                </RecordLink>
              }
              badges={
                <>
                  <StatusBadge
                    status={p.status}
                    labels={o.purchases.statuses}
                    tone={placementTone(p.status)}
                  />
                  <Badge tone={paymentTone(p.paymentStatus)}>
                    {o.purchases.payment.title}:{' '}
                    {o.purchases.payment[p.paymentStatus]}
                  </Badge>
                  {p.claimStatus === 'open' && (
                    <Badge tone="danger">{o.purchases.statuses.disputed}</Badge>
                  )}
                </>
              }
            >
              <div>
                <RecordLink section="venues" id={p.venueId}>
                  {o.nav.venues}
                </RecordLink>
                {' · '}
                {fmtText(o.purchases.seq, { n: p.purchaseSeq })}
                {p.publishDueAt && (
                  <>
                    {' · '}
                    {o.purchases.publishDueAt}:{' '}
                    <DateText iso={p.publishDueAt} />
                  </>
                )}
              </div>
            </ListRow>
          ))}
        </ul>
        <PagedFooter page={page} empty={o.purchases.empty} />
      </Section>
      {can('placement.propose') ? (
        <CreatePlacement onCreated={page.reload} />
      ) : (
        <NoPermission />
      )}
    </div>
  );
}

function CreatePlacement({ onCreated }: { onCreated: () => void }) {
  const { o, dist, pid, go } = useOps();
  const venues = useAsync(
    () => dist.venues(pid, { status: 'verified', limit: 100 }),
    [pid]
  );
  const m = useMutation();
  const [venueId, setVenueId] = useState('');
  const [versionId, setVersionId] = useState('');
  const [currency, setCurrency] = useState('UAH');
  const [base, setBase] = useState({ raw: '', minor: null as string | null });
  const [fees, setFees] = useState({ raw: '', minor: null as string | null });
  const [fx, setFx] = useState({ rate: '', source: '', at: '' });
  const [priceSource, setPriceSource] = useState('');
  const [priceConfirmedAt, setPriceConfirmedAt] = useState('');
  const [offerExpiresAt, setOfferExpiresAt] = useState('');
  const [terms, setTerms] = useState('');
  const fxFilled = fx.rate.trim() && fx.source.trim() && fx.at;
  return (
    <Section title={o.purchases.create}>
      <Field label={o.purchases.venue}>
        <select
          className="w-full rounded-lg border border-silver-300 dark:border-silver-700 bg-transparent px-3 py-2 min-h-[44px] text-sm"
          value={venueId}
          onChange={(e) => setVenueId(e.target.value)}
        >
          <option value="">{o.common.choose}</option>
          {(venues.data?.items ?? []).map((v) => (
            <option key={v.id} value={v.id}>
              {v.title}
            </option>
          ))}
        </select>
      </Field>
      <Field label={o.purchases.versionId}>
        <TextInput value={versionId} onChange={(v) => setVersionId(v.trim())} />
      </Field>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <Field label={o.common.currency}>
          <TextInput
            value={currency}
            onChange={(v) => setCurrency(v.toUpperCase())}
            maxLength={3}
          />
        </Field>
        <Field label={o.purchases.base}>
          <MoneyInput
            value={base.raw}
            onChange={(raw, minor) => setBase({ raw, minor })}
          />
        </Field>
        <Field label={o.purchases.fees}>
          <MoneyInput
            value={fees.raw}
            onChange={(raw, minor) => setFees({ raw, minor })}
          />
        </Field>
      </div>
      <ActionBlock title={o.purchases.fxRate}>
        <p className="text-xs text-silver-500">{o.purchases.fxHint}</p>
        <Field label={o.purchases.fxRate}>
          <TextInput
            value={fx.rate}
            onChange={(v) => setFx({ ...fx, rate: v.replace(',', '.') })}
          />
        </Field>
        <Field label={o.purchases.fxSource}>
          <TextInput
            value={fx.source}
            onChange={(v) => setFx({ ...fx, source: v })}
          />
        </Field>
        <Field label={o.purchases.fxAt}>
          <TextInput
            type="datetime-local"
            value={fx.at}
            onChange={(v) => setFx({ ...fx, at: v })}
          />
        </Field>
      </ActionBlock>
      <Field label={o.purchases.priceSource}>
        <TextInput value={priceSource} onChange={setPriceSource} />
      </Field>
      <Field label={o.purchases.priceConfirmedAt}>
        <TextInput
          type="datetime-local"
          value={priceConfirmedAt}
          onChange={setPriceConfirmedAt}
        />
      </Field>
      <Field label={o.purchases.offerExpiresAt}>
        <TextInput
          type="datetime-local"
          value={offerExpiresAt}
          onChange={setOfferExpiresAt}
        />
      </Field>
      <Field label={o.purchases.terms} hint={o.common.hintPii}>
        <TextArea value={terms} onChange={setTerms} />
      </Field>
      <PubErrorAlert error={m.error} />
      <Button
        loading={m.busy}
        disabled={
          !venueId ||
          !versionId ||
          !base.minor ||
          fees.minor === null ||
          !priceSource.trim() ||
          !terms.trim() ||
          !/^[A-Z]{3}$/.test(currency)
        }
        onClick={async () => {
          if (!base.minor || fees.minor === null) return;
          const at = localToIso(fx.at);
          const p = await m.run((k) =>
            dist.createPlacement(pid, k, {
              venueId,
              versionId,
              price: {
                currency,
                baseMinor: base.minor as string,
                feesMinor: fees.minor as string,
              },
              ...(fxFilled && at
                ? { fx: { rate: fx.rate.trim(), source: fx.source.trim(), at } }
                : {}),
              priceSource: priceSource.trim(),
              ...(localToIso(priceConfirmedAt)
                ? { priceConfirmedAt: localToIso(priceConfirmedAt) as string }
                : {}),
              ...(localToIso(offerExpiresAt)
                ? { offerExpiresAt: localToIso(offerExpiresAt) }
                : {}),
              terms: terms.trim(),
            })
          );
          if (p) {
            onCreated();
            go('purchases', p.id);
          }
        }}
      >
        {o.purchases.create}
      </Button>
    </Section>
  );
}

function PurchaseCard({ id }: { id: string }) {
  const { o, dist, pid } = useOps();
  const state = useAsync(() => dist.placement(pid, id), [pid, id]);
  return (
    <div className="space-y-4">
      <RecordLink section="purchases">{o.common.back}</RecordLink>
      <Loadable state={state}>
        {(p) => (
          <PurchaseBody
            key={`${p.id}:${p.revision}`}
            p={p}
            onChange={(x) => state.setData(x)}
            reload={state.reload}
          />
        )}
      </Loadable>
    </div>
  );
}

function PurchaseBody({
  p,
  onChange,
  reload,
}: {
  p: PlacementView;
  onChange: (p: PlacementView) => void;
  reload: () => void;
}) {
  const { o, dist, pid, can } = useOps();
  const steps = placementSteps(p, can);
  const cur = p.currency;
  return (
    <div className="space-y-4">
      <ScreenTitle>
        {p.placementCode}{' '}
        <StatusBadge
          status={p.status}
          labels={o.purchases.statuses}
          tone={placementTone(p.status)}
        />
      </ScreenTitle>
      <div className="flex flex-wrap gap-1">
        <Badge tone={paymentTone(p.paymentStatus)}>
          {o.purchases.payment.title}: {o.purchases.payment[p.paymentStatus]}
        </Badge>
        {p.paymentPartial && (
          <Badge tone="warning">{o.purchases.payment.partial}</Badge>
        )}
        <Badge tone={p.observationOk ? 'neutral' : 'warning'}>
          {o.purchases.observation}:{' '}
          {p.observationOk
            ? o.purchases.observationOk
            : o.purchases.observationNo}
        </Badge>
      </div>
      {paymentNeedsReconcile(p) && (
        <Alert tone="warning">{o.purchases.reconcileFirst}</Alert>
      )}

      <Section title={o.purchases.total}>
        <Row label={o.purchases.base}>
          <MoneyText minor={p.basePriceMinor} currency={cur} />
        </Row>
        <Row label={o.purchases.fees}>
          <MoneyText minor={p.feesMinor} currency={cur} />
        </Row>
        <Row label={o.purchases.total}>
          <MoneyText minor={p.totalPriceMinor} currency={cur} />{' '}
          <KindBadge kind="plan" />
        </Row>
        {p.orig && (
          <div className="text-xs text-silver-500">
            {fmtText(o.purchases.orig, {
              amount: `${p.orig.amountMinor} ${p.orig.currency}`,
              rate: p.orig.fxRate,
              source: p.orig.fxSource,
              at: p.orig.fxAt,
            })}
          </div>
        )}
        <Row label={o.purchases.priceSource}>
          {p.priceSource ?? o.common.unknown}
        </Row>
        <Row label={o.purchases.priceConfirmedAt}>
          <DateText iso={p.priceConfirmedAt} time />
        </Row>
        <Row label={o.purchases.offerExpiresAt}>
          <DateText iso={p.offerExpiresAt} time />
        </Row>
        {p.terms && <Row label={o.purchases.terms}>{p.terms}</Row>}
        <Row label={o.purchases.priceSnapshot}>
          <code className="text-xs break-all">{p.priceSnapshotHash}</code>
        </Row>
      </Section>

      <Section title={o.common.links}>
        <Row label={o.nav.venues}>
          <RecordLink section="venues" id={p.venueId}>
            {p.venueId}
          </RecordLink>
        </Row>
        <Row label={o.purchases.versionId}>{p.versionId}</Row>
        <Row label={o.purchases.seq.replace('{n}', String(p.purchaseSeq))}>
          {p.campaignId}
        </Row>
        <Row label={o.purchases.issuedUrl}>
          <ExternalUrl url={p.issuedUrl} />
        </Row>
        <Row label={o.purchases.approval}>
          {p.approvalId ?? o.common.unknown}
        </Row>
        {p.reportDecisionId && (
          <Row label={o.purchases.reportDecision}>
            <RecordLink section="reports" id={p.reportDecisionId}>
              {p.reportDecisionId}
            </RecordLink>
          </Row>
        )}
        {p.externalOrderId && (
          <Row label={o.purchases.externalOrderId}>{p.externalOrderId}</Row>
        )}
        <Row label={o.purchases.publishDueAt}>
          <DateText iso={p.publishDueAt} time />
        </Row>
        <Row label={o.purchases.publishedAt}>
          <DateText iso={p.publishedAt} time />
        </Row>
        <Row label={o.purchases.verifiedAt}>
          <DateText iso={p.verifiedAt} time />
        </Row>
        <Row label={o.purchases.claim.owner}>
          {o.purchases.claim[p.claimStatus]}
          {p.claimOwnerMemberId ? ` · ${p.claimOwnerMemberId}` : ''}
        </Row>
        {p.nextActionAt && (
          <Row label={o.purchases.claim.nextActionAt}>
            <DateText iso={p.nextActionAt} time />
          </Row>
        )}
        <RecordLink section="traffic" query={{ placementId: p.id }}>
          {o.nav.traffic}
        </RecordLink>
      </Section>

      {steps.length > 0 ? (
        <Section title={o.common.actions}>
          {steps.map((s) => (
            <StepForm
              key={s}
              step={s}
              p={p}
              onChange={onChange}
              reload={reload}
            />
          ))}
        </Section>
      ) : (
        p.status !== 'verified_complete' &&
        p.status !== 'rejected' &&
        p.status !== 'cancelled' && <NoPermission />
      )}

      {p.expenseId && (
        <Section
          title={o.purchases.expense}
          action={
            <RecordLink section="budget" id={p.expenseId}>
              {o.purchases.openExpense}
            </RecordLink>
          }
        >
          <ExpensePanel
            embedded
            expenseId={p.expenseId}
            onChanged={() =>
              void dist.placement(pid, p.id).then(onChange, () => undefined)
            }
          />
        </Section>
      )}
    </div>
  );
}

function StepForm({
  step,
  p,
  onChange,
  reload,
}: {
  step: PlacementUiStep;
  p: PlacementView;
  onChange: (p: PlacementView) => void;
  reload: () => void;
}) {
  const { o, dist, pid } = useOps();
  // Своя мутация на каждый шаг: повтор после сети — только этого шага.
  const m = useMutation();
  const [done, setDone] = useState<string | null>(null);
  const [v, setV] = useState<Record<string, string>>({});
  const [amt, setAmt] = useState({ raw: '', minor: null as string | null });
  const set = (k: string) => (x: string) => setV({ ...v, [k]: x });
  const hash = useAsync(
    () =>
      step === 'approve'
        ? dist.versionApproval(pid, p.versionId)
        : Promise.resolve(null),
    [pid, p.versionId, step]
  );
  // Маркировка — обещанная площадкой (предзаполнение для проверки).
  const venue = useAsync(
    () =>
      step === 'verify' ? dist.venue(pid, p.venueId) : Promise.resolve(null),
    [pid, p.venueId, step]
  );
  const promised = venue.data?.linkMarking;
  const fields =
    step === 'verify' &&
    !v.marking &&
    (promised === 'sponsored' || promised === 'nofollow')
      ? { ...v, marking: promised }
      : v;
  const title = o.purchases.steps[step];
  if (step === 'editPrice') {
    return (
      <ActionBlock title={title}>
        <p className="text-xs text-silver-500">{o.purchases.approveHint}</p>
        <Field label={o.purchases.base}>
          <MoneyInput
            value={v.base ?? ''}
            onChange={(raw) => setV({ ...v, base: raw })}
          />
        </Field>
        <Field label={o.purchases.fees}>
          <MoneyInput
            value={v.fees ?? ''}
            onChange={(raw) => setV({ ...v, fees: raw })}
          />
        </Field>
        <Field label={o.purchases.priceSource}>
          <TextInput
            value={v.priceSource ?? ''}
            onChange={set('priceSource')}
          />
        </Field>
        <Field label={o.purchases.terms} hint={o.common.hintPii}>
          <TextArea value={v.terms ?? ''} onChange={set('terms')} />
        </Field>
        <EditPriceButton
          p={p}
          v={v}
          m={m}
          onChange={onChange}
          setDone={setDone}
        />
        <PubErrorAlert error={m.error} onReload={reload} />
        <Notice text={done} />
      </ActionBlock>
    );
  }
  const req = placementStepRequest(step, p, {
    fields,
    amountMinor: amt.minor,
    versionHash: hash.data?.versionHash ?? null,
  });
  const submit = async () => {
    if (!req) return;
    setDone(null);
    const x = await m.run((k) =>
      dist.placementStep(pid, p.id, req.step, k, req.body as never)
    );
    if (x) {
      onChange(x);
      setDone(o.common.done);
    }
  };
  const dangerous = step === 'cancel' || step === 'reject';
  const url = (k: string, label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <TextInput type="url" value={fields[k] ?? ''} onChange={set(k)} />
    </Field>
  );
  const dt = (k: string, label: string) => (
    <Field label={label}>
      <TextInput
        type="datetime-local"
        value={fields[k] ?? ''}
        onChange={set(k)}
      />
    </Field>
  );
  const text = (k: string, label: string, pii = true) => (
    <Field label={label} hint={pii ? o.common.hintPii : undefined}>
      <TextInput value={fields[k] ?? ''} onChange={set(k)} />
    </Field>
  );
  const money = (label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <MoneyInput
        value={amt.raw}
        onChange={(raw, minor) => setAmt({ raw, minor })}
      />
    </Field>
  );
  let form: JSX.Element | null = null;
  switch (step) {
    case 'approve': {
      const vh = hash.data?.versionHash ?? null;
      form = (
        <>
          <p className="text-xs text-silver-500">{o.purchases.approveHint}</p>
          {money(o.purchases.maxAmount)}
          <div className="text-xs text-silver-500">
            <MoneyText
              minor={amt.minor ?? p.totalPriceMinor}
              currency={p.currency}
            />
          </div>
          <Row label={o.purchases.versionHash}>
            {hash.loading ? (
              '…'
            ) : vh ? (
              <code className="text-xs break-all">{vh}</code>
            ) : (
              o.common.unknown
            )}
          </Row>
          {!hash.loading && !vh && (
            <Alert tone="warning">{o.purchases.versionHashMissing}</Alert>
          )}
          {p.purchaseSeq >= 3 &&
            text('reportDecisionId', o.purchases.reportDecision, false)}
          {text('reason', o.common.reason)}
        </>
      );
      break;
    }
    case 'reserve':
      form = (
        <p className="text-xs text-silver-500">{o.purchases.reserveHint}</p>
      );
      break;
    case 'order':
      form = (
        <>
          {text('externalOrderId', o.purchases.externalOrderId, false)}
          {text('note', o.common.note)}
        </>
      );
      break;
    case 'publication':
      form = dt('publishDueAt', o.purchases.publishDueAt);
      break;
    case 'published':
      form = (
        <>
          {url('url', o.purchases.publishedUrl, o.purchases.publishedUrlHint)}
          {dt('publishedAt', o.purchases.publishedAt)}
        </>
      );
      break;
    case 'verify': {
      const link = fields.linkUrl ?? '';
      form = (
        <>
          <p className="text-xs text-silver-500">{o.purchases.verifyHint}</p>
          {url('url', o.purchases.publishedUrl)}
          {url(
            'linkUrl',
            o.purchases.linkUrl,
            fmtText(o.purchases.linkUrlHint, { code: p.placementCode })
          )}
          {p.issuedUrl && (
            <Row label={o.purchases.issuedUrl}>
              <code className="text-xs break-all">{p.issuedUrl}</code>
            </Row>
          )}
          {isHttps(link) && !linkMatchesCode(link, p.placementCode) && (
            <Alert tone="warning">
              {fmtText(o.purchases.linkUrlMismatch, { code: p.placementCode })}
            </Alert>
          )}
          {url(
            'evidenceUrl',
            o.purchases.evidenceUrl,
            o.purchases.evidenceUrlHint
          )}
          <Field
            label={o.purchases.marking}
            hint={
              promised === 'sponsored' || promised === 'nofollow'
                ? fmtText(o.purchases.markingPromised, { v: promised })
                : undefined
            }
          >
            <Select
              value={(fields.marking ?? '') as 'sponsored' | 'nofollow' | ''}
              options={['sponsored', 'nofollow'] as const}
              empty={o.common.choose}
              onChange={set('marking')}
            />
          </Field>
        </>
      );
      break;
    }
    case 'dispute':
      form = (
        <>
          <Field label={o.purchases.claim.owner}>
            <MemberPicker value={fields.owner ?? ''} onChange={set('owner')} />
          </Field>
          {dt('nextActionAt', o.purchases.claim.nextActionAt)}
          {text('reason', o.common.reason)}
        </>
      );
      break;
    case 'resolve': {
      const to = (fields.to ?? '') as
        'publication_pending' | 'published' | 'cancelled' | '';
      form = (
        <>
          <Field label={o.purchases.resolveTo}>
            <Select
              value={to}
              options={
                ['publication_pending', 'published', 'cancelled'] as const
              }
              labels={o.purchases.statuses}
              empty={o.common.choose}
              onChange={set('to')}
            />
          </Field>
          {text('reason', o.common.reason)}
          {to === 'publication_pending' &&
            dt('publishDueAt', o.purchases.publishDueAt)}
          {to === 'published' && (
            <>
              {url(
                'url',
                o.purchases.publishedUrl,
                o.purchases.publishedUrlHint
              )}
              {dt('publishedAt', o.purchases.publishedAt)}
            </>
          )}
          {to === 'cancelled' && (
            <>
              {money(o.purchases.confirmedAmount, o.purchases.cancelHint)}
              {text('document', o.common.document, false)}
            </>
          )}
        </>
      );
      break;
    }
    case 'cancel':
      form = (
        <>
          <p className="text-xs text-silver-500">{o.purchases.cancelHint}</p>
          {money(o.purchases.confirmedAmount)}
          {text('document', o.common.document, false)}
        </>
      );
      break;
    case 'reject':
      form = text('reason', o.common.reason);
      break;
  }
  return (
    <ActionBlock title={title}>
      {form}
      {dangerous ? (
        <ConfirmButton
          loading={m.busy}
          disabled={!req}
          onConfirm={() => void submit()}
        >
          {title}
        </ConfirmButton>
      ) : (
        <Button loading={m.busy} disabled={!req} onClick={() => void submit()}>
          {title}
        </Button>
      )}
      <PubErrorAlert error={m.error} onReload={reload} />
      <Notice text={done} />
    </ActionBlock>
  );
}

function EditPriceButton({
  p,
  v,
  m,
  onChange,
  setDone,
}: {
  p: PlacementView;
  v: Record<string, string>;
  m: ReturnType<typeof useMutation>;
  onChange: (p: PlacementView) => void;
  setDone: (s: string | null) => void;
}) {
  const { o, dist, pid } = useOps();
  const parse = (raw: string | undefined) => {
    if (!raw) return undefined;
    const x = parseMoneyInput(raw);
    return x === null || x.startsWith('-') ? null : x;
  };
  const base = parse(v.base);
  const fees = parse(v.fees);
  const priceChanged = base !== undefined || fees !== undefined;
  // Цена в другой валюте: вводится целиком (обе суммы) с прежним курсом.
  const bad =
    base === null ||
    fees === null ||
    (!!p.orig && priceChanged && (base === undefined || fees === undefined));
  return (
    <Button
      loading={m.busy}
      disabled={
        bad || (!priceChanged && !v.priceSource?.trim() && !v.terms?.trim())
      }
      onClick={async () => {
        setDone(null);
        const x = await m.run((k) =>
          dist.patchPlacement(pid, p.id, k, p.revision, {
            ...(priceChanged
              ? {
                  price: {
                    currency: p.orig ? p.orig.currency : p.currency,
                    baseMinor: base ?? p.basePriceMinor,
                    feesMinor: fees ?? p.feesMinor,
                  },
                  ...(p.orig
                    ? {
                        fx: {
                          rate: p.orig.fxRate,
                          source: p.orig.fxSource,
                          at: p.orig.fxAt,
                        },
                      }
                    : {}),
                }
              : {}),
            ...(v.priceSource?.trim()
              ? { priceSource: v.priceSource.trim() }
              : {}),
            ...(v.terms?.trim() ? { terms: v.terms.trim() } : {}),
          })
        );
        if (x) {
          onChange(x);
          setDone(o.common.done);
        }
      }}
    >
      {o.purchases.steps.editPrice}
    </Button>
  );
}
