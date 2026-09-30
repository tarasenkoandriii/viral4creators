/**
 * Голосовая склейка карточек мастера поздравления (K5, ТЗ Greeting 2.0
 * §4А.7.1): строки отказов, описание значения на карточке «я понял так»
 * и голос в открытой форме кадра.
 *
 * Отдельный `.ts`, а не рядом с компонентами, — потому что это хуки и
 * помощники, которыми пользуются СРАЗУ несколько файлов шагов
 * (`features/projects/greeting/*`), а правило react-refresh требует,
 * чтобы файлы компонентов экспортировали только компоненты.
 */

import { useI18n } from '../../lib/i18n-context';
import {
  type SessionVoiceTexts,
  SESSION_VOICE_TARGETS,
  planReferenceVoice,
  refusalLines,
  needsSave,
} from '../../lib/voice-fields';
import { useVoiceFieldApplier } from './voice-commands';

// ── Голос в элементах сессии (этап K5, ТЗ Greeting 2.0 §4А.7.1) ─────────
//
// Каждая карточка ниже регистрирует свои хуки (`SESSION_VOICE_TARGETS`)
// и применяет подтверждённое «Да» ТЕМИ ЖЕ обработчиками, что её кнопки;
// что применимо к текущему состоянию, решают `plan*Voice` из
// `lib/voice-fields.ts`. Хуки регистрируются, только пока карточка на
// экране (`targets` пуст — поле не попадёт на карточку «я понял так»).

/** Строки отказов K5: свой раздел словаря плюс причины, уже написанные
 * на экране (наклейки под запретом регистра, «сценарий не собран»). */
export function useSessionVoiceTexts(): SessionVoiceTexts {
  const { dict } = useI18n();
  const vf = dict.voiceFields;
  const w = dict.greetingVideoWizard;
  return {
    refusedField: dict.voiceAssistant.refusedField,
    invalid: vf.invalid,
    notOnScreen: vf.notOnScreen,
    busy: vf.busy,
    tooMany: vf.tooMany,
    ambiguous: vf.ambiguous,
    ambiguousNone: vf.ambiguousNone,
    manual: vf.manual,
    conflict: vf.conflict,
    already: vf.already,
    unavailable: {
      'sticker-register': w.stickerUnavailable,
      'no-search': vf.noSearch,
      'no-sticker': vf.noSticker,
      'no-script': w.scriptEmpty,
      // Та же строка, что стоит над карточкой кадров после сборки.
      'references-locked': w.referencesLockedHint,
      'form-closed': vf.formClosed,
      'two-forms': vf.twoForms,
    },
  };
}

/** Значение галочки и пустого титра на карточке «я понял так». */
export function describeSessionValue(
  value: string | boolean,
  vf: { valueOn: string; valueOff: string; cardRemove: string }
): string {
  if (typeof value === 'boolean') return value ? vf.valueOn : vf.valueOff;
  return value === '' ? vf.cardRemove : value;
}

/**
 * Голос в открытую форму кадра (K5): те же `setLabel`/`setDescription`,
 * что `onChange` полей, с теми же потолками (`planReferenceVoice`).
 * Сохраняет человек той же кнопкой — голос форму не отправляет, а
 * строка после «Да» называет эту кнопку (`button`).
 */
export function useReferenceFormVoice(
  active: boolean,
  busy: boolean,
  button: string,
  setLabel: (v: string) => void,
  setDescription: (v: string) => void
): void {
  const { dict } = useI18n();
  const voiceTexts = useSessionVoiceTexts();
  useVoiceFieldApplier({
    targets: active
      ? [
          SESSION_VOICE_TARGETS.referenceLabel,
          SESSION_VOICE_TARGETS.referenceDescription,
        ]
      : [],
    describe: (f) => describeSessionValue(f.value, dict.voiceFields),
    apply: (fields) => {
      const plan = planReferenceVoice(active ? 'one' : 'none', busy, fields);
      if (plan.label !== undefined) setLabel(plan.label);
      if (plan.description !== undefined) setDescription(plan.description);
      const filled = plan.label !== undefined || plan.description !== undefined;
      return {
        refusals: refusalLines(plan.refused, fields, voiceTexts),
        effects: filled ? [needsSave(button)] : [],
      };
    },
  });
}
