/**
 * Снимок интерактивных элементов страницы (Э6-бис (а), ТЗ §5-бис.3 п.2,
 * аудит 1.2) — в origin заказчика, ленивый чанк `act.js`.
 *
 *  - роль, видимый текст (≤ 80), `data-assist-id`, тип поля, видимость,
 *    состояние (disabled, checked), ближайший заголовок; БЕЗ значений полей
 *    (кроме выбранной опции списка);
 *  - подписи — тоже ПД: e-mail, телефоны, ключи, длинные цифры маскируются
 *    ЗДЕСЬ, до отправки (порт `maskSensitiveEcho`, `shared/ui-plan.ts`);
 *  - не попадают вовсе: поля пароля/карты/кода/файла/скрытые, всё внутри
 *    `data-assist="never"`, зон из denylist кабинета, вне разрешённых зон,
 *    пользовательский контент (отзывы, комментарии — признак `ugc`), наш
 *    собственный корень (кнопка, окно, подсветка — иначе модель «нажмёт» наш
 *    «Стоп»), содержимое iframe (не обходятся вовсе);
 *  - открытые shadow-корни обходятся рекурсивно, закрытые недоступны;
 *  - `needsUserGesture` (`gesture`): новая вкладка, файл, скачивание,
 *    копирование — заранее, чтобы такие шаги не исполнялись;
 *  - не больше 150 элементов: видимая область первой, затем ближайшие.
 * Только чтение DOM: ни одного HTML-приёмника, ни одного события.
 */
import {
  ASSIST_ID,
  UI_ROLES,
  maskLabel,
  type SnapElement,
  type Snapshot,
  type UiGesture,
  type UiRole,
} from '../shared/ui-plan';

export const SNAP_MAX = 150;
const TEXT_MAX = 80;

export const INTERACTIVE =
  'a[href],button,input,select,textarea,summary,label[for],[role],[data-assist-id],[onclick]';
/** Пользовательский контент: отзывы, комментарии, вопросы покупателей (§5-бис.6 п.8). */
const UGC =
  '[data-ugc],[data-assist-ugc],[itemprop="review"],.review,.reviews,.comment,.comments,#reviews,#comments,.woocommerce-Reviews,.product-reviews';
/** Свои корни: загрузчик, подсветка, панель исполнения. */
const OWN = '[data-v4c],[data-v4c-highlight],[data-v4c-act]';
/**
 * Э6-тер (и): `data-assist-undo` — только обратная стандартная разметка
 * (`STANDARD_UNDO_PAIRS` сервера, сверка — scripts/ui-plan.test.ts);
 * `data-assist-undo-at` — путь своего origin: `/`, не `//host`, только
 * буквы/цифры латиницы и `_-.~%/` (без `*`, `\`, query и фрагмента), ≤ 200;
 * сервер проверяет ещё раз (`compAtOk`).
 */
export const UNDO_KIND = /^remove-from-(cart|wishlist|compare)$/;
export const UNDO_AT = /^\/(?!\/)[\w\-.~%/]{0,199}$/;
/** name, given-/family-/additional-name, nickname, email, tel(-national), адрес… */
const PD_AUTOCOMPLETE =
  /^(((given|family|additional)-|nick)?name|email|tel(-national)?|street-address|address-(line|level)\d|postal-code|country(-name)?|bday|organization)$/;
const SENSITIVE_AUTOCOMPLETE =
  /(^|\s)(cc-[a-z-]+|one-time-code|current-password|new-password)(\s|$)/;
const PD_NAME =
  /(^|[_\-.[\s])(name|first.?name|last.?name|surname|phone|tel|email|e-mail|mail|address|addr|city|zip|postal|прізвище|имя|телефон)([_\-.\]\s]|$)/i;

