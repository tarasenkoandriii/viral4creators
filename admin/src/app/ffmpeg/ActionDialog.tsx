'use client';

// Диалог любого действия оператора на вкладке «FFmpeg» (ТЗ §13.1):
// подтверждение, описание влияния, причина в журнал. Один `operationId`
// (UUID) на открытый диалог — двойной клик, повтор и сверка идут с тем же
// ключом. При обрыве сети/тайм-ауте/5xx/`outcome: unknown` — «результат
// неизвестен, сверяем»: то же тело уходит повторно (backend вернёт
// записанный исход, действие не выполнится второй раз), новый ключ не
// создаётся. Причина после первой отправки заблокирована: тело не меняется.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  REASON_MAX,
  errorNeedsReload,
  ffmpegErrorText,
  mutationResultText,
  newOperationId,
  reasonValid,
  runWithReconcile,
  type FfmpegRight,
} from '../../lib/ffmpeg';
import type { FfmpegMutationResult } from '../../lib/types';

export interface ActionSpec {
  /** Ключ действия — для журнала на экране и тестов. */
  kind: string;
  title: string;
  /** Объект действия (id задачи и т.п.). */
  target?: ReactNode;
  /** Что произойдёт: влияние на активную задачу, очередь, файлы. */
  effect: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  right: FfmpegRight;
  /** Отметки, без которых кнопка недоступна (необратимость и т.п.). */
  checks?: string[];
  /** Отдельное подтверждение вводом слова (перевод default → selfhosted). */
  typed?: { word: string; label: string };
  /** `optional` — причину можно не писать (сверка — только чтение); иначе обязательна. */
  reason?: 'required' | 'optional';
  run: (operationId: string, reason: string) => Promise<FfmpegMutationResult>;
}

type Phase = 'idle' | 'sending' | 'reconciling' | 'unknown';

