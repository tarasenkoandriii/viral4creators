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
 *    localStorage — тем же ключом, что у микрофона (свой на человека,
 *    с тарифом рядом), — и помощник
 *    говорит об этом один раз на страницу (§4А.7.5), сколько бы каналов
 *    ни узнали о нём.
 * 4. **Играет ли реплика** — микрофону, чтобы не записать советника.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  createBudgetMemory,
  createHintPlayer,
  createOnceClaim,
  dropLegacyBudgetKey,
  voiceBudgetUserOf,
  type AudioLike,
  type VoiceBudgetOwner,
} from './hint-audio';
import { usePlanState } from './plan-context';
import { getTelegramWebApp } from './telegram';

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

/** Идентификатор человека для ключа потолка (`voiceBudgetUserOf`). */
function budgetUserId(): string {
  const tg = getTelegramWebApp()?.initDataUnsafe as
    | { user?: { id?: number } }
    | undefined;
  return voiceBudgetUserOf({
    telegramUserId: tg?.user?.id ?? null,
    devUserId:
      import.meta.env.VITE_ALLOW_DEV_AUTH === 'true'
        ? import.meta.env.VITE_DEV_USER_ID || '123'
        : null,
  });
}

/**
 * Чей потолок сейчас: человек и его тариф. Тариф — из общего контекста
 * режима; сменился — новое значение, и запомненное «исчерпан» для
 * прежнего тарифа больше не действует (изменение контракта 6).
 */
export function useVoiceBudgetOwner(): VoiceBudgetOwner {
  const plan = usePlanState()?.plan ?? null;
  const [userId] = useState(budgetUserId);
  useEffect(dropLegacyOnce, []);
  return useMemo(() => ({ userId, plan }), [userId, plan]);
}

let legacyDropped = false;
/** Старый общий ключ — убрать один раз на страницу. */
function dropLegacyOnce(): void {
  if (legacyDropped) return;
  legacyDropped = true;
  dropLegacyBudgetKey(deviceStorage());
}

const budgetMemory = createBudgetMemory(deviceStorage);

/**
 * Потолок голоса исчерпан сегодня (UTC). Общий для советника и
 * микрофона: узнал один — молчит и второй, до конца суток, а не до
 * перезагрузки страницы.
 */
export function isVoiceBudgetExhaustedToday(
  owner: VoiceBudgetOwner,
  now: Date = new Date()
): boolean {
  return budgetMemory.isExhausted(owner, now);
}

export function markVoiceBudgetExhausted(
  owner: VoiceBudgetOwner,
  now: Date = new Date()
): void {
  budgetMemory.mark(owner, now);
}

/**
 * Право сказать об исчерпанном потолке — первому, кто спросит, на
 * странице. «Говорит об этом один раз» (§4А.7.5), а не по разу на канал.
 */
export const claimVoiceBudgetNotice: () => boolean = createOnceClaim();
