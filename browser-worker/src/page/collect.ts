/**
 * Сбор на странице (исполняется В БРАУЗЕРЕ через `page.evaluate`) — порт
 * снимка загрузчика (`widget/src/act/snapshot.ts`, ТЗ §5-бис.3 п.2) для
 * воркера Ш3. Функции САМОДОСТАТОЧНЫ: Playwright сериализует их текст,
 * замыканий на модуль нет.
 *
 *  - снимок интерактивных элементов: роль, видимый текст (≤ 80, маска ПД),
 *    `data-assist-id`, тип поля, состояние, ближайший заголовок, рамка в
 *    координатах видимой области; БЕЗ значений полей (кроме выбранной опции
 *    списка); поля пароля/карты/кода/файла/скрытые, `data-assist="never"`,
 *    пользовательский контент (отзывы, комментарии) — не попадают;
 *  - элементы в форме общей карты Ш4 (`tag/label/role/assistId/selector`);
 *  - «знания об интерфейсе» для обхода «Админки»: заголовки, подписи меню,
 *    кнопок и полей, шапки таблиц — НЕ содержимое ячеек и списков данных;
 *  - ссылки своего хоста для обхода (адрес без фрагмента) с видимым текстом.
 * Только чтение DOM: ни одного события, ни одного изменения страницы.
 */

export interface CollectedElement {
  ref: string;
  role: string;
  tag: string;
  text: string;
  hiddenLabel: string | null;
  assistId: string | null;
  inputType: string | null;
  href: string | null;
  disabled: boolean;
  checked: boolean | null;
  selected: string | null;
  options: string[];
  heading: string | null;
  submit: boolean;
  inForm: boolean;
  confirmZone: boolean;
  pd: boolean;
  toggle: boolean;
  gesture: string | null;
  inView: boolean;
  box: { x: number; y: number; w: number; h: number } | null;
}

export interface CollectedMapElement {
  tag: string;
  label: string;
  role: string | null;
  assistId: string | null;
  selector: string | null;
}

export interface Collected {
  url: string;
  title: string;
  elements: CollectedElement[];
  mapElements: CollectedMapElement[];
  viewport: { width: number; height: number };
  scrollHeight: number;
}

