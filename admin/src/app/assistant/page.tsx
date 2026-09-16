'use client';

// Вкладка «ИИ-консультант» — три под-вкладки (§9/§10/§4.9 ТЗ,
// doc/LANDING-TUTORIAL-AI-CONSULTANT-SPEC.md,
// doc/TMA-UI-SNAPSHOT-AND-TUTORIAL-VIDEO-SPEC.md):
//  - «Обмены» — исходная лента вопросов посетителей + агрегаты, без
//    изменений (этап до 99).
//  - «Видео-контент» (этап 99, §4.9) — просмотр/одобрение
//    `TutorialVideoAsset`: без него собранные видео (этап 98) физически
//    недоступны никому, кроме прямого запроса к базе — консультант
//    (`AssistantService.resolveVideoActions`) отдаёт посетителю только
//    reviewed:true.
//  - «Состояние данных» (этап 99, §4.9) — агрегированная сводка:
//    версия базы знаний, число шагов на локаль, матрица покрытия видео,
//    последние прогоны генерации/исполнения сценариев.
// Вкладки — client-side `useState`, без новых Next.js-роутов (тот же
// принцип, что и остальная админка не разрослась в лишние /assistant/*
// страницы ради под-разделов одного экрана).
// Включение/выключение и сама настройка консультанта (бюджет, модель,
// проактивный режим) по-прежнему живут на /settings (AssistantSettingsCard).

import { Fragment, useCallback, useEffect, useState } from 'react';
import {
  getAssistantAdmin,
  getTutorialVideoAssets,
  getTutorialVideoDataStatus,
  publishTutorialVideo,
  setTutorialVideoReviewed,
} from '../../lib/endpoints';
import type {
  AssistantAdminResult,
  AssistantExchangeRow,
  PublicationPlatform,
  PublicationPrivacy,
  TutorialVideoAssetRow,
  TutorialVideoDataStatus,
} from '../../lib/types';
import { ApiRequestError } from '../../lib/admin-api';

const PLATFORM_LABEL: Record<PublicationPlatform, string> = { YOUTUBE: 'YouTube', TIKTOK: 'TikTok' };
const PRIVACY_LABEL: Record<PublicationPrivacy, string> = {
  PRIVATE: 'приватно',
  UNLISTED: 'по ссылке',
  PUBLIC: 'публично',
};

function errText(e: unknown): string {
  return e instanceof ApiRequestError ? e.message : 'Не удалось выполнить запрос';
}

function formatUsd(microUsd: number): string {
  return `$${(microUsd / 1_000_000).toFixed(4)}`;
}

function actionSummary(row: AssistantExchangeRow): string {
  if (!row.actions || row.actions.length === 0) return '—';
  return row.actions
    .map((a) => {
      switch (a.kind) {
        case 'open-app':
          return 'открыть приложение';
        case 'step':
          return `шаг ${a.stepId}`;
        case 'plan':
          return `тариф ${a.planId}`;
        case 'faq':
          return `FAQ #${a.faqIndex}`;
        case 'legal':
          return `документ ${a.slug}`;
        case 'video':
          return `видео ${a.subjectKey}`;
        default:
          return a.kind;
      }
    })
    .join(', ');
}

type Tab = 'exchanges' | 'videos' | 'data-status';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'exchanges', label: 'Обмены' },
  { key: 'videos', label: 'Видео-контент' },
  { key: 'data-status', label: 'Состояние данных' },
];

export default function AssistantAdminPage() {
  const [tab, setTab] = useState<Tab>('exchanges');

  return (
    <div className="page">
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>ИИ-консультант</h1>
      <p className="muted" style={{ marginBottom: 16 }}>
        Лента вопросов посетителей, видео обучалок для его ответов и состояние подсистемы. Включение, дневной
        бюджет, модель и проактивный режим — на вкладке «Настройки».
      </p>

      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid var(--border, #333)' }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            style={{
              padding: '8px 14px',
              border: 'none',
              borderBottom: tab === t.key ? '2px solid var(--accent, #4c8dff)' : '2px solid transparent',
              background: 'transparent',
              fontWeight: tab === t.key ? 600 : 400,
              cursor: 'pointer',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'exchanges' && <ExchangesTab />}
      {tab === 'videos' && <VideoContentTab />}
      {tab === 'data-status' && <DataStatusTab />}
    </div>
  );
}

