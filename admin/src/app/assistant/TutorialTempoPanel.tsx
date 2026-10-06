'use client';

// Темп ролика обучалки во вкладке «Видео-контент» (06.10.2026,
// doc/TUTORIAL-POSTPROD-TEMPO-SPEC.md).
//
// Тот же API, что у пользователя в «Постпроде», под защитой админки.
// Отличие одно и принципиальное: версия ПУБЛИЧНОГО (сценарного) демо
// после сборки и технической проверки НЕ становится действующей сама —
// её делает действующей кнопка «Одобрить версию» (повторное одобрение
// оператором, решение владельца). До этого версия не видна ни
// консультанту, ни лендингу: они читают строку ролика, а версия живёт в
// своей таблице.
//
// Расчёт длительности бесплатный; «Собрать версию» — одна платная задача
// ffmpeg-api (расход пишется на оператора). Скорость речи не меняется —
// только паузы.

import { useCallback, useEffect, useState } from 'react';
import {
  approveTutorialVersion,
  getTutorialTempo,
  getTutorialVersions,
  requestTutorialVersion,
  revertTutorialTempo,
} from '../../lib/endpoints';
import type {
  TutorialTempoEstimate,
  TutorialTempoUnavailableReason,
  TutorialTempoWarning,
  TutorialVersionRow,
} from '../../lib/types';
import { ApiRequestError } from '../../lib/admin-api';

const PRESETS: Array<{ key: string; label: string; factor: number }> = [
  { key: 'calm', label: 'Спокойнее (×1.5 паузы)', factor: 1.5 },
  { key: 'normal', label: 'Обычный', factor: 1 },
  { key: 'fast', label: 'Быстрее (×0.4 паузы)', factor: 0.4 },
];

function errText(e: unknown): string {
  return e instanceof ApiRequestError ? e.message : 'Не удалось выполнить запрос';
}

