/**
 * Загрузчик виджета (ТЗ §3-бис.2–3, §4.12, §4-бис.2) — W1. Ванильный TS,
 * ≤ 12 КБ gzip, исполняется в origin ЗАКАЗЧИКА:
 *  - только createElement/textContent/attachShadow; стили — CSS-переменные
 *    через adoptedStyleSheets; нативные методы запоминаются при старте;
 *  - очередь вызовов до загрузки: `window[WIDGET_GLOBAL].q`;
 *  - конфиг `GET /widget/v1/config?pk=` fetch'ем (CORS *, без cookie, кэш
 *    5 мин; нужен connect-src — без него вид по умолчанию), повторная
 *    проверка enum/HEX; кнопка в Shadow DOM, 4 угла, мобильные режимы, «не
 *    перекрывать чужое», своя кнопка/якорь, inline-контейнер, SPA-роутинг;
 *  - iframe `${origin}${WIDGET_FRAME_PATH}?pk=…` с referrerpolicy="origin" и
 *    allow="microphone" (Э5) — лениво по клику/восстановлению окна;
 *  - пинг установки — картинкой `/widget/v1/ping?pk=&v=&c=0|1`;
 *  - в sessionStorage страницы — ТОЛЬКО `<prefix>:<pk>:ui` = open|min|closed.
 */
import { natives as N } from './natives';
import {
  WIDGET_ANCHOR,
  WIDGET_FRAME_PATH,
  WIDGET_GLOBAL,
  WIDGET_LOADER_PATH,
  WIDGET_ORIGIN_DEFAULT,
  WIDGET_PREVIEW_PARAM,
  WIDGET_PROTOCOL_VERSION,
  WIDGET_STORAGE_PREFIX,
} from '../shared/brand';
import {
  POSITIONS,
  applyPreviewPatch,
  defaultPublicConfig,
  isObj,
  parsePublicConfig,
  shownOn,
  type Position,
  type PublicConfig,
  type UiLang,
  type ViewConfig,
} from '../shared/config';
import {
  cleanContext,
  cleanIdentify,
  cleanQuestion,
  envelope,
  parseFrameMessage,
  type ParentMessage,
} from '../shared/protocol';
import {
  isLocalHost,
  isTestKey,
  readAttrs,
  uiLang,
  type TagAttrs,
} from './attrs';
import { WidgetUi } from './ui';

type QueuedCall = IArguments | unknown[];
type GlobalApi = ((...args: unknown[]) => void) & { q?: QueuedCall[]; l?: 1 };
type EventName = 'open' | 'close' | 'lead' | 'handoff';
type UiState = 'open' | 'min' | 'closed';

const LABELS: Record<UiLang, { open: string; close: string; frame: string }> = {
  uk: {
    open: 'Відкрити чат з помічником',
    close: 'Закрити чат',
    frame: 'Чат з ІІ-помічником',
  },
  ru: {
    open: 'Открыть чат с помощником',
    close: 'Закрыть чат',
    frame: 'Чат с ИИ-помощником',
  },
  en: {
    open: 'Open assistant chat',
    close: 'Close chat',
    frame: 'AI assistant chat',
  },
};

const W = window as unknown as Record<string, GlobalApi | undefined>;

function findScript(): HTMLScriptElement | null {
  const cs = document.currentScript;
  if (cs instanceof HTMLScriptElement && cs.hasAttribute('data-site'))
    return cs;
  // async-скрипт без currentScript (модуль на дев-стенде) — ищем свой тег.
  const all = document.querySelectorAll('script[data-site]');
  for (let i = 0; i < all.length; i++) {
    const s = all[i] as HTMLScriptElement;
    if (s.src.indexOf(WIDGET_LOADER_PATH) > 0) return s;
  }
  return (all[0] as HTMLScriptElement) || null;
}

function widgetOrigin(script: HTMLScriptElement | null): string {
  try {
    if (script && script.src) {
      const u = new URL(script.src, location.href);
      if (u.protocol === 'https:' || u.protocol === 'http:') return u.origin;
    }
  } catch {
    /* умолчание ниже */
  }
  return WIDGET_ORIGIN_DEFAULT;
}

/**
 * Origin страницы. У макета конфигуратора TMA (пустой iframe about:blank,
 * §3-бис.4) `location.origin` — "null" (берётся из URL), а origin документа
 * унаследован от кабинета — его и подтверждают ancestorOrigins iframe чата
 * и сервер. `window.origin` — только для этого случая: на обычной странице
 * глобал `origin` может перекрыть скрипт заказчика.
 */
