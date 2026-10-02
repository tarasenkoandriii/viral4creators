/**
 * Режим выбора цели на сайте (Э3, W; ТЗ §5-тер.1 «WYSIWYG-выбор элемента»).
 * Отдельный IIFE-чанк `dist/v1/picker.js` (WIDGET_PICKER_PATH): загрузчик
 * подгружает его ТОЛЬКО при `?v4c_goal=<токен>` в адресе (сам параметр
 * сразу убирает `history.replaceState`), посетителям он не грузится и в
 * бюджет загрузчика 12 КБ не входит (свой бюджет — scripts/size-budget.mjs).
 *
 * Что делает: обмен токена (`POST /widget/v1/goal-picker/session`),
 * обводка элемента под курсором в СВОЁМ Shadow DOM поверх страницы, клик
 * перехватывается в фазе capture на window (`preventDefault` +
 * `stopImmediatePropagation` — действие сайта НЕ исполняется, §5-тер.16
 * п.6; так же pointer/mouse down/up и submit), поле ввода выбрать нельзя
 * (input/textarea/select/[contenteditable] — подсказка «значения полей не
 * собираются»), выбранный элемент → дескриптор (goal-types.ts A:
 * data-assist-goal / data-assist-id, иначе роль + видимый текст — та же
 * нормализация, что у детектора загрузчика, shared/dom.ts) →
 * `POST /widget/v1/goal-picker/pick`; карточку «считать целью?» и
 * сохранение показывает TMA (опрос GoalPickerStatusView, A).
 * Те же запреты, что у загрузчика: без HTML-приёмников и eval (линт), в
 * DOM — только createElement/textContent. Токен и сессия — только в памяти.
 */
import { WIDGET_GOAL_ATTR, WIDGET_GOAL_SUBMIT_ATTR } from '../shared/brand';
import { roleOf, textOf } from '../shared/dom';

type Lang = 'uk' | 'ru' | 'en';
const T: Record<
  Lang,
  Record<'start' | 'input' | 'saved' | 'fail' | 'exit', string>
> = {
  uk: {
    start:
      'Режим вибору цілі: клікніть кнопку чи посилання, яке вважати ціллю.',
    input: 'Поле введення вибрати не можна — значення полів не збираються.',
    saved: 'Вибрано: «{x}». Поверніться в Telegram, щоб підтвердити.',
    fail: 'Посилання вибору недійсне або вже використане — візьміть нове в Telegram.',
    exit: 'Вийти',
  },
  ru: {
    start:
      'Режим выбора цели: кликните кнопку или ссылку, которую считать целью.',
    input: 'Поле ввода выбрать нельзя — значения полей не собираются.',
    saved: 'Выбрано: «{x}». Вернитесь в Telegram, чтобы подтвердить.',
    fail: 'Ссылка выбора недействительна или уже использована — возьмите новую в Telegram.',
    exit: 'Выйти',
  },
  en: {
    start: 'Goal picker: click the button or link that counts as a goal.',
    input: 'Input fields cannot be picked — field values are never collected.',
    saved: 'Picked: “{x}”. Return to Telegram to confirm.',
    fail: 'This picker link is invalid or already used — get a new one in Telegram.',
    exit: 'Exit',
  },
};

const CSS = `:host{all:initial}*{box-sizing:border-box}
.o{position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #e8590c;border-radius:4px;background:rgba(232,89,12,.08);display:none}
.b{position:fixed;z-index:2147483647;left:50%;top:12px;transform:translateX(-50%);max-width:min(560px,calc(100vw - 24px));display:flex;gap:10px;align-items:center;padding:10px 14px;border-radius:10px;background:#111;color:#fff;font:14px/1.4 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.3)}
.b button{all:unset;cursor:pointer;padding:4px 10px;border-radius:6px;background:#e8590c;color:#fff;white-space:nowrap}`;

const INPUTS =
  'input:not([type=submit]):not([type=button]),textarea,select,option,[contenteditable],[contenteditable] *';
const TARGETS =
  'a[href],button,[role=button],[role=link],input[type=submit],input[type=button],[' +
  WIDGET_GOAL_ATTR +
  '],[data-assist-id]';
/** capture и НЕ passive: иначе preventDefault у click/submit не сработал бы (касания — см. block). */
const OPT = { capture: true, passive: false };
const BLOCKED = [
  'click',
  'dblclick',
  'auxclick',
  'mousedown',
  'mouseup',
  'pointerdown',
  'pointerup',
  'touchstart',
  'touchend',
  'submit',
];

function lang(): Lang {
  const l = (document.documentElement.lang || navigator.language || '')
    .slice(0, 2)
    .toLowerCase();
  return l === 'uk' || l === 'ru' ? l : 'en';
}

function attr(el: Element | null, name: string): string | null {
  const v = el && el.getAttribute(name);
  return v && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null;
}

