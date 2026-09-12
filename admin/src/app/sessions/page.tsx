'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { listSessions } from '../../lib/endpoints';
import type { SessionListResult, SessionSortKey, SortDirection } from '../../lib/types';
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
  { key: 'voiceMode', label: 'Озвучка' },
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

  // Фильтры — по одному useState на колонку, тот же принцип, что был у
  // единственного фильтра status раньше.
  const [status, setStatus] = useState('');
  const [quality, setQuality] = useState('');
  const [voiceMode, setVoiceMode] = useState('');
  const [plan, setPlan] = useState('');
  const [createdFrom, setCreatedFrom] = useState('');
  const [createdTo, setCreatedTo] = useState('');
  const [search, setSearch] = useState('');

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
          aria-label="Поиск по владельцу"
          placeholder="Владелец (username/имя/telegram id)"
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
                      <td className="muted">{s.generationStatus ?? '—'}</td>
                    )}
                    {visibleColumns.has('product') && (
                      <td>{s.productName ?? <span className="muted">—</span>}</td>
                    )}
                    {visibleColumns.has('quality') && (
                      <td className="muted">{s.quality ?? '—'}</td>
                    )}
                    {visibleColumns.has('voiceMode') && (
                      <td className="muted">{s.voiceMode ?? '—'}</td>
                    )}
                    {visibleColumns.has('owner') && <td>{ownerLabel(s)}</td>}
                    {visibleColumns.has('video') && (
                      <td>{s.hasGeneratedVideo ? '✓' : <span className="muted">—</span>}</td>
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
