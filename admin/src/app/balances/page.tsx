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

/**
 * Остаток в единицах провайдера (этап 142). В доллары не переводится
 * намеренно: цена символа зависит от тарифа и меняется без нашего
 * участия, и посчитанная нами сумма разошлась бы со счётом провайдера
 * без всякого способа это заметить.
 */
function units(u: NonNullable<ProviderBalance['units']>): string {
  const n = (value: number) => value.toLocaleString('ru-RU');
  // Перебор — не «осталось минус сто»: у тарифов с overage лимит можно
  // перебрать, и правда здесь «уже должны», а не «почти пусто».
  if (u.left < 0) return `перебор на ${n(-u.left)} ${u.label}`;
  return u.total === undefined
    ? `${n(u.left)} ${u.label}`
    : `${n(u.left)} ${u.label} из ${n(u.total)}`;
}

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
      <p className="muted" style={{ marginBottom: 16, fontSize: 13 }}>
        С консолью провайдера до цента сходиться не обязано: там остаток
        на момент своего запроса, списания доезжают в журнал с
        задержкой, а автопополнение поднимает баланс скачком. Расходится
        на порядок или знаком — вот это повод разбираться.
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
                    : row.units
                      ? units(row.units)
                      : '—'}
                  {/* Дата сброса — часть ответа на «хватит ли»: сто
                      тысяч символов до завтра и до конца месяца это
                      разные новости. */}
                  {row.units?.resetsAt && (
                    <div className="muted" style={{ fontSize: 12 }}>
                      обнулится{' '}
                      {new Date(row.units.resetsAt).toLocaleDateString('ru-RU')}
                    </div>
                  )}
                  {/* Сырое значение рядом намеренно. У xAI остаток
                      приходит как сальдо журнала в центах с обратным
                      знаком: «−1827» — это $18.27. Человек, который
                      сверяет экран с консолью провайдера, должен
                      видеть оба числа, иначе расхождение читается как
                      поломка разбора. */}
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
                  {/* Ссылка в КОНЦЕ строки, по запросу владельца: наше
                      число у GROK расходится с консолью, и пока это не
                      разобрано, экран обязан давать дорогу к
                      первоисточнику, а не только своё значение. У
                      провайдеров без API остатка она тем более нужна:
                      «смотрите в кабинете» без адреса — половина
                      ответа. */}
                  {row.dashboardUrl && (
                    <>
                      {' · '}
                      <a
                        href={row.dashboardUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        консоль провайдера ↗
                      </a>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Сырой ответ — теперь только когда разобрать не вышло. Пока
          поле не было опознано, тело показывалось всегда, и это и был
          способ его опознать; сейчас повод исчерпан, а в `changes`
          лежат номера счетов, которым на экране делать нечего. */}
      {items?.some((row) => row.rawBody) && (
        <details style={{ marginTop: 24 }}>
          <summary className="muted" style={{ cursor: 'pointer' }}>
            Неразобранные ответы провайдеров
          </summary>
          {items
            .filter((row) => row.rawBody)
            .map((row) => (
              <div key={row.provider} style={{ marginTop: 12 }}>
                <strong>{row.provider}</strong>
                <pre
                  style={{
                    background: 'var(--card)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    padding: 12,
                    overflowX: 'auto',
                    fontSize: 12,
                  }}
                >
                  {row.rawBody}
                </pre>
              </div>
            ))}
        </details>
      )}
    </div>
  );
}
