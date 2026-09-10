'use client';

// Очередь модерации публикаций — ТЗ §8 (Todo) / §11 «Опубликовать» +
// §14 «Выгрузка» (этап 61). Оператор смотрит ролик и одобряет или
// отклоняет заявку; одобрение назначает канал и приватность — саму
// выгрузку в YouTube/TikTok делает крон-воркер (GET /api/cron/publish),
// колонка «Выгрузка» показывает его прогресс без участия оператора.

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { approvePublication, listPublications, rejectPublication, retryPublication } from '../../lib/endpoints';
import type { PublicationListResult, PublicationPrivacy, PublicationRequest, PublicationStatus } from '../../lib/types';
import { ApiRequestError } from '../../lib/admin-api';

const STATUS_LABEL: Record<PublicationStatus, string> = {
  PENDING: 'ждёт решения',
  APPROVED: 'одобрено',
  REJECTED: 'отклонено',
  PUBLISHED: 'опубликовано',
  FAILED: 'ошибка выгрузки',
};
const STATUS_TONE: Record<PublicationStatus, 'ok' | 'warning' | 'critical'> = {
  PENDING: 'warning',
  APPROVED: 'ok',
  REJECTED: 'critical',
  PUBLISHED: 'ok',
  FAILED: 'critical',
};
const PLATFORM_LABEL = { YOUTUBE: 'YouTube', TIKTOK: 'TikTok' } as const;
const PRIVACY_LABEL: Record<PublicationPrivacy, string> = {
  PRIVATE: 'приватно',
  UNLISTED: 'по ссылке',
  PUBLIC: 'публично',
};

function errText(e: unknown): string {
  return e instanceof ApiRequestError ? e.message : 'Не удалось выполнить запрос';
}

