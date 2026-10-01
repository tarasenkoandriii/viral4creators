import { Clock } from 'lucide-react';
import { Alert, Card, ScreenTitle } from '../kit/ui';
import { fmt } from '../kit';
import type { AppDictionary } from '../i18n';
import type { Section } from '../lib/router';

/**
 * Пустые разделы «Знания», «Виджет», «Диалоги» — только плашка этапа
 * (план помощника §2: Э1 знания, Э2 виджет, Э3 передача человеку).
 * Ни кнопок, ни сроков — ничего сверх ТЗ не обещаем.
 */
export function SectionPlaceholder({
  t,
  section,
}: {
  t: AppDictionary['section'];
  section: Section;
}) {
  const s = t[section];
  return (
    <div className="space-y-4">
      <ScreenTitle>{s.title}</ScreenTitle>
      <Alert tone="accent">
        <span className="inline-flex items-center gap-2">
          <Clock size={16} />
          {fmt(t.stagePlate, { stage: s.stage })}
        </span>
      </Alert>
      <Card className="text-sm text-silver-500">{s.text}</Card>
    </div>
  );
}
