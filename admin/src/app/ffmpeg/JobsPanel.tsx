'use client';

// Задачи (ТЗ §13.1 п.2): курсорная пагинация по 25, фильтры провайдер,
// состояние, продукт, период, client operation id, job id — в адресе
// страницы; по умолчанию последние 24 часа. Поиска по содержимому речи и
// субтитров нет и не будет.
import { useEffect, useId, useState } from 'react';
import type { FormEvent } from 'react';
import {
  DEFAULT_FILTERS,
  ERROR_CODE_LABEL,
  FFMPEG_PAGE_SIZE,
  FFMPEG_PERIODS,
  FFMPEG_PRODUCTS,
  FFMPEG_STATES,
  FILES_GONE_LABEL,
  PERIOD_LABEL,
  PRODUCT_LABEL,
  PROVIDER_LABEL,
  STAGE_LABEL,
  STATE_LABEL,
  STATE_TONE,
  cleanId,
  cleanJobId,
  ffmpegErrorText,
  filesGone,
  formatBytes,
  formatDuration,
  kyivTime,
  labelOf,
  sameFilters,
  shortId,
  type FfmpegFilters,
  type FfmpegPeriod,
} from '../../lib/ffmpeg';
import type { FfmpegJobsPage } from '../../lib/types';
import { Badge, ErrorLine, Observed, StaleBanner } from './ui';