// ── «Обмены» — без изменений в логике, вынесено в отдельный компонент ──

function ExchangesTab() {
  const [flagged, setFlagged] = useState<'' | 'true' | 'false'>('');
  const [locale, setLocale] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [days, setDays] = useState<7 | 30>(7);
  const [result, setResult] = useState<AssistantAdminResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    getAssistantAdmin({
      flagged: flagged === '' ? undefined : flagged === 'true',
      locale: locale || undefined,
      search: search.trim() || undefined,
      page,
      pageSize: 20,
      days,
    })
      .then(setResult)
      .catch((e) => setError(errText(e)));
  }, [flagged, locale, search, page, days]);

  useEffect(() => {
    load();
  }, [load]);

  const feed = result?.feed;
  const totalPages = feed ? Math.max(Math.ceil(feed.total / feed.pageSize), 1) : 1;
  const agg = days === 30 ? result?.aggregates30 ?? result?.aggregates7 : result?.aggregates7;

  return (
    <div>
      <p className="muted" style={{ marginBottom: 16 }}>
        Флаг «подозрительный» ставит пост-фильтр (§5.5 ТЗ) — сам ответ не блокируется и не изменяется, здесь
        только видно оператору для ревью.
      </p>

      {result && agg && (
        <div className="card" style={{ marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
            <h2 style={{ fontSize: 16, margin: 0 }}>Агрегаты</h2>
            <select
              aria-label="Окно агрегатов"
              value={days}
              onChange={(e) => setDays(Number(e.target.value) === 30 ? 30 : 7)}
            >
              <option value={7}>7 дней</option>
              <option value={30}>30 дней</option>
            </select>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24 }}>
            <div>
              <div className="muted" style={{ fontSize: 12 }}>
                Вопросов/день
              </div>
              <div style={{ fontSize: 20, fontWeight: 600 }}>{agg.questionsPerDay}</div>
            </div>
            <div>
              <div className="muted" style={{ fontSize: 12 }}>
                Средняя стоимость ответа
              </div>
              <div style={{ fontSize: 20, fontWeight: 600 }}>{formatUsd(agg.avgCostMicroUsd)}</div>
            </div>
            <div>
              <div className="muted" style={{ fontSize: 12 }}>
                Бюджет исчерпан (раз)
              </div>
              <div style={{ fontSize: 20, fontWeight: 600 }}>{agg.budgetExhaustedCount}</div>
            </div>
            <div>
              <div className="muted" style={{ fontSize: 12 }}>
                Доля с действием «открыть приложение»
              </div>
              <div style={{ fontSize: 20, fontWeight: 600 }}>{Math.round(agg.actionsOpenAppShare * 100)}%</div>
            </div>
          </div>
          {agg.topQuestions.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                Топ вопросов (нормализовано, без учёта регистра)
              </div>
              <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13 }}>
                {agg.topQuestions.slice(0, 10).map((q) => (
                  <li key={q.question}>
                    {q.question} <span className="muted">×{q.count}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {/* §10 упоминает и долю rate_limited — намеренно не считаем: guard
              отклоняет запрос ДО того, как он доходит до сервиса
              консультанта, отдельный аналитический хук туда не заводили
              (см. доккомментарий AssistantService.streamChat). */}
        </div>
      )}

      <div className="filters" style={{ marginBottom: 16, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <select
          aria-label="Фильтр по флагу пост-фильтра"
          value={flagged}
          onChange={(e) => {
            setFlagged(e.target.value as '' | 'true' | 'false');
            setPage(1);
          }}
        >
          <option value="">Все ответы</option>
          <option value="true">Только подозрительные</option>
          <option value="false">Без флага</option>
        </select>
        <select
          aria-label="Фильтр по локали"
          value={locale}
          onChange={(e) => {
            setLocale(e.target.value);
            setPage(1);
          }}
        >
          <option value="">Все локали</option>
          <option value="ru">ru</option>
          <option value="uk">uk</option>
          <option value="en">en</option>
          <option value="de">de</option>
          <option value="es">es</option>
        </select>
        <input
          type="text"
          placeholder="Поиск по тексту вопроса"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          style={{ minWidth: 220 }}
        />
      </div>

      {error && (
        <p className="critical">
          {error}{' '}
          <button type="button" onClick={load}>
            Повторить
          </button>
        </p>
      )}

      {!result && !error && <p className="muted">Загрузка…</p>}

      {feed && feed.rows.length === 0 && <p className="muted">Обменов нет.</p>}

      {feed && feed.rows.length > 0 && (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Когда</th>
                  <th>Локаль/страница</th>
                  <th>Вопрос</th>
                  <th>Действия</th>
                  <th>Стоимость</th>
                  <th>Флаг</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {feed.rows.map((row) => (
                  <Fragment key={row.id}>
                    <tr>
                      <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                        {new Date(row.createdAt).toLocaleString('ru-RU')}
                      </td>
                      <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                        {row.locale} / {row.page}
                        {row.stepId ? ` (шаг ${row.stepId})` : ''}
                        {row.triggeredBy === 'proactive' ? ' · проактивно' : ''}
                      </td>
                      <td style={{ maxWidth: 360 }}>
                        {row.question.length > 140 ? `${row.question.slice(0, 140)}…` : row.question}
                      </td>
                      <td className="muted" style={{ fontSize: 12 }}>
                        {actionSummary(row)}
                      </td>
                      <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                        {formatUsd(row.costMicroUsd)}
                      </td>
                      <td>
                        {row.flagged && <span className="badge-status badge-status-warning">подозрительный</span>}
                      </td>
                      <td>
                        <button type="button" onClick={() => setExpanded(expanded === row.id ? null : row.id)}>
                          {expanded === row.id ? 'Скрыть' : 'Открыть'}
                        </button>
                      </td>
                    </tr>
                    {expanded === row.id && (
                      <tr>
                        <td colSpan={7} style={{ background: 'var(--bg-alt, rgba(255,255,255,0.03))' }}>
                          <div style={{ padding: '8px 4px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                            <div>
                              <strong>Вопрос:</strong> <span style={{ whiteSpace: 'pre-wrap' }}>{row.question}</span>
                            </div>
                            <div>
                              <strong>Ответ:</strong> <span style={{ whiteSpace: 'pre-wrap' }}>{row.answer}</span>
                            </div>
                            <div className="muted" style={{ fontSize: 12 }}>
                              Токены: {row.inTokens} вход / {row.outTokens} выход / {row.cachedTokens} кэш ·
                              Задержка: {row.latencyMs} мс
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 16 }}>
            <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              ← Назад
            </button>
            <span className="muted">
              {page} / {totalPages} · всего {feed.total}
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

// ── «Видео-контент» (этап 99, §4.9) ──

function assemblyStatusLabel(status: TutorialVideoAssetRow['assemblyStatus']): string {
  switch (status) {
    case 'pending':
      return 'в очереди';
    case 'submitted':
      return 'собирается';
    case 'completed':
      return 'готово';
    case 'failed':
      return 'ошибка';
    default:
      return status;
  }
}

function VideoContentTab() {
  const [subjectKey, setSubjectKey] = useState('');
  const [locale, setLocale] = useState('');
  const [reviewed, setReviewedFilter] = useState<'' | 'true' | 'false'>('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<{ rows: TutorialVideoAssetRow[]; total: number; pageSize: number } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Этап 101 (ТЗ §4.7, Фаза 3) — публикация в YouTube/TikTok прямо с
  // этой вкладки, тот же приём формы, что «Одобрить/Отклонить» на
  // /admin/publications: раскрывается по клику, channelId — свободный
  // ввод (угадывать канал неоткуда — у обучающего видео нет ни проекта,
  // ни бренд-манифеста).
  const [publishingId, setPublishingId] = useState<string | null>(null);
  const [publishPlatform, setPublishPlatform] = useState<PublicationPlatform>('YOUTUBE');
  const [publishChannelId, setPublishChannelId] = useState('');
  const [publishPrivacy, setPublishPrivacy] = useState<PublicationPrivacy>('UNLISTED');

  const load = useCallback(() => {
    setError(null);
    getTutorialVideoAssets({
      subjectKey: subjectKey.trim() || undefined,
      locale: locale || undefined,
      reviewed: reviewed === '' ? undefined : reviewed === 'true',
      page,
      pageSize: 20,
    })
      .then(setResult)
      .catch((e) => setError(errText(e)));
  }, [subjectKey, locale, reviewed, page]);

  useEffect(() => {
    load();
  }, [load]);

  const totalPages = result ? Math.max(Math.ceil(result.total / result.pageSize), 1) : 1;

  const toggleReviewed = useCallback(
    async (row: TutorialVideoAssetRow) => {
      // §4.9 — предупреждение прямо в моменте действия: одобрение делает
      // видео ЖИВЫМ для посетителей лендинга немедленно (консультант
      // резолвит kind:"video" только среди reviewed:true, см.
      // AssistantService.resolveVideoActions), не «ставит в очередь на
      // публикацию».
      if (!row.reviewed) {
        const ok = window.confirm(
          `Одобрить видео «${row.title}» (${row.subjectKey}, ${row.locale})?\n\n` +
            'Оно станет доступно посетителям лендинга НЕМЕДЛЕННО — консультант сможет ' +
            'предлагать его в ответах прямо со следующего запроса.',
        );
        if (!ok) return;
      }
      setBusyId(row.id);
      setError(null);
      try {
        await setTutorialVideoReviewed(row.id, !row.reviewed);
        load();
      } catch (e) {
        setError(errText(e));
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  const handlePublish = useCallback(
    async (row: TutorialVideoAssetRow) => {
      if (!publishChannelId.trim()) return;
      setBusyId(row.id);
      setError(null);
      try {
        await publishTutorialVideo(row.id, {
          platform: publishPlatform,
          channelId: publishChannelId.trim(),
          privacy: publishPrivacy,
        });
        setPublishingId(null);
        setPublishChannelId('');
        setPublishPrivacy('UNLISTED');
      } catch (e) {
        setError(errText(e));
      } finally {
        setBusyId(null);
      }
    },
    [publishPlatform, publishChannelId, publishPrivacy],
  );

  return (
    <div>
      <p className="muted" style={{ marginBottom: 16 }}>
        Кадры-слайдшоу, собранные исполнителем сценариев (этап 98), становятся доступны консультанту на лендинге
        ТОЛЬКО после одобрения здесь — иначе они физически недоступны никому, кроме прямого запроса к базе.
      </p>

      <div className="filters" style={{ marginBottom: 16, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="text"
          placeholder="Поиск по subjectKey"
          value={subjectKey}
          onChange={(e) => {
            setSubjectKey(e.target.value);
            setPage(1);
          }}
          style={{ minWidth: 200 }}
        />
        <select
          aria-label="Фильтр по локали"
          value={locale}
          onChange={(e) => {
            setLocale(e.target.value);
            setPage(1);
          }}
        >
          <option value="">Все локали</option>
          <option value="ru">ru</option>
          <option value="uk">uk</option>
          <option value="en">en</option>
          <option value="de">de</option>
          <option value="es">es</option>
        </select>
        <select
          aria-label="Фильтр по одобрению"
          value={reviewed}
          onChange={(e) => {
            setReviewedFilter(e.target.value as '' | 'true' | 'false');
            setPage(1);
          }}
        >
          <option value="">Все</option>
          <option value="true">Одобренные</option>
          <option value="false">Неодобренные</option>
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

      {!result && !error && <p className="muted">Загрузка…</p>}

      {result && result.rows.length === 0 && <p className="muted">Видео нет.</p>}

      {result && result.rows.length > 0 && (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Когда</th>
                  <th>subjectKey / локаль</th>
                  <th>Заголовок</th>
                  <th>Сборка</th>
                  <th>Кадры</th>
                  <th>Одобрено</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row) => (
                  <Fragment key={row.id}>
                    <tr>
                      <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                        {new Date(row.createdAt).toLocaleString('ru-RU')}
                      </td>
                      <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                        {row.subjectKey} / {row.locale}
                      </td>
                      <td style={{ maxWidth: 280 }}>{row.title}</td>
                      <td>
                        <span
                          className={`badge-status ${
                            row.assemblyStatus === 'completed'
                              ? 'badge-status-ok'
                              : row.assemblyStatus === 'failed'
                                ? 'badge-status-critical'
                                : 'badge-status-warning'
                          }`}
                        >
                          {assemblyStatusLabel(row.assemblyStatus)}
                        </span>
                        {row.assemblyError && (
                          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                            {row.assemblyError}
                          </div>
                        )}
                      </td>
                      <td className="muted">{row.frameCount ?? '—'}</td>
                      <td>
                        {row.reviewed ? (
                          <span className="badge-status badge-status-ok">одобрено</span>
                        ) : (
                          <span className="muted">нет</span>
                        )}
                      </td>
                      <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {row.blobUrl && (
                          <button type="button" onClick={() => setPreviewId(previewId === row.id ? null : row.id)}>
                            {previewId === row.id ? 'Скрыть' : 'Просмотр'}
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={!row.blobUrl || busyId === row.id}
                          onClick={() => toggleReviewed(row)}
                        >
                          {row.reviewed ? 'Снять одобрение' : 'Одобрить'}
                        </button>
                        {/* Этап 101 (§4.7): публиковать можно только уже
                            одобренное видео — тот же порядок, что требует спека
                            (§4.6): сначала «показать посетителям», отдельно —
                            «выложить на YouTube/TikTok». */}
                        {row.reviewed && row.blobUrl && (
                          <button
                            type="button"
                            disabled={busyId === row.id}
                            onClick={() => {
                              setPublishingId(publishingId === row.id ? null : row.id);
                              setPublishChannelId('');
                            }}
                          >
                            {publishingId === row.id ? 'Скрыть' : 'Опубликовать'}
                          </button>
                        )}
                      </td>
                    </tr>
                    {previewId === row.id && row.blobUrl && (
                      <tr>
                        <td colSpan={7} style={{ background: 'var(--bg-alt, rgba(255,255,255,0.03))' }}>
                          <div style={{ padding: '8px 4px' }}>
                            {/* eslint-disable-next-line jsx-a11y/media-has-caption -- служебный предпросмотр слайдшоу для оператора, не публичный контент */}
                            <video controls src={row.blobUrl} style={{ maxWidth: 480, width: '100%' }} />
                          </div>
                        </td>
                      </tr>
                    )}
                    {publishingId === row.id && (
                      <tr>
                        <td colSpan={7} style={{ background: 'var(--bg-alt, rgba(255,255,255,0.03))' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 4px', maxWidth: 320 }}>
                            <span className="muted" style={{ fontSize: 12 }}>
                              Канал должен быть подключён именно вашим оператором-аккаунтом
                              (вкладка «Каналы» TMA) — заявку подхватит тот же крон-воркер
                              выгрузки, что и рекламные ролики.
                            </span>
                            <label style={{ fontSize: 12 }}>
                              Площадка
                              <select
                                value={publishPlatform}
                                onChange={(e) => setPublishPlatform(e.target.value as PublicationPlatform)}
                                style={{ display: 'block', width: '100%', marginTop: 2 }}
                              >
                                {(Object.keys(PLATFORM_LABEL) as PublicationPlatform[]).map((p) => (
                                  <option key={p} value={p}>
                                    {PLATFORM_LABEL[p]}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label style={{ fontSize: 12 }}>
                              Приватность
                              <select
                                value={publishPrivacy}
                                onChange={(e) => setPublishPrivacy(e.target.value as PublicationPrivacy)}
                                style={{ display: 'block', width: '100%', marginTop: 2 }}
                              >
                                {(Object.keys(PRIVACY_LABEL) as PublicationPrivacy[]).map((p) => (
                                  <option key={p} value={p}>
                                    {PRIVACY_LABEL[p]}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label style={{ fontSize: 12 }}>
                              Канал (id, обязательно)
                              <input
                                type="text"
                                value={publishChannelId}
                                onChange={(e) => setPublishChannelId(e.target.value)}
                                placeholder="id канала"
                                style={{ display: 'block', width: '100%', marginTop: 2, fontSize: 12 }}
                              />
                            </label>
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button
                                type="button"
                                onClick={() => void handlePublish(row)}
                                disabled={busyId === row.id || !publishChannelId.trim()}
                              >
                                {busyId === row.id ? '…' : 'Подтвердить'}
                              </button>
                              <button type="button" onClick={() => setPublishingId(null)} disabled={busyId === row.id}>
                                Отмена
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
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

// ── «Состояние данных» (этап 99, §4.9) ──

function DataStatusTab() {
  const [data, setData] = useState<TutorialVideoDataStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    getTutorialVideoDataStatus().then(setData).catch((e) => setError(errText(e)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (error) {
    return (
      <p className="critical">
        {error}{' '}
        <button type="button" onClick={load}>
          Повторить
        </button>
      </p>
    );
  }

  if (!data) return <p className="muted">Загрузка…</p>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div className="card">
        <h2 style={{ fontSize: 16, marginTop: 0 }}>База знаний ассистента</h2>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <div>
            <div className="muted" style={{ fontSize: 12 }}>
              Собрана
            </div>
            <div>{new Date(data.knowledge.builtAt).toLocaleString('ru-RU')}</div>
          </div>
          <div>
            <div className="muted" style={{ fontSize: 12 }}>
              Коммит
            </div>
            <div>{data.knowledge.commit}</div>
          </div>
        </div>
      </div>

      <div className="card">
        <h2 style={{ fontSize: 16, marginTop: 0 }}>Шагов обучалки по локалям</h2>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          {Object.entries(data.stepCounts).map(([loc, count]) => (
            <div key={loc}>
              <div className="muted" style={{ fontSize: 12 }}>
                {loc}
              </div>
              <div style={{ fontSize: 20, fontWeight: 600 }}>{count}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h2 style={{ fontSize: 16, marginTop: 0 }}>Покрытие обучающими видео (одобренные)</h2>
        {data.videoCoverage.length === 0 ? (
          <p className="muted">Ни одного одобренного видео пока нет.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>subjectKey</th>
                  <th>Локаль</th>
                  <th>Одобренных версий</th>
                </tr>
              </thead>
              <tbody>
                {data.videoCoverage.map((cell) => (
                  <tr key={`${cell.subjectKey}__${cell.locale}`}>
                    <td>{cell.subjectKey}</td>
                    <td>{cell.locale}</td>
                    <td>{cell.reviewedCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2 style={{ fontSize: 16, marginTop: 0 }}>Последние прогоны</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Джоба</th>
                <th>Статус</th>
                <th>Начат</th>
                <th>Завершён</th>
                <th>Сводка</th>
              </tr>
            </thead>
            <tbody>
              {data.lastRuns.map((run) => (
                <tr key={run.jobKey}>
                  <td className="muted">{run.jobKey}</td>
                  <td>
                    {run.status ? (
                      <span
                        className={`badge-status ${
                          run.status === 'SUCCESS'
                            ? 'badge-status-ok'
                            : run.status === 'FAILED'
                              ? 'badge-status-critical'
                              : 'badge-status-warning'
                        }`}
                      >
                        {run.status}
                      </span>
                    ) : (
                      <span className="muted">ещё не запускалась</span>
                    )}
                  </td>
                  <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                    {run.startedAt ? new Date(run.startedAt).toLocaleString('ru-RU') : '—'}
                  </td>
                  <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                    {run.finishedAt ? new Date(run.finishedAt).toLocaleString('ru-RU') : '—'}
                  </td>
                  <td className="muted">{run.errorMessage ?? run.summary ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
