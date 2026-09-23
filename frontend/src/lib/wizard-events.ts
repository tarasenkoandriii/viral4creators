/**
 * Очередь событий телеметрии шагов — «Тонкая красная линия» §8, этап 8.
 *
 * ## Почему очередь, а не запрос на событие
 *
 * Событий шесть видов, и самые частые (`enter`/`leave`) идут парами на
 * каждом переходе: запрос на каждое означал бы шесть-восемь обращений
 * за один проход мастера ради чисел, которые никто не читает в реальном
 * времени. Очередь копит их и отправляет пачкой.
 *
 * ## Что здесь чистое, а что нет
 *
 * Здесь — только правила накопления: что склеивается, когда пора
 * отправлять, что теряется при переполнении. Таймер и сам вызов живут в
 * хуке: их нечем проверить без React, а правила — можно и нужно.
 *
 * ## Чего в событии нет
 *
 * Сценария (его выводит сервер из проекта — иначе клиент мог бы
 * приписать событие чужому сценарию) и чего-либо про человека: таблица
 * на сервере без идентификаторов по построению (§8).
 */

export const WIZARD_EVENT_KINDS = [
  'enter',
  'leave',
  'hint_open',
  'hint_useless',
  'undo',
  'error',
] as const;

export type WizardEventKind = (typeof WIZARD_EVENT_KINDS)[number];

export interface WizardEvent {
  stepId: string;
  kind: WizardEventKind;
  /** Код, а не текст: пользовательский текст сюда не попадает никогда. */
  detail?: string;
}

/** Сколько событий влезает в одну отправку — столько же принимает сервер. */
export const WIZARD_EVENT_QUEUE_MAX = 20;

/** Через сколько тишины отправляем накопленное. */
export const WIZARD_EVENT_FLUSH_MS = 2000;

function same(a: WizardEvent, b: WizardEvent): boolean {
  return a.kind === b.kind && a.stepId === b.stepId && a.detail === b.detail;
}

export interface QueueResult {
  queue: WizardEvent[];
  /** Очередь заполнилась — отправлять, не дожидаясь тишины. */
  full: boolean;
}

/**
 * Добавить событие.
 *
 * Повтор подряд склеивается: перерисовка родителя не должна удваивать
 * «вошёл на шаг», иначе частоты, по которым потом заводят записи опыта,
 * врут ровно на число лишних рендеров.
 *
 * Переполнение отбрасывает НОВОЕ событие, а не самое старое: очередь
 * такой длины означает, что отправка не проходит, и в этом случае
 * ценнее начало прохода по мастеру, чем его хвост.
 */
export function queueEvent(
  queue: readonly WizardEvent[],
  event: WizardEvent
): QueueResult {
  const last = queue[queue.length - 1];
  if (last && same(last, event)) return { queue: [...queue], full: false };
  if (queue.length >= WIZARD_EVENT_QUEUE_MAX)
    return { queue: [...queue], full: true };
  const next = [...queue, event];
  return { queue: next, full: next.length >= WIZARD_EVENT_QUEUE_MAX };
}
