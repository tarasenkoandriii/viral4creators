/**
 * Карта интерфейса страницы из HTML обхода — Э6 (ТЗ помощника §4.12
 * «показать на экране»: «карта интерфейса снимается при обходе тем же
 * `PageExploration`, что у обучалки»).
 *
 * Браузера у обхода нет (htmlparser2, сети не ходит — шапка extractor.ts),
 * поэтому здесь — порт ПРИОРИТЕТА СЕЛЕКТОРА `collectPageExploration`
 * (backend/src/modules/client-site-tutorial/page-exploration.ts, §5.4
 * ТЗ обучалки): `#id` → `tag[id="…"]` → `[data-testid]` → `[data-test]` →
 * `[name]` → `[aria-label]` → путь `tag:nth-of-type(n)` от `body`; каждый
 * кандидат проверяется на единственность в документе. Тот же селектор,
 * что сняла бы обучалка в браузере, — значит карта из обхода и карта из
 * раундов обучалки (источник `tutorial`) говорят на одном языке, и Ш4
 * сможет их сливать.
 *
 * Отличия от браузерной версии (честно): видимость — только по разметке
 * (`hidden`, `aria-hidden`, inline `display:none`/`visibility:hidden`,
 * `type=hidden`), CSS не вычисляется; элементы, которые дорисовывает JS,
 * в карту не попадают (их даст обучалка). Ссылки наружу — вон (как §5.4).
 */
import type { AnyNode, Element } from 'domhandler';
import { getAttributeValue, isTag, isText } from 'domutils';
import { parseDocument } from 'htmlparser2';
import {
  UI_ELEMENT_TAGS,
  cleanUiElements,
  type UiMapElement,
} from '../../site-core/ui-map/ui-map';

const TAGS = new Set<string>(UI_ELEMENT_TAGS);
/** Поддеревья, где интерактивных элементов для посетителя нет. */
const SKIP_SUBTREE = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'head',
  'iframe',
  'object',
]);
const MAX_SCAN = 400;

function attr(el: Element, name: string): string | null {
  const v = getAttributeValue(el, name);
  return typeof v === 'string' ? v : null;
}

