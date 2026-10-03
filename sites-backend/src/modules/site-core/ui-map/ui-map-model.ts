/**
 * Общая модель карты интерфейса — Э-С Ш4 (план, «Э-С: слияние», Ш4; аудит
 * слияния §3.2 — `site_ui_maps` для подсветки Э6, голоса Э6-бис, редактора
 * Э6-тер и Flow-QA). ЧИСТЫЙ код: без базы и Nest — его берут и обход, и
 * внутренний API, и публичная зона виджета.
 *
 * Что здесь:
 *  - кандидаты селектора элемента с порядком надёжности (§5-бис.3 п.6,
 *    §5-кватер.4): `data-assist-id` > `id` > тестовый атрибут > роль+имя >
 *    `[name]` > видимый текст > css-путь; устойчивость `strong|medium|fragile`
 *    (сгенерированные id, цена и числа в тексте, позиционный путь — хрупко);
 *  - стабильный ключ элемента (от лучшего кандидата) — по нему сливаются
 *    снимки разных источников и копятся промахи;
 *  - строгая чистка снимка от любого источника (v2: с кандидатами; старая
 *    форма Э6 `{selector, tag, label}` понимается как есть) и отпечаток;
 *  - слияние снимков страницы (один вид вёрстки) в элементы `site_ui_elements`;
 *  - вид вёрстки посетителя по заголовкам и правила устаревания по элементу.
 *
 * Карта по-прежнему НЕ несёт значений полей и текста страницы — только
 * селекторы, роль, тег и короткую подпись (≤ 80). Подпись — текст ЧУЖОЙ
 * страницы: в промпт — блоком данных, в загрузчике — `textContent`.
 */
import { createHash } from 'crypto';
import {
  UI_ELEMENT_TAGS,
  UI_MAP_SOURCES,
  cleanUiLabel,
  cleanUiSelector,
  uiElementId,
  type UiElementTag,
  type UiMapSource,
} from './ui-map';

// ── Виды вёрстки ─────────────────────────────────────────────────────────

/** Вид снимка: `any` — без браузера (обход) или вид неизвестен. */
export const UI_MAP_VIEWPORTS = ['any', 'desktop', 'mobile'] as const;
export type UiMapViewport = (typeof UI_MAP_VIEWPORTS)[number];
/** Вид посетителя — всегда конкретный. */
export type UiVisitorViewport = Exclude<UiMapViewport, 'any'>;

export function parseUiViewport(v: unknown): UiMapViewport | null {
  return typeof v === 'string' &&
    (UI_MAP_VIEWPORTS as readonly string[]).includes(v)
    ? (v as UiMapViewport)
    : null;
}

export function parseUiSource(v: unknown): UiMapSource | null {
  return typeof v === 'string' &&
    (UI_MAP_SOURCES as readonly string[]).includes(v)
    ? (v as UiMapSource)
    : null;
}

/**
 * Вид посетителя по заголовкам запроса из iframe (тот же браузер, что
 * страница): Client Hint `Sec-CH-UA-Mobile: ?1` — точно; иначе признаки
 * мобильного UA. Нет ничего — `desktop`.
 */
export function visitorViewport(headers: {
  userAgent?: string | null;
  chUaMobile?: string | null;
}): UiVisitorViewport {
  const ch = (headers.chUaMobile ?? '').trim();
  if (ch === '?1') return 'mobile';
  if (ch === '?0') return 'desktop';
  const ua = headers.userAgent ?? '';
  return /Mobi|Android|iPhone|iPod|iPad|Windows Phone|Opera Mini/i.test(ua)
    ? 'mobile'
    : 'desktop';
}

// ── Источники ────────────────────────────────────────────────────────────

/** Ранг доверия источника (меньше — главнее): подпись и порядок — от него. */
export const UI_SOURCE_RANK: Readonly<Record<UiMapSource, number>> = {
  manual: 0,
  tutorial: 1,
  qa: 2,
  loader: 3,
  crawl: 4,
};

