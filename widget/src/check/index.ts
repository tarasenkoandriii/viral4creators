/**
 * Мастер проверки голосового управления Т-2 — ленивый чанк загрузчика
 * `check.js` (Э6-бис (г), ТЗ помощника §5-бис.13 шаги 1 и 3; бюджет —
 * scripts/size-budget.mjs; загрузчик и act.js не растут). Грузится ТОЛЬКО
 * по команде своего iframe в тестовой сессии владельца (ссылка мастера из
 * кабинета) — у посетителей его нет.
 *
 * Исполняется в origin ЗАКАЗЧИКА, правила загрузчика: никаких
 * HTML-приёмников (createElement/textContent/CSSOM), никаких запросов,
 * кроме динамического импорта своего чанка act.js (проверка «CSP пускает
 * наши чанки»); только сообщения своему iframe. Команды разбираются здесь
 * строго.
 *
 *  - `vt-env` — окружение: нарушения CSP и Trusted Types, связанные с
 *    виджетом (событие `securitypolicyviolation` с момента загрузки чанка),
 *    чанк act.js загрузился. Политику микрофона iframe проверяет сам
 *    (`document.featurePolicy` внутри iframe видит и Permissions-Policy
 *    сайта, и `allow` у iframe);
 *  - `vt-markup` — разметка страницы: интерактивных N, с `data-assist-id` M,
 *    без доступного имени (список с ключами для обводки), закрытые
 *    shadow-корни (оценка: пользовательский элемент без открытого корня и
 *    без детей, но с размером), внешние iframe (оплата, карты), дубликаты
 *    имён, запрещённые (`data-assist="never"` + denylist), список 2 «похоже
 *    на опасное, но не распознано» (иконка-корзина/класс delete/remove,
 *    кнопка без текста в `form[method=post]`);
 *  - `vt-mark` — обвести пункты списков на странице (пустой список — снять).
 */
import type { ActApi, ActHost } from '../act';
import { maskLabel } from '../shared/ui-plan';
import {
  closestDeep,
  deepQuery,
  excluded,
  visible,
  visibleText,
} from '../act/snapshot';

const RID = /^[a-z0-9]{8,32}$/;
const KEY = /^[us][0-9]{1,4}$/;
const LIST_MAX = 50;
const INTERACTIVE =
  'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[onclick],[data-assist-id]';
const DANGER_CLASS =
  /(^|[-_\s])(trash|bin|delete|remove|destroy|erase|del)([-_\s]|$)/i;
const COLOR = '#d97706';

type Item = { key: string; tag: string; selector: string };

function selectorOk(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  return !!s && s.length <= 200 && !/[\u0000-\u001f\u007f<`]/.test(s);
}

/** Короткий CSS-путь для разработчика сайта (≤ 3 уровня). */
function pathOf(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  for (let i = 0; cur && i < 3; i++) {
    const tag = cur.tagName.toLowerCase();
    if (cur.id && /^[A-Za-z][\w-]{0,40}$/.test(cur.id)) {
      parts.unshift(`${tag}#${cur.id}`);
      break;
    }
    const cls = Array.prototype.slice
      .call(cur.classList)
      .filter((c: string) => /^[A-Za-z][\w-]{0,30}$/.test(c))
      .slice(0, 2) as string[];
    let part = tag + (cls.length ? '.' + cls.join('.') : '');
    const p: Element | null = cur.parentElement;
    if (p) {
      const same = Array.prototype.filter.call(
        p.children,
        (c: Element) => c.tagName === cur!.tagName
      );
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
    }
    parts.unshift(part);
    cur = p;
  }
  const s = parts.join(' > ');
  return selectorOk(s) ? s : '';
}

/** Доступное имя: видимый текст, aria-label/labelledby, title, alt, подпись поля. */
function hasName(el: Element): boolean {
  if (visibleText(el).trim()) return true;
  for (const a of ['aria-label', 'title', 'placeholder', 'value', 'alt'])
    if ((el.getAttribute(a) || '').trim()) return true;
  const by = el.getAttribute('aria-labelledby');
  if (by) {
    for (const id of by.split(/\s+/)) {
      const t = document.getElementById(id);
      if (t && (t.textContent || '').trim()) return true;
    }
  }
  const img = el.querySelector('img[alt]');
  if (img && (img.getAttribute('alt') || '').trim()) return true;
  const id = el.id;
  if (id) {
    try {
      const l = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (l && (l.textContent || '').trim()) return true;
    } catch {
      /* без подписи */
    }
  }
  return !!el.closest('label');
}

