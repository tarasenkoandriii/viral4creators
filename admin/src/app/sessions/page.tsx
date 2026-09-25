'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { listSessions, retrySessionGeneration, pollSessionStatus, runVideoAudit, applyFixAndRetry, getSessionVersions } from '../../lib/endpoints';
import type { SessionListResult, SessionSortKey, SortDirection, AuditStateView, VideoVersion } from '../../lib/types';
import { ApiRequestError } from '../../lib/admin-api';

const STATUSES = [
  '',
  'created',
  'video_uploaded',
  'analyzing',
  'analysis_complete',
  'product_info_added',
  'prompt_generated',
  'generating_video',
  'video_complete',
  'error',
];

const QUALITIES = ['', 'fast', 'standard'];
const VOICE_MODES = ['', 'veo', 'voiceover', 'dub'];
const PLANS = ['', 'LITE', 'STANDARD', 'PREMIUM'];

type ColumnKey =
  | 'status'
  | 'generationStatus'
  | 'product'
  | 'quality'
  | 'voiceMode'
  | 'owner'
  | 'video'
  | 'createdAt'
  | 'lastActivityAt';

interface ColumnDef {
  key: ColumnKey;
  label: string;
  /** Присутствует только у колонок, по которым бэкенд умеет сортировать. */
  sortKey?: SessionSortKey;
}

// Доп. запрос владельца продукта: пагинация + сортировки + фильтры по
// колонкам для списка роликов/сессий. ID — не в списке ниже: это ссылка
// на детали, скрывать её незачем.
const ALL_COLUMNS: ColumnDef[] = [
  { key: 'status', label: 'Статус', sortKey: 'status' },
  { key: 'generationStatus', label: 'Статус рендера' },
  { key: 'product', label: 'Товар' },
  { key: 'quality', label: 'Качество' },
  { key: 'voiceMode', label: 'Режим озвучки' },
  { key: 'owner', label: 'Владелец', sortKey: 'plan' },
  { key: 'video', label: 'Видео' },
  { key: 'createdAt', label: 'Создана', sortKey: 'createdAt' },
  { key: 'lastActivityAt', label: 'Активность', sortKey: 'lastActivityAt' },
];

const VISIBLE_COLUMNS_KEY = 'admin.sessions.visibleColumns';

function loadVisibleColumns(): Set<ColumnKey> {
  if (typeof window === 'undefined') return new Set(ALL_COLUMNS.map((c) => c.key));
  try {
    const raw = window.localStorage.getItem(VISIBLE_COLUMNS_KEY);
    if (!raw) return new Set(ALL_COLUMNS.map((c) => c.key));
    const parsed: string[] = JSON.parse(raw);
    const known = new Set(ALL_COLUMNS.map((c) => c.key as string));
    return new Set(parsed.filter((k) => known.has(k)) as ColumnKey[]);
  } catch {
    return new Set(ALL_COLUMNS.map((c) => c.key));
  }
}

function saveVisibleColumns(cols: Set<ColumnKey>): void {
  try {
    window.localStorage.setItem(VISIBLE_COLUMNS_KEY, JSON.stringify([...cols]));
  } catch {
    /* приватный режим/квота — просто не запомнится до следующего раза */
  }
}

