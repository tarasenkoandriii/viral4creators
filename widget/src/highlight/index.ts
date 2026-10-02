/**
 * «Показать на экране» (Э6, ТЗ §4.9 `highlight`, §4.12) — ленивый чанк
 * загрузчика `highlight.js`: грузится только по клику посетителя на кнопку
 * «Показать на странице» (бюджет загрузчика 12 КБ не поднимается).
 *
 * Исполняется в origin ЗАКАЗЧИКА, поэтому правила загрузчика:
 *  - никаких HTML-приёмников: только createElement/textContent/style через
 *    CSSOM (работает под CSP без `unsafe-inline` и под Trusted Types);
 *  - из ответа модели на страницу не попадает ничего: селектор и подпись —
 *    из карты интерфейса СЕРВЕРА, подпись — `textContent`;
 *  - слой подсветки не перехватывает клики (`pointer-events: none`) и не
 *    нажимает ничего сам: «показать», а не «сделать».
 *
 * Не нашёл (селектор не валиден, элементов 0 или больше одного, элемент
 * невидим) — ТИХО возвращает `false`: вёрстка сменилась, загрузчик
 * передаст это iframe, а тот — сигнал «карта устарела» на сервер.
 */

export interface HighlightNatives {
  el<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K];
  on(
    t: EventTarget,
    type: string,
    fn: EventListener,
    opt?: boolean | AddEventListenerOptions
  ): void;
  off(t: EventTarget, type: string, fn: EventListener, opt?: boolean): void;
  later(fn: () => void, ms: number): number;
}

/** Сколько держать подсветку (мс). */
export const HIGHLIGHT_MS = 6000;
const PAD = 6;
const COLOR = '#2563eb';

let clear: (() => void) | null = null;

function visible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0)) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none';
}

function css(e: HTMLElement, props: Record<string, string>) {
  for (const k in props) e.style.setProperty(k, props[k], 'important');
}

/** Найти ровно один видимый элемент и подсветить; `false` — тихо не нашёл. */
export function highlight(
  selector: string,
  caption: string,
  N: HighlightNatives
): boolean {
  let found: NodeListOf<Element>;
  try {
    found = document.querySelectorAll(selector);
  } catch {
    return false;
  }
  if (found.length !== 1 || !visible(found[0])) return false;
  const target = found[0];
  if (clear) clear();

  const reduce =
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches;
  try {
    target.scrollIntoView({
      block: 'center',
      inline: 'nearest',
      behavior: reduce ? 'auto' : 'smooth',
    });
  } catch {
    target.scrollIntoView();
  }

  const ring = N.el('div');
  ring.setAttribute('data-v4c-highlight', '');
  ring.setAttribute('aria-hidden', 'true');
  css(ring, {
    position: 'fixed',
    'z-index': '2147483646',
    'pointer-events': 'none',
    'box-sizing': 'border-box',
    border: `3px solid ${COLOR}`,
    'border-radius': '8px',
    'box-shadow': '0 0 0 4px rgba(37,99,235,.25)',
    margin: '0',
    padding: '0',
    transition: reduce ? 'none' : 'opacity .2s',
  });
  const tip = N.el('div');
  tip.setAttribute('role', 'status');
  tip.textContent = caption;
  css(tip, {
    position: 'fixed',
    'z-index': '2147483647',
    'pointer-events': 'none',
    background: COLOR,
    color: '#fff',
    font: '600 13px/1.3 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
    padding: '6px 10px',
    'border-radius': '6px',
    'max-width': '260px',
    'white-space': 'normal',
    'overflow-wrap': 'anywhere',
    margin: '0',
  });
  const root = document.body || document.documentElement;
  root.appendChild(ring);
  root.appendChild(tip);

  let raf = 0;
  const place = () => {
    const r = target.getBoundingClientRect();
    css(ring, {
      top: `${r.top - PAD}px`,
      left: `${r.left - PAD}px`,
      width: `${r.width + PAD * 2}px`,
      height: `${r.height + PAD * 2}px`,
    });
    const below = r.bottom + PAD + 8;
    const tipH = tip.offsetHeight || 30;
    const top =
      below + tipH < innerHeight ? below : Math.max(4, r.top - PAD - 8 - tipH);
    css(tip, {
      top: `${top}px`,
      left: `${Math.max(4, Math.min(r.left, innerWidth - 270))}px`,
    });
    raf = requestAnimationFrame(place);
  };
  place();

  const done = () => {
    cancelAnimationFrame(raf);
    ring.remove();
    tip.remove();
    N.off(document, 'keydown', onKey, true);
    N.off(document, 'pointerdown', done, true);
    if (clear === done) clear = null;
  };
  const onKey = (e: Event) => {
    if ((e as KeyboardEvent).key === 'Escape') done();
  };
  N.on(document, 'keydown', onKey, true);
  // Нажал куда угодно (в т.ч. на сам элемент) — подсветка своё сделала.
  N.on(document, 'pointerdown', done, true);
  N.later(done, HIGHLIGHT_MS);
  clear = done;
  return true;
}