const clean = (s: string | null | undefined, max = TEXT_MAX): string => {
  const t = maskLabel(
    (s || '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
};

/** Сверка подписей: NFKC, нижний регистр, пробелы (и исполнитель — exec.ts). */
export const norm = (s: string) =>
  s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/** closest() сквозь границы открытых shadow-корней. */
export function closestDeep(el: Element, sel: string): Element | null {
  let cur: Element | null = el;
  while (cur) {
    let hit: Element | null = null;
    try {
      hit = cur.closest(sel);
    } catch {
      return null;
    }
    if (hit) return hit;
    const root = cur.getRootNode() as ShadowRoot | Document;
    cur = (root as ShadowRoot).host || null;
  }
  return null;
}

/** Все элементы под корнем, включая открытые shadow-корни (рекурсивно). */
export function deepQuery(root: Document | ShadowRoot, sel: string): Element[] {
  const out: Element[] = [];
  const walk = (r: Document | ShadowRoot) => {
    try {
      r.querySelectorAll(sel).forEach((e) => out.push(e));
    } catch {
      return;
    }
    r.querySelectorAll('*').forEach((e) => {
      const sr = (e as HTMLElement).shadowRoot;
      if (sr) walk(sr);
    });
  };
  walk(root);
  return out;
}

export function visible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0)) return false;
  const cs = getComputedStyle(el);
  if (cs.visibility === 'hidden' || cs.display === 'none') return false;
  // Прозрачный (сам или предок): человек его не видит — модель не увидит тоже.
  for (let p: Element | null = el; p; p = p.parentElement)
    if (getComputedStyle(p).opacity === '0') return false;
  return !closestDeep(el, '[aria-hidden="true"],[hidden],[inert]');
}

function inView(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return (
    r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth
  );
}

function roleOf(el: Element): UiRole | null {
  const explicit = (el.getAttribute('role') || '').trim().split(/\s+/)[0];
  if ((UI_ROLES as readonly string[]).indexOf(explicit) >= 0)
    return explicit as UiRole;
  if (explicit && explicit !== 'presentation' && explicit !== 'none')
    return null;
  const tag = el.tagName;
  // Подпись-кнопка поля выбора файла: в снимке — с пометкой жеста «файл».
  if (tag === 'LABEL') {
    const c = (el as HTMLLabelElement).control as HTMLInputElement | null;
    return c && c.type === 'file' ? 'button' : null;
  }
  if (tag === 'A') return el.hasAttribute('href') ? 'link' : null;
  if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
  if (tag === 'SELECT') return 'combobox';
  if (tag === 'TEXTAREA') return 'textbox';
  if (tag === 'INPUT') {
    const t = (el as HTMLInputElement).type;
    return t === 'checkbox' || t === 'radio'
      ? t
      : t === 'search'
        ? 'searchbox'
        : /^(button|submit|reset|image)$/.test(t)
          ? 'button'
          : 'textbox';
  }
  // `data-assist-id`/`onclick` на div — кнопка по смыслу.
  return el.hasAttribute('data-assist-id') || el.hasAttribute('onclick')
    ? 'button'
    : null;
}

/** Видимый текст: то, что видит человек (подпись поля — её label/placeholder). */
export function visibleText(el: Element): string {
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
    const f = el as HTMLInputElement;
    if (tag === 'INPUT' && /^(submit|button|reset)$/.test(f.type))
      return clean(f.value);
    const lab = f.labels?.[0];
    return clean(
      (lab && (lab as HTMLElement).innerText) || f.placeholder || ''
    );
  }
  // Аудит 06.10: поле не-INPUT (contenteditable, role=textbox/searchbox/
  // combobox) — его innerText это ВВОД человека (ПД): только подпись.
  if (
    (el as HTMLElement).isContentEditable ||
    /^(textbox|searchbox|combobox)$/.test(roleOf(el) || '')
  )
    return clean(
      el.getAttribute('aria-label') || el.getAttribute('placeholder') || ''
    );
  const t = clean((el as HTMLElement).innerText || '');
  if (t) return t;
  const img = el.querySelector('img[alt]');
  return img ? clean(img.getAttribute('alt')) : '';
}

