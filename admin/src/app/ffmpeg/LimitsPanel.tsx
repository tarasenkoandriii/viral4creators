'use client';

// Лимиты и обслуживание (ТЗ §13.1 п.4): эффективные лимиты и их ревизия,
// маршрутизация новых задач, режим приёма, история изменений. Секреты,
// hostname API, доступ к файловой системе, образ контейнера и произвольные
// команды здесь не редактируются. Одновременных задач на общем VPS — 1,
// UI выше не предлагает. Изменения касаются только новых задач.
import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import {
  ACTION_LABEL,
  EVENT_LABEL,
  FFMPEG_PRODUCTS,
  LIMIT_FIELDS,
  PRODUCT_LABEL,
  PROVIDER_LABEL,
  UNIT_LABEL,
  diffLimits,
  diffRouting,
  ffmpegErrorText,
  formatLimit,
  kyivTime,
  labelOf,
  shortId,
  toDisplay,
  type LimitChange,
  type RoutingChange,
} from '../../lib/ffmpeg';
import type { FfmpegLimitsView, FfmpegProduct, FfmpegProvider, FfmpegRouting } from '../../lib/types';
import { Badge, ErrorLine, Observed, StaleBanner } from './ui';

const RESULT_TONE: Record<string, 'ok' | 'warning' | 'critical' | 'neutral'> = {
  succeeded: 'ok',
  requested: 'neutral',
  failed: 'critical',
  unknown: 'warning',
};
const RESULT_LABEL: Record<string, string> = {
  succeeded: 'выполнено',
  requested: 'отправлено, исход не записан',
  failed: 'отказ',
  unknown: 'исход неизвестен',
};

