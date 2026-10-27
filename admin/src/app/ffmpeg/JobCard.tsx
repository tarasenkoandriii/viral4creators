'use client';

// Карточка задачи (ТЗ §13.1 п.3, п.5): timeline, id операции и провайдера,
// имена входов/выходов без URL, метаданные и SHA-256, пики ресурсов,
// версия, очищенный stderr ≤64 KiB. Отдельная метка «выполнено, но файлы
// истекли/отозваны». Результат — только по явному действию через
// короткую ссылку backend; без автовоспроизведения, SVG/HTML не
// встраиваются. Кнопки повторного рендера нет: новая версия делается
// только из исходной операции продукта.
import Link from 'next/link';
import { ReviewDraftPanel } from './ReviewDraftPanel';
import { useEffect, useRef, useState } from 'react';
import {
  ACTION_LABEL,
  ARTIFACTS_LABEL,
  EVENT_LABEL,
  ERROR_CODE_LABEL,
  FILES_GONE_LABEL,
  PRODUCT_LABEL,
  PROVIDER_LABEL,
  STAGE_LABEL,
  STATE_LABEL,
  STATE_TONE,
  canCancel,
  canPurge,
  createFfmpegDownloadLink,
  ffmpegErrorText,
  filesGone,
  formatBytes,
  formatDuration,
  kyivTime,
  labelOf,
  newOperationId,
  operationLinks,
  previewKind,
  reasonValid,
  runWithReconcile,
  shortId,
  type PreviewKind,
} from '../../lib/ffmpeg';
import type { FfmpegFileInfo, FfmpegJobDetail } from '../../lib/types';
import { Badge, ErrorLine, Observed, StaleBanner } from './ui';

function streamsText(f: FfmpegFileInfo): string {
  if (!f.streams?.length) return '—';
  return f.streams
    .map((s) => {
      const parts = [s.type, s.codec ?? '?'];
      if (s.width && s.height) parts.push(`${s.width}×${s.height}`);
      if (s.fps) parts.push(`${Math.round(s.fps * 100) / 100} fps`);
      if (s.sampleRate) parts.push(`${s.sampleRate} Гц`);
      if (s.channels) parts.push(`${s.channels} кан.`);
      if (typeof s.durationSec === 'number') parts.push(`${s.durationSec.toFixed(2)} с`);
      return parts.join(' ');
    })
    .join('; ');
}

interface Preview {
  kind: PreviewKind;
  url: string;
  expiresAt: string | null;
}

