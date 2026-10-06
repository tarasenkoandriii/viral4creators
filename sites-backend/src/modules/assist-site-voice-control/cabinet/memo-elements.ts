/**
 * Правка мемо с телефона в TMA (Э6-бис (е) хвост (4), ТЗ §5-бис.17 п.14,
 * В-56 «на телефоне основной — TMA»): «добавить шаг» и «заменить цель»
 * ВЫБОРОМ из списка элементов карты интерфейса Ш4 страницы шага — ЧИСТАЯ
 * часть без базы.
 *
 *  - отпечаток `pin` строит СЕРВЕР из строки Ш4 (роль, `data-assist-id` из
 *    кандидатов, подпись — маскированная, тег, устойчивость): клиент шлёт
 *    только id элемента, факты цели (`submit`, `pd`, тип поля) он не
 *    подделает;
 *  - действие — по элементу: поле → `fill`, список → `select` (слот без
 *    значения: значений в мемо нет), флажок/переключатель → `check`, иначе
 *    `click`; новый слот — `[a-z][a-z0-9_]{0,19}` по типу поля;
 *  - «заменить цель» — новый отпечаток и элемент, действие и слот шага
 *    прежние (как перепривязка в редакторе);
 *  - всё дальше — те же операции черновика и ворота (`patchDraft`,
 *    `memoGates`): шаг, который ворота считают «никогда», сервис не
 *    сохраняет (422, как запись кликами останавливается на опасной цели).
 */
import {
  MEMO_LIMITS,
  type MemoPin,
  type MemoSlot,
  type MemoSlotKind,
  type MemoStep,
  type MemoStepKind,
} from '../../assist-ui-core/memo';
import { PD_FIELD_LABEL } from '../../assist-ui-core/plan-checks';
import { pathMatches, PATH_MASK_RE } from '../../assist-ui-core/rules';
import { ASSIST_ID_RE, maskLabel } from '../../assist-ui-core/snapshot';
import { UI_ROLES, type UiRole } from '../../assist-ui-core/types';

/** Строка Ш4 — то, что нужно для цели шага (без статистики и голосов). */
export interface MemoUiElementRow {
  id: string;
  hostId: string;
  path: string;
  viewport: string;
  elementKey: string;
  tag: string;
  label: string;
  role: string | null;
  selector: string | null;
  candidates: unknown;
  stability: string;
  staleDesktopAt: Date | null;
  staleMobileAt: Date | null;
}

/** Элемент для выбора в TMA (без селекторов и служебных полей карты). */
export interface MemoUiElementView {
  uiElementId: string;
  path: string;
  viewport: 'any' | 'desktop' | 'mobile';
  label: string;
  tag: MemoPin['tag'];
  role: UiRole | null;
  action: MemoStepKind;
  stability: 'strong' | 'medium' | 'fragile' | null;
  stale: boolean;
  pin: MemoPin;
}

export const MEMO_ELEMENTS_LIMITS = {
  /** Строк Ш4 на страницу при выборке и элементов в ответе. */
  scan: 600,
  items: 150,
} as const;

const PIN_TAGS = ['a', 'button', 'input', 'select', 'textarea'] as const;

function roleOf(el: Pick<MemoUiElementRow, 'role' | 'tag'>): UiRole | null {
  if (el.role && (UI_ROLES as readonly string[]).includes(el.role))
    return el.role as UiRole;
  switch (el.tag) {
    case 'a':
      return 'link';
    case 'button':
      return 'button';
    case 'select':
      return 'combobox';
    case 'input':
    case 'textarea':
      return 'textbox';
    default:
      return null;
  }
}

function candidateSelectors(
  el: Pick<MemoUiElementRow, 'selector' | 'candidates'>,
): string[] {
  const out: string[] = [];
  if (el.selector) out.push(el.selector);
  if (Array.isArray(el.candidates))
    for (const c of el.candidates)
      if (
        c &&
        typeof c === 'object' &&
        typeof (c as { selector?: unknown }).selector === 'string'
      )
        out.push((c as { selector: string }).selector);
  return out;
}

function assistIdOf(
  el: Pick<MemoUiElementRow, 'selector' | 'candidates'>,
): string | null {
  for (const s of candidateSelectors(el)) {
    const m = /\[data-assist-id="((?:[^"\\]|\\.)*)"\]$/.exec(s);
    if (!m) continue;
    const v = m[1].replace(/\\(.)/g, '$1');
    if (ASSIST_ID_RE.test(v)) return v;
  }
  return null;
}

/** Действие шага по элементу Ш4. */
export function memoActionFor(
  el: Pick<MemoUiElementRow, 'role' | 'tag'>,
): MemoStepKind {
  // Роль строки Ш4 — шире словаря плана (listbox, spinbutton): сырой текст.
  const role = el.role ?? roleOf(el);
  if (el.tag === 'select' || role === 'combobox' || role === 'listbox')
    return 'select';
  if (role === 'checkbox' || role === 'radio' || role === 'switch')
    return 'check';
  // `<input type=submit>` в Ш4 — тег input с ролью кнопки.
  if (role === 'button' || role === 'link') return 'click';
  if (
    el.tag === 'textarea' ||
    el.tag === 'input' ||
    role === 'textbox' ||
    role === 'searchbox' ||
    role === 'spinbutton'
  )
    return 'fill';
  return 'click';
}

/** Тип слота по подписи поля (типа поля в Ш4 нет). */
export function memoSlotKindFor(label: string): MemoSlotKind {
  if (/e-?mail|пошт|почт/iu.test(label)) return 'email';
  if (/телефон|phone|mobile|\btel\b/iu.test(label)) return 'phone';
  if (/дата|date/iu.test(label)) return 'date';
  return 'text';
}