export function ActionDialog({
  spec,
  onDone,
  onClose,
  onStale,
}: {
  spec: ActionSpec;
  onDone: (message: string) => void;
  /** `unknownNote` — закрыто при неизвестном исходе. */
  onClose: (unknownNote?: string) => void;
  onStale: () => void;
}) {
  const [operationId, setOperationId] = useState(newOperationId);
  const [reason, setReason] = useState('');
  const [checked, setChecked] = useState<boolean[]>(() => (spec.checks ?? []).map(() => false));
  const [typed, setTyped] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  /** Тело уже уходило хотя бы раз: причина и отметки заморожены. */
  const [sent, setSent] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const mounted = useRef(true);
  const uid = useId();
  const titleId = `${uid}-title`;
  const effectId = `${uid}-effect`;
  const reasonId = `${uid}-reason`;
  const reasonHintId = `${uid}-reason-hint`;
  const busy = phase === 'sending' || phase === 'reconciling';

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const close = useCallback(() => {
    if (busy) return;
    onClose(
      phase === 'unknown'
        ? `${spec.title}: результат неизвестен. Повторно действие не отправлялось; проверьте журнал действий и состояние ниже.`
        : undefined,
    );
  }, [busy, onClose, phase, spec.title]);

  // Начальный фокус — в первое поле (причина).
  useEffect(() => {
    cardRef.current?.querySelector<HTMLElement>('textarea, input, button')?.focus();
  }, []);

  // Ловушка Tab и Escape — как у общего ConfirmDialog.
  useEffect(() => {
    const focusables = () =>
      Array.from(
        cardRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), textarea:not(:disabled), input:not(:disabled), select:not(:disabled)',
        ) ?? [],
      );
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== 'Tab') return;
      const els = focusables();
      if (els.length === 0) return;
      const first = els[0];
      const last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close]);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const optional = spec.reason === 'optional';
  const reasonOk = reasonValid(reason) || (optional && reason.trim() === '');
  const ready =
    reasonOk && checked.every(Boolean) && (!spec.typed || typed.trim() === spec.typed.word);

  const submit = async () => {
    if (busy || (!sent && !ready)) return;
    setSent(true);
    setError('');
    setPhase('sending');
    const trimmed = reason.trim();
    const outcome = await runWithReconcile(() => spec.run(operationId, trimmed), {
      onUnknown: () => mounted.current && setPhase('reconciling'),
      cancelled: () => !mounted.current,
    });
    if (!mounted.current) return;
    if (outcome.kind === 'done') {
      onDone(mutationResultText(spec.title, outcome.result));
      return;
    }
    if (outcome.kind === 'unknown') {
      setPhase('unknown');
      setError(
        `Результат неизвестен: ${ffmpegErrorText(outcome.error, spec.right)} Сверка тем же ключом пока не дала ответа. ` +
          'Нажмите «Сверить ещё раз» — действие не выполнится повторно.',
      );
      return;
    }
    setPhase('idle');
    // Окончательный отказ (4xx): действие точно не выполнено. Backend
    // записал отказ под этим ключом и на повтор вернёт его же, поэтому
    // следующая попытка — с новым ключом. Это единственный случай смены
    // ключа: при неизвестном исходе ключ не меняется никогда.
    setOperationId(newOperationId());
    setSent(false);
    setError(ffmpegErrorText(outcome.error, spec.right));
    if (errorNeedsReload(outcome.error)) onStale();
  };

  const status =
    phase === 'sending'
      ? 'Отправляем…'
      : phase === 'reconciling'
        ? 'Результат неизвестен, сверяем тем же ключом…'
        : '';

  return (
    <div className="dialog-overlay" role="presentation" onClick={close}>
      <div
        ref={cardRef}
        className="card dialog-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={effectId}
        style={{ maxWidth: 560, maxHeight: 'calc(100vh - 32px)', overflowY: 'auto', borderColor: spec.danger ? 'var(--signal-critical)' : 'var(--signal-warning)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id={titleId} style={{ fontSize: 18, margin: '0 0 8px' }}>
          {spec.title}
        </h2>
        {spec.target && <div style={{ marginBottom: 8, fontSize: 13, overflowWrap: 'anywhere' }}>{spec.target}</div>}
        <div id={effectId} style={{ fontSize: 13, lineHeight: 1.5 }}>
          {spec.effect}
        </div>

        <>
            <label htmlFor={reasonId} style={{ display: 'block', marginTop: 12, fontSize: 13 }}>
              Причина для журнала ({optional ? 'необязательно' : 'обязательно'}; без персональных данных и текстов)
            </label>
            <textarea
              id={reasonId}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={REASON_MAX}
              rows={2}
              disabled={sent}
              aria-describedby={reasonHintId}
              aria-invalid={reason.length > 0 && !reasonOk}
              style={{ width: '100%', marginTop: 4 }}
            />
            <p id={reasonHintId} className="muted" style={{ fontSize: 12, margin: '4px 0 0' }}>
              {optional ? 'Если пишете — не меньше трёх символов. ' : 'Не меньше трёх символов. '}В журнал записываются ваш id, время и исход.
            </p>
        </>

        {(spec.checks ?? []).map((text, i) => (
          <label key={text} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 10, fontSize: 13, minHeight: 24 }}>
            <input
              type="checkbox"
              checked={checked[i]}
              disabled={sent}
              onChange={(e) => setChecked((prev) => prev.map((v, j) => (j === i ? e.target.checked : v)))}
              style={{ width: 20, height: 20, flex: '0 0 auto', margin: 0 }}
            />
            <span>{text}</span>
          </label>
        ))}

        {spec.typed && (
          <>
            <label htmlFor={`${uid}-typed`} style={{ display: 'block', marginTop: 12, fontSize: 13 }}>
              {spec.typed.label}
            </label>
            <input
              id={`${uid}-typed`}
              value={typed}
              disabled={sent}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              style={{ width: '100%', marginTop: 4 }}
            />
          </>
        )}

        <p role="status" aria-live="polite" style={{ fontSize: 13, minHeight: 18, margin: '12px 0 0' }}>
          {status}
        </p>
        {error && (
          <p ref={errorRef} tabIndex={-1} role="alert" className="critical" style={{ fontSize: 13, margin: '4px 0 0' }}>
            {error}
          </p>
        )}
        <p className="muted" style={{ fontSize: 12, margin: '8px 0 0' }}>
          Ключ операции: <code>{operationId.slice(0, 8)}</code> — повтор этого диалога безопасен.
        </p>

        <div className="dialog-actions" style={{ flexWrap: 'wrap' }}>
          <button type="button" onClick={close} disabled={busy}>
            {phase === 'unknown' ? 'Закрыть' : 'Отмена'}
          </button>
          <button
            type="button"
            className={spec.danger ? 'button-danger' : undefined}
            onClick={() => void submit()}
            disabled={busy || (!sent && !ready)}
          >
            {busy ? 'Выполняется…' : phase === 'unknown' ? 'Сверить ещё раз' : spec.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