/** Доступное имя (aria-label/labelledby/title) — если расходится с видимым. */
export function hiddenLabel(el: Element, text: string): string | null {
  let name = el.getAttribute('aria-label') || '';
  const by = el.getAttribute('aria-labelledby');
  if (!name && by) {
    const root = el.getRootNode() as Document | ShadowRoot;
    name = by
      .split(/\s+/)
      .map((id) => {
        const n = root.getElementById(id);
        return n ? n.textContent || '' : '';
      })
      .join(' ');
  }
  if (!name) name = el.getAttribute('title') || '';
  const c = clean(name);
  return c && norm(c) !== norm(text) ? c : null;
}

function gestureOf(el: Element, text: string): UiGesture | null {
  const a = el.closest('a');
  if (a) {
    const tg = (a.getAttribute('target') || '').toLowerCase();
    if (tg && !/^_(self|parent|top)$/.test(tg)) return 'new_tab';
    if (a.hasAttribute('download')) return 'download';
  }
  const lab = el.closest('label');
  const ctl = lab && (lab as HTMLLabelElement).control;
  if (ctl && (ctl as HTMLInputElement).type === 'file') return 'file';
  if (
    el.hasAttribute('data-clipboard-text') ||
    el.hasAttribute('data-clipboard-target') ||
    /(?:^|[^\p{L}])(скопі|скопир|копіюв|копиров|copy)/iu.test(text)
  )
    return 'copy';
  return null;
}

/**
 * Поле, которого в снимке не бывает: пароль, карта, код, файл, скрытое;
 * список с autocomplete `cc-*` (срок/тип карты) — тоже.
 */
