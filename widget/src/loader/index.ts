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
  WIDGET_ADMIN_MODE,
  WIDGET_ADMIN_PATH,
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
  WIDGET_EDITOR_PARAM,
  WIDGET_EDITOR_PATH,
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
  envelope,
  MAX_QUESTION,
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
 * src/engage/host.ts): чанк получает сам объект загрузчика. Закрытые — с
 * `_`: сборка сжимает такие имена (esbuild `mangleProps`, `vite.mangle.ts`),
 * наружу они не уходят (сверка — scripts/mangle.test.ts).
 */
class Loader {
  readonly N = N;
  /** Э3-бис: origin API и pk — чанку ana.js (стык EngageHost). */
  readonly origin: string;
  readonly pk: string;
  private readonly _attrs: TagAttrs;
  readonly lang: UiLang;
  private readonly _uiKey: string;
  private readonly _previewToken: string | null;
  cfg: PublicConfig = defaultPublicConfig();
  private _view: ViewConfig;
  private _cfgLoaded = false;
  ui: WidgetUi | null = null;
  private _frameWin: Window | null = null;
  private _ready = false;
  private _outbox: ParentMessage[] = [];
  private _listeners: Record<
    EventName,
    Array<(e: { type: EventName; at: number; key?: string }) => void>
  > = {
    open: [],
    close: [],
    lead: [],
    handoff: [],
    goal: [],
  };
  private readonly _pickerToken: string | null;
  /** Э6-бис (г): одноразовая ссылка мастера проверки (`?v4c_voicetest=`). */
  private readonly _vt: string | null;
  /** Без `_` (не сжимается сборкой): читается по имени-строке `this[k]`. */
  private chkQ: Promise<ActApi | null> | null = null;
  /** Э6-тер: одноразовая ссылка редактора голосовой карты (`?v4c_edit=`). */
  private readonly _ed: string | null;
  // ── Э3: вовлечение, счётчики, цели ──
  private readonly _docId = rid();
  readonly t0 = Date.now();
  /** navigator.webdriver (наши воркеры, QA) — без аналитики (§5-тер.1). */
  readonly analytics = navigator.webdriver !== true;
  private _uiState: UiState = 'closed';
  /** Визит (вкладка): показано сигналов, посетитель закрыл сигнал/окно. */
  shown = 0;
  stop = false;
  /** Э6-бис: идёт голосовой план — на следующей странице поднять iframe. */
  private _acting = false;
  /** Без `_`: как `chkQ` — `this[k]`. */
  private actQ: Promise<ActApi | null> | null = null;
  private _batch: Array<{ kind: string; key: string | null }> = [];
  private _viewed = false;
  prevPath = '';
  routeAt = this.t0;
  /** Чанк engage.js; до загрузки — очередь событий (null — чанк не нужен). */
  private _eng: EngageApi | null = null;
  private _engQ: EngEvent[] | null = [['r', location.pathname]];
  private _engLoad = false;
  private _pendingPreview: unknown[] = [];
  private _unavailable = false;
  hidden = false;
  destroyed = false;
  private _lastHref: string;
  private _opener: Element | null = null;
  private _scrollLock: [string, string] | null = null;
  private _timers: number[] = [];
  readonly cleanups: Array<() => void> = [];

