'use client';

// Блог/новости — модерация (doc/TODO.md §II.3, ТЗ §36/§37, этап 58 UI;
// backend — этап 57). Тот же принцип, что «Модерация публикаций» и
// «Библиотека»: ничего не появляется на витрине без оператора.
//
// Жизненный цикл (см. backend/src/modules/blog/blog.service.ts —
// переходы проверяются там, эта страница только не предлагает кнопку,
// которую сервер всё равно отклонит):
//   DRAFT --одобрить--> APPROVED --опубликовать--> PUBLISHED
//   DRAFT/APPROVED --отклонить(причина)--> REJECTED
//   PUBLISHED --снять--> APPROVED (не REJECTED — снятие с витрины не отказ)
// Правка текста (title/bodyHtml) сбрасывает готовые/поданные переводы на
// PENDING — колонка «Переводы» покажет упавшее число сразу после правки,
// это ожидаемо, крон подхватит на следующем прогоне.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  approveBlogPost,
  createBlogPost,
  deleteBlogPost,
  getBlogPost,
  listBlogPosts,
  publishBlogPost,
  rejectBlogPost,
  unpublishBlogPost,
  updateBlogPost,
} from '../../lib/endpoints';
import type {
  AdminBlogPostDetail,
  AdminBlogPostListItem,
  AdminBlogPostPage,
  BlogPostStatus,
  BlogTranslationsState,
} from '../../lib/types';
import { ApiRequestError } from '../../lib/admin-api';

const STATUS_LABEL: Record<BlogPostStatus, string> = {
  DRAFT: 'черновик',
  APPROVED: 'одобрено · ждёт публикации',
  PUBLISHED: 'опубликовано',
  REJECTED: 'отклонено',
};
const STATUS_TONE: Record<BlogPostStatus, 'ok' | 'warning' | 'critical'> = {
  DRAFT: 'warning',
  APPROVED: 'ok',
  PUBLISHED: 'ok',
  REJECTED: 'critical',
};
const SOURCE_LABEL = { YOUTUBE_TREND: 'YouTube-тренд', MANUAL: 'вручную' } as const;

function errText(e: unknown): string {
  return e instanceof ApiRequestError ? e.message : 'Не удалось выполнить запрос';
}

/**
 * Одно число «готово/всего» означало ПЯТЬ разных состояний, и только в
 * одном из них нужен человек. Владелец, увидев «0/4» у черновика,
 * спросил «как инициировать переводы» — и правильно спросил: у
 * черновика их не бывает по устройству, а экран об этом молчал.
 */
const TRANSLATIONS_LABEL: Record<BlogTranslationsState, string> = {
  'not-started': 'после одобрения',
  'awaiting-cron': 'в очереди крона',
  'in-progress': 'переводятся',
  ready: 'готовы',
  failed: 'сбой — нужен повтор',
};

const TRANSLATIONS_HINT: Record<BlogTranslationsState, string> = {
  'not-started':
    'Переводы заводятся только у одобренных записей. Одобрите — и суточный крон блога поставит их в очередь.',
  'awaiting-cron':
    'Запись одобрена, строки переводов заведёт ближайший прогон крона блога. Можно не ждать сутки: «Система → Кроны → blog → Запустить».',
  'in-progress':
    'Пачка подана в xAI. Ответ приходит в течение суток, забирает его тот же крон.',
  ready: 'Все четыре языка переведены.',
  failed:
    'Хотя бы один перевод провалился. Крон повторит его сам (до трёх попыток); если не помогает — правка текста статьи ставит переводы в очередь заново.',
};

