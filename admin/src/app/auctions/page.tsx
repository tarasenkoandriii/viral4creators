'use client';

// Модерация аукциона (ТЗ на маркетплейс §22). Реальный, самый крупный из
// оставшихся пробелов: backend (AdminAuctionController — список/approve/
// reject/confirm-payment) существует с Этапа 2, но ни одной страницы под
// него не было — оператору было физически нечем одобрить или отклонить
// заявку, кроме прямых запросов к API. Тот же паттерн, что у
// portfolio-items/page.tsx: фильтр по статусу + таблица + одобрить/
// отклонить с причиной. Отличия: три действия вместо двух (approve/
// reject/confirm-payment — последнее запасной ручной путь, основной —
// self-serve чек-аут покупателя, применяемый вебхуком WayForPay самим),
// плюс поля, которых у портфолио нет — валюта выплаты, подтверждение
// прав (§22.6), ИИ-оценка видео и брендбука (§22, Этап 3).

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  approveAuctionListing,
  assignAuctionVirtualStudio,
  confirmAuctionPayment,
  listAuctionListings,
  listVirtualStudios,
  rejectAuctionListing,
} from '../../lib/endpoints';
import type { AdminAuctionListing, AdminAuctionListingStatus, AdminAuctionListResult, VirtualStudio } from '../../lib/types';
import { ApiRequestError } from '../../lib/admin-api';

const STATUS_LABEL: Record<AdminAuctionListingStatus, string> = {
  PENDING_MODERATION: 'ждёт решения',
  QUEUED: 'одобрен, ждёт места',
  ACTIVE: 'активен на витрине',
  WON: 'выигран',
  EXPIRED: 'завершён без продажи',
  REJECTED: 'отклонён',
  WITHDRAWN: 'отозван исполнителем',
};
const STATUS_TONE: Record<AdminAuctionListingStatus, 'ok' | 'warning' | 'critical'> = {
  PENDING_MODERATION: 'warning',
  QUEUED: 'warning',
  ACTIVE: 'ok',
  WON: 'ok',
  EXPIRED: 'critical',
  REJECTED: 'critical',
  WITHDRAWN: 'critical',
};

const MARKETPLACE_URL = process.env.NEXT_PUBLIC_MARKETPLACE_URL ?? 'http://localhost:3004';

function errText(e: unknown): string {
  return e instanceof ApiRequestError ? e.message : 'Не удалось выполнить запрос';
}

