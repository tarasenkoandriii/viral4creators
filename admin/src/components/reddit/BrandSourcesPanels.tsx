'use client';

// «Настройка» (контракт v1.2, §4): оффер и факты бренда платформенного
// продукта — чтобы гейт `reddit_publish` (`offer_active_version`)
// закрывался из Админки; источники контента — список (для тезисов брифа)
// и ручной источник `manual_text|url` (ссылка только хранится, сервер её
// не загружает). Тела и значения фактов — чистые функции кабинета
// (`brand-view`, `content-api`), тексты — словарь `publisher-content-ru`.

import { useState } from 'react';
import { C, fmtDateTime, R, T } from '../../lib/reddit';
import { factValue, sourceBody, type SourceForm } from '../../lib/reddit-shared/lib/publisher/brand-view';
import {
  factValueText,
  type BrandFactView,
  type CascadeSummary,
  type OfferVersionView,
  type SourceView,
} from '../../lib/reddit-shared/lib/publisher/content-api';
import { BRAND_FACT_KINDS, BRAND_FACT_STATUSES, SOURCE_VISIBILITIES, type BrandFactKind } from '../../lib/reddit-shared/lib/publisher/states';
import { fmtText } from '../../lib/reddit-shared/lib/publisher/view';
import {
  Alert,
  Badge,
  ConfirmButton,
  CsvButton,
  ErrorAlert,
  Field,
  Notice,
  PagedFooter,
  PlainQuote,
  Section,
  Select,
  useMutation,
  usePaged,
  useRx,
} from './ui';

const cascadeText = (c: CascadeSummary) =>
  [
    fmtText(C.brand.cascadeTasks, { n: c.tasksOpened }),
    c.correctionRequired.length ? fmtText(C.brand.cascadeCorrection, { n: c.correctionRequired.length }) : '',
    c.approvalsSuperseded.length ? fmtText(C.brand.cascadeSuperseded, { n: c.approvalsSuperseded.length }) : '',
  ]
    .filter(Boolean)
    .join(' · ');

// ── Оффер ─────────────────────────────────────────────────────────────────

export function OfferPanel({ onChanged, factsTick = 0 }: { onChanged: () => void; factsTick?: number }) {
  const { api } = useRx();
  const offers = usePaged((before) => api.content.offers({ before, limit: 20 }), [api]);
  // Активные факты для оффера — перечитываются после решений по фактам.
  const facts = usePaged((before) => api.content.facts({ status: 'active', before, limit: 100 }), [api, factsTick]);
  const after = () => {
    offers.reload();
    onChanged();
  };
  return (
    <Section title={C.brand.offers}>
      <span className="muted rx-hint">
        Активная версия оффера закрывает параметр гейта «{T.params.keys.offer_active_version}»: активирует оператор Админки (решение
        пишется с актором Админки).
      </span>
      <ul className="rx-items" data-offers="">
        {offers.items.map((o) => (
          <OfferRow key={o.id} o={o} onDone={after} />
        ))}
      </ul>
      <PagedFooter page={offers} empty={T.common.empty} />
      <NewOffer facts={facts.items} onDone={offers.reload} />
    </Section>
  );
}

