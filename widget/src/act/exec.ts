/**
 * Исполнитель шагов голосового плана (Э6-бис (а), ТЗ §5-бис.3 п.6–7,
 * §5-бис.5, §5-бис.6 п.5, §4-бис.5) — в origin заказчика, чанк `act.js`.
 *
 * Шаг за шагом, в браузере человека и у него на глазах:
 *  - поиск цели: элемент снимка этой страницы → `data-assist-id` →
 *    роль + видимый текст → видимый текст → селектор карты интерфейса;
 *    несколько — берётся видимый в области просмотра, иначе «не нашёл»;
 *  - запреты — по НАСТОЯЩЕЙ цели в DOM в момент исполнения: `never`-зона,
 *    denylist, поле пароля/карты/файла, стоп-лист по живому тексту и
 *    скрытой подписи, другая ссылка, жест — шаг не исполняется;
 *  - прокрутка и подсветка ДО действия (600 мс; после перехода — тоже);
 *  - действие синтетическими событиями: pointer/mouse + `focus()` вызовом
 *    + нативный `click()`; поля — нативный сеттер прототипа + `input` и
 *    `change` (иначе React откатит значение, а Vue `v-model` не увидит);
 *  - шаг с побочным эффектом (клик, поле, список, флажок; аудит Э6-бис —
 *    не только навигация): `dispatched` на сервер ДО действия, действие —
 *    только после подтверждения записи (`ui-ack`); после перезагрузки такой
 *    шаг не повторяется никогда — навигационный: сверка адреса; остальные:
 *    `skipped/interrupted` («мог уже выполниться — проверьте сами»);
 *  - ожидание оседания (MutationObserver: 300 мс тишины, не дольше 5 с) и
 *    проверка `expect`; не сошлось — «нажмите сами», план стоп;
 *  - стоп: кнопка «Стоп» на странице, `Esc`, любой СОБСТВЕННЫЙ клик или
 *    клавиша человека (`isTrusted`; наши события его не имеют); пауза —
 *    локальный детектор речи в iframe;
 *  - пауза между шагами ≥ 300 мс (антибот, §5-бис.8);
 *  - (д) перед `fill/select/check` — прежнее значение поля в ПАМЯТИ этой
 *    страницы (`mem`; не sessionStorage, не сервер, не журнал — §5-бис.15
 *    п.7): «Вернуть»/«отмени последнее» возвращает его ленивый чанк
 *    `undo.js`; переход/перезагрузка стирают память — честно «не могу».
 */
import {
  neverTarget,
  paymentPath,
  type UiStep,
  type UiStepResult,
  type UiTarget,
} from '../shared/ui-plan';
import {
  closestDeep,
  deepQuery,
  excluded,
  factsOf,
  INTERACTIVE,
  sensitiveField,
  visible,
  visibleText,
} from './snapshot';

export interface ActNatives {
  el<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K];
  on(
    t: EventTarget,
    type: string,
    fn: EventListener,
    opt?: boolean | AddEventListenerOptions
  ): void;
  off(t: EventTarget, type: string, fn: EventListener, opt?: boolean): void;
  later(fn: () => void, ms: number): number;
  /** Нативный `HTMLElement.prototype.click`, запомненный загрузчиком при старте. */
  click?: (this: HTMLElement) => void;
}

export type StopBy = 'esc' | 'click' | 'key' | 'button';

/**
 * (д) Прежнее значение поля: план, шаг, элемент, значение, флажок, ранее
 * отмеченная радиокнопка группы; после действия — значение и флажок,
 * которые поставил помощник (возврат — только если поле их ещё держит).
 */
export type Prior = [
  string,
  number,
  Element,
  string,
  boolean | null,
  Element | null,
  string?,
  (boolean | null)?,
];
/** (д) Память прежних значений — только последний план этой страницы. */
export const mem: Prior[] = [];

