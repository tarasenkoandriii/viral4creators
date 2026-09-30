/**
 * Голосовая навигация по шагам и голосовая справка — этап K6 ТЗ
 * `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md` §4А.7.2, §4А.7.3.
 *
 * ## Второго списка шагов нет
 *
 * «Дальше», «назад», «к сценарию» решаются по ТОМУ ЖЕ списку
 * `greetingSteps` и тому же виду `toStepsView`, что рисует степпер, — их
 * сюда передаёт мастер, а не строит этот файл. Порядок шагов, их цели и
 * «текущий» берутся оттуда; своего перечня шагов здесь нет, и потому
 * голос не может повести туда, куда не пускает степпер.
 *
 * Доступность — ровно правило кнопки степпера (`Stepper`: шаг с целью и
 * не текущий), вынесенное в `stepIsReachable`: им же мастер строит
 * `reachable` для строки готовности и советника. Одно правило на
 * степпер, советника и голос.
 *
 * ## Отказ — причиной, а не «не могу»
 *
 * Причина выводится из тех же фактов (`GreetingFacts`), из которых
 * `greetingSteps` поставил шагу `target: null`: нет сессии — фото и
 * сценария на экране ещё нет; нет сценария — нет видео. Сама причина
 * ищется ТОЛЬКО когда цели у шага нет: решение «можно ли» принимает
 * список шагов, а факты лишь объясняют уже принятое.
 *
 * ## Без карточки подтверждения
 *
 * Навигация и справка ничего не меняют в данных, поэтому применяются
 * сразу (§4А.7.2): план `navigate`/`help`, а не `propose`.
 */

import { getDictionary, type Dictionary } from './get-dictionary';
import type { GreetingHelpTopic } from './greeting-help';
import { helpTopicOf } from './greeting-help';
import type { GreetingFacts, GreetingStepId } from './greeting-steps';
import { isLocale, type Locale } from './i18n';
import type { IntentHandler, VoiceIntentRegistry } from './voice-intents';
import { withIntentHandler } from './voice-intents';
import type { VoiceIntent } from './voice-types';
import type { WizardStep, WizardStepsView } from './wizard-steps';

export type VoiceNavTarget = Extract<VoiceIntent, { kind: 'navigate' }>['to'];

/**
 * Подписи четырёх шагов из словаря мастера — одно соответствие на
 * степпер и на реплики голоса. Реплика на языке речи берёт подписи из
 * словаря ТОГО языка, и совпадают они с тем, что степпер пишет на нём же.
 */
export function greetingStepLabels(
  w: Dictionary['greetingVideoWizard']
): Record<GreetingStepId, string> {
  return {
    brief: w.occasionLabel,
    references: w.referencesHeading,
    script: w.scriptHeading,
    video: w.videoHeading,
  };
}

/**
 * Можно ли перейти на шаг `i` — то же, что кликабельность кнопки
 * степпера: у шага есть цель, и это не тот шаг, на котором человек стоит.
 */
export function stepIsReachable<S extends string>(
  view: WizardStepsView<S>,
  i: number
): boolean {
  return view.targets[i] != null && i !== view.current;
}

export type NavRefusal =
  /** Уже на этом шаге. */
  | 'here'
  /** «Назад» с первого шага. */
  | 'first'
  /** «Дальше» с последнего. */
  | 'last'
  /** Нет сессии — после брифа ничего ещё нет. */
  | 'no-session'
  /** Нет сценария — нет видео. */
  | 'no-script'
  /** Цели нет, а факты не объясняют почему — не должно случаться. */
  | 'unavailable';

export type NavDecision =
  | { kind: 'go'; step: GreetingStepId }
  | { kind: 'refuse'; reason: NavRefusal; step: GreetingStepId | null };

/** Всё, что голосу нужно от степпера, — ровно то, из чего он нарисован. */
export interface VoiceNavState {
  /** Результат `greetingSteps(…)` — тот же массив, что ушёл в `toStepsView`. */
  steps: readonly WizardStep<GreetingStepId>[];
  /** Результат `toStepsView(steps, …)` — тот же, что получил `Stepper`. */
  view: WizardStepsView<GreetingStepId>;
  facts: GreetingFacts;
}

/** Почему у шага нет цели — из тех же фактов, что убрали цель. */
function whyUnavailable(facts: GreetingFacts): NavRefusal {
  if (!facts.hasSession) return 'no-session';
  if (!facts.hasPrompt) return 'no-script';
  return 'unavailable';
}

export function decideNavigation(
  to: VoiceNavTarget,
  nav: VoiceNavState
): NavDecision {
  const { steps, view, facts } = nav;
  const i =
    to === 'next'
      ? view.current + 1
      : to === 'back'
        ? view.current - 1
        : steps.findIndex((s) => s.id === to);
  if (to === 'back' && i < 0)
    return { kind: 'refuse', reason: 'first', step: null };
  if (to === 'next' && i >= steps.length) {
    return { kind: 'refuse', reason: 'last', step: null };
  }
  const step = steps[i];
  // Имени нет в списке (сервер держит закрытый набор, но клиент ему не
  // обязан верить) — туда нельзя, как и в шаг без цели.
  if (!step) return { kind: 'refuse', reason: 'unavailable', step: null };
  if (i === view.current)
    return { kind: 'refuse', reason: 'here', step: step.id };
  const target = view.targets[i];
  if (!stepIsReachable(view, i) || !target) {
    return { kind: 'refuse', reason: whyUnavailable(facts), step: step.id };
  }
  return { kind: 'go', step: target };
}

