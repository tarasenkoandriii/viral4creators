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

import { useCallback, useEffect, useRef, useState } from 'react';
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

/**
 * Чек-лист перед «Одобрить» (перенос QA TMA §12, 01.10.2026).
 *
 * Пункты — ровно то, на чём спотыкались кадры обучалки нашего продукта
 * и что одинаково возможно на чужом сайте: кадр снят до того, как
 * страница осела; кадр не про свой шаг; поверх баннер; в кадре чужие
 * люди или ключи. Последний — про §8.3: опасный шаг допустим, если он
 * и есть смысл ролика («как оформить заказ»), но решение об этом
 * должно быть принято, а не пропущено.
 *
 * Галочки обязательны: кнопка одобрения запускает ПЛАТНУЮ сборку, и
 * «посмотрел мельком» здесь стоит денег и, хуже, публикации чужих
 * данных от имени продукта.
 */
const CHECKLIST: Array<{ key: string; label: string }> = [
  { key: 'settled', label: 'Ни на одном кадре нет спиннера, скелетона или пустого экрана' },
  { key: 'onStep', label: 'Каждый кадр показывает результат своего шага (подписи под кадрами)' },
  { key: 'noOverlay', label: 'Поверх содержимого нет баннера (куки, чат, подписка)' },
  { key: 'noPersonal', label: 'В кадре нет персональных данных клиентов заказчика, токенов и ключей' },
  { key: 'danger', label: 'Опасные действия (помечены красным) — осознанная часть сценария' },
];

interface StepLike {
  kind?: string;
  selector?: string;
  route?: string;
}

/** Короткая подпись шага: что сделал и где. Значения `fill` не
 * показываются — у секретных полей их и нет, а у обычных в подписи
 * под кадром они лишние (полный список шагов ниже). */
function stepLabel(step: StepLike): string {
  const where = step.selector ?? step.route ?? '';
  return `${step.kind ?? '?'} ${where}`.trim();
}

/**
 * Раскладка «раунд → его шаги» по `stepsPerRound`: раунд i владеет
 * шагами со сдвига суммы предыдущих. Отдельной функцией, чтобы подпись
 * кадра и номер шага в списке ниже считались одним правилом.
 */
function stepsOfRounds(
  steps: unknown,
  stepsPerRound: number[],
): Array<{ from: number; items: StepLike[] }> {
  const list = Array.isArray(steps) ? (steps as StepLike[]) : [];
  const out: Array<{ from: number; items: StepLike[] }> = [];
  let offset = 0;
  for (const size of stepsPerRound) {
    out.push({ from: offset, items: list.slice(offset, offset + size) });
    offset += size;
  }
  return out;
}

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
  const [checked, setChecked] = useState<Record<string, boolean>>({});

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

  // Какую карточку оператор ждёт СЕЙЧАС. Ref, а не `openId` из
  // замыкания: ответ на open(A), пришедший после open(B), иначе
  // подменял бы детали B деталями A — и чек-лист с кнопкой «Одобрить»
  // оказывались под чужими кадрами (аудит 01.10.2026).
  const wantedId = useRef<string | null>(null);

  const open = useCallback(async (id: string) => {
    if (openId === id) {
      wantedId.current = null;
      setOpenId(null);
      setDetails(null);
      return;
    }
    wantedId.current = id;
    setOpenId(id);
    setDetails(null);
    setReason('');
    // Чек-лист — на каждую заявку заново: галочки от прошлой карточки
    // открыли бы кнопку для кадров, которых оператор не видел.
    setChecked({});
    try {
      const loaded = await getClientSiteDraft(id);
      if (wantedId.current !== id) return;
      setDetails(loaded);
    } catch (e) {
      if (wantedId.current !== id) return;
      setError(errText(e));
    }
  }, [openId]);

  // Переход с «Обзора» (дашборд внимания): `?open=<id>` сразу
  // раскрывает карточку этого черновика — один раз, при входе.
  const deepLinked = useRef(false);
  useEffect(() => {
    if (deepLinked.current) return;
    deepLinked.current = true;
    const id = new URLSearchParams(window.location.search).get('open');
    if (id) void open(id);
  }, [open]);

  async function act(run: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await run();
      wantedId.current = null;
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
  const detailRounds = details
    ? stepsOfRounds(details.steps, details.stepsPerRound)
    : [];

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
                <>
                  {details.frameUrls.length !== details.stepsPerRound.length && (
                    // Кадр раунда мог пропасть из хранилища — тогда
                    // подписи ниже съезжают, и оператор должен это знать,
                    // а не сверять кадр с чужими шагами.
                    <p style={{ color: '#b00', fontSize: 13 }}>
                      Кадров {details.frameUrls.length}, раундов{' '}
                      {details.stepsPerRound.length} — подписи «кадр ↔ шаги»
                      могут не совпадать.
                    </p>
                  )}
                  <div style={{ display: 'flex', gap: 8, overflowX: 'auto' }}>
                    {details.frameUrls.map((url, i) => {
                      const round = detailRounds[i];
                      const danger = details.roundDangerWarnings[i];
                      return (
                        <figure key={url} style={{ margin: 0, width: 180, flex: 'none' }}>
                          {/* Это полный PNG, лишь ВЫВЕДЕННЫЙ шириной 180:
                              отдельных миниатюр в хранилище нет. Экономит
                              здесь `loading="lazy"` — кадры за краем
                              ленты не грузятся, пока до них не
                              прокрутили. Полный размер — по клику. */}
                          <a href={url} target="_blank" rel="noreferrer">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={url}
                              alt={`Кадр ${i + 1}`}
                              loading="lazy"
                              decoding="async"
                              style={{ width: 180, height: 'auto', border: '1px solid #eee' }}
                            />
                          </a>
                          <figcaption style={{ fontSize: 12, color: '#444' }}>
                            <strong>Кадр {i + 1}</strong>
                            {round && round.items.length > 0 && (
                              <>
                                {' '}
                                · шаги {round.from + 1}
                                {round.items.length > 1
                                  ? `–${round.from + round.items.length}`
                                  : ''}
                                {round.items.map((st, k) => (
                                  <div key={k} style={{ wordBreak: 'break-all' }}>
                                    {stepLabel(st)}
                                  </div>
                                ))}
                              </>
                            )}
                            {danger && (
                              <div style={{ color: '#b00' }}>Опасно: {danger}</div>
                            )}
                          </figcaption>
                        </figure>
                      );
                    })}
                  </div>
                </>
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
                  <fieldset style={{ border: '1px solid #ddd', marginBottom: 8 }}>
                    <legend>Перед одобрением</legend>
                    {CHECKLIST.map((item) => (
                      <label key={item.key} style={{ display: 'block', fontSize: 14 }}>
                        <input
                          type="checkbox"
                          checked={checked[item.key] === true}
                          onChange={(e) =>
                            setChecked((prev) => ({
                              ...prev,
                              [item.key]: e.target.checked,
                            }))
                          }
                        />{' '}
                        {item.label}
                      </label>
                    ))}
                  </fieldset>
                  <button
                    disabled={
                      busy || !CHECKLIST.every((item) => checked[item.key])
                    }
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
