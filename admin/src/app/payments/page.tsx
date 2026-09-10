'use client';

// Платежи — ТЗ §41 (этап 62). Список покупок (подписки Standard/Premium
// и пакеты кредитов) через Telegram Stars и WayForPay, с единственным
// действием «Возврат»: у Stars это настоящий вызов API
// (refundStarPayment), у WayForPay — только пометка REFUNDED (деньги
// оператор возвращает вручную в личном кабинете WayForPay — см.
// AdminBillingService.refund на бэкенде, автоматизированного API там нет).

import { useCallback, useEffect, useRef, useState } from 'react';
import { listPayments, refundPayment } from '../../lib/endpoints';
import type {
  AdminPaymentListResult,
  AdminPaymentRow,
  PaymentMethod,
  PaymentStatus,
} from '../../lib/types';
import { ApiRequestError } from '../../lib/admin-api';

const STATUS_LABEL: Record<PaymentStatus, string> = {
  PENDING: 'ждёт оплаты',
  SUCCEEDED: 'оплачено',
  FAILED: 'ошибка',
  REFUNDED: 'возвращено',
};
const STATUS_TONE: Record<PaymentStatus, 'ok' | 'warning' | 'critical'> = {
  PENDING: 'warning',
  SUCCEEDED: 'ok',
  FAILED: 'critical',
  REFUNDED: 'warning',
};
const METHOD_LABEL: Record<PaymentMethod, string> = {
  STARS: 'Telegram Stars',
  WAYFORPAY: 'WayForPay',
};

function errText(e: unknown): string {
  return e instanceof ApiRequestError ? e.message : 'Не удалось выполнить запрос';
}

/** XTR (Stars) — целые звёзды, без минорных единиц. Минорные единицы
 * WayForPay (копейки/центы) переводятся в целую валюту для читаемости —
 * точная разрядность в ответе бэкенда не передаётся, поэтому /100 —
 * приближение, годное для карточки платежа, не для бухгалтерии. */
function amountLabel(row: AdminPaymentRow): string {
  if (row.method === 'STARS') return `${row.amount} ⭐`;
  return `${(row.amount / 100).toFixed(2)} ${row.currency}`;
}

function purposeLabel(row: AdminPaymentRow): string {
  if (row.purpose === 'SUBSCRIPTION') return row.plan ? `Подписка ${row.plan}` : 'Подписка';
  return row.creditsGranted != null ? `Пакет: ${row.creditsGranted} кредитов` : 'Пакет кредитов';
}

export default function PaymentsPage() {
  const [status, setStatus] = useState('');
  const [method, setMethod] = useState('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<AdminPaymentListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const loadGen = useRef(0);
  const load = useCallback(() => {
    const gen = ++loadGen.current;
    setError(null);
    listPayments({ status: status || undefined, method: method || undefined, page, pageSize: 20 })
      .then((r) => {
        if (gen === loadGen.current) setResult(r);
      })
      .catch((e) => {
        if (gen === loadGen.current) setError(errText(e));
      });
  }, [status, method, page]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleRefund(row: AdminPaymentRow) {
    const confirmText =
      row.method === 'STARS'
        ? `Вернуть ${amountLabel(row)} через Telegram? Деньги спишутся с бота обратно пользователю.`
        : `Пометить платёж возвращённым? Сами деньги нужно вернуть вручную в личном кабинете WayForPay — эта кнопка только фиксирует статус у нас.`;
    if (!window.confirm(confirmText)) return;
    setBusy(row.id);
    setError(null);
    try {
      const updated = await refundPayment(row.id);
      setResult((r) => (r ? { ...r, items: r.items.map((x) => (x.id === updated.id ? updated : x)) } : r));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  }

  const totalPages = result ? Math.max(Math.ceil(result.total / result.pageSize), 1) : 1;

  return (
    <div className="page">
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Оплата</h1>
      <p className="muted" style={{ marginBottom: 16 }}>
        Покупки подписок (Standard/Premium) и пакетов кредитов через Telegram Stars и WayForPay.
        Автопродление подписок и возврат просроченных в Lite делает крон (GET /api/cron/billing-renew) —
        здесь только история платежей и возврат средств.
      </p>

      <div className="filters" style={{ marginBottom: 16, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <select
          aria-label="Фильтр по статусу"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="">Все статусы</option>
          {(Object.keys(STATUS_LABEL) as PaymentStatus[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <select
          aria-label="Фильтр по способу оплаты"
          value={method}
          onChange={(e) => {
            setMethod(e.target.value);
            setPage(1);
          }}
        >
          <option value="">Любой способ</option>
          {(Object.keys(METHOD_LABEL) as PaymentMethod[]).map((m) => (
            <option key={m} value={m}>
              {METHOD_LABEL[m]}
            </option>
          ))}
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

      {result && result.items.length === 0 && <p className="muted">Платежей нет.</p>}

      {result && result.items.length > 0 && (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Пользователь</th>
                  <th>Что куплено</th>
                  <th>Способ</th>
                  <th>Сумма</th>
                  <th>Статус</th>
                  <th>Создан</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((row) => (
                  <tr key={row.id}>
                    <td>{row.telegramId}</td>
                    <td>{purposeLabel(row)}</td>
                    <td>{METHOD_LABEL[row.method]}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{amountLabel(row)}</td>
                    <td>
                      <span className={`badge-status badge-status-${STATUS_TONE[row.status]}`}>
                        {STATUS_LABEL[row.status]}
                      </span>
                      {row.status === 'FAILED' && row.failureReason && (
                        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                          {row.failureReason}
                        </div>
                      )}
                    </td>
                    <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                      {new Date(row.createdAt).toLocaleString('ru-RU')}
                    </td>
                    <td>
                      {row.status === 'SUCCEEDED' && (
                        <button type="button" onClick={() => void handleRefund(row)} disabled={busy !== null}>
                          {busy === row.id ? '…' : 'Возврат'}
                        </button>
                      )}
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
