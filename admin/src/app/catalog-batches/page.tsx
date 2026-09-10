'use client';

// Пакетная генерация по каталогу — один уже одобренный ролик (разбор +
// промпт) переносится на все остальные выбранные товары линейки за один
// заход (ТЗ §44, этап 65, doc/TODO.md §III.5). Read-only: обработка идёт
// кроном (GET /api/cron/catalog-batch-run, см. CatalogBatchWorkerService
// на бэкенде), оператору здесь нечего нажимать — только история запусков
// и сводка по статусам.

import { useCallback, useEffect, useRef, useState } from 'react';
import { listCatalogBatches } from '../../lib/endpoints';
import type { AdminCatalogBatchListResult } from '../../lib/types';
import { ApiRequestError } from '../../lib/admin-api';

function errText(e: unknown): string {
  return e instanceof ApiRequestError ? e.message : 'Не удалось выполнить запрос';
}

export default function CatalogBatchesPage() {
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<AdminCatalogBatchListResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadGen = useRef(0);
  const load = useCallback(() => {
    const gen = ++loadGen.current;
    setError(null);
    listCatalogBatches({ page, pageSize: 20 })
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
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Пакетная генерация</h1>
      <p className="muted" style={{ marginBottom: 16 }}>
        Одна уже одобренная сессия (разбор + промпт + готовый ролик) переносится на остальные
        товары линейки за один заход — доступно только на Premium. Обработка идёт кроном по одному
        товару за раз: создание сессии, перенос разбора, генерация и одобрение промпта, старт
        рендера — без остановки на подтверждение по каждому. Здесь только история запусков и
        сводка по статусам, вмешиваться оператору нечем.
      </p>

      {error && (
        <p className="critical">
          {error}{' '}
          <button type="button" onClick={load}>
            Повторить
          </button>
        </p>
      )}

      {result && result.items.length === 0 && <p className="muted">Партий ещё не запускали.</p>}

      {result && result.items.length > 0 && (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Запущена</th>
                  <th>Проект</th>
                  <th>Пользователь</th>
                  <th>В очереди</th>
                  <th>Генерируется</th>
                  <th>Готово</th>
                  <th>Ошибок</th>
                  <th>Всего товаров</th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((row) => (
                  <tr key={row.id}>
                    <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                      {new Date(row.createdAt).toLocaleString('ru-RU')}
                    </td>
                    <td className="muted" style={{ fontFamily: 'monospace', fontSize: 12 }}>
                      {row.projectId}
                    </td>
                    <td className="muted" style={{ fontFamily: 'monospace', fontSize: 12 }}>
                      {row.userId}
                    </td>
                    <td>{row.pending}</td>
                    <td>{row.generating}</td>
                    <td>{row.done}</td>
                    <td>{row.failed > 0 ? <span className="critical">{row.failed}</span> : row.failed}</td>
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
