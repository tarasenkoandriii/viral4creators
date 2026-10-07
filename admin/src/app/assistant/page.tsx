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

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import {
  getAssistantAdmin,
  getDemoQualityChecks,
  getDemoQualityOverrides,
  getTutorialVideoAssets,
  getTutorialVideoDataStatus,
  publishTutorialVideo,
  requestDemoQualityApproved,
  requestDemoQualityCheck,
  overrideDemoQualityVerdict,
  setTutorialVideoReviewed,
  setTutorialVideoSiteTutorialDemo,
} from '../../lib/endpoints';
import type {
  AssistantAdminResult,
  AssistantExchangeRow,
  DemoQualityCheck,
  DemoQualityOverrideEntry,
  DemoQualityVerdict,
  PublicationPlatform,
  PublicationPrivacy,
  TutorialVideoAssetRow,
  TutorialVideoDataStatus,
} from '../../lib/types';
import { ApiRequestError } from '../../lib/admin-api';
import { TutorialTempoPanel } from './TutorialTempoPanel';
import {
  captureModeLabel,
  categoryLabel,
  checkResultLabel,
  effectiveVerdictOf,
  enqueueMessage,
  formatCost,
  formatTimecode,
  freshnessLabel,
  overrideReasonProblem,
  qualityBadge,
  SEVERITY_LABEL,
  SEVERITY_TONE,
  signalsSummary,
  sortIssues,
  VERDICT_LABEL,
} from '../../lib/demo-quality';

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

/** Переход с «Обзора» (дашборд внимания): `?tab=videos&reviewed=false
 * &subjectKey=2&locale=ru&tempo=<assetId>` — открыть нужную вкладку с
 * фильтром и, если указан `tempo`, панель темпа этого ролика; `quality`
 * — отчёт проверки качества этого ролика. */
interface VideoTabInit {
  subjectKey: string;
  locale: string;
  reviewed: '' | 'true' | 'false';
  tempo: string | null;
  quality: string | null;
}

function readDeepLink(): { tab: Tab | null; video: VideoTabInit } {
  const p = new URLSearchParams(window.location.search);
  const t = p.get('tab');
  const r = p.get('reviewed');
  return {
    tab: t === 'exchanges' || t === 'videos' || t === 'data-status' ? t : null,
    video: {
      subjectKey: p.get('subjectKey') ?? '',
      locale: p.get('locale') ?? '',
      reviewed: r === 'true' || r === 'false' ? r : '',
      tempo: p.get('tempo'),
      quality: p.get('quality'),
    },
  };
}

export default function AssistantAdminPage() {
  const [tab, setTab] = useState<Tab>('exchanges');
  const [videoInit, setVideoInit] = useState<VideoTabInit | null>(null);

  useEffect(() => {
    const link = readDeepLink();
    if (link.tab) setTab(link.tab);
    setVideoInit(link.video);
  }, []);

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
      {tab === 'videos' && <VideoContentTab key={videoInit ? 'linked' : 'plain'} init={videoInit} />}
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
    case 'preparing':
      return 'кадры грузятся';
    case 'pending':
      return 'собирается';
    case 'complete':
      return 'готово';
    case 'failed':
      return 'ошибка';
    default:
      return status;
  }
}

/** Слот демо обучающего лендинга — ровно один из трёх (бэкенд проверяет
 *  то же самое и откажет любому другому ключу). */
function isSiteTutorialDemoSlot(subjectKey: string): boolean {
  return /^site-tutorial-demo-[1-3]$/.test(subjectKey);
}