  constructor(script: HTMLScriptElement | null, attrs: TagAttrs) {
    this.origin = widgetOrigin(script);
    this._attrs = attrs;
    this.pk = attrs.pk as string;
    this.lang = uiLang(
      attrs.lang,
      document.documentElement.lang,
      navigator.language
    );
    this._uiKey = `${WIDGET_STORAGE_PREFIX}:${this.pk}:ui`;
    this._lastHref = location.href;
    this._view = this._withAttrs(this.cfg.config);
    this._previewToken =
      this._takeParam(WIDGET_PREVIEW_PARAM) || attrs.previewToken;
    this._pickerToken = this._takeParam(WIDGET_GOAL_PICKER_PARAM);
    this._vt = this._takeParam(WIDGET_VOICE_TEST_PARAM);
    // Переход по сайту во вкладке редактора (MPA): флаг пикера в хранилище
    // вкладки — панель продолжит по своей сессии `we.` (токена тут нет).
    this._ed =
      this._takeParam(WIDGET_EDITOR_PARAM) ||
      (storage()?.getItem(WIDGET_EDITOR_PARAM) ? '-' : null);
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
  private _takeParam(name: string): string | null {
    try {
      const u = new URL(location.href);
      const t = u.searchParams.get(name);
      if (t === null) return null;
      u.searchParams.delete(name);
      N.replaceUrl(u.href);
      this._lastHref = location.href;
      return /^[A-Za-z0-9_.~-]{8,256}$/.test(t) ? t : null;
    } catch {
      return null;
    }
  }

  private _withAttrs(v: ViewConfig): ViewConfig {
    const a = this._attrs;
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
    // Э6-тер: вкладка редактора — только ленивый чанк пикера (панель — iframe
    // `we.`), публичный чат здесь не поднимается (§5-кватер.3 п.1).
    if (this._ed)
      return void import(/* @vite-ignore */ this.origin + WIDGET_EDITOR_PATH)
        .then((m: { start: (...a: string[]) => void }) =>
          m.start(this._ed as string, this.pk, this.origin, this.lang)
        )
        .catch(() => null);
    const prev = this._readUi();
    this._mount(prev === 'open');
    this._listen();
    this._listenGoals();
    if (this._pickerToken) this._loadPicker(this._pickerToken);
    for (const call of queue) this.call(Array.prototype.slice.call(call));
    this._loadConfig();
    const afterLoad = () => {
      // Восстановление открытого окна — iframe сразу после load (§4-бис.1),
      // иначе лениво по первому клику (§4.12).
      // Э6-бис: идёт голосовой план — iframe нужен и при свёрнутом окне.
      if (
        (prev === 'open' || this._acting) &&
        !this.ui?.frame &&
        this.allowed()
      )
        this._openFrame();
      this.later(() => this._ping(), 0);
      // Э6-бис (г): ссылка мастера — окно сразу (мастер живёт в iframe).
      if (location.hash === WIDGET_ANCHOR || this._vt) this.open();
    };
    if (document.readyState === 'complete') this.later(afterLoad, 0);
    else N.on(window, 'load', afterLoad, { once: true });
  }

  later(fn: () => void, ms: number) {
    // Тик чанка engage.js — раз в секунду весь визит: старые id не копим
    // (сработавший таймер destroy() снимать не нужно, колбэк и так под
    // проверкой `destroyed`).
    if (this._timers.push(N.later(() => !this.destroyed && fn(), ms)) > 40)
      this._timers.shift();
  }

  // ── хранилище страницы: ТОЛЬКО состояние окна (§4-бис.2) ────────────────

  private _readUi(): UiState | null {
    const p = (storage()?.getItem(this._uiKey) || '').split(':');
    const s = p[0];
    // Э3: счётчик сигналов визита и «закрыл» — в том же значении (без нового ключа).
    this.shown = Number(p[2]) || 0;
    this.stop = p[3] === '1';
    this._acting = p[4] === '1';
    return s === 'open' || s === 'min' || s === 'closed'
      ? (this._uiState = s)
      : null;
  }

  writeUi(s: UiState = this._uiState) {
    this._uiState = s;
    try {
      storage()?.setItem(
        this._uiKey,
        `${s}:${Date.now()}:${this.shown}:${this.stop ? 1 : 0}:${this._acting ? 1 : 0}`
      );
    } catch {
      /* хранилище недоступно — окно просто не восстановится */
    }
  }

  // ── DOM ─────────────────────────────────────────────────────────────────

  private _mount(restoreOpen: boolean) {
    const inline = this._attrs.container
      ? N.query(this._attrs.container)
      : null;
    this.ui = new WidgetUi({
      view: this._view,
      inline,
      assetUrl: (id) =>
        `${this.origin}/widget/v1/asset/${encodeURIComponent(id)}`,
      labels: LABELS[this.lang],
      onToggle: () => this.toggle(),
      onEsc: () => this.close(),
    });
    if (inline) {
      // Inline: без кнопки и окна; iframe — когда хост виден (CWV до взаимодействия).
      // Наблюдается ХОСТ, не контейнер: Turbo/htmx меняют <body> — `_reattach`
      // переносит тот же хост в новый контейнер, и наблюдение едет с ним
      // (на выпавшем контейнере оно молчало бы, держа старый <body>). Хост
      // на скрытом пути или после `V4CAssist('hide')` — display:none, не
      // пересекается: iframe грузится только после разрешённого пути или
      // `show()` (раньше при hide грузился сразу, в невидимый хост), а
      // наблюдатель не снимается впустую.
      const io =
        'IntersectionObserver' in window
          ? new IntersectionObserver((es) => {
              if (es.some((e) => e.isIntersecting) && this.allowed()) {
                io && io.disconnect();
                this._openFrame();
              }
            })
          : null;
      if (io) {
        io.observe(this.ui.host);
        this.cleanups.push(() => io.disconnect());
      } else this._openFrame();
    } else if (restoreOpen) {
      this.ui.show(true);
      this._lockScroll(true);
    }
    this._refreshVisibility();
    this._watchViewport();
  }

  isInline(): boolean {
    return (
      !!this.ui && !!this._attrs.container && this.ui.panel.className === 'I'
    );
  }

  allowed(): boolean {
    if (this._unavailable || this.destroyed || this.cfg.status === 'off')
      return false;
    const local = isTestKey(this.pk) && isLocalHost(location.hostname);
    // Предпросмотр (конфигуратор TMA — origin кабинета, не хост сайта;
    // «посмотреть на сайте») допускает сервер: обмен токена + frame-ancestors.
    // Список хостов опубликованного вида его бы спрятал.
    return shownOn(
      local || this._previewToken ? { hosts: [] } : this.cfg,
      pageOrigin(),
      location.pathname,
      this._attrs.hideOn
    );
  }

  private _refreshVisibility() {
    const ok = this.allowed();
    this.ui?.visible(ok && !this.hidden);
    if (ok && this._configSettled && !this._viewed) {
      this._viewed = true;
      this.count('widget_view');
    }
    if (!ok || this.hidden) this._eng?.unbubble();
    // hide() при открытом окне — закрыть: иначе невидимое окно держит
    // блокировку прокрутки страницы (мобильный fullscreen/sheet).
    if ((!ok || this.hidden) && this.ui?.isOpen()) this.close();
  }

  private _watchViewport() {
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
    const re = () => this.ui?.apply(this._view);
    N.on(mq, 'change', re);
    this.cleanups.push(() => N.off(mq, 'change', re));
    let lastY = window.scrollY;
    const onScroll = () => {
      const y = window.scrollY;
      if (
        this._view.layout.hideOnScrollMobile &&
        this.ui?.isMobile() &&
        !this.ui.isOpen()
      )
        this.ui.setHideOnScroll(y > lastY + 4);
      lastY = y;
    };
    N.on(window, 'scroll', onScroll, { passive: true });
    this.cleanups.push(() => N.off(window, 'scroll', onScroll));
  }

  private _lockScroll(on: boolean) {
    const de = document.documentElement;
    if (on) {
      if (
        this._scrollLock ||
        !this.ui?.isMobile() ||
        this._view.layout.mobile === 'bubble' ||
        this.isInline()
      )
        return;
      this._scrollLock = [
        de.style.getPropertyValue('overflow'),
        document.body?.style.getPropertyValue('overflow') || '',
      ];
      de.style.setProperty('overflow', 'hidden');
      document.body?.style.setProperty('overflow', 'hidden');
    } else if (this._scrollLock) {
      de.style.setProperty('overflow', this._scrollLock[0]);
      document.body?.style.setProperty('overflow', this._scrollLock[1]);
      this._scrollLock = null;
    }
  }

  private _scheduleOverlap() {
    // «Не перекрывать чужое»: при старте и раз в 2 с до 10 с (§3-бис.3).
    for (let t = 0; t <= 10000; t += 2000)
      this.later(() => {
        const moved = this.ui?.avoidOverlap();
        if (moved) this.position(moved as Position, false);
      }, t);
  }

  // ── конфиг и пинг ───────────────────────────────────────────────────────

  private _loadConfig() {
    const url = `${this.origin}/widget/v1/config?pk=${encodeURIComponent(this.pk)}`;
    N.fetch(url, { credentials: 'omit', mode: 'cors' })
      .then((r) => r.json())
      .then((body: unknown) => {
        if (isObj(body) && body.success === true) {
          this.cfg = parseLoaderConfig(body.data);
          this._cfgLoaded = true;
          return;
        }
        // Сервер ответил (connect-src есть), но виджета нет: ключ неизвестен
        // или вид ни разу не опубликован — кнопку не рисуем (иначе форма лида,
        // которую некуда отправить). Предпросмотр черновика решает сервер.
        const code = isObj(body) && isObj(body.error) ? body.error.code : 0;
        if (code !== 'WIDGET_UNKNOWN_KEY' && code !== 'WIDGET_DISABLED')
          throw new Error('config');
        this._cfgLoaded = true;
        if (!this._previewToken) this.cfg.status = 'off';
      })
      .catch(() => {
        // Нет connect-src в CSP заказчика / сеть: вид по умолчанию, допуск решит iframe.
        this._cfgLoaded = false;
      })
      .then(() => {
        if (this.destroyed) return;
        this._setView(this.cfg.config);
        this._configSettled = true;
        this._refreshVisibility();
        this._scheduleOverlap();
        this._engDecide();
        const pv = this._pendingPreview;
        this._pendingPreview = [];
        for (const p of pv) this.preview(p);
        if (this._loaded) this._ping();
      });
  }

  private _configSettled = false;
  private _loaded = false;
  private _pinged = false;

  private _ping() {
    this._loaded = true;
    if (!this._configSettled || this._pinged || this.destroyed) return;
    this._pinged = true;
    // Картинкой: работает при любом connect-src; c — получен ли конфиг (§3-бис.2, контракт §1 п.6).
    const img = new Image(1, 1);
    img.referrerPolicy = 'origin';
    img.src = `${this.origin}/widget/v1/ping?pk=${encodeURIComponent(this.pk)}&v=${WIDGET_PROTOCOL_VERSION}&c=${this._cfgLoaded ? 1 : 0}`;
  }

  private _setView(v: ViewConfig) {
    this._view = this._withAttrs(v);
    this.ui?.apply(this._view);
  }

  // ── iframe и протокол ──────────────────────────────────────────────────

  private _openFrame() {
    if (!this.ui || this.ui.frame) return;
    const pv = this._previewToken ? '&pv=1' : '';
    const f = this.ui.ensureFrame(
      `${this.origin}${WIDGET_FRAME_PATH}?pk=${encodeURIComponent(this.pk)}${pv}`
    );
    this._frameWin = N.frameWindow(f);
    // Браузер не отрисовал чат (frame-ancestors: хост не подтверждён/отозван)
    // — «ready» не придёт никогда; не держим вечный каркас.
    N.on(
      f,
      'load',
      () =>
        this.later(() => {
          if (!this._ready) {
            this._unavailable = true;
            this._refreshVisibility();
          }
        }, 4000),
      { once: true }
    );
  }

  private _listen() {
    const onMsg = (ev: Event) => {
      const e = ev as MessageEvent;
      // Граница доверия (§4.12): только наш iframe — origin И окно-источник.
      if (
        !this._frameWin ||
        e.origin !== this.origin ||
        e.source !== this._frameWin
      )
        return;
      const m = parseFrameMessage(e.data);
      if (!m) return;
      switch (m.type) {
        case 'ready':
          this._ready = true;
          this.ui?.ready();
          this._sendInit();
          for (const msg of this._outbox.splice(0)) this.post(msg);
          if (this.ui?.isOpen()) this.post({ type: 'open' });
          break;
        case 'ui-state':
          if (m.state !== 'open') this.close(m.state);
          break;
        case 'event':
          if (m.name === 'lead' || m.name === 'handoff') this._emit(m.name);
          break;
        case 'count':
          this.count(m.kind, m.key);
          break;
        case 'unavailable':
          this._unavailable = true;
          this._refreshVisibility();
          break;
        case 'highlight':
          this._highlight(m);
          break;
        case 'ui-raw':
          this._act(m.raw);
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
        this._opener = a;
        this.open();
      }
    };
    N.on(document, 'click', onClick, true);
    this.cleanups.push(() => N.off(document, 'click', onClick, true));

    // SPA: pushState/replaceState/popstate/Navigation API (§3-бис.2).
    const H = history as History & Record<string, unknown>;
    const nav = () => this.later(() => this._route(), 0);
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

    // Тема «как на сайте»: data-theme на <html> (§3-бис.1). childList —
    // замена <body> целиком (Turbo `body.replaceWith`) до/без pushState.
    const mo = new MutationObserver(() => {
      this._reattach();
      if (this._ready) this._sendInit();
    });
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
      childList: true,
    });
    this.cleanups.push(() => mo.disconnect());
  }

  private _siteTheme(): 'light' | 'dark' | null {
    const t = document.documentElement.getAttribute('data-theme');
    return t === 'dark' || t === 'light' ? t : null;
  }

  private _siteFont(): string | null {
    try {
      const f = getComputedStyle(
        document.body || document.documentElement
      ).fontFamily;
      return f && /^[\w\s,"'.-]{1,200}$/.test(f) ? f : null;
    } catch {
      return null;
    }
  }

  private _page() {
    // Только origin+путь: в query бывают ПД (e-mail, токены, utm с id);
    // сервер всё равно хранит без query (cleanPageUrl).
    // Макет страницы в конфигураторе TMA — about:blank (§3-бис.4): iframe
    // принимает только http(s)-адрес и без него отбросил бы init — чат не
    // стартовал бы. Адрес кабинета целиком не отдаём — только origin.
    return {
      url: /^https?:/.test(location.href)
        ? location.origin + location.pathname
        : pageOrigin() + '/',
      title: (document.title || '').slice(0, 200),
    };
  }

  private _sendInit() {
    this.post({
      type: 'init',
      pk: this.pk,
      parentOrigin: pageOrigin(),
      page: this._page(),
      uiLang: this.lang,
      mode: this.isInline() ? 'inline' : 'float',
      siteFont: this._siteFont(),
      siteTheme: this._siteTheme(),
      previewToken: this._previewToken,
      voiceTest: this._vt,
      restoreOpen: !!this.ui?.isOpen(),
    });
  }

  post(m: ParentMessage) {
    if (!this._frameWin || !this._ready) {
      if (m.type !== 'init') this._outbox.push(m);
      return;
    }
    // targetOrigin — только origin виджета, никогда '*' (§4.12).
    N.post(this._frameWin, envelope(m), this.origin);
  }

  /**
   * Turbo/htmx/Swup меняют <body> целиком — хост выпал из документа:
   * вставляем заново (inline — в контейнер по селектору заново). iframe
   * при вставке перезагружается: новое окно, ждём его `ready` заново.
   */
  private _reattach() {
    const u = this.ui;
    if (u && !u.host.isConnected) {
      (this.isInline()
        ? N.query(this._attrs.container as string)
        : document.body
      )?.appendChild(u.host);
      if (u.frame) {
        this._frameWin = N.frameWindow(u.frame);
        this._ready = false;
      }
    }
  }

  private _route() {
    this._reattach();
    const href = location.href;
    if (href === this._lastHref) return;
    const pathChanged = href.split('#')[0] !== this._lastHref.split('#')[0];
    this._lastHref = href;
    if (location.hash === WIDGET_ANCHOR) this.open();
    if (!pathChanged) return;
    this._refreshVisibility();
    this.post({ type: 'route', page: this._page() });
    this._scheduleOverlap();
    this._ev(['r', location.pathname]);
    this.routeAt = Date.now();
  }

  private _emit(name: EventName, key?: string) {
    // Наружу — только тип и время (у цели — ещё ключ): ни текста, ни полей лида (§3-бис.2).
    const at = Date.now();
    for (const cb of this._listeners[name].slice())
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
    this._batch.push({ kind, key });
    if (this._batch.length >= 20) this._flush();
  }

  /** Пакет счётчиков — sendBeacon text/plain (переживает уход со страницы). */
  private _flush() {
    if (this._batch.length)
      N.beacon(
        `${this.origin}/widget/v1/event`,
        JSON.stringify({ pk: this.pk, events: this._batch.splice(0, 20) })
      );
  }

  // ── Э3: цели и вовлечение — ленивый чанк engage.js ─────────────────────

  /** Цель из чанка: живой iframe этого документа → direct/assisted (решение 12), иначе маяк (unassisted). */
  sendGoal(m: GoalMsg) {
    m = { ...m, docId: this._docId };
    this._emit('goal', m.goalKey);
    if (this._frameWin && this._ready) return this.post(m);
    const { type: _t, ...body } = m;
    N.beacon(
      `${this.origin}/widget/v1/goal`,
      JSON.stringify({ pk: this.pk, ...body })
    );
  }

  /** Событие для чанка: сразу ему или в очередь (взаимодействие — грузить чанк сейчас). */
  private _ev(e: EngEvent) {
    if (this._eng) return this._eng.ev(e);
    const q = this._engQ;
    if (!q) return;
    if (q.length < 50) q.push(e);
    if (e[0] !== 'r' && this._configSettled) this._loadEngage();
  }

  /** После конфига: чанк нужен, только если есть цели (и аналитика) или триггеры. */
  private _engDecide() {
    const e = this.cfg.rawEngagement;
    const g = this.cfg.rawGoals;
    if (!(
      (this.analytics && Array.isArray(g) && g.length) ||
      (isObj(e) && Array.isArray(e.triggers) && e.triggers.length) ||
      isObj(this.cfg.rawAna)
    ))
      return void (this._engQ = null);
    if (this._engQ && this._engQ.some((x) => x[0] !== 'r'))
      return this._loadEngage();
    const idle = () => {
      const ric = (
        window as { requestIdleCallback?: typeof requestIdleCallback }
      ).requestIdleCallback;
      if (ric) ric(() => this._loadEngage(), { timeout: 3000 });
      else this.later(() => this._loadEngage(), 1500);
    };
    if (document.readyState === 'complete') idle();
    else N.on(window, 'load', idle, { once: true });
  }

  private _loadEngage() {
    if (this._engLoad || !this._engQ || this.destroyed) return;
    this._engLoad = true;
    import(/* @vite-ignore */ this.chunk(WIDGET_ENGAGE_PATH))
      .then((m: { start: EngageStart }) => {
        const q = this._engQ || [];
        this._engQ = null;
        if (this.destroyed) return;
        const api = m.start(this);
        this._eng = api;
        for (const e of q) api.ev(e);
      })
      .catch(() => {
        // Чанк не загрузился (CSP без script-src виджета, сеть) — без целей и сигналов.
        this._engQ = null;
      });
  }

  private _listenGoals() {
    const onClick = (ev: Event) => {
      const t = ev.target as Element | null;
      // Цель клика — только элемент (у текстового узла/документа нет closest).
      const a = t instanceof Element && t.closest('a[href]');
      if (t instanceof Element)
        this._ev([
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
        this._ev([
          's',
          f,
          (ev as SubmitEvent).submitter || null,
          location.pathname,
        ]);
    };
    const onHide = () => document.visibilityState === 'hidden' && this._flush();
    N.on(document, 'click', onClick, true);
    N.on(window, 'submit', onSubmit);
    N.on(document, 'visibilitychange', onHide);
    N.on(window, 'pagehide', () => this._flush());
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
  private _highlight(m: {
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
  private _act(raw: Record<string, unknown>) {
    const host: ActHost = {
      N,
      post: (m) => this.post(m),
      min: () => {
        if (this.ui?.isOpen() && this.ui.isMobile() && !this.isInline())
          this.close('min');
      },
      mark: (on) => {
        this._acting = on;
        this.writeUi();
      },
    };
    // Э6-бис (г): `vt-*` — проверка страницы мастера (чанк check.js).
    // Не загрузился (сеть) — не запоминаем отказ навсегда: следующая
    // команда попробует снова.
    const k = String(raw.type).charAt(1) == 't' ? 'chkQ' : 'actQ';
    (this[k] ||= import(
      /* @vite-ignore */ this.chunk(
        k == 'chkQ' ? WIDGET_CHECK_PATH : WIDGET_ACT_PATH
      )
    )
      .then((x: { start: (h: ActHost) => ActApi }) => x.start(host))
      .catch(() => (this[k] = null))).then((a) => a && a.on(raw));
  }

  /** Путь ленивого чанка: выпуск сайта (канарейка, §5-бис.12) или `/v1/`. */
  chunk(p: string): string {
    const r = this.cfg.release;
    return this.origin + (r ? p.replace('/v1/', '/v1/r/' + r + '/') : p);
  }

  /** `?v4c_goal=` → чанк режима выбора цели. Trusted Types без политики — честный отказ (О-8). */
  private _loadPicker(token: string) {
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
      this._openFrame();
      this.ui.host.scrollIntoView({ block: 'nearest' });
      this.post({ type: 'open' });
      if (this.ui.frame) N.focus(this.ui.frame);
      return;
    }
    if (this.ui.isOpen()) return;
    if (!this._opener) this._opener = document.activeElement;
    this._eng?.unbubble();
    this.count('open');
    this.ui.show(true);
    this._lockScroll(true);
    this._openFrame();
    this.writeUi('open');
    this.post({ type: 'open' });
    if (this.ui.frame) N.focus(this.ui.frame);
    this._emit('open');
  }

  close(state: UiState = 'closed') {
    if (!this.ui || this.isInline() || !this.ui.isOpen()) return;
    this.ui.show(false);
    this._lockScroll(false);
    // Закрыл окно — сигналов до конца визита больше нет (§5-тер.12 п.4).
    this.stop = true;
    this.writeUi(state === 'min' ? 'min' : 'closed');
    this.post({ type: 'close' });
    // Возврат фокуса (§3-бис.3 «доступность»): на кнопку или на то, что открыло окно.
    const back = this._opener;
    this._opener = null;
    if (
      back instanceof HTMLElement &&
      back !== document.body &&
      document.contains(back)
    )
      N.focus(back);
    else this.ui.focusButton();
    this._emit('close');
  }

  toggle() {
    if (this.ui?.isOpen()) this.close();
    else {
      this._opener = this.ui ? this.ui.button : null;
      this.open();
    }
  }

  position(p: Position, notify = true) {
    this._view = {
      ...this._view,
      layout: { ...this._view.layout, position: p },
    };
    this.ui?.apply(this._view);
    if (notify) this.post({ type: 'position', position: p });
  }

  /** «к Л2»: только при allowClientPreview из КОНФИГА сервера; partial — те же проверки enum/HEX. */
  preview(partial: unknown) {
    if (!this._configSettled) {
      this._pendingPreview.push(partial);
      return;
    }
    if (!this.cfg.allowClientPreview || !isObj(partial)) return;
    this._setView(applyLookPatch(this.cfg.config, partial));
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
      // ask/identify/context: строгий разбор — в iframe (parseParentMessage:
      // длины, ключи, типы); здесь только форма — бюджет загрузчика 12 КБ.
      // Неклонируемое (функция, DOM) — DataCloneError ловит N.post.
      case 'ask':
        if (typeof a != 'string' || !a.trim() || a.length > MAX_QUESTION)
          return;
        this.open();
        this.post({ type: 'ask', question: a });
        return;
      case 'identify':
        if (isObj(a)) this.post({ ...a, type: 'identify' });
        return;
      case 'context':
        if (isObj(a))
          this.post({
            type: 'context',
            data: a as Record<string, string | number>,
          });
        return;
      case 'position':
        if ((POSITIONS as readonly unknown[]).includes(a))
          this.position(a as Position);
        return;
      case 'hide':
      case 'show':
        this.hidden = cmd === 'hide';
        this._refreshVisibility();
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
          this._listeners[a].push(
            b as (e: { type: EventName; at: number }) => void
          );
        return;
      // Э3-бис: согласие CMP сайта, группа эксперимента, ref для вебхука —
      // тем же путём, что цель: чанк engage.js передаёт их чанку ana.js.
      case 'goal':
      case 'consent':
      case 'group':
      case 'ref':
        // До чанка (и до конфига) — в очередь: вызов со страницы «спасибо»
        // (часто — из очереди до загрузки) не теряется; разбор — в чанке.
        return this._ev(['g', args]);
      case 'route':
        this._lastHref = '';
        return this._route();
      case 'destroy':
        return this.destroy();
      case 'preview':
        return this.preview(a);
    }
  }

  destroy() {
    this.close();
    this._flush();
    this.destroyed = true;
    for (const t of this._timers) clearTimeout(t);
    for (const c of this.cleanups.splice(0)) c();
    this.ui?.destroy();
    this.ui = null;
    this._frameWin = null;
    delete W[WIDGET_GLOBAL];
  }
}

/**
 * Э7: «Админка» — отдельный ленивый чанк с origin тега (`wa.`, §4.12,
 * У-13); загрузчик здесь только развилка — его бюджет 12 КБ не растёт.
 */
function startAdmin(script: HTMLScriptElement) {
  import(/* @vite-ignore */ widgetOrigin(script) + WIDGET_ADMIN_PATH)
    .then((m: { start: (s: HTMLScriptElement) => void }) => m.start(script))
    .catch(() => null);
}

function boot() {
  const existing = W[WIDGET_GLOBAL];
  if (existing && existing.l) return; // второй тег загрузчика — игнор
  const script = findScript();
  if (script && script.getAttribute('data-mode') === WIDGET_ADMIN_MODE)
    return startAdmin(script);
  // `script` не попадает ни в одно замыкание boot(): их общий контекст
  // держит `window.V4CAssist`, а тег — в <body>, который Turbo/htmx
  // заменяют целиком (старый документ остался бы в памяти).
  const attrs = readAttrs(
    script ? script.getAttribute.bind(script) : () => null
  );
  if (!attrs.pk) return;
  const queue = (existing && existing.q) || [];
  const loader = new Loader(script, attrs);
  const api: GlobalApi = (...args: unknown[]) => loader.call(args);
  api.l = 1;
  W[WIDGET_GLOBAL] = api;
  loader.start(queue);
}

boot();