function fmt(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function reasonText(r: TutorialTempoUnavailableReason): string {
  switch (r) {
    case 'whole-track':
      return 'Озвучка — одна дорожка на весь ролик (вариант А): реплики не привязаны к кадрам, паузы менять нельзя.';
    case 'sources-pending':
      return 'Исходники ролика не перенесены из транзита — темп недоступен до следующей сборки.';
    case 'not-complete':
      return 'Ролик ещё не собран.';
    case 'frames-purged':
      return 'Кадры черновика клиента стёрты по сроку хранения.';
    default:
      return 'Ролик собран до монтажного плана — темп недоступен, нужна новая сборка.';
  }
}

function warningText(w: TutorialTempoWarning): string {
  switch (w.code) {
    case 'pauses-at-minimum':
      return `У ${w.frames} кадр(ов) пауза уже минимальная — быстрее не станут.`;
    case 'source-frame-too-short':
      return `В исходнике ${w.frameIndexes.length} кадр(ов) короче реплики — в версии реплика прозвучит целиком.`;
    case 'speech-unmeasured':
      return `У ${w.frameIndexes.length} кадр(ов) длина реплики неизвестна — их длительность не меняется.`;
    case 'zoom-dropped':
      return 'Ролик длиннее 180 с — зум снимется, переходы останутся.';
  }
}

function statusLabel(v: TutorialVersionRow): string {
  if (v.active) return 'действует';
  switch (v.status) {
    case 'preparing':
    case 'pending':
      return 'собирается';
    case 'failed':
      return 'ошибка';
    default:
      return v.requiresApproval && !v.approved ? 'ждёт одобрения' : 'собрана';
  }
}

export function TutorialTempoPanel({ assetId, onChanged }: { assetId: string; onChanged: () => void }) {
  const [factor, setFactor] = useState<number | null>(null);
  const [estimate, setEstimate] = useState<TutorialTempoEstimate | null>(null);
  const [versions, setVersions] = useState<TutorialVersionRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadVersions = useCallback(() => {
    getTutorialVersions(assetId)
      .then(setVersions)
      .catch((e) => setError(errText(e)));
  }, [assetId]);

  useEffect(() => {
    getTutorialTempo(assetId, 1)
      .then((est) => {
        setEstimate(est);
        setFactor(est.activeFactor);
      })
      .catch((e) => setError(errText(e)));
    loadVersions();
  }, [assetId, loadVersions]);

  useEffect(() => {
    if (factor === null) return;
    const timer = setTimeout(() => {
      getTutorialTempo(assetId, factor)
        .then(setEstimate)
        .catch((e) => setError(errText(e)));
    }, 250);
    return () => clearTimeout(timer);
  }, [assetId, factor]);

  const building = versions.some((v) => v.status === 'preparing' || v.status === 'pending');
  useEffect(() => {
    if (!building) return;
    const timer = setInterval(loadVersions, 5000);
    return () => clearInterval(timer);
  }, [building, loadVersions]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      loadVersions();
      if (factor !== null) setEstimate(await getTutorialTempo(assetId, factor));
      onChanged();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const approve = (v: TutorialVersionRow) => {
    const ok = window.confirm(
      `Сделать версию ×${v.factor} действующей?\n\n` +
        'Если ролик одобрен, посетители лендинга и консультант увидят новую версию НЕМЕДЛЕННО. ' +
        'Посмотрите её перед одобрением.',
    );
    if (!ok) return;
    void run(() => approveTutorialVersion(assetId, v.id));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 4px', maxWidth: 560 }}>
      <strong>Темп: меняет паузы, скорость речи сохраняется</strong>
      {error && <p className="critical">{error}</p>}
      {!estimate && !error && <p className="muted">Загрузка…</p>}
      {estimate && !estimate.editable && estimate.reason && <p className="muted">{reasonText(estimate.reason)}</p>}
      {estimate && estimate.editable && factor !== null && (
        <>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                disabled={busy}
                aria-pressed={factor === p.factor}
                style={factor === p.factor ? { fontWeight: 600 } : undefined}
                onClick={() => setFactor(p.factor)}
              >
                {p.label}
              </button>
            ))}
          </div>
          <label style={{ fontSize: 12 }}>
            Точная настройка — пауза ×{factor.toFixed(2)}
            <input
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={factor}
              disabled={busy}
              onChange={(e) => setFactor(Number(Number(e.target.value).toFixed(2)))}
              style={{ display: 'block', width: '100%' }}
            />
          </label>
          <span>
            Итог: <strong>{fmt(estimate.durationMs)}</strong>{' '}
            <span className="muted">
              (обычный — {fmt(estimate.sourceDurationMs)}, минимум — {fmt(estimate.minimumDurationMs)}; действует ×
              {estimate.activeFactor})
            </span>
          </span>
          {!estimate.voiced && <span className="muted">Озвучки нет — меняются паузы немых кадров.</span>}
          {estimate.warnings.map((w, i) => (
            <span key={`${w.code}-${i}`} className="badge-status badge-status-warning" style={{ whiteSpace: 'normal' }}>
              {warningText(w)}
            </span>
          ))}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button
              type="button"
              disabled={busy || building || factor === estimate.activeFactor}
              onClick={() => void run(() => requestTutorialVersion(assetId, factor))}
            >
              {building ? 'Собирается…' : 'Собрать версию'}
            </button>
            {estimate.activeFactor !== 1 && (
              <button type="button" disabled={busy || building} onClick={() => void run(() => revertTutorialTempo(assetId))}>
                Вернуть обычный
              </button>
            )}
          </div>
          <span className="muted" style={{ fontSize: 11 }}>
            Сборка — одна платная задача ffmpeg-api. У публичного демо версия становится действующей только после
            «Одобрить версию».
          </span>
        </>
      )}
      {versions.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Версия</th>
              <th>Длительность</th>
              <th>Состояние</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.id}>
                <td>{v.kind === 'source' ? 'исходный' : `×${v.factor}`}</td>
                <td className="muted">{fmt(v.durationMs)}</td>
                <td>
                  <span
                    className={`badge-status ${
                      v.active
                        ? 'badge-status-ok'
                        : v.status === 'failed'
                          ? 'badge-status-critical'
                          : 'badge-status-warning'
                    }`}
                  >
                    {statusLabel(v)}
                  </span>
                  {v.error && (
                    <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                      {v.error}
                    </div>
                  )}
                </td>
                <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {v.url && (
                    <a href={v.url} target="_blank" rel="noreferrer">
                      Просмотр
                    </a>
                  )}
                  {v.status === 'complete' && !v.active && v.kind === 'tempo' && (
                    <button type="button" disabled={busy} onClick={() => approve(v)}>
                      Одобрить версию
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