/** Снимок страницы (исполняется в браузере). */
export function collectSnapshot(limits: {
  elements: number;
  mapElements: number;
  text: number;
}): Collected {
  const EMAIL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const PHONE = /(?:\+?\d[\s().-]?){7,}\d/g;
  const TOKEN = /\b(sk-[A-Za-z0-9]{10,}|AIza[A-Za-z0-9_-]{10,})\b/g;
  const LONG_DIGITS = /\d(?:[\s-]?\d){8,}/g;
  const mask = (s: string) =>
    s
      .replace(EMAIL, '[e-mail]')
      .replace(TOKEN, '[ключ]')
      .replace(PHONE, '[тел.]')
      .replace(LONG_DIGITS, '[№]');
  const clean = (s: string | null | undefined, max = limits.text): string => {
    const t = mask(
      (s || '')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    );
    return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
  };
  const norm = (s: string) =>
    s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  const ROLES = [
    'button',
    'link',
    'textbox',
    'searchbox',
    'combobox',
    'checkbox',
    'radio',
    'tab',
    'menuitem',
    'switch',
  ];
  const INTERACTIVE =
    'a[href],button,input,select,textarea,summary,label[for],[role],[data-assist-id],[onclick]';
  const UGC =
    '[data-ugc],[data-assist-ugc],[itemprop="review"],.review,.reviews,.comment,.comments,#reviews,#comments,.woocommerce-Reviews,.product-reviews';
  const PD_AUTOCOMPLETE =
    /^(name|given-name|family-name|additional-name|nickname|email|tel|tel-national|street-address|address-line\d|address-level\d|postal-code|country|country-name|bday|organization)$/;
  const SENSITIVE_AUTOCOMPLETE =
    /(^|\s)(cc-[a-z-]+|one-time-code|current-password|new-password)(\s|$)/;
  const PD_NAME =
    /(^|[_\-.[\s])(name|first.?name|last.?name|surname|phone|tel|email|e-mail|mail|address|addr|city|zip|postal|прізвище|имя|телефон)([_\-.\]\s]|$)/i;

  const closestDeep = (el: Element, sel: string): Element | null => {
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
  };
  const deepQuery = (root: Document | ShadowRoot, sel: string): Element[] => {
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
  };
  const visible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    for (let p: Element | null = el; p; p = p.parentElement)
      if (getComputedStyle(p).opacity === '0') return false;
    return !closestDeep(el, '[aria-hidden="true"],[hidden],[inert]');
  };
  const inView = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    return (
      r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth
    );
  };
  const roleOf = (el: Element): string | null => {
    const explicit = (el.getAttribute('role') || '').trim().split(/\s+/)[0];
    if (ROLES.indexOf(explicit) >= 0) return explicit;
    if (explicit && explicit !== 'presentation' && explicit !== 'none')
      return null;
    const tag = el.tagName;
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
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'search') return 'searchbox';
      if (t === 'button' || t === 'submit' || t === 'reset' || t === 'image')
        return 'button';
      return 'textbox';
    }
    return el.hasAttribute('data-assist-id') || el.hasAttribute('onclick')
      ? 'button'
      : null;
  };
  const visibleText = (el: Element): string => {
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
      const f = el as HTMLInputElement;
      if (tag === 'INPUT' && /^(submit|button|reset)$/.test(f.type))
        return clean(f.value);
      const lab = f.labels && f.labels[0];
      return clean(
        (lab && (lab as HTMLElement).innerText) || f.placeholder || '',
      );
    }
    const t = clean((el as HTMLElement).innerText || '');
    if (t) return t;
    const img = el.querySelector('img[alt]');
    return img ? clean(img.getAttribute('alt')) : '';
  };
  const hiddenLabel = (el: Element, text: string): string | null => {
    let name = el.getAttribute('aria-label') || '';
    const by = el.getAttribute('aria-labelledby');
    if (!name && by) {
      name = by
        .split(/\s+/)
        .map((id) => {
          const n = document.getElementById(id);
          return n ? n.textContent || '' : '';
        })
        .join(' ');
    }
    if (!name) name = el.getAttribute('title') || '';
    const c = clean(name);
    return c && norm(c) !== norm(text) ? c : null;
  };
  const gestureOf = (el: Element, text: string): string | null => {
    const a = el.closest('a');
    if (a) {
      const tg = (a.getAttribute('target') || '').toLowerCase();
      if (tg && tg !== '_self' && tg !== '_parent' && tg !== '_top')
        return 'new_tab';
      if (a.hasAttribute('download')) return 'download';
    }
    const lab = el.closest('label');
    const ctl = lab && (lab as HTMLLabelElement).control;
    if (ctl && (ctl as HTMLInputElement).type === 'file') return 'file';
    if (
      el.hasAttribute('data-clipboard-text') ||
      el.hasAttribute('data-clipboard-target') ||
      /(?<!\p{L})(скопі|скопир|копіюв|копиров|copy)/iu.test(text)
    )
      return 'copy';
    return null;
  };
  const sensitiveField = (el: Element): boolean => {
    if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return false;
    const t = (el as HTMLInputElement).type;
    if (t === 'password' || t === 'file' || t === 'hidden') return true;
    return SENSITIVE_AUTOCOMPLETE.test(
      (el.getAttribute('autocomplete') || '').toLowerCase(),
    );
  };
  const heading = (el: Element): string | null => {
    let cur: Element | null = el.parentElement;
    for (let k = 0; cur && k < 5; k++, cur = cur.parentElement) {
      const h = cur.querySelector('h1,h2,h3,h4,legend');
      if (h && h !== el && !h.contains(el)) {
        const t = clean((h as HTMLElement).innerText || h.textContent || '');
        if (t) return t;
      }
    }
    return null;
  };
  const hrefOf = (el: Element): string | null => {
    const a = el.closest('a[href]') as HTMLAnchorElement | null;
    if (!a) return null;
    try {
      const u = new URL(a.href, location.href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      const out = u.origin + u.pathname;
      return out.length <= 300 ? out : null;
    } catch {
      return null;
    }
  };
  const generatedId = (id: string) =>
    /\d{3,}|[a-f0-9]{8,}|^(ember|react|radix|mui|headlessui|:r)/i.test(id);
  const cssEscape = (s: string) =>
    window.CSS && CSS.escape ? CSS.escape(s) : s;
  const uniq = (sel: string): boolean => {
    try {
      return document.querySelectorAll(sel).length === 1;
    } catch {
      return false;
    }
  };

  const picked: Array<{
    el: Element;
    e: Omit<CollectedElement, 'ref'>;
    i: number;
    d: number;
  }> = [];
  const seen = new Set<Element>();
  let idx = 0;
  for (const el of deepQuery(document, INTERACTIVE)) {
    if (seen.has(el)) continue;
    seen.add(el);
    if (el.parentElement && el.parentElement.closest('a[href],button'))
      continue;
    if (
      closestDeep(el, '[data-assist="never"]') ||
      closestDeep(el, UGC) ||
      sensitiveField(el)
    )
      continue;
    if (!visible(el)) continue;
    const role = roleOf(el);
    if (!role) continue;
    const tagName = el.tagName.toLowerCase();
    const tag = ['a', 'button', 'input', 'select', 'textarea'].includes(tagName)
      ? tagName
      : 'other';
    const text = visibleText(el);
    const hidden = hiddenLabel(el, text);
    const aid = el.getAttribute('data-assist-id');
    const assistId =
      aid && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(aid) ? aid : null;
    if (!text && !hidden && !assistId) continue;
    const f = el as unknown as {
      form?: HTMLFormElement | null;
      type?: string;
      disabled?: boolean;
    };
    const form = f.form || el.closest('form');
    const inputType =
      tagName === 'input' ? (f.type || 'text').toLowerCase() : null;
    const submit =
      !!form &&
      ((tagName === 'button' && (f.type || 'submit') === 'submit') ||
        (tagName === 'input' &&
          (inputType === 'submit' || inputType === 'image')));
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    const pd =
      (tagName === 'input' || tagName === 'textarea') &&
      (PD_AUTOCOMPLETE.test(ac) ||
        inputType === 'email' ||
        inputType === 'tel' ||
        PD_NAME.test(el.getAttribute('name') || '') ||
        PD_NAME.test(el.id || ''));
    const options: string[] = [];
    let selected: string | null = null;
    if (tagName === 'select') {
      const opts = (el as HTMLSelectElement).options;
      for (let i = 0; i < opts.length && options.length < 12; i++)
        options.push(clean(opts[i].text));
      const so = (el as HTMLSelectElement).selectedOptions;
      selected = so && so[0] ? clean(so[0].text) : null;
    }
    const checkable = inputType === 'checkbox' || inputType === 'radio';
    const r = el.getBoundingClientRect();
    const iv = inView(el);
    picked.push({
      el,
      i: idx++,
      d: iv ? 0 : r.top > innerHeight ? r.top - innerHeight : -r.bottom,
      e: {
        role,
        tag,
        text,
        hiddenLabel: hidden,
        assistId,
        inputType,
        href: role === 'link' || tag === 'a' ? hrefOf(el) : null,
        disabled: !!f.disabled || el.getAttribute('aria-disabled') === 'true',
        checked: checkable
          ? !!(el as HTMLInputElement).checked
          : el.hasAttribute('aria-checked')
            ? el.getAttribute('aria-checked') === 'true'
            : null,
        selected,
        options,
        heading: heading(el),
        submit,
        inForm: !!form,
        confirmZone: !!closestDeep(el, '[data-assist="confirm"]'),
        pd,
        toggle:
          el.hasAttribute('aria-expanded') ||
          role === 'tab' ||
          tagName === 'summary',
        gesture: gestureOf(el, text),
        inView: iv,
        box: {
          x: Math.round(r.left),
          y: Math.round(r.top),
          w: Math.round(r.width),
          h: Math.round(r.height),
        },
      },
    });
  }
  const chosen = picked
    .slice()
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .slice(0, limits.elements)
    .sort((a, b) => a.i - b.i);
  const elements: CollectedElement[] = chosen.map((p, k) => ({
    ref: `e${k + 1}`,
    ...p.e,
  }));

  const mapElements: CollectedMapElement[] = [];
  for (const p of chosen) {
    if (mapElements.length >= limits.mapElements) break;
    if (p.e.tag === 'other') continue;
    const label = p.e.text || p.e.hiddenLabel || '';
    if (!label) continue;
    let selector: string | null = null;
    const id = p.el.id;
    const testId = p.el.getAttribute('data-testid');
    if (
      id &&
      /^[A-Za-z][A-Za-z0-9_-]{0,62}$/.test(id) &&
      !generatedId(id) &&
      uniq(`#${cssEscape(id)}`)
    ) {
      selector = `#${id}`;
    } else if (testId && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(testId)) {
      const s = `${p.e.tag}[data-testid="${testId}"]`;
      if (uniq(s)) selector = s;
    }
    mapElements.push({
      tag: p.e.tag,
      label,
      role: p.e.role,
      assistId: p.e.assistId,
      selector,
    });
  }
  let url = location.href;
  try {
    const u = new URL(url);
    url = u.origin + u.pathname;
  } catch {
    /* как есть */
  }
  return {
    url,
    title: clean(document.title, 200),
    elements,
    mapElements,
    viewport: { width: innerWidth, height: innerHeight },
    scrollHeight: Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0,
    ),
  };
}

