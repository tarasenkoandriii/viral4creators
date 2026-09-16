'use client';

// Вкладка «Сценарии обучалки» (§4.10/§4.11 ТЗ, этап 94 — бэкенд;
// UI подключён этапом 105 — аудит лендинга/обучалки, доп. заход).
//
// Эндпоинты (GET /admin/tutorial-scenarios, PATCH
// /admin/tutorial-scenarios/:id/approve) существовали и были покрыты
// тестами с этапа 94, но своей страницы у них не было — доккомментарий
// backend/src/modules/tutorial-scenario/tutorial-scenario-admin.controller.ts
// прямо называл это «UI подключается отдельным заходом». Без этой
// страницы costly=true сценарии, которые генерирует крон
// `tutorial-scenario-generate`, было можно одобрить только прямым
// вызовом PATCH (curl/Postman с админской сессионной кукой) — то есть
// фактически никак для оператора без доступа к API напрямую.
//
// «Одобрено» здесь — про ДЕНЬГИ (можно ли исполнять платный шаг
// сценария при автоматическом регресс-прогоне), не про то, можно ли
// показывать что-то посетителям — это отдельное поле `reviewed` у
// TutorialVideoAsset на вкладке «ИИ-консультант» → «Видео-контент».
//
// «Удалить» (этап 106) — генератор только добавляет строки (`create`,
// не `upsert`), а раннер берёт ВСЕ подходящие по `createdAt asc` без
// пропуска уже провалившихся: сломанный сценарий (например, с route,
// которого не существует — реальный случай, 9/9 сгенерированных
// сценариев упали на этом при первом прогоне на проде) иначе будет
// падать и слать алерт в Telegram на каждом прогоне крона бесконечно,
// без способа его убрать кроме прямого доступа к БД.

import { useCallback, useEffect, useState } from 'react';
import {
  approveTutorialScenario,
  deleteTutorialScenario,
  getTutorialScenarios,
} from '../../lib/endpoints';
import type { TutorialScenarioRow } from '../../lib/types';
import { ApiRequestError } from '../../lib/admin-api';

function errText(e: unknown): string {
  return e instanceof ApiRequestError ? e.message : 'Не удалось выполнить запрос';
}

function formatUsd(microUsd: number): string {
  return `$${(microUsd / 1_000_000).toFixed(4)}`;
}