/**
 * Источники СЕРВЕРА, которые ВИДЕЛИ страницу в браузере: их подтверждение
 * элемента сразу снимает промахи и устаревание этого вида. Обход разбирает
 * HTML без CSS и JS — «есть в разметке» не значит «виден посетителю»
 * (элемент, скрытый мобильной вёрсткой, обход видит всегда). Загрузчик
 * (`loader`, снимок Э6-бис) — тоже браузер, но его данные присылает
 * ПОСЕТИТЕЛЬ (аудит Ш4, 03.10.2026): он не сбрасывает сразу, а голосует
 * «найден» с тем же порогом, что промахи (assist-site-media/public/ui-map.ts,
 * `confirmSeenUiElements`).
 */
export const UI_BROWSER_SOURCES: ReadonlySet<UiMapSource> = new Set([
  'manual',
  'tutorial',
  'qa',
]);

/**
 * Вид по умолчанию, когда источник его не прислал. Исследователь обучалки
 * генератора снимает в окне 390×844 (`CAPTURE_VIEWPORT`,
 * backend/src/modules/tutorial-runner/tutorial-video-assembly.ts) — это
 * мобильная вёрстка; обход — без браузера.
 */
export const UI_DEFAULT_VIEWPORT: Readonly<Record<UiMapSource, UiMapViewport>> =
  {
    crawl: 'any',
    tutorial: 'mobile',
    loader: 'any',
    qa: 'any',
    manual: 'any',
  };

// ── Лимиты и устаревание ─────────────────────────────────────────────────

export const UI_MAP_SHARED = {
  /** Кандидатов селектора на элемент. */
  candidatesPerElement: 5,
  /** Слитых элементов на страницу и вид. */
  elementsPerPage: 120,
  /** Разных страниц (хост + путь) в карте сайта. */
  pagesPerSite: 1000,
  /** Версий истории на снимок источника (текущая — всегда). */
  versionsPerMap: 10,
  /** Срок истории, дней (текущая версия не удаляется). */
  historyDays: 90,
  /** Страниц без слитых элементов, достраиваемых одним проходом крона. */
  backfillPerRun: 200,
} as const;

export const UI_MAP_STALE = {
  /** Промахов разных посетителей (и разных IP) за окно — элемент устарел. */
  threshold: 3,
  /** Окно накопления промахов. */
  windowMs: 7 * 24 * 3600_000,
  /** Сколько держится отметка «устарел» без нового подтверждения браузером. */
  staleTtlMs: 30 * 24 * 3600_000,
  /** Квитанция показа: подсветку этого элемента ассистент выдал не раньше. */
  receiptMs: 30 * 60_000,
  /** Сигналов «не найден» с одного IP на сайт в сутки (сверх минутных). */
  missesPerIpSitePerDay: 20,
} as const;

// ── Кандидаты селектора ──────────────────────────────────────────────────

export const UI_CANDIDATE_KINDS = [
  'assist-id',
  'id',
  'test-id',
  'role-name',
  'attr',
  'text',
  'css',
] as const;
export type UiCandidateKind = (typeof UI_CANDIDATE_KINDS)[number];
export type UiStability = 'strong' | 'medium' | 'fragile';

/** Роли ARIA интерактивных элементов (закрытый список). */
export const UI_ROLES = [
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'menuitem',
  'option',
  'listbox',
  'spinbutton',
  'slider',
] as const;
export type UiRole = (typeof UI_ROLES)[number];

export interface UiSelectorCandidate {
  kind: UiCandidateKind;
  /** CSS — у всех, кроме `text` и смыслового `role-name`. */
  selector?: string;
  role?: UiRole;
  /** Доступное имя (`role-name`) или видимый текст (`text`), ≤ 80. */
  name?: string;
}

/** Элемент снимка источника после чистки (v2). */
export interface UiSnapshotElement {
  /** `u` + 8 hex: от лучшего CSS-селектора (как Э6), без него — от ключа. */
  id: string;
  key: string;
  selector: string | null;
  tag: UiElementTag;
  label: string;
  role: UiRole | null;
  candidates: UiSelectorCandidate[];
  stability: UiStability;
}

const KIND_ORDER: Record<UiCandidateKind, number> = Object.fromEntries(
  UI_CANDIDATE_KINDS.map((k, i) => [k, i]),
) as Record<UiCandidateKind, number>;