export default function AuctionsPage() {
  const [status, setStatus] = useState<string>('PENDING_MODERATION');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<AdminAuctionListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  // Живой аукцион (§7.8, ПРАВКА 1.4) — READY-студии для выпадающего
  // списка назначения; загружаются один раз, не привязаны к пагинации
  // самой очереди заявок. `assigningStudioFor`/`selectedStudioId` —
  // одиночные (не по ключу на строку) состояния, тот же приём, что уже
  // применён к `rejecting`/`reason` выше: назначать студию можно только
  // одному лоту за раз.
  const [studios, setStudios] = useState<VirtualStudio[]>([]);
  const [studiosError, setStudiosError] = useState<string | null>(null);
  const [assigningStudioFor, setAssigningStudioFor] = useState<string | null>(null);
  const [selectedStudioId, setSelectedStudioId] = useState('');

  useEffect(() => {
    listVirtualStudios()
      .then((list) => setStudios(list.filter((s) => s.status === 'READY')))
      .catch((e) => setStudiosError(errText(e)));
  }, []);

  const loadGen = useRef(0);
  const load = useCallback(() => {
    const gen = ++loadGen.current;
    setError(null);
    listAuctionListings({ status: status || undefined, page, pageSize: 20 })
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

  const replace = (item: AdminAuctionListing) =>
    setResult((r) => (r ? { ...r, items: r.items.map((x) => (x.id === item.id ? item : x)) } : r));

  async function handleApprove(item: AdminAuctionListing) {
    if (!confirm(`Одобрить заявку на «${item.portfolioItemTitle}»? Она встанет в очередь на свободное место на витрине.`)) return;
    setBusy(item.id);
    setError(null);
    try {
      const updated = await approveAuctionListing(item.id);
      replace(updated);
      load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  }

  async function handleReject(item: AdminAuctionListing) {
    if (reason.trim().length < 1) return;
    setBusy(item.id);
    setError(null);
    try {
      const updated = await rejectAuctionListing(item.id, reason.trim());
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

  async function handleConfirmPayment(item: AdminAuctionListing) {
    if (
      !confirm(
        `Подтвердить оплату лота «${item.portfolioItemTitle}» вручную? Основной путь — покупатель платит сам через чек-аут, это только запасной вариант (например, оплата пришла вне self-serve).`,
      )
    )
      return;
    setBusy(item.id);
    setError(null);
    try {
      const updated = await confirmAuctionPayment(item.id);
      replace(updated);
      load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  }

  /**
   * Живой аукцион (§7.8) — `videoFragmentId` не передаём (см.
   * доккомментарий assignAuctionVirtualStudio): бэкенд сам берёт
   * последний готовый VIDEO-фрагмент выбранной студии. Работает и для
   * первого назначения, и для переназначения (бэкенд идемпотентно
   * перезаписывает `virtualStudioId` в обоих случаях).
   */
  async function handleAssignStudio(item: AdminAuctionListing) {
    if (!selectedStudioId) return;
    setBusy(item.id);
    setError(null);
    try {
      const updated = await assignAuctionVirtualStudio(item.id, selectedStudioId);
      replace(updated);
      setAssigningStudioFor(null);
      setSelectedStudioId('');
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  }

  const totalPages = result ? Math.max(Math.ceil(result.total / result.pageSize), 1) : 1;

  return (
    <div className="page">
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Модерация аукциона</h1>
      <p className="muted" style={{ marginBottom: 16 }}>
        Исполнитель ставит в очередь заявку на аукцион (§22) — «Одобрить» переводит её в очередь на свободное
        место на витрине (не сразу на витрину — мест всего 5 на весь сайт, 3 из них с брендбуком). «Отклонить»
        не удаляет заявку — исполнитель видит причину у себя в «Мои заявки на аукцион». «Подтвердить оплату» —
        запасной ручной путь для уже выигранных лотов, основной путь — покупатель платит сам, и вебхук
        WayForPay применяет оплату без участия оператора.
      </p>

      <div className="filters" style={{ marginBottom: 16, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <select
          aria-label="Фильтр по статусу заявки"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="">Все статусы</option>
          {(Object.keys(STATUS_LABEL) as AdminAuctionListingStatus[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
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

      {studiosError && (
        <p className="muted" style={{ fontSize: 12 }}>
          Не удалось загрузить список студий для назначения эфира: {studiosError}
        </p>
      )}

      {result && result.items.length === 0 && <p className="muted">Заявок нет.</p>}

      {result && result.items.length > 0 && (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Заявка</th>
                  <th>Цена</th>
                  <th>Ставки</th>
                  <th>Статус</th>
                  <th>Создана</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((item) => (
                  <tr key={item.id}>
                    <td style={{ maxWidth: 380 }}>
                      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                        <video
                          src={item.portfolioItemVideoUrl}
                          controls
                          preload="metadata"
                          style={{ width: 90, aspectRatio: '9 / 16', borderRadius: 6, background: '#000', flex: '0 0 auto' }}
                        />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 600 }}>{item.portfolioItemTitle}</div>
                          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                            <a href={`${MARKETPLACE_URL}/creator/${item.creatorProfileId}`} target="_blank" rel="noreferrer">
                              {item.creatorDisplayName ?? 'профиль исполнителя'}
                            </a>
                            {' · '}
                            {item.auctionType === 'BLITZ' ? '🔥 блиц' : 'стандарт'}
                            {item.includeBrandManifest ? ' · с брендбуком (эксклюзив)' : ''}
                          </div>
                          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                            Права подтверждены: {new Date(item.rightsConfirmedAt).toLocaleString('ru-RU')}
                          </div>
                          {item.aiAssessment && (
                            <div style={{ fontSize: 12, marginTop: 4 }}>
                              <strong>ИИ по видео:</strong> {item.aiAssessment}
                            </div>
                          )}
                          {item.brandManifestAiAudit && (
                            <div style={{ fontSize: 12, marginTop: 4 }}>
                              <strong>ИИ по брендбуку:</strong> {item.brandManifestAiAudit}
                            </div>
                          )}
                          {item.status === 'ACTIVE' && (
                            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                              <a href={`${MARKETPLACE_URL}/auctions/${item.id}`} target="_blank" rel="noreferrer">
                                открыть на витрине
                              </a>
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
                    <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                      {item.startingPrice} {item.payoutCurrency}
                      {item.reservePrice != null && (
                        <div style={{ fontSize: 11 }}>резерв: {item.reservePrice}</div>
                      )}
                      {item.buyNowPrice != null && (
                        <div style={{ fontSize: 11 }}>купить сразу: {item.buyNowPrice}</div>
                      )}
                      {item.currentPriceUahEquivalent != null && (
                        <div style={{ fontSize: 11 }} title="Информационная оценка по статичному курсу — не сумма сделки">
                          ≈ {item.currentPriceUahEquivalent.toFixed(0)} UAH
                        </div>
                      )}
                    </td>
                    <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                      {item.bidCount > 0 ? `${item.bidCount} (лучшая: ${item.highestBidAmount})` : 'нет'}
                    </td>
                    <td>
                      <span className={`badge-status badge-status-${STATUS_TONE[item.status]}`}>{STATUS_LABEL[item.status]}</span>
                    </td>
                    <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                      {new Date(item.createdAt).toLocaleString('ru-RU')}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {item.status === 'PENDING_MODERATION' && rejecting !== item.id && (
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
                      {item.status === 'PENDING_MODERATION' && rejecting === item.id && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 220 }}>
                          <textarea
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                            rows={3}
                            placeholder="Причина отклонения — увидит исполнитель"
                            style={{ fontSize: 12 }}
                          />
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button type="button" onClick={() => void handleReject(item)} disabled={busy !== null || reason.trim().length < 1}>
                              {busy === item.id ? '…' : 'Подтвердить отказ'}
                            </button>
                            <button type="button" onClick={() => setRejecting(null)} disabled={busy !== null}>
                              Отмена
                            </button>
                          </div>
                        </div>
                      )}
                      {item.status === 'WON' && (
                        <button type="button" onClick={() => void handleConfirmPayment(item)} disabled={busy !== null}>
                          {busy === item.id ? '…' : 'Подтвердить оплату вручную'}
                        </button>
                      )}
                      {item.auctionType === 'BLITZ' && (item.status === 'QUEUED' || item.status === 'ACTIVE') && (
                        <div style={{ marginTop: 8, minWidth: 200 }}>
                          {!item.liveStreamOptIn ? (
                            <p className="muted" style={{ fontSize: 11, margin: 0 }}>
                              Живой эфир: продавец не согласился (чекбокс при подаче заявки, §7.8)
                            </p>
                          ) : item.virtualStudioId && assigningStudioFor !== item.id ? (
                            <div style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
                              <div>
                                Студия: {studios.find((s) => s.id === item.virtualStudioId)?.name ?? item.virtualStudioId}
                              </div>
                              <div className={item.liveStreamActive ? undefined : 'muted'}>
                                {item.liveStreamActive ? '🔴 в эфире' : 'эфир не активен'}
                              </div>
                              <button
                                type="button"
                                onClick={() => {
                                  setAssigningStudioFor(item.id);
                                  setSelectedStudioId(item.virtualStudioId ?? '');
                                }}
                                disabled={busy !== null}
                              >
                                Переназначить студию
                              </button>
                            </div>
                          ) : assigningStudioFor === item.id ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                              <select
                                aria-label="Студия для эфира"
                                value={selectedStudioId}
                                onChange={(e) => setSelectedStudioId(e.target.value)}
                              >
                                <option value="">Выберите студию…</option>
                                {studios.map((s) => (
                                  <option key={s.id} value={s.id}>
                                    {s.name}
                                  </option>
                                ))}
                              </select>
                              <div style={{ display: 'flex', gap: 6 }}>
                                <button
                                  type="button"
                                  onClick={() => void handleAssignStudio(item)}
                                  disabled={busy !== null || !selectedStudioId}
                                >
                                  {busy === item.id ? '…' : 'Назначить'}
                                </button>
                                <button type="button" onClick={() => setAssigningStudioFor(null)} disabled={busy !== null}>
                                  Отмена
                                </button>
                              </div>
                              {studios.length === 0 && (
                                <p className="muted" style={{ fontSize: 11, margin: 0 }}>
                                  Нет готовых студий (статус READY) — подготовьте студию на вкладке «Виртуальная студия».
                                </p>
                              )}
                            </div>
                          ) : (
                            <button type="button" onClick={() => setAssigningStudioFor(item.id)} disabled={busy !== null}>
                              Назначить студию эфира
                            </button>
                          )}
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
