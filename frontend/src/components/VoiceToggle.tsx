/**
 * Переключатель «голосом» — ТЗ Greeting 2.0 §4А.5, решение В-10.
 *
 * Рядом с чекбоксом советника, отдельной галочкой: голос — второй канал
 * того же советника, а не второй советник, и по умолчанию выключен
 * (синтез стоит денег на каждой новой подсказке). Без включённого
 * советника переключателя нет вовсе — сервер такое включение всё равно
 * отверг бы (409), а неработающая галочка хуже отсутствующей.
 *
 * В отличие от галочки советника, голос можно включить и выключить на
 * любом шаге: он не меняет подсказок, только канал, которым они
 * доходят. Поэтому монтировать его стоит НЕ под условием `canEnable`.
 */

import { useState } from 'react';
import { useI18n } from '../lib/i18n-context';
import { setWizardGuideVoice } from '../services/wizard-guide-api';
import { markGesture } from '../lib/hint-audio-session';
import type { WizardGuideState } from '../types';

export function VoiceToggle({
  projectId,
  guide,
  onChange,
}: {
  projectId: string;
  /** Состояние советника проекта — то же, что держит мастер. */
  guide: WizardGuideState | null;
  /** Новое состояние с сервера — мастер кладёт его к себе. */
  onChange: (next: WizardGuideState) => void;
}) {
  const { dict } = useI18n();
  const t = dict.wizardGuide;
  const [busy, setBusy] = useState(false);

  if (!guide?.available || !guide.enabled) return null;

  const toggle = async (next: boolean) => {
    setBusy(true);
    // Отказ — молча: галочка останется в прежнем положении, потому что
    // рисуется по состоянию с сервера, а не по клику.
    const updated = await setWizardGuideVoice(projectId, next).catch(
      () => null
    );
    setBusy(false);
    if (updated) onChange(updated);
  };

  return (
    <label className="flex items-start gap-2">
      <input
        type="checkbox"
        className="mt-0.5"
        checked={!!guide.voice}
        disabled={busy}
        onChange={(e) => {
          // Включение — само по себе касание: отпираем звук здесь же,
          // синхронно, чтобы первая реплика прозвучала без второго
          // «коснитесь» (§4А.4).
          if (e.target.checked) markGesture();
          void toggle(e.target.checked);
        }}
      />
      <span>
        <span className="font-medium">{t.voiceToggleLabel}</span>
        <span className="block text-sm text-[var(--muted)]">
          {t.voiceToggleHint}
        </span>
      </span>
    </label>
  );
}
