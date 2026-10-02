/**
 * Отправка событий §10 из браузера: очередь в памяти страницы → батч
 * `sendBeacon` при скрытии/уходе со страницы и при наборе 10 событий.
 *
 *  - Никакой записи на устройство (§10.1, ePrivacy): ни cookie, ни
 *    `localStorage` — очередь живёт, пока жива страница.
 *  - `sendBeacon` с телом `text/plain` (Blob без типа JSON): так запрос
 *    «простой», без preflight, а сервер дочитывает такое тело сам
 *    (`readSmallBody` в landing.controller). Наш API cookie не ставит;
 *    запасной путь — `fetch` с `credentials: 'omit'` и `keepalive`.
 *  - Без адреса (события выключены в сборке) — `track()` ничего не делает.
 */
import { makeEvent, packBatches, type LandingEvent } from './landing-events';

let endpoint: string | null = null;
/** Настроено ли (до настройки события копятся: эффекты детей идут раньше Telemetry). */
let configured = false;
const queue: LandingEvent[] = [];
let installed = false;

function send(body: string) {
  if (!endpoint) return;
  try {
    if (navigator.sendBeacon?.(endpoint, new Blob([body], { type: 'text/plain' }))) return;
  } catch {
    /* ниже — запасной путь */
  }
  fetch(endpoint, {
    method: 'POST',
    body,
    keepalive: true,
    credentials: 'omit',
    mode: 'no-cors',
    headers: { 'content-type': 'text/plain' },
  }).catch(() => {});
}

export function flush() {
  if (!endpoint || queue.length === 0) return;
  const batches = packBatches(queue.splice(0));
  for (const b of batches) send(b);
}

export function configureTracking(opts: { endpoint: string | null }) {
  endpoint = opts.endpoint;
  configured = true;
  if (!endpoint) {
    queue.length = 0;
    return;
  }
  if (!installed) {
    installed = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
    window.addEventListener('pagehide', flush);
  }
}

/** Событие в очередь; неизвестное имя/свойство молча отбрасывается (см. landing-events). */
export function track(name: string, props: Record<string, unknown> = {}) {
  if (typeof document === 'undefined' || (configured && !endpoint)) return;
  // Локаль — из <html lang> (её рисует сервер), путь — без query/якоря.
  const e = makeEvent(name, props, { locale: document.documentElement.lang, path: location.pathname });
  if (!e) return;
  queue.push(e);
  if (endpoint && queue.length >= 10) flush();
}

/** Для проверок: что лежит в очереди. */
export function pendingEvents(): readonly LandingEvent[] {
  return queue;
}
