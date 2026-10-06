/**
 * Пикер визуального редактора голосовой карты (Э6-тер, ТЗ §5-кватер.3–7) —
 * ленивый ES-модуль `/v1/editor.js` в origin заказчика. Загрузчик берёт его
 * `import()` ТОЛЬКО по одноразовой ссылке `?v4c_edit=<токен>` (параметр
 * сразу снят с адреса) — у посетителей ни запроса к нему, ни узлов в DOM;
 * бюджет загрузчика не растёт (свой — scripts/size-budget.mjs).
 *
 * Что делает (Р-53: «что видит DOM — здесь, что пишет в карту — в iframe»):
 *  - создаёт закрытый Shadow DOM (`data-v4c`): рамка наведения, подсказка
 *    «как поймёт помощник», слой покрытия, подсветка шагов «Сказать сейчас»
 *    и контейнер панели — iframe `we.` (токен — во ФРАГМЕНТЕ адреса);
 *  - режим «Выбор»: перехват pointer/mouse/click/touch/submit в фазе
 *    захвата на `window` (`preventDefault` + `stopImmediatePropagation` —
 *    сайт не реагирует на выбор); «Навигация» (`N`, удерживать `Alt`) —
 *    события уходят сайту; подъём к интерактивному предку, `↑`/`↓` — уровень;
 *  - дескриптор выбранного элемента: роль, МАСКИРОВАННЫЙ видимый текст
 *    (порт `maskSensitiveEcho`), кандидаты (`data-assist-id`, тестовый
 *    атрибут, id, путь ссылки), якорь, признаки риска, единственность —
 *    БЕЗ значений полей, HTML и скриншотов (§5-кватер.11 п.7);
 *  - покрытие страницы (🟩🟨🟥🟪, ≤ 600 рамок, только видимая область);
 *  - снимок страницы для «Сказать сейчас» — тот же код, что исполнитель
 *    (`act/snapshot.ts`), но шаги НЕ исполняются: только подсветка.
 * Не хранит токенов (сессия — в iframe), не ходит в наш API, не решает ничего
 * о карте. Выход — снятие всех обработчиков и корня: DOM страницы как был.
 * Без HTML-приёмников и eval: только createElement/textContent, стили —
 * `adoptedStyleSheets` (работает под строгим CSP и Trusted Types).
 */
import { WIDGET_EDITOR_FRAME_PATH, WIDGET_EDITOR_PARAM } from '../shared/brand';
import {
  closestDeep,
  deepQuery,
  factsOf,
  takeSnapshot,
  visible,
} from '../act/snapshot';
import {
  editorEnvelope,
  maskHrefPath,
  panelOrigin,
  parseToPicker,
  stabilityOf,
  type Coverage,
  type Descriptor,
  type EditorMode,
  type PageTarget,
  type ToPanel,
} from '../shared/editor-protocol';
import { maskLabel, neverTarget } from '../shared/ui-plan';

type Lang = 'uk' | 'ru' | 'en';

const T: Record<Lang, Record<string, string>> = {
  uk: {
    select: 'Вибір',
    nav: 'Навігація',
    exit: 'Вийти',
    min: 'Згорнути',
    cov: 'Покриття',
    csp: 'CSP сайту блокує панель редактора: додайте frame-src {o} або відкрийте режим «Знімок» у Telegram.',
    noname: 'без імені — помічник не зможе назвати',
    never: 'помічник не натисне ніколи',
    found: 'Знайде за',
    title: 'Редактор голосу',
  },
  ru: {
    select: 'Выбор',
    nav: 'Навигация',
    exit: 'Выйти',
    min: 'Свернуть',
    cov: 'Покрытие',
    csp: 'CSP сайта блокирует панель редактора: добавьте frame-src {o} или откройте режим «Снимок» в Telegram.',
    noname: 'без имени — помощник не сможет назвать',
    never: 'помощник не нажмёт никогда',
    found: 'Найдёт по',
    title: 'Редактор голоса',
  },
  en: {
    select: 'Select',
    nav: 'Navigate',
    exit: 'Exit',
    min: 'Collapse',
    cov: 'Coverage',
    csp: 'The site CSP blocks the editor panel: add frame-src {o} or use Snapshot mode in Telegram.',
    noname: 'no name — the assistant cannot name it',
    never: 'the assistant will never press it',
    found: 'Found by',
    title: 'Voice editor',
  },
};

