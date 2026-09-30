'use client';

// Вкладка «Снимки интерфейса»: история крона `ui-snapshot-run`, который
// каждые две минуты снимает экраны TMA и сравнивает каждый с предыдущим
// снимком того же маршрута (backend/src/modules/ui-snapshot).
//
// Зачем: тревога «экран изменился» приходила в служебный канал без
// картинки, и понять, какой экран «мигает» — меняется от тика к тику без
// правок кода (часы, случайный порядок, недогруженная картинка), — можно
// было только запросом в базу. Сверху — сводка по маршрутам за период,
// изменчивые наверху; ниже — лента снимков выбранного маршрута. У
// изменившегося снимка рядом стоит предыдущий, с которым его сравнивали:
// смотреть на перемену надо бок о бок, а не по памяти.
//
// Картинки в Blob публичные и у каждого снимка свой путь (файл не
// перезаписывается), поэтому показываются прямо по адресу — тот же
// приём, что у кадров «Обучалок по сайтам».

import { useCallback, useEffect, useRef, useState } from 'react';
import { getUiSnapshots, getUiSnapshotSummary } from '../../lib/endpoints';
import type { UiSnapshotItem, UiSnapshotSummary } from '../../lib/types';
import { ApiRequestError } from '../../lib/admin-api';

function errText(e: unknown): string {
  return e instanceof ApiRequestError ? e.message : 'Не удалось выполнить запрос';
}

const PERIODS: Array<{ label: string; hours: number }> = [
  { label: 'последние 6 часов', hours: 6 },
  { label: 'сутки', hours: 24 },
  { label: '3 дня', hours: 72 },
  { label: '7 дней', hours: 168 },
  // 29 дней, а не 30: потолок сводки на сервере — 30 дней от ЕГО «сейчас»,
  // и граница, посчитанная здесь до отправки запроса, не должна упираться
  // в этот потолок (у сервера есть и свой допуск в пять минут).
  { label: '29 дней', hours: 696 },
];

const PAGE_SIZE = 20;

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatScore(score: number | null): string {
  return score === null ? '—' : score.toFixed(3);
}

interface LightboxImage {
  url: string;
  label: string;
}