function VideoContentTab({ init }: { init: VideoTabInit | null }) {
  const [subjectKey, setSubjectKey] = useState(init?.subjectKey ?? '');
  const [locale, setLocale] = useState(init?.locale ?? '');
  const [reviewed, setReviewedFilter] = useState<'' | 'true' | 'false'>(init?.reviewed ?? '');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<{
    rows: TutorialVideoAssetRow[];
    total: number;
    pageSize: number;
    siteTutorialDemoAssetIds?: string[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  // Темп (06.10.2026): панель версий с другим темпом под строкой ролика.
  const [tempoId, setTempoId] = useState<string | null>(init?.tempo ?? null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Проверка качества демо (06.10.2026): последняя проверка каждого ролика
  // страницы, раскрытый отчёт и плееры для перемотки к таймкоду. Фаза
  // наблюдения — одобрение отсюда не меняется.
  const [quality, setQuality] = useState<Record<string, DemoQualityCheck>>({});
  const [qualityEnabled, setQualityEnabled] = useState<boolean | null>(null);
  const [qualityError, setQualityError] = useState<string | null>(null);
  const [qualityMsg, setQualityMsg] = useState<string | null>(null);
  const [reportId, setReportId] = useState<string | null>(init?.quality ?? null);
  const [approvedBusy, setApprovedBusy] = useState(false);
  const videoRefs = useRef<Record<string, HTMLVideoElement | null>>({});
  const [seek, setSeek] = useState<{ id: string; ms: number; n: number } | null>(null);
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

  const loadQuality = useCallback((ids: string[]) => {
    if (ids.length === 0) {
      setQuality({});
      return;
    }
    getDemoQualityChecks(ids)
      .then((res) => {
        setQuality(res.checks);
        setQualityEnabled(res.enabled);
        setQualityError(null);
      })
      .catch((e) => setQualityError(errText(e)));
  }, []);

  useEffect(() => {
    if (result) loadQuality(result.rows.map((r) => r.id));
  }, [result, loadQuality]);

  // Клик по таймкоду: открыть плеер ролика и перемотать. Плеер может ещё
  // не иметь метаданных — тогда перемотка после `loadedmetadata`.
  useEffect(() => {
    if (!seek) return;
    const el = videoRefs.current[seek.id];
    if (!el) return;
    const apply = () => {
      el.currentTime = seek.ms / 1000;
    };
    if (el.readyState >= 1) apply();
    else el.addEventListener('loadedmetadata', apply, { once: true });
    el.scrollIntoView({ block: 'nearest' });
  }, [seek, previewId]);

  const seekTo = useCallback((id: string, ms: number) => {
    setPreviewId(id);
    setSeek((prev) => ({ id, ms, n: (prev?.n ?? 0) + 1 }));
  }, []);

  const checkQuality = useCallback(async (row: TutorialVideoAssetRow) => {
    setBusyId(row.id);
    setQualityMsg(null);
    setError(null);
    try {
      const res = await requestDemoQualityCheck(row.id);
      setQualityMsg(enqueueMessage(res));
      setQuality((prev) => ({ ...prev, [row.id]: res.check }));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusyId(null);
    }
  }, []);

  const checkApproved = useCallback(async () => {
    setApprovedBusy(true);
    setQualityMsg(null);
    setError(null);
    try {
      const res = await requestDemoQualityApproved();
      setQualityMsg(
        `Поставлено в очередь: ${res.queued} (потолок за нажатие — ${res.cap}); уже проверены или в очереди: ${res.skipped}` +
          (res.remaining > 0 ? `; осталось ${res.remaining} — нажмите ещё раз позже.` : '.'),
      );
      if (result) loadQuality(result.rows.map((r) => r.id));
    } catch (e) {
      setError(errText(e));
    } finally {
      setApprovedBusy(false);
    }
  }, [result, loadQuality]);

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
          isSiteTutorialDemoSlot(row.subjectKey)
            ? `Одобрить видео «${row.title}» (${row.subjectKey}, ${row.locale})?\n\n` +
                'Это демо обучающего лендинга: консультант его не предлагает, а на лендинг ' +
                'оно попадёт только после галочки «В демо обучающего лендинга».'
            : `Одобрить видео «${row.title}» (${row.subjectKey}, ${row.locale})?\n\n` +
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

  const markedDemo = new Set(result?.siteTutorialDemoAssetIds ?? []);

  const toggleSiteTutorialDemo = useCallback(
    async (row: TutorialVideoAssetRow, marked: boolean) => {
      if (marked) {
        const ok = window.confirm(
          `Показать «${row.title}» (${row.subjectKey}, ${row.locale}, ${row.theme ?? 'светлая'}) ` +
            'в демо обучающего лендинга?\n\n' +
            'Ролик станет виден посетителям /site-tutorial, как только на лендинге включён ' +
            'SITE_TUTORIAL_DEMO_GALLERY (с учётом кеша — до ~10 минут).',
        );
        if (!ok) return;
      }
      setBusyId(row.id);
      setError(null);
      try {
        await setTutorialVideoSiteTutorialDemo(row.id, marked);
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
        Ролики демо обучающего лендинга (<code>site-tutorial-demo-1..3</code>, витрина-полигон) консультанту
        не выдаются: на лендинг их выводит только галочка «В демо обучающего лендинга» у одобренного ролика.
      </p>

      <div style={{ marginBottom: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => void checkApproved()}
          disabled={approvedBusy || qualityEnabled === false}
          title="Поставить одобренные ролики в очередь ИИ-проверки качества (с потолком за нажатие)"
        >
          {approvedBusy ? 'Ставим…' : 'Проверить все одобренные'}
        </button>
        <span className="muted" style={{ fontSize: 12 }}>
          {qualityEnabled === false
            ? 'ИИ-проверка качества выключена (TUTORIAL_DEMO_QUALITY_ENABLED).'
            : 'ИИ-проверка качества — режим наблюдения: отчёт и сигнал, одобрение она не меняет.'}
        </span>
      </div>
      {qualityMsg && (
        <p className="muted" role="status" style={{ marginTop: 0 }}>
          {qualityMsg}
        </p>
      )}
      {qualityError && <p className="critical">Проверки качества не загрузились: {qualityError}</p>}

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
                  <th>Тема</th>
                  <th>Сборка</th>
                  <th>Кадры</th>
                  <th>Качество</th>
                  <th>Одобрено</th>
                  <th title="Отметка оператора: ролик выдаётся в галерее /site-tutorial (только слоты site-tutorial-demo-1..3)">
                    В демо обучающего лендинга
                  </th>
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
                      <td className="muted" title="Тема интерфейса на съёмке">
                        {row.theme === 'light' ? 'светлая' : row.theme === 'dark' ? 'тёмная' : '—'}
                      </td>
                      <td>
                        <span
                          className={`badge-status ${
                            row.assemblyStatus === 'complete'
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
                        <QualityBadge check={quality[row.id]} />
                      </td>
                      <td>
                        {row.reviewed ? (
                          <span className="badge-status badge-status-ok">одобрено</span>
                        ) : (
                          <span className="muted">нет</span>
                        )}
                      </td>
                      <td>
                        {isSiteTutorialDemoSlot(row.subjectKey) ? (
                          <label
                            style={{ display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 12 }}
                            title={
                              row.reviewed && row.blobUrl
                                ? 'Показывать в демо обучающего лендинга'
                                : 'Отметить можно только одобренный собранный ролик'
                            }
                          >
                            <input
                              type="checkbox"
                              checked={markedDemo.has(row.id)}
                              disabled={
                                busyId === row.id ||
                                (!markedDemo.has(row.id) && !(row.reviewed && row.blobUrl))
                              }
                              onChange={(e) => void toggleSiteTutorialDemo(row, e.target.checked)}
                            />
                            {markedDemo.has(row.id) ? 'в демо' : 'нет'}
                          </label>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {row.blobUrl && (
                          <button type="button" onClick={() => setPreviewId(previewId === row.id ? null : row.id)}>
                            {previewId === row.id ? 'Скрыть' : 'Просмотр'}
                          </button>
                        )}
                        {row.assemblyStatus === 'complete' && row.blobUrl && (
                          <button
                            type="button"
                            disabled={busyId === row.id || qualityEnabled === false}
                            onClick={() => void checkQuality(row)}
                            title="Поставить ролик в очередь ИИ-проверки качества"
                          >
                            Проверить
                          </button>
                        )}
                        {quality[row.id] && (
                          <button type="button" onClick={() => setReportId(reportId === row.id ? null : row.id)}>
                            {reportId === row.id ? 'Скрыть отчёт' : 'Отчёт'}
                          </button>
                        )}
                        {row.assemblyStatus === 'complete' && row.blobUrl && (
                          <button type="button" onClick={() => setTempoId(tempoId === row.id ? null : row.id)}>
                            {tempoId === row.id ? 'Скрыть темп' : 'Темп'}
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
                        <td colSpan={10} style={{ background: 'var(--bg-alt, rgba(255,255,255,0.03))' }}>
                          <div style={{ padding: '8px 4px' }}>
                            {/* eslint-disable-next-line jsx-a11y/media-has-caption -- служебный предпросмотр слайдшоу для оператора, не публичный контент */}
                            <video
                              controls
                              src={row.blobUrl}
                              style={{ maxWidth: 480, width: '100%' }}
                              ref={(el) => {
                                videoRefs.current[row.id] = el;
                              }}
                            />
                          </div>
                        </td>
                      </tr>
                    )}
                    {reportId === row.id && quality[row.id] && (
                      <tr>
                        <td colSpan={10} style={{ background: 'var(--bg-alt, rgba(255,255,255,0.03))' }}>
                          <QualityReportPanel
                            check={quality[row.id]}
                            canSeek={!!row.blobUrl}
                            onSeek={(ms) => seekTo(row.id, ms)}
                            onChanged={(c) => setQuality((prev) => ({ ...prev, [row.id]: c }))}
                          />
                        </td>
                      </tr>
                    )}
                    {tempoId === row.id && (
                      <tr>
                        <td colSpan={10} style={{ background: 'var(--bg-alt, rgba(255,255,255,0.03))' }}>
                          <TutorialTempoPanel assetId={row.id} onChanged={load} />
                        </td>
                      </tr>
                    )}
                    {publishingId === row.id && (
                      <tr>
                        <td colSpan={10} style={{ background: 'var(--bg-alt, rgba(255,255,255,0.03))' }}>
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

// ── Проверка качества демо (06.10.2026) ──

function QualityBadge({ check }: { check: DemoQualityCheck | undefined }) {
  const badge = qualityBadge(check);
  if (badge.tone === 'muted') {
    return (
      <span className="muted" style={{ whiteSpace: 'nowrap' }}>
        {badge.label}
      </span>
    );
  }
  return <span className={`badge-status badge-status-${badge.tone}`}>{badge.label}</span>;
}

/** Раскрываемый отчёт: сводка, оценки, тема/язык/актуальность и
 *  замечания с таймкодами (клик — перемотка плеера ролика). */
function QualityReportPanel({
  check,
  canSeek,
  onSeek,
  onChanged,
}: {
  check: DemoQualityCheck;
  canSeek: boolean;
  onSeek: (ms: number) => void;
  onChanged: (check: DemoQualityCheck) => void;
}) {
  const report = check.report;
  const signals = signalsSummary(check);
  return (
    <div style={{ padding: '8px 4px', display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 760 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <strong>ИИ-проверка качества</strong>
        <QualityBadge check={check} />
        <span className="muted" style={{ fontSize: 12 }}>
          {check.modelId} · {check.rubricVersion}
          {check.versionId ? ` · версия ${check.versionId}` : ''}
          {check.checkedAt ? ` · ${new Date(check.checkedAt).toLocaleString('ru-RU')}` : ''}
          {check.status === 'complete' ? ` · ${formatCost(check)}` : ''}
          {check.reusedFromId ? ' · результат прежней проверки того же файла' : ''}
          {` · ${captureModeLabel(check.captureMode)}`}
        </span>
      </div>
      {check.status === 'error' && (
        <p className="critical" style={{ margin: 0 }}>
          Сбой проверки (не вердикт ролику): {check.error ?? 'без текста'}. Нажмите «Проверить», чтобы запустить заново.
        </p>
      )}
      {(check.status === 'pending' || check.status === 'running') && (
        <p className="muted" style={{ margin: 0 }}>
          В работе: фаза «{check.phase === 'upload' ? 'загрузка' : check.phase === 'wait' ? 'ожидание' : 'анализ'}»
          {check.attempts > 0 ? `, попытка ${check.attempts + 1} из 3` : ''}
          {check.nextAttemptAt ? `, не раньше ${new Date(check.nextAttemptAt).toLocaleString('ru-RU')}` : ''}
          {check.error ? ` — ${check.error}` : ''}.
        </p>
      )}
      {report && (
        <>
          {report.summary && <p style={{ margin: 0 }}>{report.summary}</p>}
          {report.invalid && (
            <p className="muted" style={{ margin: 0 }}>
              Ответ модели не принят: {report.invalid} — нужен взгляд оператора.
            </p>
          )}
          {report.scores && (
            <div className="muted" style={{ fontSize: 12 }}>
              Читаемость {report.scores.readability} · шаги/подписи {report.scores.stepMatch} · темп {report.scores.pacing} ·
              согласованность {report.scores.consistency} (порог ok — 80)
            </div>
          )}
          <div className="muted" style={{ fontSize: 12 }}>
            Тема: {checkResultLabel(report.theme.result)} (заявлена {report.theme.expected ?? '—'}, видна {report.theme.observed}) · Язык{' '}
            {report.language.expected}: {checkResultLabel(report.language.result)} (речь {report.language.speech}, подписи{' '}
            {report.language.captions}) · {freshnessLabel(report.freshness)}
          </div>
          {report.issues.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              Замечаний нет.
            </p>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {sortIssues(report.issues).map((issue, i) => (
                <li key={`${issue.startMs}-${i}`}>
                  {canSeek ? (
                    <button
                      type="button"
                      onClick={() => onSeek(issue.startMs)}
                      title="Перемотать плеер к этому месту"
                      style={{ fontFamily: 'monospace', marginRight: 6 }}
                    >
                      {formatTimecode(issue.startMs)}
                    </button>
                  ) : (
                    <span style={{ fontFamily: 'monospace', marginRight: 6 }}>{formatTimecode(issue.startMs)}</span>
                  )}
                  <span
                    className={
                      SEVERITY_TONE[issue.severity] === 'muted'
                        ? 'muted'
                        : `badge-status badge-status-${SEVERITY_TONE[issue.severity]}`
                    }
                    style={{ marginRight: 6 }}
                  >
                    {SEVERITY_LABEL[issue.severity] ?? issue.severity}
                  </span>
                  <span className="muted" style={{ marginRight: 6 }}>
                    {categoryLabel(issue.category)}
                  </span>
                  {issue.explanation}
                </li>
              ))}
            </ul>
          )}
          {report.missingEvidence.length > 0 && (
            <div className="muted" style={{ fontSize: 12 }}>
              Не удалось проверить: {report.missingEvidence.join('; ')}
            </div>
          )}
          {report.droppedIssues > 0 && (
            <div className="muted" style={{ fontSize: 12 }}>
              Отброшено замечаний без проверяемого таймкода: {report.droppedIssues}
            </div>
          )}
        </>
      )}
      {signals && (
        <div className={check.signals?.status === 'error' ? 'critical' : 'muted'} style={{ fontSize: 12 }}>
          {signals}
        </div>
      )}
      {check.controlFrames && check.controlFrames.length > 0 && (
        <ControlFramesStrip frames={check.controlFrames} canSeek={canSeek} onSeek={onSeek} />
      )}
      {check.status === 'complete' && <QualityOverrideForm check={check} onChanged={onChanged} />}
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        Проверка не ставит и не снимает одобрение — решение за оператором. При включённой блокировке публикации
        (TUTORIAL_DEMO_QUALITY_BLOCK) итоговый fail не даёт одобрить ролик, отметить его «в демо» и одобрить версию
        темпа — до исправления или переопределения с причиной.
      </p>
    </div>
  );
}

/** Контрольные кадры шагов (заход 7): снимок шага и его таймкод в этом
 *  файле — сверить, что видно в ролике, с тем, что снималось. */
function ControlFramesStrip({
  frames,
  canSeek,
  onSeek,
}: {
  frames: NonNullable<DemoQualityCheck['controlFrames']>;
  canSeek: boolean;
  onSeek: (ms: number) => void;
}) {
  return (
    <div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
        Контрольные кадры шагов (клик по таймкоду — перемотка ролика):
      </div>
      <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4 }}>
        {frames.map((f) => (
          <figure key={`${f.stepIndex}-${f.startMs}`} style={{ margin: 0, width: 96, flex: '0 0 auto' }}>
            <a href={f.imageUrl} target="_blank" rel="noreferrer">
              {/* eslint-disable-next-line @next/next/no-img-element -- снимок из Blob, без оптимизатора */}
              <img
                src={f.imageUrl}
                alt={f.caption ?? `шаг ${f.stepIndex}`}
                loading="lazy"
                style={{ width: 96, height: 'auto', display: 'block', borderRadius: 4 }}
              />
            </a>
            <figcaption style={{ fontSize: 11 }}>
              {canSeek ? (
                <button type="button" onClick={() => onSeek(f.startMs)} style={{ fontFamily: 'monospace' }}>
                  {formatTimecode(f.startMs)}
                </button>
              ) : (
                <span style={{ fontFamily: 'monospace' }}>{formatTimecode(f.startMs)}</span>
              )}{' '}
              <span className="muted">шаг {f.stepIndex}</span>
              {f.caption && <div className="muted">{f.caption}</div>}
            </figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}

/** Переопределение вердикта оператором (заход 7): причина обязательна,
 *  каждое действие — строка журнала (кто, когда, с чего на что, почему). */
function QualityOverrideForm({
  check,
  onChanged,
}: {
  check: DemoQualityCheck;
  onChanged: (check: DemoQualityCheck) => void;
}) {
  const [verdict, setVerdict] = useState<DemoQualityVerdict>(
    effectiveVerdictOf(check) === 'fail' ? 'ok' : 'fail',
  );
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [log, setLog] = useState<DemoQualityOverrideEntry[] | null>(null);

  useEffect(() => {
    let alive = true;
    getDemoQualityOverrides(check.id)
      .then((rows) => {
        if (alive) setLog(rows);
      })
      .catch(() => {
        if (alive) setLog(null);
      });
    return () => {
      alive = false;
    };
  }, [check.id]);

  const submit = async (next: DemoQualityVerdict | null) => {
    const problem = overrideReasonProblem(reason);
    if (problem) {
      setErr(problem);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await overrideDemoQualityVerdict(check.id, next, reason.trim());
      setLog(res.overrides);
      setReason('');
      onChanged(res.check);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, borderTop: '1px solid var(--border, #333)', paddingTop: 8 }}>
      <strong style={{ fontSize: 13 }}>Решение оператора</strong>
      {check.override ? (
        <div style={{ fontSize: 12 }}>
          Вердикт переопределён: модель — {check.verdict ?? '—'}, итог — <b>{check.override.verdict}</b>
          {check.override.by ? ` · ${check.override.by}` : ''}
          {check.override.at ? ` · ${new Date(check.override.at).toLocaleString('ru-RU')}` : ''}
          {check.override.reason ? ` · «${check.override.reason}»` : ''}
        </div>
      ) : (
        <div className="muted" style={{ fontSize: 12 }}>
          Вердикт модели не переопределялся.
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <select value={verdict} onChange={(e) => setVerdict(e.target.value as DemoQualityVerdict)} disabled={busy}>
          {(['ok', 'warn', 'fail'] as const).map((v) => (
            <option key={v} value={v}>
              {VERDICT_LABEL[v]}
            </option>
          ))}
        </select>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Причина (обязательно): что видно в ролике и почему вердикт другой"
          rows={2}
          maxLength={500}
          style={{ flex: '1 1 260px', minWidth: 200 }}
          disabled={busy}
        />
        <button type="button" disabled={busy} onClick={() => void submit(verdict)}>
          Переопределить
        </button>
        {check.override && (
          <button type="button" disabled={busy} onClick={() => void submit(null)}>
            Вернуть вердикт модели
          </button>
        )}
      </div>
      {err && (
        <p className="critical" style={{ margin: 0 }}>
          {err}
        </p>
      )}
      {log && log.length > 0 && (
        <details>
          <summary className="muted" style={{ fontSize: 12 }}>
            Журнал переопределений ({log.length})
          </summary>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
            {log.map((o) => (
              <li key={o.id}>
                {new Date(o.at).toLocaleString('ru-RU')} · {o.by}: {o.fromVerdict ?? '—'} → {o.toVerdict ?? 'вердикт модели'} — «
                {o.reason}»
              </li>
            ))}
          </ul>
        </details>
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
