'use client';

// Модерация библиотеки разборов — ТЗ §21.1 (этап 25). Оператор видит все
// записи, включая приватные (разборы чужих загруженных файлов, §21.3), и
// может: скрыть с причиной, вернуть в выдачу, сделать публичной/приватной,
// поправить категорию (по ней записи и подбираются) или удалить.
//
// Скрытие ≠ удаление: скрытая запись не рекомендуется И не отдаётся из
// кеша, но остаётся с причиной и следом модератора; удаление стирает всё,
// и тот же источник разберётся заново с нуля.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  deleteLibraryEntry,
  getLibraryEntry,
  listLibrary,
  updateLibraryEntry,
} from '../../lib/endpoints';
import type {
  AdminLibraryEntry,
  AdminLibraryEntryDetail,
  AdminLibraryPage,
  LibraryVisibility,
} from '../../lib/types';
import { ApiRequestError } from '../../lib/admin-api';

const VISIBILITY_LABEL: Record<LibraryVisibility, string> = {
  PUBLIC: 'в выдаче',
  PRIVATE: 'только автору',
  HIDDEN: 'скрыта',
};
const VISIBILITY_TONE: Record<LibraryVisibility, 'ok' | 'warning' | 'critical'> = {
  PUBLIC: 'ok',
  PRIVATE: 'warning',
  HIDDEN: 'critical',
};

function errText(e: unknown): string {
  return e instanceof ApiRequestError ? e.message : 'Не удалось выполнить запрос';
}

