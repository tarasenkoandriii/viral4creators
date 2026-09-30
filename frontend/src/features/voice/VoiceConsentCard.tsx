import { X } from 'lucide-react';
import { Button } from '../../components/ui';
import { useI18n } from '../../lib/i18n-context';
import { chargeText, type ConsentSummary } from '../../lib/voice-consent';

/**
 * Сводка перед генерацией голосом (ТЗ Greeting 2.0 §4А.7.4): с чем
 * человек соглашается — кому, повод, качество и СКОЛЬКО спишет.
 * Рисуется рядом с кнопкой генерации, а не в панели помощника: второе
 * «генерируй» нажимает именно эту кнопку, и видно, какую.
 *
 * Своей кнопки «Запустить» здесь нет намеренно: запуск руками — та же
 * кнопка шага, и второй кнопки с тем же действием быть не должно.
 */
export function VoiceConsentCard({
  summary,
  buttonLabel,
  onCancel,
}: {
  summary: ConsentSummary;
  /** Подпись кнопки генерации — ей подсказка и называет, что нажать. */
  buttonLabel: string;
  onCancel: () => void;
}) {
  const { dict } = useI18n();
  const c = dict.voiceConsent;
  const cost = chargeText(summary.charge, c);
  const rows: Array<[string, string]> = [
    [c.recipient, summary.recipient],
    [c.occasion, summary.occasion],
    [c.quality, summary.quality],
  ];
  if (cost) rows.push([c.cost, cost]);
  return (
    <div
      className="mb-3 rounded-xl border border-accent/30 bg-accent/5 p-3"
      role="dialog"
      aria-label={c.title}
    >
      <p className="text-sm font-medium">{c.title}</p>
      <dl className="mt-2 space-y-1 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex gap-2">
            <dt className="shrink-0 text-silver-400">{label}:</dt>
            <dd className="break-words font-medium">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-xs text-silver-400">
        {c.hint.replace('{button}', buttonLabel)}
      </p>
      <div className="mt-2">
        <Button
          size="sm"
          variant="outline"
          icon={<X size={14} />}
          onClick={onCancel}
        >
          {c.cancel}
        </Button>
      </div>
    </div>
  );
}
