'use client';

// Сводка (ТЗ §13.1 п.1): провайдер новых задач, canary allowlist, режим
// приёма и worker, ready с причиной, активные/ожидающие/ошибочные, возраст
// старейшей, диск, CPU/RAM executor, версия образа. У каждого значения —
// момент наблюдения; устаревшее и недоступное помечено. Недоступный VPS
// не превращается в «пустую очередь»: значения без данных — «нет данных».
import type { ReactNode } from 'react';
import {
  ACCEPT_MODE_LABEL,
  PRODUCT_LABEL,
  PROVIDER_LABEL,
  STAGE_LABEL,
  WORKER_LABEL,
  ffmpegErrorText,
  formatBytes,
  formatDuration,
  freshness,
  kyivTime,
  labelOf,
  routingSchemeText,
  shortId,
} from '../../lib/ffmpeg';
import type { FfmpegObserved, FfmpegOverview } from '../../lib/types';
import { Badge, ErrorLine, Observed, StaleBanner } from './ui';

function Tile<T>({ label, obs, now, render }: { label: string; obs: FfmpegObserved<T>; now: number; render: (v: T) => ReactNode }) {
  const fresh = freshness(obs, now);
  return (
    <div className="stat-tile" style={{ minWidth: 0 }}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontSize: 15, fontWeight: 600, overflowWrap: 'anywhere' }}>
        {obs.value === null ? <span className="critical">нет данных{obs.reason ? `: ${obs.reason}` : ''}</span> : render(obs.value)}
      </div>
      <div style={{ marginTop: 6 }}>
        <Observed at={obs.observedAt} fresh={fresh} />
      </div>
    </div>
  );
}

const small = { fontSize: 12, fontWeight: 400 } as const;