function OutputActions({ jobId, file, available, reason }: { jobId: string; file: FfmpegFileInfo; available: boolean; reason: string }) {
  const [busy, setBusy] = useState<'' | 'preview' | 'download'>('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const kind = previewKind(file.mime);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const request = async (purpose: 'preview' | 'download') => {
    setBusy(purpose);
    setError('');
    setNote('');
    // Один ключ на нажатие: при обрыве повтор идёт с ним же.
    const operationId = newOperationId();
    const outcome = await runWithReconcile(
      () => createFfmpegDownloadLink(jobId, { operationId, file: file.name, ...(reasonValid(reason) ? { reason: reason.trim() } : {}) }),
      { cancelled: () => !mounted.current },
    );
    if (!mounted.current) return;
    setBusy('');
    if (outcome.kind !== 'done') {
      setError(ffmpegErrorText(outcome.error, 'media'));
      return;
    }
    const link = outcome.result;
    // MIME от сервера важнее заявленного в метаданных: SVG/HTML не встраиваются никогда.
    const served = previewKind(link.mime ?? file.mime);
    if (purpose === 'preview' && kind && served) {
      setPreview({ kind: served, url: link.url, expiresAt: link.expiresAt });
      setNote(`Ссылка для предпросмотра действует до ${kyivTime(link.expiresAt)}. Для загрузки и воспроизведения нажмите Play.`);
      return;
    }
    // Скачивание: временная ссылка не остаётся в DOM.
    const a = document.createElement('a');
    a.href = link.url;
    a.download = file.name;
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setNote(`Скачивание начато; ссылка действует до ${kyivTime(link.expiresAt)}.`);
  };

  if (!available) return <span className="muted">файлов нет</span>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {kind && (
          <button type="button" onClick={() => void request('preview')} disabled={busy !== ''} aria-label={`Предпросмотр ${file.name}`}>
            {busy === 'preview' ? 'Получаем ссылку…' : 'Предпросмотр'}
          </button>
        )}
        <button type="button" onClick={() => void request('download')} disabled={busy !== ''} aria-label={`Скачать ${file.name}`}>
          {busy === 'download' ? 'Получаем ссылку…' : 'Скачать'}
        </button>
      </div>
      {!kind && <span className="muted" style={{ fontSize: 12 }}>предпросмотр недоступен для этого типа — только скачивание</span>}
      <span role="status" style={{ fontSize: 12 }}>{note}</span>
      {error && (
        <span role="alert" className="critical" style={{ fontSize: 12 }}>
          {error}
        </span>
      )}
      {preview?.kind === 'image' && (
        // Растровая картинка с безопасным MIME; SVG сюда не попадает (previewKind).
        // eslint-disable-next-line @next/next/no-img-element
        <img src={preview.url} alt={`Предпросмотр результата ${file.name}`} referrerPolicy="no-referrer" style={{ maxWidth: '100%', maxHeight: 320, objectFit: 'contain' }} />
      )}
      {preview?.kind === 'video' && (
        <video src={preview.url} controls preload="none" playsInline aria-label={`Предпросмотр видео ${file.name}`} style={{ maxWidth: '100%', maxHeight: 360 }} />
      )}
      {preview?.kind === 'audio' && <audio src={preview.url} controls preload="none" aria-label={`Предпросмотр аудио ${file.name}`} style={{ maxWidth: '100%' }} />}
      {preview && (
        <button type="button" onClick={() => setPreview(null)}>
          Скрыть предпросмотр
        </button>
      )}
    </div>
  );
}

