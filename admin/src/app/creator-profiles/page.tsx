'use client';

// Витрина маркетплейса — Featured-бейдж (ТЗ на маркетплейс §20 №19,
// backend/src/modules/creator-profile). Тот же паттерн, что у
// shared-videos/page.tsx: список + фильтр + постраничная навигация,
// но без модерации approve/reject — здесь единственное действие
// оператора — включить/выключить редакционный бейдж. Он не платный
// (в отличие от буст-функционала §13/§14 общего ТЗ) — это только
// выбор оператора, кого поднять в каталоге (сортировка `isFeatured desc`
// на бэкенде).

import { useCallback, useEffect, useRef, useState } from 'react';
import { listCreatorProfiles, setCreatorProfileFeatured } from '../../lib/endpoints';
import type { AdminCreatorProfile, AdminCreatorProfileListResult } from '../../lib/types';
import { ApiRequestError } from '../../lib/admin-api';

const MARKETPLACE_URL = process.env.NEXT_PUBLIC_MARKETPLACE_URL ?? 'http://localhost:3004';

function errText(e: unknown): string {
  return e instanceof ApiRequestError ? e.message : 'Не удалось выполнить запрос';
}

export default function CreatorProfilesPage() {
  const [filter, setFilter] = useState<'' | 'true' | 'false'>('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<AdminCreatorProfileListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const loadGen = useRef(0);
  const load = useCallback(() => {
    const gen = ++loadGen.current;
    setError(null);
    listCreatorProfiles({
      isFeatured: filter === '' ? undefined : filter === 'true',
      page,
      pageSize: 20,
    })
      .then((r) => {
        if (gen === loadGen.current) setResult(r);
      })
      .catch((e) => {
        if (gen === loadGen.current) setError(errText(e));
      });
  }, [filter, page]);

  useEffect(() => {
    load();
  }, [load]);

  const replace = (item: AdminCreatorProfile) =>
    setResult((r) => (r ? { ...r, items: r.items.map((x) => (x.id === item.id ? item : x)) } : r));

  async function handleToggle(item: AdminCreatorProfile) {
    setBusy(item.id);
    setError(null);
    try {
      const updated = await setCreatorProfileFeatured(item.id, !item.isFeatured);
      replace({ ...item, isFeatured: updated.isFeatured });
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  }

  const totalPages = result ? Math.max(Math.ceil(result.total / result.pageSize), 1) : 1;

  return (
    <div className="page">
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Маркетплейс: исполнители</h1>
      <p className="muted" style={{ marginBottom: 16 }}>
        Featured — редакционный выбор оператора, не платное продвижение: такие профили сортируются
        первыми в публичном каталоге (/creators на маркетплейсе). Ничего, кроме этого флага, здесь не
        меняется — квиз, ниши и портфолио редактирует сам исполнитель.
      </p>

      <div className="filters" style={{ marginBottom: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
        <select
          aria-label="Фильтр по Featured"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value as '' | 'true' | 'false');
            setPage(1);
          }}
        >
          <option value="">Все профили</option>
          <option value="true">Только Featured</option>
          <option value="false">Без бейджа</option>
        </select>
      </div>

      {error && (
        <p className="critical">
          {error}{' '}
          <button type="button" onClick={load}>
            Повторить
          </button>
        </p>
      )}

      {result && result.items.length === 0 && <p className="muted">Профилей нет.</p>}

      {result && result.items.length > 0 && (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Исполнитель</th>
                  <th>Ниши</th>
                  <th>Портфолио</th>
                  <th>Просмотры</th>
                  <th>Приём заказов</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{item.displayName ?? item.userId.slice(0, 8) + '…'}</div>
                      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                        <a
                          href={`${MARKETPLACE_URL}/creator/${item.slug ?? item.id}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          открыть профиль
                        </a>
                      </div>
                    </td>
                    <td>{item.niches.join(', ') || '—'}</td>
                    <td>{item.portfolioItemCount}</td>
                    <td>{item.viewCount}</td>
                    <td>
                      {item.isAcceptingOrders ? (
                        <span className="badge-status badge-status-ok">принимает</span>
                      ) : (
                        <span className="badge-status badge-status-warning">пауза</span>
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        disabled={busy === item.id}
                        onClick={() => void handleToggle(item)}
                        aria-pressed={item.isFeatured}
                      >
                        {item.isFeatured ? '★ Убрать Featured' : '☆ Сделать Featured'}
                      </button>
                    </td>
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
