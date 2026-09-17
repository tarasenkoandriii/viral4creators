import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from './Button';
import { Card } from './Card';
import { Spinner } from './Spinner';
import { useI18n } from '../../lib/i18n-context';

/**
 * ConfirmDialog — «умный» алерт удаления (этап 89, доп. запрос
 * владельца продукта): раньше `window.confirm(...)` с общей фразой
 * («это необратимо»), теперь — модалка, которая умеет показать ЧТО
 * именно уйдёт из базы (счётчики под-сущностей), пока `body` грузится
 * отдельным запросом (`loadingBody`), и падает обратно на обычный текст,
 * если счётчики не пришли (`children`, переданные сразу — родительский
 * экран сам решает, что показать вместо превью).
 *
 * Само удаление за этим диалогом — софт-delete (backend
 * `common/soft-delete.ts`): физически строка уходит из БД только спустя
 * грейс-период, кроном. Пользователю это не показывается и не
 * обещается как восстановление — интерфейс всегда говорит «удалит», а
 * не «пометит на удаление», потому что для пользователя разницы нет
 * (ни кнопки «восстановить», ни срока в интерфейсе намеренно нет, см.
 * doc/PRODUCT-PROJECT-IMPLEMENTATION-PLAN.md, этап 89).
 */
export function ConfirmDialog({
  open,
  title,
  children,
  loadingBody = false,
  confirmLabel,
  cancelLabel,
  danger = true,
  busy = false,
  secondaryAction,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: ReactNode;
  /** Тело диалога — точные счётчики (или запасной общий текст). */
  children?: ReactNode;
  /** Счётчики ещё грузятся (delete-preview в полёте) — показывает спиннер вместо `children`. */
  loadingBody?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
  /**
   * Третье действие рядом с «Отмена» (этап 121): бывает выбор из двух
   * поступков, а не «сделать/не делать» — например, «вернуться к
   * незавершённому прогону» против «начать новый». Рисуется в подвале, а
   * НЕ в теле: начальный фокус уходит на первую кнопку диалога, и
   * кнопка в теле забирала бы его себе — то есть Enter сразу запускал бы
   * более дорогое из двух действий.
   */
  secondaryAction?: ReactNode;
  /** false — нейтральный акцент вместо красного (не всякое подтверждение — удаление). */
  danger?: boolean;
  /** Само удаление в полёте — блокирует обе кнопки, крутит спиннер на «Удалить». */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { dict } = useI18n();
  const dialogRef = useRef<HTMLDivElement>(null);

  // Esc закрывает (пока не идёт сам запрос удаления, чтобы не оборвать
  // его на середине неожиданным анмаунтом); начальный фокус на первую
  // кнопку и простой Tab-trap между двумя кнопками диалога — найдено
  // доп. аудитом (LOW): без этого фокус клавиатуры при открытии
  // оставался там, где был до модалки (обычно на кнопке «Удалить» в
  // списке), а Tab уводил его за пределы модалки, на элементы под
  // затемнением. `querySelectorAll` от корневого div, а не ref на
  // `Button`/`Card` — ни один из них не завёрнут в `forwardRef`.
  useEffect(() => {
    if (!open) return;
    const focusables = () =>
      Array.from(
        dialogRef.current?.querySelectorAll<HTMLButtonElement>(
          'button:not(:disabled)'
        ) ?? []
      );
    focusables()[0]?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (!busy) onCancel();
        return;
      }
      if (e.key === 'Tab') {
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
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onCancel]);

  if (!open) return null;

  return (
    <div
      ref={dialogRef}
      role="presentation"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 backdrop-blur-sm animate-fadeIn sm:items-center"
      onClick={() => !busy && onCancel()}
    >
      <Card
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        className="w-full max-w-sm p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          {danger && (
            <span className="mt-0.5 shrink-0 text-rose-500">
              <AlertTriangle size={20} />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <h3 id="confirm-dialog-title" className="text-sm font-bold">
              {title}
            </h3>
            <div className="mt-1.5 text-xs leading-relaxed text-silver-500 dark:text-silver-300">
              {loadingBody ? (
                <span className="inline-flex items-center gap-1.5">
                  <Spinner size={12} />
                  {dict.common.checkingWhatWillBeDeleted}
                </span>
              ) : (
                children
              )}
            </div>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            {cancelLabel ?? dict.common.cancel}
          </Button>
          {secondaryAction}
          <Button
            variant={danger ? 'danger' : 'solid'}
            size="sm"
            onClick={onConfirm}
            loading={busy}
            disabled={loadingBody}
          >
            {confirmLabel ?? dict.common.delete}
          </Button>
        </div>
      </Card>
    </div>
  );
}