export interface RunHost {
  N: ActNatives;
  report(
    index: number,
    result: UiStepResult,
    reason: string | null,
    ms: number
  ): void;
  stopped(by: StopBy): void;
  /** Шаг «после перехода» (SPA): цель найдёт и проверит сервер по новому снимку. */
  need(index: number): void;
  /** Свернуть окно чата на телефоне (иначе показывать некуда). */
  min(): void;
  /** План идёт: загрузчик откроет iframe на следующей странице. */
  mark(on: boolean): void;
  refs: Map<string, Element>;
  deny: string[];
  allow: string[];
}

const SETTLE_QUIET_MS = 300;
const SETTLE_MAX_MS = 5000;
export const HIGHLIGHT_BEFORE_MS = 600;
const BETWEEN_MS = 300;
const ACK_TIMEOUT_MS = 8000;
const COLOR = '#2563eb';

const LABELS = {
  uk: {
    stop: 'Зупинити помічника',
    doing: 'Помічник виконує',
    self: 'Натисніть самі',
  },
  ru: {
    stop: 'Остановить помощника',
    doing: 'Помощник выполняет',
    self: 'Нажмите сами',
  },
  en: {
    stop: 'Stop the assistant',
    doing: 'Assistant is working',
    self: 'Please press it yourself',
  },
} as const;

const norm = (s: string) =>
  s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const sleep = (N: ActNatives, ms: number) =>
  new Promise<void>((r) => N.later(r, ms));

/** Опция списка по тексту или значению шага. */
const optionOf = (el: Element, v: string | null) => {
  const want = norm(v || '');
  for (const o of (el as HTMLSelectElement).options || [])
    if (norm(o.text) === want || norm(o.value) === want) return o;
  return null;
};

/** (д) Отмеченная сейчас радиокнопка той же группы (вернуть — её). */
const radioOn = (x: HTMLInputElement): Element | null => {
  if (x.type == 'radio' && x.name)
    for (const r of (x.form || (x.getRootNode() as Document)).querySelectorAll(
      'input[type=radio]'
    ))
      if (
        (r as HTMLInputElement).name == x.name &&
        (r as HTMLInputElement).checked
      )
        return r;
  return null;
};

