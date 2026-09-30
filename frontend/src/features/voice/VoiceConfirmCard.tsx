import { useId } from 'react';
import { Check, X } from 'lucide-react';
import { Button } from '../../components/ui';
import { useI18n } from '../../lib/i18n-context';
import type { VoiceCard } from '../../lib/voice-confirm';
import type { VoiceField } from '../../lib/voice-types';

/**
 * Карточка «я понял так» (ТЗ Greeting 2.0 §4А.2 п. 3): разобранное —
 * списком «поле → значение», применяется только после «Да». Ответить
 * можно кнопкой или голосом (интенты `confirm` / `cancel`) — оба пути
 * ведут в один и тот же обработчик `VoiceAssistant`.
 *
 * `role="group"`, а не `dialog`: карточка — часть страницы, фокус в неё
 * не переносится и за ней не запирается (финальный аудит, доступность).
 * О её появлении читалке говорит область объявлений `VoiceAssistant`.
 */
export function VoiceConfirmCard({
  card,
  describe,
  note,
  onConfirm,
  onCancel,
}: {
  card: VoiceCard;
  describe: (field: VoiceField) => string;
  /** Предупреждение к карточке (фраза обрезана по длине). */
  note?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { dict } = useI18n();
  const v = dict.voiceAssistant;
  const titleId = useId();
  return (
    <div
      className="rounded-xl border border-accent/30 bg-accent/5 p-3"
      role="group"
      aria-labelledby={titleId}
    >
      <p id={titleId} className="text-sm font-medium">
        {v.confirmTitle}
      </p>
      {card.kind === 'fill' ? (
        <dl className="mt-2 space-y-1 text-sm">
          {card.fields.map((f) => (
            <div key={f.target} className="flex gap-2">
              <dt className="shrink-0 text-silver-400">{f.label}:</dt>
              <dd className="break-words font-medium">{describe(f)}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mt-2 text-sm font-medium">{card.label}</p>
      )}
      {note && (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
          {note}
        </p>
      )}
      <p className="mt-2 text-xs text-silver-400">{v.confirmHint}</p>
      <div className="mt-2 flex gap-2">
        <Button size="sm" icon={<Check size={14} />} onClick={onConfirm}>
          {v.confirmYes}
        </Button>
        <Button
          size="sm"
          variant="outline"
          icon={<X size={14} />}
          onClick={onCancel}
        >
          {v.confirmNo}
        </Button>
      </div>
    </div>
  );
}
