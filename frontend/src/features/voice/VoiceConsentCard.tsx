import { useId } from 'react';
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
 *
 * `role="group"`, а не `dialog`: сводка — часть страницы, фокус не
 * запирается. Объявляет её читалке строка помощника: ответ на
 * «генерируй» (`summaryLine` — кому, повод, качество и цена, или
 * «условия изменились») звучит из области объявлений `VoiceAssistant`.
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
  const { dict, locale } = useI18n();
  const c = dict.voiceConsent;
  const cost = chargeText(summary.charge, c, locale);
  // Третье поле — маска личного текста (этап I ТЗ Greeting 2.0, §5.3):
  // кому и «особый повод» пишет человек, и на кадре лендинга они
  // размываются. Качество и цена — текст продукта.
  const rows: Array<[string, string, string?]> = [
    [c.recipient, summary.recipient, 'personal-recipient'],
    [c.occasion, summary.occasion, 'personal-occasion'],
    [c.quality, summary.quality],
  ];
  if (cost) rows.push([c.cost, cost]);
  const titleId = useId();
  return (
    <div
      className="mb-3 rounded-xl border border-accent/30 bg-accent/5 p-3"
      role="group"
      aria-labelledby={titleId}
    >
      <p id={titleId} className="text-sm font-medium">
        {c.title}
      </p>
      <dl className="mt-2 space-y-1 text-sm">
        {rows.map(([label, value, mask]) => (
          <div key={label} className="flex gap-2">
            <dt className="shrink-0 text-silver-400">{label}:</dt>
            <dd className="break-words font-medium" data-qa-mask={mask}>
              {value}
            </dd>
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
