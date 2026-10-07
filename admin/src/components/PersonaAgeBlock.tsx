'use client';

// Блок карточки пользователя «Я в кадре: отметка „младше 18“» (В-4 ТЗ
// Greeting 2.0, заход 8). Автопроверка селфи ставит отметку, если нижняя
// граница оценки возраста ниже 18; человек оспаривает её через поддержку,
// а оператор здесь снимает — с обязательной причиной, которая уходит в
// журнал снятий (`GET/POST /admin/users/:id/persona-age`).
//
// Снятие режим не включает: человек заново даёт согласие и проходит
// автопроверку под рубильником PERSONA_ENABLED. Оценки возраста в блоке
// нет намеренно (§4.4 ТЗ: она только для допуска и показа самому человеку).

import { useCallback, useEffect, useRef, useState } from 'react';
import { clearPersonaAge, getPersonaAge } from '../lib/endpoints';
import type { PersonaAgeState } from '../lib/types';
import { ApiRequestError } from '../lib/admin-api';
import {
  canClearAgeMark,
  checkClearReason,
  clearConfirmText,
  personaAgeSummary,
  PERSONA_AGE_REASON_MAX,
  refusalsText,
} from '../lib/persona-age';
import UserBadge from './UserBadge';

function errText(e: unknown): string {
  return e instanceof ApiRequestError ? e.message : 'Не удалось выполнить запрос';
}

function date(value: string | null): string {
  return value ? new Date(value).toLocaleString('ru-RU') : '—';
}

const TONE_CLASS = { ok: 'badge-status-ok', warning: 'badge-status-warning', critical: 'badge-status-critical' } as const;

export default function PersonaAgeBlock({ userId, who }: { userId: string; who: string }) {
  const [state, setState] = useState<PersonaAgeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [reason, setReason] = useState('');

  // Карточку переключили на другого пользователя, пока шёл запрос, —
  // ответ про прежнего выбрасывается.
  const req = useRef(0);
  const load = useCallback(() => {
    const gen = ++req.current;
    setError(null);
    setState(null);
    getPersonaAge(userId)
      .then((s) => {
        if (gen === req.current) setState(s);
      })
      .catch((e) => {
        if (gen === req.current) setError(errText(e));
      });
  }, [userId]);

  useEffect(() => {
    setFormOpen(false);
    setReason('');
    load();
  }, [load]);

  const submit = async () => {
    const checked = checkClearReason(reason);
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    if (!window.confirm(clearConfirmText(who, state?.personaEnabled ?? false))) return;
    setBusy(true);
    setError(null);
    try {
      const next = await clearPersonaAge(userId, checked.reason);
      setState(next);
      setFormOpen(false);
      setReason('');
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const summary = personaAgeSummary(state);
  const p = state?.persona;

  return (
    <div style={{ marginTop: 12 }}>
      <strong style={{ fontSize: 13 }}>«Я в кадре»: отметка «младше 18»</strong>
      <p style={{ fontSize: 13, margin: '6px 0' }}>
        {summary.tone === 'muted' ? (
          <span className="muted">{summary.text}</span>
        ) : (
          <>
            <span className={`badge-status ${TONE_CLASS[summary.tone]}`}>
              {summary.tone === 'critical' ? 'закрыто' : summary.tone === 'ok' ? 'проверена' : 'удаляется'}
            </span>{' '}
            {summary.text}
          </>
        )}
        {state && !state.personaEnabled && (
          <span className="muted"> · режим выключен рубильником PERSONA_ENABLED</span>
        )}
      </p>
      {p?.under18 && (
        <p className="muted" style={{ fontSize: 12, margin: '0 0 6px' }}>
          Поставлена {date(p.markedAt)} автопроверкой селфи; причины отказа: {refusalsText(p.refusals)}.
        </p>
      )}
      {error && (
        <p className="critical" style={{ fontSize: 13 }}>
          {error}{' '}
          <button type="button" onClick={load}>
            Обновить
          </button>
        </p>
      )}
      {canClearAgeMark(state) && !formOpen && (
        <button type="button" disabled={busy || !!p?.filesPending} onClick={() => setFormOpen(true)}>
          Снять отметку…
        </button>
      )}
      {formOpen && (
        <div style={{ display: 'grid', gap: 6, maxWidth: 520 }}>
          <label style={{ fontSize: 13 }} htmlFor={`persona-age-reason-${userId}`}>
            Причина (апелляция через поддержку: что проверено, номер обращения) — уйдёт в журнал снятий
          </label>
          <textarea
            id={`persona-age-reason-${userId}`}
            value={reason}
            maxLength={PERSONA_AGE_REASON_MAX + 20}
            rows={3}
            onChange={(e) => setReason(e.target.value)}
          />
          <span className="muted" style={{ fontSize: 12 }}>
            {reason.trim().length} / {PERSONA_AGE_REASON_MAX}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" disabled={busy || !checkClearReason(reason).ok} onClick={() => void submit()}>
              {busy ? 'Снимаю…' : 'Снять отметку'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setFormOpen(false);
                setReason('');
                setError(null);
              }}
            >
              Отмена
            </button>
          </div>
        </div>
      )}
      {state && state.clears.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary className="muted" style={{ fontSize: 12, cursor: 'pointer' }}>
            Журнал снятий ({state.clears.length})
          </summary>
          <ul className="muted" style={{ fontSize: 12, marginTop: 6, paddingLeft: 18 }}>
            {state.clears.map((c) => (
              <li key={`${c.at}-${c.by}`} style={{ marginBottom: 4 }}>
                {date(c.at)} — <UserBadge userId={c.by} />: {c.reason}
                <div>
                  снята отметка от {date(c.markedAt)} ({refusalsText(c.refusals)})
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
