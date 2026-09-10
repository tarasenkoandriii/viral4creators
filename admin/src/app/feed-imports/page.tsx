'use client';

// Импорт товарного фида по ссылке — продавец с сотнями SKU вставляет
// ссылку на свой YML/CSV-фид вместо ручного заведения каждой позиции
// (TODO §Уровень 2 п.8, этап 68, doc/PRODUCT-PROJECT-SPEC.md §47).
// Read-only: обработка идёт кроном (GET /api/cron/feed-import-run, см.
// ProductFeedImportWorkerService на бэкенде), оператору здесь нечего
// нажимать — только история запусков и сводка по статусам. В отличие от
// «Пакетной генерации»/«A/B-вариантов», счётчики здесь не считаются на
// лету — они уже накоплены воркером прямо в строке запуска.

import { useCallback, useEffect, useRef, useState } from 'react';
import { listFeedImports } from '../../lib/endpoints';
import type { AdminFeedImportListResult, AdminFeedImportStatus } from '../../lib/types';
import { ApiRequestError } from '../../lib/admin-api';

function errText(e: unknown): string {
  return e instanceof ApiRequestError ? e.message : 'Не удалось выполнить запрос';
}

const STATUS_LABEL: Record<AdminFeedImportStatus, string> = {
  PENDING: 'В очереди',
  IMPORTING: 'Импортируется',
  DONE: 'Готово',
  FAILED: 'Ошибка',
};

export default function FeedImportsPage() {
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<AdminFeedImportListResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadGen = useRef(0);
  const load = useCallback(() => {
    const gen = ++loadGen.current;
    setError(null);
    listFeedImports({ page, pageSize: 20 })
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
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Импорт товарного фида</h1>
      <p className="muted" style={{ marginBottom: 16 }}>
        Продавец вставляет ссылку на YML- или CSV-фид каталога (Rozetka, Prom, «Мой склад»,
        экспорт из Shopify/WooCommerce) — доступно только на Premium. Импорт разовый: снимок фида
        на момент запуска, а не постоянная синхронизация. Обработка идёт кроном: скачивание и
        разбор фида, затем заведение позиций по одной через тот же путь, что и ручное добавление.
        Здесь только история запусков и сводка по статусам, вмешиваться оператору нечем.
      </p>

      {error && (
        <p className="critical">
          {error}{' '}
          <button type="button" onClick={load}>
            Повторить
          </button>
        </p>
      )}

      {result && result.items.length === 0 && <p className="muted">Импортов ещё не запускали.</p>}

      {result && result.items.length > 0 && (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Запущен</th>
                  <th>Проект</th>
                  <th>Пользователь</th>
                  <th>Ссылка на фид</th>
                  <th>Статус</th>
                  <th>Добавлено</th>
                  <th>Пропущено</th>
                  <th>Ошибок</th>
                  <th>Всего строк</th>
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
                    <td
                      className="muted"
                      style={{
                        maxWidth: 260,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={row.sourceUrl}
                    >
                      {row.sourceUrl}
                    </td>
                    <td>
                      {row.status === 'FAILED' ? (
                        <span className="critical">{STATUS_LABEL[row.status]}</span>
                      ) : (
                        STATUS_LABEL[row.status]
                      )}
                      {row.status === 'FAILED' && row.error && (
                        <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                          {row.error}
                        </div>
                      )}
                    </td>
                    <td>{row.importedCount}</td>
                    <td>{row.skippedCount}</td>
                    <td>{row.failedCount > 0 ? <span className="critical">{row.failedCount}</span> : row.failedCount}</td>
                    <td className="muted">{row.totalRows}</td>
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