export default function SessionsPage() {
  const [result, setResult] = useState<SessionListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [auditingId, setAuditingId] = useState<string | null>(null);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [auditResults, setAuditResults] = useState<Record<string, AuditStateView>>({});
  const [fixingId, setFixingId] = useState<string | null>(null);
  const [fixError, setFixError] = useState<string | null>(null);
  const [expandedVersionsId, setExpandedVersionsId] = useState<string | null>(null);
  const [versionsBySession, setVersionsBySession] = useState<Record<string, VideoVersion[]>>({});
  const [versionsLoadingId, setVersionsLoadingId] = useState<string | null>(null);
  const [versionsError, setVersionsError] = useState<string | null>(null);

  // Фильтры — по одному useState на колонку, тот же принцип, что был у
  // единственного фильтра status раньше.
  const [status, setStatus] = useState('');
  const [quality, setQuality] = useState('');
  const [voiceMode, setVoiceMode] = useState('');
  const [plan, setPlan] = useState('');
  const [createdFrom, setCreatedFrom] = useState('');
  const [createdTo, setCreatedTo] = useState('');
  // Начальное значение из адреса: из карточки находки (вкладка
  // «Тестирование») сюда приходят ссылкой с конкретным id сессии
  // (аудит этапа 158). Читается один раз при монтировании — дальше
  // поле живёт своей жизнью, и переписывать адрес на каждую букву
  // значило бы засорять историю браузера.
  const [search, setSearch] = useState(() => {
    if (typeof window === 'undefined') return '';
    return new URLSearchParams(window.location.search).get('search') ?? '';
  });

  const [sortBy, setSortBy] = useState<SessionSortKey>('createdAt');
  const [sortDir, setSortDir] = useState<SortDirection>('desc');

  const [columnsOpen, setColumnsOpen] = useState(false);
  const [visibleColumns, setVisibleColumns] = useState<Set<ColumnKey>>(
    () => loadVisibleColumns()
  );

  const toggleColumn = (key: ColumnKey) => {
    setVisibleColumns((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveVisibleColumns(next);
      return next;
    });
  };

  const toggleSort = (col: ColumnDef) => {
    if (!col.sortKey) return;
    if (sortBy === col.sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(col.sortKey);
      setSortDir('desc');
    }
    setPage(1);
  };

  // Доп. запрос владельца продукта: та же кнопка «Повторить», что видит
  // пользователь при проваленном рендере, но из админки. Патчим строку
  // на месте ответом сервера, а не перезагружаем весь список — ответ
  // уже несёт свежий статус (обычно снова 'processing').
  const handleRetry = async (id: string) => {
    setRetryingId(id);
    setRetryError(null);
    try {
      const updated = await retrySessionGeneration(id);
      setResult((prev) =>
        prev
          ? {
              ...prev,
              items: prev.items.map((item) =>
                item.sessionId === id ? { ...item, ...updated } : item
              ),
            }
          : prev
      );
    } catch (err) {
      setRetryError(
        err instanceof ApiRequestError ? err.message : 'Не удалось перезапустить рендер'
      );
    } finally {
      setRetryingId(null);
    }
  };

  // Доп. запрос владельца продукта: та же проверка на артефакты, что
  // видит пользователь на готовом ролике, только запущенная оператором.
  // Результат кладётся в ту же запись сессии, которую читает визард
  // пользователя — второй, отдельной видимости заводить не пришлось.
  const handleAudit = async (id: string) => {
    setAuditingId(id);
    setAuditError(null);
    try {
      const state = await runVideoAudit(id);
      setAuditResults((prev) => ({ ...prev, [id]: state }));
    } catch (err) {
      setAuditError(
        err instanceof ApiRequestError ? err.message : 'Не удалось запустить проверку на артефакты'
      );
    } finally {
      setAuditingId(null);
    }
  };

  // Реальный случай: аудит нашёл артефакты (пролив, битый текстовый
  // оверлей, лишний звук, обрыв в конце) — простое «Повторить» с тем же
  // промптом воспроизвело бы их снова. Три шага одним кликом на сервере
  // (применить фикс → одобрить за отсутствующего пользователя →
  // перегенерировать); здесь — тот же паттерн patch-строки на месте,
  // что у handleRetry.
  const handleApplyFixAndRetry = async (id: string) => {
    setFixingId(id);
    setFixError(null);
    try {
      const updated = await applyFixAndRetry(id);
      setResult((prev) =>
        prev
          ? {
              ...prev,
              items: prev.items.map((item) =>
                item.sessionId === id ? { ...item, ...updated } : item
              ),
            }
          : prev
      );
    } catch (err) {
      setFixError(
        err instanceof ApiRequestError ? err.message : 'Не удалось применить исправление и перегенерировать'
      );
    } finally {
      setFixingId(null);
    }
  };

  // Доп. запрос владельца продукта: «должно быть несколько кнопок для
  // каждой версии» — раскрывается по клику, а не грузится сразу для
  // всех строк списка (история — отдельный запрос на сессию, незачем
  // тянуть её для строк, которые никто не разворачивал).
  const handleToggleVersions = async (id: string) => {
    if (expandedVersionsId === id) {
      setExpandedVersionsId(null);
      return;
    }
    setExpandedVersionsId(id);
    setVersionsError(null);
    if (versionsBySession[id]) return;
    setVersionsLoadingId(id);
    try {
      const versions = await getSessionVersions(id);
      setVersionsBySession((prev) => ({ ...prev, [id]: versions }));
    } catch (err) {
      setVersionsError(
        err instanceof ApiRequestError ? err.message : 'Не удалось загрузить историю версий'
      );
    } finally {
      setVersionsLoadingId(null);
    }
  };

  useEffect(() => {
    let cancelled = false;
    // Этап 50 (В-5.13): ошибка прошлой загрузки не висит над свежими данными.
    setError(null);
    listSessions({
      status: status || undefined,
      quality: quality || undefined,
      voiceMode: voiceMode || undefined,
      plan: plan || undefined,
      createdFrom: createdFrom || undefined,
      createdTo: createdTo || undefined,
      search: search.trim() || undefined,
      sortBy,
      sortDir,
      page,
      pageSize: 20,
    })
      .then((r) => {
        if (!cancelled) setResult(r);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiRequestError ? err.message : 'Не удалось загрузить сессии');
      });
    return () => {
      cancelled = true;
    };
  }, [status, quality, voiceMode, plan, createdFrom, createdTo, search, sortBy, sortDir, page]);

  // Без этого опроса рендер, запущенный из админки (кнопкой «Повторить»
  // ниже), никогда не продвинется дальше 'processing' — у оператора нет
  // собственного визарда, который опрашивал бы статус за пользователя
  // (обычно это делает клиент пользователя каждые 4 с). Опрашиваем
  // КАЖДУЮ строку, у которой рендер ещё идёт — не только ту, что только
  // что перезапустили: так же подхватывается 'processing', оставшийся
  // от предыдущей открытой вкладки/сессии оператора.
  const pollTimers = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());

  useEffect(() => {
    if (!result) return;
    const active = new Set(
      result.items
        .filter((s) => s.generationStatus === 'pending' || s.generationStatus === 'processing')
        .map((s) => s.sessionId)
    );

    for (const [id, timer] of pollTimers.current) {
      if (!active.has(id)) {
        clearInterval(timer);
        pollTimers.current.delete(id);
      }
    }

    for (const id of active) {
      if (pollTimers.current.has(id)) continue;
      const timer = setInterval(() => {
        pollSessionStatus(id)
          .then((updated) => {
            setResult((prev) =>
              prev
                ? {
                    ...prev,
                    items: prev.items.map((item) =>
                      item.sessionId === id ? { ...item, ...updated } : item
                    ),
                  }
                : prev
            );
          })
          .catch(() => {
            // Сетевая икота — тот же принцип, что у визарда пользователя:
            // не хоронить прогресс из-за одного неудачного опроса,
            // попробуем на следующем тике.
          });
      }, 4000);
      pollTimers.current.set(id, timer);
    }
  }, [result]);

  useEffect(() => {
    const timers = pollTimers.current;
    return () => {
      for (const timer of timers.values()) clearInterval(timer);
      timers.clear();
    };
  }, []);

  const totalPages = result ? Math.max(Math.ceil(result.total / result.pageSize), 1) : 1;
  const visibleColumnDefs = useMemo(
    () => ALL_COLUMNS.filter((c) => visibleColumns.has(c.key)),
    [visibleColumns]
  );

  const ownerLabel = (s: { ownerPlan: string | null; ownerUsername: string | null; ownerFirstName: string | null; userId: string | null }) => {
    if (!s.userId) return <span className="muted">аноним</span>;
    const name = s.ownerUsername ? `@${s.ownerUsername}` : s.ownerFirstName ?? s.userId.slice(0, 8);
    return (
      <>
        {name}
        {s.ownerPlan && <span className="muted"> · {s.ownerPlan}</span>}
      </>
    );
  };

  return (
    <div className="page">
      <h1 style={{ fontSize: 20, marginBottom: 16 }}>Сессии</h1>

      <div className="filters" style={{ marginBottom: 16, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <select
          aria-label="Фильтр по статусу сессии"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="">Все статусы</option>
          {STATUSES.filter(Boolean).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        <select
          aria-label="Фильтр по качеству рендера"
          value={quality}
          onChange={(e) => {
            setQuality(e.target.value);
            setPage(1);
          }}
        >
          <option value="">Любое качество</option>
          {QUALITIES.filter(Boolean).map((q) => (
            <option key={q} value={q}>
              {q}
            </option>
          ))}
        </select>

        <select
          aria-label="Фильтр по режиму озвучки"
          value={voiceMode}
          onChange={(e) => {
            setVoiceMode(e.target.value);
            setPage(1);
          }}
        >
          <option value="">Любая озвучка</option>
          {VOICE_MODES.filter(Boolean).map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>

        <select
          aria-label="Фильтр по тарифу владельца"
          value={plan}
          onChange={(e) => {
            setPlan(e.target.value);
            setPage(1);
          }}
        >
          <option value="">Любой тариф</option>
          {PLANS.filter(Boolean).map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>

        <label className="muted" style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 12 }}>
          с
          <input
            type="date"
            aria-label="Создана с"
            value={createdFrom}
            onChange={(e) => {
              setCreatedFrom(e.target.value);
              setPage(1);
            }}
          />
        </label>
        <label className="muted" style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 12 }}>
          по
          <input
            type="date"
            aria-label="Создана по"
            value={createdTo}
            onChange={(e) => {
              setCreatedTo(e.target.value);
              setPage(1);
            }}
          />
        </label>

        <input
          type="text"
          aria-label="Поиск по владельцу или id сессии"
          placeholder="Владелец или id сессии"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />

        <div style={{ position: 'relative', marginLeft: 'auto' }}>
          <button type="button" onClick={() => setColumnsOpen((v) => !v)}>
            Колонки ▾
          </button>
          {columnsOpen && (
            <div
              className="card"
              style={{
                position: 'absolute',
                right: 0,
                top: '100%',
                marginTop: 4,
                zIndex: 10,
                minWidth: 220,
                padding: 12,
              }}
            >
              {ALL_COLUMNS.map((c) => (
                <label key={c.key} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0', fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={visibleColumns.has(c.key)}
                    onChange={() => toggleColumn(c.key)}
                  />
                  {c.label}
                </label>
              ))}
            </div>
          )}
        </div>
      </div>

      {error && <p className="critical">{error}</p>}
      {retryError && <p className="critical">{retryError}</p>}
      {auditError && <p className="critical">{auditError}</p>}
      {fixError && <p className="critical">{fixError}</p>}
      {versionsError && <p className="critical">{versionsError}</p>}

      {result && (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  {visibleColumnDefs.map((c) => (
                    <th key={c.key}>
                      {c.sortKey ? (
                        <button
                          type="button"
                          onClick={() => toggleSort(c)}
                          style={{ fontWeight: 600, cursor: 'pointer' }}
                        >
                          {c.label}
                          {sortBy === c.sortKey && (sortDir === 'asc' ? ' ↑' : ' ↓')}
                        </button>
                      ) : (
                        c.label
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.items.map((s) => (
                  <tr key={s.sessionId}>
                    <td>
                      <Link href={`/sessions/${s.sessionId}`}>{s.sessionId.slice(0, 8)}…</Link>
                    </td>
                    {visibleColumns.has('status') && <td>{s.status}</td>}
                    {visibleColumns.has('generationStatus') && (
                      <td className="muted">
                        {s.generationStatus === 'failed' ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
                            <span title={s.errorMessage ?? undefined}>
                              failed{s.errorCode ? ` (${s.errorCode})` : ''}
                            </span>
                            {s.errorMessage && (
                              <span style={{ fontSize: 11, maxWidth: 220 }}>{s.errorMessage}</span>
                            )}
                            <button
                              type="button"
                              disabled={retryingId === s.sessionId}
                              onClick={() => handleRetry(s.sessionId)}
                            >
                              {retryingId === s.sessionId ? 'Запускаю…' : '↻ Повторить'}
                            </button>
                          </div>
                        ) : s.generationStatus === 'processing' || s.generationStatus === 'pending' ? (
                          <span>{s.generationStatus} · опрашиваю…</span>
                        ) : (
                          s.generationStatus ?? '—'
                        )}
                      </td>
                    )}
                    {visibleColumns.has('product') && (
                      <td>{s.productName ?? <span className="muted">—</span>}</td>
                    )}
                    {visibleColumns.has('quality') && (
                      // У Grok нет понятия `quality` — своя ось, `resolution`
                      // (см. комментарий у generation.service.ts). Колонка
                      // раньше читала только `quality` и потому у Grok-роликов
                      // — по дефолту фронтенда почти все ролики — всегда была
                      // прочерком, хотя данные были, просто по другому полю
                      // (этап 86).
                      <td className="muted">
                        {s.quality || s.resolution
                          ? s.provider === 'grok'
                            ? `Grok · ${s.resolution ?? '—'}`
                            : `Veo · ${s.quality ?? '—'}`
                          : '—'}
                      </td>
                    )}
                    {visibleColumns.has('voiceMode') && (
                      // Пустое значение — не «нет данных», а дефолт §15.1:
                      // не выбрано явно = veo. Прочерк здесь читался бы
                      // как «неизвестно», хотя на самом деле известно.
                      <td className="muted">{s.voiceMode ?? 'veo'}</td>
                    )}
                    {visibleColumns.has('owner') && <td>{ownerLabel(s)}</td>}
                    {visibleColumns.has('video') && (
                      <td>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
                          {s.hasGeneratedVideo && s.downloadUrl ? (
                            <>
                              <a href={s.downloadUrl} target="_blank" rel="noopener noreferrer">
                                ▶ Смотреть
                              </a>
                              <button
                                type="button"
                                disabled={auditingId === s.sessionId}
                                onClick={() => handleAudit(s.sessionId)}
                              >
                                {auditingId === s.sessionId ? 'Проверяю…' : '🔍 На артефакты'}
                              </button>
                              {auditResults[s.sessionId]?.history[0] && (
                                <span
                                  className="muted"
                                  style={{ fontSize: 11, maxWidth: 220 }}
                                  title={auditResults[s.sessionId].history[0].summary}
                                >
                                  {auditResults[s.sessionId].history[0].verdict}:{' '}
                                  {auditResults[s.sessionId].history[0].summary}
                                </span>
                              )}
                              {auditResults[s.sessionId]?.history[0]?.promptFix && (
                                <button
                                  type="button"
                                  disabled={fixingId === s.sessionId}
                                  onClick={() => handleApplyFixAndRetry(s.sessionId)}
                                >
                                  {fixingId === s.sessionId
                                    ? 'Исправляю…'
                                    : '🛠 Исправить и перегенерировать'}
                                </button>
                              )}
                            </>
                          ) : (
                            <span className="muted">—</span>
                          )}
                          {/* Доп. запрос владельца продукта: тогл виден независимо от
                              того, завершилась ли ТЕКУЩАЯ попытка — история прошлых
                              попыток (включая проваленные) не зависит от неё. */}
                          <button type="button" onClick={() => handleToggleVersions(s.sessionId)}>
                            {expandedVersionsId === s.sessionId ? '▴ Версии' : '▾ Версии'}
                          </button>
                          {expandedVersionsId === s.sessionId && (
                            <div
                              className="card"
                              style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 6, minWidth: 260 }}
                            >
                              {versionsLoadingId === s.sessionId && (
                                <span className="muted">Загрузка…</span>
                              )}
                              {versionsBySession[s.sessionId]?.length === 0 && (
                                <span className="muted">Прошлых попыток нет</span>
                              )}
                              {versionsBySession[s.sessionId]?.map((v) => (
                                <div
                                  key={v.generatedVideoId}
                                  style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11 }}
                                >
                                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                    {v.isCurrent && <strong>текущая</strong>}
                                    <span className="muted">{v.status}</span>
                                    <span className="muted">
                                      {v.provider === 'grok' ? `Grok · ${v.resolution ?? '—'}` : `Veo · ${v.quality ?? '—'}`} · {v.aspectRatio ?? '—'}
                                    </span>
                                    {v.downloadUrl && (
                                      <a href={v.downloadUrl} target="_blank" rel="noopener noreferrer">
                                        ▶
                                      </a>
                                    )}
                                  </div>
                                  {/* Доп. запрос владельца продукта: «Чего избежать» видно
                                      оператору (§4/§16.6 ТЗ) — тот же принцип, что уже
                                      применён к provider/resolution выше. */}
                                  {v.avoidText && (
                                    <div className="muted" style={{ fontStyle: 'italic' }}>
                                      Избегать: {v.avoidText}
                                    </div>
                                  )}
                                  {v.audits.map((a) => (
                                    <span key={a.auditId} className="muted" title={a.summary}>
                                      {a.verdict}: {a.summary}
                                      {a.hasPromptFix ? ' (есть фикс)' : ''}
                                    </span>
                                  ))}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </td>
                    )}
                    {visibleColumns.has('createdAt') && (
                      <td className="muted">{new Date(s.createdAt).toLocaleString('ru-RU')}</td>
                    )}
                    {visibleColumns.has('lastActivityAt') && (
                      <td className="muted">{new Date(s.lastActivityAt).toLocaleString('ru-RU')}</td>
                    )}
                  </tr>
                ))}
                {result.items.length === 0 && (
                  <tr>
                    <td colSpan={visibleColumnDefs.length + 1} className="muted">
                      Ничего не найдено
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 16, alignItems: 'center' }}>
            <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              ← Назад
            </button>
            <span className="muted">
              Стр. {result.page} из {totalPages} (всего {result.total})
            </span>
            <button type="button" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
              Вперёд →
            </button>
          </div>
        </>
      )}
    </div>
  );
}
