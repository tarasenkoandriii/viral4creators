/**
 * «Карточка в фокусе» для голоса — этап K6 ТЗ
 * `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md` §4А.7.3.
 *
 * Волна 1 брала карточку из `document.activeElement`. На телефоне это
 * почти всегда промах: чтобы заговорить, человек касается кнопки
 * микрофона, и фокус оказывается на ней — вне любой карточки, — а
 * «что здесь?» отвечало про карточку ТЕКУЩЕГО шага, хотя человек мог
 * смотреть на музыку двумя экранами ниже.
 *
 * Правило теперь такое:
 *  1. карточка, с которой человек взаимодействовал последней (касание
 *     или фокус клавиатуры), — если она ещё заметно на экране: это самый
 *     прямой знак «я здесь»;
 *  2. иначе — карточка, которой на экране видно больше всего: человек
 *     прокрутил ленту и смотрит на неё;
 *  3. иначе — карточка текущего шага (прежнее поведение).
 *
 * Та же карточка уходит серверу как `screen.card` и та же открывает
 * справку — «карточка в фокусе» одна на разбор и на (i).
 *
 * Здесь только выбор по готовым числам; чтение DOM — в
 * `features/voice/voice-focus.ts`.
 */

export interface CardBox {
  /** `data-qa` карточки. */
  hook: string;
  /** Координаты относительно окна (`getBoundingClientRect`). */
  top: number;
  bottom: number;
}

/**
 * Доля, при которой карточка «ещё на экране»: четверть её самой (или
 * окна, если карточка выше окна). Уголок карточки у края экрана — уже не
 * то, на что человек смотрит.
 */
export const STILL_VISIBLE_SHARE = 0.25;

/** Сколько пикселей карточки видно в окне высотой `viewport`. */
export function visiblePx(box: CardBox, viewport: number): number {
  return Math.max(0, Math.min(box.bottom, viewport) - Math.max(box.top, 0));
}

/**
 * Карточка (или секция) «на экране»: видна хотя бы на долю
 * `STILL_VISIBLE_SHARE` от себя или от окна, если она выше окна. Тем же
 * правилом голос решает, прокручивать ли к шагу, на котором человек стоит.
 */
export function isMostlyVisible(box: CardBox, viewport: number): boolean {
  const size = Math.min(box.bottom - box.top, viewport);
  if (size <= 0) return false;
  return visiblePx(box, viewport) >= size * STILL_VISIBLE_SHARE;
}

export function pickFocusCard(input: {
  /** Последняя карточка, которой касались; `null` — ещё ни одной. */
  interacted: string | null;
  /** Карточки на странице в порядке ленты. */
  cards: readonly CardBox[];
  viewport: number;
  /** Карточка текущего шага. */
  fallback: string;
}): string {
  const { interacted, cards, viewport, fallback } = input;
  if (interacted) {
    const box = cards.find((c) => c.hook === interacted);
    if (box && isMostlyVisible(box, viewport)) return interacted;
  }
  let best: CardBox | null = null;
  let bestPx = 0;
  for (const c of cards) {
    const px = visiblePx(c, viewport);
    // Строго больше: при равенстве остаётся та, что выше в ленте.
    if (px > bestPx) {
      best = c;
      bestPx = px;
    }
  }
  return best ? best.hook : fallback;
}
