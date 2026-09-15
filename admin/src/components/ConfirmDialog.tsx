'use client';

import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

/**
 * ConfirmDialog — «умный» алерт удаления (этап 89, доп. запрос владельца
 * продукта: «реализовать тот же механизм в админке для сессий»). Тот же
 * приём, что и в TMA (frontend/src/components/ui/ConfirmDialog.tsx):
 * раньше `confirm(...)` с общей фразой «это необратимо», теперь —
 * модалка. У сессии нет каскадных под-сущностей для превью (все её
 * связи в БД — `SetNull`, см. doc/PRODUCT-PROJECT-IMPLEMENTATION-PLAN.md,
 * этап 89) — поэтому тело диалога здесь всегда фиксированный честный
 * текст, а не счётчики, как у проекта/товара на TMA-стороне.
 *
 * Само удаление за этим диалогом — софт-delete
 * (`SessionService.softDeleteSession`, общий и с пользовательским
 * маршрутом): строка физически уходит из БД только спустя грейс-период,
 * кроном. Оператору это НЕ показывается как обратимое — интерфейс
 * говорит «удалит», а не «пометит», восстановления через интерфейс нет.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel = 'Удалить',
  cancelLabel = 'Отмена',
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: ReactNode;
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Esc закрывает (но не пока само удаление в полёте, чтобы не оборвать
  // запрос неожиданным анмаунтом диалога); начальный фокус на первую
  // кнопку и простой Tab-trap между двумя кнопками — найдено доп.
  // аудитом (LOW, тот же фикс, что и в TMA-варианте
  // frontend/src/components/ui/ConfirmDialog.tsx, см. её доккомментарий).
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
      className="dialog-overlay"
      role="presentation"
      onClick={() => !busy && onCancel()}
    >
      <div
        className="card dialog-card"
        role="alertdialog"
        aria-modal="true"
        // Найдено доп. аудитом (LOW) — раньше без accessible name вовсе
        // (ни `aria-label`, ни `aria-labelledby`): скринридер объявлял
        // модалку без заголовка. `id` ниже — тот же приём, что у
        // TMA-варианта (`confirm-dialog-title`).
        aria-labelledby="admin-confirm-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <p
          id="admin-confirm-dialog-title"
          style={{ fontWeight: 600, marginBottom: 8 }}
        >
          {title}
        </p>
        {children && (
          <div className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
            {children}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className="button-danger"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? 'Удаление…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
