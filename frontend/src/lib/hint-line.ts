/**
 * Строка совета: машина состояний — «Тонкая красная линия» §5.11.
 *
 * ## Почему машина, а не набор флагов
 *
 * Совет живёт на пересечении четырёх независимых событий: человек
 * раскрыл строку, истёк таймер безделья, приехал ответ, сменился шаг.
 * Набором булевых флагов это выражается, но каждое новое сочетание
 * приходится проверять глазами — а дороже всего стоят именно сочетания:
 * два запроса на один шаг (платим дважды) и ответ, приехавший на шаг, с
 * которого уже ушли (совет не про то, что на экране).
 *
 * Поэтому переходы описаны явно и проверяются отдельно от React:
 *
 * ```
 * hidden   ──(чекбокс включён)──────► collapsed
 * collapsed ──(клик | простой 8с)───► loading
 * loading  ──(ответ с текстом)──────► shown
 * loading  ──(ответ без текста)─────► hidden     // сказать нечего
 * loading  ──(ошибка | таймаут)─────► collapsed  // можно попробовать снова
 * shown    ──(смена шага)───────────► collapsed
 * *        ──(чекбокс выключен)─────► frozen     // текст остаётся, запросов нет
 * frozen   ──(смена шага)───────────► hidden
 * ```
 *
 * ## Два места, где легко ошибиться
 *
 * 1. **`hidden` после пустого ответа — не то же самое, что «выключено».**
 *    Строки нет в обоих случаях, но в первом смена шага обязана дать
 *    новую попытку, а во втором — нет. Различает их не фаза, а флаг
 *    `enabled`: держать это различие в фазе значило бы завести две
 *    почти одинаковые фазы и путать их до конца жизни модуля.
 * 2. **Ошибка возвращает в `collapsed`, а пустой ответ — в `hidden`.**
 *    Разница смысловая: после ошибки повтор имеет смысл, после «нечего
 *    сказать» — нет, и повторять его значило бы платить за тот же
 *    пустой ответ на каждом простое.
 * 3. **Сам по себе запрос уходит один раз на шаг.** Таймер простоя
 *    срабатывает однократно (`autoTried`), дальше — только по клику.
 *    Без этого лежащий провайдер или 429 превращались в семь запросов в
 *    минуту с каждого открытого мастера: ошибка возвращает в
 *    `collapsed`, а `collapsed` снова заводит восьмисекундный таймер.
 */

import type { GuideAction } from '../types';

export type HintPhase =
  /** Строки нет вовсе. */
  | 'hidden'
  /** Строка «Совет ИИ» с шевроном; запроса ещё не было. */
  | 'collapsed'
  /** Та же строка со спиннером на месте шеврона. */
  | 'loading'
  /** Текст совета раскрыт. */
  | 'shown'
  /** Чекбокс сняли: текст остался, новых запросов не будет. */
  | 'frozen';

export interface HintState {
  phase: HintPhase;
  /** Галочка «использовать ИИ» стоит. */
  enabled: boolean;
  /** Шаг, к которому относится текущее содержимое. */
  stepId: string | null;
  hint: string | null;
  actions: GuideAction[];
  /**
   * Код уведомления от сервера — сейчас только `'personal-limit'`.
   * Именно код, а не фраза: подпись даёт словарь, у которого есть языки.
   */
  notice?: string;
  /** Таймер простоя на этом шаге уже срабатывал. */
  autoTried: boolean;
}

export type HintEvent =
  | { type: 'enabled' }
  | { type: 'disabled' }
  /** Человек раскрыл строку сам. */
  | { type: 'open' }
  /** Истёк `HINT_IDLE_MS` на этом шаге. */
  | { type: 'idle' }
  | {
      type: 'result';
      hint: string | null;
      actions: GuideAction[];
      notice?: string;
    }
  /** Таймаут, отказ провайдера, частотный лимит. */
  | { type: 'failed' }
  | { type: 'step'; stepId: string };

/**
 * Сколько человек должен пробыть на шаге, прежде чем совет спросят сам.
 *
 * 8 секунд — по образцу триггера `step-pause` лендингового виджета
 * (§5.4). Меньше значило бы платить за каждый пролёт мимо шага;
 * больше — что совет приходит, когда человек уже справился сам.
 */
export const HINT_IDLE_MS = 8000;

export function initialHintState(
  enabled: boolean,
  stepId: string | null = null
): HintState {
  return {
    phase: enabled ? 'collapsed' : 'hidden',
    enabled,
    stepId,
    hint: null,
    actions: [],
    autoTried: false,
  };
}

/** Есть ли что показывать в свёрнутом/замороженном виде. */
function hasContent(state: HintState): boolean {
  return !!state.hint || !!state.notice;
}

export function hintReducer(state: HintState, event: HintEvent): HintState {
  switch (event.type) {
    case 'enabled':
      // Включить советы можно только в начале сценария, то есть это
      // событие приходит один раз и с пустым содержимым.
      if (state.enabled) return state;
      return { ...state, enabled: true, phase: 'collapsed' };

    case 'disabled':
      if (!state.enabled) return state;
      // Текст остаётся: человек читал его в тот момент, когда снимал
      // галочку, и выдёргивать прочитанное из-под глаз незачем.
      return {
        ...state,
        enabled: false,
        phase: hasContent(state) ? 'frozen' : 'hidden',
      };

    case 'open':
      // Только из `collapsed`. Отсюда же берётся «один вызов на шаг»:
      // из `loading` и `shown` это событие ничего не меняет, и второй
      // запрос не уходит ни по клику, ни по таймеру.
      if (!state.enabled || state.phase !== 'collapsed') return state;
      return { ...state, phase: 'loading' };

    case 'idle':
      // Таймер — ОДИН раз на шаг. Клик человека — сколько угодно: он
      // видел, что ответа нет, и просит ещё раз сам.
      if (!state.enabled || state.phase !== 'collapsed' || state.autoTried)
        return state;
      return { ...state, phase: 'loading', autoTried: true };

    case 'result': {
      // Ответ, приехавший не в `loading`, — это ответ на шаг, с
      // которого уже ушли. Его роняют здесь, а не только отменой
      // запроса: отмена не мгновенна.
      if (state.phase !== 'loading') return state;
      const text = event.hint?.trim() ? event.hint : null;
      if (!text && !event.notice) {
        return { ...state, phase: 'hidden', hint: null, actions: [] };
      }
      return {
        ...state,
        phase: 'shown',
        hint: text,
        actions: event.actions,
        notice: event.notice,
      };
    }

    case 'failed':
      if (state.phase !== 'loading') return state;
      // Назад в `collapsed`, а не в ошибку: совет — украшение пути, и
      // красная плашка поверх мастера из-за него несоразмерна.
      return { ...state, phase: 'collapsed' };

    case 'step': {
      if (event.stepId === state.stepId) return state;
      return {
        phase: state.enabled ? 'collapsed' : 'hidden',
        enabled: state.enabled,
        stepId: event.stepId,
        hint: null,
        actions: [],
        autoTried: false,
      };
    }
  }
}

/** Ждать ли срабатывания таймера простоя на этом шаге. */
export function waitsForIdle(state: HintState): boolean {
  return state.enabled && state.phase === 'collapsed' && !state.autoTried;
}

/** Нужно ли прямо сейчас идти на сервер. */
export function shouldRequest(state: HintState): boolean {
  return state.phase === 'loading';
}

/** Видна ли строка человеку (в любом из своих видов). */
export function isVisible(state: HintState): boolean {
  if (state.phase === 'hidden') return false;
  if (state.phase === 'frozen') return hasContent(state);
  return true;
}
