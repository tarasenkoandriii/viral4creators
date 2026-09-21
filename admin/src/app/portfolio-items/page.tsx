'use client';

// Модерация портфолио маркетплейса (ТЗ на маркетплейс §9, §11; ТЗ на
// бэкенд §6). Аудит-фикс: backend GET/approve/reject/broadcast-top-of-week
// существовали с самого начала реализации Этапа 0, но ни одного экрана
// под них не было — весь self-upload флоу заканчивался в очереди PENDING
// без единого способа её разобрать через интерфейс. Тот же паттерн, что
// у shared-videos/page.tsx: фильтр по статусу + таблица + одобрить/
// отклонить с причиной. Отличия: нет привязки к сессии/товару (это
// самостоятельная работа исполнителя, не сгенерированный ролик), зато
// есть кнопка еженедельной подборки в Telegram-канал (§20 №8) — она была
// вызываемой только напрямую через API, теперь оператор может нажать её.

import { useCallback, useEffect, useRef, useState } from 'react';
import { approvePortfolioItem, broadcastTopOfWeek, listPortfolioItems, rejectPortfolioItem } from '../../lib/endpoints';
import type { AdminPortfolioItem, AdminPortfolioItemStatus, AdminPortfolioListResult } from '../../lib/types';
import { ApiRequestError } from '../../lib/admin-api';

const STATUS_LABEL: Record<AdminPortfolioItemStatus, string> = {
  PENDING: 'ждёт решения',
  PUBLISHED: 'опубликовано',
  REJECTED: 'отклонено',
  SOLD: 'продано на аукционе',
};
const STATUS_TONE: Record<AdminPortfolioItemStatus, 'ok' | 'warning' | 'critical'> = {
  PENDING: 'warning',
  PUBLISHED: 'ok',
  REJECTED: 'critical',
  SOLD: 'ok',
};

const MARKETPLACE_URL = process.env.NEXT_PUBLIC_MARKETPLACE_URL ?? 'http://localhost:3004';

function errText(e: unknown): string {
  return e instanceof ApiRequestError ? e.message : 'Не удалось выполнить запрос';
}

