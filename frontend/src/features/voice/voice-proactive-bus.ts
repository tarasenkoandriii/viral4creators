/**
 * Поводы проактивной речи (K4, ТЗ Greeting 2.0 §4А.2 п.1) — от экранов к
 * помощнику.
 *
 * Экран знает, что случилось (рендер отказал, ролик готов, сценарий
 * помечен, показана сводка), а говорить умеет помощник
 * (`VoiceAssistant`): у него проект, «без звука», потолок голоса и
 * память о том, что уже звучало. Шина — чтобы экранам не тащить к себе
 * ни одно из этого: сообщили повод и забыли. Помощник не смонтирован
 * (голос выключен) — повод никто не слышит, и это правильно: у
 * работающего текстом экран уже всё показал сам.
 */

import { useEffect, useRef } from 'react';
import axios from 'axios';
import { isGenerationLocked } from '../../services/projects-api';
import {
  becameReady,
  refusalOfStartError,
  type ProactiveEvent,
} from '../../lib/voice-proactive';

const listeners = new Set<(event: ProactiveEvent) => void>();

/**
 * Поводы, сказанные, пока помощник ещё не слушал. Эффекты React идут по
 * дереву сверху вниз, и шаг «Видео» сообщает о помеченном сценарии
 * раньше, чем смонтированный ниже помощник успевает подписаться.
 * Недоставленное живёт `UNDELIVERED_TTL_MS` и не больше
 * `UNDELIVERED_MAX` штук: помощника нет вовсе (голос выключен) — очередь
 * просто вытесняется, а не растёт.
 */
const UNDELIVERED_TTL_MS = 5_000;
const UNDELIVERED_MAX = 4;
let undelivered: Array<{ event: ProactiveEvent; at: number }> = [];

export function announceProactive(event: ProactiveEvent): void {
  if (listeners.size === 0) {
    undelivered = [...undelivered, { event, at: Date.now() }].slice(
      -UNDELIVERED_MAX
    );
    return;
  }
  for (const cb of listeners) cb(event);
}

export function subscribeProactive(
  cb: (event: ProactiveEvent) => void
): () => void {
  listeners.add(cb);
  const now = Date.now();
  const late = undelivered.filter((u) => now - u.at <= UNDELIVERED_TTL_MS);
  undelivered = [];
  for (const u of late) cb(u.event);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * Отказ старта рендера — объяснить голосом (стена, лимит). Звать из
 * `catch` той же кнопки: ошибка показана экраном, голос — второй канал.
 */
export function announceStartRefusal(error: unknown): void {
  const status = axios.isAxiosError(error)
    ? (error.response?.status ?? null)
    : null;
  const refusal = refusalOfStartError(status, isGenerationLocked(error));
  if (refusal) announceProactive({ kind: 'refusal', refusal });
}

/**
 * Поводы, которые живут, пока верны (CONTRACT5): помеченный сценарий.
 *
 * Разовое событие здесь не годится: шаг «Видео» сообщает о пометке при
 * монтировании, а помощник в этот момент может говорить только строкой
 * (звук выключен, касания ещё не было) — и событие сгорело бы, так и не
 * прозвучав. Поэтому повод лежит здесь, пока сценарий помечен, а
 * помощник пробует его снова, когда голосовой канал открывается
 * (касание, включённый звук), и расходует — один раз на ключ — только
 * когда реплика и правда пошла голосом.
 */
const sticky = new Map<string, ProactiveEvent>();

export function stickyProactiveEvents(): ProactiveEvent[] {
  return [...sticky.values()];
}

export function useVoiceProactiveWatch(input: {
  sessionId: string;
  videoStatus: string | null | undefined;
  promptId: string | null | undefined;
  scriptFlagged: boolean;
}): void {
  const prev = useRef<{ sessionId: string; video: string | null } | null>(null);
  const { sessionId, videoStatus, promptId, scriptFlagged } = input;
  useEffect(() => {
    const was = prev.current?.sessionId === sessionId ? prev.current : null;
    const video = videoStatus ?? null;
    if (was && becameReady(was.video, video)) {
      announceProactive({ kind: 'video-ready', sessionId });
    }
    prev.current = { sessionId, video };
  }, [sessionId, videoStatus]);
  useEffect(() => {
    if (!scriptFlagged || !promptId) return;
    const key = `${sessionId}:${promptId}`;
    const event: ProactiveEvent = {
      kind: 'refusal',
      refusal: 'moderation',
      key,
    };
    sticky.set(`moderation:${key}`, event);
    announceProactive(event);
    return () => {
      sticky.delete(`moderation:${key}`);
    };
  }, [sessionId, promptId, scriptFlagged]);
}
