/**
 * SketchSlotActions — то, что встраивается в карточку слота (§7.2):
 * кнопка «ИИ-скетч» плюс бейдж с меню, когда скетч применён.
 *
 * Зачем обёртка, а не два компонента на каждом экране: состояние слота
 * («сейчас активен скетч или оригинал») одинаково нужно всем шести
 * местам встраивания, и повторять его в мастере, брендбуке и товаре
 * значило бы трижды написать один и тот же useState с одним и тем же
 * риском рассинхрона.
 *
 * Начальное состояние приходит ИЗ ВЫДАЧИ слота (`variant`,
 * `activeSketchId`, `originalDeleted`), а не заводится пустым: раньше
 * после перезагрузки экран показывал оригинал и не давал ни «Вернуть»,
 * ни «Удалить оригинал», хотя в ролик уже уходил скетч (аудит A-8).
 * Отдельного запроса на карточку для этого не нужно — все шесть выдач
 * отдают эти поля вместе с картинкой.
 *
 * Оригинал запоминается на момент применения: после apply экран уже
 * показывает скетч, и без этого «Показать оригинал» показывал бы скетч
 * сам себе.
 */

import { useEffect, useState } from 'react';
import type { SketchSlotView, SketchTarget } from '../../types/sketch';
import { SketchBadge } from './SketchBadge';
import { SketchButton } from './SketchButton';

export function SketchSlotActions({
  target,
  hasImage,
  originalUrl,
  activeUrl,
  variant = 'original',
  activeSketchId = null,
  originalDeleted = false,
  description,
  disabled,
  label,
  className = '',
  onSlot,
}: {
  target: SketchTarget;
  hasImage: boolean;
  /** ИСХОДНОЕ фото слота — не то, что сейчас на экране (аудит A-15). */
  originalUrl?: string | null;
  /** Что показано сейчас: при применённом скетче — его URL. */
  activeUrl?: string | null;
  variant?: 'original' | 'sketch';
  activeSketchId?: string | null;
  originalDeleted?: boolean;
  description?: string;
  disabled?: boolean;
  label?: string;
  className?: string;
  /** Экран обновляет свою картинку из `slot.url` (§7.2). */
  onSlot: (slot: SketchSlotView) => void;
}) {
  const initial: SketchSlotView | null =
    variant === 'sketch'
      ? {
          target,
          variant: 'sketch',
          url: activeUrl ?? null,
          sketchId: activeSketchId,
          originalDeleted,
        }
      : null;

  const [slot, setSlot] = useState<SketchSlotView | null>(initial);
  const [kept, setKept] = useState<string | null>(null);

  // Экран мог перезагрузить слот (после сохранения, смены товара,
  // возврата на шаг) — начальное состояние следует за выдачей.
  useEffect(() => {
    setSlot(
      variant === 'sketch'
        ? {
            target,
            variant: 'sketch',
            url: activeUrl ?? null,
            sketchId: activeSketchId,
            originalDeleted,
          }
        : null
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    variant,
    activeSketchId,
    activeUrl,
    originalDeleted,
    target.id,
    target.subId,
  ]);

  const changed = (next: SketchSlotView) => {
    if (next.variant === 'sketch' && kept === null)
      setKept(originalUrl ?? null);
    setSlot(next);
    onSlot(next);
  };

  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      <SketchButton
        target={target}
        hasImage={hasImage}
        originalUrl={kept ?? originalUrl}
        description={description}
        disabled={disabled}
        label={label}
        onApplied={changed}
      />
      {slot?.variant === 'sketch' && (
        <SketchBadge
          target={target}
          slot={slot}
          originalUrl={kept ?? originalUrl ?? null}
          onChanged={changed}
        />
      )}
    </div>
  );
}
