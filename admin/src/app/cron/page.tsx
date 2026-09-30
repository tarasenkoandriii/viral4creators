'use client';

// Вкладка «Кроны» (доп. ТЗ «Кроны в админке», этап 69, аналогично Solar
// Shop): реестр крон-задач, статус последнего прогона, ручной
// запуск с необязательным флагом debug. Почти у всех джобов debug
// раскрывает только сырой JSON результата (debugLog); у sweep-orphans
// debug меняет ПОВЕДЕНИЕ — маппится на dryRun (безвозвратное удаление
// файлов из хранилища — единственная операция реестра, где случайный
// клик реально необратим), поэтому у неё отдельная подпись рядом с
// чекбоксом.
//
// Сверху — сводка за выбранный день (сегодня/вчера/дата, границы — по
// местному времени браузера): по каждому джобу сколько прогонов
// ожидалось по расписанию vercel.json и сколько было, статусы,
// медиана/максимум длительности, зависшие RUNNING и последние ошибки.
// До этого история отдавала только 50 последних строк — у
// двухминутных кронов это ≈1,5 часа, и сутки целиком проверить было
// нельзя. У каждой карточки — «история за день» с подгрузкой страниц.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getCronRegistry,
  getCronHistory,
  getCronSummary,
  runCronJob,
} from '../../lib/endpoints';
import type {
  CronJobInfo,
  CronJobSummary,
  CronRunLog,
  CronRunStatus,
  CronSummary,
} from '../../lib/types';
import { ApiRequestError } from '../../lib/admin-api';

const STATUS_LABEL: Record<CronRunStatus, string> = {
  RUNNING: 'Выполняется',
  SUCCESS: 'Успех',
  FAILED: 'Ошибка',
};

/** RUNNING почти никогда не видно живьём (запуск — синхронный HTTP-вызов,
 * ответ приходит уже с итоговым статусом) — бейдж на случай, если прогон
 * оборвался, не дойдя до FAILED/SUCCESS (например, функция была убита
 * таймаутом Vercel). Переиспользуются три готовых severity-класса
 * (`badge-status-*`) — новый CSS под кроны не заводится. */
const STATUS_SEVERITY: Record<CronRunStatus, 'ok' | 'warning' | 'critical'> = {
  SUCCESS: 'ok',
  RUNNING: 'warning',
  FAILED: 'critical',
};

/** Строк истории за день на страницу (потолок бэкенда — 500). */
const DAY_HISTORY_PAGE = 200;

type DayMode = 'today' | 'yesterday' | 'date';

/** YYYY-MM-DD в местном времени браузера. */
function localDateString(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Местная дата со сдвигом на `days` суток. Через `new Date(y, m, d ± n)`,
 * а не `Date.now() − 86 400 000`: в сутки перевода часов (DST) в них 23
 * или 25 часов, и вычитание суток в миллисекундах промахивается мимо
 * «вчера». */
function shiftLocalDate(days: number): string {
  const now = new Date();
  return localDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days));
}

/** Журнал кронов хранится 30 дней (CRON_LOG_RETENTION_DAYS на бэкенде):
 * раньше выбирать нечего. */
const HISTORY_DAYS_BACK = 29;

/** Границы местных суток [since, until) в ISO (UTC) для API. */
function dayBounds(date: string): { since: string; until: string } {
  const [y, m, d] = date.split('-').map(Number);
  return {
    since: new Date(y, m - 1, d).toISOString(),
    until: new Date(y, m - 1, d + 1).toISOString(),
  };
}