export function start(host: ActHost): ActApi {
  let csp = 0;
  let tt = 0;
  let marks = new Map<string, Element>();
  let rings: HTMLElement[] = [];
  const self = location.origin;
  const onViolation = (ev: Event) => {
    const e = ev as SecurityPolicyViolationEvent;
    const d = e.effectiveDirective || e.violatedDirective || '';
    if (/trusted-types/.test(d)) return void tt++;
    // Только то, что мешает виджету: наш origin (чанки) — не чужие скрипты сайта.
    const src = `${e.blockedURI || ''} ${e.sourceFile || ''}`;
    if (src.indexOf(new URL(import.meta.url).origin) >= 0) csp++;
  };
  host.N.on(document, 'securitypolicyviolation', onViolation as EventListener);

  const unmark = () => {
    for (const r of rings) r.remove();
    rings = [];
  };

  const mark = (keys: string[]) => {
    unmark();
    for (const k of keys) {
      const el = marks.get(k);
      if (!el || !el.isConnected) continue;
      const r = el.getBoundingClientRect();
      const ring = host.N.el('div');
      ring.setAttribute('data-v4c-highlight', '');
      Object.assign(ring.style, {
        position: 'absolute',
        left: `${r.left + scrollX - 3}px`,
        top: `${r.top + scrollY - 3}px`,
        width: `${r.width + 6}px`,
        height: `${r.height + 6}px`,
        border: `2px dashed ${COLOR}`,
        borderRadius: '6px',
        pointerEvents: 'none',
        zIndex: '2147483646',
      });
      (document.body || document.documentElement).appendChild(ring);
      rings.push(ring);
    }
    const first = rings[0];
    if (first) first.scrollIntoView({ block: 'center' });
  };

  const markup = (deny: string[], allow: string[]) => {
    marks = new Map();
    const all = deepQuery(document, INTERACTIVE).filter(
      (e) => visible(e) && !closestDeep(e, '[data-v4c],[data-v4c-act]')
    );
    const unnamed: Item[] = [];
    const suspicious: Array<Item & { why: string; label: string }> = [];
    const names = new Map<string, number>();
    let withId = 0;
    let denied = 0;
    let n = 0;
    for (const e of all) {
      if (e.hasAttribute('data-assist-id')) withId++;
      if (excluded(e, deny, allow)) {
        denied++;
        continue;
      }
      const tag = e.tagName.toLowerCase();
      const named = hasName(e);
      const label = maskLabel(visibleText(e).trim()).slice(0, 80);
      if (!named && unnamed.length < LIST_MAX) {
        const key = `u${unnamed.length}`;
        marks.set(key, e);
        unnamed.push({ key, tag, selector: pathOf(e) });
      }
      if (label) {
        const k = label.toLowerCase();
        names.set(k, (names.get(k) || 0) + 1);
      }
      // Список 2: похоже на опасное — класс/id/иконка, форма POST без текста.
      const cls = `${e.getAttribute('class') || ''} ${e.id || ''}`;
      const icon = e.querySelector('svg,i,use');
      const iconCls = icon
        ? `${icon.getAttribute('class') || ''} ${icon.getAttribute('href') || icon.getAttribute('xlink:href') || ''}`
        : '';
      let why = '';
      if (DANGER_CLASS.test(iconCls) || (!label && DANGER_CLASS.test(cls)))
        why = 'icon_trash';
      else if (DANGER_CLASS.test(cls)) why = 'class_danger';
      else {
        const f = e.closest('form');
        if (
          !named &&
          f &&
          (f.getAttribute('method') || '').toLowerCase() === 'post' &&
          (tag === 'button' ||
            (tag === 'input' &&
              /^(submit|image)$/i.test(e.getAttribute('type') || '')))
        )
          why = 'post_form_textless';
      }
      if (why && suspicious.length < LIST_MAX) {
        const key = `s${n++}`;
        marks.set(key, e);
        suspicious.push({ key, why, tag, label, selector: pathOf(e) });
      }
    }
    // Закрытые shadow-корни: пользовательский элемент с размером, без открытого
    // корня и без своих детей — содержимое у него есть, а снаружи не видно.
    let closedShadow = 0;
    document.querySelectorAll('*').forEach((e) => {
      if (
        e.tagName.indexOf('-') > 0 &&
        !(e as HTMLElement).shadowRoot &&
        !e.children.length &&
        visible(e)
      )
        closedShadow++;
    });
    let extIframes = 0;
    document.querySelectorAll('iframe[src]').forEach((f) => {
      try {
        const o = new URL(f.getAttribute('src') || '', location.href).origin;
        if (o !== self && !closestDeep(f, '[data-v4c]')) extIframes++;
      } catch {
        /* битый адрес */
      }
    });
    const duplicates: Array<{ name: string; count: number }> = [];
    names.forEach((count, name) => {
      if (count > 1 && duplicates.length < 20) duplicates.push({ name, count });
    });
    return {
      total: all.length,
      withId,
      unnamed,
      closedShadow,
      extIframes,
      duplicates,
      denied,
      suspicious,
    };
  };

  return {
    on(raw) {
      const t = raw.type;
      const rid =
        typeof raw.rid === 'string' && RID.test(raw.rid) ? raw.rid : '';
      if (t === 'vt-env' && rid) {
        // Проверка «CSP пускает наши чанки»: свой act.js тем же путём выпуска.
        import(/* @vite-ignore */ new URL('act.js', import.meta.url).href)
          .then(
            () => true,
            () => false
          )
          .then((chunks) =>
            host.post({
              type: 'vt-result',
              rid,
              op: 'env',
              data: { widget: true, chunks, csp, tt },
            })
          );
      } else if (t === 'vt-markup' && rid) {
        const list = (v: unknown) =>
          Array.isArray(v)
            ? v
                .slice(0, 30)
                .filter(
                  (x): x is string => typeof x === 'string' && selectorOk(x)
                )
            : [];
        host.post({
          type: 'vt-result',
          rid,
          op: 'markup',
          data: markup(list(raw.deny), list(raw.allow)),
        });
      } else if (t === 'vt-mark') {
        const keys = Array.isArray(raw.keys)
          ? raw.keys
              .slice(0, LIST_MAX)
              .filter((k): k is string => typeof k === 'string' && KEY.test(k))
          : [];
        mark(keys);
      }
    },
  };
}
