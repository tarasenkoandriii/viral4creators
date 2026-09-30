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
 */
export function VoiceConfirmCard({
  card,
  describe,
  onConfirm,
  onCancel,
}: {
  card: VoiceCard;
  describe: (field: VoiceField) => string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { dict } = useI18n();
  const v = dict.voiceAssistant;
  return (
    <div
      className="rounded-xl border border-accent/30 bg-accent/5 p-3"
      role="dialog"
      aria-label={v.confirmTitle}
    >
      <p className="text-sm font-medium">{v.confirmTitle}</p>
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