function pageOrigin(): string {
  const o = location.origin;
  return o === 'null' && typeof self.origin === 'string' ? self.origin : o;
}

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

class Loader {
  private readonly origin: string;
  private readonly pk: string;
  private readonly attrs: TagAttrs;
  private readonly lang: UiLang;
  private readonly uiKey: string;
  private readonly previewToken: string | null;
  private cfg: PublicConfig = defaultPublicConfig();
  private view: ViewConfig;
  private cfgLoaded = false;
  private ui: WidgetUi | null = null;
  private frameWin: Window | null = null;
  private ready = false;
  private outbox: ParentMessage[] = [];
  private listeners: Record<
    EventName,
    Array<(e: { type: EventName; at: number }) => void>
  > = {
    open: [],
    close: [],
    lead: [],
    handoff: [],
  };
  private pendingPreview: unknown[] = [];
  private unavailable = false;
  private hidden = false;
  private destroyed = false;
  private lastHref: string;
  private opener: Element | null = null;
  private scrollLock: [string, string] | null = null;
  private timers: number[] = [];
  private cleanups: Array<() => void> = [];

  constructor(script: HTMLScriptElement | null, attrs: TagAttrs) {
    this.origin = widgetOrigin(script);
    this.attrs = attrs;
    this.pk = attrs.pk as string;
    this.lang = uiLang(
      attrs.lang,
      document.documentElement.lang,
      navigator.language
    );
    this.uiKey = `${WIDGET_STORAGE_PREFIX}:${this.pk}:ui`;
    this.lastHref = location.href;
    this.view = this.withAttrs(this.cfg.config);
    this.previewToken = this.takePreviewToken() || attrs.previewToken;
  }

  /** `?v4c_preview=` — одноразовый токен: передать iframe и сразу убрать из адреса (§3-бис.4). */
  private takePreviewToken(): string | null {
    try {
      const u = new URL(location.href);
      const t = u.searchParams.get(WIDGET_PREVIEW_PARAM);
      if (t === null) return null;
      u.searchParams.delete(WIDGET_PREVIEW_PARAM);
      N.replaceUrl(u.href);
      this.lastHref = location.href;
      return /^[A-Za-z0-9_.~-]{8,256}$/.test(t) ? t : null;
    } catch {
      return null;
    }
  }

  private withAttrs(v: ViewConfig): ViewConfig {
    const a = this.attrs;
    const l = { ...v.layout, offset: { ...v.layout.offset } };
    if (a.position) l.position = a.position;
    if (a.offsetX !== null || a.offsetY !== null) {
      for (const k of ['desktop', 'mobile'] as const) {
        l.offset[k] = {
          x: a.offsetX ?? l.offset[k].x,
          y: a.offsetY ?? l.offset[k].y,
        };
      }
    }
    if (a.mobile) l.mobile = a.mobile;
    if (a.launcher) l.launcher = a.launcher;
    if (a.zIndex !== null) l.zIndex = a.zIndex;
    return { ...v, layout: l };
  }

  start(queue: QueuedCall[]) {
    const prev = this.readUi();
    this.mount(prev === 'open');
    this.listen();
    for (const call of queue) this.call(Array.prototype.slice.call(call));
    this.loadConfig();
    const afterLoad = () => {
      // Восстановление открытого окна — iframe сразу после load (§4-бис.1),
      // иначе лениво по первому клику (§4.12).
      if (prev === 'open' && !this.ui?.frame && this.allowed())
        this.openFrame();
      this.later(() => this.ping(), 0);
      if (location.hash === WIDGET_ANCHOR) this.open();
    };
    if (document.readyState === 'complete') this.later(afterLoad, 0);
    else N.on(window, 'load', afterLoad, { once: true });
  }

  private later(fn: () => void, ms: number) {
    this.timers.push(N.later(() => !this.destroyed && fn(), ms));
  }

  // ── хранилище страницы: ТОЛЬКО состояние окна (§4-бис.2) ────────────────

  private readUi(): UiState | null {
    const v = storage()?.getItem(this.uiKey) || '';
    const s = v.split(':')[0];
    return s === 'open' || s === 'min' || s === 'closed' ? s : null;
  }