export default function TutorialScenariosPage() {
  const [subjectKey, setSubjectKey] = useState('');
  const [locale, setLocale] = useState('');
  const [costly, setCostlyFilter] = useState<'' | 'true' | 'false'>('true');
  const [approved, setApprovedFilter] = useState<'' | 'true' | 'false'>('false');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<{
    rows: TutorialScenarioRow[];
    total: number;
    pageSize: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    getTutorialScenarios({
      subjectKey: subjectKey.trim() || undefined,
      locale: locale || undefined,
      costly: costly === '' ? undefined : costly === 'true',
      approved: approved === '' ? undefined : approved === 'true',
      page,
      pageSize: 20,
    })
      .then(setResult)
      .catch((e) => setError(errText(e)));
  }, [subjectKey, locale, costly, approved, page]);

  useEffect(() => {
    load();
  }, [load]);

  const totalPages = result ? Math.max(Math.ceil(result.total / result.pageSize), 1) : 1;

  const approve = useCallback(
    async (row: TutorialScenarioRow) => {
      // Явное предупреждение в моменте действия (§4.11 ТЗ) — тот же
      // приём, что «Одобрить видео» на вкладке «Видео-контент»: это
      // разрешение тратить деньги на автоматическом прогоне, не «просто
      // отметка».
      const costLabel =
        row.estimatedCostMicroUsd != null
          ? `${formatUsd(row.estimatedCostMicroUsd)}${row.costUnpriced ? ' (прикидка занижена — не для всех шагов нашлась ставка)' : ''}`
          : 'неизвестна';
      const ok = window.confirm(
        `Одобрить сценарий «${row.subjectKey}» (${row.locale})?\n\n` +
          `Оценочная стоимость одного прогона: ${costLabel}.\n\n` +
          'После одобрения регресс-раннер (tutorial-scenario-run) сможет исполнять ' +
          'его платные шаги автоматически при каждом прогоне, не только вручную.',
      );
      if (!ok) return;
      setBusyId(row.id);
      setError(null);
      try {
        await approveTutorialScenario(row.id);
        load();
      } catch (e) {
        setError(errText(e));
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  const remove = useCallback(
    async (row: TutorialScenarioRow) => {
      const ok = window.confirm(
        `Удалить сценарий «${row.subjectKey}» (${row.locale}) безвозвратно?\n\n` +
          'Полезно для сломанных сценариев (например, с несуществующим route) — иначе ' +
          'регресс-раннер будет повторно пытаться его исполнить и слать алерт на каждом прогоне крона.',
      );
      if (!ok) return;
      setBusyId(row.id);
      setError(null);
      try {
        await deleteTutorialScenario(row.id);
        load();
      } catch (e) {
        setError(errText(e));
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  return (
    <div className="page">
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Сценарии обучалки</h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        Сгенерированные ИИ сценарии для регресс-раннера обучалки (крон{' '}
        <code>tutorial-scenario-generate</code>). Платные (costly) сценарии требуют явного
        одобрения здесь, прежде чем крон <code>tutorial-scenario-run</code> сможет исполнять их
        платные шаги автоматически — без фикстурного пользователя (см. «Настройки») сам прогон
        всё равно будет пропускаться, одобрение этого не меняет.
      </p>

      <div
        className="filters"
        style={{ marginBottom: 16, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
      >
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
          aria-label="Фильтр по платности"
          value={costly}
          onChange={(e) => {
            setCostlyFilter(e.target.value as '' | 'true' | 'false');
            setPage(1);
          }}
        >
          <option value="">Все (платные и бесплатные)</option>
          <option value="true">Только платные</option>
          <option value="false">Только бесплатные</option>
        </select>
        <select
          aria-label="Фильтр по одобрению"
          value={approved}
          onChange={(e) => {
            setApprovedFilter(e.target.value as '' | 'true' | 'false');
            setPage(1);
          }}
        >
          <option value="">Все</option>
          <option value="false">Ожидают одобрения</option>
          <option value="true">Одобренные</option>
        </select>
      </div>

      {error && (
        <p className="critical" style={{ marginBottom: 16 }}>
          {error}{' '}
          <button type="button" onClick={load}>
            Повторить
          </button>
        </p>
      )}

      {!result && !error && <p className="muted">Загрузка…</p>}

      {result && result.rows.length === 0 && <p className="muted">Сценариев нет.</p>}

      {result && result.rows.length > 0 && (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Когда</th>
                  <th>subjectKey / локаль</th>
                  <th>Сгенерирован</th>
                  <th>Платно</th>
                  <th>Стоимость</th>
                  <th>Одобрение</th>
                  <th>Последний прогон</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row) => (
                  <tr key={row.id}>
                    <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                      {new Date(row.createdAt).toLocaleString('ru-RU')}
                    </td>
                    <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                      {row.subjectKey} / {row.locale}
                    </td>
                    <td className="muted">{row.generatedBy === 'ai' ? 'ИИ' : 'вручную'}</td>
                    <td>
                      {row.costly ? (
                        <span className="badge-status badge-status-warning">платно</span>
                      ) : (
                        <span className="muted">нет</span>
                      )}
                    </td>
                    <td className="muted">
                      {row.estimatedCostMicroUsd != null ? (
                        <>
                          {formatUsd(row.estimatedCostMicroUsd)}
                          {row.costUnpriced && (
                            <div style={{ fontSize: 11 }}>прикидка занижена</div>
                          )}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      {row.approved ? (
                        <span className="badge-status badge-status-ok">
                          одобрено{row.approvedAt ? ` ${new Date(row.approvedAt).toLocaleDateString('ru-RU')}` : ''}
                        </span>
                      ) : row.costly ? (
                        <span className="badge-status badge-status-warning">ожидает</span>
                      ) : (
                        <span className="muted">не требуется</span>
                      )}
                    </td>
                    <td className="muted" style={{ fontSize: 12 }}>
                      {row.lastRunAt ? (
                        <>
                          {row.lastRunStatus === 'failed' ? (
                            <span className="critical">ошибка</span>
                          ) : (
                            row.lastRunStatus ?? '—'
                          )}{' '}
                          {new Date(row.lastRunAt).toLocaleDateString('ru-RU')}
                        </>
                      ) : (
                        'ещё не запускался'
                      )}
                    </td>
                    <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        onClick={() => setExpandedId(expandedId === row.id ? null : row.id)}
                      >
                        {expandedId === row.id ? 'Скрыть шаги' : 'Шаги'}
                      </button>
                      {row.costly && !row.approved && (
                        <button type="button" disabled={busyId === row.id} onClick={() => void approve(row)}>
                          {busyId === row.id ? '…' : 'Одобрить'}
                        </button>
                      )}
                      <button type="button" disabled={busyId === row.id} onClick={() => void remove(row)}>
                        {busyId === row.id ? '…' : 'Удалить'}
                      </button>
                    </td>
                  </tr>
                ))}
                {expandedId &&
                  result.rows
                    .filter((r) => r.id === expandedId)
                    .map((row) => (
                      <tr key={`${row.id}-steps`}>
                        <td colSpan={8} style={{ background: 'var(--bg-alt, rgba(255,255,255,0.03))' }}>
                          <pre
                            style={{
                              maxHeight: 320,
                              overflow: 'auto',
                              padding: '8px 4px',
                              fontSize: 12,
                              margin: 0,
                            }}
                          >
                            {JSON.stringify(row.steps, null, 2)}
                          </pre>
                          {row.lastRunError && (
                            <p className="critical" style={{ fontSize: 12, padding: '0 4px 8px' }}>
                              Последняя ошибка: {row.lastRunError}
                            </p>
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
