'use client';

// «Статус и настройка» (Р-RD-ADM-1, -3, -5): флаг раздела, платформенный
// продукт (`setup` — идемпотентно), гейт `reddit_publish` и его параметры —
// предложить значение и утвердить (решение пишется с актором Админки).

import { useState } from 'react';
import {
  aiReadiness,
  AI_PARAM_KEYS,
  decideBody,
  gateMissingText,
  hintValue,
  productLine,
  fmtDateTime,
  paramDraft,
  parseParamValue,
  SECTION_TEXT,
  sectionState,
  T,
  type AdminRedditStatus,
  type DecideStatus,
  type GateLite,
  type ParamHints,
} from '../../lib/reddit';
import { FactsPanel, OfferPanel, SourcesPanel } from './BrandSourcesPanels';
import { DEPENDENT_STAGES, type DependentStage } from '../../lib/reddit-shared/lib/publisher/states';
import type { ParameterView } from '../../lib/reddit-shared/lib/publisher/core-api';
import { fmtText } from '../../lib/reddit-shared/lib/publisher/view';
import {
  ActorText,
  Alert,
  Badge,
  ConfirmButton,
  ErrorAlert,
  Field,
  Loading,
  Notice,
  PlainText,
  Row,
  Section,
  Select,
  useLoad,
  useMutation,
  useRx,
} from './ui';

const label = (map: Record<string, string>, k: string) => (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : k);

export function GateMissingList({ gate }: { gate: GateLite }) {
  if (gate.open) return <Badge tone="success">{T.gates.open}</Badge>;
  return (
    <div className="rx-stack">
      <Badge tone="warning">{T.gates.closed}</Badge>
      <ul className="rx-list">
        {gate.missing.map((m, i) => (
          <li key={i}>{gateMissingText(m)}</li>
        ))}
      </ul>
    </div>
  );
}

export function SetupTab({
  status,
  statusError,
  onStatus,
  reloadStatus,
}: {
  status: AdminRedditStatus | null;
  statusError: unknown;
  onStatus: (s: AdminRedditStatus) => void;
  reloadStatus: () => void;
}) {
  const { api } = useRx();
  const mu = useMutation();
  const [notice, setNotice] = useState<string | null>(null);
  const [factsTick, setFactsTick] = useState(0);
  if (statusError) return <ErrorAlert error={statusError} />;
  if (!status) return <Loading />;
  const state = sectionState(status);
  return (
    <div className="rx-stack">
      <Section title="Статус раздела">
        <Row label="Раздел (PUBLISHER_REDDIT_ENABLED)">
          {status.enabled ? <Badge tone="success">включён</Badge> : <Badge tone="danger">выключен</Badge>}
        </Row>
        <Row label="Генерация (PUBLISHER_REDDIT_AI_ENABLED)">
          {status.aiEnabled ? 'включена' : 'выключена — тексты пишутся вручную'}
        </Row>
        <Row label="Платформенный сайт">{status.platformSiteId ?? R_NONE}</Row>
        <Row label="Продукт Publisher">{productLine(status)}
        </Row>
        <Alert tone={state === 'ready' ? 'success' : state === 'no_product' ? 'neutral' : 'warning'}>{SECTION_TEXT[state]}</Alert>
        <p className="muted rx-hint">
          Только ручной режим (MANUAL_COPY): Админка и сервер не обращаются к Reddit — сообщества, правила и треды вносятся по
          ссылкам, текст копируется человеком, публикация отмечается «со слов пользователя».
        </p>
        {state === 'no_product' && (
          <>
            <ErrorAlert error={mu.error} />
            <ConfirmButton
              busy={mu.busy}
              onConfirm={async () => {
                const s = await mu.run(() => api.admin.setup(), 'setup');
                if (s) {
                  onStatus(s);
                  setNotice(s.created ? 'Продукт заведён.' : 'Продукт уже был — показан он.');
                }
              }}
            >
              Завести продукт
            </ConfirmButton>
          </>
        )}
        <Notice text={notice} />
        <button type="button" onClick={reloadStatus}>
          Обновить статус
        </button>
      </Section>
      {state === 'ready' && <AiStatus status={status} />}
      {state === 'ready' && status.gate && (
        <Section title={`${T.gates.title}: ${T.gates.names.reddit_publish}`}>
          <GateMissingList gate={status.gate} />
          <p className="muted rx-hint">{T.gates.hint}</p>
        </Section>
      )}
      {state === 'ready' && <ParamsPanel onChanged={reloadStatus} status={status} />}
      {state === 'ready' && <OfferPanel onChanged={reloadStatus} factsTick={factsTick} />}
      {state === 'ready' && (
        <FactsPanel
          onChanged={() => {
            setFactsTick((x) => x + 1);
            reloadStatus();
          }}
        />
      )}
      {state === 'ready' && <SourcesPanel />}
    </div>
  );
}