  private writeUi(s: UiState) {
    try {
      storage()?.setItem(this.uiKey, `${s}:${Date.now()}`);
    } catch {
      /* хранилище недоступно — окно просто не восстановится */
    }
  }

  // ── DOM ─────────────────────────────────────────────────────────────────

  private mount(restoreOpen: boolean) {
    const inline = this.attrs.container ? N.query(this.attrs.container) : null;
    this.ui = new WidgetUi({
      view: this.view,
      inline,
      assetUrl: (id) =>
        `${this.origin}/widget/v1/asset/${encodeURIComponent(id)}`,
      labels: LABELS[this.lang],
      onToggle: () => this.toggle(),
      onEsc: () => this.close(),
    });
    if (inline) {
      // Inline: без кнопки и окна; iframe — когда контейнер виден (CWV до взаимодействия).
      const io =
        'IntersectionObserver' in window
          ? new IntersectionObserver((es) => {
              if (es.some((e) => e.isIntersecting)) {
                io && io.disconnect();
                if (this.allowed()) this.openFrame();
              }
            })
          : null;
      if (io) {
        io.observe(inline);
        this.cleanups.push(() => io.disconnect());
      } else this.openFrame();
    } else if (restoreOpen) {
      this.ui.show(true);
      this.lockScroll(true);
    }
    this.refreshVisibility();
    this.watchViewport();
  }

  private isInline(): boolean {
    return (
      !!this.ui && !!this.attrs.container && this.ui.panel.className === 'I'
    );
  }

  private allowed(): boolean {
    if (this.unavailable || this.destroyed || this.cfg.status === 'off')
      return false;
    const local = isTestKey(this.pk) && isLocalHost(location.hostname);
    // Предпросмотр (конфигуратор TMA — origin кабинета, не хост сайта;
    // «посмотреть на сайте») допускает сервер: обмен токена + frame-ancestors.
    // Список хостов опубликованного вида его бы спрятал.
    return shownOn(
      local || this.previewToken ? { hosts: [] } : this.cfg,
      pageOrigin(),
      location.pathname,
      this.attrs.hideOn
    );
  }

  private refreshVisibility() {
    const ok = this.allowed();
    this.ui?.visible(ok && !this.hidden);
    // hide() при открытом окне — закрыть: иначе невидимое окно держит
    // блокировку прокрутки страницы (мобильный fullscreen/sheet).
    if ((!ok || this.hidden) && this.ui?.isOpen()) this.close();
  }

  private watchViewport() {
    const vv = window.visualViewport;
    const upd = () => {
      if (vv) this.ui?.setVisualViewport(vv.height, vv.offsetTop);
    };
    upd();
    if (vv) {
      N.on(vv, 'resize', upd);
      N.on(vv, 'scroll', upd);
      this.cleanups.push(() => {
        N.off(vv, 'resize', upd);
        N.off(vv, 'scroll', upd);
      });
    }
    const mq = window.matchMedia('(max-width: 640px)');
    const re = () => this.ui?.apply(this.view);
    N.on(mq, 'change', re);
    this.cleanups.push(() => N.off(mq, 'change', re));
    let lastY = window.scrollY;
    const onScroll = () => {
      const y = window.scrollY;
      if (
        this.view.layout.hideOnScrollMobile &&
        this.ui?.isMobile() &&
        !this.ui.isOpen()
      )
        this.ui.setHideOnScroll(y > lastY + 4);
      lastY = y;
    };
    N.on(window, 'scroll', onScroll, { passive: true });
    this.cleanups.push(() => N.off(window, 'scroll', onScroll));
  }

  private lockScroll(on: boolean) {
    const de = document.documentElement;
    if (on) {
      if (
        this.scrollLock ||
        !this.ui?.isMobile() ||
        this.view.layout.mobile === 'bubble' ||
        this.isInline()
      )
        return;
      this.scrollLock = [
        de.style.getPropertyValue('overflow'),
        document.body?.style.getPropertyValue('overflow') || '',
      ];
      de.style.setProperty('overflow', 'hidden');
      document.body?.style.setProperty('overflow', 'hidden');
    } else if (this.scrollLock) {
      de.style.setProperty('overflow', this.scrollLock[0]);
      document.body?.style.setProperty('overflow', this.scrollLock[1]);
      this.scrollLock = null;
    }
  }