export function LimitsPanel({
  view,
  error,
  busy,
  onLimits,
  onRouting,
}: {
  view: FfmpegLimitsView | null;
  error: unknown;
  busy: boolean;
  onLimits: (changes: LimitChange[], baseRevision: number) => void;
  onRouting: (change: RoutingChange, next: { provider: FfmpegProvider; canary: FfmpegProduct[] }, base: FfmpegRouting) => void;
}) {
  const uid = useId();
  const [editLimits, setEditLimits] = useState<{ base: number; draft: Record<string, string> } | null>(null);
  const [editRouting, setEditRouting] = useState<{ base: FfmpegRouting; provider: FfmpegProvider; canary: FfmpegProduct[] } | null>(null);

  const limitsCheck = view && editLimits ? diffLimits(view.effective, view.bounds, editLimits.draft, view.editable) : null;
  const limitsMoved = !!view && !!editLimits && view.revision !== editLimits.base;
  const routingCheck = editRouting ? diffRouting(editRouting.base, editRouting.provider, editRouting.canary) : null;
  const routingMoved = !!view?.routing && !!editRouting && view.routing.revision !== editRouting.base.revision;
  const editableField = (key: string) => typeof view?.bounds[key] === 'number' && (!view?.editable.length || view.editable.includes(key));

  const startLimits = () => {
    if (!view || view.revision === null) return;
    const draft: Record<string, string> = {};
    for (const f of LIMIT_FIELDS) if (typeof view.effective[f.key] === 'number') draft[f.key] = toDisplay(f.unit, view.effective[f.key]);
    setEditLimits({ base: view.revision, draft });
  };
  const submitLimits = (e: FormEvent) => {
    e.preventDefault();
    if (!editLimits || !limitsCheck || limitsMoved) return;
    if (limitsCheck.changes.length === 0 || Object.keys(limitsCheck.errors).length > 0) return;
    onLimits(limitsCheck.changes, editLimits.base);
  };
  const submitRouting = (e: FormEvent) => {
    e.preventDefault();
    if (!editRouting || !routingCheck?.changed || routingMoved) return;
    onRouting(routingCheck, { provider: editRouting.provider, canary: editRouting.canary }, editRouting.base);
  };

  return (
    <section className="card" aria-labelledby="ff-limits-title" style={{ marginBottom: 16 }}>
      <h2 id="ff-limits-title" style={{ fontSize: 18, margin: '0 0 8px' }}>
        Лимиты и обслуживание
      </h2>
      {error != null && <ErrorLine text={`Лимиты не обновились: ${ffmpegErrorText(error)}`} />}
      {view?.stale && <StaleBanner title="Лимиты получены не от FFmpeg-сервера" reason={view.staleReason} at={view.observedAt} />}
      {!view && !error && <p className="muted">Загрузка лимитов…</p>}
      {view && (
        <>
          <p style={{ fontSize: 13, margin: '0 0 4px' }}>
            Ревизия лимитов: <strong>{view.revision ?? 'неизвестна'}</strong>
          </p>
          <div style={{ marginBottom: 8 }}>
            <Observed at={view.observedAt} fresh={view.stale ? 'stale' : view.revision === null ? 'missing' : 'fresh'} />
          </div>
          <p className="muted" style={{ fontSize: 13 }}>
            Одновременных задач: 1 — на общем VPS больше не разрешено, поле не редактируется. Изменения действуют только на новые задачи;
            провайдер и профиль уже принятых не меняются.
          </p>

          {!editLimits && (
            <>
              <div className="table-scroll" role="region" aria-label="Эффективные лимиты" tabIndex={0}>
                <table className="table-narrow">
                  <thead>
                    <tr>
                      <th scope="col">Лимит</th>
                      <th scope="col">Сейчас</th>
                      <th scope="col">Граница деплоя</th>
                    </tr>
                  </thead>
                  <tbody>
                    {LIMIT_FIELDS.map((f) => (
                      <tr key={f.key}>
                        <td>{f.label}</td>
                        <td>{formatLimit(f.unit, view.effective[f.key])}</td>
                        <td className="muted">{typeof view.bounds[f.key] === 'number' ? formatLimit(f.unit, view.bounds[f.key]) : 'неизвестна'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button type="button" onClick={startLimits} disabled={busy || view.revision === null} style={{ marginTop: 10 }}>
                Изменить лимиты…
              </button>
            </>
          )}

          {editLimits && limitsCheck && (
            <form onSubmit={submitLimits} aria-label="Изменение лимитов" style={{ marginTop: 8 }}>
              {limitsMoved && (
                <div className="rx-alert rx-alert-warning" role="alert" style={{ marginBottom: 10 }}>
                  Лимиты изменились, пока вы редактировали (ревизия {editLimits.base} → {view.revision}). Отмените правку и начните заново.
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 10 }}>
                {LIMIT_FIELDS.map((f) => {
                  const err = limitsCheck.errors[f.key];
                  const inputId = `${uid}-lim-${f.key}`;
                  const hintId = `${inputId}-hint`;
                  return (
                    <div key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, minWidth: 0 }}>
                      <label htmlFor={inputId}>
                        {f.label}, {UNIT_LABEL[f.unit]}
                      </label>
                      <input
                        id={inputId}
                        inputMode="decimal"
                        value={editLimits.draft[f.key] ?? ''}
                        disabled={!editableField(f.key)}
                        aria-invalid={!!err}
                        aria-describedby={hintId}
                        onChange={(e) => setEditLimits((s) => (s ? { ...s, draft: { ...s.draft, [f.key]: e.target.value } } : s))}
                      />
                      <span id={hintId} className={err ? 'critical' : 'muted'} style={{ fontSize: 12 }}>
                        {err ?? (editableField(f.key) ? `не больше ${formatLimit(f.unit, view.bounds[f.key])}` : 'не редактируется (нет границы деплоя или запрещено backend)')}
                      </span>
                    </div>
                  );
                })}
              </div>
              <p style={{ fontSize: 13 }} aria-live="polite">
                {limitsCheck.changes.length === 0 ? 'Изменений пока нет.' : `Изменено полей: ${limitsCheck.changes.length}.`}
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                <button
                  type="submit"
                  disabled={busy || limitsMoved || limitsCheck.changes.length === 0 || Object.keys(limitsCheck.errors).length > 0}
                >
                  Проверить и применить…
                </button>
                <button type="button" onClick={() => setEditLimits(null)}>
                  Отменить правку
                </button>
              </div>
            </form>
          )}

          <h3 style={{ fontSize: 15, marginTop: 20 }}>Маршрутизация новых задач</h3>
          {view.routing ? (
            !editRouting ? (
              <>
                <p style={{ fontSize: 13 }}>
                  По умолчанию: <strong>{PROVIDER_LABEL[view.routing.defaultProvider]}</strong> (ревизия {view.routing.revision ?? 'неизвестна'}
                  {view.routing.updatedAt ? `, изменено ${kyivTime(view.routing.updatedAt)}` : ''}). Canary:{' '}
                  {view.routing.canaryProducts.length ? view.routing.canaryProducts.map((p) => PRODUCT_LABEL[p]).join(', ') : 'нет'}.
                </p>
                <p style={{ fontSize: 13 }}>
                  Фактически новые задачи получат: <strong>{PROVIDER_LABEL[view.routing.effectiveDefaultProvider]}</strong>; canary действует для:{' '}
                  {view.routing.effectiveCanaryProducts.length ? view.routing.effectiveCanaryProducts.map((p) => PRODUCT_LABEL[p]).join(', ') : 'никого'}.
                </p>
                {!view.routing.selfhostedEnabled && (
                  <p className="muted" style={{ fontSize: 13 }}>
                    env-гейт FFMPEG_SELFHOSTED_ENABLED выключен: пока его не включат деплоем, все новые задачи идут в hosted независимо от
                    настройки.
                  </p>
                )}
                {view.routing.selfhostedEnabled && !view.routing.selfhostedConfigured && (
                  <p className="muted" style={{ fontSize: 13 }}>Адрес или ключ своего сервера не заданы в backend — новые задачи идут в hosted.</p>
                )}
                {view.routing.revision === null && (
                  <p className="critical" style={{ fontSize: 13 }}>Таблица маршрутизации недоступна — изменить настройку сейчас нельзя.</p>
                )}
                <button
                  type="button"
                  disabled={busy || view.routing.revision === null}
                  onClick={() =>
                    view.routing &&
                    setEditRouting({ base: view.routing, provider: view.routing.defaultProvider, canary: [...view.routing.canaryProducts] })
                  }
                >
                  Изменить маршрутизацию…
                </button>
              </>
            ) : (
              <form onSubmit={submitRouting} aria-label="Изменение маршрутизации">
                {routingMoved && (
                  <div className="rx-alert rx-alert-warning" role="alert" style={{ marginBottom: 10 }}>
                    Маршрутизация изменилась, пока вы редактировали (ревизия {editRouting.base.revision} → {view.routing.revision}). Отмените
                    правку и начните заново.
                  </div>
                )}
                <fieldset className="rx-fieldset" style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
                  <legend>Провайдер по умолчанию</legend>
                  {(['hosted', 'selfhosted'] as const).map((p) => (
                    <label key={p} style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 44, fontSize: 13 }}>
                      <input
                        type="radio"
                        name={`${uid}-provider`}
                        value={p}
                        checked={editRouting.provider === p}
                        onChange={() => setEditRouting((s) => (s ? { ...s, provider: p } : s))}
                        style={{ width: 20, height: 20 }}
                      />
                      {PROVIDER_LABEL[p]}
                    </label>
                  ))}
                  {routingCheck?.toSelfhostedDefault && (
                    <p className="critical" style={{ fontSize: 13 }}>
                      Перевод default → selfhosted потребует отдельного подтверждения владельца после критериев приёмки canary.
                    </p>
                  )}
                </fieldset>
                <fieldset className="rx-fieldset" style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10, marginTop: 10 }}>
                  <legend>Canary allowlist (новые задачи этих продуктов — на selfhosted)</legend>
                  {FFMPEG_PRODUCTS.map((p) => (
                    <label key={p} style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 44, fontSize: 13 }}>
                      <input
                        type="checkbox"
                        checked={editRouting.canary.includes(p)}
                        onChange={(e) =>
                          setEditRouting((s) =>
                            s ? { ...s, canary: e.target.checked ? [...s.canary, p] : s.canary.filter((x) => x !== p) } : s,
                          )
                        }
                        style={{ width: 20, height: 20 }}
                      />
                      {PRODUCT_LABEL[p]}
                    </label>
                  ))}
                </fieldset>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
                  <button type="submit" disabled={busy || routingMoved || !routingCheck?.changed}>
                    Проверить и применить…
                  </button>
                  <button type="button" onClick={() => setEditRouting(null)}>
                    Отменить правку
                  </button>
                </div>
              </form>
            )
          ) : (
            <p className="critical">Настройка маршрутизации недоступна — изменить её сейчас нельзя.</p>
          )}

          <h3 style={{ fontSize: 15, marginTop: 20 }}>Режим сервера: история pause / drain / resume</h3>
          {view.controlHistory.length ? (
            <ul style={{ fontSize: 13, paddingLeft: 20 }}>
              {view.controlHistory.map((e, i) => (
                <li key={`${e.at}-${i}`}>
                  <span className="muted">{kyivTime(e.at)}</span> — {labelOf(EVENT_LABEL, e.event)}
                  {e.from || e.to ? ` (${e.from ?? '?'} → ${e.to ?? '?'})` : ''}
                  {e.reason ? <span className="muted"> · {e.reason}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{view.stale ? 'Нет данных: сервер не ответил.' : 'Смен режима не было.'}</p>
          )}

          <h3 style={{ fontSize: 15, marginTop: 20 }}>Ревизии лимитов на сервере</h3>
          {view.serverHistory.length ? (
            <ul style={{ fontSize: 13, paddingLeft: 20 }}>
              {view.serverHistory.map((h) => (
                <li key={h.revision}>
                  ревизия {h.revision} — <span className="muted">{kyivTime(h.at)}</span>
                  {h.actor ? ` · ${h.actor}` : ''}
                  {h.reason ? <span className="muted"> · {h.reason}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{view.stale ? 'Нет данных: сервер не ответил.' : 'Изменений не было.'}</p>
          )}

          <h3 style={{ fontSize: 15, marginTop: 20 }}>Журнал действий операторов</h3>
          <p className="muted" style={{ fontSize: 12 }}>Журнал append-only, хранится 90 дней. Токены, команды и личные тексты в него не пишутся.</p>
          {view.history.length ? (
            <div className="table-scroll" role="region" aria-label="Журнал действий" tabIndex={0}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Когда (Киев)</th>
                    <th scope="col">Кто</th>
                    <th scope="col">Действие</th>
                    <th scope="col">Объект</th>
                    <th scope="col">Причина</th>
                    <th scope="col">Ревизия</th>
                    <th scope="col">Итог</th>
                  </tr>
                </thead>
                <tbody>
                  {view.history.map((h) => (
                    <tr key={h.id}>
                      <td>{kyivTime(h.at)}</td>
                      <td>{h.actorId ? <code title={h.actorId}>{shortId(h.actorId)}</code> : '—'}</td>
                      <td>{labelOf(ACTION_LABEL, h.action)}</td>
                      <td>
                        {h.jobId ? <code title={h.jobId}>{shortId(h.jobId)}</code> : h.operationId ? <code title={h.operationId}>{shortId(h.operationId)}</code> : '—'}
                      </td>
                      <td>{h.reason ?? '—'}</td>
                      <td>{h.oldRevision != null || h.newRevision != null ? `${h.oldRevision ?? '—'} → ${h.newRevision ?? '—'}` : '—'}</td>
                      <td>
                        <Badge tone={RESULT_TONE[h.result] ?? 'neutral'}>{RESULT_LABEL[h.result] ?? h.result}</Badge>
                        {h.correlationId && (
                          <div className="muted" style={{ fontSize: 12 }}>
                            <code title={h.correlationId}>{shortId(h.correlationId)}</code>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">Записей нет.</p>
          )}
        </>
      )}
    </section>
  );
}

export function limitsEffect(changes: LimitChange[]) {
  return (
    <>
      <p style={{ margin: '0 0 8px' }}>Новые значения применятся к задачам, принятым после изменения. Уже принятые задачи сохраняют свой профиль.</p>
      <div className="table-scroll">
        <table className="table-narrow">
          <thead>
            <tr>
              <th scope="col">Лимит</th>
              <th scope="col">Было</th>
              <th scope="col">Станет</th>
            </tr>
          </thead>
          <tbody>
            {changes.map((c) => (
              <tr key={c.key}>
                <td>{c.label}</td>
                <td>{formatLimit(c.unit, c.from)}</td>
                <td>
                  <strong>{formatLimit(c.unit, c.to)}</strong>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function routingEffect(change: RoutingChange, selfhostedEnabled: boolean) {
  const list = (ps: FfmpegProduct[]) => (ps.length ? ps.map((p) => PRODUCT_LABEL[p]).join(', ') : 'нет');
  return (
    <>
      <ul style={{ margin: '0 0 8px', paddingLeft: 20 }}>
        <li>
          Провайдер по умолчанию: {PROVIDER_LABEL[change.fromProvider]} → <strong>{PROVIDER_LABEL[change.toProvider]}</strong>
        </li>
        <li>Добавить в canary: {list(change.added)}</li>
        <li>Убрать из canary: {list(change.removed)}</li>
      </ul>
      <p style={{ margin: '0 0 8px' }}>
        Действует только на новые задачи. Уже принятые задачи обслуживает тот провайдер, к которому они ушли; статус старых hosted-задач
        по-прежнему опрашивается у hosted.
      </p>
      {!selfhostedEnabled && <p className="muted">env-гейт selfhosted выключен — фактически все новые задачи останутся в hosted.</p>}
      {change.toSelfhostedDefault && (
        <p className="critical">
          Перевод default → selfhosted: все новые задачи всех продуктов пойдут на собственный сервер. Делайте это только после приёмки
          canary (24 ч, нагрузка, relay, очистка). Rollback — обратной сменой default, он касается только будущих задач.
        </p>
      )}
    </>
  );
}
