// Помощники блока «Я в кадре: отметка „младше 18“» карточки пользователя
// (В-4 ТЗ Greeting 2.0, заход 8). Снятие — после апелляции через
// поддержку; режим оно не включает: человек проходит согласие и
// автопроверку заново, под общим рубильником PERSONA_ENABLED.
import type { PersonaAgeState } from './types';

/** Те же границы, что у бэкенда (`PERSONA_AGE_CLEAR_REASON_MIN/MAX`). */
export const PERSONA_AGE_REASON_MIN = 3;
export const PERSONA_AGE_REASON_MAX = 500;

export type ReasonCheck = { ok: true; reason: string } | { ok: false; error: string };

/** Причина обрезается так же, как на сервере, и мерится после обрезки. */
export function checkClearReason(raw: string): ReasonCheck {
  const reason = raw.trim();
  if (reason.length < PERSONA_AGE_REASON_MIN) {
    return { ok: false, error: `Причина — не короче ${PERSONA_AGE_REASON_MIN} символов` };
  }
  if (reason.length > PERSONA_AGE_REASON_MAX) {
    return { ok: false, error: `Причина — не длиннее ${PERSONA_AGE_REASON_MAX} символов` };
  }
  return { ok: true, reason };
}

/** Подписи причин отказа автопроверки (`PERSONA_REFUSALS` бэкенда). */
export const REFUSAL_LABEL: Record<string, string> = {
  'check-unavailable': 'проверка недоступна',
  'no-face': 'лица нет',
  'multiple-faces': 'несколько лиц',
  'not-frontal': 'не анфас',
  'poor-quality': 'плохое качество',
  'screen-or-print': 'экран или распечатка',
  'not-same-person': 'на ролике другой человек',
  'no-live-motion': 'нет живого движения',
  'age-unknown': 'возраст не определён',
  'under-18': 'младше 18 по оценке ИИ',
};

export function refusalsText(refusals: string[] | null | undefined): string {
  if (!refusals || refusals.length === 0) return '—';
  return refusals.map((r) => REFUSAL_LABEL[r] ?? r).join(', ');
}

export type PersonaAgeTone = 'ok' | 'warning' | 'critical' | 'muted';

/** Одна строка состояния для карточки и её тон. */
export function personaAgeSummary(state: PersonaAgeState | null): { text: string; tone: PersonaAgeTone } {
  if (!state) return { text: 'загружается…', tone: 'muted' };
  const p = state.persona;
  if (!p) return { text: 'Персоны нет — режимом «Я в кадре» не пользовался', tone: 'muted' };
  if (p.under18) {
    return {
      text: p.filesPending
        ? 'Отметка «младше 18» стоит; файлы проверки ещё удаляются — снять можно, когда хранилище их примет'
        : 'Отметка «младше 18» стоит: режим закрыт, POST /personas отвечает 403',
      tone: 'critical',
    };
  }
  if (p.deletePending) return { text: 'Персона удаляется (дочищает крон)', tone: 'warning' };
  if (p.verified) return { text: 'Персона проверена, отметки нет', tone: 'ok' };
  return { text: 'Отметки нет; проверка не пройдена или не начата', tone: 'muted' };
}

export function canClearAgeMark(state: PersonaAgeState | null): boolean {
  return state?.persona?.under18 === true;
}

/** Подтверждение перед снятием — что именно произойдёт и чего не будет. */
export function clearConfirmText(who: string, personaEnabled: boolean): string {
  return (
    `Снять отметку «младше 18» у ${who}?\n\n` +
    'Режим «Я в кадре» это НЕ включает: человек заново даст согласие и пройдёт автопроверку; ' +
    'если ИИ снова оценит возраст ниже 18 — отметка встанет снова.' +
    (personaEnabled ? '' : '\n\nСейчас режим выключен рубильником PERSONA_ENABLED — повторить попытку человек сможет только после включения.') +
    '\n\nПричина попадёт в журнал снятий.'
  );
}
