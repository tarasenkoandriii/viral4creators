/**
 * Нативные методы, запомненные при СТАРТЕ загрузчика (ТЗ §4.12, аудит 1.2):
 * скрипт страницы заказчика может позже подменить `postMessage`,
 * `addEventListener`, `history.pushState`, `fetch` — загрузчик продолжит
 * работать через свои копии. Модуль импортируется первым (порядок
 * исполнения в IIFE = порядок импортов).
 */
const W = window;
const D = document;
const apply = Reflect.apply;
const desc = Object.getOwnPropertyDescriptor;

const ET = EventTarget.prototype;
const nAdd = ET.addEventListener;
const nRemove = ET.removeEventListener;
const contentWindowGet = desc(HTMLIFrameElement.prototype, 'contentWindow')!
  .get as (this: HTMLIFrameElement) => Window | null;
const nCreate = D.createElement;
const nAttachShadow = Element.prototype.attachShadow;
const nFocus = HTMLElement.prototype.focus;
const nFetch = W.fetch;
const nPush = history.pushState;
const nReplace = history.replaceState;
const nSetTimeout = W.setTimeout;
const nQuery = D.querySelector;
const nBeacon = navigator.sendBeacon;

export const natives = {
  on(
    t: EventTarget,
    type: string,
    fn: EventListener,
    opt?: AddEventListenerOptions | boolean
  ) {
    apply(nAdd, t, [type, fn, opt]);
  },
  off(t: EventTarget, type: string, fn: EventListener, opt?: boolean) {
    apply(nRemove, t, [type, fn, opt]);
  },
  frameWindow(f: HTMLIFrameElement): Window | null {
    return apply(contentWindowGet, f, []);
  },
  /** postMessage окна ДРУГОГО origin нельзя подменить скриптом страницы — берём со свежего WindowProxy. */
  post(win: Window, data: unknown, targetOrigin: string) {
    win.postMessage(data, targetOrigin);
  },
  el<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] {
    return apply(nCreate, D, [tag]) as HTMLElementTagNameMap[K];
  },
  shadow(host: Element): ShadowRoot {
    return apply(nAttachShadow, host, [{ mode: 'open' }]);
  },
  focus(e: HTMLElement) {
    apply(nFocus, e, [{ preventScroll: true }]);
  },
  fetch(url: string, init: RequestInit): Promise<Response> {
    return apply(nFetch, W, [url, init]);
  },
  push: nPush,
  replace: nReplace,
  replaceUrl(url: string) {
    apply(nReplace, history, [history.state, '', url]);
  },
  later(fn: () => void, ms: number): number {
    return apply(nSetTimeout, W, [fn, ms]) as unknown as number;
  },
  query(sel: string): Element | null {
    try {
      return apply(nQuery, D, [sel]);
    } catch {
      return null;
    }
  },
  /** sendBeacon text/plain (простой запрос, переживает уход со страницы). */
  beacon(url: string, body: string): boolean {
    try {
      return !!nBeacon && apply(nBeacon, navigator, [url, body]);
    } catch {
      return false;
    }
  },
  apply,
};