export type VoiceNavTexts = Dictionary['voiceNav'];

const REFUSAL_KEY: Record<NavRefusal, keyof VoiceNavTexts> = {
  here: 'here',
  first: 'first',
  last: 'last',
  'no-session': 'noSession',
  'no-script': 'noScript',
  unavailable: 'unavailable',
};

/** Строка отказа; `{step}` — подпись шага на том же языке. */
export function navRefusalText(
  decision: Extract<NavDecision, { kind: 'refuse' }>,
  texts: VoiceNavTexts,
  labels: Record<GreetingStepId, string>
): string {
  const template = texts[REFUSAL_KEY[decision.reason]];
  return template.replace('{step}', decision.step ? labels[decision.step] : '');
}

/**
 * Язык реплики: язык речи, если он из пяти, иначе интерфейса — то же
 * правило, что у сервера (`replyLocaleOf`), чтобы отказ навигации не
 * звучал на другом языке, чем переспрос сервера.
 */
export function replyLocale(spoken: string | null, ui: Locale): Locale {
  return isLocale(spoken) ? spoken : ui;
}

/** Реплики навигации и подписи шагов на языке речи. */
export function navTextsFor(
  spoken: string | null,
  ui: Locale
): { texts: VoiceNavTexts; labels: Record<GreetingStepId, string> } {
  const d = getDictionary(replyLocale(spoken, ui));
  return {
    texts: d.voiceNav,
    labels: greetingStepLabels(d.greetingVideoWizard),
  };
}

/**
 * Тема справки для голоса: карточка в фокусе (та, что ушла серверу как
 * `screen.card`), иначе карточка текущего шага. Резолвер один — тот же
 * `helpTopicOf`, что у кнопки (i): голос открывает ровно тот ролик,
 * который открыла бы кнопка этой карточки.
 */
export function voiceHelpTopic(
  card: string | null | undefined,
  stepCard: string
): GreetingHelpTopic | null {
  return (card ? helpTopicOf(card) : null) ?? helpTopicOf(stepCard);
}

export interface VoiceNavHandlersContext {
  /** Нет — мастер не дал степпер: навигации голосом нет. */
  nav: VoiceNavState | null;
  /** Карточка в фокусе — та же, что ушла серверу в `screen.card`. */
  card: string | null;
  /** Карточка текущего шага — если фокус ни в одной из карточек. */
  stepCard: string;
  /** Есть ли лист справки (`HelpProvider`) — как у кнопки (i). */
  canOpenHelp: boolean;
  uiLocale: Locale;
  /**
   * Секция шага на экране (`isMostlyVisible` по её якорю). Нужна одному
   * случаю: человек назвал шаг, на котором стоит, но укатил от него —
   * тогда голос прокручивает к нему, как ни в чём не бывало (решение
   * аудита волны 2); правила степпера при этом те же.
   */
  stepInView: (step: GreetingStepId) => boolean;
}

/** Обработчик `navigate`: сразу `navigate` или отказ причиной. */
export function navigateHandler(
  c: VoiceNavHandlersContext
): IntentHandler<'navigate'> {
  return (intent, ctx, result) => {
    if (!c.nav) return { kind: 'reply', text: ctx.texts.manual };
    const decision = decideNavigation(intent.to, c.nav);
    if (decision.kind === 'go')
      return { kind: 'navigate', step: decision.step };
    const { texts, labels } = navTextsFor(result.language, c.uiLocale);
    // «К сценарию», стоя на сценарии, но глядя на бриф: отказ «вы уже
    // там» был бы правдой по степперу и неправдой по экрану. Прокрутка
    // к СВОЕМУ шагу ничего не меняет в данных и не обходит степпер —
    // туда он и так показывает.
    if (decision.reason === 'here' && decision.step) {
      if (!c.stepInView(decision.step)) {
        return {
          kind: 'navigate',
          step: decision.step,
          text: texts.hereShowing.replace('{step}', labels[decision.step]),
        };
      }
    }
    return { kind: 'reply', text: navRefusalText(decision, texts, labels) };
  };
}

/** Обработчик `help`: открыть лист темы — как кнопка (i), без автозапуска. */
export function helpHandler(c: VoiceNavHandlersContext): IntentHandler<'help'> {
  return (_intent, _ctx, result) => {
    const topic = c.canOpenHelp ? voiceHelpTopic(c.card, c.stepCard) : null;
    if (topic) return { kind: 'help', topic };
    return {
      kind: 'reply',
      text: navTextsFor(result.language, c.uiLocale).texts.noHelp,
    };
  };
}

/** Реестр с обработчиками K6. */
export function withNavHelpHandlers(
  registry: VoiceIntentRegistry,
  c: VoiceNavHandlersContext
): VoiceIntentRegistry {
  return withIntentHandler(
    withIntentHandler(registry, 'navigate', navigateHandler(c)),
    'help',
    helpHandler(c)
  );
}
