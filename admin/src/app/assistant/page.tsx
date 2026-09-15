'use client';

// Вкладка «ИИ-консультант» — лента обменов + агрегаты (ТЗ §9/§10,
// doc/LANDING-TUTORIAL-AI-CONSULTANT-SPEC.md). Включение/выключение и
// сама настройка (бюджет, модель, проактивный режим) живут на
// /settings (AssistantSettingsCard) — этот экран только для наблюдения
// за тем, что консультант реально отвечает, и разбора флагов
// пост-фильтра, тот же принцип разделения, что «Модерация публикаций»
// (действие) vs «Телеметрия» (наблюдение) в остальной админке.

import { Fragment, useCallback, useEffect, useState } from 'react';
import { getAssistantAdmin } from '../../lib/endpoints';
import type { AssistantAdminResult, AssistantExchangeRow } from '../../lib/types';
import { ApiRequestError } from '../../lib/admin-api';

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
        default:
          return a.kind;
      }
    })
    .join(', ');
}

export default function AssistantAdminPage() {
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
    <div className="page">
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>ИИ-консультант</h1>
      <p className="muted" style={{ marginBottom: 16 }}>
        Лента вопросов посетителей и агрегаты. Включение, дневной бюджет, модель и проактивный режим — на вкладке
        «Настройки». Флаг «подозрительный» ставит пост-фильтр (§5.5 ТЗ) — сам ответ не блокируется и не
        изменяется, здесь только видно оператору для ревью.
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