export function sensitiveField(el: Element): boolean {
  if (!/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return false;
  const t = (el as HTMLInputElement).type;
  if (/^(password|file|hidden)$/.test(t)) return true;
  return SENSITIVE_AUTOCOMPLETE.test(
    (el.getAttribute('autocomplete') || '').toLowerCase()
  );
}

function heading(el: Element): string | null {
  let cur: Element | null = el.parentElement;
  for (let k = 0; cur && k < 5; k++, cur = cur.parentElement) {
    const h = cur.querySelector('h1,h2,h3,h4,legend');
    if (h && !h.contains(el)) {
      const t = clean((h as HTMLElement).innerText || h.textContent || '');
      if (t) return t;
    }
  }
  return null;
}

/** Адрес ссылки без query и фрагмента (в query бывают ПД). */
export function cleanHref(el: Element): string | null {
  const a = el.closest('a[href]') as HTMLAnchorElement | null;
  if (!a) return null;
  try {
    const u = new URL(a.href); // `href` — уже абсолютный (разобран браузером)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin + u.pathname;
  } catch {
    return null;
  }
}

/** Элемент — кандидат снимка/цели (не наш, не под запретом, не ПД-поле). */
export function excluded(
  el: Element,
  deny: string[],
  allow: string[]
): boolean {
  if (closestDeep(el, OWN)) return true;
  if (closestDeep(el, '[data-assist="never"]')) return true;
  if (closestDeep(el, UGC)) return true;
  if (sensitiveField(el)) return true;
  for (const d of deny) if (closestDeep(el, d)) return true;
  if (allow.length && !allow.some((a) => closestDeep(el, a))) return true;
  return false;
}

export interface Facts extends Omit<SnapElement, 'ref'> {
  el: Element;
}

/** Факты о живом элементе (и для снимка, и для проверки цели перед действием). */
export function factsOf(el: Element): Facts | null {
  const role = roleOf(el);
  if (!role) return null;
  const tag = el.tagName.toLowerCase();
  const t = (
    /^(a|button|input|select|textarea)$/.test(tag) ? tag : 'other'
  ) as SnapElement['tag'];
  const text = visibleText(el);
  const hidden = hiddenLabel(el, text);
  const assistId = el.getAttribute('data-assist-id');
  const f = el as unknown as {
    form?: HTMLFormElement | null;
    type?: string;
    disabled?: boolean;
  };
  const form =
    (f.form as HTMLFormElement | null | undefined) || el.closest('form');
  const inputType = tag === 'input' ? (f.type || 'text').toLowerCase() : null;
  const isSubmit =
    !!form &&
    ((tag === 'button' && (f.type || 'submit') === 'submit') ||
      (tag === 'input' && (inputType === 'submit' || inputType === 'image')));
  const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
  const pd =
    (tag === 'input' || tag === 'textarea') &&
    (PD_AUTOCOMPLETE.test(ac) ||
      inputType === 'email' ||
      inputType === 'tel' ||
      PD_NAME.test(el.getAttribute('name') || '') ||
      PD_NAME.test(el.id || ''));
  const options: string[] = [];
  let selected: string | null = null;
  if (tag === 'select') {
    const opts = (el as HTMLSelectElement).options;
    for (let i = 0; i < opts.length && options.length < 12; i++)
      options.push(clean(opts[i].text));
    const so = (el as HTMLSelectElement).selectedOptions;
    selected = so?.[0] ? clean(so[0].text) : null;
  }
  const checkable = inputType === 'checkbox' || inputType === 'radio';
  return {
    el,
    role,
    tag: t,
    text,
    hiddenLabel: hidden,
    assistId: assistId && ASSIST_ID.test(assistId) ? assistId : null,
    inputType,
    href: cleanHref(el),
    disabled: !!f.disabled || el.getAttribute('aria-disabled') === 'true',
    checked: checkable
      ? !!(el as HTMLInputElement).checked
      : el.hasAttribute('aria-checked')
        ? el.getAttribute('aria-checked') === 'true'
        : null,
    selected,
    options,
    heading: heading(el),
    submit: isSubmit,
    inForm: !!form,
    confirmZone: !!closestDeep(el, '[data-assist="confirm"]'),
    pd,
    toggle:
      el.hasAttribute('aria-expanded') || role === 'tab' || tag === 'summary',
    gesture: gestureOf(el, text),
    inView: inView(el),
  };
}

/** Снимок страницы и карта ref → элемент (для исполнителя на этой странице). */
export function takeSnapshot(
  deny: string[],
  allow: string[]
): { snapshot: Snapshot; refs: Map<string, Element> } {
  const seen = new Set<Element>();
  const facts: Facts[] = [];
  for (const el of deepQuery(document, INTERACTIVE)) {
    if (seen.has(el)) continue;
    seen.add(el);
    // Вложенный интерактив (кнопка внутри ссылки) — берём внешний.
    if (el.parentElement && el.parentElement.closest('a[href],button'))
      continue;
    if (excluded(el, deny, allow) || !visible(el)) continue;
    const f = factsOf(el);
    if (!f) continue;
    if (!f.text && !f.hiddenLabel && !f.assistId) continue;
    facts.push(f);
  }
  // Видимая область — первой, дальше — ближайшие к ней.
  const dist = (f: Facts) => {
    const r = f.el.getBoundingClientRect();
    return f.inView ? 0 : r.top > innerHeight ? r.top - innerHeight : -r.bottom;
  };
  const picked = facts
    .map((f, i) => ({ f, i, d: dist(f) }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .slice(0, SNAP_MAX)
    .sort((a, b) => a.i - b.i);
  const refs = new Map<string, Element>();
  const elements: SnapElement[] = picked.map(({ f }, k) => {
    const ref = `e${k + 1}`;
    const { el, ...rest } = f;
    refs.set(ref, el);
    // Э6-тер (и): объявленная пара разметки владельца — вид из закрытого
    // списка и (если есть) путь страницы отмены своего origin; иначе — нет.
    const u = el.getAttribute('data-assist-undo');
    const at = el.getAttribute('data-assist-undo-at');
    return {
      ref,
      ...rest,
      ...(u && UNDO_KIND.test(u) && UNDO_AT.test(at ?? '/')
        ? { undo: u, undoAt: at }
        : {}),
    };
  });
  return {
    snapshot: {
      url: location.origin + location.pathname,
      title: clean(document.title, 200),
      elements,
    },
    refs,
  };
}