const ASSIST_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Роль по тегу (для `[aria-label]` обхода и обучалки). */
export function implicitRole(tag: UiElementTag): UiRole {
  switch (tag) {
    case 'a':
      return 'link';
    case 'button':
      return 'button';
    case 'select':
      return 'combobox';
    default:
      return 'textbox';
  }
}

/**
 * Похоже на сгенерированный id/класс: хеши CSS-in-JS (`css-1x2y3z`,
 * `sc-…`), React `:r1:`, длинные числа и hex — между сборками другие.
 */
export function isGeneratedToken(v: string): boolean {
  return (
    /^:r[0-9a-z]*:$/i.test(v) ||
    /^(css|sc|jsx|emotion|ember|mui|chakra|svelte|tw)-/i.test(v) ||
    /\d{4,}/.test(v) ||
    (/[0-9a-f]{8,}/i.test(v) && /\d/.test(v)) ||
    v.length > 40
  );
}

/** Цена, число, дата в тексте — подпись поменяется вместе с данными. */
function volatileText(t: string): boolean {
  return /\d[\d\s.,]*\s*(₴|грн|uah|\$|€|руб|₽|zł|%)|\d{2,}/i.test(t);
}

function quote(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function unquote(value: string): string {
  return value.replace(/\\(.)/g, '$1');
}

/**
 * Селектор Э6 (обход/обучалка присылают одну строку) → кандидат с видом:
 * `[data-assist-id]`, `#id`/`tag[id]`, `[data-testid]`/`[data-test]`,
 * `[aria-label]` (роль по тегу + имя), `[name]`, иначе css-путь.
 */
export function candidateFromSelector(
  selector: string,
  tag: UiElementTag,
): UiSelectorCandidate {
  let m = /^(?:[a-z]+)?\[data-assist-id="((?:[^"\\]|\\.)*)"\]$/.exec(selector);
  if (m) return { kind: 'assist-id', selector };
  m = /^#([A-Za-z][\w-]*)$/.exec(selector);
  if (m) return { kind: 'id', selector };
  m = /^[a-z]+\[id="((?:[^"\\]|\\.)*)"\]$/.exec(selector);
  if (m) return { kind: 'id', selector };
  if (/^[a-z]+\[data-test(?:id)?="(?:[^"\\]|\\.)*"\]$/.test(selector))
    return { kind: 'test-id', selector };
  m = /^[a-z]+\[aria-label="((?:[^"\\]|\\.)*)"\]$/.exec(selector);
  if (m) {
    const name = cleanUiLabel(unquote(m[1]));
    return name
      ? { kind: 'role-name', selector, role: implicitRole(tag), name }
      : { kind: 'css', selector };
  }
  if (/^[a-z]+\[name="(?:[^"\\]|\\.)*"\]$/.test(selector))
    return { kind: 'attr', selector };
  return { kind: 'css', selector };
}

/** Строгая чистка присланного кандидата; не годится — null. */
export function cleanCandidate(raw: unknown): UiSelectorCandidate | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const kind = o.kind;
  if (
    typeof kind !== 'string' ||
    !(UI_CANDIDATE_KINDS as readonly string[]).includes(kind)
  )
    return null;
  const selector =
    o.selector === undefined || o.selector === null
      ? null
      : cleanUiSelector(o.selector);
  if (o.selector !== undefined && o.selector !== null && !selector) return null;
  const role =
    typeof o.role === 'string' &&
    (UI_ROLES as readonly string[]).includes(o.role)
      ? (o.role as UiRole)
      : null;
  if (o.role !== undefined && o.role !== null && !role) return null;
  const name =
    o.name === undefined || o.name === null ? null : cleanUiLabel(o.name);
  if (o.name !== undefined && o.name !== null && !name) return null;
  const k = kind as UiCandidateKind;
  if (k === 'text') return name ? { kind: k, name } : null;
  if (k === 'role-name') {
    if (!role || !name) return null;
    return selector
      ? { kind: k, selector, role, name }
      : { kind: k, role, name };
  }
  if (!selector) return null;
  if (k === 'assist-id') {
    const m = /\[data-assist-id="((?:[^"\\]|\\.)*)"\]$/.exec(selector);
    if (!m || !ASSIST_ID_RE.test(unquote(m[1]))) return null;
  }
  return { kind: k, selector };
}

