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
 * 5. **«Без звука»** — одно на страницу (K4): его кнопка живёт в строке
 *    совета, а слушается и проактивной речью помощника; два состояния
 *    разошлись бы, и выключенный звук продолжал бы говорить отказами.
 * 6. **Активность человека** — касание, клавиша или фраза в микрофон:
 *    по ней отсчитывается 20-секундный простой (`VOICE_IDLE_REPEAT_MS`).
 */

import { useEffect, useMemo, useState } from 'react';
import {
  createBudgetMemory,
  createHintPlayer,
  createOnceClaim,
  dropLegacyBudgetKey,
  createSpeechQueue,
  readMuted,
  writeMuted,
  type SpeechTag,
  voiceBudgetUserOf,
  type AudioLike,
  type VoiceBudgetOwner,
} from './hint-audio';
import { usePlanState } from './plan-context';
import { getTelegramWebApp } from './telegram';

export const hintPlayer = createHintPlayer(
  () => new Audio() as unknown as AudioLike
);

/**
 * Очередь реплик страницы (K4, CONTRACT5): один ожидающий слот поверх
 * общего плеера. Подсказка шага и проактивная речь говорят через неё —
 * новая реплика ждёт конца звучащей, а не обрывает её.
 */
export const speechQueue = createSpeechQueue(hintPlayer);
hintPlayer.onPlayingChange((playing) => {
  if (!playing) speechQueue.idle(Date.now());
});

/** Сказать реплику — сразу или после звучащей (`speechQueue`). */
export function sayReply(url: string, tag: SpeechTag): void {
  speechQueue.say(url, tag, Date.now());
}

/**
 * Уход с шага глушит ТОЛЬКО подсказку этого шага — осознанно: она про
 * экран, которого больше нет. Проактивная речь (готовый ролик, отказ,
 * сводка) — про событие, а не про шаг, и уход с шага её не обрывает.
 */
export function silenceStepHint(): void {
  speechQueue.drop('hint');
  hintPlayer.stopTag('hint');
}

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
  // Ожидающая реплика тоже снимается: иначе она зазвучала бы поверх
  // того, что человек сейчас говорит.
  speechQueue.drop();
  hintPlayer.stop();
}

// ── «Без звука»: одно на страницу (K4) ─────────────────────────────

let mutedNow: boolean | null = null;
const mutedSubscribers = new Set<(muted: boolean) => void>();

/** Выключен ли звук — с устройства, прочитано один раз на страницу. */
export function isHintMuted(): boolean {
  if (mutedNow === null) mutedNow = readMuted(deviceStorage());
  return mutedNow;
}

/** Выключить/включить звук: запомнить на устройстве, сказать всем. */
export function setHintMuted(next: boolean): void {
  mutedNow = next;
  writeMuted(deviceStorage(), next);
  if (next) {
    speechQueue.drop();
    hintPlayer.stop();
  }
  for (const cb of mutedSubscribers) cb(next);
}

export function subscribeHintMuted(cb: (muted: boolean) => void): () => void {
  mutedSubscribers.add(cb);
  return () => {
    mutedSubscribers.delete(cb);
  };
}

// ── Активность человека: простой для повтора реплики (K4) ──────────

const activitySubscribers = new Set<() => void>();

/**
 * Человек что-то сделал — касание, клавиша, фраза в микрофон. Фразу
 * сообщает помощник (`VoiceAssistant`): для страницы она не событие, а
 * для «простоя без действия» (§4А.2 п.1) — самое что ни на есть действие.
 */
export function markVoiceActivity(): void {
  for (const cb of activitySubscribers) cb();
}

export function subscribeVoiceActivity(cb: () => void): () => void {
  activitySubscribers.add(cb);
  return () => {
    activitySubscribers.delete(cb);
  };
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
