/**
 * Хук телеметрии шагов — «Тонкая красная линия» §8, этап 8.
 *
 * Правила накопления живут в `wizard-events.ts` и проверяются без
 * React; здесь — только то, чего в чистой функции быть не может: таймер
 * тишины, отправка и последний сброс при уходе с экрана.
 *
 * `track` стабилен между рендерами намеренно: его передают в эффекты
 * («вошёл на шаг») и в дочерние компоненты, и нестабильная ссылка
 * превратила бы каждый рендер в новое событие.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  WIZARD_EVENT_FLUSH_MS,
  queueEvent,
  type WizardEvent,
  type WizardEventKind,
} from './wizard-events';
import { sendWizardEvents } from '../services/wizard-events-api';

export type TrackWizardEvent = ((
  kind: WizardEventKind,
  stepId: string,
  detail?: string
) => void) & {
  /**
   * Отправить накопленное немедленно.
   *
   * Нужен там, где ждать тишины нельзя: последнее событие ухода с шага
   * ставится в очередь ПОСЛЕ того, как хук уже сбросил её на размонтаже
   * (эффекты чистятся в порядке объявления), и без явного вызова
   * держалось бы на таймере, который переживает экран только по
   * случайности.
   */
  flush: () => void;
};

export function useWizardEvents(projectId: string): TrackWizardEvent {
  const queue = useRef<WizardEvent[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const pending = queue.current;
    if (!pending.length) return;
    queue.current = [];
    void sendWizardEvents(projectId, pending);
  }, [projectId]);

  const track = useCallback(
    (kind: WizardEventKind, stepId: string, detail?: string) => {
      const result = queueEvent(queue.current, { kind, stepId, detail });
      queue.current = result.queue;
      if (result.full) {
        flush();
        return;
      }
      if (!timer.current)
        timer.current = setTimeout(flush, WIZARD_EVENT_FLUSH_MS);
    },
    [flush]
  );

  // Уход с экрана — последняя отправка. Без неё терялся бы весь хвост
  // прохода: человек доходит до конца мастера и закрывает его раньше,
  // чем истечёт тишина.
  useEffect(() => () => flush(), [flush]);

  return useMemo(() => Object.assign(track, { flush }), [track, flush]);
}