export default function LibraryPage() {
  const [visibility, setVisibility] = useState('');
  const [sourceType, setSourceType] = useState('');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<AdminLibraryPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [hiding, setHiding] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [detail, setDetail] = useState<AdminLibraryEntryDetail | null>(null);

  // Этап 50 (В-5.10, В-5.12, В-5.13): см. users/page.tsx — поколение
  // запроса, сброс ошибки перед загрузкой, кнопка «Повторить».
  const loadGen = useRef(0);
  const load = useCallback(() => {
    const gen = ++loadGen.current;
    setError(null);
    listLibrary({
      visibility: visibility || undefined,
      sourceType: sourceType || undefined,
      q: query || undefined,
      page,
      pageSize: 20,
    })
      .then((r) => {
        if (gen === loadGen.current) setResult(r);
      })
      .catch((e) => {
        if (gen === loadGen.current) setError(errText(e));
      });
  }, [visibility, sourceType, query, page]);

  useEffect(() => {
    load();
  }, [load]);

  const patch = async (
    id: string,
    body: Parameters<typeof updateLibraryEntry>[1]
  ) => {
    setBusy(id);
    setError(null);
    try {
      await updateLibraryEntry(id, body);
      setHiding(null);
      setReason('');
      load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (entry: AdminLibraryEntry) => {
    if (
      !window.confirm(
        `Удалить запись «${entry.title ?? entry.sourceKey}»? Источник разберётся заново при следующем обращении. Обычно достаточно скрыть.`
      )
    ) {
      return;
    }
    setBusy(entry.id);
    try {
      await deleteLibraryEntry(entry.id);
      load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="admin-main">
      <h1>Библиотека разборов</h1>
      <p className="muted">
        Разборы Gemini, которые сервис переиспользует как кеш и предлагает
        пользователям как готовые сценарии. Записи из загруженных файлов
        создаются приватными — их видит только автор.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setQuery(q.trim());
        }}
        className="filters"
        style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '16px 0' }}
      >
        <select
          aria-label="Фильтр по видимости"
          value={visibility}
          onChange={(e) => {
            setPage(1);
            setVisibility(e.target.value);
          }}
        >
          <option value="">Любая видимость</option>
          <option value="PUBLIC">В выдаче</option>
          <option value="PRIVATE">Только автору</option>
          <option value="HIDDEN">Скрытые</option>
        </select>
        <select
          aria-label="Фильтр по источнику"
          value={sourceType}
          onChange={(e) => {
            setPage(1);
            setSourceType(e.target.value);
          }}
        >
          <option value="">Любой источник</option>
          <option value="youtube">YouTube</option>
          <option value="upload">Загруженный файл</option>
        </select>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Название, категория или ключ источника"
          aria-label="Поиск по библиотеке"
          style={{ minWidth: 260 }}
        />
        <button type="submit">Искать</button>
      </form>

      {error && (
        <p className="critical">
          {error}{' '}
          <button type="button" onClick={load}>
            Повторить
          </button>
        </p>
      )}

      {result && (
        <>
          <p className="muted">
            Всего: {result.total}. Страница {result.page}.
          </p>
          <div className="table-scroll">
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>Разбор</th>
                  <th style={{ textAlign: 'left' }}>Аудитория</th>
                  <th style={{ textAlign: 'left' }}>Видимость</th>
                  <th style={{ textAlign: 'left' }}>Использован</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {result.items.map((it) => (
                  <tr key={it.id} style={{ borderTop: '1px solid #333' }}>
                    <td style={{ padding: '8px 0', maxWidth: 380 }}>
                      <strong>{it.title ?? 'без названия'}</strong>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {it.sourceType === 'youtube' && it.sourceUrl ? (
                          <a href={it.sourceUrl} target="_blank" rel="noreferrer">
                            {it.sourceKey}
                          </a>
                        ) : (
                          it.sourceKey
                        )}
                        {it.category ? ` · ${it.category}` : ''} · {it.sceneCount} сцен ·{' '}
                        {it.characterCount} перс.
                      </div>
                      {it.hiddenReason && (
                        <div className="critical" style={{ fontSize: 12 }}>
                          Причина: {it.hiddenReason}
                        </div>
                      )}
                    </td>
                    <td className="muted" style={{ fontSize: 12 }}>
                      {[it.audienceAgeRange, it.audienceGender].filter(Boolean).join(' · ') ||
                        '—'}
                      <div>{it.audienceInterests.join(', ')}</div>
                    </td>
                    <td className={VISIBILITY_TONE[it.visibility]}>
                      {VISIBILITY_LABEL[it.visibility]}
                    </td>
                    <td className="muted">{it.usageCount}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button
                        type="button"
                        disabled={busy === it.id}
                        onClick={() =>
                          void getLibraryEntry(it.id)
                            .then(setDetail)
                            .catch((e) => setError(errText(e)))
                        }
                      >
                        Разбор
                      </button>{' '}
                      {it.visibility !== 'HIDDEN' ? (
                        <button
                          type="button"
                          disabled={busy === it.id}
                          onClick={() => {
                            setHiding(it.id);
                            setReason('');
                          }}
                        >
                          Скрыть
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={busy === it.id}
                          onClick={() =>
                            void patch(it.id, {
                              visibility:
                                it.sourceType === 'upload' ? 'PRIVATE' : 'PUBLIC',
                              hiddenReason: null,
                            })
                          }
                        >
                          Вернуть
                        </button>
                      )}{' '}
                      {it.visibility === 'PRIVATE' && (
                        <button
                          type="button"
                          disabled={busy === it.id}
                          onClick={() => void patch(it.id, { visibility: 'PUBLIC' })}
                        >
                          В выдачу
                        </button>
                      )}{' '}
                      {it.visibility === 'PUBLIC' && (
                        <button
                          type="button"
                          disabled={busy === it.id}
                          onClick={() => void patch(it.id, { visibility: 'PRIVATE' })}
                        >
                          Только автору
                        </button>
                      )}{' '}
                      <button
                        type="button"
                        disabled={busy === it.id}
                        onClick={() => void remove(it)}
                      >
                        Удалить
                      </button>
                      {hiding === it.id && (
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            if (!reason.trim()) return;
                            void patch(it.id, {
                              visibility: 'HIDDEN',
                              hiddenReason: reason.trim(),
                            });
                          }}
                          style={{ marginTop: 8 }}
                        >
                          <input
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                            placeholder="Причина скрытия (обязательно)"
                            style={{ minWidth: 240 }}
                            autoFocus
                          />{' '}
                          <button type="submit" disabled={!reason.trim()}>
                            Скрыть
                          </button>{' '}
                          <button type="button" onClick={() => setHiding(null)}>
                            Отмена
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Назад
            </button>
            <button
              type="button"
              disabled={result.page * result.pageSize >= result.total}
              onClick={() => setPage((p) => p + 1)}
            >
              Вперёд
            </button>
          </div>
        </>
      )}

      {detail && (
        <section style={{ marginTop: 24, borderTop: '1px solid #333', paddingTop: 16 }}>
          <h2>
            {detail.title ?? detail.sourceKey}{' '}
            <button type="button" onClick={() => setDetail(null)}>
              Закрыть
            </button>
          </h2>
          <p className="muted" style={{ fontSize: 12 }}>
            Автор: {detail.ownerId ?? 'анонимная сессия'} · сессия:{' '}
            {detail.sessionId ?? '—'} · создан{' '}
            {new Date(detail.createdAt).toLocaleString('ru-RU')}
          </p>
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              maxHeight: 400,
              overflow: 'auto',
              background: '#111',
              padding: 12,
            }}
          >
            {detail.analysis?.sceneBreakdown ?? 'Разбор пуст'}
          </pre>
        </section>
      )}
    </main>
  );
}
