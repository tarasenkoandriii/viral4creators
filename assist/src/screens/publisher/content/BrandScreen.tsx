import { useState } from 'react';
import { useAsync } from '../../../kit';
import { Alert, Badge, Button } from '../../../kit/ui';
import {
  factValueText,
  type BrandFactView,
  type CascadeSummary,
  type OfferVersionView,
} from '../../../lib/publisher/content-api';
import {
  BRAND_FACT_KINDS,
  BRAND_FACT_STATUSES,
  type BrandFactKind,
} from '../../../lib/publisher/states';
import { factValue } from '../../../lib/publisher/brand-view';
import { actorLabel, fmtText } from '../../../lib/publisher/view';
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
  ListToolbar,
  Loadable,
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

/**
 * Бренд и оффер F02 (§14.1 BrandScreen): факты (черновик ED/PO; активация,
 * конфликты `needs_resolution`, снятие — PO), запрещённые обещания отдельно,
 * версии оффера и активация с перечнем затронутых материалов (каскад).
 */
export function BrandScreen({ query }: PublisherSectionProps) {
  const { product, can } = usePublisher();
  const c = usePubContent();
  const apis = usePubApis();
  const f = useListFilters('brand', query, ['status']);
  const q = { status: f.values.status || undefined };
  const facts = useAsync(
    async () => (await apis.content.facts({ ...q, limit: 100 })).items,
    [apis, product.id, q.status]
  );
  const allFacts = useAsync(
    async () => (await apis.content.facts({ limit: 100 })).items,
    [apis, product.id, facts.data]
  );
  const offers = useAsync(
    async () => (await apis.content.offers({ limit: 50 })).items,
    [apis, product.id]
  );
  const [cascade, setCascade] = useState<CascadeSummary | null>(null);
  const conflicts = (allFacts.data ?? []).filter(
    (x) => x.status === 'needs_resolution'
  );
  const forbidden = (allFacts.data ?? []).filter(
    (x) => x.kind === 'forbidden_promise' && x.status === 'active'
  );
  const reload = () => {
    facts.reload();
    offers.reload();
  };

  return (
    <div className="space-y-4">
      <Alert tone="neutral" title={c.brand.title}>
        {!can('brand.activate') ? c.brand.onlyPo : null}
      </Alert>
      {cascade && <CascadeNote cascade={cascade} />}
      {conflicts.length > 0 && (
        <Section title={c.brand.conflicts}>
          <ul className="space-y-2">
            {conflicts.map((x) => (
              <ConflictRow
                key={x.id}
                fact={x}
                onDone={(cs) => {
                  setCascade(cs);
                  reload();
                }}
              />
            ))}
          </ul>
        </Section>
      )}
      <Section title={c.brand.forbidden}>
        <p className="text-xs text-silver-500">{c.brand.forbiddenHint}</p>
        {forbidden.length ? (
          <ul className="list-disc pl-5 text-sm">
            {forbidden.map((x) => (
              <li key={x.id}>
                <code className="text-xs break-all">{x.factKey}</code> —{' '}
                {factValueText(x.value)}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState />
        )}
      </Section>
      {can('brand.draft') ? <NewFact onDone={reload} /> : <NoPermission />}
      <Section title={c.brand.facts}>
        <ListToolbar
          statuses={BRAND_FACT_STATUSES}
          status={f.values.status}
          onStatus={(v) => f.set('status', v)}
          statusLabels={c.brand.factStatuses}
          csvPath={`products/${product.id}/brand-facts`}
          csvQuery={q}
        />
        <Loadable state={facts}>
          {(items) =>
            items.length ? (
              <ul className="divide-y divide-silver-200 dark:divide-silver-800">
                {items.map((x) => (
                  <FactRow
                    key={x.id}
                    fact={x}
                    onDone={(cs) => {
                      if (cs) setCascade(cs);
                      reload();
                    }}
                  />
                ))}
              </ul>
            ) : (
              <EmptyState />
            )
          }
        </Loadable>
      </Section>
      <Section title={c.brand.offers}>
        {can('brand.activate') && (
          <NewOffer facts={allFacts.data ?? []} onDone={offers.reload} />
        )}
        <Loadable state={offers}>
          {(items) =>
            items.length ? (
              <ul className="divide-y divide-silver-200 dark:divide-silver-800">
                {items.map((o) => (
                  <OfferRow
                    key={o.id}
                    offer={o}
                    onDone={(cs) => {
                      setCascade(cs);
                      reload();
                    }}
                  />
                ))}
              </ul>
            ) : (
              <EmptyState />
            )
          }
        </Loadable>
      </Section>
    </div>
  );
}

/** Каскад активации/снятия: задачи, материалы к исправлению, согласования. */
function CascadeNote({ cascade }: { cascade: CascadeSummary }) {
  const c = usePubContent();
  const { t } = usePublisher();
  return (
    <Alert tone="warning" title={t.common.related}>
      <div>
        {fmtText(c.brand.cascadeCorrection, {
          n: cascade.correctionRequired.length,
        })}
      </div>
      <ul className="list-disc pl-5">
        {cascade.correctionRequired.map((id) => (
          <li key={id}>
            <RecordLink section="materials" id={id}>
              {id}
            </RecordLink>
          </li>
        ))}
      </ul>
      <div>
        {fmtText(c.brand.cascadeSuperseded, {
          n: cascade.approvalsSuperseded.length,
        })}
      </div>
      <div>{fmtText(c.brand.cascadeTasks, { n: cascade.tasksOpened })}</div>
    </Alert>
  );
}

function FactRow({
  fact: x,
  onDone,
}: {
  fact: BrandFactView;
  onDone: (cs: CascadeSummary | null) => void;
}) {
  const c = usePubContent();
  const { can, t } = usePublisher();
  const apis = usePubApis();
  const [reason, setReason] = useState('');
  const m = useMutation();
  return (
    <li className="py-2 space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <code className="text-xs break-all">{x.factKey}</code>
        <Badge tone="neutral">{c.brand.factKinds[x.kind]}</Badge>
        <StatusBadge status={x.status} labels={c.brand.factStatuses} />
        <span className="text-xs text-silver-500">v{x.version}</span>
      </div>
      <div className="text-sm">{factValueText(x.value)}</div>
      {x.approvedAt && (
        <div className="text-xs text-silver-500">
          {actorLabel(x.approvedBy, t.common.adminActor)} ·{' '}
          <DateText iso={x.approvedAt} />
        </div>
      )}
      {can('brand.activate') && (
        <div className="flex flex-wrap items-center gap-2">
          {x.status === 'draft' && (
            <Button
              variant="outline"
              loading={m.busy}
              onClick={async () => {
                const r = await m.run((k) =>
                  apis.content.factDecision(x.id, 'activate', {}, k)
                );
                if (r) onDone(r.cascade);
              }}
            >
              {c.brand.activate}
            </Button>
          )}
          {x.status === 'active' && (
            <>
              <TextInput
                value={reason}
                onChange={setReason}
                placeholder={c.brand.retireReason}
                maxLength={500}
              />
              <ConfirmButton
                loading={m.busy}
                disabled={!reason.trim()}
                onConfirm={async () => {
                  const r = await m.run((k) =>
                    apis.content.factDecision(
                      x.id,
                      'retire',
                      { reason: reason.trim() },
                      k
                    )
                  );
                  if (r) onDone(r.cascade);
                }}
              >
                {c.brand.retire}
              </ConfirmButton>
            </>
          )}
        </div>
      )}
      <PubErrorAlert error={m.error} onReload={() => onDone(null)} />
    </li>
  );
}

function ConflictRow({
  fact: x,
  onDone,
}: {
  fact: BrandFactView;
  onDone: (cs: CascadeSummary) => void;
}) {
  const c = usePubContent();
  const { can } = usePublisher();
  const apis = usePubApis();
  const [reason, setReason] = useState('');
  const m = useMutation();
  return (
    <li className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <code className="text-xs break-all">{x.factKey}</code>
        <span className="text-sm flex-1 min-w-0">{factValueText(x.value)}</span>
        {x.conflictWithId && (
          <span className="text-xs text-silver-500">
            {fmtText(c.brand.conflictWith, { id: x.conflictWithId })}
          </span>
        )}
      </div>
      {can('brand.activate') && (
        <div className="flex flex-wrap items-center gap-2">
          <TextInput
            value={reason}
            onChange={setReason}
            placeholder={c.brand.resolveReason}
            maxLength={500}
          />
          <Button
            variant="outline"
            loading={m.busy}
            disabled={!reason.trim()}
            onClick={async () => {
              const r = await m.run((k) =>
                apis.content.factDecision(
                  x.id,
                  'resolve',
                  { keepId: x.id, reason: reason.trim() },
                  k
                )
              );
              if (r) onDone(r.cascade);
            }}
          >
            {c.brand.resolve}
          </Button>
        </div>
      )}
      <PubErrorAlert error={m.error} />
    </li>
  );
}

function NewFact({ onDone }: { onDone: () => void }) {
  const c = usePubContent();
  const { t } = usePublisher();
  const apis = usePubApis();
  const [factKey, setFactKey] = useState('');
  const [kind, setKind] = useState<BrandFactKind | ''>('fact');
  const [text, setText] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('UAH');
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [scope, setScope] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const m = useMutation();
  const { value, ready } = factValue(kind, {
    text,
    amount,
    currency,
    question,
    answer,
  });
  const canAdd = !!factKey.trim() && ready;
  return (
    <Section title={c.brand.addFact}>
      <div className="grid gap-2 md:grid-cols-2">
        <Field label={c.brand.factKey}>
          <TextInput value={factKey} onChange={setFactKey} maxLength={64} />
        </Field>
        <Field label={c.brand.kind}>
          <Select
            value={kind}
            options={BRAND_FACT_KINDS}
            labels={c.brand.factKinds}
            onChange={setKind}
          />
        </Field>
      </div>
      {kind === 'price' && (
        <div className="grid grid-cols-2 gap-2">
          <Field label={c.brand.priceAmount}>
            <TextInput value={amount} onChange={setAmount} type="number" />
          </Field>
          <Field label={c.brand.currency}>
            <TextInput value={currency} onChange={setCurrency} maxLength={3} />
          </Field>
        </div>
      )}
      {kind === 'faq' ? (
        <>
          <Field label={c.brand.faqQuestion}>
            <TextInput value={question} onChange={setQuestion} />
          </Field>
          <Field label={c.brand.faqAnswer}>
            <TextArea value={answer} onChange={setAnswer} />
          </Field>
        </>
      ) : (
        <Field label={c.brand.value}>
          <TextArea value={text} onChange={setText} />
        </Field>
      )}
      <Field label={c.brand.scope}>
        <TextInput value={scope} onChange={setScope} maxLength={200} />
      </Field>
      <Notice text={notice} />
      <PubErrorAlert error={m.error} />
      <Button
        loading={m.busy}
        disabled={!canAdd}
        onClick={async () => {
          if (!kind) return;
          const r = await m.run((k) =>
            apis.content.createFact(
              {
                factKey: factKey.trim(),
                kind,
                value,
                scope: scope.trim() || null,
              },
              k
            )
          );
          if (r) {
            setNotice(
              r.conflictTaskOpened ? c.brand.conflictOpened : c.brand.factAdded
            );
            setText('');
            setQuestion('');
            setAnswer('');
            onDone();
          }
        }}
      >
        {t.common.add}
      </Button>
    </Section>
  );
}

function NewOffer({
  facts,
  onDone,
}: {
  facts: BrandFactView[];
  onDone: () => void;
}) {
  const c = usePubContent();
  const apis = usePubApis();
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [priceNote, setPriceNote] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const m = useMutation();
  const active = facts.filter((x) => x.status === 'active');
  return (
    <div className="space-y-2">
      <Field label={c.brand.offerTitle}>
        <TextInput value={title} onChange={setTitle} maxLength={200} />
      </Field>
      <Field label={c.brand.offerText}>
        <TextArea value={text} onChange={setText} rows={4} />
      </Field>
      <Field label={c.brand.priceNote}>
        <TextInput value={priceNote} onChange={setPriceNote} maxLength={300} />
      </Field>
      {active.length > 0 && (
        <Field label={c.brand.factIds}>
          <div className="max-h-32 overflow-auto space-y-1">
            {active.map((x) => (
              <label key={x.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={picked.includes(x.id)}
                  onChange={(e) =>
                    setPicked((p) =>
                      e.target.checked
                        ? [...p, x.id]
                        : p.filter((y) => y !== x.id)
                    )
                  }
                />
                {x.factKey}
              </label>
            ))}
          </div>
        </Field>
      )}
      <Notice text={notice} />
      <PubErrorAlert error={m.error} />
      <Button
        variant="outline"
        loading={m.busy}
        disabled={!title.trim() || !text.trim()}
        onClick={async () => {
          const r = await m.run((k) =>
            apis.content.createOffer(
              {
                title: title.trim(),
                text: text.trim(),
                priceNote: priceNote.trim() || null,
                factIds: picked,
              },
              k
            )
          );
          if (r) {
            setNotice(c.brand.offerAdded);
            setTitle('');
            setText('');
            onDone();
          }
        }}
      >
        {c.brand.addOffer}
      </Button>
    </div>
  );
}

function OfferRow({
  offer: o,
  onDone,
}: {
  offer: OfferVersionView;
  onDone: (cs: CascadeSummary) => void;
}) {
  const c = usePubContent();
  const { can } = usePublisher();
  const apis = usePubApis();
  const [basis, setBasis] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const m = useMutation();
  return (
    <li className="py-2 space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium flex-1 min-w-0">
          v{o.version} · {o.title}
        </span>
        <StatusBadge status={o.status} labels={c.brand.offerStatuses} />
      </div>
      <div className="text-sm whitespace-pre-wrap">{o.text}</div>
      {o.priceNote && (
        <div className="text-xs text-silver-500">{o.priceNote}</div>
      )}
      <Notice text={notice} />
      {can('brand.activate') && o.status === 'draft' && (
        <div className="flex flex-wrap items-center gap-2">
          <TextInput
            value={basis}
            onChange={setBasis}
            placeholder={c.brand.basis}
            maxLength={1000}
          />
          <ConfirmButton
            variant="solid"
            loading={m.busy}
            disabled={!basis.trim()}
            onConfirm={async () => {
              const r = await m.run((k) =>
                apis.content.activateOffer(o.id, basis.trim(), k)
              );
              if (r) {
                setNotice(
                  fmtText(c.brand.offerActivated, {
                    v: r.parameterVersion,
                    tasks: r.cascade.tasksOpened,
                  })
                );
                onDone(r.cascade);
              }
            }}
          >
            {c.brand.activateOffer}
          </ConfirmButton>
        </div>
      )}
      <PubErrorAlert error={m.error} />
    </li>
  );
}