  private scheduleOverlap() {
    // «Не перекрывать чужое»: при старте и раз в 2 с до 10 с (§3-бис.3).
    for (let t = 0; t <= 10000; t += 2000)
      this.later(() => {
        const moved = this.ui?.avoidOverlap();
        if (moved) this.position(moved as Position, false);
      }, t);
  }

  // ── конфиг и пинг ───────────────────────────────────────────────────────

  private loadConfig() {
    const url = `${this.origin}/widget/v1/config?pk=${encodeURIComponent(this.pk)}`;
    N.fetch(url, { credentials: 'omit', mode: 'cors' })
      .then((r) => r.json())
      .then((body: unknown) => {
        if (isObj(body) && body.success === true) {
          this.cfg = parsePublicConfig(body.data);
          this.cfgLoaded = true;
          return;
        }
        // Сервер ответил (connect-src есть), но виджета нет: ключ неизвестен
        // или вид ни разу не опубликован — кнопку не рисуем (иначе форма лида,
        // которую некуда отправить). Предпросмотр черновика решает сервер.
        const code = isObj(body) && isObj(body.error) ? body.error.code : 0;
        if (code !== 'WIDGET_UNKNOWN_KEY' && code !== 'WIDGET_DISABLED')
          throw new Error('config');
        this.cfgLoaded = true;
        if (!this.previewToken) this.cfg.status = 'off';
      })
      .catch(() => {
        // Нет connect-src в CSP заказчика / сеть: вид по умолчанию, допуск решит iframe.
        this.cfgLoaded = false;
      })
      .then(() => {
        if (this.destroyed) return;
        this.setView(this.cfg.config);
        this.refreshVisibility();
        this.scheduleOverlap();
        this.configSettled = true;
        const pv = this.pendingPreview;
        this.pendingPreview = [];
        for (const p of pv) this.preview(p);
        if (this.loaded) this.ping();
      });
  }

  private configSettled = false;
  private loaded = false;
  private pinged = false;

  private ping() {
    this.loaded = true;
    if (!this.configSettled || this.pinged || this.destroyed) return;
    this.pinged = true;
    // Картинкой: работает при любом connect-src; c — получен ли конфиг (§3-бис.2, контракт §1 п.6).
    const img = new Image(1, 1);
    img.referrerPolicy = 'origin';
    img.src = `${this.origin}/widget/v1/ping?pk=${encodeURIComponent(this.pk)}&v=${WIDGET_PROTOCOL_VERSION}&c=${this.cfgLoaded ? 1 : 0}`;
  }

  private setView(v: ViewConfig) {
    this.view = this.withAttrs(v);
    this.ui?.apply(this.view);
  }

  // ── iframe и протокол ──────────────────────────────────────────────────

  private openFrame() {
    if (!this.ui || this.ui.frame) return;
    const pv = this.previewToken ? '&pv=1' : '';
    const f = this.ui.ensureFrame(
      `${this.origin}${WIDGET_FRAME_PATH}?pk=${encodeURIComponent(this.pk)}${pv}`
    );
    this.frameWin = N.frameWindow(f);
    // Браузер не отрисовал чат (frame-ancestors: хост не подтверждён/отозван)
    // — «ready» не придёт никогда; не держим вечный каркас.
    N.on(
      f,
      'load',
      () =>
        this.later(() => {
          if (!this.ready) {
            this.unavailable = true;
            this.refreshVisibility();
          }
        }, 4000),
      { once: true }
    );
  }

