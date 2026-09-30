/**
 * Куда идёт разобранная реплика — порядок разбора ответа `understand`
 * на клиенте (ТЗ Greeting 2.0 §4А.7, финальный аудит ветки K).
 *
 * Порядок и есть правило, поэтому он здесь, а не в компоненте:
 *
 *   1. потолок (В-14) запоминается даже из устаревшего ответа — он
 *      правда исчерпан, и советник тоже должен замолчать;
 *   2. устаревший ответ (микрофон выключен, сказано следующее) — никуда;
 *   3. статус не `ok` — строка и судьба микрофона (`voice-status.ts`);
 *      о потолке говорит только первый на странице;
 *   4. согласие на генерацию — мимо реестра, владельцу кнопки
 *      (`consentRoute`, K7): деньги не зависят от реестра интентов;
 *   5. остальное — реестр интентов → план (`dispatchVoiceResult`).
 *
 * Чистая функция с внедрёнными зависимостями — `scripts/voice-route.test.ts`;
 * `VoiceAssistant` только исполняет итог (строка, карточка, переход).
 */

import { consentRoute } from './voice-consent';
import {
  dispatchVoiceResult,
  type VoiceDispatchContext,
  type VoiceIntentRegistry,
  type VoicePlan,
} from './voice-intents';
import { voiceStatusOutcome, type VoiceStatusTexts } from './voice-status';
import type {
  VoiceCurrentField,
  VoiceScreenCurrent,
  VoiceUnderstandResult,
} from './voice-types';
import { VOICE_CURRENT_FIELDS } from './voice-types';

export interface VoiceLine {
  text: string;
  tone: 'info' | 'warning' | 'success';
}

/** Ровно то, что маршруту нужно от владельца кнопки генерации. */
export interface VoiceRouteConsentTarget {
  isOpen: () => boolean;
  consent: (
    confidence: number,
    hasPendingCard: boolean,
    isCurrent: () => boolean
  ) => Promise<VoiceLine | null>;
  cancel: () => VoiceLine | null;
  interrupt: () => void;
}

export interface VoiceRouteDeps {
  /** Ответ ещё нужен (тот же отрезок, микрофон не выключали). */
  isCurrent: () => boolean;
  /** Карточка «я понял так» на экране — СЕЙЧАС, а не в начале фразы. */
  hasPendingCard: () => boolean;
  consentTarget: () => VoiceRouteConsentTarget | null;
  markBudgetExhausted: () => void;
  /** Право сказать о потолке — первому на странице (один раз). */
  claimBudgetNotice: () => boolean;
  /** Ответ актуален — показать, что услышано. */
  onHeard: (transcript: string | null) => void;
  handlers: () => VoiceIntentRegistry;
  dispatch: Omit<VoiceDispatchContext, 'hasPending'>;
  texts: VoiceStatusTexts & {
    /** Согласие сказано, а кнопки генерации на экране нет. */
    noButton: string;
    /** «Да» при открытой сводке — что сказать для запуска. */
    sayHint: string;
  };
}

export type VoiceRouteOutcome =
  /** Ответ устарел — ни строки, ни карточки. */
  | { kind: 'stale' }
  /**
   * Не `ok`: строка и что сделать с микрофоном — `today` (потолок, до
   * конца суток), `until-tap` (оператор, вход, лимит аккаунта).
   */
  | {
      kind: 'status';
      line: VoiceLine | null;
      stop: 'today' | 'until-tap' | null;
    }
  /** Согласие / «нет» сводке / подсказка при сводке — только строка. */
  | { kind: 'line'; line: VoiceLine | null }
  /** Реестр интентов: план для экрана. */
  | { kind: 'plan'; plan: VoicePlan };

export async function routeVoiceResult(
  result: VoiceUnderstandResult,
  deps: VoiceRouteDeps
): Promise<VoiceRouteOutcome> {
  const budget = result.status === 'budget-exhausted';
  if (budget) deps.markBudgetExhausted();
  if (!deps.isCurrent()) return { kind: 'stale' };
  deps.onHeard(result.transcript);

  // Право сказать о потолке берётся, только если о нём и правда есть
  // что сказать: иначе первый обычный ответ отнял бы его у советника.
  const status = voiceStatusOutcome(
    result,
    deps.texts,
    budget && deps.claimBudgetNotice()
  );
  if (status) {
    return {
      kind: 'status',
      line: status.text
        ? {
            text: status.text,
            tone: status.tone === 'info' ? 'info' : 'warning',
          }
        : null,
      stop: status.stopForToday
        ? 'today'
        : status.stopUntilTap
          ? 'until-tap'
          : null,
    };
  }

  const target = deps.consentTarget();
  const route = consentRoute(
    result.intent?.kind,
    deps.hasPendingCard(),
    !!target?.isOpen()
  );
  if (route === 'consent') {
    const said = target
      ? await target.consent(
          result.confidence,
          deps.hasPendingCard(),
          deps.isCurrent
        )
      : { text: deps.texts.noButton, tone: 'info' as const };
    if (!deps.isCurrent()) return { kind: 'stale' };
    return { kind: 'line', line: said };
  }
  if (route === 'cancel') {
    return { kind: 'line', line: target?.cancel() ?? null };
  }
  if (route === 'hint') {
    return { kind: 'line', line: { text: deps.texts.sayHint, tone: 'info' } };
  }
  if (route === 'interrupt') target?.interrupt();
  return {
    kind: 'plan',
    plan: dispatchVoiceResult(result, deps.handlers(), {
      ...deps.dispatch,
      hasPending: deps.hasPendingCard(),
    }),
  };
}

/**
 * Строка рядом с планом. У карточки — `reply` сервера: он мог отбросить
 * часть сказанного (тон, недоступный поводу) и объясняет это рядом с
 * карточкой, а не вместо неё. «Да» строку не трогает — её напишет итог
 * применения.
 */
export function planLine(
  plan: VoicePlan,
  result: Pick<VoiceUnderstandResult, 'reply'>
): VoiceLine | null | 'keep' {
  switch (plan.kind) {
    case 'propose':
      return result.reply ? { text: result.reply, tone: 'info' } : null;
    case 'confirm':
      return 'keep';
    case 'cancel':
    case 'help':
      return null;
    case 'reply':
      return { text: plan.text, tone: 'info' };
    case 'navigate':
      return plan.text ? { text: plan.text, tone: 'info' } : null;
  }
}

/**
 * Значения брифа на экране → тело `current` (изменение контракта 1).
 * Только известные ключи и только строки: пустое поле — `null`
 * («не выбрано»), не строка — не отправляется (сервер всё равно проверит,
 * но мусор в теле ему незачем). Ничего не осталось — `undefined`, поля
 * `current` в запросе нет.
 */
export function screenCurrentOf(
  raw: VoiceScreenCurrent | null | undefined
): VoiceScreenCurrent | undefined {
  if (!raw) return undefined;
  const out: VoiceScreenCurrent = {};
  let any = false;
  for (const k of VOICE_CURRENT_FIELDS as readonly VoiceCurrentField[]) {
    const v: unknown = raw[k];
    if (v === null || v === '') {
      out[k] = null;
      any = true;
    } else if (typeof v === 'string') {
      out[k] = v;
      any = true;
    }
  }
  return any ? out : undefined;
}