function formatMs(ms: number | null): string {
  if (ms == null) return '—';
  return ms < 1000 ? `${ms}мс` : `${(ms / 1000).toFixed(1)}с`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Джоб требует внимания: ошибки, пропуски по расписанию, зависшие. */
function needsAttention(j: CronJobSummary): boolean {
  return j.byStatus.FAILED > 0 || (j.missed ?? 0) > 0 || j.stuck;
}

interface DayHistoryState {
  rows: CronRunLog[];
  hasMore: boolean;
  loading: boolean;
  error: string | null;
}

export default function CronPage() {
  const [registry, setRegistry] = useState<CronJobInfo[] | null>(null);
  const [history, setHistory] = useState<CronRunLog[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runningKey, setRunningKey] = useState<string | null>(null);
  const [debugByJob, setDebugByJob] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [dayMode, setDayMode] = useState<DayMode>('today');
  const [customDate, setCustomDate] = useState<string>(() => localDateString(new Date()));
  const [summary, setSummary] = useState<CronSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [dayHistory, setDayHistory] = useState<Record<string, DayHistoryState>>({});
  const [openHistory, setOpenHistory] = useState<string | null>(null);

  const selectedDate =
    dayMode === 'today'
      ? localDateString(new Date())
      : dayMode === 'yesterday'
        ? shiftLocalDate(-1)
        : customDate;

  // Выбранный день «сейчас» — для отбрасывания поздних ответов: запрос,
  // ушедший за прошлый день, не должен лечь поверх истории нового.
  const selectedDateRef = useRef(selectedDate);
  selectedDateRef.current = selectedDate;

  const loadSummary = useCallback(async () => {
    const { since, until } = dayBounds(selectedDate);
    setSummaryLoading(true);
    try {
      const result = await getCronSummary(since, until);
      if (selectedDateRef.current !== selectedDate) return;
      setSummary(result);
      setSummaryError(null);
    } catch (err) {
      if (selectedDateRef.current !== selectedDate) return;
      setSummaryError(err instanceof ApiRequestError ? err.message : 'Не удалось загрузить сводку');
    } finally {
      if (selectedDateRef.current === selectedDate) setSummaryLoading(false);
    }
  }, [selectedDate]);

  useEffect(() => {
    // Другой день — другая история: раскрытые списки сбрасываются.
    setDayHistory({});
    setOpenHistory(null);
    void loadSummary();
  }, [loadSummary]);

  async function loadDayHistory(jobKey: string, append: boolean) {
    const requestedDate = selectedDate;
    const prev = dayHistory[jobKey];
    const before = append && prev?.rows.length ? prev.rows[prev.rows.length - 1].id : undefined;
    setDayHistory((cur) => ({
      ...cur,
      [jobKey]: {
        rows: append ? cur[jobKey]?.rows ?? [] : [],
        hasMore: false,
        loading: true,
        error: null,
      },
    }));
    try {
      const { since, until } = dayBounds(requestedDate);
      const rows = await getCronHistory({
        jobKey,
        since,
        until,
        limit: DAY_HISTORY_PAGE,
        before,
      });
      if (selectedDateRef.current !== requestedDate) return;
      setDayHistory((cur) => ({
        ...cur,
        [jobKey]: {
          rows: append ? [...(cur[jobKey]?.rows ?? []), ...rows] : rows,
          hasMore: rows.length === DAY_HISTORY_PAGE,
          loading: false,
          error: null,
        },
      }));
    } catch (err) {
      if (selectedDateRef.current !== requestedDate) return;
      setDayHistory((cur) => ({
        ...cur,
        [jobKey]: {
          rows: cur[jobKey]?.rows ?? [],
          hasMore: false,
          loading: false,
          error: err instanceof ApiRequestError ? err.message : 'Не удалось загрузить историю',
        },
      }));
    }
  }

  function toggleDayHistory(jobKey: string) {
    if (openHistory === jobKey) {
      setOpenHistory(null);
      return;
    }
    setOpenHistory(jobKey);
    if (!dayHistory[jobKey]) void loadDayHistory(jobKey, false);
  }

  async function load() {
    try {
      const [r, h] = await Promise.all([getCronRegistry(), getCronHistory()]);
      setRegistry(r);
      setHistory(h);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Не удалось загрузить кроны');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function runJob(jobKey: string) {
    // «Метла» — единственная кнопка реестра, которая безвозвратно
    // удаляет файлы из хранилища; остальные девять только читают/пишут
    // строки в БД или дергают внешние API идемпотентно. Ничем не
    // отличаясь визуально от них, она стоит одним лишним кликом от
    // случайного запуска (пятый аудит, Д-1.4/Д-5.1) — подтверждение
    // здесь такое же по духу, что и `window.confirm` в других разделах
    // админки (library/users/payments) для их деструктивных действий.
    if (jobKey === 'sweep-orphans') {
      const dryRun = debugByJob[jobKey] ?? false;
      const message = dryRun
        ? 'Debug-прогон метлы: ничего не удалится, только покажет, что было бы удалено. Запустить?'
        : 'Метла удалит осиротевшие файлы из хранилища БЕЗВОЗВРАТНО. Включите Debug выше, чтобы сначала посмотреть, что будет удалено, без реального удаления. Продолжить с настоящим удалением?';
      if (!window.confirm(message)) return;
    }
    setRunningKey(jobKey);
    try {
      await runCronJob(jobKey, debugByJob[jobKey] ?? false);
      await Promise.all([load(), loadSummary()]);
      if (openHistory === jobKey) await loadDayHistory(jobKey, false);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Не удалось запустить крон');
    } finally {
      setRunningKey(null);
    }
  }

  function lastRunFor(jobKey: string): CronRunLog | undefined {
    return history?.find((h) => h.jobKey === jobKey);
  }

  function summaryFor(jobKey: string): CronJobSummary | undefined {
    return summary?.jobs.find((j) => j.jobKey === jobKey);
  }

  const failingJobs = summary?.jobs.filter((j) => j.recentFailures.length > 0) ?? [];

  if (error && !registry) {
    return (
      <div className="page">
        <p className="critical">
          {error}{' '}
          <button type="button" onClick={() => void load()}>
            Повторить
          </button>
        </p>
      </div>
    );
  }

  return (
    <div className="page">
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Кроны</h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        Те же задачи, что выполняются по расписанию Vercel Cron (см. doc/API.md) — здесь их
        можно запустить вручную и посмотреть последний прогон. Debug у большинства джобов только
        раскрывает подробный JSON результата; у «Метлы по хранилищу» debug дополнительно ничего не
        удаляет — см. подпись под её карточкой.
      </p>

      {error && (
        <p className="critical" style={{ marginBottom: 16 }}>
          {error}{' '}
          <button type="button" onClick={() => void load()}>
            Повторить
          </button>
        </p>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
            marginBottom: 12,
          }}
        >
          <p style={{ fontWeight: 600, marginRight: 8 }}>Сводка за день</p>
          <button
            type="button"
            disabled={dayMode === 'today'}
            onClick={() => setDayMode('today')}
          >
            Сегодня
          </button>
          <button
            type="button"
            disabled={dayMode === 'yesterday'}
            onClick={() => setDayMode('yesterday')}
          >
            Вчера
          </button>
          <input
            type="date"
            value={selectedDate}
            min={shiftLocalDate(-HISTORY_DAYS_BACK)}
            max={localDateString(new Date())}
            onChange={(e) => {
              if (!e.target.value) return;
              setCustomDate(e.target.value);
              setDayMode('date');
            }}
          />
          {summaryLoading && <span className="muted" style={{ fontSize: 13 }}>Загрузка…</span>}
        </div>
        <p className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
          Сутки по местному времени браузера; журнал хранится{' '}
          {summary ? summary.retentionDays : 30} дней. «Ожидалось» — по расписанию vercel.json
          (UTC), не раньше срока хранения; для сегодняшнего дня — только до момента «сейчас минус{' '}
          {summary ? Math.round(summary.expectedGraceMs / 60000) : 3} мин»: только что наступивший
          тик ещё мог не записаться, и без запаса он выглядел бы пропущенным. «Пропущено» сравнивает
          ожидание с прогонами Vercel Cron в том же окне; «по расписанию» — все прогоны Vercel Cron
          за день, ручные запуски — отдельно. «Зависшие» — RUNNING дольше замка джоба
          {summary ? ` (${Math.round(summary.lockMs / 60000)} мин)` : ''}.
        </p>

        {summaryError && (
          <p className="critical" style={{ marginBottom: 12 }}>
            {summaryError}{' '}
            <button type="button" onClick={() => void loadSummary()}>
              Повторить
            </button>
          </p>
        )}

        {summary && !summary.schedulesLoaded && (
          <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
            Расписание (vercel.json) на сервере недоступно — колонка «Ожидалось» пуста.
          </p>
        )}

        {summary && (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Крон</th>
                  <th>Ожидалось</th>
                  <th>По расписанию</th>
                  <th>Пропущено</th>
                  <th>Вручную</th>
                  <th>Успех</th>
                  <th>Ошибки</th>
                  <th>Выполняется</th>
                  <th>Медиана</th>
                  <th>Макс.</th>
                </tr>
              </thead>
              <tbody>
                {summary.jobs.map((j) => (
                  <tr key={j.jobKey}>
                    <td>
                      <span style={{ fontWeight: needsAttention(j) ? 600 : 400 }}>{j.jobKey}</span>
                      {j.schedule && (
                        <span className="muted" style={{ display: 'block', fontSize: 12 }}>
                          {j.schedule}
                        </span>
                      )}
                    </td>
                    <td>{j.expected ?? '—'}</td>
                    <td>{j.scheduledRuns}</td>
                    <td className={(j.missed ?? 0) > 0 ? 'critical' : undefined}>
                      {j.missed ?? '—'}
                    </td>
                    <td>{j.manualRuns}</td>
                    <td>{j.byStatus.SUCCESS}</td>
                    <td className={j.byStatus.FAILED > 0 ? 'critical' : undefined}>
                      {j.byStatus.FAILED}
                    </td>
                    <td>
                      {j.byStatus.RUNNING}
                      {j.stuck && (
                        <span
                          className="badge-status badge-status-critical"
                          style={{ marginLeft: 6 }}
                        >
                          зависших: {j.stuckRunning}
                        </span>
                      )}
                    </td>
                    <td>{formatMs(j.medianDurationMs)}</td>
                    <td>{formatMs(j.maxDurationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {failingJobs.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <p style={{ fontWeight: 600, marginBottom: 8 }}>Последние ошибки за день</p>
            {failingJobs.map((j) => (
              <div key={j.jobKey} style={{ marginBottom: 10 }}>
                <p style={{ fontSize: 13, fontWeight: 600 }}>{j.jobKey}</p>
                {j.recentFailures.map((f) => (
                  <p key={f.id} className="critical" style={{ fontSize: 13 }}>
                    {formatTime(f.startedAt)} · {f.triggeredBy} · {formatMs(f.durationMs)} —{' '}
                    {f.errorMessage ?? f.summary ?? 'без текста ошибки'}
                  </p>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {!registry ? (
        <p className="muted">Загрузка…</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {registry.map((job) => {
            const last = lastRunFor(job.jobKey);
            const isSweep = job.jobKey === 'sweep-orphans';
            const daySummary = summaryFor(job.jobKey);
            const dayState = dayHistory[job.jobKey];
            return (
              <div className="card" key={job.jobKey}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    justifyContent: 'space-between',
                    gap: 12,
                    marginBottom: 8,
                  }}
                >
                  <div>
                    <p style={{ fontWeight: 600 }}>{job.jobKey}</p>
                    <p className="muted" style={{ fontSize: 13 }}>{job.description}</p>
                  </div>
                  {last && (
                    <span className={`badge-status badge-status-${STATUS_SEVERITY[last.status]}`}>
                      {STATUS_LABEL[last.status]}
                    </span>
                  )}
                </div>

                {last?.summary && (
                  <button
                    type="button"
                    onClick={() => setExpanded(expanded === job.jobKey ? null : job.jobKey)}
                    className="muted"
                    style={{
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      marginBottom: 8,
                      textAlign: 'left',
                      textDecoration: 'underline',
                      cursor: 'pointer',
                      fontSize: 13,
                    }}
                  >
                    {last.summary}
                    {last.durationMs != null ? ` (${last.durationMs}мс)` : ''}
                    {last.debugLog !== null && last.debugLog !== undefined
                      ? expanded === job.jobKey
                        ? ' ▲'
                        : ' ▼'
                      : ''}
                  </button>
                )}

                {last?.status === 'FAILED' && last.errorMessage && (
                  <p className="critical" style={{ fontSize: 13, marginBottom: 8 }}>
                    ⚠ {last.errorMessage}
                  </p>
                )}

                {expanded === job.jobKey && last?.debugLog !== null && last?.debugLog !== undefined && (
                  <pre
                    style={{
                      maxHeight: 260,
                      overflow: 'auto',
                      background: '#0b0b0d',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      padding: 12,
                      fontSize: 12,
                      marginBottom: 8,
                    }}
                  >
                    {JSON.stringify(last.debugLog, null, 2)}
                  </pre>
                )}

                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    disabled={runningKey === job.jobKey}
                    onClick={() => void runJob(job.jobKey)}
                  >
                    {runningKey === job.jobKey ? 'Выполняется…' : 'Запустить'}
                  </button>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                    <input
                      type="checkbox"
                      checked={debugByJob[job.jobKey] ?? false}
                      onChange={(e) =>
                        setDebugByJob({ ...debugByJob, [job.jobKey]: e.target.checked })
                      }
                    />
                    Debug
                  </label>
                  {isSweep && (
                    <span className="muted" style={{ fontSize: 12 }}>
                      Debug здесь = ничего не удалять, только показать, что было бы удалено
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => toggleDayHistory(job.jobKey)}
                    style={{
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      marginLeft: 'auto',
                      textDecoration: 'underline',
                      cursor: 'pointer',
                      fontSize: 13,
                      color: 'inherit',
                    }}
                  >
                    {openHistory === job.jobKey ? 'Скрыть историю за день' : 'История за день'}
                    {daySummary ? ` (${daySummary.total})` : ''}
                  </button>
                </div>

                {openHistory === job.jobKey && (
                  <div style={{ marginTop: 12 }}>
                    {dayState?.error && (
                      <p className="critical" style={{ fontSize: 13, marginBottom: 8 }}>
                        {dayState.error}
                      </p>
                    )}
                    {dayState && dayState.rows.length === 0 && !dayState.loading && !dayState.error && (
                      <p className="muted" style={{ fontSize: 13 }}>
                        За {selectedDate} прогонов нет.
                      </p>
                    )}
                    {dayState && dayState.rows.length > 0 && (
                      <div className="table-scroll">
                        <table>
                          <thead>
                            <tr>
                              <th>Начало</th>
                              <th>Статус</th>
                              <th>Кто</th>
                              <th>Длительность</th>
                              <th>Итог</th>
                            </tr>
                          </thead>
                          <tbody>
                            {dayState.rows.map((r) => (
                              <tr key={r.id}>
                                <td>{formatTime(r.startedAt)}</td>
                                <td>
                                  <span
                                    className={`badge-status badge-status-${STATUS_SEVERITY[r.status]}`}
                                  >
                                    {STATUS_LABEL[r.status]}
                                  </span>
                                </td>
                                <td>{r.triggeredBy}</td>
                                <td>{formatMs(r.durationMs)}</td>
                                <td className={r.status === 'FAILED' ? 'critical' : undefined}>
                                  {r.errorMessage ?? r.summary ?? '—'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    {dayState?.loading && (
                      <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
                        Загрузка…
                      </p>
                    )}
                    {dayState?.hasMore && !dayState.loading && (
                      <button
                        type="button"
                        style={{ marginTop: 8 }}
                        onClick={() => void loadDayHistory(job.jobKey, true)}
                      >
                        Загрузить ещё
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
