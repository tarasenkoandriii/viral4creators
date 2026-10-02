/**
 * Ленивый чанк вовлечения и целей `dist/v1/engage.js` (Э3; вынесен из
 * загрузчика интеграцией — бюджет загрузчика 12 КБ gzip не поднимается).
 * ES-модуль: загрузчик берёт его `import()` (не вставкой <script>: под
 * `require-trusted-types-for 'script'` сеттер `script.src` бросает без
 * политики, а динамический импорт — не приёмник Trusted Types; CSP
 * script-src виджета его разрешает), после `load` + простоя или при первом
 * взаимодействии и ТОЛЬКО если в конфиге есть цели или триггеры.
 *
 * Здесь (перенесено из загрузчика W без изменения правил):
 *  - разбор `engagement`/`goals` (engagement.ts — строгий, значение не по
 *    форме отбрасывается целиком);
 *  - проактивные триггеры MVP с лимитами навязчивости §5-тер.12 п.1–5, 8–10
 *    (пузырь `role="status"`, ничего не открывается само, ≤ 1–2 за визит, не
 *    раньше 10 с, не на первом экране телефона, не после закрытия, не на
 *    исключённых путях, только при status `active`);
 *  - детекторы целей: url — раз на документ (и для каждого SPA-пути, что
 *    был ДО загрузки чанка), click — раз на цель за документ, form_submit —
 *    только не отменённая сайтом (решает слушатель загрузчика в момент
 *    события), авто tel:/мессенджеры, `V4CAssist('goal')` (детектор js).
 * Те же запреты, что у загрузчика: только createElement/textContent, без
 * HTML-приёмников и eval (линт и size-budget). Нативные методы — копии
 * загрузчика (`h.N`), снятые при его старте.
 */
import { pathMatches } from '../shared/config';
import {
  MESSENGER_HREF,
  MIN_TRIGGER_SECONDS,
  ORDER_ID,
  parseEngagement,
  parseGoals,
  type Descriptor,
  type GoalDetector,
  type Trigger,
} from '../shared/engagement';
import { cleanQuestion } from '../shared/protocol';
import { roleOf, textOf } from '../shared/dom';
import { WIDGET_GOAL_ATTR, WIDGET_GOAL_SUBMIT_ATTR } from '../shared/brand';
import { isObj } from '../shared/config';
import type { EngageApi, EngageHost, EngEvent, GoalMsg } from './host';

const HIDE = {
  uk: 'Закрити підказку',
  ru: 'Закрыть подсказку',
  en: 'Dismiss hint',
};

const CSS = `.g{position:fixed;z-index:var(--z);display:flex;max-width:min(280px,calc(100vw - 2*var(--x)));background:#fff;color:#111;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.22);font:14px/1.4 system-ui,sans-serif}
.g button{all:unset;cursor:pointer;padding:10px 12px}.g button+button{padding:10px;opacity:.6}.g button:focus-visible{outline:2px solid var(--c)}
.R .g{right:calc(var(--x) + env(safe-area-inset-right,0px))}.L .g{left:calc(var(--x) + env(safe-area-inset-left,0px))}
.B .g{bottom:calc(var(--y) + var(--s) + var(--bs) + 12px)}.T .g{top:calc(var(--y) + var(--s) + var(--bs) + 12px)}`;

/** Элемент (или предок ≤ 6 уровней) подходит под дескриптор цели. */
export function matchDescriptor(
  el: Element | null,
  d: Descriptor,
  attr: string
): boolean {
  for (let n = 0; el && n < 6; n++, el = el.parentElement) {
    if (d.assistGoal || d.assistId) {
      if (
        (d.assistGoal && el.getAttribute(attr) === d.assistGoal) ||
        (d.assistId && el.getAttribute('data-assist-id') === d.assistId)
      )
        return true;
    } else if (textOf(el) === d.text && (!d.role || roleOf(el) === d.role))
      return true;
  }
  return false;
}

