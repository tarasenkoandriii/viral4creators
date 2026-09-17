'use client';

// Вкладка «Обучалки по сайтам» (§5.2 админские эндпоинты и §8.3
// doc/CLIENT-SITE-TUTORIAL-SPEC.md, этап 113).
//
// Зачем отдельная вкладка, а не строка в «Сценариях обучалки»: там
// оператор решает, можно ли ПОТРАТИТЬ НАШИ ДЕНЬГИ на платный шаг
// регресс-прогона. Здесь — можно ли ПОКАЗАТЬ от имени продукта видео, в
// кадре которого ЧУЖОЙ сайт (чужой брендинг, чужие данные) и в котором
// пользователь мог записать необратимый шаг: «Оплатить», «Удалить».
// Разные вопросы, разные данные для решения.
//
// Ключевая деталь экрана — лента кадров. Она уже залита в Blob на
// /finish и стоит ноль: посмотреть на будущий ролик можно ДО того, как
// запустится сборка через внешний ffmpeg-api — самый дорогой шаг всего
// конвейера. Одобрение запускает её; поэтому кнопка «Одобрить» стоит
// ПОД кадрами, а не над ними.

import { useCallback, useEffect, useState } from 'react';
import {
  approveClientSiteDraft,
  getClientSiteDraft,
  getClientSiteDrafts,
  rejectClientSiteDraft,
} from '../../lib/endpoints';
import type {
  ClientSiteDraftDetails,
  ClientSiteDraftRow,
  ClientSiteDraftStatus,
} from '../../lib/types';
import { ApiRequestError } from '../../lib/admin-api';

function errText(e: unknown): string {
  return e instanceof ApiRequestError
    ? e.message
    : 'Не удалось выполнить запрос';
}

const STATUS_LABEL: Record<ClientSiteDraftStatus, string> = {
  DRAFTING: 'записывается',
  PENDING_REVIEW: 'ждёт проверки',
  APPROVED: 'одобрено',
  REJECTED: 'отклонено',
};

const PAGE_SIZE = 20;

export default function SiteTutorialDraftsPage() {
  const [status, setStatus] = useState<'' | ClientSiteDraftStatus>(
    'PENDING_REVIEW',
  );
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<{
    items: ClientSiteDraftRow[];
    total: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [details, setDetails] = useState<ClientSiteDraftDetails | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await getClientSiteDrafts({
        status: status || undefined,
        page,
        pageSize: PAGE_SIZE,
      });
      setResult({ items: data.items, total: data.total });
    } catch (e) {
      setError(errText(e));
    }
  }, [status, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = useCallback(async (id: string) => {
    if (openId === id) {
      setOpenId(null);
      setDetails(null);
      return;
    }
    setOpenId(id);
    setDetails(null);
    setReason('');
    try {
      setDetails(await getClientSiteDraft(id));
    } catch (e) {
      setError(errText(e));
    }
  }, [openId]);

  async function act(run: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await run();
      setOpenId(null);
      setDetails(null);
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  const pages = result ? Math.ceil(result.total / PAGE_SIZE) : 1;

  return (
    <main style={{ padding: 24, maxWidth: 1000 }}>
      <h1>Обучалки по сайтам заказчиков</h1>
      <p style={{ color: '#666', maxWidth: 680 }}>
        Пользователь записал сценарий, кликая по своему сайту. Одобрение
        запускает платную сборку ролика, поэтому сначала — кадры: они уже
        сняты и ничего не стоят. Отдельно смотрите на шаги: среди них мог
        оказаться необратимый («Оплатить», «Удалить»).
      </p>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', margin: '16px 0' }}>
        <label>
          Статус:{' '}
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as '' | ClientSiteDraftStatus);
              setPage(1);
            }}
          >
            <option value="">все</option>
            <option value="PENDING_REVIEW">ждут проверки</option>
            <option value="DRAFTING">записываются</option>
            <option value="APPROVED">одобренные</option>
            <option value="REJECTED">отклонённые</option>
          </select>
        </label>
        <button onClick={() => void load()}>Обновить</button>
      </div>

      {error && <p style={{ color: '#b00' }}>{error}</p>}
      {!result && <p>Загрузка…</p>}
      {result && result.items.length === 0 && <p>Ничего нет.</p>}

      {result?.items.map((row) => (
        <section
          key={row.id}
          style={{
            border: '1px solid #ddd',
            borderRadius: 6,
            padding: 12,
            marginBottom: 12,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <strong>{row.title ?? '(без названия)'}</strong>
              <div style={{ color: '#666', fontSize: 13 }}>
                {row.baseUrl} · {STATUS_LABEL[row.status]} · раундов{' '}
                {row.roundCount}, шагов {row.stepCount}
                {row.previewFrameCount !== null
                  ? `, кадров ${row.previewFrameCount}`
                  : ', кадры не залиты'}
                {row.requiresLiveLoginReplay && ' · был живой вход'}
              </div>
              {row.rejectionReason && (
                <div style={{ color: '#b00', fontSize: 13 }}>
                  Отклонено: {row.rejectionReason}
                </div>
              )}
            </div>
            <button onClick={() => void open(row.id)}>
              {openId === row.id ? 'Свернуть' : 'Смотреть'}
            </button>
          </div>

          {openId === row.id && !details && <p>Загрузка карточки…</p>}
          {openId === row.id && details && (
            <div style={{ marginTop: 12 }}>
              <h3 style={{ marginBottom: 4 }}>Кадры будущего ролика</h3>
              {details.frameUrls.length === 0 ? (
                <p style={{ color: '#666' }}>
                  Кадры ещё не залиты — пользователь не завершил запись.
                </p>
              ) : (
                <div style={{ display: 'flex', gap: 8, overflowX: 'auto' }}>
                  {details.frameUrls.map((url, i) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={url}
                      src={url}
                      alt={`Кадр ${i + 1}`}
                      style={{ height: 320, border: '1px solid #eee' }}
                    />
                  ))}
                </div>
              )}

              <h3 style={{ marginBottom: 4 }}>Шаги сценария</h3>
              <pre
                style={{
                  background: '#f7f7f7',
                  padding: 8,
                  maxHeight: 240,
                  overflow: 'auto',
                  fontSize: 12,
                }}
              >
                {JSON.stringify(details.steps, null, 2)}
              </pre>
              {details.hasCredentials && (
                <p style={{ color: '#666', fontSize: 13 }}>
                  У черновика сохранены тестовые учётные данные заказчика —
                  они зашифрованы и в сценарии не хранятся.
                </p>
              )}

              {row.status === 'PENDING_REVIEW' && (
                <div style={{ marginTop: 12 }}>
                  <button
                    disabled={busy}
                    onClick={() => void act(() => approveClientSiteDraft(row.id))}
                  >
                    Одобрить и собрать ролик
                  </button>
                  <div style={{ marginTop: 8 }}>
                    <input
                      placeholder="Причина отклонения — её увидит пользователь"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      style={{ width: 420, marginRight: 8 }}
                    />
                    <button
                      disabled={busy || reason.trim().length < 3}
                      onClick={() =>
                        void act(() => rejectClientSiteDraft(row.id, reason))
                      }
                    >
                      Отклонить
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      ))}

      {result && pages > 1 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Назад
          </button>
          <span>
            {page} / {pages}
          </span>
          <button disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
            Вперёд
          </button>
        </div>
      )}
    </main>
  );
}