/** Число совпадений CSS-селекторов (исполняется в браузере). */
export function countSelectors(selectors: string[]): number[] {
  return selectors.map((s) => {
    try {
      return document.querySelectorAll(s).length;
    } catch {
      return 0;
    }
  });
}

export interface InterfaceText {
  title: string;
  text: string;
  links: Array<{ href: string; text: string }>;
  toggles: Array<{
    idx: number;
    text: string;
    hidden: string | null;
    submit: boolean;
    inForm: boolean;
  }>;
}

/**
 * «Знания об интерфейсе» страницы «Админки» (исполняется в браузере):
 * заголовки, подписи навигации, кнопок, полей, шапки таблиц. Содержимое
 * ячеек таблиц, строк списков данных и пользовательский контент — нет.
 * Плюс ссылки (для обхода) и раскрывашки-кандидаты (меню, вкладки) —
 * решение «нажимать ли» принимает воркер по стоп-листу, не страница.
 */
export function collectInterface(maxChars: number): InterfaceText {
  const EMAIL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const PHONE = /(?:\+?\d[\s().-]?){7,}\d/g;
  const TOKEN = /\b(sk-[A-Za-z0-9]{10,}|AIza[A-Za-z0-9_-]{10,})\b/g;
  const LONG_DIGITS = /\d(?:[\s-]?\d){8,}/g;
  const clean = (s: string | null | undefined): string =>
    (s || '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(EMAIL, '[e-mail]')
      .replace(TOKEN, '[ключ]')
      .replace(PHONE, '[тел.]')
      .replace(LONG_DIGITS, '[№]')
      .slice(0, 80);
  const DATA_ZONE =
    'td,tbody,[role="row"],[role="gridcell"],[role="cell"],[data-assist-ugc],[data-ugc],.comment,.comments,.review,.reviews,[data-assist="never"]';
  const shown = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    const cs = getComputedStyle(el);
    return (
      cs.visibility !== 'hidden' &&
      cs.display !== 'none' &&
      !el.closest('[aria-hidden="true"],[hidden]')
    );
  };
  const lines: string[] = [];
  const seen = new Set<string>();
  const add = (prefix: string, raw: string | null | undefined) => {
    const t = clean(raw);
    if (!t) return;
    const line = `${prefix}${t}`;
    if (seen.has(line)) return;
    seen.add(line);
    lines.push(line);
  };
  const each = (sel: string, fn: (el: Element) => void) =>
    document.querySelectorAll(sel).forEach((el) => {
      if (el.closest(DATA_ZONE) || !shown(el)) return;
      fn(el);
    });
  each('h1,h2,h3,h4,legend,[role="heading"]', (el) =>
    add('# ', (el as HTMLElement).innerText),
  );
  each(
    'nav a,aside a,[role="navigation"] a,[role="menu"] [role="menuitem"],[role="tab"]',
    (el) =>
      add(
        'меню: ',
        (el as HTMLElement).innerText || el.getAttribute('aria-label'),
      ),
  );
  each('th,[role="columnheader"]', (el) =>
    add('колонка: ', (el as HTMLElement).innerText),
  );
  each('label', (el) => add('поле: ', (el as HTMLElement).innerText));
  each('input[placeholder],textarea[placeholder]', (el) => {
    const t = (el as HTMLInputElement).type;
    if (t === 'password' || t === 'hidden') return;
    add('поле: ', el.getAttribute('placeholder'));
  });
  each(
    'button,[role="button"],input[type="submit"],input[type="button"]',
    (el) =>
      add(
        'кнопка: ',
        (el as HTMLElement).innerText ||
          (el as HTMLInputElement).value ||
          el.getAttribute('aria-label'),
      ),
  );
  let text = '';
  for (const l of lines) {
    if (text.length + l.length + 1 > maxChars) break;
    text += (text ? '\n' : '') + l;
  }
  const links: Array<{ href: string; text: string }> = [];
  document.querySelectorAll('a[href]').forEach((a) => {
    if (links.length >= 300) return;
    if (a.closest('td,tbody,[role="row"],[data-assist="never"]') || !shown(a))
      return;
    try {
      const u = new URL((a as HTMLAnchorElement).href, location.href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
      u.hash = '';
      links.push({
        href: u.toString(),
        text: clean(
          (a as HTMLElement).innerText || a.getAttribute('aria-label'),
        ),
      });
    } catch {
      /* пропуск */
    }
  });
  const toggles: InterfaceText['toggles'] = [];
  document
    .querySelectorAll(
      '[aria-expanded="false"],summary,[role="tab"][aria-selected="false"]',
    )
    .forEach((el, idx) => {
      if (toggles.length >= 20) return;
      if (el.closest(DATA_ZONE) || !shown(el)) return;
      const form = (el as HTMLButtonElement).form || el.closest('form');
      toggles.push({
        idx,
        text: clean((el as HTMLElement).innerText),
        hidden:
          clean(el.getAttribute('aria-label') || el.getAttribute('title')) ||
          null,
        submit:
          !!form &&
          el.tagName === 'BUTTON' &&
          ((el as HTMLButtonElement).type || 'submit') === 'submit',
        inForm: !!form,
      });
    });
  return { title: clean(document.title), text, links, toggles };
}
