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
 *  - в sessionStorage страницы — ТОЛЬКО `<prefix>:<pk>:ui` = open|min|closed
 *    (Э3 — плюс в том же значении счётчик проактивных сигналов визита и
 *    «посетитель закрыл»: лимиты навязчивости переживают MPA-переходы без
 *    нового ключа, §5-тер.16 п.2).
 *
 * Э3 (W): проактивные триггеры MVP с лимитами навязчивости §5-тер.12 п.1–5,
 * 8–10 (пузырь `role="status"`, ничего не открывается само, ≤ 1–2 за визит,
 * не раньше 10 с, не на первом экране телефона, не после закрытия, не на
 * исключённых путях, только при status `active`); детекторы целей (url —
 * раз на документ, click — раз на цель за документ, form_submit — только
 * не отменённый сайтом, авто tel:/мессенджеры, `V4CAssist('goal')`);
 * цель уходит в живой iframe (атрибуция direct/assisted), иначе — сама
 * (`unassisted`); счётчики событий — пакетом через sendBeacon при скрытии;
 * `navigator.webdriver` — без аналитики; `?v4c_goal=` → чанк picker.js.
 *
 * Интеграция Э3: триггеры, пузырь и детекторы целей — в ленивом чанке
 * `engage.js` (src/engage/, бюджет загрузчика 12 КБ не поднимается). Здесь
 * остались лёгкие слушатели: клик, отправка формы (решение «отменена ли
 * сайтом» — в момент события), путь документа и `V4CAssist('goal')` копятся
 * в очереди `EngEvent` до загрузки чанка и отдаются ему — цели, случившиеся
 * раньше (url «спасибо», клик по tel:), не теряются. Чанк грузится только
 * если в конфиге есть цели/триггеры: после `load` + простоя или сразу при
 * первом взаимодействии.
 */
import { natives as N } from './natives';
import {
  WIDGET_ACT_PATH,
  WIDGET_ANCHOR,
  WIDGET_ENGAGE_PATH,
  WIDGET_FRAME_PATH,
  WIDGET_GLOBAL,
  WIDGET_GOAL_ATTR,
  WIDGET_GOAL_PICKER_PARAM,
  WIDGET_HIGHLIGHT_PATH,
  WIDGET_LOADER_PATH,
  WIDGET_ORIGIN_DEFAULT,
  WIDGET_PICKER_PATH,
  WIDGET_PREVIEW_PARAM,
  WIDGET_VOICE_TEST_PARAM,
  WIDGET_CHECK_PATH,
  WIDGET_PROTOCOL_VERSION,
  WIDGET_STORAGE_PREFIX,
} from '../shared/brand';
import {
  POSITIONS,
  applyLookPatch,
  defaultPublicConfig,
  isObj,
  parseLoaderConfig,
  shownOn,
  type Position,
  type PublicConfig,
  type UiLang,
  type ViewConfig,
} from '../shared/config';
import type { EngageApi, EngageStart, EngEvent, GoalMsg } from '../engage/host';
import type { ActApi, ActHost } from '../act/index';
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
type EventName = 'open' | 'close' | 'lead' | 'handoff' | 'goal';
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

/** Случайный id документа (дедуп целей «раз на документ», не идентификатор посетителя). */
function rid(): string {
  let s = '';
  for (const b of crypto.getRandomValues(new Uint8Array(12)))
    s += (b & 63).toString(36);
  return 'd' + s;
}

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

/**
 * Поля и методы без `private` — стык с чанком engage.js (`EngageHost`,
 * src/engage/host.ts): чанк получает сам объект загрузчика.
 */