const R_NONE = '—';

/** Генерация из Админки: флаг, генератор (до eval), гейт `ai_use`, месяц AI. */
function AiStatus({ status }: { status: AdminRedditStatus }) {
  const a = aiReadiness(status);
  return (
    <Section title={`${T.gates.names.ai_use} и генерация`} action={<Badge tone={a.ready ? 'success' : 'warning'}>{a.ready ? 'доступна' : 'недоступна'}</Badge>}>
      <ul className="rx-list" data-ai-status="">
        {a.lines.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
      <span className="muted rx-hint">Ручной путь («Написать самому») работает всегда — проверки и согласование те же.</span>
    </Section>
  );
}
const C_OFFERS = 'Версии оффера';

function ParamsPanel({ onChanged, status }: { onChanged: () => void; status: AdminRedditStatus }) {
  const { api } = useRx();
  // Перечитываются вместе со статусом (оффер активирован → подсказки и гейт).
  const params = useLoad(() => api.admin.params(), [api, status]);
  const [open, setOpen] = useState<string>('');
  if (params.error) return <ErrorAlert error={params.error} onReload={params.reload} />;
  if (!params.data) return <Loading />;
  const p = params.data;
  const aiKeys: readonly string[] = AI_PARAM_KEYS;
  const publish = p.items.filter((x) => !aiKeys.includes(x.key));
  const ai = AI_PARAM_KEYS.map((k) => p.items.find((x) => x.key === k)).filter((x): x is ParameterView => !!x);
  const table = (items: ParameterView[], testid: string) => (
    <div className="table-scroll">
      <table className="table-narrow" data-params={testid}>
        <thead>
          <tr>
            <th>Параметр</th>
            <th>{T.common.status}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {items.map((x) => (
            <tr key={x.key}>
              <td>
                {label(T.params.keys, x.key)}
                <div className="muted rx-hint">{x.key}</div>
              </td>
              <td>
                <Badge tone={x.status === 'approved' ? 'success' : x.status === 'assumption' ? 'warning' : 'danger'}>{label(T.params.statuses, x.status)}</Badge>
                {x.openProposals > 0 && <div className="rx-hint">{fmtText(T.params.openProposals, { n: x.openProposals })}</div>}
              </td>
              <td>
                <button type="button" onClick={() => setOpen(open === x.key ? '' : x.key)} aria-expanded={open === x.key}>
                  {open === x.key ? T.common.close : T.common.open}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  const card = (items: ParameterView[]) =>
    items
      .filter((x) => x.key === open)
      .map((x) => (
        <ParamCard
          key={`${x.key}:${x.revision}`}
          param={x}
          hints={p.hints}
          onChanged={() => {
            params.reload();
            onChanged();
          }}
        />
      ));
  return (
    <>
      <Section title={`Параметры гейта «${T.gates.names.reddit_publish}»`}>
        <p className="muted rx-hint">{T.params.hint}</p>
        {table(publish, 'publish')}
        {card(publish)}
      </Section>
      {ai.length > 0 && (
        <Section title="AI и бюджет">
          <p className="muted rx-hint">
            Для генерации из Админки: утвердите по порядку «{T.params.keys.ai_budget_usd_month}» (<code>{'{"microUsd": 20000000}'}</code>), «
            {T.params.keys.ai_fx_rate}» (курс вводите сами — сети нет: <code>{'{"rate": "41.5", "source": "НБУ", "at": "<дата ISO>"}'}</code>), по
            желанию «{T.params.keys.ai_unpriced_allowed}», затем три ключа бюджета значениями подсказки «только AI»
            {p.hints.budget?.aiMonthMinor != null
              ? ` (месяц AI = ${(p.hints.budget.aiMonthMinor / 100).toFixed(2)} ${p.hints.budget.currency} × ${p.hints.budget.months})`
              : ' (подсказка появится после курса)'}
            . Месяц AI откроет ближайший проход задания открытия месяца.
          </p>
          {table(ai, 'ai')}
          {card(ai)}
        </Section>
      )}
    </>
  );
}

function ParamCard({ param, hints, onChanged }: { param: ParameterView; hints: ParamHints; onChanged: () => void }) {
  const { api, userId } = useRx();
  const [json, setJson] = useState(() => paramDraft(param.value));
  const [jsonError, setJsonError] = useState(false);
  const [toStatus, setToStatus] = useState<DecideStatus>('approved');
  const [proposalId, setProposalId] = useState('');
  const [basis, setBasis] = useState('');
  const [stages, setStages] = useState<DependentStage[]>(() => [...param.gates]);
  const [notice, setNotice] = useState<string | null>(null);
  const propose = useMutation();
  const decide = useMutation();
  const proposals = useLoad(() => api.admin.proposals(param.key), [api, param.key, param.revision, param.openProposals]);
  const body = decideBody(param, { toStatus, proposalId, basis, stages });
  return (
    <div className="card rx-stack rx-inner">
      <h3>{label(T.params.keys, param.key)}</h3>
      <Row label={T.params.value}>
        <PlainText text={paramDraft(param.value)} />
      </Row>
      <Row label={T.common.status}>
        {label(T.params.statuses, param.status)} · {fmtText(T.params.version, { n: param.version })}
        {param.approvedAt ? ` · ${fmtDateTime(param.approvedAt)}` : ''}
      </Row>
      <div className="rx-stack">
        <b>{T.params.proposals}</b>
        {proposals.error ? (
          <ErrorAlert error={proposals.error} />
        ) : !proposals.data ? (
          <Loading />
        ) : proposals.data.items.length === 0 ? (
          <span className="muted">{T.params.proposalsEmpty}</span>
        ) : (
          <ul className="rx-list">
            {proposals.data.items.map((x) => (
              <li key={x.id}>
                <span className="rx-wrap">
                  {label(T.params.proposalStatuses, x.status)} · {T.params.proposalBy} <ActorText actor={x.proposedBy} userId={userId} /> ·{' '}
                  {fmtDateTime(x.proposedAt)}
                </span>
                <PlainText text={paramDraft(x.value)} />
                {x.status === 'open' && (
                  <button
                    type="button"
                    onClick={() => {
                      setProposalId(x.id);
                      setToStatus('approved');
                    }}
                  >
                    {T.params.useProposal}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {hintValue(param.key, hints) !== null && (
        <div className="rx-row">
          <span className="muted rx-hint">Подсказка сервера: {JSON.stringify(hintValue(param.key, hints))}</span>
          <button type="button" onClick={() => setJson(paramDraft(hintValue(param.key, hints)))}>
            Подставить подсказку
          </button>
        </div>
      )}
      {param.key === 'offer_active_version' && !hints.offerActiveVersion && (
        <Alert tone="neutral">Активной версии оффера нет — создайте и активируйте её в разделе «{C_OFFERS}» ниже.</Alert>
      )}
      <Field label={T.params.propose} hint={T.params.proposeHint}>
        <textarea rows={6} value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} />
      </Field>
      {jsonError && <Alert tone="danger">{T.params.jsonInvalid}</Alert>}
      <ErrorAlert error={propose.error} onReload={onChanged} />
      <button
        type="button"
        disabled={propose.busy}
        onClick={async () => {
          const v = parseParamValue(json);
          setJsonError(!v.ok);
          if (!v.ok) return;
          const r = await propose.run((k) => api.admin.propose(param.key, v.value, k), `propose:${param.key}:${json}`);
          if (r) {
            setProposalId(r.proposalId);
            setNotice(T.params.proposed);
            proposals.reload();
          }
        }}
      >
        {T.params.propose}
      </button>
      <div className="rx-stack rx-divider">
        <b>{T.params.decide}</b>
        <p className="muted rx-hint">{T.params.decideHint}</p>
        <Field label={T.params.toStatus}>
          <Select
            value={toStatus}
            options={['approved', 'rejected', 'revoked', 'assumption'] as const}
            labels={T.params.toStatuses}
            onChange={(v) => v && setToStatus(v)}
          />
        </Field>
        <Field label={T.params.proposalId}>
          <input value={proposalId} onChange={(e) => setProposalId(e.target.value)} />
        </Field>
        <Field label={T.params.basis} hint="Не короче 10 знаков; без телефонов и контактов.">
          <textarea rows={3} maxLength={2000} value={basis} onChange={(e) => setBasis(e.target.value)} />
        </Field>
        <fieldset className="rx-fieldset">
          <legend className="muted">{T.params.stages}</legend>
          <div className="rx-row">
            {DEPENDENT_STAGES.map((s) => (
              <label key={s} className="rx-check">
                <input
                  type="checkbox"
                  checked={stages.includes(s)}
                  onChange={(e) => setStages((x) => (e.target.checked ? [...x, s] : x.filter((y) => y !== s)))}
                />
                {s === 'reports' ? T.params.stageReports : label(T.gates.names, s)}
              </label>
            ))}
          </div>
        </fieldset>
        <ErrorAlert error={decide.error} onReload={onChanged} />
        <ConfirmButton
          busy={decide.busy}
          disabled={!body}
          onConfirm={async () => {
            if (!body) return;
            const r = await decide.run((k) => api.admin.decide(param.key, body, k), `decide:${param.key}:${JSON.stringify(body)}`);
            if (r) {
              setNotice(T.params.decided);
              onChanged();
            }
          }}
        >
          {T.params.decide}
        </ConfirmButton>
      </div>
      <Notice text={notice} />
    </div>
  );
}