export function JobsPanel({
  filters,
  page,
  error,
  okAt,
  loading,
  pageIndex,
  onFilters,
  onNext,
  onPrev,
  onFirst,
  onOpen,
  openJob,
}: {
  filters: FfmpegFilters;
  page: FfmpegJobsPage | null;
  error: unknown;
  okAt: number | null;
  loading: boolean;
  pageIndex: number;
  onFilters: (f: FfmpegFilters) => void;
  onNext: () => void;
  onPrev: () => void;
  onFirst: () => void;
  onOpen: (id: string) => void;
  openJob: string;
}) {
  const [draft, setDraft] = useState<FfmpegFilters>(filters);
  const uid = useId();
  // Адрес сменился снаружи (ссылка из очереди внимания, «назад») — форма следует.
  useEffect(() => {
    setDraft(filters);
  }, [filters]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onFilters({ ...draft, operationId: cleanId(draft.operationId), jobId: cleanJobId(draft.jobId) });
  };
  const set = <K extends keyof FfmpegFilters>(k: K, v: FfmpegFilters[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const id = (s: string) => `${uid}-${s}`;
  const dirty = !sameFilters(draft, filters);
  const fieldStyle = { display: 'flex', flexDirection: 'column' as const, gap: 4, fontSize: 13, minWidth: 0 };

  return (
    <section className="card" aria-labelledby="ff-jobs-title" style={{ marginBottom: 16 }}>
      <h2 id="ff-jobs-title" style={{ fontSize: 18, margin: '0 0 8px' }}>
        Задачи
      </h2>
      <form onSubmit={submit} aria-label="Фильтры задач" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 170px), 1fr))', gap: 10, alignItems: 'end' }}>
        <div style={fieldStyle}>
          <label htmlFor={id('state')}>Состояние</label>
          <select id={id('state')} value={draft.state} onChange={(e) => set('state', e.target.value as FfmpegFilters['state'])}>
            <option value="">любое</option>
            {FFMPEG_STATES.map((s) => (
              <option key={s} value={s}>
                {STATE_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        <div style={fieldStyle}>
          <label htmlFor={id('provider')}>Провайдер</label>
          <select id={id('provider')} value={draft.provider} onChange={(e) => set('provider', e.target.value === 'hosted' ? 'hosted' : '')}>
            <option value="">{PROVIDER_LABEL.selfhosted}</option>
            <option value="hosted">{PROVIDER_LABEL.hosted} — только по id задачи</option>
          </select>
        </div>
        <div style={fieldStyle}>
          <label htmlFor={id('product')}>Продукт</label>
          <select id={id('product')} value={draft.product} onChange={(e) => set('product', e.target.value as FfmpegFilters['product'])}>
            <option value="">любой</option>
            {FFMPEG_PRODUCTS.map((p) => (
              <option key={p} value={p}>
                {PRODUCT_LABEL[p]}
              </option>
            ))}
          </select>
        </div>
        <div style={fieldStyle}>
          <label htmlFor={id('period')}>Период</label>
          <select id={id('period')} value={draft.period} onChange={(e) => set('period', e.target.value as FfmpegPeriod)}>
            {FFMPEG_PERIODS.map((p) => (
              <option key={p} value={p}>
                {PERIOD_LABEL[p]}
              </option>
            ))}
          </select>
        </div>
        <div style={fieldStyle}>
          <label htmlFor={id('op')}>Id операции</label>
          <input id={id('op')} value={draft.operationId} maxLength={128} spellCheck={false} autoComplete="off" onChange={(e) => set('operationId', e.target.value)} />
        </div>
        <div style={fieldStyle}>
          <label htmlFor={id('job')}>Id задачи</label>
          <input id={id('job')} value={draft.jobId} maxLength={160} spellCheck={false} autoComplete="off" onChange={(e) => set('jobId', e.target.value)} />
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="submit">{dirty ? 'Применить фильтры' : 'Применить'}</button>
          <button type="button" onClick={() => onFilters(DEFAULT_FILTERS)} disabled={sameFilters(filters, DEFAULT_FILTERS) && !dirty}>
            Сбросить
          </button>
        </div>
      </form>
      <p className="muted" style={{ fontSize: 12, margin: '8px 0 12px' }}>
        Фильтры сохраняются в адресе страницы — ссылкой можно поделиться. Поиск по содержимому речи и субтитров не предусмотрен.
      </p>

      {draft.provider === 'hosted' && !draft.jobId && (
        <p className="muted" style={{ fontSize: 13 }}>Внешний провайдер не отдаёт список задач — укажите id задачи.</p>
      )}
      {error != null && <ErrorLine text={`Список не обновился: ${ffmpegErrorText(error)}`} />}
      {page?.source === 'unsupported' && (
        <div className="rx-alert rx-alert-accent" role="status" style={{ marginBottom: 12 }}>
          {page.staleReason ?? 'Этот источник не отдаёт список задач.'}
        </div>
      )}
      {page?.stale && page.source !== 'unsupported' && (
        <StaleBanner
          title={page.source === 'not-configured' ? 'Собственный FFmpeg-сервер не подключён' : 'FFmpeg-сервер не ответил — список может быть неполным'}
          reason={page.staleReason}
          at={page.observedAt}
        />
      )}
      {page?.productFilterPageOnly && (
        <p className="muted" style={{ fontSize: 12 }}>
          Фильтр по продукту применён к каждой странице из {FFMPEG_PAGE_SIZE} задач: на странице может быть меньше строк, листайте дальше.
        </p>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <span aria-live="polite" style={{ fontSize: 13 }}>
          {page
            ? `Страница ${pageIndex + 1}: ${page.items.length} ${page.items.length === 1 ? 'задача' : 'задач'} (по ${FFMPEG_PAGE_SIZE})`
            : loading
              ? 'Загрузка задач…'
              : ''}
        </span>
        {page && <Observed at={page.observedAt ?? (okAt ? new Date(okAt).toISOString() : null)} fresh={page.stale ? 'stale' : 'fresh'} />}
      </div>

      {page && page.items.length === 0 && !page.stale && <p>За выбранный период и фильтры задач нет.</p>}
      {page && page.items.length === 0 && page.stale && page.source !== 'unsupported' && (
        <p className="critical">Задач не показано, потому что сервер недоступен, — это не означает, что их нет.</p>
      )}
      {page && page.items.length > 0 && (
        <div className="table-scroll" role="region" aria-label="Таблица задач" tabIndex={0}>
          <table>
            <caption className="muted" style={{ textAlign: 'left', fontSize: 12, paddingBottom: 6 }}>
              Время — по Киеву. Размер — суммарно результаты.
            </caption>
            <thead>
              <tr>
                <th scope="col">Операция / продукт</th>
                <th scope="col">Статус / этап</th>
                <th scope="col">Очередь / исполнение</th>
                <th scope="col">Попытки</th>
                <th scope="col">Размер</th>
                <th scope="col">Код ошибки</th>
                <th scope="col">Время</th>
                <th scope="col">Задача</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((j) => {
                const gone = filesGone(j);
                const isOpen = j.id === openJob;
                return (
                  <tr key={j.id} aria-current={isOpen ? 'true' : undefined} style={isOpen ? { background: 'rgba(110,168,254,0.08)' } : undefined}>
                    <td>
                      {j.operationId ? <code title={j.operationId}>{shortId(j.operationId)}</code> : <span className="muted">без операции</span>}
                      <div className="muted" style={{ fontSize: 12 }}>
                        {j.product ? labelOf(PRODUCT_LABEL, j.product) : 'продукт неизвестен'} · {j.provider}
                      </div>
                    </td>
                    <td>
                      <Badge tone={STATE_TONE[j.state]}>{STATE_LABEL[j.state]}</Badge>
                      {j.stage && j.state === 'processing' && <div className="muted" style={{ fontSize: 12 }}>{labelOf(STAGE_LABEL, j.stage)}</div>}
                      {gone && <div style={{ fontSize: 12, marginTop: 4 }}><Badge tone="warning">{FILES_GONE_LABEL[gone]}</Badge></div>}
                    </td>
                    <td>
                      {formatDuration(j.queueMs)} / {formatDuration(j.runMs)}
                    </td>
                    <td>{j.attempts ?? '—'}</td>
                    <td>{j.outputBytes === null ? '—' : formatBytes(j.outputBytes)}</td>
                    <td>
                      {j.errorCode ? (
                        <>
                          <code>{j.errorCode}</code>
                          <div className="muted" style={{ fontSize: 12 }}>{labelOf(ERROR_CODE_LABEL, j.errorCode)}</div>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      {j.createdAt ? kyivTime(j.createdAt) : '—'}
                      {j.finishedAt && <div className="muted" style={{ fontSize: 12 }}>завершена {kyivTime(j.finishedAt)}</div>}
                    </td>
                    <td>
                      <button type="button" onClick={() => onOpen(j.id)} aria-label={`Открыть карточку задачи ${shortId(j.id)}`}>
                        {shortId(j.id)}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <nav aria-label="Страницы задач" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
        <button type="button" onClick={onFirst} disabled={pageIndex === 0}>
          В начало
        </button>
        <button type="button" onClick={onPrev} disabled={pageIndex === 0}>
          Назад
        </button>
        <button type="button" onClick={onNext} disabled={!page?.nextCursor}>
          Следующие {FFMPEG_PAGE_SIZE}
        </button>
      </nav>
    </section>
  );
}
