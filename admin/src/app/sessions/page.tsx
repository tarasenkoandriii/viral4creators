'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { listSessions } from '../../lib/endpoints';
import type { SessionListResult } from '../../lib/types';
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

export default function SessionsPage() {
  const [result, setResult] = useState<SessionListResult | null>(null);
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Этап 50 (В-5.13): ошибка прошлой загрузки не висит над свежими данными.
    setError(null);
    listSessions({ status: status || undefined, page, pageSize: 20 })
      .then((r) => {
        if (!cancelled) setResult(r);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiRequestError ? err.message : 'Не удалось загрузить сессии');
      });
    return () => {
      cancelled = true;
    };
  }, [status, page]);

  const totalPages = result ? Math.max(Math.ceil(result.total / result.pageSize), 1) : 1;

  return (
    <div className="page">
      <h1 style={{ fontSize: 20, marginBottom: 16 }}>Сессии</h1>

      <div className="filters" style={{ marginBottom: 16, display: 'flex', gap: 8 }}>
        {/* Инлайновые стили селекта убраны: те же background/border/radius
            теперь приходят из globals.css на все поля разом (А-3.3). */}
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
      </div>

      {error && <p className="critical">{error}</p>}

      {result && (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Статус</th>
                  <th>Товар</th>
                  <th>Видео</th>
                  <th>Создана</th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((s) => (
                  <tr key={s.sessionId}>
                    <td>
                      <Link href={`/sessions/${s.sessionId}`}>{s.sessionId.slice(0, 8)}…</Link>
                    </td>
                    <td>{s.status}</td>
                    <td>{s.productName ?? <span className="muted">—</span>}</td>
                    <td>{s.hasGeneratedVideo ? '✓' : <span className="muted">—</span>}</td>
                    <td className="muted">{new Date(s.createdAt).toLocaleString('ru-RU')}</td>
                  </tr>
                ))}
                {result.items.length === 0 && (
                  <tr>
                    <td colSpan={5} className="muted">
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