/** Отпечаток цели из строки Ш4 (подпись — маска ПД, как `parsePin`). */
export function memoPinFor(
  el: Pick<
    MemoUiElementRow,
    'role' | 'tag' | 'label' | 'selector' | 'candidates' | 'stability'
  >,
  action: MemoStepKind,
): MemoPin {
  const tag = (PIN_TAGS as readonly string[]).includes(el.tag)
    ? (el.tag as MemoPin['tag'])
    : 'other';
  const text = maskLabel(el.label.replace(/\s+/g, ' ').trim()).slice(0, 80);
  const field = action === 'fill' || action === 'select';
  const kind = field ? memoSlotKindFor(text) : null;
  return {
    role: roleOf(el),
    assistId: assistIdOf(el),
    text,
    tag,
    href: null,
    submit: false,
    inForm: field,
    pd:
      field &&
      (kind === 'email' || kind === 'phone' || PD_FIELD_LABEL.test(text)),
    inputType:
      kind === 'email'
        ? 'email'
        : kind === 'phone'
          ? 'tel'
          : kind === 'date'
            ? 'date'
            : null,
    toggle: action === 'check',
    stability:
      el.stability === 'strong' ||
      el.stability === 'medium' ||
      el.stability === 'fragile'
        ? el.stability
        : null,
  };
}

const viewportOf = (v: string): MemoUiElementView['viewport'] =>
  v === 'desktop' || v === 'mobile' ? v : 'any';

/**
 * Список выбора: элементы страницы (точный путь или маска `…*`) в виде
 * мемо — один элемент на `elementKey` (сначала вид мемо, затем `any`),
 * без пустых подписей без разметки; устаревшие — с пометкой.
 */
export function memoElementViews(
  rows: readonly MemoUiElementRow[],
  page: string,
  view: 'any' | 'desktop' | 'mobile',
): MemoUiElementView[] {
  const rank = (v: string) =>
    v === view ? 0 : v === 'any' ? 1 : view === 'any' ? 1 : 2;
  const best = new Map<string, MemoUiElementRow>();
  for (const r of rows) {
    if (!pathMatches(r.path, page)) continue;
    if (view !== 'any' && r.viewport !== 'any' && r.viewport !== view) continue;
    const k = `${r.path}|${r.elementKey}`;
    const prev = best.get(k);
    if (!prev || rank(r.viewport) < rank(prev.viewport)) best.set(k, r);
  }
  const out: MemoUiElementView[] = [];
  for (const r of best.values()) {
    const action = memoActionFor(r);
    const pin = memoPinFor(r, action);
    if (!pin.text && !pin.assistId) continue;
    const stale =
      view === 'desktop'
        ? !!r.staleDesktopAt
        : view === 'mobile'
          ? !!r.staleMobileAt
          : !!(r.staleDesktopAt || r.staleMobileAt);
    out.push({
      uiElementId: r.id,
      path: r.path,
      viewport: viewportOf(r.viewport),
      label: pin.text,
      tag: pin.tag,
      role: pin.role,
      action,
      stability: pin.stability,
      stale,
      pin,
    });
    if (out.length >= MEMO_ELEMENTS_LIMITS.items) break;
  }
  return out;
}

/** Маска/путь страницы из запроса — или null. */
export function memoPageParam(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 300 || !PATH_MASK_RE.test(raw))
    return null;
  // Маска — только хвостом `*` (как `pathMatches`).
  return raw.indexOf('*') === -1 || raw.indexOf('*') === raw.length - 1
    ? raw
    : null;
}

/** Свободное имя слота по типу: `text`, `text_2`… (≤ 20 знаков). */
export function freeSlotName(
  kind: MemoSlotKind,
  slots: readonly Pick<MemoSlot, 'name'>[],
): string {
  const taken = new Set(slots.map((s) => s.name));
  if (!taken.has(kind)) return kind;
  for (let i = 2; ; i++) if (!taken.has(`${kind}_${i}`)) return `${kind}_${i}`;
}

/**
 * Новый шаг мемо по элементу: `page` — страница выбора (маска остаётся
 * маской, если элемент под ней), цель — элемент Ш4; поле/список — слот.
 */
export function memoStepFromElement(
  el: MemoUiElementRow,
  page: string,
  slots: readonly MemoSlot[],
): { step: MemoStep; slot: MemoSlot | null } {
  const action = memoActionFor(el);
  const pin = memoPinFor(el, action);
  let slot: MemoSlot | null = null;
  if (action === 'fill' || action === 'select') {
    const kind = memoSlotKindFor(pin.text);
    slot = {
      name: freeSlotName(kind, slots),
      kind,
      pii: kind === 'email' || kind === 'phone',
      options: [],
    };
  }
  return {
    step: {
      page: pathMatches(el.path, page) ? page : el.path,
      action,
      target: {
        uiElementId: el.id,
        key: el.elementKey.slice(0, 200),
        mapKey: null,
        pin,
      },
      value: slot ? { slot: slot.name } : null,
      expect: null,
      say: null,
      risk: null,
    },
    slot,
  };
}

/** Заменить цель шага: элемент и отпечаток новые, действие и значение — прежние. */
export function memoStepRetarget(
  step: MemoStep,
  el: MemoUiElementRow,
): MemoStep {
  return {
    ...step,
    target: {
      uiElementId: el.id,
      key: el.elementKey.slice(0, 200),
      mapKey: null,
      pin: memoPinFor(el, step.action),
    },
  };
}

export const MEMO_MAX_SLOTS = MEMO_LIMITS.slots;
