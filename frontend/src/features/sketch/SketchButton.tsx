/**
 * SketchButton — точка входа в скетч (doc/AI-SKETCH-SPEC.md §3.1):
 * вторичная кнопка на карточке слота, рядом с самим изображением.
 *
 * Квота здесь НЕ проверяется заранее: по §3.1 кнопка остаётся видимой и
 * при исчерпанной квоте, а лимит объясняет окно — вместе с CTA тарифа
 * (§8.4). Лишний `GET /sketches/quota` на каждую карточку слота (их на
 * экране до шести) не дал бы ничего, кроме шести запросов.
 *
 * Закрытый признаком тарифа скетч не прячется, а показывается замком —
 * тем же `LockedNote`, что и фото-замена персонажа: спрятанная функция
 * ничего не сообщает о себе (см. components/ui/Locked.tsx).
 *
 * Ветка с замком сейчас недостижима: `aiSketch` есть у всех тарифов
 * (§8.1) — фича заводилась как юридическая мера, закрывать её тарифом
 * было бы странно. Оставлена намеренно (аудит, «низкая»): решение о
 * тарифах живёт в `common/plans.ts`, и если признак когда-нибудь станет
 * платным, замок обязан появиться сам, без правки шести экранов. Стоит
 * она два вызова и ноль запросов.
 */

import { useState } from 'react';
import { PenTool } from 'lucide-react';
import { Button, LockedNote } from '../../components/ui';
import { useFeature } from '../../lib/plan-context';
import { useI18n } from '../../lib/i18n-context';
import type { SketchSlotView, SketchTarget } from '../../types/sketch';
import { SketchSheet } from './SketchSheet';

export function SketchButton({
  target,
  hasImage,
  originalUrl,
  description,
  disabled = false,
  onApplied,
  label,
}: {
  target: SketchTarget;
  /** Есть ли у слота оригинал: без него остаётся только «по описанию». */
  hasImage: boolean;
  /** Оригинал для сравнения в превью — обычно то же, что показывает слот. */
  originalUrl?: string | null;
  /** Предзаполнение текста для режима «по описанию» (§3.2, п. 1). */
  description?: string;
  disabled?: boolean;
  onApplied: (slot: SketchSlotView) => void;
  label?: string;
}) {
  const { dict } = useI18n();
  const feature = useFeature('aiSketch');
  const [open, setOpen] = useState(false);

  // Пока матрица режимов не пришла — ни кнопки, ни замка: мигнуть замком
  // у премиум-пользователя хуже, чем показать кнопку на полсекунды позже.
  if (feature.loading) return null;

  if (!feature.allowed) {
    return (
      <LockedNote title={dict.sketch.lockedTitle} lock={feature.lock} compact>
        {dict.sketch.lockedBody}
      </LockedNote>
    );
  }

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        icon={<PenTool size={14} />}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        {label ?? dict.sketch.button}
      </Button>
      {open && (
        <SketchSheet
          target={target}
          hasImage={hasImage}
          originalUrl={originalUrl}
          description={description}
          onClose={() => setOpen(false)}
          onApplied={(slot) => {
            setOpen(false);
            onApplied(slot);
          }}
        />
      )}
    </>
  );
}