export function OverviewPanel({
  overview,
  error,
  okAt,
  now,
  onAction,
  onOpenJob,
  busy,
}: {
  overview: FfmpegOverview | null;
  error: unknown;
  okAt: number | null;
  now: number;
  onAction: (action: 'pause' | 'drain' | 'resume') => void;
  onOpenJob: (id: string) => void;
  busy: boolean;
}) {
  const mode = overview?.acceptMode.value ?? null;
  const perms = overview?.permissions ?? null;
  return (
    <section className="card" aria-labelledby="ff-overview-title" style={{ marginBottom: 16 }}>
      <h2 id="ff-overview-title" style={{ fontSize: 18, margin: '0 0 8px' }}>
        Сводка
      </h2>
      {error != null && (
        <ErrorLine
          text={`Сводка не обновилась: ${ffmpegErrorText(error)}${okAt ? ` Ниже — данные, полученные в ${kyivTime(new Date(okAt).toISOString())}; они помечены как устаревшие.` : ''}`}
        />
      )}
      {overview?.stale && (
        <StaleBanner
          title={overview.source === 'not-configured' ? 'Собственный FFmpeg-сервер не подключён' : 'FFmpeg-сервер недоступен — это не пустая очередь'}
          reason={overview.staleReason}
          at={overview.jobs.observedAt}
        />
      )}
      {!overview && error == null && <p className="muted">Загрузка сводки…</p>}
      {!overview && error != null && <p className="critical">Сводки нет: значения неизвестны, а не равны нулю.</p>}
      {overview && (
        <>
          <div className="stat-grid" style={{ marginTop: 0 }}>
            <Tile
              label="Провайдер новых задач"
              obs={overview.routing}
              now={now}
              render={(r) => (
                <>
                  {routingSchemeText(r)}
                  {r.effectiveDefaultProvider !== r.defaultProvider && (
                    <div className="muted" style={small}>
                      сохранено: {PROVIDER_LABEL[r.defaultProvider]}, но{' '}
                      {r.breaker?.open && r.fallbackToHosted
                        ? 'breaker открыт — временно внешний сервис'
                        : !r.selfhostedEnabled
                          ? 'env-гейт selfhosted выключен'
                          : !r.selfhostedConfigured
                            ? 'свой сервер не настроен'
                            : 'действует canary-список'}
                    </div>
                  )}
                  <div className="muted" style={small}>
                    ревизия {r.revision ?? 'неизвестна'}
                  </div>
                </>
              )}
            />
            <Tile
              label="Запасной путь и breaker"
              obs={overview.routing}
              now={now}
              render={(r) => (
                <>
                  {r.breaker?.open ? (
                    <Badge tone="critical">breaker открыт</Badge>
                  ) : (
                    <Badge tone="ok">breaker закрыт</Badge>
                  )}
                  <div style={{ ...small, marginTop: 4 }}>
                    {r.breaker?.open && r.breaker.openUntil ? `до ${kyivTime(r.breaker.openUntil)}; ` : ''}
                    отказов подряд: {r.breaker ? `${r.breaker.failures}${r.breaker.threshold !== null ? ` из ${r.breaker.threshold}` : ''}` : 'нет данных'}
                  </div>
                  <div className="muted" style={small}>
                    запасной путь (внешний сервис): {r.fallbackToHosted ? 'включён' : 'выключен'}
                  </div>
                </>
              )}
            />
            <Tile
              label="Ушло к внешнему сервису за 24 ч"
              obs={overview.fallbacks24h}
              now={now}
              render={(n) => (
                <>
                  <span className={n > 0 ? 'critical' : undefined}>{n}</span>
                  <div className="muted" style={small}>
                    новых задач вместо своего сервера
                  </div>
                </>
              )}
            />
            <Tile
              label="Canary allowlist"
              obs={overview.routing}
              now={now}
              render={(r) => (
                <>
                  {r.canaryProducts.length ? r.canaryProducts.map((p) => PRODUCT_LABEL[p]).join(', ') : 'пуст — canary выключен'}
                  {r.canaryProducts.length > 0 && r.effectiveCanaryProducts.length === 0 && (
                    <div className="muted" style={small}>
                      не действует: selfhosted выключен или не настроен
                    </div>
                  )}
                </>
              )}
            />
            <Tile
              label="Режим приёма"
              obs={overview.acceptMode}
              now={now}
              render={(m) => <Badge tone={m === 'active' ? 'ok' : m === 'recovery' ? 'critical' : 'warning'}>{ACCEPT_MODE_LABEL[m]}</Badge>}
            />
            <Tile
              label="Worker"
              obs={overview.worker}
              now={now}
              render={(w) => (
                <>
                  <span className={w === 'executor-down' ? 'critical' : undefined}>{WORKER_LABEL[w]}</span>
                  {overview.activeJob && (
                    <div style={{ ...small, marginTop: 4 }}>
                      <button type="button" onClick={() => onOpenJob(overview.activeJob!.id)} aria-label={`Открыть активную задачу ${shortId(overview.activeJob.id)}`}>
                        {shortId(overview.activeJob.id)}
                      </button>{' '}
                      {overview.activeJob.stage ? labelOf(STAGE_LABEL, overview.activeJob.stage) : ''}
                      {overview.activeJob.progress !== null ? ` · ~${Math.round(overview.activeJob.progress)}%` : ''}
                    </div>
                  )}
                </>
              )}
            />
            <Tile
              label="Готовность (ready)"
              obs={overview.ready}
              now={now}
              render={(r) =>
                r.ready ? (
                  <Badge tone="ok">готов</Badge>
                ) : (
                  <>
                    <Badge tone="critical">не готов</Badge>
                    <div style={{ fontSize: 13, fontWeight: 400, marginTop: 4 }}>{r.reason ?? 'причина не сообщена'}</div>
                    {r.checkedAt && <div className="muted" style={small}>проверено {kyivTime(r.checkedAt)}</div>}
                  </>
                )
              }
            />
            <Tile
              label="Активные / ожидающие / ошибки за 24 ч"
              obs={overview.jobs}
              now={now}
              render={(j) => (
                <>
                  {j.active} / {j.queued} / <span className={j.failed > 0 ? 'critical' : undefined}>{j.failed}</span>
                  {j.maxQueued !== null && <div className="muted" style={small}>лимит очереди {j.maxQueued}</div>}
                </>
              )}
            />
            <Tile
              label="Возраст старейшей в очереди"
              obs={overview.jobs}
              now={now}
              render={(j) => (j.oldestQueuedAgeSec === null ? 'очередь пуста' : formatDuration(j.oldestQueuedAgeSec * 1000))}
            />
            <Tile
              label="Диск и квоты"
              obs={overview.disk}
              now={now}
              render={(d) => {
                const low = d.minFreeBytes !== null && d.freeBytes < d.minFreeBytes;
                return (
                  <>
                    <span className={low ? 'critical' : undefined}>свободно {formatBytes(d.freeBytes)}</span>
                    {low && <div className="critical" style={{ fontSize: 12 }}>ниже порога — новые задачи не принимаются</div>}
                    <div className="muted" style={small}>
                      {d.minFreeBytes !== null ? `порог ${formatBytes(d.minFreeBytes)}` : 'порог неизвестен'}
                      {d.workspacesBytes !== null ? `; рабочие папки ${formatBytes(d.workspacesBytes)}${d.workspacesLimitBytes ? ` из ${formatBytes(d.workspacesLimitBytes)}` : ''}` : ''}
                      {d.outputsBytes !== null ? `; результаты ${formatBytes(d.outputsBytes)}${d.outputsLimitBytes ? ` из ${formatBytes(d.outputsLimitBytes)}` : ''}` : ''}
                      {d.measuredAt ? `; замер ${kyivTime(d.measuredAt)}` : ''}
                    </div>
                  </>
                );
              }}
            />
            <Tile
              label="CPU / RAM executor"
              obs={overview.executor}
              now={now}
              render={(x) =>
                x.idle ? (
                  <>
                    простой
                    <div className="muted" style={small}>
                      активной задачи нет — замеров нет
                    </div>
                  </>
                ) : (
                  <>
                    CPU {x.cpuPercent === null ? 'нет данных' : `${Math.round(x.cpuPercent)}% (из 200%)`}
                    <br />
                    RAM {x.rssBytes === null ? 'нет данных' : formatBytes(x.rssBytes)}
                    {x.peakRssBytes !== null ? `, пик ${formatBytes(x.peakRssBytes)}` : ''}
                    {x.stale && <div className="critical" style={{ fontSize: 12 }}>замер устарел</div>}
                  </>
                )
              }
            />
            <Tile
              label="Версия образа"
              obs={overview.image}
              now={now}
              render={(i) => (
                <>
                  {i.ffmpegVersion ?? 'версия FFmpeg неизвестна'}
                  <div className="muted" style={small}>
                    {i.imageDigest ? <code title={i.imageDigest}>{i.imageDigest.length > 23 ? `${i.imageDigest.slice(0, 23)}…` : i.imageDigest}</code> : 'digest неизвестен'}
                  </div>
                </>
              )}
            />
            <Tile
              label="Вызовы ffmpeg за 24 ч"
              obs={overview.usage24h}
              now={now}
              render={(u) => (
                <>
                  hosted {u.hosted} · selfhosted {u.selfhosted}
                  <div className="muted" style={small}>
                    по журналу расходов — расчёт, не счёт провайдера
                  </div>
                </>
              )}
            />
          </div>
          {overview.hosted && (
            <p className="muted" style={{ fontSize: 12, margin: '10px 0 0' }}>
              hosted: {overview.hosted.configured ? 'ключ задан' : 'ключ не задан'}. {overview.hosted.note ?? ''}
            </p>
          )}

          <h3 style={{ fontSize: 15, margin: '20px 0 8px' }}>Обслуживание worker</h3>
          <p className="muted" style={{ fontSize: 13, margin: '0 0 8px' }}>
            Сейчас: {mode ? labelOf(ACCEPT_MODE_LABEL, mode) : 'режим неизвестен'}. Каждое действие — с подтверждением и причиной; права проверяет
            сервер.
            {perms && (perms.length ? ` Ваши права: ${perms.join(', ')}.` : ' У вас нет прав на действия.')}
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <button type="button" onClick={() => onAction('pause')} disabled={busy}>
              Пауза worker
            </button>
            <button type="button" onClick={() => onAction('drain')} disabled={busy}>
              Drain
            </button>
            <button type="button" onClick={() => onAction('resume')} disabled={busy}>
              {mode === 'recovery' ? 'Продолжить после сверки…' : 'Продолжить'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