const STYLE = `:host{all:initial}*{box-sizing:border-box}
.box{position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #2563eb;border-radius:4px;background:rgba(37,99,235,.08);display:none}
.tip{position:fixed;z-index:2147483646;pointer-events:none;max-width:min(420px,90vw);padding:6px 9px;border-radius:7px;background:#111827;color:#fff;font:12px/1.4 system-ui,sans-serif;display:none;white-space:pre-line}
.cv{position:fixed;z-index:2147483645;pointer-events:none;border:2px solid;border-radius:3px}
.green{border-color:#16a34a;background:rgba(22,163,74,.08)}.yellow{border-color:#ca8a04;background:rgba(202,138,4,.08)}.red{border-color:#dc2626;background:rgba(220,38,38,.1)}.violet{border-color:#7c3aed;background:rgba(124,58,237,.12)}
.hl{position:fixed;z-index:2147483646;pointer-events:none;border:3px solid #f97316;border-radius:5px}
.hl span{position:absolute;left:-3px;top:-24px;padding:2px 6px;border-radius:5px;background:#f97316;color:#fff;font:12px/1.4 system-ui,sans-serif;white-space:nowrap}
.pn{position:fixed;z-index:2147483646;right:12px;bottom:12px;width:min(390px,calc(100vw - 24px));height:min(600px,calc(100vh - 24px));display:flex;flex-direction:column;border-radius:12px;overflow:hidden;background:#fff;box-shadow:0 10px 40px rgba(0,0,0,.35);font:13px/1.4 system-ui,sans-serif}
.pn.c{height:44px}
@media (max-width:640px){.pn{right:0;left:0;bottom:0;width:100vw;height:60vh;border-radius:12px 12px 0 0}.pn.c{height:44px}}
.bar{display:flex;gap:6px;align-items:center;padding:6px 8px;background:#111827;color:#fff;flex:0 0 auto}
.bar b{flex:1;font-weight:600;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.bar button{all:unset;cursor:pointer;padding:5px 8px;border-radius:6px;background:#374151;color:#fff;font:12px system-ui,sans-serif}
.bar button.on{background:#2563eb}
.msg{padding:10px;background:#fef3c7;color:#92400e}
iframe{border:0;width:100%;flex:1 1 auto;background:#fff}`;

/** Что считаем интерактивным при наведении (§5-кватер.3 «Уровень вложенности»). */
const INTERACTIVE =
  'a[href],button,input,select,textarea,summary,label[for],[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=radio],[role=switch],[tabindex],[contenteditable],[data-assist-id],[onclick]';
const LANDMARK = 'main,nav,header,footer,aside,form,section,dialog';
const EVENTS = [
  'pointerdown',
  'pointerup',
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'auxclick',
  'contextmenu',
  'touchstart',
  'touchend',
  'submit',
];
const FLAG = WIDGET_EDITOR_PARAM;
const MAX_FRAMES = 600;