export function JobCard({
  jobId,
  job,
  error,
  loading,
  onClose,
  onAction,
  busy,
}: {
  jobId: string;
  job: FfmpegJobDetail | null;
  error: unknown;
  loading: boolean;
  onClose: () => void;
  onAction: (action: 'reconcile' | 'cancel' | 'purge', job: FfmpegJobDetail) => void;
  busy: boolean;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [mediaReason, setMediaReason] = useState('');
  useEffect(() => {
    headingRef.current?.focus();
  }, [jobId]);
  const gone = job ? filesGone(job) : null;
  const links = job ? operationLinks(job) : [];
  // Короткие ссылки выдаёт только свой сервер; у hosted результат уже импортирован продуктом.
  const outputsAvailable =
    !!job && job.provider === 'selfhosted' && job.state === 'succeeded' && (job.artifacts ?? 'available') === 'available';

  return (
    <section className="card" aria-labelledby="ff-job-title" style={{ marginBottom: 16, borderColor: 'var(--accent)' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <h2 id="ff-job-title" ref={headingRef} tabIndex={-1} style={{ fontSize: 18, margin: 0, overflowWrap: 'anywhere' }}>
          Задача <code>{jobId}</code>
        </h2>
        <button type="button" onClick={onClose}>
          Закрыть карточку
        </button>
      </div>
      {error != null && <ErrorLine text={`Карточка не обновилась: ${ffmpegErrorText(error)}`} />}
      {!job && !error && <p className="muted">{loading ? 'Загрузка карточки…' : ''}</p>}
      {job?.stale && <StaleBanner title="FFmpeg-сервер не ответил — часть данных может быть старой" reason={job.staleReason} at={job.observedAt} />}
      {job && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', margin: '10px 0' }}>
            <Badge tone={STATE_TONE[job.state]}>{STATE_LABEL[job.state]}</Badge>
            {job.stage && job.state === 'processing' && <Badge tone="accent">{labelOf(STAGE_LABEL, job.stage)}</Badge>}
            {gone && <Badge tone="warning">{FILES_GONE_LABEL[gone]}</Badge>}
            <Observed at={job.observedAt} fresh={job.stale ? 'stale' : 'fresh'} />
          </div>
          {gone && (
            <p style={{ fontSize: 13 }}>
              Обработка завершилась успешно{job.finishedAt ? ` ${kyivTime(job.finishedAt)}` : ''}, но временные файлы{' '}
              {gone === 'expired' ? 'истекли по сроку хранения (24 ч)' : gone === 'purged' ? 'отозваны и удалены' : 'сейчас удаляются; ссылки уже отозваны'}. Факт
              выполнения и журнал сохранены. Копия, импортированная продуктом, не затрагивается.
            </p>
          )}
          <dl className="rx-kv" style={{ margin: '8px 0 16px' }}>
            <dt className="muted">Провайдер</dt>
            <dd style={{ margin: 0 }}>{PROVIDER_LABEL[job.provider]}</dd>
            <dt className="muted">Id задачи у провайдера</dt>
            <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>
              <code>{job.id}</code>
            </dd>
            <dt className="muted">Продукт</dt>
            <dd style={{ margin: 0 }}>{job.product ? labelOf(PRODUCT_LABEL, job.product) : 'неизвестен'}</dd>
            <dt className="muted">Операция продукта</dt>
            <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>
              {job.operationId ? <code>{job.operationId}</code> : <span className="muted">не передана</span>}
              {links.length > 0 && (
                <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                  {links.map((l) => (
                    <li key={l.href}>
                      <Link href={l.href} className="rx-link">
                        {l.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </dd>
            <dt className="muted">Ошибка</dt>
            <dd style={{ margin: 0 }}>
              {job.errorCode ? (
                <>
                  <code>{job.errorCode}</code> — {labelOf(ERROR_CODE_LABEL, job.errorCode)}
                </>
              ) : (
                'нет'
              )}
              {job.errorMessage && <div className="muted" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{job.errorMessage}</div>}
            </dd>
            <dt className="muted">Исполнение</dt>
            <dd style={{ margin: 0 }}>
              {job.executionStatus ? STATE_LABEL[job.executionStatus] : '—'}; попыток {job.attempts ?? '—'}
              {job.progress !== null && job.state === 'processing' ? `; прогресс ~${Math.round(job.progress)}% (приблизительно)` : ''}
            </dd>
            <dt className="muted">Файлы результата</dt>
            <dd style={{ margin: 0 }}>
              {job.artifacts ? ARTIFACTS_LABEL[job.artifacts] : '—'}
              {job.expiresAt && job.artifacts === 'available' ? `, хранятся до ${kyivTime(job.expiresAt)}` : ''}
            </dd>
            <dt className="muted">Создана / начата / завершена</dt>
            <dd style={{ margin: 0 }}>
              {job.createdAt ? kyivTime(job.createdAt) : '—'} / {job.startedAt ? kyivTime(job.startedAt) : '—'} / {job.finishedAt ? kyivTime(job.finishedAt) : '—'}
            </dd>
            <dt className="muted">Ревизия лимитов задачи</dt>
            <dd style={{ margin: 0 }}>{job.limitsRevision ?? '—'}</dd>
            <dt className="muted">FFmpeg / образ</dt>
            <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>
              {job.ffmpegVersion ?? 'версия неизвестна'}
              {job.imageDigest && (
                <>
                  {' '}
                  · <code>{job.imageDigest}</code>
                </>
              )}
            </dd>
          </dl>

          <h3 style={{ fontSize: 15 }}>Действия</h3>
          <p className="muted" style={{ fontSize: 13, margin: '0 0 8px' }}>
            Повторного рендера здесь нет: после ошибки вернитесь к исходной операции продукта — только её поток создаёт новую версию с новым
            ключом и собственной проверкой расходов и согласия.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
            <button type="button" onClick={() => onAction('reconcile', job)} disabled={busy}>
              Сверить
            </button>
            {canCancel(job) && (
              <button type="button" className="button-danger" onClick={() => onAction('cancel', job)} disabled={busy}>
                Отменить задачу
              </button>
            )}
            {canPurge(job) && (
              <button type="button" className="button-danger" onClick={() => onAction('purge', job)} disabled={busy}>
                Удалить временные файлы
              </button>
            )}
          </div>

          <h3 style={{ fontSize: 15 }}>Timeline</h3>
          {job.timeline.length ? (
            <ol style={{ fontSize: 13, paddingLeft: 20, margin: '0 0 16px' }}>
              {job.timeline.map((t, i) => (
                <li key={`${t.at}-${i}`} style={{ marginBottom: 4 }}>
                  <span className="muted">{kyivTime(t.at)}</span> — {labelOf(EVENT_LABEL, t.event)}
                  {t.note ? <span className="muted"> · {t.note}</span> : null}
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted">Событий нет.</p>
          )}

          <h3 style={{ fontSize: 15 }}>Входы</h3>
          {job.inputs.length ? (
            <div className="table-scroll" role="region" aria-label="Входы задачи" tabIndex={0}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Имя</th>
                    <th scope="col">Размер</th>
                    <th scope="col">MIME</th>
                    <th scope="col">SHA-256</th>
                  </tr>
                </thead>
                <tbody>
                  {job.inputs.map((f) => (
                    <tr key={f.name}>
                      <td>
                        <code>{f.name}</code>
                      </td>
                      <td>{formatBytes(f.bytes)}</td>
                      <td>{f.mime ?? '—'}</td>
                      <td style={{ overflowWrap: 'anywhere' }}>{f.sha256 ? <code>{f.sha256}</code> : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">Нет данных о входах.</p>
          )}
          <p className="muted" style={{ fontSize: 12 }}>Исходные ссылки входов не хранятся в открытом виде и здесь не показываются.</p>

          <h3 style={{ fontSize: 15 }}>Результаты</h3>
          {outputsAvailable && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, marginBottom: 8, maxWidth: 520 }}>
              <label htmlFor="ff-media-reason">Причина просмотра/скачивания для журнала (необязательно)</label>
              <input id="ff-media-reason" value={mediaReason} maxLength={500} onChange={(e) => setMediaReason(e.target.value)} autoComplete="off" />
            </div>
          )}
          {job.outputs.length ? (
            <div className="table-scroll" role="region" aria-label="Результаты задачи" tabIndex={0}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Имя</th>
                    <th scope="col">Размер / MIME</th>
                    <th scope="col">Потоки</th>
                    <th scope="col">SHA-256</th>
                    <th scope="col">Просмотр</th>
                  </tr>
                </thead>
                <tbody>
                  {job.outputs.map((f) => (
                    <tr key={f.name}>
                      <td>
                        <code>{f.name}</code>
                      </td>
                      <td>
                        {formatBytes(f.bytes)}
                        <div className="muted" style={{ fontSize: 12 }}>{f.mime ?? 'MIME неизвестен'}</div>
                        {typeof f.durationSec === 'number' && <div className="muted" style={{ fontSize: 12 }}>{f.durationSec.toFixed(2)} с</div>}
                      </td>
                      <td style={{ fontSize: 12 }}>{streamsText(f)}</td>
                      <td style={{ overflowWrap: 'anywhere' }}>{f.sha256 ? <code>{f.sha256}</code> : '—'}</td>
                      <td style={{ minWidth: 180 }}>
                        <OutputActions jobId={job.id} file={f} available={outputsAvailable} reason={mediaReason} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">Результатов нет.</p>
          )}

          {outputsAvailable && job.provider === 'selfhosted' && <ReviewDraftPanel key={`${job.id}:${job.outputs.map((file) => file.sha256).join(':')}`} job={job} />}

          <h3 style={{ fontSize: 15 }}>Пиковые ресурсы</h3>
          {job.resources ? (
            <ul style={{ fontSize: 13, margin: '0 0 16px', paddingLeft: 20 }}>
              <li>Ожидание в очереди: {formatDuration(job.resources.queueDelayMs)}</li>
              <li>Время исполнения: {formatDuration(job.resources.wallMs)}; CPU: {formatDuration(job.resources.cpuMs)}</li>
              <li>Пик памяти: {typeof job.resources.peakRssKb === 'number' ? formatBytes(job.resources.peakRssKb * 1024) : 'нет данных'}</li>
              <li>
                Скачано входов: {formatBytes(job.resources.inputBytes)}; результатов: {formatBytes(job.resources.outputBytes)}
              </li>
              <li>Код выхода: {job.resources.exitCode ?? '—'}</li>
            </ul>
          ) : (
            <p className="muted">Нет данных о ресурсах (hosted-провайдер их не сообщает или задача не исполнялась).</p>
          )}

          {job.attemptsDetail.length > 0 && (
            <>
              <h3 style={{ fontSize: 15 }}>Попытки</h3>
              <div className="table-scroll" role="region" aria-label="Попытки исполнения" tabIndex={0}>
                <table>
                  <thead>
                    <tr>
                      <th scope="col">№</th>
                      <th scope="col">Исход</th>
                      <th scope="col">Начало / конец</th>
                      <th scope="col">Время / CPU</th>
                      <th scope="col">Пик памяти</th>
                      <th scope="col">Выход</th>
                    </tr>
                  </thead>
                  <tbody>
                    {job.attemptsDetail.map((a) => (
                      <tr key={a.n}>
                        <td>{a.n}</td>
                        <td>
                          {a.outcome ?? a.status ?? '—'}
                          {a.errorCode && (
                            <div className="muted" style={{ fontSize: 12 }}>
                              <code>{a.errorCode}</code>
                            </div>
                          )}
                        </td>
                        <td>
                          {kyivTime(a.startedAt)} / {kyivTime(a.finishedAt)}
                        </td>
                        <td>
                          {formatDuration(a.wallMs)} / {formatDuration(a.cpuMs)}
                        </td>
                        <td>{typeof a.peakRssKb === 'number' ? formatBytes(a.peakRssKb * 1024) : '—'}</td>
                        <td>
                          {a.exitCode ?? '—'}
                          {a.signal ? ` (${a.signal})` : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <h3 style={{ fontSize: 15 }}>Действия операторов по задаче</h3>
          {job.actions.length ? (
            <ul style={{ fontSize: 13, paddingLeft: 20, margin: '0 0 16px' }}>
              {job.actions.map((a) => (
                <li key={a.id}>
                  <span className="muted">{kyivTime(a.at)}</span> — {labelOf(ACTION_LABEL, a.action)} ·{' '}
                  {a.actorId ? <code title={a.actorId}>{shortId(a.actorId)}</code> : '—'} · {a.result}
                  {a.reason ? <span className="muted"> · {a.reason}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Действий не было.</p>
          )}

          <h3 style={{ fontSize: 15 }}>stderr</h3>
          {job.stderr ? (
            <details>
              <summary style={{ cursor: 'pointer', minHeight: 44, display: 'flex', alignItems: 'center' }}>
                Показать очищенный stderr{job.stderrTruncated ? ' (только последние 64 КиБ)' : ''}
              </summary>
              <pre className="rx-pre" tabIndex={0} aria-label="stderr задачи" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
                {job.stderr}
              </pre>
            </details>
          ) : (
            <p className="muted">stderr нет.</p>
          )}
        </>
      )}
    </section>
  );
}