export default function PublicationsPage() {
  const [status, setStatus] = useState<string>('PENDING');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<PublicationListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  // Этап 61 (§14.2/14.3): необязательный выбор канала/приватности перед
  // одобрением — по умолчанию сервис сам находит канал, форма нужна
  // только когда у автора несколько каналов на платформу или оператор
  // хочет выложить не приватно.
  const [approving, setApproving] = useState<string | null>(null);
  const [channelId, setChannelId] = useState('');
  const [privacy, setPrivacy] = useState<PublicationPrivacy>('PRIVATE');

  // Этап 50 (В-5.23, В-5.13): одна загрузка вместо двух копий одного
  // запроса (после одобрения звалась версия без отмены); поколение
  // отбрасывает устаревший ответ, ошибка сбрасывается перед загрузкой.
  const loadGen = useRef(0);
  const load = useCallback(() => {
    const gen = ++loadGen.current;
    setError(null);
    listPublications({ status: status || undefined, page, pageSize: 20 })
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

  const replace = (item: PublicationRequest) =>
    setResult((r) => (r ? { ...r, items: r.items.map((x) => (x.id === item.id ? item : x)) } : r));

  async function handleApprove(item: PublicationRequest) {
    setBusy(item.id);
    setError(null);
    try {
      const updated = await approvePublication(item.id, {
        channelId: channelId.trim() || undefined,
        privacy,
      });
      replace(updated);
      setApproving(null);
      setChannelId('');
      setPrivacy('PRIVATE');
      load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  }

  async function handleRetry(item: PublicationRequest) {
    setBusy(item.id);
    setError(null);
    try {
      const updated = await retryPublication(item.id);
      replace(updated);
      load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  }

  async function handleReject(item: PublicationRequest) {
    if (reason.trim().length < 3) return;
    setBusy(item.id);
    setError(null);
    try {
      const updated = await rejectPublication(item.id, reason.trim());
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
        Модерация публикаций
        {result && result.pending > 0 && (
          <span className="badge-status badge-status-warning" style={{ marginLeft: 10, verticalAlign: 'middle' }}>
            ждут: {result.pending}
          </span>
        )}
      </h1>
      <p className="muted" style={{ marginBottom: 16 }}>
        Кнопка «Опубликовать» в TMA ставит ролик сюда, а не выкладывает его. «Одобрить» назначает канал
        выгрузки (обычно сам, по проекту/бренду или единственному каналу автора) — дальше крон-воркер
        выгружает ролик в YouTube/TikTok сам, колонка «Выгрузка» показывает его прогресс. Пока канал не
        подключён автором, заявка остаётся одобренной, но невыгруженной — это не ошибка.
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
          {(Object.keys(STATUS_LABEL) as PublicationStatus[]).map((s) => (
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
                  <th>Платформа</th>
                  <th>Теги</th>
                  <th>Статус</th>
                  <th>Выгрузка</th>
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
                          {item.description && (
                            <div className="muted" style={{ fontSize: 12, marginTop: 2, whiteSpace: 'pre-wrap' }}>
                              {item.description.length > 240 ? `${item.description.slice(0, 240)}…` : item.description}
                            </div>
                          )}
                          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                            <Link href={`/sessions/${item.sessionId}`}>сессия {item.sessionId.slice(0, 8)}…</Link>
                            {' · '}
                            <a href={item.videoUrl} target="_blank" rel="noreferrer">
                              скачать
                            </a>
                            {' · автор '}
                            {item.userId.slice(0, 8)}…
                          </div>
                          {item.status === 'REJECTED' && item.rejectReason && (
                            <div style={{ fontSize: 12, marginTop: 4, color: 'var(--signal-critical)' }}>
                              Причина: {item.rejectReason}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td>{PLATFORM_LABEL[item.platform]}</td>
                    <td style={{ maxWidth: 200 }}>
                      <span className="muted" style={{ fontSize: 12 }}>
                        {item.tags.map((t) => `#${t}`).join(' ')}
                      </span>
                    </td>
                    <td>
                      <span className={`badge-status badge-status-${STATUS_TONE[item.status]}`}>{STATUS_LABEL[item.status]}</span>
                      {item.moderatedAt && (
                        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                          {new Date(item.moderatedAt).toLocaleString('ru-RU')}
                        </div>
                      )}
                    </td>
                    <td style={{ maxWidth: 220 }}>
                      {item.status === 'PUBLISHED' && item.externalUrl && (
                        <a href={item.externalUrl} target="_blank" rel="noreferrer">
                          открыть на площадке
                        </a>
                      )}
                      {item.status === 'PUBLISHED' && !item.externalUrl && (
                        <span className="muted" style={{ fontSize: 12 }}>
                          опубликовано (без публичной ссылки — TikTok, приватно)
                        </span>
                      )}
                      {item.status === 'APPROVED' && !item.channelId && (
                        <span className="muted" style={{ fontSize: 12 }}>канал не подключён</span>
                      )}
                      {item.status === 'APPROVED' && item.channelId && (
                        <span className="muted" style={{ fontSize: 12 }}>
                          {item.attempts > 0 ? `ждёт воркера (попытка ${item.attempts})` : 'ждёт воркера'}
                        </span>
                      )}
                      {item.status === 'FAILED' && (
                        <div>
                          <div style={{ fontSize: 12, color: 'var(--signal-critical)' }}>
                            {item.publishError || 'попытки исчерпаны'}
                          </div>
                          <button type="button" onClick={() => void handleRetry(item)} disabled={busy !== null} style={{ marginTop: 4 }}>
                            {busy === item.id ? '…' : 'Повторить'}
                          </button>
                        </div>
                      )}
                    </td>
                    <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                      {new Date(item.createdAt).toLocaleString('ru-RU')}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {item.status === 'PENDING' && approving !== item.id && rejecting !== item.id && (
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button
                            type="button"
                            onClick={() => {
                              setApproving(item.id);
                              setChannelId('');
                              setPrivacy('PRIVATE');
                            }}
                            disabled={busy !== null}
                          >
                            Одобрить
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
                      {item.status === 'PENDING' && approving === item.id && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 220 }}>
                          <label style={{ fontSize: 12 }}>
                            Приватность
                            <select
                              value={privacy}
                              onChange={(e) => setPrivacy(e.target.value as PublicationPrivacy)}
                              style={{ display: 'block', width: '100%', marginTop: 2 }}
                            >
                              {(Object.keys(PRIVACY_LABEL) as PublicationPrivacy[]).map((p) => (
                                <option key={p} value={p}>
                                  {PRIVACY_LABEL[p]}
                                </option>
                              ))}
                            </select>
                          </label>
                          {item.platform === 'TIKTOK' && (
                            <span className="muted" style={{ fontSize: 11 }}>
                              TikTok до прохождения аудита всё равно выгружает только приватно.
                            </span>
                          )}
                          <label style={{ fontSize: 12 }}>
                            Канал (необязательно — иначе подберётся сам)
                            <input
                              type="text"
                              value={channelId}
                              onChange={(e) => setChannelId(e.target.value)}
                              placeholder="id канала"
                              style={{ display: 'block', width: '100%', marginTop: 2, fontSize: 12 }}
                            />
                          </label>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button type="button" onClick={() => void handleApprove(item)} disabled={busy !== null}>
                              {busy === item.id ? '…' : 'Подтвердить'}
                            </button>
                            <button type="button" onClick={() => setApproving(null)} disabled={busy !== null}>
                              Отмена
                            </button>
                          </div>
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