export default function UiSnapshotsPage() {
  const [hours, setHours] = useState(24);
  const [summary, setSummary] = useState<UiSnapshotSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  const [route, setRoute] = useState<string | null>(null);
  const [changedOnly, setChangedOnly] = useState(true);
  const [items, setItems] = useState<UiSnapshotItem[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [feedLoading, setFeedLoading] = useState(false);
  const [feedError, setFeedError] = useState<string | null>(null);

  const [lightbox, setLightbox] = useState<LightboxImage[] | null>(null);

  // Номер последнего запроса ленты. Смена маршрута, флажка или периода и
  // «Загрузить ещё» уходят параллельно; ответ, пришедший после более
  // нового запроса, выбрасывается — иначе лента маршрута A дописалась бы
  // к ленте маршрута B, а «ещё» старого фильтра — к новому.
  const feedRequest = useRef(0);
  const summaryRequest = useRef(0);

  // Граница периода считается в момент загрузки: «сутки» — это сутки до
  // нажатия, а не до открытия вкладки час назад.
  const sinceIso = useCallback(
    () => new Date(Date.now() - hours * 3_600_000).toISOString(),
    [hours],
  );

  const loadSummary = useCallback(async () => {
    const req = ++summaryRequest.current;
    setSummaryError(null);
    try {
      const data = await getUiSnapshotSummary(sinceIso());
      // Период переключили, пока шёл запрос, — это сводка не за тот период.
      if (req !== summaryRequest.current) return;
      setSummary(data);
      // Без выбора — самый изменчивый маршрут: ради него вкладку и
      // открывают. Сервер уже отсортировал их изменчивыми вверх.
      setRoute((cur) => cur ?? data.routes[0]?.routeKey ?? null);
    } catch (e) {
      if (req === summaryRequest.current) setSummaryError(errText(e));
    }
  }, [sinceIso]);

  const loadFeed = useCallback(
    async (before?: string) => {
      if (!route) return;
      const req = ++feedRequest.current;
      setFeedLoading(true);
      setFeedError(null);
      try {
        const data = await getUiSnapshots({
          route,
          since: sinceIso(),
          limit: PAGE_SIZE,
          before,
          changed: changedOnly ? 'true' : undefined,
        });
        if (req !== feedRequest.current) return;
        setItems((cur) => (before ? [...cur, ...data.items] : data.items));
        setNextBefore(data.nextBefore);
      } catch (e) {
        if (req !== feedRequest.current) return;
        setFeedError(errText(e));
      } finally {
        if (req === feedRequest.current) setFeedLoading(false);
      }
    },
    [route, changedOnly, sinceIso],
  );

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  useEffect(() => {
    setItems([]);
    setNextBefore(null);
    void loadFeed();
  }, [loadFeed]);

  // Escape закрывает крупный просмотр — как и диалог подтверждения.
  useEffect(() => {
    if (!lightbox) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setLightbox(null);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [lightbox]);

  const selected = summary?.routes.find((r) => r.routeKey === route) ?? null;
  // Период длиннее срока хранения обычных снимков: «Снимков» и «Не
  // снялось» тогда считают только последние дни, а «Изменилось» — весь
  // период, и подписи обязаны это говорить.
  const retentionClipped = summary !== null && hours > summary.plainRetentionDays * 24;

  return (
    <div className="page">
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Снимки интерфейса</h1>
      <p className="muted" style={{ marginBottom: 20, maxWidth: 720 }}>
        Крон <code>ui-snapshot-run</code> каждые две минуты снимает экраны мини-приложения и
        сравнивает каждый с предыдущим снимком того же экрана. Экран, который «изменился» много раз
        без выкладок, — мигающий: в нём что-то меняется само (время, порядок, недогруженная
        картинка). Изменчивые маршруты — сверху таблицы.
      </p>

      <div className="filters" style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <label>
          Период:{' '}
          <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
            {PERIODS.map((p) => (
              <option key={p.hours} value={p.hours}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => {
            void loadSummary();
            void loadFeed();
          }}
        >
          Обновить
        </button>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <p style={{ fontWeight: 600, marginBottom: 8 }}>Сводка по маршрутам</p>
        {summaryError && (
          <p className="critical" style={{ fontSize: 13 }}>
            {summaryError}
          </p>
        )}
        {!summary && !summaryError && <p className="muted">Загрузка…</p>}
        {summary && summary.routes.length === 0 && (
          <p className="muted" style={{ fontSize: 13 }}>
            За выбранный период снимков нет — крон не ходил или ещё не дошёл.
          </p>
        )}
        {summary && summary.routes.length > 0 && retentionClipped && (
          <p className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
            Обычные снимки и сбои хранятся {summary.plainRetentionDays} дн., снимки «изменилось» —
            дольше. Поэтому за выбранный период «Изменилось» посчитано целиком, а «Снимков» и «Не
            снялось» — только за последние {summary.plainRetentionDays} дн., и доля перемен из этих
            чисел не выводится.
          </p>
        )}
        {summary && summary.routes.length > 0 && (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Маршрут</th>
                  <th>{retentionClipped ? `Снимков (за ${summary.plainRetentionDays} дн.)` : 'Снимков'}</th>
                  <th>Изменилось</th>
                  <th>{retentionClipped ? `Не снялось (за ${summary.plainRetentionDays} дн.)` : 'Не снялось'}</th>
                  <th>Последний снимок</th>
                  <th>Последние перемены</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {summary.routes.map((r) => (
                  <tr key={r.routeKey}>
                    <td style={{ fontWeight: r.routeKey === route ? 600 : 400 }}>{r.routeKey}</td>
                    <td>{r.total}</td>
                    <td>
                      {r.changed > 0 ? (
                        <span className="badge-status badge-status-warning">{r.changed}</span>
                      ) : (
                        0
                      )}
                    </td>
                    <td className={r.errors > 0 ? 'critical' : undefined}>{r.errors}</td>
                    <td>{r.lastAt ? formatDateTime(r.lastAt) : '—'}</td>
                    <td>
                      {r.recentChangedAt.length === 0 ? (
                        <span className="muted">—</span>
                      ) : (
                        r.recentChangedAt.map((t) => (
                          <span key={t} style={{ display: 'block' }}>
                            {formatDateTime(t)}
                          </span>
                        ))
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        disabled={r.routeKey === route}
                        onClick={() => setRoute(r.routeKey)}
                      >
                        {r.routeKey === route ? 'Открыт' : 'Смотреть'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {route && (
        <div className="card">
          <div
            className="filters"
            style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}
          >
            <p style={{ fontWeight: 600 }}>
              Снимки маршрута {route}
              {selected
                ? retentionClipped
                  ? ` · изменилось ${selected.changed} за период, снимков за последние ${summary?.plainRetentionDays} дн.: ${selected.total}`
                  : ` · изменилось ${selected.changed} из ${selected.total}`
                : ''}
            </p>
            <label style={{ marginLeft: 'auto', fontSize: 13 }}>
              <input
                type="checkbox"
                checked={changedOnly}
                onChange={(e) => setChangedOnly(e.target.checked)}
              />
              Только изменившиеся
            </label>
          </div>

          {feedError && (
            <p className="critical" style={{ fontSize: 13, marginBottom: 8 }}>
              {feedError}
            </p>
          )}
          {!feedLoading && !feedError && items.length === 0 && (
            <p className="muted" style={{ fontSize: 13 }}>
              {changedOnly
                ? 'За период этот экран ни разу не изменился.'
                : 'За период снимков этого маршрута нет.'}
            </p>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {items.map((s) => {
              // «Было» — то, с чем раннер сравнивал на самом деле
              // (`comparedToUrl`). Строка `previous` найдена сервером по
              // правилу раннера и может оказаться другой (строку убрали,
              // вставили ручной прогон); её время подписываем, только
              // если это тот же файл, иначе пара получила бы чужую дату.
              const prevUrl = s.comparedToUrl ?? s.previous?.blobUrl ?? null;
              const prevAt =
                s.previous && s.previous.blobUrl === prevUrl ? s.previous.createdAt : null;
              const current: LightboxImage | null = s.blobUrl
                ? { url: s.blobUrl, label: `Стало · ${formatDateTime(s.createdAt)}` }
                : null;
              const before: LightboxImage | null =
                s.changed && prevUrl
                  ? {
                      url: prevUrl,
                      label: prevAt ? `Было · ${formatDateTime(prevAt)}` : 'Было',
                    }
                  : null;
              const pair = [before, current].filter((x): x is LightboxImage => x !== null);
              return (
                <div
                  key={s.id}
                  style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}
                >
                  <p style={{ fontSize: 13, marginBottom: 8 }}>
                    <strong>{formatDateTime(s.createdAt)}</strong>
                    <span className="muted">
                      {' '}
                      · {s.locale} / {s.theme} · расстояние {formatScore(s.diffScore)}
                      {s.diffHash ? ` · отпечаток ${s.diffHash}` : ''}
                    </span>
                    {s.changed && (
                      <span className="badge-status badge-status-warning" style={{ marginLeft: 8 }}>
                        изменилось
                      </span>
                    )}
                  </p>
                  {s.error && (
                    <p className="critical" style={{ fontSize: 13, marginBottom: 8 }}>
                      Снимок не снят: {s.error}
                    </p>
                  )}
                  {pair.length > 0 && (
                    <div style={{ display: 'flex', gap: 12, overflowX: 'auto' }}>
                      {pair.map((img) => (
                        <button
                          key={img.url}
                          type="button"
                          title="Открыть крупно"
                          onClick={() => setLightbox(pair)}
                          style={{
                            background: 'none',
                            border: 'none',
                            padding: 0,
                            cursor: 'zoom-in',
                            color: 'inherit',
                            textAlign: 'left',
                          }}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={img.url}
                            alt={img.label}
                            loading="lazy"
                            style={{
                              height: 240,
                              display: 'block',
                              border: '1px solid var(--border)',
                              borderRadius: 6,
                            }}
                          />
                          <span className="muted" style={{ fontSize: 12 }}>
                            {img.label}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                  {s.changed && !prevUrl && (
                    <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                      Предыдущего снимка нет — сравнивать не с чем.
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          {feedLoading && (
            <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
              Загрузка…
            </p>
          )}
          {nextBefore && !feedLoading && (
            <button
              type="button"
              style={{ marginTop: 12 }}
              onClick={() => void loadFeed(nextBefore)}
            >
              Загрузить ещё
            </button>
          )}
        </div>
      )}

      {lightbox && (
        <div
          className="dialog-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Снимок крупно"
          onClick={() => setLightbox(null)}
          style={{ cursor: 'zoom-out', overflow: 'auto' }}
        >
          <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', maxWidth: '100%' }}>
            {lightbox.map((img) => (
              <figure key={img.url} style={{ margin: 0, minWidth: 0 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img.url}
                  alt={img.label}
                  style={{
                    maxHeight: '85vh',
                    maxWidth: lightbox.length > 1 ? '45vw' : '90vw',
                    display: 'block',
                    borderRadius: 6,
                  }}
                />
                <figcaption style={{ fontSize: 13, marginTop: 6 }}>
                  {img.label}{' '}
                  <a
                    href={img.url}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                  >
                    открыть файл
                  </a>
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
