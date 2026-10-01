/**
 * iframe-чат (ТЗ §4.12, §4-бис, §6.2) — W1. Preact, ≤ 60 КБ gzip вместе с
 * CSS. Живёт на origin виджета: API `/widget/v1/*` — тот же origin.
 *
 * Граница доверия с родителем (§4.12): origin родителя — из
 * `location.ancestorOrigins[0]` (Chromium/WebKit) или `document.referrer`
 * (Firefox; загрузчик ставит iframe с referrerpolicy=origin); затем его
 * подтверждает сервер при `session`. Принимаем только `event.source ===
 * window.parent && event.origin === parentOrigin`; шлём только с
 * targetOrigin = parentOrigin (никогда '*'), и только размер/состояние/тип
 * события — ни текста, ни полей лида, ни токенов.
 */
import { render } from 'preact';
import './chat.css';
import { App } from './view';
import { ChatController } from './controller';
import {
  cleanOrigin,
  FONTS,
  onColor,
  type Font,
  type ViewConfig,
} from '../shared/config';
import {
  envelope,
  isPk,
  parseParentMessage,
  type FrameMessage,
} from '../shared/protocol';

function detectParentOrigin(): string | null {
  if (window.parent === window) return null;
  const ao = location.ancestorOrigins;
  if (ao && ao.length) return cleanOrigin(ao[0]);
  try {
    return document.referrer
      ? cleanOrigin(new URL(document.referrer).origin)
      : null;
  } catch {
    return null;
  }
}

const FONT_FAMILY: Record<Font, string> = {
  site: '',
  system: '',
  inter: 'Inter',
  roboto: 'Roboto',
  montserrat: 'Montserrat',
  manrope: 'Manrope',
  'open-sans': 'Open Sans',
  rubik: 'Rubik',
};
const SYSTEM_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const loadedFonts: string[] = [];

/** Шрифт: свой хостинг `/v1/fonts/<id>.woff2` (font-src 'self'), только iframe и только при открытии (§3-бис.1). */
function fontStack(font: Font, siteFont: string | null, load: boolean): string {
  if (font === 'site')
    return siteFont ? `${siteFont}, ${SYSTEM_STACK}` : SYSTEM_STACK;
  if (font === 'system' || !(FONTS as readonly string[]).includes(font))
    return SYSTEM_STACK;
  const family = `v4c-${font}`;
  if (load && loadedFonts.indexOf(font) < 0 && typeof FontFace === 'function') {
    loadedFonts.push(font);
    try {
      const ff = new FontFace(
        family,
        `url(/v1/fonts/${font}.woff2) format("woff2")`,
        { weight: '100 900', display: 'swap' }
      );
      document.fonts.add(ff);
      ff.load().catch(() => undefined);
    } catch {
      /* шрифт не загрузился — системный */
    }
  }
  return `"${family}", "${FONT_FAMILY[font]}", ${SYSTEM_STACK}`;
}

function applyVars(view: ViewConfig, siteFont: string | null, opened: boolean) {
  // Бренд — CSS-переменные через CSSOM (значения уже проверены HEX/enum).
  const st = document.documentElement.style;
  st.setProperty('--v4c-c', view.brand.primaryColor);
  st.setProperty(
    '--v4c-on',
    onColor(view.brand.primaryColor, view.brand.buttonTextColor)
  );
  st.setProperty('--v4c-font', fontStack(view.brand.font, siteFont, opened));
}

function start() {
  const root =
    document.getElementById('app') ||
    document.body.appendChild(document.createElement('div'));
  const pk = new URLSearchParams(location.search).get('pk');
  const parentOrigin = detectParentOrigin();
  if (!isPk(pk) || !parentOrigin) return;

  const toParent = (m: FrameMessage) =>
    window.parent.postMessage(envelope(m), parentOrigin);
  const c = new ChatController(pk, parentOrigin, toParent);
  const focusRef: { current: HTMLTextAreaElement | null } = { current: null };
  let opened = false;
  let wantFocus = false;
  const focusComposer = () => {
    const ta = focusRef.current;
    if (wantFocus && ta && !ta.disabled) {
      wantFocus = false;
      ta.focus();
    }
  };

  c.subscribe(() => {
    applyVars(c.state.view, c.state.siteFont, opened || c.state.inline);
    // Язык документа = язык интерфейса (WCAG 3.1.1): шаблон iframe — `uk`,
    // иначе экранный диктор читает русский/английский текст украинским голосом.
    const html = document.documentElement;
    if (html.lang !== c.state.lang) html.lang = c.state.lang;
    // Поле ввода доступно после сессии — фокус туда, как только можно.
    setTimeout(focusComposer, 0);
  });

  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || e.origin !== parentOrigin) return;
    const m = parseParentMessage(e.data);
    if (!m) return;
    if (m.type === 'open') {
      opened = true;
      applyVars(c.state.view, c.state.siteFont, true);
      wantFocus = true;
      setTimeout(focusComposer, 0);
    }
    c.onParent(m);
  });

  const close = () => toParent({ type: 'ui-state', state: 'closed' });

  // Клавиатура: Esc закрывает окно, Tab не выходит из чата (фокус-ловушка, §4.12).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !c.state.inline) {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    const box = root.querySelector('.v4c-chat');
    if (!box) return;
    const els = Array.prototype.filter.call(
      box.querySelectorAll(
        'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled])'
      ),
      (el: HTMLElement) => el.offsetParent !== null
    ) as HTMLElement[];
    if (!els.length) return;
    const first = els[0];
    const last = els[els.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });

  render(<App c={c} onClose={close} focusRef={focusRef} />, root);
  applyVars(c.state.view, null, false);
  toParent({ type: 'ready' });
}

start();
