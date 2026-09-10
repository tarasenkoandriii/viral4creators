'use client';

// Вкладка «Кроны» (доп. ТЗ «Кроны в админке», этап 69, аналогично Solar
// Shop): реестр десяти крон-задач, статус последнего прогона, ручной
// запуск с необязательным флагом debug. У девяти из десяти джобов debug
// раскрывает только сырой JSON результата (debugLog); у sweep-orphans
// debug меняет ПОВЕДЕНИЕ — маппится на dryRun (безвозвратное удаление
// файлов из хранилища — единственная из десяти операций, где случайный
// клик реально необратим), поэтому у неё отдельная подпись рядом с
// чекбоксом.

import { useEffect, useState } from 'react';
import { getCronRegistry, getCronHistory, runCronJob } from '../../lib/endpoints';
import type { CronJobInfo, CronRunLog, CronRunStatus } from '../../lib/types';
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

export default function CronPage() {
  const [registry, setRegistry] = useState<CronJobInfo[] | null>(null);
  const [history, setHistory] = useState<CronRunLog[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runningKey, setRunningKey] = useState<string | null>(null);
  const [debugByJob, setDebugByJob] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<string | null>(null);

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
    // «Метла» — единственная из десяти кнопок, которая безвозвратно
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
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Не удалось запустить крон');
    } finally {
      setRunningKey(null);
    }
  }

  function lastRunFor(jobKey: string): CronRunLog | undefined {
    return history?.find((h) => h.jobKey === jobKey);
  }

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
        Те же десять задач, что выполняются по расписанию Vercel Cron (см. doc/API.md) — здесь их
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

      {!registry ? (
        <p className="muted">Загрузка…</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {registry.map((job) => {
            const last = lastRunFor(job.jobKey);
            const isSweep = job.jobKey === 'sweep-orphans';
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
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
