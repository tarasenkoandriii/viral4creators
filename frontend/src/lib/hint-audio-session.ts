/**
 * Состояние голоса советника на странице — ТЗ Greeting 2.0 §4А.4, K1.
 *
 * Три вещи живут дольше одного шага и одной строки совета, поэтому они
 * здесь, на уровне модуля, а не в состоянии компонента:
 *
 * 1. **Было ли касание.** Браузер разрешает звук после первого жеста на
 *    странице, а не на шаге: уход на следующий шаг не должен снова
 *    просить «коснитесь».
 * 2. **Один плеер** — почему именно один, сказано в `hint-audio.ts`.
 * 3. **Потолок голоса исчерпан.** Помнится до конца суток UTC в
 *    localStorage — тем же ключом, что у микрофона, — и помощник
 *    говорит об этом один раз на страницу (§4А.7.5), сколько бы каналов
 *    ни узнали о нём.
 * 4. **Играет ли реплика** — микрофону, чтобы не записать советника.
 */

import {
  budgetExhaustedOn,
  createHintPlayer,
  createOnceClaim,
  rememberBudgetExhausted,
  type AudioLike,
} from './hint-audio';

export const hintPlayer = createHintPlayer(
  () => new Audio() as unknown as AudioLike
);

let gestured = false;
const subscribers = new Set<() => void>();

export function hasGesture(): boolean {
  return gestured;
}

/**
 * Касание случилось. Звать СИНХРОННО из обработчика события: отпирание
 * плеера засчитывается браузером только внутри жеста.
 */
export function markGesture(): void {
  hintPlayer.unlock();
  if (gestured) return;
  gestured = true;
  for (const fn of subscribers) fn();
}

export function subscribeGesture(fn: () => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

// ── Голос играет: для микрофона (аудит волны 1, «перебивание») ──────

/** Звучит ли сейчас реплика советника — микрофон на это время глохнет. */
export function isHintPlaying(): boolean {
  return hintPlayer.playing;
}

/** Подписка на начало и конец реплики; возвращает отписку. */
export function onHintPlayingChange(
  cb: (playing: boolean) => void
): () => void {
  return hintPlayer.onPlayingChange(cb);
}

/** Замолчать сейчас — человек заговорил поверх советника. */
export function stopHint(): void {
  hintPlayer.stop();
}

// ── Потолок голоса В-14: один источник на страницу ─────────────────

function deviceStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Потолок голоса исчерпан сегодня (UTC). Общий для советника и
 * микрофона: узнал один — молчит и второй, до конца суток, а не до
 * перезагрузки страницы.
 */
export function isVoiceBudgetExhaustedToday(now: Date = new Date()): boolean {
  return budgetExhaustedOn(deviceStorage(), now);
}

export function markVoiceBudgetExhausted(now: Date = new Date()): void {
  rememberBudgetExhausted(deviceStorage(), now);
}

/**
 * Право сказать об исчерпанном потолке — первому, кто спросит, на
 * странице. «Говорит об этом один раз» (§4А.7.5), а не по разу на канал.
 */
export const claimVoiceBudgetNotice: () => boolean = createOnceClaim();
