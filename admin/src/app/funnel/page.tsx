'use client';

// Вкладка «Воронка» (этап 78, doc/WORKFLOW-FUNNEL-SPEC.md,
// doc/WORKFLOW-FUNNEL-COHORT-CONVERSION-SPEC.md) — два РАЗНЫХ вопроса на
// одной странице через переключатель режима (§6 когортного ТЗ), а не две
// вкладки: «Событийная воронка» — что произошло за окно (§3.3 родительского
// ТЗ, событийный счётчик, числа могут идти не строго по убыванию слева
// направо и не обязаны быть монотонны между стадиями); «Когортная
// конверсия» — что случилось с теми, кто СТАРТОВАЛ в этом окне, без
// ограничения по времени самого перехода (§3.1 когортного ТЗ). Режимы
// намеренно подписаны разными словами и разнесены визуально, чтобы
// оператор не путал одно с другим (см. явное требование §3.1 когортного
// документа).

import { useEffect, useState } from 'react';
import { getWorkflowFunnel, getWorkflowCohortConversion } from '../../lib/endpoints';
import type {
  WorkflowWindow,
  WorkflowFunnelResult,
  WorkflowCohortConversionResult,
} from '../../lib/types';
import { ApiRequestError } from '../../lib/admin-api';

const WINDOW_LABEL: Record<WorkflowWindow, string> = {
  hour: 'Последний час',
  day: 'Последние сутки',
  week: 'Последняя неделя',
  month: 'Последний месяц',
};

type Mode = 'event' | 'cohort';

/** `ms` → «Xм Yс», округлено до секунды — точнее миллисекунд оператору не
 * нужно, а «5 минут 42 секунды» читается быстрее, чем «342000». */
function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}с`;
  return `${minutes}м ${seconds}с`;
}

/** `0.68` → «68%». Намеренно НЕ обрезает значения выше 100% (когортный
 * ТЗ §4.1 — обход промежуточных стадий может дать >100%, это не ошибка
 * данных). */
function formatPct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export default function FunnelPage() {
  const [window_, setWindow] = useState<WorkflowWindow>('day');
  const [mode, setMode] = useState<Mode>('event');
  const [funnel, setFunnel] = useState<WorkflowFunnelResult | null>(null);
  const [cohort, setCohort] = useState<WorkflowCohortConversionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Пятый аудит (доп. проверка §5 — доведение до ума): «Повторить» должен
  // реально повторить загрузку, а не просто выставить то же самое
  // значение периода (`setWindow((w) => w)` — React пропускает ререндер
  // при `Object.is`-равном состоянии, кнопка ничего не делала). Отдельный
  // счётчик в зависимостях эффекта — тот же результат, что и извлечение
  // `load()` наружу (как в `cron/page.tsx`), но без риска разъехаться с
  // `react-hooks/exhaustive-deps` на реактивных `window_`/`mode`.
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    const request =
      mode === 'event' ? getWorkflowFunnel(window_) : getWorkflowCohortConversion(window_);
    request
      .then((result) => {
        if (cancelled) return;
        if (mode === 'event') setFunnel(result as WorkflowFunnelResult);
        else setCohort(result as WorkflowCohortConversionResult);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof ApiRequestError ? err.message : 'Не удалось загрузить воронку');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [window_, mode, refreshKey]);

  function reload() {
    setRefreshKey((k) => k + 1);
  }

  return (
    <div className="page">
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Воронка</h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        {mode === 'event'
          ? 'Событийная воронка: сколько роликов получили каждое событие за выбранный период — это НЕ когорта, числа на соседних стадиях не обязаны идти по убыванию (сущность могла пройти стадию ещё до начала окна или после его конца).'
          : 'Когортная конверсия: что случилось с роликами, СТАРТОВАВШИМИ в выбранном периоде, без ограничения по времени самого перехода — свежая когорта может быть ещё не завершена (см. пометку под каждой карточкой).'}
      </p>

      <div className="filters" style={{ marginBottom: 20, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <select
          aria-label="Период"
          value={window_}
          onChange={(e) => setWindow(e.target.value as WorkflowWindow)}
        >
          {(Object.keys(WINDOW_LABEL) as WorkflowWindow[]).map((w) => (
            <option key={w} value={w}>
              {WINDOW_LABEL[w]}
            </option>
          ))}
        </select>
        <select aria-label="Режим" value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
          <option value="event">Событийная воронка</option>
          <option value="cohort">Когортная конверсия</option>
        </select>
      </div>

      {error && (
        <p className="critical" style={{ marginBottom: 16 }}>
          {error}{' '}
          <button type="button" onClick={reload}>
            Повторить
          </button>
        </p>
      )}

      {mode === 'event' && !funnel && !error && <p className="muted">Загрузка…</p>}
      {mode === 'cohort' && !cohort && !error && <p className="muted">Загрузка…</p>}

      {mode === 'event' && funnel && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {funnel.blocks.map((block) => (
            <div className="card" key={block.workflow}>
              <h2 style={{ fontSize: 16, marginTop: 0, marginBottom: 12 }}>{block.label}</h2>
              <div className="workflow-diagram-scroll">
                <div className="workflow-diagram">
                  {block.stages.map((stage, i) => (
                    <div key={stage.key} style={{ display: 'flex', alignItems: 'center' }}>
                      {i > 0 && <span className="workflow-arrow">→</span>}
                      <div className="workflow-stage">
                        <div className="muted" style={{ fontSize: 12 }}>
                          {stage.label}
                        </div>
                        <div className="workflow-stage-count">{stage.count}</div>
                        {stage.uniqueUsers !== null && (
                          <div className="muted" style={{ fontSize: 11 }}>
                            {stage.uniqueUsers} польз.
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {block.totalFailed > 0 && (
                <div className="workflow-failures">
                  <div className="critical" style={{ fontWeight: 600, marginBottom: 6 }}>
                    Ошибок: {block.totalFailed}
                  </div>
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {block.failures.map((f) => (
                      <li key={f.fromStage} className="muted" style={{ fontSize: 13 }}>
                        с «{f.fromLabel}»: {f.count} роликов ({f.uniqueUsers} польз.)
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {mode === 'cohort' && cohort && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {cohort.blocks.map((block) => (
            <div className="card" key={block.workflow}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: 8,
                  marginBottom: 12,
                }}
              >
                <h2 style={{ fontSize: 16, margin: 0 }}>{block.label}</h2>
                <span className="muted" style={{ fontSize: 13 }}>
                  Когорта: {block.cohortSize} роликов
                </span>
              </div>

              {!block.matured && (
                <div className="badge-status badge-status-warning" style={{ marginBottom: 12 }}>
                  ещё не завершена — цифры могут вырасти
                </div>
              )}

              {block.cohortSize === 0 ? (
                <p className="muted" style={{ fontSize: 13 }}>
                  Ни один ролик не начал путь в этом периоде.
                </p>
              ) : (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Стадия</th>
                        <th>Роликов</th>
                        <th>% от когорты</th>
                        <th>% от предыдущей</th>
                        <th>Среднее время от старта</th>
                      </tr>
                    </thead>
                    <tbody>
                      {block.stages.map((stage) => (
                        <tr key={stage.key}>
                          <td>{stage.label}</td>
                          <td>{stage.reached}</td>
                          <td>{formatPct(stage.pctOfCohort)}</td>
                          <td>{stage.pctOfPrevious === null ? '—' : formatPct(stage.pctOfPrevious)}</td>
                          <td>
                            {stage.avgDurationFromStartMs === null
                              ? '—'
                              : formatDuration(stage.avgDurationFromStartMs)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