/** Ключ кандидата — то, по чему узнаём «тот же элемент» в другом снимке. */
export function candidateKey(
  c: UiSelectorCandidate,
  tag: UiElementTag,
): string {
  switch (c.kind) {
    case 'assist-id': {
      const m = /\[data-assist-id="((?:[^"\\]|\\.)*)"\]$/.exec(
        c.selector ?? '',
      );
      return `a:${m ? unquote(m[1]) : (c.selector ?? '')}`;
    }
    case 'id': {
      const s = c.selector ?? '';
      const m =
        /^#([A-Za-z][\w-]*)$/.exec(s) ?? /\[id="((?:[^"\\]|\\.)*)"\]$/.exec(s);
      return `i:${m ? unquote(m[1]) : s}`;
    }
    case 'role-name':
      return `r:${c.role ?? implicitRole(tag)}|${(c.name ?? '').toLowerCase()}`;
    case 'text':
      return `x:${tag}|${(c.name ?? '').toLowerCase()}`;
    case 'test-id':
      return `t:${c.selector ?? ''}`;
    case 'attr':
      return `n:${c.selector ?? ''}`;
    default:
      return `c:${c.selector ?? ''}`;
  }
}

/** Устойчивость кандидата (§5-кватер.4 «Проверка устойчивости»). */
export function candidateStability(c: UiSelectorCandidate): UiStability {
  switch (c.kind) {
    case 'assist-id':
    case 'test-id':
      return 'strong';
    case 'id': {
      const s = c.selector ?? '';
      const m =
        /^#([A-Za-z][\w-]*)$/.exec(s) ?? /\[id="((?:[^"\\]|\\.)*)"\]$/.exec(s);
      return m && isGeneratedToken(unquote(m[1])) ? 'fragile' : 'strong';
    }
    case 'role-name':
    case 'attr':
      return volatileText(c.name ?? '') ? 'fragile' : 'medium';
    case 'text':
      return volatileText(c.name ?? '') ? 'fragile' : 'medium';
    default:
      return 'fragile';
  }
}

const STABILITY_ORDER: Record<UiStability, number> = {
  strong: 0,
  medium: 1,
  fragile: 2,
};

/** Кандидаты по убыванию надёжности: вид, затем устойчивость. */
function sortCandidates(cs: UiSelectorCandidate[]): UiSelectorCandidate[] {
  return [...cs].sort(
    (a, b) =>
      STABILITY_ORDER[candidateStability(a)] -
        STABILITY_ORDER[candidateStability(b)] ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind],
  );
}

function dedupeCandidates(
  cs: UiSelectorCandidate[],
  tag: UiElementTag,
): UiSelectorCandidate[] {
  const seen = new Set<string>();
  const out: UiSelectorCandidate[] = [];
  for (const c of sortCandidates(cs)) {
    const k = candidateKey(c, tag);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
    if (out.length >= UI_MAP_SHARED.candidatesPerElement) break;
  }
  return out;
}

/**
 * Готовый элемент из кандидатов (лучший — первый). `weak` — кандидаты
 * источника, узнанного только по смысловому ключу (текст, роль+имя; аудит
 * Ш4): они идут ПОСЛЕ своих и не дают ни ключа, ни селектора подсветки.
 */
function finishElement(
  tag: UiElementTag,
  label: string,
  role: UiRole | null,
  candidates: UiSelectorCandidate[],
  weak: UiSelectorCandidate[] = [],
): UiSnapshotElement | null {
  const own = dedupeCandidates(candidates, tag);
  if (!own.length) return null;
  const cs = [...own];
  const keys = new Set(own.map((c) => candidateKey(c, tag)));
  for (const c of dedupeCandidates(weak, tag)) {
    if (cs.length >= UI_MAP_SHARED.candidatesPerElement) break;
    const k = candidateKey(c, tag);
    if (keys.has(k)) continue;
    keys.add(k);
    cs.push(c);
  }
  const best = own[0];
  const key = candidateKey(best, tag);
  const selector = own.find((c) => c.selector)?.selector ?? null;
  return {
    id: uiElementId(selector ?? key),
    key,
    selector,
    tag,
    label,
    role,
    candidates: cs,
    stability: candidateStability(best),
  };
}

