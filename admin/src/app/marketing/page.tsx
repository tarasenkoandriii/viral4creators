'use client';

// Рекламный канал — рассылка подборки удачных роликов через Telegram-
// бота (ТЗ §42, этап 63, doc/TODO.md §III.4). Read-only: отбор контента
// для выпуска полностью автоматический (крон GET /api/cron/marketing-
// broadcast, см. MarketingBroadcastService на бэкенде), оператору здесь
// нечего нажимать — только история выпусков и текущее число подписчиков.

import { useCallback, useEffect, useRef, useState } from 'react';
import { listMarketingBroadcasts } from '../../lib/endpoints';
import type { AdminBroadcastListResult } from '../../lib/types';
import { ApiRequestError } from '../../lib/admin-api';

function errText(e: unknown): string {
  return e instanceof ApiRequestError ? e.message : 'Не удалось выполнить запрос';
}

export default function MarketingPage() {
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<AdminBroadcastListResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadGen = useRef(0);
  const load = useCallback(() => {
    const gen = ++loadGen.current;
    setError(null);
    listMarketingBroadcasts({ page, pageSize: 20 })
      .then((r) => {
        if (gen === loadGen.current) setResult(r);
      })
      .catch((e) => {
        if (gen === loadGen.current) setError(errText(e));
      });
  }, [page]);

  useEffect(() => {
    load();
  }, [load]);

  const totalPages = result ? Math.max(Math.ceil(result.total / result.pageSize), 1) : 1;

  return (
    <div className="page">
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Рассылка</h1>
      <p className="muted" style={{ marginBottom: 16 }}>
        Подборка удачных роликов (SharedVideoPage со статусом PUBLISHED) уходит подписавшимся
        пользователям через Telegram-бота не чаще раза в несколько дней. Согласие добровольное и
        отзывается в один клик в приложении; блокировка бота пользователем снимает согласие
        автоматически. Отбор карточек для выпуска полностью автоматический — здесь только история
        и текущее число подписчиков.
      </p>

      {result && (
        <p style={{ marginBottom: 16 }}>
          Сейчас подписано: <strong>{result.activeSubscribers}</strong>
        </p>
      )}

      {error && (
        <p className="critical">
          {error}{' '}
          <button type="button" onClick={load}>
            Повторить
          </button>
        </p>
      )}

      {result && result.items.length === 0 && <p className="muted">Выпусков рассылки ещё не было.</p>}

      {result && result.items.length > 0 && (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Собран</th>
                  <th>Карточек</th>
                  <th>Отправлено</th>
                  <th>Ошибок</th>
                  <th>Пропущено</th>
                  <th>В очереди</th>
                  <th>Всего доставок</th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((row) => (
                  <tr key={row.id}>
                    <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                      {new Date(row.createdAt).toLocaleString('ru-RU')}
                    </td>
                    <td>{row.featuredCount}</td>
                    <td>{row.sent}</td>
                    <td>{row.failed > 0 ? <span className="critical">{row.failed}</span> : row.failed}</td>
                    <td>{row.skipped}</td>
                    <td>{row.pending}</td>
                    <td className="muted">{row.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 16 }}>
            <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              ← Назад
            </button>
            <span className="muted">
              {page} / {totalPages} · всего {result.total}
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
