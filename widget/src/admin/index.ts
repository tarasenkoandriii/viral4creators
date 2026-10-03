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
 *    (их держит только iframe `wa.`).
 */
import { WIDGET_ADMIN_FRAME_PATH, WIDGET_GLOBAL } from '../shared/brand';
import {
  adminEnvelope,
  isAdminPk,
  isJwt,
  parseAdminFrameMessage,
} from '../shared/admin-protocol';

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

  const host = document.createElement('div');
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
    frame.src = `${origin}${WIDGET_ADMIN_FRAME_PATH}?pk=${encodeURIComponent(pk!)}`;
    panel.appendChild(frame);
  }

  function setOpen(open: boolean) {
    if (open) ensureFrame();
    panel.className = open ? 'p o' : 'p';
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  btn.addEventListener('click', () => setOpen(panel.className === 'p'));
  window.addEventListener('message', (e: MessageEvent) => {
    if (!frame || e.source !== frame.contentWindow || e.origin !== origin)
      return;
    const m = parseAdminFrameMessage(e.data);
    if (!m) return;
    if (m.type === 'ready') {
      ready = true;
      send({ type: 'init', pk, parentOrigin: location.origin, lang });
      void giveIdentity();
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
}