/** Что сервер вычищает из подписей: управляющие, bidi/zero-width, `<>`. */
/* eslint-disable no-control-regex */
const SERVER_STRIPS =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069<>`]/g;
/* eslint-enable no-control-regex */
/** Подпись к сверке с целью сервера (он вычистил и обрезал до 80 с «…»). */
const key = (s: string) => norm(s.replace(SERVER_STRIPS, '').replace(/…$/, ''));

/**
 * Живой элемент по ref — ТОТ ЖЕ, что проверил сервер (§5-бис.6 п.5): роль,
 * разметка, адрес ссылки и видимый текст. Ref — номер в ПОСЛЕДНЕМ снимке
 * страницы: после перезагрузки или подмены DOM под тем же номером может
 * оказаться другая кнопка («Надіслати» вместо «Таблиця розмірів»).
 */
export function sameTarget(el: Element, t: UiTarget): boolean {
  const f = factsOf(el);
  if (!f) return false;
  if (t.role && f.role !== t.role) return false;
  if ((t.assistId || null) !== f.assistId) return false;
  if ((t.href || null) !== f.href) return false;
  // Ссылка на тот же проверенный адрес — та же цель (счётчик в подписи «Кошик (1)»).
  if (t.href) return true;
  const live = key(f.text);
  if (!live && t.assistId) return true; // подпись цели — сама разметка
  const want = key(t.text);
  return t.text.slice(-1) === '…' ? live.indexOf(want) === 0 : live === want;
}

/** Стили — `!important` (страница не перебьёт); `decl` — ПОСТОЯННЫЕ строки и наши числа. */
const put = (e: Element) =>
  (document.body || document.documentElement).appendChild(e);

function css(e: HTMLElement, decl: string) {
  for (const d of decl.split(';')) {
    const i = d.indexOf(':');
    e.style.setProperty(d.slice(0, i), d.slice(i + 1), 'important');
  }
}

/**
 * Нативный сеттер значения прототипа (React/Vue видят изменение): React
 * вешает свой `value` на сам узел — берём сеттер с прототипа узла
 * (HTMLInputElement/HTMLTextAreaElement/HTMLSelectElement.prototype).
 */
function setNativeValue(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string
) {
  const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
  if (d && d.set) d.set.call(el, value);
  else el.value = value;
}

/**
 * Синтетическое событие: pointer- и mouse-события — отменяемые, `input`/`change` —
 * нет (как у браузера). Лишние поля словаря конструктор просто игнорирует.
 */
function fire(el: Element, type: string, init: Record<string, unknown> = {}) {
  const p = type[0] == 'p';
  const E =
    p && typeof PointerEvent == 'function'
      ? PointerEvent
      : type[0] == 'm'
        ? MouseEvent
        : type == 'input' && typeof InputEvent == 'function'
          ? InputEvent
          : Event;
  el.dispatchEvent(
    new E(type, {
      bubbles: true,
      cancelable: p || type[0] == 'm',
      composed: true,
      view: window,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      inputType: 'insertText',
      ...init,
    })
  );
}

export class Runner {
  private stoppedFlag = false;
  private paused = false;
  private resumeWaiters: Array<() => void> = [];
  private ackWait: { index: number; resolve: (ok: boolean) => void } | null =
    null;
  private overlay: HTMLElement | null = null;
  private live: HTMLElement | null = null;
  private ring: HTMLElement | null = null;
  private cleanups: Array<() => void> = [];
  private readonly L: (typeof LABELS)[keyof typeof LABELS];

  constructor(
    private readonly host: RunHost,
    readonly planId: string,
    private readonly steps: UiStep[],
    private readonly from: number,
    lang: 'uk' | 'ru' | 'en'
  ) {
    this.L = LABELS[lang] || LABELS.uk;
  }

  get stopped(): boolean {
    return this.stoppedFlag;
  }

  // ── управление ──────────────────────────────────────────────────────────

  /** `keep` — флаг «план идёт» не снимать (уход страницы в bfcache). */
  stop(by: StopBy | null, keep?: 1) {
    if (this.stoppedFlag) return;
    this.stoppedFlag = true;
    if (this.ackWait) this.ackWait.resolve(false);
    this.wake();
    this.teardown(keep);
    if (by) this.host.stopped(by);
  }

  pause(on: boolean) {
    this.paused = on;
    if (!on) this.wake();
  }

  ack(index: number) {
    if (this.ackWait && this.ackWait.index === index) {
      this.ackWait.resolve(true);
      this.ackWait = null;
    }
  }

  private wake() {
    for (const w of this.resumeWaiters.splice(0)) w();
  }

  private async gate(): Promise<boolean> {
    while (this.paused && !this.stoppedFlag)
      await new Promise<void>((r) => this.resumeWaiters.push(r));
    return !this.stoppedFlag;
  }

  // ── панель «Стоп» и человек берёт управление ───────────────────────────

  private mount() {
    const N = this.host.N;
    const host = N.el('div');
    host.setAttribute('data-v4c-act', '');
    const root = host.attachShadow({ mode: 'closed' });
    const bar = N.el('div');
    css(
      bar,
      `position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483647;display:flex;align-items:center;gap:10px;background:#111827;color:#fff;border-radius:999px;padding:8px 10px 8px 16px;font:600 14px/1.3 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.25);max-width:calc(100vw - 24px)`
    );
    const live = N.el('span');
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    live.textContent = this.L.doing;
    css(live, `overflow:hidden;text-overflow:ellipsis;white-space:nowrap`);
    const btn = N.el('button');
    btn.type = 'button';
    btn.textContent = '■ ' + this.L.stop;
    btn.setAttribute('data-act-stop', '');
    css(
      btn,
      `background:#dc2626;color:#fff;border:0;border-radius:999px;padding:8px 14px;font:inherit;cursor:pointer;min-height:40px`
    );
    N.on(btn, 'click', () => this.stop('button'));
    bar.appendChild(live);
    bar.appendChild(btn);
    root.appendChild(bar);
    put(host);
    this.overlay = host;
    this.live = live;

    // Человек взял управление: собственный клик/клавиша (isTrusted).
    const onPointer = (e: Event) => {
      if (!e.isTrusted || this.stoppedFlag) return;
      const path =
        (
          e as Event & { composedPath?: () => EventTarget[] }
        ).composedPath?.() || [];
      if (path.indexOf(host) >= 0) return; // своя панель — у кнопки свой обработчик
      this.stop('click');
    };
    const onKey = (e: Event) => {
      if (!e.isTrusted || this.stoppedFlag) return;
      const k = (e as KeyboardEvent).key;
      if (k === 'Shift' || k === 'Control' || k === 'Alt' || k === 'Meta')
        return;
      this.stop(k === 'Escape' ? 'esc' : 'key');
    };
    N.on(window, 'pointerdown', onPointer, true);
    N.on(window, 'keydown', onKey, true);
    this.cleanups.push(() => {
      N.off(window, 'pointerdown', onPointer, true);
      N.off(window, 'keydown', onKey, true);
    });
  }

  private teardown(keep?: 1) {
    for (const c of this.cleanups.splice(0)) c();
    this.unring();
    if (this.overlay) this.overlay.remove();
    this.overlay = null;
    if (!keep) this.host.mark(false);
  }

  private say(text: string) {
    if (this.live) this.live.textContent = text;
  }

  private ringAround(el: Element, caption: string) {
    this.unring();
    const N = this.host.N;
    const ring = N.el('div');
    ring.setAttribute('data-v4c-highlight', '');
    ring.setAttribute('aria-hidden', 'true');
    const r = el.getBoundingClientRect();
    css(
      ring,
      `position:fixed;z-index:2147483646;pointer-events:none;box-sizing:border-box;border:3px solid ${COLOR};border-radius:8px;box-shadow:0 0 0 4px rgba(37,99,235,.25);margin:0;padding:0;top:${r.top - 6}px;left:${r.left - 6}px;width:${r.width + 12}px;height:${r.height + 12}px`
    );
    const tip = N.el('div');
    tip.textContent = caption;
    css(
      tip,
      `position:absolute;top:100%;left:0;margin-top:6px;background:${COLOR};color:#fff;font:600 13px/1.3 system-ui,sans-serif;padding:4px 8px;border-radius:6px;white-space:nowrap;max-width:260px;overflow:hidden;text-overflow:ellipsis`
    );
    if (caption) ring.appendChild(tip);
    put(ring);
    this.ring = ring;
  }

  private unring() {
    if (this.ring) this.ring.remove();
    this.ring = null;
  }

  // ── поиск цели ──────────────────────────────────────────────────────────

  private candidates(): Element[] {
    return deepQuery(document, INTERACTIVE).filter(
      (e) => !excluded(e, this.host.deny, this.host.allow) && visible(e)
    );
  }

  /** Ровно одна цель (видимая в области просмотра — при равенстве) или null. */
  find(step: UiStep): Element | null {
    const t = step.target;
    if (!t) return null;
    const pick = (list: Element[]): Element | null => {
      if (list.length === 1) return list[0];
      if (list.length > 1) {
        const inView = list.filter((e) => {
          const r = e.getBoundingClientRect();
          return r.bottom > 0 && r.top < innerHeight;
        });
        return inView.length === 1 ? inView[0] : null;
      }
      return null;
    };
    const byRef = this.host.refs.get(t.ref);
    if (byRef && byRef.isConnected && visible(byRef) && sameTarget(byRef, t))
      return byRef;
    const all = this.candidates();
    if (t.assistId) {
      const hit = pick(
        all.filter((e) => e.getAttribute('data-assist-id') === t.assistId)
      );
      if (hit) return hit;
    }
    const want = norm(t.text);
    if (want) {
      const byText = all.filter((e) => norm(visibleText(e)) === want);
      const withRole = t.role
        ? byText.filter((e) => factsOf(e)?.role === t.role)
        : byText;
      const hit = pick(withRole) || pick(byText);
      if (hit) return hit;
    }
    if (t.selector) {
      let list: Element[] = [];
      try {
        list = [...document.querySelectorAll(t.selector)];
      } catch {
        /* селектор карты не разобрался — «не нашёл» */
      }
      return pick(
        list.filter(
          (e) => visible(e) && !excluded(e, this.host.deny, this.host.allow)
        )
      );
    }
    return null;
  }

  /**
   * Запреты по НАСТОЯЩЕЙ цели (§5-бис.6 п.5): элемент мог поменяться между
   * снимком и действием. Возвращает причину отказа или null.
   */
  liveRefusal(step: UiStep, el: Element): string | null {
    if (closestDeep(el, '[data-assist="never"]')) return 'denied';
    if (excluded(el, this.host.deny, this.host.allow)) return 'denied';
    if (sensitiveField(el)) return 'sensitive_field';
    const f = factsOf(el);
    if (!f) return 'no_target';
    if (step.kind === 'highlight' || step.kind === 'scroll') return null;
    if (f.disabled) return 'disabled';
    // Цель снимка подменили за время подсветки (текст/роль/ссылка) — не та.
    if (
      step.target &&
      /^e/.test(step.target.ref) &&
      !sameTarget(el, step.target)
    )
      return 'changed';
    const words = [
      f.text,
      f.hiddenLabel || '',
      (f.assistId || '').replace(/[-_.:]+/g, ' '),
    ].join(' ');
    if (neverTarget(words, f.assistId)) return 'danger';
    // Н-4: выбираемая опция списка — тот же стоп-лист («Скасувати
    // замовлення», «Видалити акаунт» в <select>).
    if (step.kind == 'select') {
      const o = optionOf(el, step.value);
      if (o && neverTarget(o.text, null)) return 'danger';
    }
    // `f.href` — origin+путь http(s) (cleanHref), разбирается всегда.
    if (f.href && paymentPath(new URL(f.href).pathname)) return 'payment';
    // Сервер проверял ссылку, а живая цель — уже не ссылка или ссылка
    // поменялась; без проверенной ссылки — только свой origin.
    const th = step.target && step.target.href;
    if (
      th ? th !== f.href : f.href && new URL(f.href).origin !== location.origin
    )
      return 'offhost';
    if (f.gesture) return 'gesture';
    return null;
  }

  // ── действия ────────────────────────────────────────────────────────────

  private nativeClick(el: Element) {
    const c = this.host.N.click;
    if (c && el instanceof HTMLElement) c.call(el);
    else (el as HTMLElement).click();
  }

  private pointerSequence(el: Element) {
    for (const t of [
      'pointerover',
      'pointerenter',
      'mouseover',
      'pointerdown',
      'mousedown',
    ])
      fire(el, t, t.indexOf('enter') > 0 ? { bubbles: false } : {});
    if (el instanceof HTMLElement) el.focus({ preventScroll: true });
    for (const t of ['pointerup', 'mouseup']) fire(el, t);
  }

  private act(step: UiStep, el: Element): boolean {
    const x = el as HTMLInputElement;
    let p: Prior | null = null;
    if (step.kind == 'fill' || step.kind == 'select' || step.kind == 'check') {
      if (mem[0] && mem[0][0] != this.planId) mem.length = 0;
      mem.push(
        (p = [this.planId, step.i, el, x.value, x.checked ?? null, radioOn(x)])
      );
    }
    const ok = this.go(step, el);
    if (p) {
      p[6] = x.value;
      p[7] = x.checked ?? null;
    }
    return ok;
  }

  private go(step: UiStep, el: Element): boolean {
    switch (step.kind) {
      case 'click':
        this.pointerSequence(el);
        this.nativeClick(el);
        return true;
      case 'check': {
        const f = factsOf(el);
        if (f && f.checked === true) return true; // уже отмечено
        this.pointerSequence(el);
        this.nativeClick(el);
        return true;
      }
      case 'fill': {
        if (!(
          el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
        ))
          return false;
        el.focus({ preventScroll: true });
        setNativeValue(el, step.value || '');
        fire(el, 'input', { data: step.value || '' });
        fire(el, 'change');
        return true;
      }
      case 'select': {
        const o = optionOf(el, step.value);
        if (!o || !(el instanceof HTMLSelectElement)) return false;
        el.focus({ preventScroll: true });
        setNativeValue(el, o.value);
        fire(el, 'input');
        fire(el, 'change');
        return true;
      }
      default:
        return true;
    }
  }

  /** 300 мс тишины DOM, не дольше 5 с. */
  private settle(): Promise<void> {
    const N = this.host.N;
    return new Promise((resolve) => {
      let quiet = 0;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        mo.disconnect();
        resolve();
      };
      const mo = new MutationObserver(() => {
        quiet = Date.now();
      });
      mo.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      const start = Date.now();
      quiet = start;
      const tick = () => {
        if (this.stoppedFlag) return finish();
        const now = Date.now();
        if (now - quiet >= SETTLE_QUIET_MS || now - start >= SETTLE_MAX_MS)
          return finish();
        N.later(tick, 50);
      };
      N.later(tick, 50);
    });
  }

  private expectOk(step: UiStep, el: Element | null, before: string): boolean {
    const e = step.expect;
    if (!e) return true;
    if (e.path) {
      // `/catalog/*` — префикс пути; иначе — путь целиком (без хвостовых `/`).
      const star = e.path.slice(-1) == '*';
      const p = location.pathname.replace(/\/+$/, '') || '/';
      const w = (star ? e.path.slice(0, -1) : e.path).replace(/\/+$/, '');
      if (star ? p.indexOf(w) != 0 : p != (w || '/')) return false;
    }
    if (e.appear) {
      const want = norm(e.appear);
      const hit =
        this.candidates().some(
          (x) => norm(visibleText(x)).indexOf(want) >= 0
        ) ||
        norm(document.body ? document.body.innerText : '').indexOf(want) >= 0;
      if (!hit) return false;
    }
    if (
      e.textChange &&
      el &&
      el.isConnected &&
      norm(visibleText(el)) === before
    )
      return false;
    return true;
  }

  private waitAck(index: number): Promise<boolean> {
    return new Promise((resolve) => {
      this.ackWait = { index, resolve };
      this.host.N.later(() => {
        if (this.ackWait && this.ackWait.index === index) {
          this.ackWait = null;
          resolve(false);
        }
      }, ACK_TIMEOUT_MS);
    });
  }

  /** Шаг меняет страницу/данные — исполняется не более одного раза. */
  private effect(step: UiStep): boolean {
    return step.nav || /^(click|fill|select|check|navigate)$/.test(step.kind);
  }

  /** Сверка адреса для `dispatched`-шага после перехода — без повтора клика. */
  private resumeDispatched(step: UiStep): UiStepResult {
    return this.expectOk(
      {
        ...step,
        expect:
          step.expect && step.expect.path ? { path: step.expect.path } : null,
      },
      null,
      ''
    )
      ? 'done'
      : 'failed';
  }

  async run(resumed: boolean): Promise<void> {
    const host = this.host;
    host.mark(true);
    this.mount();
    host.min();
    for (let i = this.from; i < this.steps.length; i++) {
      if (!(await this.gate())) return;
      const step = this.steps[i];
      const t0 = Date.now();
      const rep = (r: UiStepResult, why: string | null = null) =>
        host.report(i, r, why, Date.now() - t0);
      if (step.state === 'dispatched' && !step.nav) {
        // Аудит Э6-бис: действие могло сработать до перезагрузки — не
        // повторяем; iframe скажет «проверьте сами».
        rep('skipped', 'interrupted');
        return this.finish();
      }
      if (step.state === 'dispatched') {
        // §4-бис.5: шаг уже нажат на прошлой странице — НИКОГДА не повторять.
        const r = this.resumeDispatched(step);
        rep(r, r === 'failed' ? 'expect' : null);
        if (r === 'failed') return this.finish();
        continue;
      }
      if (step.state !== 'pending') continue;
      if (step.kind === 'say') {
        if (step.say) this.say(step.say);
        rep('done');
        continue;
      }
      if (step.kind === 'wait') {
        await this.settle();
        const ok = this.expectOk(step, null, '');
        rep(ok ? 'done' : 'failed', ok ? null : 'expect');
        if (!ok) return this.finish();
        continue;
      }
      if (step.target && step.target.ref === 'after') {
        // SPA сменила страницу без перезагрузки: цель — по новому снимку на
        // сервере (те же проверки), затем iframe пришлёт новый `ui-run`.
        host.need(i);
        return this.finish();
      }
      const el = step.target ? this.find(step) : null;
      if (!el) {
        rep(
          step.risk === 'manual' || step.risk === 'never' ? 'manual' : 'failed',
          'no_target'
        );
        this.say(this.L.self);
        return this.finish(true);
      }
      const caption = (step.target && step.target.text) || visibleText(el);
      // `instant` — поверх `scroll-behavior: smooth` сайта: рамка (fixed)
      // считается от прямоугольника ПОСЛЕ прокрутки, а не до неё. Старый
      // браузер без `instant` бросает TypeError — тогда как умеет.
      try {
        el.scrollIntoView({
          block: 'center',
          inline: 'nearest',
          behavior: 'instant',
        });
      } catch {
        el.scrollIntoView();
      }
      this.ringAround(el, caption);
      this.say(`${this.L.doing}: ${caption}`);
      await sleep(
        host.N,
        resumed && i === this.from
          ? HIGHLIGHT_BEFORE_MS * 2
          : HIGHLIGHT_BEFORE_MS
      );
      if (!(await this.gate())) return;
      // Не исполняется: «никогда»/«нажмите сами» — подсветка и сообщение.
      if (step.risk === 'manual' || step.risk === 'never') {
        this.say(`${this.L.self}: ${caption}`);
        rep('manual', step.reason);
        return this.finish(true);
      }
      const refusal = this.liveRefusal(step, el);
      if (refusal) {
        this.say(`${this.L.self}: ${caption}`);
        rep('failed', refusal);
        return this.finish(true);
      }
      if (step.kind === 'highlight' || step.kind === 'scroll') {
        rep('done');
        await sleep(host.N, BETWEEN_MS);
        continue;
      }
      if (this.effect(step)) {
        // Отметка «начат» на сервере (один раз) — ДО действия: перезагрузка
        // между действием и `done` не приведёт к повтору.
        rep('dispatched');
        if (!(await this.waitAck(i))) {
          if (!this.stoppedFlag) rep('failed', 'ack');
          return this.finish(true);
        }
        if (!(await this.gate())) return;
        // Пока ждали записи `dispatched`, цель могли подменить — ещё раз.
        const late = this.liveRefusal(step, el);
        if (late) {
          rep('failed', late);
          return this.finish(true);
        }
      }
      const before = norm(visibleText(el));
      this.unring();
      if (!this.act(step, el)) {
        rep('failed', 'action');
        this.ringAround(el, caption);
        return this.finish(true);
      }
      await this.settle();
      if (this.stoppedFlag) return;
      if (!this.expectOk(step, el, before)) {
        rep('failed', 'expect');
        if (el.isConnected) this.ringAround(el, caption);
        this.say(`${this.L.self}: ${caption}`);
        return this.finish(true);
      }
      rep('done');
      await sleep(host.N, BETWEEN_MS);
    }
    this.finish();
  }

  /**
   * Конец: панель убирается; при «нажмите сами» подсветка держится 6 с.
   * Уже остановленный через stop() раннер (новый `ui-run`, «Стоп») не
   * трогает ничего: его teardown был, а `mark(false)` после `mark(true)`
   * нового раннера сбросил бы флаг «план идёт».
   */
  private finish(keepRing = false) {
    if (this.stoppedFlag) return;
    const ring = this.ring;
    this.ring = null;
    this.stoppedFlag = true;
    this.teardown();
    if (keepRing && ring) {
      put(ring);
      this.host.N.later(() => ring.remove(), 6000);
    }
  }
}