function quote(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function hiddenByMarkup(el: Element): boolean {
  if (el.attribs.hidden !== undefined) return true;
  if ((attr(el, 'aria-hidden') ?? '').toLowerCase() === 'true') return true;
  const style = (attr(el, 'style') ?? '').toLowerCase().replace(/\s+/g, '');
  return /display:none|visibility:hidden/.test(style);
}

function textOf(node: AnyNode, skipFields = false): string {
  if (isText(node)) return node.data;
  if (!isTag(node)) return '';
  const tag = node.name.toLowerCase();
  if (SKIP_SUBTREE.has(tag)) return '';
  if (
    skipFields &&
    (tag === 'input' ||
      tag === 'select' ||
      tag === 'textarea' ||
      tag === 'button')
  )
    return '';
  return node.children.map((c) => textOf(c, skipFields)).join(' ');
}

interface Collected {
  el: Element;
  tag: string;
}

/** Интерактивные элементы в порядке документа (видимые по разметке). */
function collect(root: AnyNode[]): {
  found: Collected[];
  byAttr: Map<string, number>;
  labels: Map<string, Element>;
} {
  const found: Collected[] = [];
  // Счётчики для проверки единственности: `id=…`, `tag|attr=value`.
  const byAttr = new Map<string, number>();
  const labels = new Map<string, Element>();
  const bump = (k: string) => byAttr.set(k, (byAttr.get(k) ?? 0) + 1);
  const walk = (nodes: AnyNode[], hidden: boolean) => {
    for (const n of nodes) {
      if (!isTag(n)) continue;
      const tag = n.name.toLowerCase();
      if (SKIP_SUBTREE.has(tag)) continue;
      const id = attr(n, 'id');
      if (id) bump(`#${id}`);
      for (const a of ['data-testid', 'data-test', 'name', 'aria-label']) {
        const v = attr(n, a);
        if (v) bump(`${tag}|${a}=${v}`);
      }
      if (tag === 'label') {
        const f = attr(n, 'for');
        if (f && !labels.has(f)) labels.set(f, n);
      }
      const isHidden = hidden || hiddenByMarkup(n);
      if (TAGS.has(tag) && !isHidden && found.length < MAX_SCAN) {
        found.push({ el: n, tag });
      }
      walk(n.children, isHidden);
    }
  };
  walk(root, false);
  return { found, byAttr, labels };
}

function cssPath(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  let depth = 0;
  while (node && depth < 12) {
    const tag = node.name.toLowerCase();
    if (tag === 'html' || tag === 'body') break;
    const parent: Element | null =
      node.parent && isTag(node.parent) ? (node.parent as Element) : null;
    let index = 1;
    const siblings = (node.parent?.children ?? []) as AnyNode[];
    for (const sib of siblings) {
      if (sib === node) break;
      if (isTag(sib) && sib.name.toLowerCase() === tag) index++;
    }
    parts.unshift(`${tag}:nth-of-type(${index})`);
    node = parent;
    depth++;
  }
  return parts.join(' > ');
}

function selectorFor(
  el: Element,
  tag: string,
  byAttr: Map<string, number>,
): string {
  const id = attr(el, 'id');
  if (id && byAttr.get(`#${id}`) === 1) {
    if (/^[A-Za-z][\w-]*$/.test(id)) return `#${id}`;
    return `${tag}[id="${quote(id)}"]`;
  }
  for (const a of ['data-testid', 'data-test', 'name', 'aria-label']) {
    const v = attr(el, a);
    if (v && byAttr.get(`${tag}|${a}=${v}`) === 1) {
      return `${tag}[${a}="${quote(v)}"]`;
    }
  }
  return cssPath(el);
}

function labelFor(c: Collected, labels: Map<string, Element>): string | null {
  const { el, tag } = c;
  const pick = (s: string | null | undefined) => {
    const t = (s ?? '').replace(/\s+/g, ' ').trim();
    return t ? t : null;
  };
  if (tag === 'a' || tag === 'button') {
    return (
      pick(attr(el, 'aria-label')) ??
      pick(textOf(el)) ??
      pick(attr(el, 'title'))
    );
  }
  if (tag === 'input') {
    const type = (attr(el, 'type') ?? '').toLowerCase();
    if (type === 'submit' || type === 'button') {
      const v = pick(attr(el, 'value'));
      if (v) return v;
    }
  }
  const id = attr(el, 'id');
  const bound = id ? labels.get(id) : undefined;
  const fromLabel = bound ? pick(textOf(bound, true)) : null;
  if (fromLabel) return fromLabel;
  // Подпись-обёртка `<label>Имя <input></label>`.
  let p = el.parent;
  for (let i = 0; p && i < 4; i++) {
    if (isTag(p) && p.name.toLowerCase() === 'label') {
      const t = pick(textOf(p, true));
      if (t) return t;
      break;
    }
    p = p.parent;
  }
  return (
    pick(attr(el, 'aria-label')) ??
    pick(attr(el, 'placeholder')) ??
    pick(attr(el, 'title'))
  );
}

function sameOrigin(href: string | null, pageUrl: URL): boolean {
  if (!href) return false;
  const h = href.trim();
  if (!h || h.startsWith('#') || /^(?:javascript|mailto|tel|data):/i.test(h))
    return false;
  try {
    return new URL(h, pageUrl).origin === pageUrl.origin;
  } catch {
    return false;
  }
}

/**
 * Элементы карты из HTML страницы (`pageUrl` — финальный адрес обхода).
 * Пустой массив — нечего подсвечивать (SPA-оболочка, страница без кнопок).
 */
export function extractUiElements(
  html: string,
  pageUrl: string,
): UiMapElement[] {
  let base: URL;
  try {
    base = new URL(pageUrl);
  } catch {
    return [];
  }
  const doc = parseDocument(html, { decodeEntities: true });
  const { found, byAttr, labels } = collect(doc.children);
  const raw: Array<{ selector: string; tag: string; label: string | null }> =
    [];
  for (const c of found) {
    const type = (attr(c.el, 'type') ?? '').toLowerCase();
    if (c.tag === 'input' && type === 'hidden') continue;
    if (c.tag === 'a' && !sameOrigin(attr(c.el, 'href'), base)) continue;
    raw.push({
      selector: selectorFor(c.el, c.tag, byAttr),
      tag: c.tag,
      label: labelFor(c, labels),
    });
  }
  return cleanUiElements(raw);
}