interface Draft {
  tag: UiElementTag;
  label: string;
  role: UiRole | null;
  candidates: UiSelectorCandidate[];
}

function draftOf(item: unknown): Draft | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const o = item as Record<string, unknown>;
  const tag = o.tag;
  if (
    typeof tag !== 'string' ||
    !(UI_ELEMENT_TAGS as readonly string[]).includes(tag)
  )
    return null;
  const t = tag as UiElementTag;
  const label = cleanUiLabel(o.label);
  if (!label) return null;
  const role =
    typeof o.role === 'string' &&
    (UI_ROLES as readonly string[]).includes(o.role)
      ? (o.role as UiRole)
      : null;
  const cs: UiSelectorCandidate[] = [];
  if (o.assistId !== undefined && o.assistId !== null) {
    if (typeof o.assistId !== 'string' || !ASSIST_ID_RE.test(o.assistId))
      return null;
    cs.push({
      kind: 'assist-id',
      selector: `[data-assist-id="${quote(o.assistId)}"]`,
    });
  }
  if (o.selector !== undefined && o.selector !== null) {
    const s = cleanUiSelector(o.selector);
    if (!s) return null;
    cs.push(candidateFromSelector(s, t));
  }
  if (o.candidates !== undefined) {
    if (!Array.isArray(o.candidates)) return null;
    for (const c of o.candidates.slice(0, 10)) {
      const clean = cleanCandidate(c);
      if (clean) cs.push(clean);
    }
  }
  // Видимый текст — запасной кандидат (Э6-бис ищет цель и по нему).
  cs.push({ kind: 'text', name: label });
  if (role) cs.push({ kind: 'role-name', role, name: label });
  // Только видимый текст — мало: такой элемент не узнать в другом снимке.
  return cs.some((c) => c.kind !== 'text')
    ? { tag: t, label, role, candidates: cs }
    : null;
}

/**
 * Строгая чистка снимка любого источника (v2). Понимает старую форму Э6
 * (`{selector, tag, label}`) и новую (`candidates`, `assistId`, `role`).
 * Тег — из перечня, подпись — обязательна; хотя бы один кандидат кроме
 * текста. Кандидат-текст (и роль+имя), который на странице НЕ единственный,
 * вычёркивается у всех таких элементов: «Купить» у трёх товаров — не ключ.
 * id и ключ считаются здесь (присланным не верим); ≤ 60 элементов.
 */
export function cleanUiSnapshot(raw: unknown, limit = 60): UiSnapshotElement[] {
  if (!Array.isArray(raw)) return [];
  const drafts: Draft[] = [];
  for (const item of raw) {
    if (drafts.length >= limit * 2) break;
    const d = draftOf(item);
    if (d) drafts.push(d);
  }
  // Неединственные смысловые ключи (текст, роль+имя) — вон у всех.
  const count = new Map<string, number>();
  for (const d of drafts) {
    const keys = new Set(
      d.candidates
        .filter(
          (c) => c.kind === 'text' || (c.kind === 'role-name' && !c.selector),
        )
        .map((c) => candidateKey(c, d.tag)),
    );
    for (const k of keys) count.set(k, (count.get(k) ?? 0) + 1);
  }
  const out: UiSnapshotElement[] = [];
  const seenKeys = new Set<string>();
  const seenSelectors = new Set<string>();
  for (const d of drafts) {
    if (out.length >= limit) break;
    const cs = d.candidates.filter(
      (c) =>
        !(
          (c.kind === 'text' || (c.kind === 'role-name' && !c.selector)) &&
          (count.get(candidateKey(c, d.tag)) ?? 0) > 1
        ),
    );
    const el = finishElement(d.tag, d.label, d.role, cs);
    if (!el) continue;
    if (seenKeys.has(el.key)) continue;
    if (el.selector && seenSelectors.has(el.selector)) continue;
    seenKeys.add(el.key);
    if (el.selector) seenSelectors.add(el.selector);
    out.push(el);
  }
  return out;
}