  private listen() {
    const onMsg = (ev: Event) => {
      const e = ev as MessageEvent;
      // Граница доверия (§4.12): только наш iframe — origin И окно-источник.
      if (
        !this.frameWin ||
        e.origin !== this.origin ||
        e.source !== this.frameWin
      )
        return;
      const m = parseFrameMessage(e.data);
      if (!m) return;
      switch (m.type) {
        case 'ready':
          this.ready = true;
          this.ui?.ready();
          this.sendInit();
          for (const msg of this.outbox.splice(0)) this.post(msg);
          if (this.ui?.isOpen()) this.post({ type: 'open' });
          break;
        case 'ui-state':
          if (m.state !== 'open') this.close(m.state);
          break;
        case 'event':
          if (m.name === 'lead' || m.name === 'handoff') this.emit(m.name);
          break;
        case 'unavailable':
          this.unavailable = true;
          this.refreshVisibility();
          break;
        case 'resize':
          break;
      }
    };
    N.on(window, 'message', onMsg);
    this.cleanups.push(() => N.off(window, 'message', onMsg));

    const onClick = (ev: Event) => {
      const t = ev.target as Element | null;
      const a = t && t.closest ? t.closest('a[href]') : null;
      const href = a && a.getAttribute('href');
      if (href && href.slice(-WIDGET_ANCHOR.length) === WIDGET_ANCHOR) {
        ev.preventDefault();
        this.opener = a;
        this.open();
      }
    };
    N.on(document, 'click', onClick, true);
    this.cleanups.push(() => N.off(document, 'click', onClick, true));

    // SPA: pushState/replaceState/popstate/Navigation API (§3-бис.2).
    const H = history as History & Record<string, unknown>;
    const nav = () => this.later(() => this.route(), 0);
    const wrap = (
      name: 'pushState' | 'replaceState',
      native: History['pushState']
    ) => {
      const fn = function (this: History, ...args: unknown[]) {
        const r = N.apply(native, this, args);
        nav();
        return r;
      };
      H[name] = fn;
      this.cleanups.push(() => {
        if (H[name] === fn) H[name] = native;
      });
    };
    wrap('pushState', N.push);
    wrap('replaceState', N.replace);
    N.on(window, 'popstate', nav);
    N.on(window, 'hashchange', nav);
    const navApi = (window as unknown as { navigation?: EventTarget })
      .navigation;
    if (navApi) N.on(navApi, 'navigatesuccess', nav);
    this.cleanups.push(() => {
      N.off(window, 'popstate', nav);
      N.off(window, 'hashchange', nav);
      if (navApi) N.off(navApi, 'navigatesuccess', nav);
    });

    // Тема «как на сайте»: data-theme на <html> (§3-бис.1).
    const mo = new MutationObserver(() => this.ready && this.sendInit());
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    this.cleanups.push(() => mo.disconnect());
  }

  private siteTheme(): 'light' | 'dark' | null {
    const t = document.documentElement.getAttribute('data-theme');
    return t === 'dark' || t === 'light' ? t : null;
  }

