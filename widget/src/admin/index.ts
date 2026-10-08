/**
 * Чанк «Админки» на странице админки заказчика (Э7, ТЗ §5.1 7b, §4.12,
 * §4-бис.8) — ES-модуль `/v1/admin.js`. Загрузчик (`data-mode="admin"`)
 * только отдаёт ему управление: бюджет загрузчика 12 КБ не растёт.
 *
 * Тег: `<script async src="https://wa.<домен>/v1/loader.js"
 *   data-site="pk_live_…" data-mode="admin"
 *   data-identity="<JWT>" | data-identity-endpoint="/api/assist-jwt">`.
 *
 *  - Кнопка — Shadow DOM, только createElement/textContent (Trusted Types
 *    страницы не нужны); iframe — origin тега (`wa.`), путь `/wa/v1/frame`.
 *  - employee-JWT: атрибут `data-identity` (выдаётся на каждой загрузке
 *    страницы) или `data-identity-endpoint` — свежий JWT запросом с куками
 *    сотрудника (ТОЛЬКО тот же origin, что админка — первая сторона), или
 *    `V4CAssist('identify-admin', jwt)` из SPA. Нет JWT — помощник не
 *    показывается и iframe получает `logout` (§4-бис.8).
 *  - В хранилище страницы админки ничего не пишется: ни `sub`, ни сессия
 *    (их держит только iframe `wa.`). Э6-бис (б): единственное исключение —
 *    флаг «план голосового управления идёт» (`v4c-admin-act` = `1` в
 *    sessionStorage вкладки, без данных): после перехода окно помощника
 *    поднимается само и iframe продолжает план.
 *
 * Э6-бис (б) «голосовое управление „Админкой“» (ТЗ §5-бис.3): команды
 * плана своего iframe (`ui-*`, `vt-*`) уходят ленивому чанку
 * `/v1/admin-act.js` (снимок, исполнитель, регистратор мастера) — сырыми,
 * разбор строгий там; ответы — назад своему iframe. Нативные `click`,
 * `addEventListener`, `setTimeout`, `createElement` запоминаются ЗДЕСЬ, при
 * старте чанка (до того, как их подменит скрипт страницы). Ссылка мастера
 * `?v4c_voicetest=` снимается с адреса сразу и отдаётся только iframe.
 */
import { WIDGET_ADMIN_FRAME_PATH, WIDGET_GLOBAL } from '../shared/brand';
import {
  adminEnvelope,
  isAdminPk,
  isJwt,
  parseAdminFrameMessage,
} from '../shared/admin-protocol';
import { WIDGET_VOICE_TEST_PARAM } from '../shared/brand';

// Нативные методы — при старте чанка (§4.12: страница может их подменить).
const nClick = HTMLElement.prototype.click;
const nAdd = EventTarget.prototype.addEventListener;
const nRemove = EventTarget.prototype.removeEventListener;
const nTimeout = window.setTimeout;
const nCreate = document.createElement;
const N = {
  el: <K extends keyof HTMLElementTagNameMap>(t: K) =>
    nCreate.call(document, t) as HTMLElementTagNameMap[K],
  on: (
    t: EventTarget,
    type: string,
    fn: EventListener,
    o?: boolean | AddEventListenerOptions
  ) => nAdd.call(t, type, fn, o),
  off: (t: EventTarget, type: string, fn: EventListener, o?: boolean) =>
    nRemove.call(t, type, fn, o),
  later: (fn: () => void, ms: number) => nTimeout.call(window, fn, ms),
  click: nClick,
};
const ACT_KEY = 'v4c-admin-act';

/** Ссылка мастера: снять с адреса сразу (история без токена). */
function takeVoiceTest(): string | null {
  try {
    const u = new URL(location.href);
    const t = u.searchParams.get(WIDGET_VOICE_TEST_PARAM);
    if (!t) return null;
    u.searchParams.delete(WIDGET_VOICE_TEST_PARAM);
    history.replaceState(history.state, '', u.pathname + u.search + u.hash);
    return /^[A-Za-z0-9_-]{20,100}$/.test(t) ? t : null;
  } catch {
    return null;
  }
}