function OfferRow({ o, onDone }: { o: OfferVersionView; onDone: () => void }) {
  const { api } = useRx();
  const m = useMutation();
  const [basis, setBasis] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <li className="rx-item">
      <div className="rx-row">
        <b className="rx-wrap">
          v{o.version} · {o.title}
        </b>
        <Badge tone={o.status === 'active' ? 'success' : o.status === 'draft' ? 'warning' : 'neutral'}>
          {(C.brand.offerStatuses as Record<string, string>)[o.status] ?? o.status}
        </Badge>
        {o.approvedAt && <span className="muted rx-hint">{fmtDateTime(o.approvedAt)}</span>}
      </div>
      <PlainQuote text={o.text} label={C.brand.offerText} />
      {o.priceNote && <span className="rx-hint">{o.priceNote}</span>}
      {o.status === 'draft' && (
        <div className="rx-stack">
          <Field label={C.brand.basis} hint="Не короче 10 знаков.">
            <input value={basis} maxLength={2000} onChange={(e) => setBasis(e.target.value)} />
          </Field>
          <ErrorAlert error={m.error} onReload={onDone} />
          <ConfirmButton
            busy={m.busy}
            disabled={[...basis.trim()].length < 10}
            onConfirm={async () => {
              const r = await m.run((k) => api.content.activateOffer(o.id, basis.trim(), k), `offer:${o.id}:${basis.trim()}`);
              if (r) {
                setNotice(`${fmtText(C.brand.offerActivated, { v: r.parameterVersion, tasks: r.cascade.tasksOpened })} ${cascadeText(r.cascade)}`);
                onDone();
              }
            }}
          >
            {C.brand.activateOffer}
          </ConfirmButton>
        </div>
      )}
      <Notice text={notice} />
    </li>
  );
}