export default function PortfolioItemsPage() {
  const [status, setStatus] = useState<string>('PENDING');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<AdminPortfolioListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [broadcasting, setBroadcasting] = useState(false);
  const [broadcastResult, setBroadcastResult] = useState<string | null>(null);

  const loadGen = useRef(0);
  const load = useCallback(() => {
    const gen = ++loadGen.current;
    setError(null);
    listPortfolioItems({ status: status || undefined, page, pageSize: 20 })
      .then((r) => {
        if (gen === loadGen.current) setResult(r);
      })
      .catch((e) => {
        if (gen === loadGen.current) setError(errText(e));
      });
  }, [status, page]);

  useEffect(() => {
    load();
  }, [load]);

  const replace = (item: AdminPortfolioItem) =>
    setResult((r) => (r ? { ...r, items: r.items.map((x) => (x.id === item.id ? item : x)) } : r));

  async function handleApprove(item: AdminPortfolioItem) {
    if (!confirm(`Опубликовать работу «${item.title}»? Она сразу станет видна всем в каталоге.`)) return;
    setBusy(item.id);
    setError(null);
    try {
      const updated = await approvePortfolioItem(item.id);
      replace(updated);
      load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  }

  async function handleReject(item: AdminPortfolioItem) {
    if (reason.trim().length < 3) return;
    setBusy(item.id);
    setError(null);
    try {
      const updated = await rejectPortfolioItem(item.id, reason.trim());
      replace(updated);
      setRejecting(null);
      setReason('');
      load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  }

  async function handleBroadcast() {
    if (!confirm('Отправить подборку лучших работ недели в Telegram-канал маркетплейса?')) return;
    setBroadcasting(true);
    setBroadcastResult(null);
    try {
      const r = await broadcastTopOfWeek();
      setBroadcastResult(
        r.sent
          ? `Отправлено, работ в подборке: ${r.count}`
          : r.count === 0
            ? 'Не отправлено — за последние 7 дней нет опубликованных работ.'
            : 'Не отправлено — проверьте TELEGRAM_MARKETPLACE_CHANNEL_ID в .env бэкенда.',
      );
    } catch (e) {
      setBroadcastResult(errText(e));
    } finally {
      setBroadcasting(false);
    }
  }

  const totalPages = result ? Math.max(Math.ceil(result.total / result.pageSize), 1) : 1;

  return (
    <div className="page">
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Модерация портфолио маркетплейса</h1>
      <p className="muted" style={{ marginBottom: 16 }}>
        Исполнитель сам загружает работу через сайт (§9) — «Одобрить» сразу публикует её в каталоге и на
        странице профиля. «Отклонить» не удаляет работу навсегда — исполнитель видит причину у себя в
        «Моё портфолио» и может отозвать её сам.
      </p>

      <div className="filters" style={{ marginBottom: 16, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <select
          aria-label="Фильтр по статусу работы"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="">Все статусы</option>
          {(Object.keys(STATUS_LABEL) as AdminPortfolioItemStatus[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>

        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <button type="button" onClick={() => void handleBroadcast()} disabled={broadcasting}>
            {broadcasting ? '…' : 'Отправить подборку недели в Telegram-канал'}
          </button>
          {broadcastResult && <span className="muted" style={{ fontSize: 12 }}>{broadcastResult}</span>}
        </span>
      </div>

      {error && (
        <p className="critical">
          {error}{' '}
          <button type="button" onClick={load}>
            Повторить
          </button>
        </p>
      )}

      {result && result.items.length === 0 && <p className="muted">Работ нет.</p>}

      {result && result.items.length > 0 && (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Работа</th>
                  <th>Подборка</th>
                  <th>Статус</th>
                  <th>Создана</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((item) => (
                  <tr key={item.id}>
                    <td style={{ maxWidth: 360 }}>
                      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                        <video
                          src={item.videoUrl}
                          controls
                          preload="metadata"
                          poster={item.thumbnailUrl ?? undefined}
                          style={{ width: 90, aspectRatio: '9 / 16', borderRadius: 6, background: '#000', flex: '0 0 auto' }}
                        />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 600 }}>{item.title}</div>
                          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                            <a
                              href={`${MARKETPLACE_URL}/creator/${item.creatorProfileId}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              профиль исполнителя
                            </a>
                            {' · '}
                            <a href={item.videoUrl} target="_blank" rel="noreferrer">
                              скачать
                            </a>
                          </div>
                          {(item.watermarkStatus === 'FAILED' || item.watermarkStatus === 'PROCESSING') && (
                            <div
                              className="muted"
                              style={{
                                fontSize: 12,
                                marginTop: 4,
                                color: item.watermarkStatus === 'FAILED' ? 'var(--signal-critical)' : undefined,
                              }}
                            >
                              {item.watermarkStatus === 'FAILED'
                                ? 'Водяной знак не удалось нанести — на витрине показан оригинал'
                                : 'Водяной знак ещё наносится'}
                            </div>
                          )}
                          {item.status === 'PUBLISHED' && (
                            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                              <a href={`${MARKETPLACE_URL}/item/${item.id}`} target="_blank" rel="noreferrer">
                                открыть страницу
                              </a>
                              {' · просмотров: '}
                              {item.viewCount}
                              {' · лайков: '}
                              {item.likeCount}
                            </div>
                          )}
                          {item.status === 'REJECTED' && item.rejectionReason && (
                            <div style={{ fontSize: 12, marginTop: 4, color: 'var(--signal-critical)' }}>
                              Причина: {item.rejectionReason}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td>{item.collectionTag ? `#${item.collectionTag}` : '—'}</td>
                    <td>
                      <span className={`badge-status badge-status-${STATUS_TONE[item.status]}`}>{STATUS_LABEL[item.status]}</span>
                    </td>
                    <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                      {new Date(item.createdAt).toLocaleString('ru-RU')}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {item.status === 'PENDING' && rejecting !== item.id && (
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button type="button" onClick={() => void handleApprove(item)} disabled={busy !== null}>
                            {busy === item.id ? '…' : 'Одобрить'}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setRejecting(item.id);
                              setReason('');
                            }}
                            disabled={busy !== null}
                          >
                            Отклонить
                          </button>
                        </div>
                      )}
                      {item.status === 'PENDING' && rejecting === item.id && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 220 }}>
                          <textarea
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                            rows={3}
                            placeholder="Причина отклонения — увидит исполнитель"
                            style={{ fontSize: 12 }}
                          />
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button type="button" onClick={() => void handleReject(item)} disabled={busy !== null || reason.trim().length < 3}>
                              {busy === item.id ? '…' : 'Подтвердить отказ'}
                            </button>
                            <button type="button" onClick={() => setRejecting(null)} disabled={busy !== null}>
                              Отмена
                            </button>
                          </div>
                        </div>
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