export function start(h: EngageHost): EngageApi {
  const N = h.N;
  const eng = parseEngagement(h.cfg.rawEngagement);
  const det: Array<[string, GoalDetector]> = [];
  for (const g of parseGoals(h.cfg.rawGoals))
    for (const d of g.detectors) det.push([g.key, d]);
  const fired: string[] = [];
  const fine = window.matchMedia('(pointer: fine)').matches;
  let prevPath = h.prevPath;
  let exit = false;
  let bub: HTMLElement | null = null;
  let sheet = false;

  // ── цели (§5-тер.1) ──

  function goal(
    key: string,
    detector: GoalMsg['detector'],
    path: string,
    extra?: Pick<GoalMsg, 'orderId' | 'value' | 'currency'>
  ) {
    if (!h.analytics) return;
    // url — раз на документ, click/form — раз на цель за документ; js — дедуп по orderId (сервер).
    const id = detector + ':' + key;
    if (detector !== 'js') {
      if (fired.indexOf(id) >= 0) return;
      fired.push(id);
    }
    h.sendGoal({
      type: 'goal',
      goalKey: key,
      detector,
      docId: '',
      path: path.length <= 512 && !/\s/.test(path) ? path : null,
      orderId: null,
      value: null,
      currency: null,
      ...extra,
    });
  }

  function urlGoals(path: string) {
    for (const [k, d] of det)
      if (
        d.kind === 'url' &&
        pathMatches(d.pathMask, path) &&
        (!d.fromPathMask || pathMatches(d.fromPathMask, prevPath))
      )
        goal(k, 'url', path);
    prevPath = path;
  }

  /**
   * Клик/отправка формы → цели: разметка (`data-assist-goal` /
   * `data-assist-goal-submit` = ключ), дескриптор WYSIWYG (маска пути +
   * data-assist-* или роль и текст), авто tel:/мессенджеры (только клик).
   */
  function hits(
    kind: 'click' | 'form_submit',
    el: Element,
    attr: string,
    href: string,
    path: string,
    sub?: Element | null
  ) {
    const mk = el.closest('[' + attr + ']');
    const mv = mk && mk.getAttribute(attr);
    for (const [k, d] of det)
      if (
        d.kind === 'auto'
          ? kind === 'click' &&
            (d.auto === 'tel' ? /^tel:/i.test(href) : MESSENGER_HREF.test(href))
          : d.kind === kind &&
            (mv === k ||
              ((!d.pathMask || pathMatches(d.pathMask, path)) &&
                (matchDescriptor(el, d.descriptor, attr) ||
                  (!!sub && matchDescriptor(sub, d.descriptor, attr)))))
      )
        goal(k, kind, path);
  }

  /**
   * `V4CAssist('goal', key, {value, currency, orderId})` — только ключ цели
   * сайта с детектором js и эти три поля (никаких имён, телефонов, корзины,
   * §5-тер.1); orderId-контакт не отправляем (сервер ответил бы 422).
   */
  function jsGoal(args: unknown[]) {
    const [, a, b] = args;
    const o = isObj(b) ? b : {};
    const v = o.value;
    const c = o.currency;
    const id = o.orderId;
    if (
      typeof a === 'string' &&
      det.some(([k, d]) => k === a && d.kind === 'js') &&
      (id === undefined || (typeof id === 'string' && ORDER_ID.test(id)))
    )
      goal(a, 'js', location.pathname, {
        orderId: (id as string) || null,
        value: typeof v === 'number' && v >= 0 && v <= 1e9 ? v : null,
        currency: typeof c === 'string' && /^[A-Z]{3}$/.test(c) ? c : null,
      });
  }

  // ── проактивные триггеры (§3.6 п.4, §5-тер.12) ──

  function unbubble() {
    if (bub) bub.remove();
    bub = null;
  }

  /**
   * Пузырь (§5-тер.12): `role="status"`, ничего не открывает сам — текст-
   * кнопка (принять) и «×» (закрыть). Текст — данные (textContent).
   */
  function bubble(text: string, accept: () => void, dismiss: () => void) {
    const ui = h.ui;
    if (!ui) return;
    unbubble();
    if (!sheet) {
      sheet = true;
      const sr = ui.root.getRootNode() as ShadowRoot;
      try {
        const s = new CSSStyleSheet();
        s.replaceSync(CSS);
        sr.adoptedStyleSheets = sr.adoptedStyleSheets.concat(s);
      } catch {
        const st = N.el('style');
        st.textContent = CSS;
        sr.appendChild(st);
      }
    }
    const g = N.el('div');
    g.className = 'g';
    g.setAttribute('role', 'status');
    const a = N.el('button');
    a.textContent = text;
    const x = N.el('button');
    x.textContent = '×';
    x.setAttribute('aria-label', HIDE[h.lang]);
    N.on(a, 'click', accept);
    N.on(x, 'click', dismiss);
    g.appendChild(a);
    g.appendChild(x);
    ui.root.appendChild(g);
    bub = g;
  }

  /** Лимиты навязчивости §5-тер.12 п.1–5, 8–10 — все здесь, до показа. */
  function fire(t: Trigger) {
    const path = location.pathname;
    const ui = h.ui;
    if (
      !ui ||
      bub ||
      h.stop ||
      h.hidden ||
      h.cfg.status !== 'active' ||
      h.shown >= eng.perVisit ||
      ui.isOpen() ||
      !h.allowed() ||
      h.isInline() ||
      Date.now() - h.t0 < MIN_TRIGGER_SECONDS * 1000 ||
      eng.excludedPaths.some((m) => pathMatches(m, path)) ||
      (t.pathMasks.length && !t.pathMasks.some((m) => pathMatches(m, path))) ||
      // Телефон: не на первом экране — сначала посетитель листает сам.
      (ui.isMobile() && window.scrollY < window.innerHeight)
    )
      return;
    const text = t.text[h.lang] || t.text.uk || t.text.ru || t.text.en;
    if (!text) return;
    h.shown++;
    h.writeUi();
    h.count('proactive_shown', t.key);
    bubble(
      text,
      () => {
        unbubble();
        h.stop = true;
        h.count('proactive_accepted', t.key);
        h.open();
        const a = t.accept;
        h.post({
          type: 'proactive',
          triggerKey: t.key,
          action: a.kind,
          scenarioKey: a.kind === 'scenario' ? a.scenarioKey : null,
          question:
            a.kind === 'prefill'
              ? cleanQuestion(
                  a.question[h.lang] ||
                    a.question.uk ||
                    a.question.ru ||
                    a.question.en
                )
              : null,
        });
        h.writeUi();
      },
      () => {
        unbubble();
        // Закрыл сигнал — до конца визита больше ни одного (§5-тер.12 п.4).
        h.stop = true;
        h.writeUi();
        h.count('proactive_dismissed', t.key);
      }
    );
  }

  function check() {
    const de = document.documentElement;
    const pct = ((window.scrollY + window.innerHeight) / de.scrollHeight) * 100;
    const now = Date.now();
    for (const t of eng.triggers) {
      const c = t.cond;
      if (
        c.kind === 'scroll_depth'
          ? pct >= c.percent
          : c.kind === 'exit_intent'
            ? exit
            : now -
                (c.kind === 'url_match'
                  ? pathMatches(c.pathMask, location.pathname)
                    ? h.routeAt
                    : now
                  : h.t0) >=
              c.seconds * 1000
      )
        fire(t);
    }
    exit = false;
  }

  /** Раз в секунду (пока сигнал ещё возможен): условия всех триггеров. */
  function tick() {
    if (!eng.triggers.length || h.stop || h.shown >= eng.perVisit) return;
    check();
    h.later(tick, 1000);
  }

  if (eng.triggers.length) {
    const onOut = (e: Event) => {
      const m = e as MouseEvent;
      // exit-intent — только мышь (pointer: fine), курсор ушёл за верх окна.
      if (!m.relatedTarget && m.clientY <= 0 && fine) {
        exit = true;
        check();
      }
    };
    N.on(document, 'mouseout', onOut);
    h.cleanups.push(() => N.off(document, 'mouseout', onOut));
    tick();
  }

  return {
    ev(e: EngEvent) {
      if (h.destroyed) return;
      if (e[0] === 'r') urlGoals(e[1]);
      else if (e[0] === 'c') hits('click', e[1], WIDGET_GOAL_ATTR, e[2], e[3]);
      else if (e[0] === 's')
        hits('form_submit', e[1], WIDGET_GOAL_SUBMIT_ATTR, '', e[3], e[2]);
      else jsGoal(e[1]);
    },
    unbubble,
  };
}