function NewOffer({ facts, onDone }: { facts: BrandFactView[]; onDone: () => void }) {
  const { api } = useRx();
  const m = useMutation();
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [priceNote, setPriceNote] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <div className="rx-inner rx-stack">
      <b>{C.brand.addOffer}</b>
      <Field label={C.brand.offerTitle}>
        <input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label={C.brand.offerText}>
        <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
      <Field label={C.brand.priceNote}>
        <input value={priceNote} maxLength={300} onChange={(e) => setPriceNote(e.target.value)} />
      </Field>
      {facts.length > 0 && (
        <fieldset className="rx-fieldset">
          <legend className="muted">{C.brand.factIds}</legend>
          <div className="rx-row">
            {facts.map((x) => (
              <label key={x.id} className="rx-check">
                <input
                  type="checkbox"
                  checked={picked.includes(x.id)}
                  onChange={(e) => setPicked((p) => (e.target.checked ? [...p, x.id] : p.filter((y) => y !== x.id)))}
                />
                {x.factKey}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <Notice text={notice} />
      <ErrorAlert error={m.error} />
      <button
        type="button"
        disabled={!title.trim() || !text.trim() || m.busy}
        onClick={async () => {
          const body = { title: title.trim(), text: text.trim(), priceNote: priceNote.trim() || null, factIds: picked };
          const r = await m.run((k) => api.content.createOffer(body, k), `createOffer:${JSON.stringify(body)}`);
          if (r) {
            setNotice(C.brand.offerAdded);
            setTitle('');
            setText('');
            setPriceNote('');
            setPicked([]);
            onDone();
          }
        }}
      >
        {C.brand.addOffer}
      </button>
    </div>
  );
}

// ── Факты бренда ──────────────────────────────────────────────────────────

export function FactsPanel({ onChanged }: { onChanged: () => void }) {
  const { api } = useRx();
  const [status, setStatus] = useState('');
  const facts = usePaged((before) => api.content.facts({ status: status || undefined, before, limit: 50 }), [api, status]);
  const after = () => {
    facts.reload();
    onChanged();
  };
  return (
    <Section title={C.brand.facts}>
      <div className="rx-row">
        <Select ariaLabel={T.common.status} value={status} options={BRAND_FACT_STATUSES} labels={C.brand.factStatuses} empty="все статусы" onChange={setStatus} />
        <CsvButton list="brand-facts" query={{ status: status || undefined }} />
      </div>
      <ul className="rx-items" data-facts="">
        {facts.items.map((f) => (
          <FactRow key={f.id} f={f} all={facts.items} onDone={after} />
        ))}
      </ul>
      <PagedFooter page={facts} empty={T.common.empty} />
      <NewFact onDone={facts.reload} />
    </Section>
  );
}

function FactRow({ f, all, onDone }: { f: BrandFactView; all: BrandFactView[]; onDone: () => void }) {
  const { api } = useRx();
  const m = useMutation();
  const [basis, setBasis] = useState('');
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const rival = f.conflictWithId ? all.find((x) => x.id === f.conflictWithId) : null;
  const run = async (action: 'activate' | 'resolve' | 'retire') => {
    const r = await m.run(
      (k) =>
        action === 'activate'
          ? api.content.factDecision(f.id, 'activate', basis.trim() ? { basis: basis.trim() } : {}, k)
          : action === 'resolve'
            ? api.content.factDecision(f.id, 'resolve', { keepId: f.id, reason: reason.trim() }, k)
            : api.content.factDecision(f.id, 'retire', { reason: reason.trim() }, k),
      `fact:${action}:${f.id}:${basis}:${reason}`,
    );
    if (r) {
      setNotice(`${action === 'activate' ? C.brand.activated : action === 'resolve' ? C.brand.resolved : C.brand.retired} ${cascadeText(r.cascade)}`);
      setReason('');
      onDone();
    }
  };
  return (
    <li className="rx-item">
      <div className="rx-row">
        <b className="rx-wrap">{f.factKey}</b>
        <Badge>{(C.brand.factKinds as Record<string, string>)[f.kind] ?? f.kind}</Badge>
        <Badge tone={f.status === 'active' ? 'success' : f.status === 'needs_resolution' ? 'danger' : f.status === 'draft' ? 'warning' : 'neutral'}>
          {(C.brand.factStatuses as Record<string, string>)[f.status] ?? f.status}
        </Badge>
        <span className="muted rx-hint">v{f.version}</span>
      </div>
      <span className="rx-wrap">{factValueText(f.value)}</span>
      {rival && <span className="rx-hint rx-warn">{fmtText(C.brand.conflictWith, { id: `${rival.factKey}: ${factValueText(rival.value)}` })}</span>}
      {f.status === 'draft' && (
        <div className="rx-row">
          <input aria-label={`${C.brand.basis}: ${f.factKey}`} placeholder={C.brand.basis} value={basis} onChange={(e) => setBasis(e.target.value)} className="rx-grow" />
          <button type="button" disabled={m.busy} onClick={() => void run('activate')}>
            {C.brand.activate}
          </button>
        </div>
      )}
      {(f.status === 'needs_resolution' || f.status === 'active') && (
        <div className="rx-row">
          <input
            aria-label={`${f.status === 'needs_resolution' ? C.brand.resolveReason : C.brand.retireReason}: ${f.factKey}`}
            placeholder={f.status === 'needs_resolution' ? C.brand.resolveReason : C.brand.retireReason}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="rx-grow"
          />
          {f.status === 'needs_resolution' && (
            <ConfirmButton busy={m.busy} disabled={!reason.trim()} onConfirm={() => void run('resolve')}>
              {C.brand.resolve}
            </ConfirmButton>
          )}
          <ConfirmButton danger busy={m.busy} disabled={!reason.trim()} onConfirm={() => void run('retire')}>
            {C.brand.retire}
          </ConfirmButton>
        </div>
      )}
      <ErrorAlert error={m.error} onReload={onDone} />
      <Notice text={notice} />
    </li>
  );
}

function NewFact({ onDone }: { onDone: () => void }) {
  const { api } = useRx();
  const m = useMutation();
  const [factKey, setFactKey] = useState('');
  const [kind, setKind] = useState<BrandFactKind | ''>('fact');
  const [text, setText] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [scope, setScope] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const { value, ready } = factValue(kind, { text, amount, currency, question, answer });
  const canAdd = !!factKey.trim() && ready;
  return (
    <div className="rx-inner rx-stack">
      <b>{C.brand.addFact}</b>
      <div className="rx-grid2">
        <Field label={C.brand.factKey}>
          <input value={factKey} maxLength={64} onChange={(e) => setFactKey(e.target.value)} />
        </Field>
        <Field label={C.brand.kind}>
          <Select value={kind} options={BRAND_FACT_KINDS} labels={C.brand.factKinds} onChange={setKind} />
        </Field>
      </div>
      {kind === 'price' && (
        <div className="rx-grid2">
          <Field label={C.brand.priceAmount}>
            <input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label={C.brand.currency}>
            <input value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value)} />
          </Field>
        </div>
      )}
      {kind === 'faq' ? (
        <>
          <Field label={C.brand.faqQuestion}>
            <input value={question} onChange={(e) => setQuestion(e.target.value)} />
          </Field>
          <Field label={C.brand.faqAnswer}>
            <textarea rows={2} value={answer} onChange={(e) => setAnswer(e.target.value)} />
          </Field>
        </>
      ) : (
        <Field label={C.brand.value}>
          <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
      )}
      <Field label={C.brand.scope}>
        <input value={scope} maxLength={200} onChange={(e) => setScope(e.target.value)} />
      </Field>
      <Notice text={notice} />
      <ErrorAlert error={m.error} />
      <button
        type="button"
        disabled={!canAdd || !kind || m.busy}
        onClick={async () => {
          if (!kind) return;
          const body = { factKey: factKey.trim(), kind, value, scope: scope.trim() || null };
          const r = await m.run((k) => api.content.createFact(body, k), `createFact:${JSON.stringify(body)}`);
          if (r) {
            setNotice(r.conflictTaskOpened ? C.brand.conflictOpened : C.brand.factAdded);
            setText('');
            setQuestion('');
            setAnswer('');
            onDone();
          }
        }}
      >
        {C.brand.addFact}
      </button>
    </div>
  );
}

// ── Источники контента ────────────────────────────────────────────────────

export const MANUAL_SOURCE_KINDS = ['manual_text', 'url'] as const;

export function SourcesPanel() {
  const { api } = useRx();
  const [usage, setUsage] = useState('');
  const page = usePaged((before) => api.content.sources({ usage: usage || undefined, before, limit: 50 }), [api, usage]);
  return (
    <Section title={`${C.sources.title} продукта`}>
      <span className="muted rx-hint">{C.sources.hint} Здесь — источники контента для тезисов брифа; доказательства Reddit (выдержки, первоисточники правил) — в карточках.</span>
      <div className="rx-row">
        <Select ariaLabel={C.sources.usage} value={usage} options={['allowed', 'restricted', 'revoked'] as const} labels={C.sources.usages} empty="все" onChange={setUsage} />
        <CsvButton list="sources" query={{ usage: usage || undefined }} />
      </div>
      <ul className="rx-items" data-sources="">
        {page.items.map((s) => (
          <li key={s.id} className="rx-item">
            <div className="rx-row">
              <b className="rx-wrap">{s.title ?? s.id}</b>
              <Badge>{(C.sources.kinds as Record<string, string>)[s.kind] ?? s.kind}</Badge>
              <Badge tone={s.usage === 'allowed' ? 'success' : s.usage === 'revoked' ? 'danger' : 'warning'}>{C.sources.usages[s.usage]}</Badge>
              <span className="muted rx-hint">
                {T.common.id}: {s.id}
              </span>
            </div>
            {s.url && <span className="rx-hint rx-wrap">{s.url}</span>}
            <PlainQuote text={s.fragment} injectionFlag={s.injectionFlag} label={C.sources.fragmentShort} />
          </li>
        ))}
      </ul>
      <PagedFooter page={page} empty={T.common.empty} />
      <ManualSource onDone={page.reload} />
    </Section>
  );
}

const emptySource = (): SourceForm => ({
  kind: 'manual_text',
  title: '',
  url: '',
  author: '',
  publishedOn: '',
  fragment: '',
  language: 'en',
  visibility: 'private',
  usage: 'allowed',
});

function ManualSource({ onDone }: { onDone: () => void }) {
  const { api } = useRx();
  const m = useMutation();
  const [f, setF] = useState<SourceForm>(emptySource);
  const [notice, setNotice] = useState<string | null>(null);
  const body = sourceBody(f);
  const urlMissing = f.kind === 'url' && !f.url.trim();
  return (
    <div className="rx-inner rx-stack">
      <b>{C.sources.add}</b>
      <span className="muted rx-hint">Ссылка только сохраняется: ни Админка, ни сервер её не загружают.</span>
      <div className="rx-grid2">
        <Field label={C.sources.kind}>
          <Select value={f.kind} options={MANUAL_SOURCE_KINDS} labels={C.sources.kinds} onChange={(x) => setF({ ...f, kind: x })} />
        </Field>
        <Field label={C.sources.fields.title}>
          <input value={f.title} maxLength={300} onChange={(e) => setF({ ...f, title: e.target.value })} />
        </Field>
      </div>
      <Field label={C.sources.fields.url}>
        <input type="url" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} />
      </Field>
      <Field label={C.sources.fields.fragment}>
        <textarea rows={4} value={f.fragment} onChange={(e) => setF({ ...f, fragment: e.target.value })} />
      </Field>
      <div className="rx-grid3">
        <Field label={C.sources.fields.language}>
          <input value={f.language} maxLength={8} onChange={(e) => setF({ ...f, language: e.target.value })} />
        </Field>
        <Field label={C.sources.visibility}>
          <Select value={f.visibility} options={SOURCE_VISIBILITIES} labels={C.sources.visibilities} onChange={(x) => setF({ ...f, visibility: x })} />
        </Field>
        <Field label={C.sources.usage}>
          <Select value={f.usage} options={['allowed', 'restricted'] as const} labels={C.sources.usages} onChange={(x) => setF({ ...f, usage: x })} />
        </Field>
      </div>
      <Notice text={notice} />
      <ErrorAlert error={m.error} />
      <button
        type="button"
        disabled={!body || urlMissing || m.busy}
        onClick={async () => {
          if (!body) return;
          const r = await m.run((k) => api.content.createSource(body, k), `createSource:${JSON.stringify(body)}`);
          if (r) {
            setNotice(C.sources.created);
            setF(emptySource());
            onDone();
          }
        }}
      >
        {C.sources.add}
      </button>
    </div>
  );
}

/**
 * Выбор источников тезиса брифа (вместо ввода id): разрешённые и
 * ограниченные источники контента; незнакомый id из формы остаётся видимым.
 */
export function SourcePicker({ value, onChange, sources, label }: { value: string; onChange: (v: string) => void; sources: SourceView[]; label: string }) {
  const ids = value
    .split(/[\s,;]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const usable = sources.filter((s) => s.usage !== 'revoked');
  const unknown = ids.filter((id) => !usable.some((s) => s.id === id));
  const set = (next: string[]) => onChange(next.join(', '));
  return (
    <fieldset className="rx-fieldset rx-stack">
      <legend className="muted">{label}</legend>
      {usable.length === 0 ? (
        <Alert tone="neutral">{R.briefs.noSources.replace('в разделе «Источники»', 'в «Статус и настройка» → «Источники продукта»')}</Alert>
      ) : (
        <div className="rx-stack rx-picker">
          {usable.map((s) => (
            <label key={s.id} className="rx-check">
              <input
                type="checkbox"
                checked={ids.includes(s.id)}
                disabled={!ids.includes(s.id) && ids.length >= 10}
                onChange={(e) => set(e.target.checked ? [...ids, s.id] : ids.filter((x) => x !== s.id))}
              />
              <span className="rx-wrap">
                {s.title ?? s.id} <span className="muted rx-hint">({C.sources.usages[s.usage]})</span>
              </span>
            </label>
          ))}
        </div>
      )}
      {unknown.length > 0 && <span className="rx-hint rx-warn">{unknown.map((id) => fmtText(R.briefs.sourceUnknown, { id })).join(', ')}</span>}
      <span className="muted rx-hint">{fmtText(R.briefs.sourcesChosen, { n: ids.length })}</span>
    </fieldset>
  );
}
