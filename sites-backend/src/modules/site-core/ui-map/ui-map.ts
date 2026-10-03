/**
 * Карта интерфейса страницы — ЧИСТОЕ ядро (Э6, ТЗ помощника §4.12 «показать
 * на экране»; аудит слияния §3.2 — `site_ui_maps`, общая карта Ш4).
 *
 * Здесь — форма элемента, ключ страницы (хост + путь), id элемента и
 * строгая чистка: карту пишут два источника (обход sites-backend и раунды
 * обучалки генератора через внутренний API), а читают виджет (подсветка),
 * позже голос (Э6-бис), редактор (Э6-тер) и Flow-QA. Ядро `site-core` —
 * чтобы его брали все, включая лист графа `internal-sites` (правило
 * `internal-sites-scope`) и общий с QA `site-crawl`.
 *
 * Чего карта НЕ несёт: значений полей, текста страницы, адресов чужих
 * сайтов — только селектор, тег и короткую подпись элемента. Подпись — это
 * текст ЧУЖОЙ страницы: в промпт она идёт размеченным блоком данных
 * (assist-site-chat/prompt.ts), а в загрузчике ставится `textContent`.
 */
import { createHash } from 'crypto';
import type { UiRole, UiSelectorCandidate } from './ui-map-model';

/**
 * Источники снимков карты. Э6: `crawl` (обход без браузера), `tutorial`
 * (раунды обучалки). Э-С Ш4: `loader` (снимок загрузчика Э6-бис — только
 * подтверждает уже известные элементы, сам не сохраняется), `qa` (Flow-QA,
 * внутренний HMAC-маршрут), `manual` (ручная разметка — редактор Э6-тер).
 * Порядок доверия и правила слияния — ui-map-model.ts.
 */
export const UI_MAP_SOURCES = [
  'crawl',
  'tutorial',
  'loader',
  'qa',
  'manual',
] as const;
export type UiMapSource = (typeof UI_MAP_SOURCES)[number];

export const UI_ELEMENT_TAGS = [
  'a',
  'button',
  'input',
  'select',
  'textarea',
] as const;
export type UiElementTag = (typeof UI_ELEMENT_TAGS)[number];

export interface UiMapElement {
  /** `u` + 8 hex sha256 селектора: тот же селектор — тот же id после переобхода. */
  id: string;
  selector: string;
  tag: UiElementTag;
  /** Доступное имя: label/aria-label/placeholder/текст — ≤ 80 символов. */
  label: string;
  /**
   * Э-С Ш4 (необязательно): все кандидаты селектора по надёжности и роль —
   * для слияния источников (ui-map-model.ts). Читатели Э6 их не берут.
   */
  candidates?: UiSelectorCandidate[];
  role?: UiRole;
}

export const UI_MAP_LIMITS = {
  /** Элементов на страницу (обход берёт первые по порядку документа). */
  elements: 60,
  selector: 200,
  label: 80,
  path: 300,
} as const;

export const UI_ELEMENT_ID_RE = /^u[0-9a-f]{8}$/;

/** id элемента — от селектора (стабилен между переобходами). */
export function uiElementId(selector: string): string {
  return `u${createHash('sha256').update(selector, 'utf8').digest('hex').slice(0, 8)}`;
}

/** Хост для ключа карты: нижний регистр, без точки на конце и `www.`. */
export function uiMapHost(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '');
}

/**
 * Ключ страницы: хост + путь без query/фрагмента и без концевого `/`
 * (корень — `/`). Не http(s), логин в адресе, слишком длинный путь — null.
 */
export function uiMapKey(raw: unknown): { host: string; path: string } | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password || !u.hostname) return null;
  const path = u.pathname.replace(/\/+$/, '') || '/';
  if (path.length > UI_MAP_LIMITS.path) return null;
  return { host: uiMapHost(u.hostname), path };
}

/**
 * Страница карты одной строкой — `хост` + `путь` (`shop.example/cart`):
 * привязка квитанции показа (`highlight.page`) к странице, где элемент
 * взят из карты (аудит Ш4: id элемента — хеш селектора, один на всех
 * страницах сайта).
 */
export function uiMapPageRef(key: { host: string; path: string }): string {
  return `${key.host}${key.path}`;
}

// Управляющие и двунаправленные символы: подпись — текст, а не разметка.
// eslint-disable-next-line no-control-regex
const CONTROL =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Подпись элемента: текст ≤ 80, без управляющих символов и `<>` — иначе null. */
export function cleanUiLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw
    .normalize('NFKC')
    .replace(CONTROL, '')
    .replace(/[<>`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return null;
  return t.length > UI_MAP_LIMITS.label
    ? `${t.slice(0, UI_MAP_LIMITS.label - 1).trimEnd()}…`
    : t;
}

/**
 * Селектор: печатный набор CSS (без `<`, обратных кавычек и управляющих;
 * `>` — комбинатор «потомок», он нужен пути `nth-of-type`), ≤ 200. Это не защита загрузчика (он ищет только
 * `querySelectorAll` в try и ничего не вставляет), а гигиена данных: в
 * карту не попадает мусор, который нельзя показать в TMA и логе.
 */
export function cleanUiSelector(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > UI_MAP_LIMITS.selector) return null;
  // Управляющие (в т.ч. перевод строки — `\s` ниже его бы пропустил).
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) return null;
  // Только печатные символы CSS (без `<` и обратных кавычек), кириллица в
  // значениях атрибутов — можно.
  if (!/^[\p{L}\p{N}\s#.:()[\]="'_*^$|~+>,\\/-]+$/u.test(s)) return null;
  return s;
}

/**
 * Строгая чистка массива элементов от любого источника: тег из перечня,
 * чистые селектор и подпись, без подписи — вон (модели нечего назвать),
 * дубли по селектору — вон, ≤ 60. id пересчитывается здесь (присланному
 * не верим).
 */
export function cleanUiElements(raw: unknown): UiMapElement[] {
  if (!Array.isArray(raw)) return [];
  const out: UiMapElement[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= UI_MAP_LIMITS.elements) break;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const tag = o.tag;
    if (
      typeof tag !== 'string' ||
      !(UI_ELEMENT_TAGS as readonly string[]).includes(tag)
    )
      continue;
    const selector = cleanUiSelector(o.selector);
    const label = cleanUiLabel(o.label);
    if (!selector || !label || seen.has(selector)) continue;
    seen.add(selector);
    out.push({
      id: uiElementId(selector),
      selector,
      tag: tag as UiElementTag,
      label,
    });
  }
  return out;
}

/** Отпечаток набора (смена вёрстки = другой хеш → счётчик промахов с нуля). */
export function uiElementsHash(elements: UiMapElement[]): string {
  return createHash('sha256')
    .update(JSON.stringify(elements.map((e) => [e.selector, e.tag, e.label])))
    .digest('hex');
}
