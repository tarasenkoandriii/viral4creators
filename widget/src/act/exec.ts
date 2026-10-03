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
 *  - пауза между шагами ≥ 300 мс (антибот, §5-бис.8).
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

function css(e: HTMLElement, props: Record<string, string>) {
  for (const k in props) e.style.setProperty(k, props[k], 'important');
}

/** Нативный сеттер значения прототипа (React/Vue видят изменение). */
function setNativeValue(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string
) {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  const d = Object.getOwnPropertyDescriptor(proto, 'value');
  if (d && d.set) d.set.call(el, value);
  else el.value = value;
}

function fire(el: Element, type: string, init: Record<string, unknown> = {}) {
  const opts = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    ...init,
  };
  let ev: Event;
  if (type.indexOf('pointer') === 0 && typeof PointerEvent === 'function')
    ev = new PointerEvent(type, {
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      ...opts,
    });
  else if (type.indexOf('mouse') === 0) ev = new MouseEvent(type, opts);
  else if (type === 'input' && typeof InputEvent === 'function')
    ev = new InputEvent(type, {
      bubbles: true,
      composed: true,
      inputType: 'insertText',
      ...init,
    });
  else
    ev = new Event(type, {
      bubbles: true,
      cancelable: type !== 'input' && type !== 'change',
    });
  el.dispatchEvent(ev);
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

  stop(by: StopBy | null) {
    if (this.stoppedFlag) return;
    this.stoppedFlag = true;
    if (this.ackWait) this.ackWait.resolve(false);
    this.wake();
    this.teardown();
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
    css(bar, {
      position: 'fixed',
      left: '50%',
      bottom: '16px',
      transform: 'translateX(-50%)',
      'z-index': '2147483647',
      display: 'flex',
      'align-items': 'center',
      gap: '10px',
      background: '#111827',
      color: '#fff',
      'border-radius': '999px',
      padding: '8px 10px 8px 16px',
      font: '600 14px/1.3 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
      'box-shadow': '0 6px 24px rgba(0,0,0,.25)',
      'max-width': 'calc(100vw - 24px)',
    });
    const live = N.el('span');
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    live.textContent = this.L.doing;
    css(live, {
      overflow: 'hidden',
      'text-overflow': 'ellipsis',
      'white-space': 'nowrap',
    });
    const btn = N.el('button');
    btn.type = 'button';
    btn.textContent = '■ ' + this.L.stop;
    btn.setAttribute('data-act-stop', '');
    css(btn, {
      background: '#dc2626',
      color: '#fff',
      border: '0',
      'border-radius': '999px',
      padding: '8px 14px',
      font: 'inherit',
      cursor: 'pointer',
      'min-height': '40px',
    });
    N.on(btn, 'click', () => this.stop('button'));
    bar.appendChild(live);
    bar.appendChild(btn);
    root.appendChild(bar);
    (document.body || document.documentElement).appendChild(host);
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

  private teardown() {
    for (const c of this.cleanups.splice(0)) c();
    this.unring();
    if (this.overlay) this.overlay.remove();
    this.overlay = null;
    this.host.mark(false);
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
    css(ring, {
      position: 'fixed',
      'z-index': '2147483646',
      'pointer-events': 'none',
      'box-sizing': 'border-box',
      border: `3px solid ${COLOR}`,
      'border-radius': '8px',
      'box-shadow': '0 0 0 4px rgba(37,99,235,.25)',
      margin: '0',
      padding: '0',
      top: `${r.top - 6}px`,
      left: `${r.left - 6}px`,
      width: `${r.width + 12}px`,
      height: `${r.height + 12}px`,
    });
    const tip = N.el('div');
    tip.textContent = caption;
    css(tip, {
      position: 'absolute',
      top: '100%',
      left: '0',
      'margin-top': '6px',
      background: COLOR,
      color: '#fff',
      font: '600 13px/1.3 system-ui,sans-serif',
      padding: '4px 8px',
      'border-radius': '6px',
      'white-space': 'nowrap',
      'max-width': '260px',
      overflow: 'hidden',
      'text-overflow': 'ellipsis',
    });
    if (caption) ring.appendChild(tip);
    (document.body || document.documentElement).appendChild(ring);
    this.ring = ring;
  }

  private unring() {
    if (this.ring) this.ring.remove();
    this.ring = null;
  }

  // ── поиск цели ──────────────────────────────────────────────────────────

  private candidates(): Element[] {
    return deepQuery(
      document,
      'a[href],button,input,select,textarea,summary,label[for],[role],[data-assist-id],[onclick]'
    ).filter(
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
        list = Array.prototype.slice.call(
          document.querySelectorAll(t.selector)
        );
      } catch {
        list = [];
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
    // Сервер проверял ссылку, а живая цель — уже не ссылка.
    if (step.target && step.target.href && !f.href) return 'offhost';
    if (f.href) {
      try {
        if (paymentPath(new URL(f.href).pathname)) return 'payment';
      } catch {
        return 'offhost';
      }
      // Ссылка поменялась после проверки сервером — не нажимаем.
      if (step.target && step.target.href && step.target.href !== f.href)
        return 'offhost';
      if (!step.target || !step.target.href) {
        if (new URL(f.href).origin !== location.origin) return 'offhost';
      }
    }
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
        if (!(el instanceof HTMLSelectElement)) return false;
        const want = norm(step.value || '');
        let val: string | null = null;
        for (let i = 0; i < el.options.length; i++) {
          const o = el.options[i];
          if (norm(o.text) === want || norm(o.value) === want) {
            val = o.value;
            break;
          }
        }
        if (val === null) return false;
        el.focus({ preventScroll: true });
        setNativeValue(el, val);
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
      const want = e.path;
      const p = location.pathname.replace(/\/+$/, '') || '/';
      const w = want.endsWith('*')
        ? want.slice(0, -1).replace(/\/+$/, '')
        : want.replace(/\/+$/, '') || '/';
      if (want.endsWith('*') ? p.indexOf(w) !== 0 : p !== w) return false;
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
    return (
      step.nav ||
      step.kind === 'click' ||
      step.kind === 'fill' ||
      step.kind === 'select' ||
      step.kind === 'check' ||
      step.kind === 'navigate'
    );
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
      if (step.state === 'dispatched' && !step.nav) {
        // Аудит Э6-бис: действие могло сработать до перезагрузки — не
        // повторяем; iframe скажет «проверьте сами».
        host.report(i, 'skipped', 'interrupted', Date.now() - t0);
        return this.finish();
      }
      if (step.state === 'dispatched') {
        // §4-бис.5: шаг уже нажат на прошлой странице — НИКОГДА не повторять.
        const r = this.resumeDispatched(step);
        host.report(i, r, r === 'failed' ? 'expect' : null, Date.now() - t0);
        if (r === 'failed') return this.finish();
        continue;
      }
      if (step.state !== 'pending') continue;
      if (step.kind === 'say') {
        if (step.say) this.say(step.say);
        host.report(i, 'done', null, 0);
        continue;
      }
      if (step.kind === 'wait') {
        await this.settle();
        const ok = this.expectOk(step, null, '');
        host.report(
          i,
          ok ? 'done' : 'failed',
          ok ? null : 'expect',
          Date.now() - t0
        );
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
        host.report(
          i,
          step.risk === 'manual' || step.risk === 'never' ? 'manual' : 'failed',
          'no_target',
          Date.now() - t0
        );
        this.say(this.L.self);
        return this.finish(true);
      }
      const caption = (step.target && step.target.text) || visibleText(el);
      try {
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
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
        host.report(i, 'manual', step.reason, Date.now() - t0);
        return this.finish(true);
      }
      const refusal = this.liveRefusal(step, el);
      if (refusal) {
        this.say(`${this.L.self}: ${caption}`);
        host.report(i, 'failed', refusal, Date.now() - t0);
        return this.finish(true);
      }
      if (step.kind === 'highlight' || step.kind === 'scroll') {
        host.report(i, 'done', null, Date.now() - t0);
        await sleep(host.N, BETWEEN_MS);
        continue;
      }
      if (this.effect(step)) {
        // Отметка «начат» на сервере (один раз) — ДО действия: перезагрузка
        // между действием и `done` не приведёт к повтору.
        host.report(i, 'dispatched', null, Date.now() - t0);
        if (!(await this.waitAck(i))) {
          if (!this.stoppedFlag)
            host.report(i, 'failed', 'ack', Date.now() - t0);
          return this.finish(true);
        }
        if (!(await this.gate())) return;
        // Пока ждали записи `dispatched`, цель могли подменить — ещё раз.
        const late = this.liveRefusal(step, el);
        if (late) {
          host.report(i, 'failed', late, Date.now() - t0);
          return this.finish(true);
        }
      }
      const before = norm(visibleText(el));
      this.unring();
      if (!this.act(step, el)) {
        host.report(i, 'failed', 'action', Date.now() - t0);
        this.ringAround(el, caption);
        return this.finish(true);
      }
      await this.settle();
      if (this.stoppedFlag) return;
      if (!this.expectOk(step, el, before)) {
        host.report(i, 'failed', 'expect', Date.now() - t0);
        if (el.isConnected) this.ringAround(el, caption);
        this.say(`${this.L.self}: ${caption}`);
        return this.finish(true);
      }
      host.report(i, 'done', null, Date.now() - t0);
      await sleep(host.N, BETWEEN_MS);
    }
    this.finish();
  }

  /** Конец: панель убирается; при «нажмите сами» подсветка держится 6 с. */
  private finish(keepRing = false) {
    const ring = this.ring;
    this.ring = null;
    this.stoppedFlag = true;
    this.teardown();
    if (keepRing && ring) {
      (document.body || document.documentElement).appendChild(ring);
      this.host.N.later(() => ring.remove(), 6000);
    }
  }
}
