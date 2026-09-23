'use client';

import { useCallback, useEffect, useState } from 'react';
import { getProviderBalances } from '../../lib/endpoints';
import type { ProviderBalance } from '../../lib/types';
import { ApiRequestError } from '../../lib/admin-api';
import { usd } from '../../lib/money';

/**
 * «Балансы» — сколько у нас ОСТАЛОСЬ (TODO §III п.36).
 *
 * Соседний экран «Расходы» отвечает на другой вопрос — сколько
 * потрачено. Разница не академическая: кончившийся баланс у одного
 * провайдера это не строка в отчёте, а вставший продукт, и до этого
 * экрана он узнавался по ошибке генерации у живого пользователя.
 *
 * Состояний четыре, и это главное в устройстве. «Остаток неизвестен»
 * был бы бесполезным ответом: в нём слиты «провайдер остатка не отдаёт
 * вовсе» (действий не требует никогда), «у нас не заданы ключи»
 * (разовая настройка) и «спросили, но не вышло» (разбираться сейчас).
 * Поэтому у каждой строки есть состояние и пояснение, что делать.
 */

const STATE_LABEL: Record<ProviderBalance['state'], string> = {
  ok: 'остаток прочитан',
  'not-configured': 'не настроено',
  unsupported: 'остаток не отдаёт',
  error: 'не удалось спросить',
};

const STATE_COLOR: Record<ProviderBalance['state'], string> = {
  ok: 'var(--signal-ok)',
  'not-configured': 'var(--signal-warning)',
  unsupported: 'var(--muted)',
  error: 'var(--signal-critical)',
};

export default function BalancesPage() {
  const [items, setItems] = useState<ProviderBalance[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback((refresh = false) => {
    setBusy(true);
    setError(null);
    getProviderBalances(refresh)
      .then((r) => setItems(r.items))
      .catch((err) =>
        setError(
          err instanceof ApiRequestError
            ? err.message
            : 'Не удалось загрузить балансы',
        ),
      )
      .finally(() => setBusy(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="page">
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Балансы провайдеров</h1>
      <p className="muted" style={{ marginBottom: 16 }}>
        Сколько осталось, а не сколько потрачено (это на вкладке
        «Расходы»). Ответы кешируются на несколько минут: ограничение
        частоты запросов у провайдера своё, и довести до него легко.
      </p>

      <div style={{ marginBottom: 16 }}>
        <button type="button" disabled={busy} onClick={() => load(true)}>
          {busy ? 'Спрашиваю…' : 'Обновить'}
        </button>
      </div>

      {error && (
        <p style={{ color: 'var(--signal-critical)' }}>{error}</p>
      )}
      {!items && !error && <p className="muted">Загрузка…</p>}

      {items && (
        <table className="table">
          <thead>
            <tr>
              <th>Провайдер</th>
              <th>Остаток</th>
              <th>Состояние</th>
              <th>Что это значит</th>
            </tr>
          </thead>
          <tbody>
            {items.map((row) => (
              <tr key={row.provider}>
                <td>
                  <strong>{row.provider}</strong>
                </td>
                <td>
                  {row.amountMicroUsd !== undefined
                    ? usd(row.amountMicroUsd)
                    : '—'}
                  {/* Сырое значение рядом намеренно: единица в
                      документации xAI не объявлена, и первый живой
                      ответ должен снять этот вопрос, а не спрятать
                      ошибку в сто раз. */}
                  {row.raw !== undefined && (
                    <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
                      (ответ провайдера: {row.raw})
                    </span>
                  )}
                </td>
                <td style={{ color: STATE_COLOR[row.state] }}>
                  {STATE_LABEL[row.state]}
                </td>
                <td className="muted" style={{ fontSize: 13 }}>
                  {row.detail ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
