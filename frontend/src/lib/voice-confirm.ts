/**
 * Карточка «я понял так» — этап K3 ТЗ
 * `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md` §4А.2 п. 3:
 * «разобранное показывается карточкой и применяется только после „Да“.
 * Ничего не применяется молча».
 *
 * Конечный автомат без React: что на карточке, что уходит серверу как
 * `pending` и что применяется по «Да» — проверяется
 * `scripts/voice-confirm.test.ts`.
 */

import type { VoiceCommand, VoiceField } from './voice-types';

export type VoiceCard =
  /** Поля: подпись → значение; по «Да» — в поля экрана. */
  | { kind: 'fill'; fields: VoiceField[] }
  /**
   * Действие мастера (пересобрать сценарий): оно тратит деньги или
   * стирает сделанное, и молча его запускать нельзя так же, как поле.
   */
  | { kind: 'action'; command: VoiceCommand; label: string };

export interface ConfirmState {
  card: VoiceCard | null;
}

export const CONFIRM_INITIAL: ConfirmState = { card: null };

export type ConfirmEvent =
  | { type: 'propose'; card: VoiceCard }
  | { type: 'confirm' }
  | { type: 'cancel' };

/**
 * Уточнение поверх карточки на экране («нет, имя — Анна»): сервер видел
 * `pending` и вернул только исправленное. Поле с тем же хуком
 * заменяется на месте, новое — дописывается: человек поправил одно, а не
 * продиктовал всё заново.
 */
export function mergeFields(
  current: readonly VoiceField[],
  next: readonly VoiceField[]
): VoiceField[] {
  const out = current.map((f) => next.find((n) => n.target === f.target) ?? f);
  for (const n of next) {
    if (!out.some((f) => f.target === n.target)) out.push(n);
  }
  return out;
}

/**
 * @returns новое состояние и то, что применить (`apply`) — только на
 * «Да» и только если карточка была.
 */
export function confirmReducer(
  state: ConfirmState,
  event: ConfirmEvent
): { state: ConfirmState; apply: VoiceCard | null } {
  switch (event.type) {
    case 'propose': {
      const prev = state.card;
      const card: VoiceCard =
        prev?.kind === 'fill' && event.card.kind === 'fill'
          ? {
              kind: 'fill',
              fields: mergeFields(prev.fields, event.card.fields),
            }
          : event.card;
      return { state: { card }, apply: null };
    }
    case 'confirm':
      return { state: CONFIRM_INITIAL, apply: state.card };
    case 'cancel':
      return { state: CONFIRM_INITIAL, apply: null };
  }
}

/**
 * Что сказать серверу о карточке на экране. У действия полей нет —
 * уходит пустой список: сервер всё равно узнает, что на экране вопрос
 * и «да» — ответ на него (контракт `pending` знает только `fill`).
 */
export function pendingForServer(
  state: ConfirmState
): { kind: 'fill'; fields: VoiceField[] } | undefined {
  if (!state.card) return undefined;
  return {
    kind: 'fill',
    fields: state.card.kind === 'fill' ? state.card.fields : [],
  };
}

/**
 * Что стало с применённым полем (K5, аудит волны 2): карточка сессии
 * сохраняет сама тем же обработчиком, что кнопка (`saved`), поле формы
 * ждёт кнопку человека (`needs-save` + её название с экрана), а
 * сохранение могло не пройти (`failed` + причина, показанная на экране).
 */
export type VoiceFieldApplyEffect =
  | { kind: 'saved' }
  | { kind: 'needs-save'; button: string }
  | { kind: 'failed'; reason: string };

/** Что на самом деле сделало «Да» (`VoiceCommandRegistry.applyCard`). */
export type VoiceApplyOutcome =
  | {
      kind: 'fill';
      applied: number;
      refusals: string[];
      /** Хоть что-то сохранено обработчиком карточки. */
      saved?: true;
      /** Названия кнопок, которые осталось нажать (без повторов). */
      needsSave?: string[];
      /** Причины несохранённого — строки экрана. */
      failures?: string[];
    }
  | { kind: 'action'; ran: boolean; label: string };

export interface VoiceApplyTexts {
  /** «Заполнил» — владелец не сказал, сохранено ли (старый контракт). */
  applied: string;
  /** «Ничего не применилось — поля уже нет на экране». */
  nothingApplied: string;
  /** «Запускаю: {action}». */
  actionStarted: string;
  /** «Это действие сейчас недоступно — сделайте руками». */
  actionStale: string;
  /** «Готово — сохранено». */
  saved: string;
  /** «Заполнил — нажмите «{button}»» (по фразе на кнопку). */
  filledNeedsSave: string;
  /** «Не сохранилось: {reason}». */
  notSaved: string;
}

/**
 * Строка после «Да» — по тому, что применилось, а не по тому, что было на
 * карточке. Частичный успех называет и сделанное, и отказы.
 */
export function applyOutcomeLine(
  outcome: VoiceApplyOutcome,
  texts: VoiceApplyTexts
): { text: string; tone: 'success' | 'warning' } {
  if (outcome.kind === 'action') {
    return outcome.ran
      ? {
          text: texts.actionStarted.replace('{action}', outcome.label),
          tone: 'success',
        }
      : { text: texts.actionStale, tone: 'warning' };
  }
  const { applied, refusals } = outcome;
  const needsSave = outcome.needsSave ?? [];
  const failures = outcome.failures ?? [];
  const reported = !!outcome.saved || needsSave.length > 0 || failures.length;
  // Владелец сказал, что стало с полями, — строка из этого; нет — «Заполнил».
  const done = reported
    ? [
        ...(outcome.saved ? [texts.saved] : []),
        // По фразе на кнопку: кавычки — в шаблоне языка, не здесь.
        ...needsSave.map((b) => texts.filledNeedsSave.replace('{button}', b)),
        ...failures.map((r) =>
          texts.notSaved.replace('{reason}', r.replace(/[.。]\s*$/, ''))
        ),
      ]
    : applied > 0
      ? [texts.applied]
      : [];
  const parts = [...done, ...refusals];
  if (parts.length === 0)
    return { text: texts.nothingApplied, tone: 'warning' };
  return {
    text: parts.join(' '),
    tone:
      refusals.length === 0 && failures.length === 0 ? 'success' : 'warning',
  };
}