/** Отпечаток снимка v2 (другой набор/кандидаты — новая версия карты). */
export function uiSnapshotHash(elements: UiSnapshotElement[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        elements.map((e) => [e.key, e.tag, e.label, e.role, e.candidates]),
      ),
    )
    .digest('hex');
}

// ── Слияние источников ───────────────────────────────────────────────────

export interface UiSourceSnapshot {
  source: UiMapSource;
  elements: UiSnapshotElement[];
}

/** Элемент страницы, слитый из снимков источников (строка site_ui_elements). */
export interface MergedUiElement {
  key: string;
  elementId: string;
  tag: UiElementTag;
  label: string;
  role: UiRole | null;
  selector: string | null;
  candidates: UiSelectorCandidate[];
  stability: UiStability;
  confidence: number;
  sources: UiMapSource[];
  sourceRank: number;
  position: number;
}

/**
 * Уверенность 0–100: устойчивость лучшего кандидата, + браузерный источник,
 * + подтверждение вторым источником; ручная разметка — 100.
 */
export function uiConfidence(
  stability: UiStability,
  sources: readonly UiMapSource[],
): number {
  if (sources.includes('manual')) return 100;
  const base = stability === 'strong' ? 80 : stability === 'medium' ? 55 : 30;
  const browser = sources.some((s) => UI_BROWSER_SOURCES.has(s)) ? 10 : 0;
  const extra = Math.min(10, Math.max(0, new Set(sources).size - 1) * 5);
  return Math.min(100, base + browser + extra);
}

/**
 * Смысловой ключ (видимый текст, роль+имя): узнаёт «похоже, тот же
 * элемент», но не доказывает его — такой же текст может стоять у чужой
 * кнопки (отзыв, комментарий посетителя с `data-assist-id` в HTML обхода).
 */
function isSemanticKey(k: string): boolean {
  return k.startsWith('x:') || k.startsWith('r:');
}

/**
 * Слияние снимков ОДНОЙ страницы и ОДНОГО вида по стабильному ключу:
 * сначала совпадение ключа, затем — любого ключа кандидата (обход видит
 * `#buy`, обучалка — тот же `#buy` и путь). Подпись, тег, роль и порядок —
 * от главного источника (ручная > обучалка > QA > загрузчик > обход),
 * кандидаты — объединение по надёжности (≤ 5). Узнан только по смысловому
 * ключу (текст, роль+имя) — кандидаты младшего источника в запасе: ключ и
 * селектор остаются от главного. Детерминировано: те же снимки — те же
 * элементы.
 */