  private siteFont(): string | null {
    try {
      const f = getComputedStyle(
        document.body || document.documentElement
      ).fontFamily;
      return f && /^[\w\s,"'.-]{1,200}$/.test(f) ? f : null;
    } catch {
      return null;
    }
  }

  private page() {
    let url = location.href;
    // Макет страницы в конфигураторе TMA — about:blank (§3-бис.4): iframe
    // принимает только http(s)-адрес и без него отбросил бы init — чат не
    // стартовал бы. Адрес кабинета целиком не отдаём — только origin.
    if (!/^https?:/.test(url)) url = pageOrigin() + '/';
    const i = url.indexOf('#');
    if (i >= 0) url = url.slice(0, i);
    return { url, title: (document.title || '').slice(0, 200) };
  }

  private sendInit() {
    this.post({
      type: 'init',
      pk: this.pk,
      parentOrigin: pageOrigin(),
      page: this.page(),
      uiLang: this.lang,
      mode: this.isInline() ? 'inline' : 'float',
      siteFont: this.siteFont(),
      siteTheme: this.siteTheme(),
      previewToken: this.previewToken,
      restoreOpen: !!this.ui?.isOpen(),
    });
  }

  private post(m: ParentMessage) {
    if (!this.frameWin || !this.ready) {
      if (m.type !== 'init') this.outbox.push(m);
      return;
    }
    // targetOrigin — только origin виджета, никогда '*' (§4.12).
    N.post(this.frameWin, envelope(m), this.origin);
  }

  private route() {
    const href = location.href;
    if (href === this.lastHref) return;
    const pathChanged = href.split('#')[0] !== this.lastHref.split('#')[0];
    this.lastHref = href;
    if (location.hash === WIDGET_ANCHOR) this.open();
    if (!pathChanged) return;
    this.refreshVisibility();
    this.post({ type: 'route', page: this.page() });
    this.scheduleOverlap();
  }

  private emit(name: EventName) {
    // Наружу — только тип и время: ни текста, ни полей лида (§3-бис.2).
    const at = Date.now();
    for (const cb of this.listeners[name].slice())
      N.later(() => {
        try {
          cb({ type: name, at });
        } catch {
          /* чужой колбэк не ломает виджет */
        }
      }, 0);
  }

  // ── JS API (§3-бис.2) ───────────────────────────────────────────────────

  open() {
    if (!this.allowed() || !this.ui) return;
    if (this.isInline()) {
      this.openFrame();
      this.ui.host.scrollIntoView({ block: 'nearest' });
      this.post({ type: 'open' });
      if (this.ui.frame) N.focus(this.ui.frame);
      return;
    }
    if (this.ui.isOpen()) return;
    if (!this.opener) this.opener = document.activeElement;
    this.ui.show(true);
    this.lockScroll(true);
    this.openFrame();
    this.writeUi('open');
    this.post({ type: 'open' });
    if (this.ui.frame) N.focus(this.ui.frame);
    this.emit('open');
  }

  close(state: UiState = 'closed') {
    if (!this.ui || this.isInline() || !this.ui.isOpen()) return;
    this.ui.show(false);
    this.lockScroll(false);
    this.writeUi(state === 'min' ? 'min' : 'closed');
    this.post({ type: 'close' });
    // Возврат фокуса (§3-бис.3 «доступность»): на кнопку или на то, что открыло окно.
    const back = this.opener;
    this.opener = null;
    if (
      back instanceof HTMLElement &&
      back !== document.body &&
      document.contains(back)
    )
      N.focus(back);
    else this.ui.focusButton();
    this.emit('close');
  }

  toggle() {
    if (this.ui?.isOpen()) this.close();
    else {
      this.opener = this.ui ? this.ui.button : null;
      this.open();
    }
  }

  position(p: Position, notify = true) {
    this.view = { ...this.view, layout: { ...this.view.layout, position: p } };
    this.ui?.apply(this.view);
    if (notify) this.post({ type: 'position', position: p });
  }

  /** «к Л2»: только при allowClientPreview из КОНФИГА сервера; partial — те же проверки enum/HEX. */
  preview(partial: unknown) {
    if (!this.configSettled) {
      this.pendingPreview.push(partial);
      return;
    }
    if (!this.cfg.allowClientPreview || !isObj(partial)) return;
    this.setView(applyPreviewPatch(this.cfg.config, partial));
    this.post({ type: 'preview', partialConfig: partial });
  }

  call(args: unknown[]) {
    if (this.destroyed) return;
    const [cmd, a, b] = args;
    switch (cmd) {
      case 'open':
        return this.open();
      case 'close':
        return this.close();
      case 'toggle':
        return this.toggle();
      case 'ask': {
        const q = cleanQuestion(a);
        if (!q) return;
        this.open();
        this.post({ type: 'ask', question: q });
        return;
      }
      case 'identify': {
        const m = cleanIdentify(a);
        if (m) this.post(m);
        return;
      }
      case 'context': {
        const data = cleanContext(a);
        if (data) this.post({ type: 'context', data });
        return;
      }
      case 'position':
        if ((POSITIONS as readonly unknown[]).includes(a))
          this.position(a as Position);
        return;
      case 'hide':
      case 'show':
        this.hidden = cmd === 'hide';
        this.refreshVisibility();
        return;
      case 'on':
        if (
          (a === 'open' || a === 'close' || a === 'lead' || a === 'handoff') &&
          typeof b === 'function'
        )
          this.listeners[a].push(
            b as (e: { type: EventName; at: number }) => void
          );
        return;
      case 'route':
        this.lastHref = '';
        return this.route();
      case 'destroy':
        return this.destroy();
      case 'preview':
        return this.preview(a);
    }
  }

  destroy() {
    this.close();
    this.destroyed = true;
    for (const t of this.timers) clearTimeout(t);
    for (const c of this.cleanups.splice(0)) c();
    this.ui?.destroy();
    this.ui = null;
    this.frameWin = null;
    delete W[WIDGET_GLOBAL];
  }
}

function boot() {
  const existing = W[WIDGET_GLOBAL];
  if (existing && existing.l) return; // второй тег загрузчика — игнор
  const script = findScript();
  const attrs = readAttrs((n) => (script ? script.getAttribute(n) : null));
  if (!attrs.pk) return;
  const queue = (existing && existing.q) || [];
  const loader = new Loader(script, attrs);
  const api: GlobalApi = (...args: unknown[]) => loader.call(args);
  api.l = 1;
  W[WIDGET_GLOBAL] = api;
  loader.start(queue);
}

boot();