export default function BlogPage() {
  const [status, setStatus] = useState<string>('DRAFT');
  const [category, setCategory] = useState('');
  const [categoryQuery, setCategoryQuery] = useState('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<AdminBlogPostPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [detail, setDetail] = useState<AdminBlogPostDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editBody, setEditBody] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [newBody, setNewBody] = useState('');

  // Этап 50 (В-5.10/12/13): поколение отбрасывает устаревший ответ,
  // ошибка сбрасывается перед загрузкой, есть кнопка «Повторить».
  const loadGen = useRef(0);
  const load = useCallback(() => {
    const gen = ++loadGen.current;
    setError(null);
    listBlogPosts({
      status: status || undefined,
      category: categoryQuery || undefined,
      page,
      pageSize: 20,
    })
      .then((r) => {
        if (gen === loadGen.current) setResult(r);
      })
      .catch((e) => {
        if (gen === loadGen.current) setError(errText(e));
      });
  }, [status, categoryQuery, page]);

  useEffect(() => {
    load();
  }, [load]);

  const replaceInList = (updated: AdminBlogPostDetail) =>
    setResult((r) =>
      r ? { ...r, items: r.items.map((x) => (x.id === updated.id ? updated : x)) } : r
    );

  const detailRef = useRef<HTMLElement | null>(null);

  const openDetail = (item: AdminBlogPostListItem) => {
    setError(null);
    getBlogPost(item.id)
      .then((d) => {
        setDetail(d);
        setEditing(false);
      })
      .catch((e) => setError(errText(e)));
  };

  // Карточка рендерится ПОД таблицей, а в таблице десятки строк с
  // длинными заголовками — нажав «Открыть» у верхней записи, оператор
  // не видел ничего: карточка открывалась за сотни пикселей ниже
  // экрана, и это выглядело как сломанная кнопка (жалоба владельца
  // 24.09.2026, запрос в сети при этом отвечал 200). Довозим человека
  // до того, что он открыл, и ставим туда фокус — иначе с клавиатуры
  // карточка так и остаётся недостижимой.
  const detailId = detail?.id ?? null;
  useEffect(() => {
    if (!detailId) return;
    detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    detailRef.current?.focus({ preventScroll: true });
  }, [detailId]);

  async function runAction(id: string, action: () => Promise<AdminBlogPostDetail>) {
    setBusy(id);
    setError(null);
    try {
      const updated = await action();
      replaceInList(updated);
      if (detail?.id === id) setDetail(updated);
      load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  }

  async function handleReject(id: string) {
    if (reason.trim().length < 1) return;
    await runAction(id, () => rejectBlogPost(id, reason.trim()));
    setRejecting(null);
    setReason('');
  }

  function startEdit(d: AdminBlogPostDetail) {
    setEditTitle(d.title);
    setEditBody(d.bodyHtml);
    setEditCategory(d.category);
    setEditing(true);
  }

  async function saveEdit() {
    if (!detail) return;
    setBusy(detail.id);
    setError(null);
    try {
      // Шлём ТОЛЬКО изменённое. Раньше уходили все три поля всегда, и
      // бэкенд считал `textChanged` истинным при любом сохранении — то
      // есть правка одной категории сбрасывала все переводы, а подсказка
      // рядом обещала обратное (аудит блога 24.09.2026).
      const patch: Parameters<typeof updateBlogPost>[1] = {};
      if (editTitle.trim() !== detail.title) patch.title = editTitle.trim();
      if (editBody.trim() !== detail.bodyHtml) patch.bodyHtml = editBody.trim();
      if (editCategory.trim() !== detail.category) {
        patch.category = editCategory.trim();
      }
      const updated = await updateBlogPost(detail.id, patch);
      setDetail(updated);
      replaceInList(updated);
      setEditing(false);
      load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  }

  async function handleCreate() {
    if (!newTitle.trim() || !newCategory.trim() || !newBody.trim()) return;
    setBusy('create');
    setError(null);
    try {
      await createBlogPost({
        title: newTitle.trim(),
        category: newCategory.trim(),
        bodyHtml: newBody.trim(),
      });
      setCreating(false);
      setNewTitle('');
      setNewCategory('');
      setNewBody('');
      setStatus('DRAFT');
      setPage(1);
      load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  }

  async function handleDelete(item: AdminBlogPostListItem) {
    if (!window.confirm(`Удалить запись «${item.title}»? Отменить нельзя.`)) return;
    setBusy(item.id);
    setError(null);
    try {
      await deleteBlogPost(item.id);
      if (detail?.id === item.id) setDetail(null);
      load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  }

  const totalPages = result ? Math.max(Math.ceil(result.total / result.pageSize), 1) : 1;

  return (
    <main className="admin-main">
      <h1>Блог / новости</h1>
      <p className="muted">
        Суточный крон заводит черновики из трендовых роликов YouTube с разбором
        Gemini (§II.3) — это не автопостинг, каждый черновик ждёт решения здесь.
        Этот же экран управляет и ручными записями (новости, кейсы, обновления
        продукта). Ничего не появляется на витрине лендинга без публикации.
      </p>

      <div className="filters" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '16px 0', alignItems: 'center' }}>
        <select
          aria-label="Фильтр по статусу"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="">Все статусы</option>
          {(Object.keys(STATUS_LABEL) as BlogPostStatus[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            setCategoryQuery(category.trim());
          }}
          style={{ display: 'flex', gap: 8 }}
        >
          <input
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="Категория (точное совпадение)"
            aria-label="Фильтр по категории"
          />
          <button type="submit">Искать</button>
        </form>
        <button type="button" onClick={() => setCreating((v) => !v)} style={{ marginLeft: 'auto' }}>
          {creating ? 'Отмена' : '+ Ручная запись'}
        </button>
      </div>

      {creating && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleCreate();
          }}
          style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16, maxWidth: 640 }}
        >
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Заголовок"
            aria-label="Заголовок новой записи"
            required
          />
          <input
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
            placeholder="Категория"
            aria-label="Категория новой записи"
            required
          />
          <textarea
            value={newBody}
            onChange={(e) => setNewBody(e.target.value)}
            placeholder="Текст (HTML)"
            aria-label="Текст новой записи"
            rows={6}
            required
          />
          <div>
            <button type="submit" disabled={busy === 'create'}>
              {busy === 'create' ? '…' : 'Создать черновик'}
            </button>
          </div>
        </form>
      )}

      {error && (
        <p className="critical">
          {error}{' '}
          <button type="button" onClick={load}>
            Повторить
          </button>
        </p>
      )}

      {result && result.items.length === 0 && <p className="muted">Записей нет.</p>}

      {result && result.items.length > 0 && (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Запись</th>
                  <th>Источник</th>
                  <th>Категория</th>
                  <th>Оценка</th>
                  <th>Переводы</th>
                  <th>Статус</th>
                  <th>Создана</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((item) => (
                  <tr key={item.id}>
                    <td style={{ maxWidth: 320 }}>
                      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                        {item.thumbnailUrl && (
                          // Обложка лежит в НАШЕМ Blob: с этапа 95
                          // `downloadAndUploadBlogCoverImage` перезаливает
                          // её к себе, а `runCoverImageBackfill` догружает
                          // пропущенные. Комментарий здесь описывал
                          // состояние до этапа 95 и вводил в заблуждение
                          // ровно по тому вопросу (права на чужие
                          // материалы), где цена ошибки юридическая —
                          // исправлено аудитом блога 24.09.2026.
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={item.thumbnailUrl}
                            alt=""
                            style={{ width: 80, aspectRatio: '16 / 9', objectFit: 'cover', borderRadius: 6, flex: '0 0 auto' }}
                          />
                        )}
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 600 }}>{item.title}</div>
                          <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                            /{item.slug}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="muted">{SOURCE_LABEL[item.source]}</td>
                    <td>{item.category}</td>
                    <td className="muted tabular">{item.score ?? '—'}</td>
                    <td className="tabular" style={{ whiteSpace: 'nowrap' }}>
                      <span className="muted">
                        {item.translationsReady}/{item.translationsTotal}
                      </span>
                      <div
                        style={{ fontSize: 11, marginTop: 2 }}
                        className={
                          item.translationsState === 'failed'
                            ? 'critical'
                            : 'muted'
                        }
                        title={TRANSLATIONS_HINT[item.translationsState]}
                      >
                        {TRANSLATIONS_LABEL[item.translationsState]}
                      </div>
                    </td>
                    <td>
                      <span className={`badge-status badge-status-${STATUS_TONE[item.status]}`}>
                        {STATUS_LABEL[item.status]}
                      </span>
                    </td>
                    <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                      {new Date(item.createdAt).toLocaleString('ru-RU')}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <button type="button" disabled={busy === item.id} onClick={() => openDetail(item)}>
                          Открыть
                        </button>
                        {item.status === 'DRAFT' && (
                          <button
                            type="button"
                            disabled={busy !== null}
                            onClick={() => void runAction(item.id, () => approveBlogPost(item.id))}
                          >
                            {busy === item.id ? '…' : 'Одобрить'}
                          </button>
                        )}
                        {item.status === 'APPROVED' && (
                          <button
                            type="button"
                            disabled={busy !== null}
                            onClick={() => void runAction(item.id, () => publishBlogPost(item.id))}
                          >
                            {busy === item.id ? '…' : 'Опубликовать'}
                          </button>
                        )}
                        {item.status === 'PUBLISHED' && (
                          <button
                            type="button"
                            disabled={busy !== null}
                            onClick={() => void runAction(item.id, () => unpublishBlogPost(item.id))}
                          >
                            {busy === item.id ? '…' : 'Снять'}
                          </button>
                        )}
                        {(item.status === 'DRAFT' || item.status === 'APPROVED') &&
                          rejecting !== item.id && (
                            <button
                              type="button"
                              disabled={busy !== null}
                              onClick={() => {
                                setRejecting(item.id);
                                setReason('');
                              }}
                            >
                              Отклонить
                            </button>
                          )}
                        <button type="button" disabled={busy !== null} onClick={() => void handleDelete(item)}>
                          Удалить
                        </button>
                      </div>
                      {rejecting === item.id && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6, minWidth: 220 }}>
                          <textarea
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                            rows={2}
                            placeholder="Причина отклонения (обязательно)"
                            style={{ fontSize: 12 }}
                          />
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button
                              type="button"
                              onClick={() => void handleReject(item.id)}
                              disabled={busy !== null || !reason.trim()}
                            >
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

      {detail && (
        <section
          ref={detailRef}
          tabIndex={-1}
          style={{ marginTop: 24, borderTop: '1px solid #333', paddingTop: 16 }}
        >
          <h2>
            {detail.title}{' '}
            <button type="button" onClick={() => setDetail(null)}>
              Закрыть
            </button>
          </h2>
          <p className="muted" style={{ fontSize: 12 }}>
            Оригинал: {detail.originalLocale} · категория: {detail.category} ·
            создана {new Date(detail.createdAt).toLocaleString('ru-RU')}
            {detail.moderatorId && detail.moderatedAt && (
              <>
                {' '}
                · решение: {new Date(detail.moderatedAt as string).toLocaleString('ru-RU')} (
                {detail.moderatorId.slice(0, 8)}…)
              </>
            )}
          </p>
          {detail.rejectReason && (
            <p className="critical" style={{ fontSize: 12 }}>Причина отказа: {detail.rejectReason}</p>
          )}
          {detail.youtubeVideoId && (
            <p className="muted" style={{ fontSize: 12 }}>
              Источник:{' '}
              <a href={`https://youtube.com/watch?v=${detail.youtubeVideoId}`} target="_blank" rel="noreferrer">
                {detail.youtubeVideoId}
              </a>
              {detail.youtubeChannelTitle && ` · ${detail.youtubeChannelTitle}`}
              {detail.youtubeViewCount !== null && ` · ${detail.youtubeViewCount.toLocaleString('ru-RU')} просмотров`}
            </p>
          )}
          {detail.scoreReasoning && (
            <p className="muted" style={{ fontSize: 12 }}>Оценка Gemini ({detail.score}): {detail.scoreReasoning}</p>
          )}

          {!editing ? (
            <>
              <div
                style={{
                  whiteSpace: 'pre-wrap',
                  maxHeight: 320,
                  overflow: 'auto',
                  background: '#111',
                  padding: 12,
                  fontSize: 13,
                }}
                dangerouslySetInnerHTML={{ __html: detail.bodyHtml }}
              />
              <div style={{ marginTop: 8 }}>
                <button type="button" onClick={() => startEdit(detail)}>
                  Редактировать текст
                </button>
              </div>
            </>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 640 }}>
              <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} aria-label="Заголовок" />
              <input value={editCategory} onChange={(e) => setEditCategory(e.target.value)} aria-label="Категория" />
              <textarea value={editBody} onChange={(e) => setEditBody(e.target.value)} rows={8} aria-label="Текст (HTML)" />
              <p className="muted" style={{ fontSize: 12 }}>
                Правка текста сбросит готовые, поданные и провалившиеся
                переводы на «ждёт очереди» — крон переведёт заново по новому
                тексту. Правка одной категории переводов не трогает.
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" onClick={() => void saveEdit()} disabled={busy === detail.id}>
                  {busy === detail.id ? '…' : 'Сохранить'}
                </button>
                <button type="button" onClick={() => setEditing(false)} disabled={busy === detail.id}>
                  Отмена
                </button>
              </div>
            </div>
          )}

          <h3 style={{ marginTop: 20, fontSize: 14 }}>Переводы</h3>
          <div className="table-scroll">
            <table className="table-narrow">
              <thead>
                <tr>
                  <th>Локаль</th>
                  <th>Статус</th>
                  <th>Готово</th>
                  <th>Ошибка</th>
                </tr>
              </thead>
              <tbody>
                {detail.translations.map((t) => (
                  <tr key={t.locale}>
                    <td>{t.locale}</td>
                    <td className="muted">{t.status}</td>
                    <td className="muted">{t.translatedAt ? new Date(t.translatedAt).toLocaleString('ru-RU') : '—'}</td>
                    <td className="critical" style={{ fontSize: 12 }}>{t.errorMessage ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