type Api = ((...args: unknown[]) => void) & { q?: unknown[][]; l?: number };

const CSS = `:host{all:initial}
.b{position:fixed;right:20px;bottom:20px;z-index:2147483000;border:0;border-radius:24px;padding:10px 16px;background:#1f2937;color:#fff;font:600 14px/1.2 system-ui,sans-serif;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.25)}
.b:focus-visible{outline:3px solid #60a5fa;outline-offset:2px}
.p{position:fixed;right:20px;bottom:72px;z-index:2147483000;width:min(400px,calc(100vw - 40px));height:min(620px,calc(100vh - 100px));border-radius:14px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,.3);background:#fff;display:none}
.p.o{display:block}
iframe{border:0;width:100%;height:100%}`;

const LABEL: Record<string, string> = {
  uk: 'Помічник співробітника',
  ru: 'Помощник сотрудника',
  en: 'Staff assistant',
};

export function start(script: HTMLScriptElement): void {
  const W = window as unknown as Record<string, unknown>;
  // Два тега «Админки» на странице: оба загрузчика успевают взять чанк до
  // того, как первый займёт глобал, — второй start() не рисует вторую кнопку.
  if ((W[WIDGET_GLOBAL] as Api | undefined)?.l) return;
  const pk = script.getAttribute('data-site');
  if (!isAdminPk(pk)) return;
  let origin: string;
  try {
    origin = new URL(script.src, location.href).origin;
  } catch {
    return;
  }
  const attrLang = (
    script.getAttribute('data-lang') ||
    document.documentElement.lang ||
    'uk'
  )
    .slice(0, 2)
    .toLowerCase();
  const lang = attrLang === 'ru' || attrLang === 'en' ? attrLang : 'uk';
  let jwt: string | null = isJwt(script.getAttribute('data-identity'))
    ? script.getAttribute('data-identity')
    : null;
  const endpointRaw = script.getAttribute('data-identity-endpoint');
  let endpoint: string | null = null;
  if (endpointRaw) {
    try {
      const u = new URL(endpointRaw, location.href);
      // Только первая сторона: JWT берётся с куками сотрудника админки.
      if (u.origin === location.origin) endpoint = u.href;
    } catch {
      endpoint = null;
    }
  }

  const vt = takeVoiceTest();
  const host = document.createElement('div');
  // Свой корень: в снимок голосового управления не попадает (§5-бис.3 п.2).
  host.setAttribute('data-v4c', '');
  const root = host.attachShadow({ mode: 'closed' });
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    root.adoptedStyleSheets = [sheet];
  } catch {
    const st = document.createElement('style');
    st.textContent = CSS;
    root.appendChild(st);
  }
  const btn = document.createElement('button');
  btn.className = 'b';
  btn.type = 'button';
  btn.textContent = LABEL[lang];
  btn.setAttribute('aria-expanded', 'false');
  const panel = document.createElement('div');
  panel.className = 'p';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', LABEL[lang]);
  root.appendChild(btn);
  root.appendChild(panel);
  let frame: HTMLIFrameElement | null = null;
  let ready = false;

  const send = (m: object) => {
    const win = frame && frame.contentWindow;
    if (win && ready) win.postMessage(adminEnvelope(m), origin);
  };

  async function freshJwt(): Promise<string | null> {
    if (!endpoint) return jwt;
    try {
      const r = await fetch(endpoint, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!r.ok) return null;
      const ct = r.headers.get('content-type') || '';
      const t =
        ct.indexOf('json') >= 0
          ? ((await r.json()) as { jwt?: unknown; token?: unknown })
          : { jwt: (await r.text()).trim() };
      const v = t.jwt ?? t.token;
      return isJwt(v) ? v : null;
    } catch {
      return null;
    }
  }

  async function giveIdentity() {
    const v = await freshJwt();
    if (v) {
      jwt = v;
      send({ type: 'identity', jwt: v });
    } else {
      // Сотрудник вышел из админки — виджет «Админки» прячется и чистит состояние.
      jwt = null;
      send({ type: 'logout' });
      host.style.display = 'none';
    }
  }

  function ensureFrame() {
    if (frame) return;
    frame = document.createElement('iframe');
    frame.title = LABEL[lang];
    frame.setAttribute('referrerpolicy', 'origin');
    // Э6-бис (б): микрофон голосовых команд сотрудника — только этому iframe.
    frame.setAttribute('allow', 'microphone');
    frame.src = `${origin}${WIDGET_ADMIN_FRAME_PATH}?pk=${encodeURIComponent(pk!)}`;
    panel.appendChild(frame);
  }

  function setOpen(open: boolean) {
    if (open) ensureFrame();
    panel.className = open ? 'p o' : 'p';
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  // Э6-бис (б): исполнитель плана — ленивый чанк своего origin.
  type ActApi = { on(raw: Record<string, unknown>): void };
  let actQ: Promise<ActApi | null> | null = null;
  const act = (raw: Record<string, unknown>) => {
    actQ ||= import(/* @vite-ignore */ `${origin}/v1/admin-act.js`)
      .then((x: { start: (h: unknown) => ActApi }) =>
        x.start({
          N,
          post: (m: object) => send(m),
          min: () => {
            if (innerWidth < 720) setOpen(false);
          },
          mark: (on: boolean) => {
            try {
              if (on) sessionStorage.setItem(ACT_KEY, '1');
              else sessionStorage.removeItem(ACT_KEY);
            } catch {
              /* хранилище недоступно — продолжение после перехода вручную */
            }
          },
        })
      )
      .catch(() => null);
    void actQ.then((a) => a && a.on(raw));
  };

  btn.addEventListener('click', () => setOpen(panel.className === 'p'));
  window.addEventListener('message', (e: MessageEvent) => {
    if (!frame || e.source !== frame.contentWindow || e.origin !== origin)
      return;
    const m = parseAdminFrameMessage(e.data);
    if (!m) return;
    if (m.type === 'ready') {
      ready = true;
      send({ type: 'init', pk, parentOrigin: location.origin, lang, vt });
      void giveIdentity();
    } else if (m.type === 'ui-raw') {
      act(m.raw);
    } else if (m.type === 'need-identity') {
      void giveIdentity();
    } else if (m.type === 'close') {
      setOpen(false);
    }
  });

  const api: Api = (...args: unknown[]) => {
    const [cmd, a] = args;
    if (cmd === 'identify-admin' && isJwt(a)) {
      jwt = a;
      endpoint = null;
      host.style.display = '';
      send({ type: 'identity', jwt: a });
    } else if (cmd === 'logout') {
      jwt = null;
      send({ type: 'logout' });
      host.style.display = 'none';
    } else if (cmd === 'open') setOpen(true);
    else if (cmd === 'close') setOpen(false);
  };
  const queued = (W[WIDGET_GLOBAL] as Api | undefined)?.q ?? [];
  api.l = 1;
  W[WIDGET_GLOBAL] = api;
  for (const args of queued) api(...args);
  if (!jwt && !endpoint) host.style.display = 'none';
  (document.body || document.documentElement).appendChild(host);
  // Turbo заменяет <body> целиком (`replaceWith`), htmx — его содержимое:
  // хост выпал — вставить заново (как `_reattach` загрузчика). iframe при
  // вставке перезагружается: ждём его `ready` заново (init, JWT). Наблюдение
  // переставляется на новый <body> после disconnect — старый не держится.
  const mo = new MutationObserver(() => {
    if (host.isConnected) return;
    ready = false;
    (document.body || document.documentElement).appendChild(host);
    watch();
  });
  const watch = () => {
    mo.disconnect();
    mo.observe(document.documentElement, { childList: true });
    if (document.body) mo.observe(document.body, { childList: true });
  };
  watch();
  // План шёл до перехода или открыта ссылка мастера — окно поднимается само.
  let acting = false;
  try {
    acting = sessionStorage.getItem(ACT_KEY) === '1';
  } catch {
    acting = false;
  }
  if ((acting || vt) && (jwt || endpoint)) setOpen(true);
}
