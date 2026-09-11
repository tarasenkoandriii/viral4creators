'use client';

// Очередь модерации публичных страниц ролика — ТЗ §40, этап 60. Тот же
// паттерн, что у публикаций (publications/page.tsx): оператор смотрит
// ролик и одобряет/отклоняет. Отличия от публикаций: нет платформы/тегов
// (страница одна, не под конкретную площадку), зато после одобрения
// страница СРАЗУ доступна публично на лендинге — есть ссылка «Открыть
// страницу» и счётчики просмотров/конверсий у PUBLISHED-строк. Отклонение
// не удаляет копию ролика (в отличие от публикаций) — автор может отозвать
// её сам в любом статусе, поэтому здесь нет отдельного «а что с файлом».

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { approveSharedVideo, listSharedVideos, rejectSharedVideo } from '../../lib/endpoints';
import type { SharedVideoListResult, SharedVideoPage, SharedVideoStatus } from '../../lib/types';
import { ApiRequestError } from '../../lib/admin-api';

const STATUS_LABEL: Record<SharedVideoStatus, string> = {
  PENDING: 'ждёт решения',
  PUBLISHED: 'опубликовано',
  REJECTED: 'отклонено',
};
const STATUS_TONE: Record<SharedVideoStatus, 'ok' | 'warning' | 'critical'> = {
  PENDING: 'warning',
  PUBLISHED: 'ok',
  REJECTED: 'critical',
};

const LANDING_URL = process.env.NEXT_PUBLIC_LANDING_URL ?? 'http://localhost:3003';

function errText(e: unknown): string {
  return e instanceof ApiRequestError ? e.message : 'Не удалось выполнить запрос';
}

export default function SharedVideosPage() {
  const [status, setStatus] = useState<string>('PENDING');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<SharedVideoListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const loadGen = useRef(0);
  const load = useCallback(() => {
    const gen = ++loadGen.current;
    setError(null);
    listSharedVideos({ status: status || undefined, page, pageSize: 20 })
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

  const replace = (item: SharedVideoPage) =>
    setResult((r) => (r ? { ...r, items: r.items.map((x) => (x.id === item.id ? item : x)) } : r));

  async function handleApprove(item: SharedVideoPage) {
    if (!confirm(`Опубликовать страницу «${item.title}»? Она сразу станет доступна всем по ссылке.`)) return;
    setBusy(item.id);
    setError(null);
    try {
      const updated = await approveSharedVideo(item.id);
      replace(updated);
      load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  }

  async function handleReject(item: SharedVideoPage) {
    if (reason.trim().length < 3) return;
    setBusy(item.id);
    setError(null);
    try {
      const updated = await rejectSharedVideo(item.id, reason.trim());
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

  const totalPages = result ? Math.max(Math.ceil(result.total / result.pageSize), 1) : 1;

  return (
    <div className="page">
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>
        Модерация публичных страниц
        {result && result.pending > 0 && (
          <span className="badge-status badge-status-warning" style={{ marginLeft: 10, verticalAlign: 'middle' }}>
            ждут: {result.pending}
          </span>
        )}
      </h1>
      <p className="muted" style={{ marginBottom: 16 }}>
        Кнопка «Сделать публичной» в TMA ставит страницу ролика сюда. «Одобрить» сразу публикует её на сайте —
        товар, цена и текст описания станут видны всем по ссылке. «Отклонить» не удаляет копию ролика — автор
        всё равно может отозвать заявку сам в любой момент.
      </p>

      <div className="filters" style={{ marginBottom: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
        <select
          aria-label="Фильтр по статусу заявки"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="">Все статусы</option>
          {(Object.keys(STATUS_LABEL) as SharedVideoStatus[]).map((s) => (
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

      {result && result.items.length === 0 && <p className="muted">Заявок нет.</p>}

      {result && result.items.length > 0 && (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Ролик</th>
                  <th>Товар</th>
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
                          style={{ width: 90, aspectRatio: '9 / 16', borderRadius: 6, background: '#000', flex: '0 0 auto' }}
                        />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 600 }}>{item.title}</div>
                          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                            <Link href={`/sessions/${item.sessionId}`}>сессия {item.sessionId.slice(0, 8)}…</Link>
                            {' · '}
                            <a href={item.videoUrl} target="_blank" rel="noreferrer">
                              скачать
                            </a>
                            {' · автор '}
                            {item.userId.slice(0, 8)}…
                          </div>
                          {item.status === 'PUBLISHED' && (
                            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                              <a href={`${LANDING_URL}/video/${item.id}`} target="_blank" rel="noreferrer">
                                открыть страницу
                              </a>
                              {' · просмотров: '}
                              {item.viewCount}
                              {' · дошли до генерации: '}
                              {item.firstGenerationCount}
                              {/* Этап 80 (TODO §III.9): лента внутри TMA — тот же счётчик,
                                  что и остальные, показывается рядом с уже существующими. */}
                              {' · лайков: '}
                              {item.likeCount}
                              {' · репостов: '}
                              {item.shareCount}
                            </div>
                          )}
                          {item.status === 'REJECTED' && item.rejectReason && (
                            <div style={{ fontSize: 12, marginTop: 4, color: 'var(--signal-critical)' }}>
                              Причина: {item.rejectReason}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td style={{ maxWidth: 200 }}>
                      <div>{item.productName}</div>
                      {item.price != null && (
                        <div className="muted" style={{ fontSize: 12 }}>
                          {item.price} {item.currency ?? ''}
                        </div>
                      )}
                      {/* Г-3.2 (аудит round4): раньше модератор одобрял
                          страницу, не видя описание товара вообще — а
                          именно оно (не только productName) идёт в
                          JSON-LD публичной страницы без предпросмотра.
                          Показываем как есть — экранирование выполняет
                          React (в отличие от dangerouslySetInnerHTML на
                          лендинге), это чтение, а не рендер сырого HTML. */}
                      {item.productDescription && (
                        <div className="muted" style={{ fontSize: 12, marginTop: 4, whiteSpace: 'pre-wrap' }}>
                          {item.productDescription}
                        </div>
                      )}
                    </td>
                    <td>
                      <span className={`badge-status badge-status-${STATUS_TONE[item.status]}`}>{STATUS_LABEL[item.status]}</span>
                      {item.moderatedAt && (
                        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                          {new Date(item.moderatedAt).toLocaleString('ru-RU')}
                        </div>
                      )}
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
                            placeholder="Причина отклонения — увидит автор"
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
