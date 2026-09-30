/**
 * Чтение DOM для «карточки в фокусе» (K6, §4А.7.3) — правило выбора в
 * `lib/voice-nav-focus.ts`, здесь только числа для него.
 *
 * Карточка мастера — элемент с хуком `greeting-…-card`: тот же хук, по
 * которому её находит обучалка и по которому (i) выбирает тему.
 */

import { useCallback, useEffect, useRef } from 'react';
import {
  greetingAnchorId,
  type GreetingStepId,
} from '../../lib/greeting-steps';
import {
  isMostlyVisible,
  pickFocusCard,
  type CardBox,
} from '../../lib/voice-nav-focus';

const CARD_SELECTOR = '[data-qa^="greeting-"][data-qa$="-card"]';

function cardOf(node: EventTarget | null): string | null {
  if (!(node instanceof Element)) return null;
  return node.closest(CARD_SELECTOR)?.getAttribute('data-qa') ?? null;
}

/**
 * Следит за последним касанием/фокусом внутри карточки и отдаёт функцию
 * «карточка в фокусе сейчас». Касание кнопки микрофона (она вне
 * карточек) последнюю карточку не сбрасывает — ради этого всё и затеяно.
 */
export function useFocusedCard(): (fallback: string) => string {
  const interacted = useRef<string | null>(null);

  useEffect(() => {
    const remember = (e: Event): void => {
      const card = cardOf(e.target);
      if (card) interacted.current = card;
    };
    // Захват: карточка узнаёт о касании раньше, чем поле внутри неё
    // успеет остановить всплытие.
    document.addEventListener('pointerdown', remember, true);
    document.addEventListener('focusin', remember, true);
    return () => {
      document.removeEventListener('pointerdown', remember, true);
      document.removeEventListener('focusin', remember, true);
    };
  }, []);

  return useCallback((fallback: string): string => {
    const cards: CardBox[] = [];
    document.querySelectorAll(CARD_SELECTOR).forEach((el) => {
      const hook = el.getAttribute('data-qa');
      if (!hook) return;
      const r = el.getBoundingClientRect();
      cards.push({ hook, top: r.top, bottom: r.bottom });
    });
    return pickFocusCard({
      interacted: interacted.current,
      cards,
      viewport: window.innerHeight,
      fallback,
    });
  }, []);
}

/**
 * Секция шага на экране — по тому же якорю, к которому прокручивает
 * степпер (`greetingAnchorId`). Нет секции — «не на экране».
 */
export function stepSectionInView(step: GreetingStepId): boolean {
  const el = document.getElementById(greetingAnchorId(step));
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return isMostlyVisible(
    { hook: step, top: r.top, bottom: r.bottom },
    window.innerHeight
  );
}