class Loader {
  readonly N = N;
  private readonly origin: string;
  private readonly pk: string;
  private readonly attrs: TagAttrs;
  readonly lang: UiLang;
  private readonly uiKey: string;
  private readonly previewToken: string | null;
  cfg: PublicConfig = defaultPublicConfig();
  private view: ViewConfig;
  private cfgLoaded = false;
  ui: WidgetUi | null = null;
  private frameWin: Window | null = null;
  private ready = false;
  private outbox: ParentMessage[] = [];
  private listeners: Record<
    EventName,
    Array<(e: { type: EventName; at: number; key?: string }) => void>
  > = {
    open: [],
    close: [],
    lead: [],
    handoff: [],
    goal: [],
  };
  private readonly pickerToken: string | null;
  /** Э6-бис (г): одноразовая ссылка мастера проверки (`?v4c_voicetest=`). */
  private readonly vt: string | null;
  private chkQ: Promise<ActApi | null> | null = null;
  // ── Э3: вовлечение, счётчики, цели ──
  private readonly docId = rid();
  readonly t0 = Date.now();
  /** navigator.webdriver (наши воркеры, QA) — без аналитики (§5-тер.1). */
  readonly analytics = navigator.webdriver !== true;
  private uiState: UiState = 'closed';
  /** Визит (вкладка): показано сигналов, посетитель закрыл сигнал/окно. */
  shown = 0;
  stop = false;
  /** Э6-бис: идёт голосовой план — на следующей странице поднять iframe. */
  private acting = false;
  private actQ: Promise<ActApi | null> | null = null;
  private batch: Array<{ kind: string; key: string | null }> = [];
  private viewed = false;
  prevPath = '';
  routeAt = this.t0;
  /** Чанк engage.js; до загрузки — очередь событий (null — чанк не нужен). */
  private eng: EngageApi | null = null;
  private engQ: EngEvent[] | null = [['r', location.pathname]];
  private engLoad = false;
  private pendingPreview: unknown[] = [];
  private unavailable = false;
  hidden = false;
  destroyed = false;
  private lastHref: string;
  private opener: Element | null = null;
  private scrollLock: [string, string] | null = null;
  private timers: number[] = [];
  readonly cleanups: Array<() => void> = [];

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
    this.previewToken =
      this.takeParam(WIDGET_PREVIEW_PARAM) || attrs.previewToken;
    this.pickerToken = this.takeParam(WIDGET_GOAL_PICKER_PARAM);
    this.vt = this.takeParam(WIDGET_VOICE_TEST_PARAM);
    try {
      const r = document.referrer && new URL(document.referrer);
      if (r && r.origin === location.origin) this.prevPath = r.pathname;
    } catch {
      /* без «пришёл со страницы» */
    }
  }

  /**
   * `?v4c_preview=` / `?v4c_goal=` — одноразовый токен: передать дальше и
   * сразу убрать из адреса (`Referer` не унесёт его на чужой сайт, §3-бис.4).
   */
  private takeParam(name: string): string | null {
    try {
      const u = new URL(location.href);
      const t = u.searchParams.get(name);
      if (t === null) return null;
      u.searchParams.delete(name);
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
    this.listenGoals();
    if (this.pickerToken) this.loadPicker(this.pickerToken);
    for (const call of queue) this.call(Array.prototype.slice.call(call));
    this.loadConfig();
    const afterLoad = () => {
      // Восстановление открытого окна — iframe сразу после load (§4-бис.1),
      // иначе лениво по первому клику (§4.12).
      // Э6-бис: идёт голосовой план — iframe нужен и при свёрнутом окне.
      if ((prev === 'open' || this.acting) && !this.ui?.frame && this.allowed())
        this.openFrame();
      this.later(() => this.ping(), 0);
      // Э6-бис (г): ссылка мастера — окно сразу (мастер живёт в iframe).
      if (location.hash === WIDGET_ANCHOR || this.vt) this.open();
    };
    if (document.readyState === 'complete') this.later(afterLoad, 0);
    else N.on(window, 'load', afterLoad, { once: true });
  }

  later(fn: () => void, ms: number) {
    this.timers.push(N.later(() => !this.destroyed && fn(), ms));
  }

  // ── хранилище страницы: ТОЛЬКО состояние окна (§4-бис.2) ────────────────

  private readUi(): UiState | null {
    const p = (storage()?.getItem(this.uiKey) || '').split(':');
    const s = p[0];
    // Э3: счётчик сигналов визита и «закрыл» — в том же значении (без нового ключа).
    this.shown = Number(p[2]) || 0;
    this.stop = p[3] === '1';
    this.acting = p[4] === '1';
    return s === 'open' || s === 'min' || s === 'closed'
      ? (this.uiState = s)
      : null;
  }

  writeUi(s: UiState = this.uiState) {
    this.uiState = s;
    try {
      storage()?.setItem(
        this.uiKey,
        `${s}:${Date.now()}:${this.shown}:${this.stop ? 1 : 0}:${this.acting ? 1 : 0}`
      );
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

  isInline(): boolean {
    return (
      !!this.ui && !!this.attrs.container && this.ui.panel.className === 'I'
    );
  }

  allowed(): boolean {
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
    if (ok && this.configSettled && !this.viewed) {
      this.viewed = true;
      this.count('widget_view');
    }
    if (!ok || this.hidden) this.eng?.unbubble();
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
          this.cfg = parseLoaderConfig(body.data);
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
        this.configSettled = true;
        this.refreshVisibility();
        this.scheduleOverlap();
        this.engDecide();
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
        case 'count':
          this.count(m.kind, m.key);
          break;
        case 'unavailable':
          this.unavailable = true;
          this.refreshVisibility();
          break;
        case 'highlight':
          this.highlight(m);
          break;
        case 'ui-raw':
          this.act(m.raw);
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
      voiceTest: this.vt,
      restoreOpen: !!this.ui?.isOpen(),
    });
  }

  post(m: ParentMessage) {
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
    this.ev(['r', location.pathname]);
    this.routeAt = Date.now();
  }

  private emit(name: EventName, key?: string) {
    // Наружу — только тип и время (у цели — ещё ключ): ни текста, ни полей лида (§3-бис.2).
    const at = Date.now();
    for (const cb of this.listeners[name].slice())
      N.later(() => {
        try {
          cb(key ? { type: name, at, key } : { type: name, at });
        } catch {
          /* чужой колбэк не ломает виджет */
        }
      }, 0);
  }

  // ── Э3: счётчики событий (§4.16) ───────────────────────────────────────

  count(kind: string, key: string | null = null) {
    if (!this.analytics) return;
    this.batch.push({ kind, key });
    if (this.batch.length >= 20) this.flush();
  }

  /** Пакет счётчиков — sendBeacon text/plain (переживает уход со страницы). */
  private flush() {
    if (this.batch.length)
      N.beacon(
        `${this.origin}/widget/v1/event`,
        JSON.stringify({ pk: this.pk, events: this.batch.splice(0, 20) })
      );
  }

  // ── Э3: цели и вовлечение — ленивый чанк engage.js ─────────────────────

  /** Цель из чанка: живой iframe этого документа → direct/assisted (решение 12), иначе маяк (unassisted). */
  sendGoal(m: GoalMsg) {
    m = { ...m, docId: this.docId };
    this.emit('goal', m.goalKey);
    if (this.frameWin && this.ready) return this.post(m);
    const { type: _t, ...body } = m;
    N.beacon(
      `${this.origin}/widget/v1/goal`,
      JSON.stringify({ pk: this.pk, ...body })
    );
  }

  /** Событие для чанка: сразу ему или в очередь (взаимодействие — грузить чанк сейчас). */
  private ev(e: EngEvent) {
    if (this.eng) return this.eng.ev(e);
    const q = this.engQ;
    if (!q) return;
    if (q.length < 50) q.push(e);
    if (e[0] !== 'r' && this.configSettled) this.loadEngage();
  }

  /** После конфига: чанк нужен, только если есть цели (и аналитика) или триггеры. */
  private engDecide() {
    const e = this.cfg.rawEngagement;
    const g = this.cfg.rawGoals;
    if (!(
      (this.analytics && Array.isArray(g) && g.length) ||
      (isObj(e) && Array.isArray(e.triggers) && e.triggers.length)
    ))
      return void (this.engQ = null);
    if (this.engQ && this.engQ.some((x) => x[0] !== 'r'))
      return this.loadEngage();
    const idle = () => {
      const ric = (
        window as { requestIdleCallback?: typeof requestIdleCallback }
      ).requestIdleCallback;
      if (ric) ric(() => this.loadEngage(), { timeout: 3000 });
      else this.later(() => this.loadEngage(), 1500);
    };
    if (document.readyState === 'complete') idle();
    else N.on(window, 'load', idle, { once: true });
  }

  private loadEngage() {
    if (this.engLoad || !this.engQ || this.destroyed) return;
    this.engLoad = true;
    import(/* @vite-ignore */ this.chunk(WIDGET_ENGAGE_PATH))
      .then((m: { start: EngageStart }) => {
        const q = this.engQ || [];
        this.engQ = null;
        if (this.destroyed) return;
        const api = m.start(this);
        this.eng = api;
        for (const e of q) api.ev(e);
      })
      .catch(() => {
        // Чанк не загрузился (CSP без script-src виджета, сеть) — без целей и сигналов.
        this.engQ = null;
      });
  }

  private listenGoals() {
    const onClick = (ev: Event) => {
      const t = ev.target as Element | null;
      // Цель клика — только элемент (у текстового узла/документа нет closest).
      const a = t instanceof Element && t.closest('a[href]');
      if (t instanceof Element)
        this.ev([
          'c',
          t,
          (a && a.getAttribute('href')) || '',
          location.pathname,
        ]);
    };
    // Отправка формы — на window в фазе всплытия: обработчики сайта уже
    // отработали; отменённая сайтом (`preventDefault`) — не цель (§5-тер.1).
    const onSubmit = (ev: Event) => {
      const f = ev.target as Element;
      if (!ev.defaultPrevented && f && f.tagName === 'FORM')
        this.ev([
          's',
          f,
          (ev as SubmitEvent).submitter || null,
          location.pathname,
        ]);
    };
    const onHide = () => document.visibilityState === 'hidden' && this.flush();
    N.on(document, 'click', onClick, true);
    N.on(window, 'submit', onSubmit);
    N.on(document, 'visibilitychange', onHide);
    N.on(window, 'pagehide', () => this.flush());
    this.cleanups.push(() => {
      N.off(document, 'click', onClick, true);
      N.off(window, 'submit', onSubmit);
      N.off(document, 'visibilitychange', onHide);
    });
  }

  // ── Э6: «показать на экране» — ленивый чанк highlight.js ─────────────

  /**
   * Селектор и подпись — из карты сервера (iframe лишь передал их); чанк
   * ищет ровно один видимый элемент и подсвечивает. Мобильное окно на весь
   * экран сначала сворачивается — иначе показывать некуда. Итог — в iframe:
   * не нашёл → сигнал «карта устарела».
   */
  private highlight(m: {
    elementId: string;
    selector: string;
    caption: string;
  }) {
    if (this.ui?.isOpen() && this.ui.isMobile() && !this.isInline())
      this.close('min');
    import(/* @vite-ignore */ this.chunk(WIDGET_HIGHLIGHT_PATH))
      .then(
        (x: { highlight: (s: string, c: string, n: typeof N) => boolean }) =>
          x.highlight(m.selector, m.caption, N)
      )
      // Чанк не загрузился (CSP без script-src виджета, сеть) — это не
      // «вёрстка сменилась»: сигнала нет.
      .catch(() => null)
      .then((found) => {
        if (found !== null)
          this.post({
            type: 'highlight-result',
            elementId: m.elementId,
            found: found === true,
          });
      });
  }

  // ── Э6-бис: голосовое управление — ленивый чанк act.js ───────────────

  /**
   * Команда своего iframe (снимок, шаги, стоп, пауза) — сырой отдаётся
   * чанку, он разбирает её строго. Чанк не загрузился (CSP без script-src
   * виджета) — iframe не получит ответа и скажет «нажмите сами».
   */
  private act(raw: Record<string, unknown>) {
    const host: ActHost = {
      N,
      post: (m) => this.post(m),
      min: () => {
        if (this.ui?.isOpen() && this.ui.isMobile() && !this.isInline())
          this.close('min');
      },
      mark: (on) => {
        this.acting = on;
        this.writeUi();
      },
    };
    // Э6-бис (г): `vt-*` — проверка страницы мастера (чанк check.js).
    const load = (p: string) =>
      import(/* @vite-ignore */ this.chunk(p))
        .then((x: { start: (h: ActHost) => ActApi }) => x.start(host))
        .catch(() => null);
    (String(raw.type).charAt(1) == 't'
      ? (this.chkQ ||= load(WIDGET_CHECK_PATH))
      : (this.actQ ||= load(WIDGET_ACT_PATH))
    ).then((a) => a && a.on(raw));
  }

  /** Путь ленивого чанка: выпуск сайта (канарейка, §5-бис.12) или `/v1/`. */
  chunk(p: string): string {
    const r = this.cfg.release;
    return this.origin + (r ? p.replace('/v1/', '/v1/r/' + r + '/') : p);
  }

  /** `?v4c_goal=` → чанк режима выбора цели. Trusted Types без политики — честный отказ (О-8). */
  private loadPicker(token: string) {
    try {
      const s = N.el('script');
      s.setAttribute('data-pk', this.pk);
      s.setAttribute('data-token', token);
      s.src = this.origin + WIDGET_PICKER_PATH;
      (document.head || document.documentElement).appendChild(s);
    } catch {
      console.warn(
        WIDGET_GLOBAL +
          ': goal picker blocked by Trusted Types — mark the element with ' +
          WIDGET_GOAL_ATTR
      );
    }
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
    this.eng?.unbubble();
    this.count('open');
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
    // Закрыл окно — сигналов до конца визита больше нет (§5-тер.12 п.4).
    this.stop = true;
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
    this.setView(applyLookPatch(this.cfg.config, partial));
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
          (a === 'open' ||
            a === 'close' ||
            a === 'lead' ||
            a === 'handoff' ||
            a === 'goal') &&
          typeof b === 'function'
        )
          this.listeners[a].push(
            b as (e: { type: EventName; at: number }) => void
          );
        return;
      case 'goal':
        // До чанка (и до конфига) — в очередь: вызов со страницы «спасибо»
        // (часто — из очереди до загрузки) не теряется; разбор — в чанке.
        return this.ev(['g', args]);
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
    this.flush();
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
