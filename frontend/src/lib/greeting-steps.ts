/**
 * Шаги поздравления — «Тонкая красная линия» §4.5, волна D, этап 12.
 *
 * ## Четыре шага против девяти секций
 *
 * На экране девять секций (бриф, фото, сценарий, голос, музыка,
 * карточки, наклейки, сцены, видео), а в степпере четыре. Это КАРТА, а
 * не оглавление: девять номеров в строке на телефоне нечитаемы, а
 * вопрос, на который отвечает степпер, — «где я», а не «что здесь
 * есть».
 *
 * ## Почему клик — якорь, а не переход
 *
 * Greeting — вертикальная лента: человек листает уже готовое и
 * возвращается к нему глазами. Ломать её ради единообразия с товаркой
 * незачем, поэтому клик по шагу прокручивает к секции.
 *
 * Из этого следует неочевидное: **«текущий шаг» определяется
 * СОСТОЯНИЕМ, а не прокруткой.** Экран один, палец может доехать куда
 * угодно, и считать шагом то, что в этот момент в середине экрана,
 * значит отвечать на случайность — в том числе советнику, который по
 * этому шагу выбирает, о чём говорить.
 *
 * ## Почему завершённость задаётся явно
 *
 * Позиционное `i < current` здесь врёт: голос, музыка, карточки
 * заполняются в любом порядке, а шаг «Фото» может остаться пустым
 * навсегда и при этом не мешать ролику.
 */

import type { WizardStep } from './wizard-steps';

export type GreetingStepId = 'brief' | 'references' | 'script' | 'video';

export const GREETING_STEP_IDS = [
  'brief',
  'references',
  'script',
  'video',
] as const;

/** Всё о поздравлении, что нужно шагам. */
export interface GreetingFacts {
  /** Сессия заведена — до неё существует только бриф. */
  hasSession: boolean;
  /** Сценарий собран. */
  hasPrompt: boolean;
  /** Ролик готов. */
  hasVideo: boolean;
}

export function greetingFactsOf(
  sessionId: string | null,
  prompt: unknown,
  video: unknown
): GreetingFacts {
  return {
    hasSession: !!sessionId,
    hasPrompt: !!prompt,
    hasVideo: !!video,
  };
}

/**
 * Текущий шаг — ровно та же таблица, что была в `stepIndexOf`, только
 * идентификаторами вместо индексов.
 */
export function greetingStepOf(facts: GreetingFacts): GreetingStepId {
  if (!facts.hasSession) return 'brief';
  if (facts.hasVideo) return 'video';
  if (facts.hasPrompt) return 'script';
  return 'references';
}

/**
 * Доступность и завершённость четырёх шагов.
 *
 * Бриф доступен всегда: к нему возвращаются править повод и текст даже
 * после сборки сценария — именно так чинят помеченный модерацией
 * сценарий.
 */
export function greetingSteps(
  facts: GreetingFacts,
  labels: Record<GreetingStepId, string>
): WizardStep<GreetingStepId>[] {
  return [
    {
      id: 'brief',
      label: labels.brief,
      target: 'brief',
      // Бриф считается пройденным, когда с него ушли: до создания
      // сессии его поля ещё правятся, и галочка обещала бы больше, чем
      // есть.
      done: facts.hasSession,
    },
    {
      id: 'references',
      label: labels.references,
      // Секции фото до создания сессии на экране нет вовсе — вести
      // туда некуда.
      target: facts.hasSession ? 'references' : null,
      // Фото необязательны; «пройден» значит «дальше уже ушли».
      done: facts.hasPrompt,
    },
    {
      id: 'script',
      label: labels.script,
      target: facts.hasSession ? 'script' : null,
      done: facts.hasPrompt,
    },
    {
      id: 'video',
      label: labels.video,
      // Секция видео появляется вместе со сценарием.
      target: facts.hasPrompt ? 'video' : null,
      done: facts.hasVideo,
    },
  ];
}

/** Идентификатор секции на экране — по нему прокручивает клик. */
export function greetingAnchorId(step: GreetingStepId): string {
  return `greeting-${step}`;
}
