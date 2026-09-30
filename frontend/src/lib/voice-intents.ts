/**
 * Реестр обработчиков голосовых интентов — этап K3 ТЗ
 * `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md` §4А.2, §4А.7.
 *
 * Разбор реплики приходит с сервера интентом; здесь он превращается в
 * ПЛАН для экрана: показать карточку «я понял так», применить или снять
 * карточку на экране, ответить строкой. Сам экран ничего не решает, а
 * исполняет план — так правила «что можно голосом» живут в одном месте
 * и проверяются без браузера (`scripts/voice-intents.test.ts`).
 *
 * Реестр расширяемый: здесь — `fill`, `command`, `confirm`, `cancel`,
 * `unknown`; `navigate` и `help` (K6) добавляет `withNavHelpHandlers`
 * (`voice-nav.ts`) через `withIntentHandler`, не трогая этот файл.
 * `consent` (K7) сюда не попадает вовсе: деньги не должны зависеть от
 * реестра — его до реестра забирает `consentRoute` (`voice-consent.ts`,
 * порядок — `voice-route.ts`). Интент без обработчика не теряется
 * молча: человек слышит, что голосом этого пока нельзя.
 */

import type { VoiceCard } from './voice-confirm';
import type { GreetingHelpTopic } from './greeting-help';
import type { GreetingStepId } from './greeting-steps';
import type {
  VoiceCommand,
  VoiceIntent,
  VoiceUnderstandResult,
} from './voice-types';

export type VoicePlan =
  | { kind: 'propose'; card: VoiceCard }
  | { kind: 'confirm' }
  | { kind: 'cancel' }
  | { kind: 'reply'; text: string }
  // K6 (`voice-nav.ts`): применяются сразу, без карточки «я понял так» —
  // ни прокрутка к шагу, ни лист справки ничего не меняют в данных.
  | { kind: 'navigate'; step: GreetingStepId; text?: string }
  | { kind: 'help'; topic: GreetingHelpTopic };

/** Итог команды у зарегистрированного обработчика экрана. */
export type VoiceCommandOutcome =
  | { kind: 'propose'; card: VoiceCard }
  /** Отказ с причиной — той же, что написана на экране. */
  | { kind: 'refuse'; text: string }
  /**
   * Команда есть, но сказанное в этой форме голосом не выполнить
   * (сервер не назвал тон) — «пока руками», как у команды без обработчика.
   */
  | { kind: 'manual' };

export interface VoiceReplyTexts {
  /** «Не понял, скажите иначе». */
  unknown: string;
  /** «Этого голосом пока нельзя — сделайте руками». */
  manual: string;
  /** «Подтверждать нечего». */
  nothingPending: string;
}

export interface VoiceDispatchContext {
  /** На экране карточка «я понял так». */
  hasPending: boolean;
  /** Умеет ли экран СЕЙЧАС заполнить поле с этим хуком. */
  canFill: (target: string) => boolean;
  /** Обработчик команды на экране; `null` — такой команды тут нет. */
  command: (
    command: VoiceCommand,
    args: Record<string, string> | undefined
  ) => VoiceCommandOutcome | null;
  texts: VoiceReplyTexts;
}

type IntentOf<K extends VoiceIntent['kind']> = Extract<
  VoiceIntent,
  { kind: K }
>;

export type IntentHandler<K extends VoiceIntent['kind']> = (
  intent: IntentOf<K>,
  ctx: VoiceDispatchContext,
  result: VoiceUnderstandResult
) => VoicePlan;

export type VoiceIntentRegistry = {
  readonly [K in VoiceIntent['kind']]?: IntentHandler<K>;
};

const replyOr = (
  result: VoiceUnderstandResult,
  fallback: string
): VoicePlan => ({ kind: 'reply', text: result.reply || fallback });

/** Обработчики этапа K3. */
export const K3_INTENT_HANDLERS: VoiceIntentRegistry = {
  fill: (intent, ctx, result) => {
    // Поле, которого на экране нет (карточка другого шага, хук волны 2),
    // не попадает в карточку: «Да» на него ничего бы не сделало, а
    // человек решил бы, что оно применилось.
    const fields = intent.fields.filter((f) => ctx.canFill(f.target));
    if (fields.length === 0) return replyOr(result, ctx.texts.unknown);
    return { kind: 'propose', card: { kind: 'fill', fields } };
  },
  confirm: (_intent, ctx) =>
    ctx.hasPending
      ? { kind: 'confirm' }
      : { kind: 'reply', text: ctx.texts.nothingPending },
  cancel: (_intent, ctx) =>
    ctx.hasPending
      ? { kind: 'cancel' }
      : { kind: 'reply', text: ctx.texts.nothingPending },
  command: (intent, ctx, result) => {
    const outcome = ctx.command(intent.command, intent.args);
    if (!outcome || outcome.kind === 'manual') {
      return replyOr(result, ctx.texts.manual);
    }
    return outcome.kind === 'propose'
      ? { kind: 'propose', card: outcome.card }
      : { kind: 'reply', text: outcome.text };
  },
  // Ниже порога уверенности сервер присылает `unknown` и переспрос
  // НАЗВАНИЕМ поля в `reply` (§4А.7.1) — его и показываем.
  unknown: (_intent, ctx, result) => replyOr(result, ctx.texts.unknown),
};

/** Новый реестр с добавленным (или заменённым) обработчиком. */
export function withIntentHandler<K extends VoiceIntent['kind']>(
  registry: VoiceIntentRegistry,
  kind: K,
  handler: IntentHandler<K>
): VoiceIntentRegistry {
  return { ...registry, [kind]: handler };
}

/**
 * Разбор → план. Только для `status: 'ok'`: остальные статусы — не
 * интент, а состояние распознавания (`voice-status.ts`).
 */
export function dispatchVoiceResult(
  result: VoiceUnderstandResult,
  registry: VoiceIntentRegistry,
  ctx: VoiceDispatchContext
): VoicePlan {
  const intent = result.intent ?? { kind: 'unknown' as const };
  const handler = registry[intent.kind] as
    | IntentHandler<typeof intent.kind>
    | undefined;
  if (!handler) return replyOr(result, ctx.texts.manual);
  return handler(intent as never, ctx, result);
}
