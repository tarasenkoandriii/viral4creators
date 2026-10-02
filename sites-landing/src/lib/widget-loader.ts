/**
 * Наш виджет на нашем лендинге (Л2, ТЗ §4) — та же одна строка, что у
 * заказчиков (`<script async src=…загрузчик data-site=pk_…>`), но
 * вставляется ПОЗЖЕ: после `load` + `requestIdleCallback` или по первому
 * взаимодействию — что раньше (§4.5, §9: загрузчик «после load», чат —
 * только по клику: iframe чата загрузчик создаёт сам по клику).
 *
 * До загрузки вызовы `V4CAssist(…)` копятся в очереди `V4CAssist.q` — так
 * её читает загрузчик (`widget/src/loader/index.ts`, `boot()`).
 */
import { WIDGET_NAMES } from '../brand';

type Stub = ((...args: unknown[]) => void) & { q?: unknown[]; l?: 1 };
const LOAD_EVENT = 'assist-landing:load-widget';

function win(): Record<string, Stub | undefined> {
  return window as unknown as Record<string, Stub | undefined>;
}

/** Глобал-очередь до загрузки (если загрузчик уже стоит — его API). */
export function ensureStub(): Stub {
  const w = win();
  const existing = w[WIDGET_NAMES.global];
  if (existing) return existing;
  const stub: Stub = function (...args: unknown[]) {
    (stub.q = stub.q || []).push(args);
  };
  w[WIDGET_NAMES.global] = stub;
  return stub;
}

/** `V4CAssist(…)` — сейчас или в очередь до загрузки. */
export function assistCall(...args: unknown[]) {
  if (typeof window === 'undefined') return;
  ensureStub()(...args);
}

/** Попросить загрузить виджет сейчас (кнопка «Открыть помощника»). */
export function requestWidgetLoad() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(LOAD_EVENT));
}

export function isWidgetReady(): boolean {
  return typeof window !== 'undefined' && win()[WIDGET_NAMES.global]?.l === 1;
}

export interface LoaderTag {
  src: string;
  pk: string;
  lang: string;
}

/** Вставить тег загрузчика один раз. */
export function injectLoader(tag: LoaderTag): HTMLScriptElement | null {
  if (document.querySelector('script[data-assist-landing]')) return null;
  const s = document.createElement('script');
  s.async = true;
  s.src = tag.src;
  s.setAttribute('data-site', tag.pk);
  s.setAttribute('data-lang', tag.lang);
  s.setAttribute('data-assist-landing', '');
  document.body.appendChild(s);
  return s;
}

const INTERACTION = ['pointerdown', 'keydown', 'touchstart', 'wheel', 'scroll'] as const;

/**
 * Отложенный старт: первое из (а) взаимодействие, (б) idle после `load`,
 * (в) явная просьба `requestWidgetLoad()`. Возвращает отмену.
 */
export function scheduleWidget(start: () => void): () => void {
  let done = false;
  let idle: number | null = null;
  let timer: number | null = null;
  const fire = () => {
    if (done) return;
    done = true;
    cancel();
    start();
  };
  const onLoad = () => {
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (ric) idle = ric(fire, { timeout: 4000 });
    else timer = window.setTimeout(fire, 2000);
  };
  const cancel = () => {
    for (const e of INTERACTION) window.removeEventListener(e, fire, true);
    window.removeEventListener('load', onLoad);
    window.removeEventListener(LOAD_EVENT, fire);
    const cic = (window as unknown as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback;
    if (idle !== null && cic) cic(idle);
    if (timer !== null) window.clearTimeout(timer);
  };
  for (const e of INTERACTION) window.addEventListener(e, fire, { capture: true, passive: true });
  window.addEventListener(LOAD_EVENT, fire);
  if (document.readyState === 'complete') onLoad();
  else window.addEventListener('load', onLoad, { once: true });
  return () => {
    done = true;
    cancel();
  };
}