/** Дескриптор (A, ElementDescriptor) и вид цели для выбранного элемента. */
function describe(target: Element): {
  kind: 'click' | 'form_submit';
  descriptor: {
    assistGoal: string | null;
    assistId: string | null;
    role: string | null;
    text: string | null;
    tag: string | null;
  };
  label: string;
} | null {
  if (target.closest(INPUTS)) return null;
  const el = target.closest(TARGETS) || target;
  const form = el.closest('form');
  const t = el.tagName;
  const submit =
    !!form &&
    ((t === 'BUTTON' && (el as HTMLButtonElement).type === 'submit') ||
      (t === 'INPUT' && (el as HTMLInputElement).type === 'submit'));
  const text = textOf(el) || null;
  if (submit && form) {
    return {
      kind: 'form_submit',
      descriptor: {
        assistGoal: attr(form, WIDGET_GOAL_SUBMIT_ATTR),
        assistId: attr(form, 'data-assist-id'),
        role: 'form',
        text,
        tag: 'form',
      },
      label: text || 'form',
    };
  }
  const role = roleOf(el);
  const tag = t.toLowerCase();
  const d = {
    assistGoal: attr(
      el.closest('[' + WIDGET_GOAL_ATTR + ']'),
      WIDGET_GOAL_ATTR
    ),
    assistId: attr(el.closest('[data-assist-id]'), 'data-assist-id'),
    role: /^[a-z]{1,20}$/.test(role) ? role : null,
    text,
    tag: /^[a-z][a-z0-9-]{0,20}$/.test(tag) ? tag : null,
  };
  if (!d.assistGoal && !d.assistId && !d.text) return null;
  return {
    kind: 'click',
    descriptor: d,
    label: text || d.assistGoal || d.assistId || tag,
  };
}

function start() {
  const script = document.currentScript as HTMLScriptElement | null;
  const pk = script && script.getAttribute('data-pk');
  const token = script && script.getAttribute('data-token');
  if (!script || !pk || !token) return;
  let origin = '';
  try {
    origin = new URL(script.src).origin;
  } catch {
    return;
  }
  const L = T[lang()];
  const host = document.createElement('div');
  host.setAttribute('data-v4c-picker', '');
  const sr = host.attachShadow({ mode: 'closed' });
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    sr.adoptedStyleSheets = [sheet];
  } catch {
    const st = document.createElement('style');
    st.textContent = CSS;
    sr.appendChild(st);
  }
  const box = document.createElement('div');
  box.className = 'o';
  const bar = document.createElement('div');
  bar.className = 'b';
  bar.setAttribute('role', 'status');
  const msg = document.createElement('span');
  msg.textContent = L.start;
  const exit = document.createElement('button');
  exit.type = 'button';
  exit.textContent = L.exit;
  bar.appendChild(msg);
  bar.appendChild(exit);
  sr.appendChild(box);
  sr.appendChild(bar);
  (document.body || document.documentElement).appendChild(host);

  let session: string | null = null;
  let busy = false;
  const ours = (e: Event) => e.composedPath().indexOf(host) >= 0;
  const say = (s: string) => (msg.textContent = s);

  const post = (path: string, body: unknown) =>
    fetch(origin + path, {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  post('/widget/v1/goal-picker/session', { pk, token })
    .then((r) => (r.ok ? r.json() : null))
    .then((b) => {
      const s = b && b.success && b.data && b.data.pickerSession;
      if (typeof s === 'string') session = s;
      else say(L.fail);
    })
    .catch(() => say(L.fail));

  const onMove = (e: Event) => {
    const t = e.target;
    if (ours(e) || !(t instanceof Element)) return;
    const el = t.closest(TARGETS) || t;
    const r = el.getBoundingClientRect();
    const s = box.style;
    s.setProperty('display', 'block');
    s.setProperty('left', r.left - 2 + 'px');
    s.setProperty('top', r.top - 2 + 'px');
    s.setProperty('width', r.width + 4 + 'px');
    s.setProperty('height', r.height + 4 + 'px');
  };

  const block = (e: Event) => {
    if (ours(e)) return;
    // Действие сайта не исполняется, пока идёт выбор (§5-тер.16 п.6).
    e.stopImmediatePropagation();
    // Касание — только скрыть от сайта: preventDefault на touchstart/touchend
    // глушит синтетический click (на телефоне не выбрать ничего) и прокрутку,
    // а ссылку из Telegram владелец открывает именно в браузере телефона.
    if (e.type.slice(0, 5) === 'touch') return;
    e.preventDefault();
    if (e.type !== 'click') return;
    const t = e.target;
    if (!(t instanceof Element)) return;
    const d = describe(t);
    if (!d) return say(L.input);
    if (!session || busy) return session ? undefined : say(L.fail);
    busy = true;
    post('/widget/v1/goal-picker/pick', {
      pickerSession: session,
      kind: d.kind,
      descriptor: d.descriptor,
      path: location.pathname.slice(0, 512),
      label: d.label.slice(0, 80),
    })
      .then((r) => say(r.ok ? L.saved.replace('{x}', d.label) : L.fail))
      .catch(() => say(L.fail))
      .then(() => (busy = false));
  };

  const stop = () => {
    window.removeEventListener('mouseover', onMove, true);
    for (const t of BLOCKED) window.removeEventListener(t, block, OPT);
    window.removeEventListener('keydown', onKey, true);
    host.remove();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') stop();
  };
  exit.addEventListener('click', stop);
  window.addEventListener('mouseover', onMove, true);
  for (const t of BLOCKED) window.addEventListener(t, block, OPT);
  window.addEventListener('keydown', onKey, true);
}

start();