const esc = (v: string) => {
  const c = (window as unknown as { CSS?: { escape?: (s: string) => string } })
    .CSS;
  return c && c.escape ? c.escape(v) : v.replace(/["\\]/g, '\\$&');
};

const clean = (s: string | null | undefined, max = 80) => {
  const t = maskLabel((s || '').replace(/\s+/g, ' ').trim());
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
};

const norm = (s: string) =>
  s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Ближайший интерактивный предок (или сам элемент); иначе — кликабельный div. */
function interactiveOf(start: Element | null): Element | null {
  let e: Element | null = start;
  while (e && e !== document.documentElement) {
    if (e.matches(INTERACTIVE)) return e;
    e = e.parentElement;
  }
  // Кликабельный `div` без роли — помечается красным (§5-кватер.3).
  e = start;
  for (let i = 0; e && i < 4; i++, e = e.parentElement)
    if (getComputedStyle(e).cursor === 'pointer') return e;
  return null;
}

/** Цепочка интерактивных предков — для `↑`/`↓` и хлебных крошек. */
function chainOf(e: Element): Element[] {
  const out: Element[] = [];
  let x: Element | null = e;
  while (x && x !== document.documentElement && out.length < 8) {
    if (x.matches(INTERACTIVE)) out.push(x);
    x = x.parentElement;
  }
  return out.length ? out : [e];
}

function cssPath(e: Element): string | null {
  const parts: string[] = [];
  let x: Element | null = e;
  for (let i = 0; x && x !== document.body && i < 5; i++) {
    const tag = x.tagName.toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/.test(tag)) return null;
    const p: Element | null = x.parentElement;
    if (!p) break;
    const same = Array.prototype.filter.call(
      p.children,
      (c: Element) => c.tagName === x!.tagName
    );
    parts.unshift(
      same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(x) + 1})` : tag
    );
    x = p;
  }
  const s = parts.join(' > ');
  return s && s.length <= 200 ? s : null;
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const tok = (v: string | null) => (v && TOKEN.test(v) ? v : null);

/** Все элементы страницы, похожие на дескриптор (для «единственный?» и образцов шаблона). */
export function findAll(d: Descriptor): Element[] {
  const q = (sel: string) => deepQuery(document, sel);
  if (d.assistId) return q(`[data-assist-id="${esc(d.assistId)}"]`);
  if (d.testId)
    return q(`[data-testid="${esc(d.testId)}"],[data-test="${esc(d.testId)}"]`);
  if (d.elId) {
    const x = document.getElementById(d.elId);
    return x ? [x] : [];
  }
  const all = q(INTERACTIVE).filter((x) => visible(x));
  if (d.hrefPath && d.tag === 'a') {
    const byHref = all.filter((x) => {
      const h = (x as HTMLAnchorElement).href;
      try {
        return !!h && maskHrefPath(new URL(h).pathname) === d.hrefPath;
      } catch {
        return false;
      }
    });
    if (byHref.length <= 1 || !d.text) return byHref;
    return byHref.filter((x) => norm(clean(factsOf(x)?.text)) === norm(d.text));
  }
  if (!d.text) return [];
  const t = norm(d.text);
  return all.filter((x) => {
    const f = factsOf(x);
    return !!f && norm(f.text) === t && (!d.role || f.role === d.role);
  });
}

/** Дескриптор элемента (§5-кватер.4 «Привязка») — без значений полей. */
export function describe(e: Element): { d: Descriptor; how: string } {
  const f = factsOf(e);
  const tag0 = e.tagName.toLowerCase();
  const tag = (
    ['a', 'button', 'input', 'select', 'textarea'].indexOf(tag0) >= 0
      ? tag0
      : 'other'
  ) as Descriptor['tag'];
  let hrefPath: string | null = null;
  let hrefHost: string | null = null;
  let offHost = false;
  if (tag0 === 'a' && (e as HTMLAnchorElement).href) {
    try {
      const u = new URL((e as HTMLAnchorElement).href, location.href);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        // ПД в пути (`/u/ivan@x.com`) — маской, как на сервере.
        hrefPath = maskHrefPath(u.pathname);
        hrefHost = u.host;
      } else offHost = true;
    } catch {
      offHost = true;
    }
  }
  const form = closestDeep(e, 'form') as HTMLFormElement | null;
  const lm = closestDeep(e, LANDMARK);
  const d: Descriptor = {
    tag,
    role: f ? f.role : null,
    text: f ? f.text : clean(e.textContent),
    hiddenLabel: f ? f.hiddenLabel : null,
    assistId: tok(e.getAttribute('data-assist-id')),
    testId: tok(e.getAttribute('data-testid') || e.getAttribute('data-test')),
    elId: tok(e.id || null),
    hrefPath,
    hrefHost,
    offHost,
    heading: f ? f.heading : null,
    landmark: lm ? lm.tagName.toLowerCase() : null,
    formName: form ? tok(form.getAttribute('name') || form.id || null) : null,
    inputType: f ? f.inputType : null,
    submit: !!f && f.submit,
    inForm: !!form,
    pd: !!f && f.pd,
    toggle: !!f && f.toggle,
    gesture: f ? f.gesture : null,
    neverAttr: !!closestDeep(e, '[data-assist="never"]'),
    confirmZone: !!f && f.confirmZone,
    clickableDiv: !f,
    editable: (e as HTMLElement).isContentEditable === true,
    closedShadow: false,
    unique: false,
    css: cssPath(e),
  };
  d.unique = findAll(d).length === 1;
  const how = d.assistId
    ? 'assist-id'
    : d.testId
      ? 'test-id'
      : d.elId
        ? 'id'
        : d.role && d.text
          ? 'role-name'
          : d.text
            ? 'text'
            : 'css';
  return { d, how };
}

/** Похоже на «никогда» (подсказка цвета; решает сервер, §5-кватер.4). */
function looksNever(d: Descriptor): boolean {
  return (
    d.neverAttr ||
    d.inputType === 'password' ||
    d.inputType === 'file' ||
    d.offHost ||
    neverTarget([d.text, d.hiddenLabel || ''].join(' '), d.assistId)
  );
}

function colorOf(e: Element, mapped: Map<Element, PageTarget>): Coverage {
  const t = mapped.get(e);
  if (t) return t.color;
  const f = factsOf(e);
  const text = f ? f.text : '';
  const assistId = e.getAttribute('data-assist-id');
  if (
    closestDeep(e, '[data-assist="never"]') ||
    (f && (f.inputType === 'password' || f.inputType === 'file')) ||
    neverTarget([text, (f && f.hiddenLabel) || ''].join(' '), assistId)
  )
    return 'violet';
  if (assistId) return 'green';
  if (!f || (!text && !f.hiddenLabel) || (e as HTMLElement).isContentEditable)
    return 'red';
  return 'yellow';
}

export function start(
  token: string,
  pk: string,
  widgetOrigin: string,
  lang0: string
): void {
  if ((window as unknown as Record<string, unknown>).__v4cEditor) return;
  (window as unknown as Record<string, unknown>).__v4cEditor = 1;
  const lang: Lang = lang0 === 'ru' || lang0 === 'en' ? lang0 : 'uk';
  const L = T[lang];
  const pOrigin = panelOrigin(widgetOrigin);
  try {
    sessionStorage.setItem(FLAG, '1');
  } catch {
    /* продолжение после перехода — только в этой странице */
  }

  const host = document.createElement('div');
  host.setAttribute('data-v4c', 'editor');
  const root = host.attachShadow({ mode: 'closed' });
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(STYLE);
    (
      root as unknown as { adoptedStyleSheets: CSSStyleSheet[] }
    ).adoptedStyleSheets = [sheet];
  } catch {
    /* без стилей — функции остаются */
  }
  const box = el('div', 'box');
  const tip = el('div', 'tip');
  const layer = el('div');
  const hls = el('div');
  const pn = el('div', 'pn');
  const bar = el('div', 'bar');
  const title = el('b', '', L.title);
  const bSel = el('button', 'on', L.select);
  const bCov = el('button', '', L.cov);
  const bMin = el('button', '', '▾');
  bMin.setAttribute('aria-label', L.min);
  const bExit = el('button', '', L.exit);
  bar.append(title, bSel, bCov, bMin, bExit);
  const frame = document.createElement('iframe');
  frame.setAttribute('title', L.title);
  frame.setAttribute('allow', 'microphone');
  frame.src = `${pOrigin}${WIDGET_EDITOR_FRAME_PATH}?pk=${encodeURIComponent(pk)}${
    token && token !== '-' ? `#t=${encodeURIComponent(token)}` : ''
  }`;
  pn.append(bar, frame);
  root.append(layer, hls, box, tip, pn);
  document.documentElement.appendChild(host);

  let mode: EditorMode = 'select';
  let altNav = false;
  let coverage = false;
  let current: Element | null = null;
  let chain: Element[] = [];
  let level = 0;
  let targets: PageTarget[] = [];
  let refs = new Map<string, Element>();
  let lastPath = location.pathname;
  let raf = 0;
  const cleanups: Array<() => void> = [];

  const on = <K extends string>(
    t: EventTarget,
    type: K,
    fn: (e: Event) => void,
    opts?: AddEventListenerOptions | boolean
  ) => {
    t.addEventListener(type, fn, opts);
    cleanups.push(() => t.removeEventListener(type, fn, opts));
  };

  const send = (m: ToPanel) => {
    if (frame.contentWindow)
      frame.contentWindow.postMessage(editorEnvelope(m), pOrigin);
  };

  const own = (t: EventTarget | null) =>
    t === host || (t instanceof Node && host.contains(t));
  const selecting = () => mode === 'select' && !altNav;

  const setMode = (m: EditorMode, tell = true) => {
    mode = m;
    bSel.textContent = m === 'select' ? L.select : L.nav;
    bSel.className = m === 'select' ? 'on' : '';
    if (m === 'nav') hide();
    if (tell) send({ type: 'mode', mode: m });
  };

  const hide = () => {
    box.style.display = 'none';
    tip.style.display = 'none';
  };

  const place = (n: HTMLElement, r: DOMRect) => {
    n.style.left = `${r.left - 2}px`;
    n.style.top = `${r.top - 2}px`;
    n.style.width = `${r.width + 4}px`;
    n.style.height = `${r.height + 4}px`;
  };

  const hover = (e: Element | null) => {
    if (!e || own(e)) return hide();
    const target = interactiveOf(e);
    if (!target) return hide();
    if (target !== chain[0]) {
      chain = chainOf(target);
      level = 0;
    }
    show(chain[level] || target);
  };

  const show = (t: Element) => {
    current = t;
    const r = t.getBoundingClientRect();
    place(box, r);
    box.style.display = 'block';
    const { d, how } = describe(t);
    const st = stabilityOf(d);
    const head = `${d.text ? `«${d.text}»` : `(${L.noname})`} · ${d.role || d.tag}${
      d.assistId ? ` · data-assist-id="${d.assistId}"` : ''
    }`;
    const line2 = looksNever(d)
      ? `🟪 ${L.never}`
      : `${L.found}: ${how} · ${st}`;
    tip.textContent = `${head}\n${line2}`;
    tip.style.left = `${Math.max(4, Math.min(innerWidth - 300, r.left))}px`;
    tip.style.top = `${r.bottom + 8 > innerHeight - 60 ? Math.max(4, r.top - 52) : r.bottom + 8}px`;
    tip.style.display = 'block';
  };

  // Запись мемо (Э6-тер (д)): последний элемент, выбранный НАСТОЯЩИМ
  // кликом человека, — единственное, что панель может попросить нажать.
  // Метка — случайная: поддельный `pick` скрипта страницы её не знает, и
  // `perform` по нему ничего не нажмёт.
  let armed: Element | null = null;
  let pid = '';
  let passing = false;

  const pick = (t: Element, real = false) => {
    const { d, how } = describe(t);
    armed = real ? t : null;
    pid = real ? Math.random().toString(36).slice(2, 12) : '';
    const tag = t.tagName;
    const field = /^(INPUT|SELECT|TEXTAREA)$/.test(tag);
    const options: string[] = [];
    if (tag === 'SELECT') {
      const o = (t as HTMLSelectElement).options;
      for (let i = 0; i < o.length && i < 20; i++)
        options.push(clean(o[i].text));
    }
    send({
      type: 'pick',
      descriptor: d,
      crumbs: chainOf(t).map((x) => x.tagName.toLowerCase()),
      how,
      stability: stabilityOf(d),
      never: looksNever(d),
      // Имя поля и подписи вариантов — НЕ значение (его не читаем вовсе).
      fieldName: field ? tok(t.getAttribute('name')) : null,
      options,
      pid: pid || null,
    });
  };

  // ── перехват событий в режиме «Выбор» (фаза захвата на window) ──
  const guard = (e: Event) => {
    if (passing || !selecting() || own(e.target)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === 'click' || (e.type === 'touchend' && current)) {
      const t =
        e.type === 'click' ? interactiveOf(e.target as Element) : current;
      if (t) {
        if (t !== chain[0]) {
          chain = chainOf(t);
          level = 0;
        }
        show(chain[level] || t);
        pick(chain[level] || t, e.isTrusted);
      }
    }
  };
  for (const t of EVENTS) on(window, t, guard, { capture: true });
  on(
    window,
    'pointermove',
    (e) => {
      if (!selecting()) return;
      const p = e as PointerEvent;
      hover(document.elementFromPoint(p.clientX, p.clientY));
    },
    { capture: true, passive: true }
  );
  on(
    window,
    'touchstart',
    (e) => {
      if (!selecting()) return;
      const t = (e as TouchEvent).touches[0];
      if (t) hover(document.elementFromPoint(t.clientX, t.clientY));
    },
    { capture: true, passive: true }
  );

  const typing = (t: EventTarget | null) =>
    t instanceof HTMLElement &&
    !own(t) &&
    (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);

  on(
    window,
    'keydown',
    (ev) => {
      const e = ev as KeyboardEvent;
      if (e.key === 'Alt') {
        altNav = true;
        hide();
        return;
      }
      if (typing(e.target) || e.ctrlKey || e.metaKey) return;
      const k = e.key.toLowerCase();
      let used = true;
      if (k === 'n') setMode(mode === 'select' ? 'nav' : 'select');
      else if (k === 'c') toggleCoverage();
      else if (k === 'escape') {
        if (current) {
          current = null;
          hide();
        } else toggleMin();
      } else if (k === 'arrowup' && current && selecting()) {
        level = Math.min(chain.length - 1, level + 1);
        show(chain[level]);
      } else if (k === 'arrowdown' && current && selecting()) {
        level = Math.max(0, level - 1);
        show(chain[level]);
      } else if (k === 'enter' && current && selecting())
        pick(current, e.isTrusted);
      else used = false;
      if (used) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    { capture: true }
  );
  on(
    window,
    'keyup',
    (ev) => {
      if ((ev as KeyboardEvent).key === 'Alt') altNav = false;
    },
    { capture: true }
  );
  on(window, 'blur', () => (altNav = false));

  // ── покрытие (§5-кватер.7) ──
  const frames: HTMLElement[] = [];
  const drawCoverage = () => {
    raf = 0;
    const mapped = new Map<Element, PageTarget>();
    for (const t of targets) {
      const found = findAll(t.descriptor);
      if (found.length === 1) mapped.set(found[0], t);
    }
    const counts = { green: 0, yellow: 0, red: 0, violet: 0 };
    let n = 0;
    if (coverage) {
      const margin = 200;
      for (const e of deepQuery(document, INTERACTIVE)) {
        if (n >= MAX_FRAMES) break;
        if (own(e) || !visible(e)) continue;
        if (e.parentElement && e.parentElement.closest('a[href],button'))
          continue;
        const r = e.getBoundingClientRect();
        if (r.bottom < -margin || r.top > innerHeight + margin) continue;
        const c = colorOf(e, mapped);
        counts[c]++;
        let f = frames[n];
        if (!f) {
          f = el('div');
          frames.push(f);
          layer.appendChild(f);
        }
        f.className = `cv ${c}`;
        place(f, r);
        f.style.display = 'block';
        n++;
      }
    }
    for (let i = n; i < frames.length; i++) frames[i].style.display = 'none';
    if (coverage) send({ type: 'counts', ...counts });
  };
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(drawCoverage);
  };
  const toggleCoverage = () => {
    coverage = !coverage;
    bCov.className = coverage ? 'on' : '';
    schedule();
  };
  on(window, 'scroll', schedule, { capture: true, passive: true });
  on(window, 'resize', schedule, { passive: true });

  // ── подсветка шагов «Сказать сейчас» (без нажатий) ──
  const highlight = (items: Array<{ ref: string; label: string }>) => {
    while (hls.firstChild) hls.removeChild(hls.firstChild);
    for (const it of items) {
      const t = refs.get(it.ref);
      if (!t) continue;
      const b = el('div', 'hl');
      b.appendChild(el('span', '', it.label));
      place(b, t.getBoundingClientRect());
      hls.appendChild(b);
    }
    const first = items.length ? refs.get(items[0].ref) : null;
    if (first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  const toggleMin = () => {
    pn.classList.toggle('c');
    bMin.textContent = pn.classList.contains('c') ? '▴' : '▾';
  };

  const exit = () => {
    for (const c of cleanups.splice(0)) c();
    if (raf) cancelAnimationFrame(raf);
    host.remove();
    try {
      sessionStorage.removeItem(FLAG);
    } catch {
      /* нет хранилища — нечего снимать */
    }
    delete (window as unknown as Record<string, unknown>).__v4cEditor;
  };

  on(bSel, 'click', () => setMode(mode === 'select' ? 'nav' : 'select'));
  on(bCov, 'click', toggleCoverage);
  on(bMin, 'click', toggleMin);
  on(bExit, 'click', () => {
    send({ type: 'mode', mode: 'nav' });
    exit();
  });

  // CSP сайта без `frame-src we.` — понятное сообщение (§5-кватер.11 п.5).
  on(document, 'securitypolicyviolation', (ev) => {
    const e = ev as SecurityPolicyViolationEvent;
    if (e.blockedURI && e.blockedURI.indexOf(pOrigin) === 0) {
      frame.remove();
      pn.appendChild(el('div', 'msg', L.csp.replace('{o}', pOrigin)));
    }
  });

  // ── сообщения панели: только наш iframe и точный origin ──
  on(window, 'message', (ev) => {
    const e = ev as MessageEvent;
    if (e.source !== frame.contentWindow || e.origin !== pOrigin) return;
    const m = parseToPicker(e.data);
    if (!m) return;
    switch (m.type) {
      case 'exit':
        return exit();
      case 'perform': {
        // Только элемент последнего настоящего клика, ещё на странице.
        const t = armed;
        const ok = !!pid && m.pid === pid;
        armed = null;
        pid = '';
        if (!t || !ok || !t.isConnected) return;
        passing = true;
        try {
          (t as HTMLElement).click();
        } finally {
          passing = false;
        }
        return;
      }
      case 'mode':
        return setMode(m.mode, false);
      case 'coverage':
        if (m.on !== coverage) toggleCoverage();
        return;
      case 'size':
        if (m.open === pn.classList.contains('c')) toggleMin();
        return;
      case 'targets':
        targets = m.items;
        schedule();
        return;
      case 'highlight':
        return highlight(m.items);
      case 'snapshot-req': {
        const s = takeSnapshot([], []);
        refs = s.refs;
        send({ type: 'snapshot', id: m.id, snapshot: s.snapshot });
        return;
      }
      case 'resolve':
        send({
          type: 'resolved',
          id: m.id,
          items: m.items.map((i) => ({
            key: i.key,
            found: findAll(i.descriptor).length,
          })),
        });
        return;
      case 'focus': {
        const t = targets.find((x) => x.key === m.key);
        const found = t ? findAll(t.descriptor) : [];
        if (found[0]) {
          found[0].scrollIntoView({ block: 'center' });
          chain = chainOf(found[0]);
          level = 0;
          show(found[0]);
        }
        return;
      }
    }
  });

  on(frame, 'load', () =>
    send({
      type: 'ready',
      path: location.pathname,
      title: clean(document.title, 200),
      lang,
    })
  );
  // SPA: смена адреса без перезагрузки — панель перечитывает карту страницы.
  const timer = setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      send({ type: 'route', path: lastPath });
      schedule();
    }
  }, 500);
  cleanups.push(() => clearInterval(timer));
}
