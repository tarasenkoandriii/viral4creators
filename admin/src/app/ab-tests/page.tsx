'use client';

// A/B-варианты одного ролика — из одного уже одобренного ролика
// собираются 3 дубля, отличающихся только хуком и CTA (TODO §III.6,
// этап 66). Read-only: обработка идёт кроном (GET /api/cron/ab-test-run,
// см. AbTestWorkerService на бэкенде), оператору здесь нечего нажимать —
// только история запусков и сводка по статусам.

import { useCallback, useEffect, useRef, useState } from 'react';
import { listAbTests } from '../../lib/endpoints';
import type { AdminAbTestListResult } from '../../lib/types';
import { ApiRequestError } from '../../lib/admin-api';

function errText(e: unknown): string {
  return e instanceof ApiRequestError ? e.message : 'Не удалось выполнить запрос';
}

export default function AbTestsPage() {
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<AdminAbTestListResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadGen = useRef(0);
  const load = useCallback(() => {
    const gen = ++loadGen.current;
    setError(null);
    listAbTests({ page, pageSize: 20 })
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
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>A/B-варианты</h1>
      <p className="muted" style={{ marginBottom: 16 }}>
        Из одной уже одобренной сессии (разбор + промпт + готовый ролик) собираются 3
        дополнительных дубля, отличающихся только хуком и CTA — доступно только на Premium.
        Хук/CTA для всех трёх пишет один вызов GPT-5 при создании запуска, а старт рендеров идёт
        кроном по одному варианту за раз: создание сессии, перенос разбора, посев уже готового
        текста (без второго обращения к GPT-5), одобрение, старт рендера. Здесь только история
        запусков и сводка по статусам, вмешиваться оператору нечем.
      </p>

      {error && (
        <p className="critical">
          {error}{' '}
          <button type="button" onClick={load}>
            Повторить
          </button>
        </p>
      )}

      {result && result.items.length === 0 && <p className="muted">Запусков ещё не было.</p>}

      {result && result.items.length > 0 && (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Запущен</th>
                  <th>Проект</th>
                  <th>Пользователь</th>
                  <th>Исходная сессия</th>
                  <th>В очереди</th>
                  <th>Генерируется</th>
                  <th>Готово</th>
                  <th>Ошибок</th>
                  <th>Всего вариантов</th>
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
                    <td className="muted" style={{ fontFamily: 'monospace', fontSize: 12 }}>
                      {row.sourceSessionId}
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