export function mergeUiSnapshots(
  snapshots: UiSourceSnapshot[],
  limit: number = UI_MAP_SHARED.elementsPerPage,
): MergedUiElement[] {
  const ordered = [...snapshots].sort(
    (a, b) =>
      UI_SOURCE_RANK[a.source] - UI_SOURCE_RANK[b.source] ||
      a.source.localeCompare(b.source),
  );
  interface Acc {
    tag: UiElementTag;
    label: string;
    role: UiRole | null;
    candidates: UiSelectorCandidate[];
    /** Кандидаты источников, узнанных только по смысловому ключу. */
    weak: UiSelectorCandidate[];
    sources: UiMapSource[];
    sourceRank: number;
    position: number;
    keys: Set<string>;
  }
  const accs: Acc[] = [];
  const byKey = new Map<string, Acc>();
  for (const snap of ordered) {
    snap.elements.forEach((e, position) => {
      const keys = e.candidates.map((c) => candidateKey(c, e.tag));
      let acc = byKey.get(e.key);
      if (!acc) {
        const hits = new Set(
          keys.map((k) => byKey.get(k)).filter((a): a is Acc => !!a),
        );
        // Совпадение по кандидату — только однозначное.
        if (hits.size === 1) acc = [...hits][0];
      }
      if (acc && acc.sources.includes(snap.source)) acc = undefined;
      // Узнан только по тексту/роли+имени — источник ниже рангом (порядок
      // снимков — по доверию) не меняет ключ и селектор подсветки элемента
      // главного источника: его кандидаты — в запас (аудит Ш4, отравление
      // карты чужой кнопкой с тем же текстом).
      const weak =
        !!acc &&
        [e.key, ...keys]
          .filter((k) => byKey.get(k) === acc)
          .every(isSemanticKey);
      if (!acc) {
        acc = {
          tag: e.tag,
          label: e.label,
          role: e.role,
          candidates: [],
          weak: [],
          sources: [],
          sourceRank: UI_SOURCE_RANK[snap.source],
          position,
          keys: new Set(),
        };
        accs.push(acc);
      }
      acc.sources.push(snap.source);
      acc.role = acc.role ?? e.role;
      (weak ? acc.weak : acc.candidates).push(...e.candidates);
      for (const k of [e.key, ...keys]) {
        acc.keys.add(k);
        if (!byKey.has(k)) byKey.set(k, acc);
      }
    });
  }
  accs.sort((a, b) => a.sourceRank - b.sourceRank || a.position - b.position);
  const out: MergedUiElement[] = [];
  const usedKeys = new Set<string>();
  for (const a of accs) {
    if (out.length >= limit) break;
    const el = finishElement(a.tag, a.label, a.role, a.candidates, a.weak);
    if (!el || usedKeys.has(el.key)) continue;
    usedKeys.add(el.key);
    const sources = [...new Set(a.sources)].sort(
      (x, y) => UI_SOURCE_RANK[x] - UI_SOURCE_RANK[y],
    );
    out.push({
      key: el.key,
      elementId: el.id,
      tag: el.tag,
      label: el.label,
      role: el.role,
      selector: el.selector,
      candidates: el.candidates,
      stability: el.stability,
      confidence: uiConfidence(el.stability, sources),
      sources,
      sourceRank: a.sourceRank,
      position: a.position,
    });
  }
  return out;
}

/** Все ключи кандидатов элемента (для узнавания строки при смене ключа). */
export function candidateKeys(
  candidates: UiSelectorCandidate[],
  tag: UiElementTag,
): string[] {
  return candidates.map((c) => candidateKey(c, tag));
}

// ── Устаревание по элементу ──────────────────────────────────────────────

/**
 * Какие счётчики промахов трогает подтверждение снимком вида `viewport`:
 * снимок `any` браузерного источника — оба вида, вид — только свой.
 */
export function viewportsConfirmedBy(
  viewport: UiMapViewport,
): UiVisitorViewport[] {
  return viewport === 'any' ? ['desktop', 'mobile'] : [viewport];
}

/**
 * Годится ли элемент вида `rowViewport` посетителю вида `visitor`
 * (`undefined` — вид неизвестен: годится любой). Элемент, снятый на
 * телефоне, компьютеру не предлагаем, и наоборот: вёрстка разная.
 */
export function rowFitsViewport(
  rowViewport: string,
  visitor: UiVisitorViewport | undefined,
): boolean {
  return !visitor || rowViewport === 'any' || rowViewport === visitor;
}

/**
 * Устарел ли элемент для посетителя: отметка вида посетителя; вид
 * неизвестен — любая отметка (осторожно: не показывать сомнительное).
 */
export function isStaleFor(
  row: { staleDesktopAt: Date | null; staleMobileAt: Date | null },
  visitor: UiVisitorViewport | undefined,
): boolean {
  if (visitor === 'desktop') return row.staleDesktopAt !== null;
  if (visitor === 'mobile') return row.staleMobileAt !== null;
  return row.staleDesktopAt !== null || row.staleMobileAt !== null;
}

/** Счётчик промахов в окне: окно истекло — счёт заново (с этого промаха). */
export function nextMissCount(
  current: { count: number; since: Date | null },
  now: Date,
): { count: number; since: Date } {
  if (
    !current.since ||
    now.getTime() - current.since.getTime() > UI_MAP_STALE.windowMs
  ) {
    return { count: 1, since: now };
  }
  return { count: current.count + 1, since: current.since };
}
