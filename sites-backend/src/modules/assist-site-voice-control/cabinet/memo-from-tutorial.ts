/**
 * Шаги одобренной обучалки → содержимое черновика мемо (Э6-тер (к), ТЗ
 * помощника §5-бис.17 п.6 «Шаги обучалки»; аудит §5-бис.18 м-16). Чистая
 * часть без базы: элементы карты Ш4 передаёт сервис.
 *
 *  - `navigate` → страница следующих шагов (`page`). Адресного перехода в
 *    словаре мемо нет (§5-бис.3 п.4: адрес «из головы» не принимается —
 *    переход только кликом по найденной ссылке): первый `navigate` —
 *    стартовая страница мемо (мемо предлагается на ней, §5-бис.17 п.5 п.1),
 *    следующие — смена страницы; ссылка, после которой страница сменилась,
 *    получает `href` в отпечатке;
 *  - `click` → `click` по элементу Ш4 (тот же селектор у элемента или среди
 *    его кандидатов; сначала на текущей странице, затем на любой странице
 *    этого хоста; вид — сначала вид съёмки). Отпечаток `pin` — из карты:
 *    роль, `data-assist-id`, подпись (маскированная разбором), тег,
 *    устойчивость. Не нашёлся — шаг без цели (ворота `no_target`, цель
 *    выберут в TMA или редакторе);
 *  - `fill` → `fill` со СЛОТОМ без значения (тип — по виду поля; e-mail и
 *    телефон — ПД, ставит код), не больше 5 слотов;
 *  - цель — адрес последней страницы (если она другая), описание и имя — из
 *    названия ролика, если оно проходит проверку текста; иначе — шаблон;
 *  - вид вёрстки — вид съёмки обучалки (`mobile`, Ш4): в бою — только на
 *    телефоне, пока сухой прогон не подтвердит компьютер.
 * Результат идёт через тот же строгий разбор `parseMemoContent`, что и
 * черновик из TMA; ворота (`memoGates`) — в карточке мемо.
 */
import {
  emptyMemoContent,
  MEMO_LIMITS,
  memoTextProblem,
  parseMemoContent,
  type MemoContent,
  type MemoLang,
  type MemoPin,
  type MemoSlotKind,
  type MemoStep,
} from '../../assist-ui-core/memo';
import { ASSIST_ID_RE } from '../../assist-ui-core/snapshot';
import { UI_ROLES, type UiRole } from '../../assist-ui-core/types';
import { cleanUiSelector } from '../../site-core/ui-map/ui-map';
import type { TutorialMemoSteps } from './generator-memo-steps.client';

/** Строка карты Ш4 — то, что нужно для цели шага. */
export interface TutorialUiElement {
  id: string;
  path: string;
  viewport: string;
  elementKey: string;
  tag: string;
  label: string;
  role: string | null;
  selector: string | null;
  candidates: unknown;
  stability: string;
}

export interface MemoFromTutorialResult {
  content: MemoContent;
  /** Номера шагов мемо (с 0) без цели в карте Ш4. */
  unresolved: number[];
  /** fill сверх 5 слотов — шаг без значения (ворота `value_not_slot`). */
  slotsOverflow: number;
}

const DEFAULT_NAME: Record<MemoLang, string> = {
  uk: 'Мемо з обучалки',
  ru: 'Мемо из обучалки',
  en: 'Memo from tutorial',
};

const PIN_TAGS = ['a', 'button', 'input', 'select', 'textarea'] as const;

function roleOf(el: TutorialUiElement): UiRole | null {
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

function candidateSelectors(el: TutorialUiElement): string[] {
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

function assistIdOf(el: TutorialUiElement): string | null {
  for (const s of candidateSelectors(el)) {
    const m = /\[data-assist-id="((?:[^"\\]|\\.)*)"\]$/.exec(s);
    if (!m) continue;
    const v = m[1].replace(/\\(.)/g, '$1');
    if (ASSIST_ID_RE.test(v)) return v;
  }
  return null;
}

/**
 * Элемент Ш4 по селектору обучалки: текущая страница → любая страница
 * хоста; среди равных — вид съёмки, затем `any`, затем другой вид.
 */
export function findTutorialElement(
  elements: readonly TutorialUiElement[],
  selector: string,
  page: string | null,
  view: 'mobile' | 'desktop',
): TutorialUiElement | null {
  const want = cleanUiSelector(selector) ?? selector;
  const hits = elements.filter((e) =>
    candidateSelectors(e).some((s) => s === want || s === selector),
  );
  if (!hits.length) return null;
  const vRank = (v: string) => (v === view ? 0 : v === 'any' ? 1 : 2);
  return [...hits].sort(
    (a, b) =>
      (a.path === page ? 0 : 1) - (b.path === page ? 0 : 1) ||
      vRank(a.viewport) - vRank(b.viewport),
  )[0];
}

function pinOf(
  el: TutorialUiElement,
  fill: { kind: MemoSlotKind } | null,
): MemoPin {
  const tag = (PIN_TAGS as readonly string[]).includes(el.tag)
    ? (el.tag as MemoPin['tag'])
    : 'other';
  return {
    role: roleOf(el),
    assistId: assistIdOf(el),
    text: el.label,
    tag,
    href: null,
    submit: false,
    inForm: !!fill,
    pd: !!fill && (fill.kind === 'email' || fill.kind === 'phone'),
    inputType:
      fill?.kind === 'email'
        ? 'email'
        : fill?.kind === 'phone'
          ? 'tel'
          : fill?.kind === 'number'
            ? 'number'
            : null,
    toggle: false,
    stability:
      el.stability === 'strong' ||
      el.stability === 'medium' ||
      el.stability === 'fragile'
        ? el.stability
        : null,
  };
}

const okText = (t: string | null, max: number): string | null => {
  if (!t) return null;
  const s = t.replace(/\s+/g, ' ').trim().slice(0, max);
  return s && !memoTextProblem(s, max) ? s : null;
};

export function memoFromTutorial(
  src: TutorialMemoSteps,
  elements: readonly TutorialUiElement[],
  lang: MemoLang,
): MemoFromTutorialResult {
  const c = emptyMemoContent();
  c.view = src.view;
  let page: string | null = src.startPath;
  const unresolved: number[] = [];
  let slotsOverflow = 0;
  const slotN = new Map<MemoSlotKind, number>();
  for (const s of src.steps) {
    if (s.kind === 'navigate') {
      page = s.path;
      continue;
    }
    const fill = s.kind === 'fill' ? { kind: s.field as MemoSlotKind } : null;
    const el = findTutorialElement(elements, s.selector, page, src.view);
    if (el) page = el.path;
    let value: MemoStep['value'] = null;
    if (fill) {
      if (c.slots.length < MEMO_LIMITS.slots) {
        const n = (slotN.get(fill.kind) ?? 0) + 1;
        slotN.set(fill.kind, n);
        const name = n > 1 ? `${fill.kind}_${n}` : fill.kind;
        c.slots.push({
          name,
          kind: fill.kind,
          pii: fill.kind === 'email' || fill.kind === 'phone',
          options: [],
        });
        value = { slot: name };
      } else slotsOverflow++;
    }
    if (!el) unresolved.push(c.steps.length);
    c.steps.push({
      page: page ?? '/',
      action: s.kind,
      target: el
        ? {
            uiElementId: el.id,
            key: el.elementKey.slice(0, 200),
            mapKey: null,
            pin: pinOf(el, fill),
          }
        : null,
      value,
      expect: null,
      say: null,
      risk: null,
    });
  }
  // Ссылка, после которой страница сменилась, — переход: путь — в отпечаток.
  c.steps.forEach((st, i) => {
    const pin = st.target?.pin;
    if (!pin || st.action !== 'click') return;
    if (pin.tag !== 'a' && pin.role !== 'link') return;
    const next = c.steps[i + 1]?.page ?? src.endPath;
    if (next && next !== st.page && !next.includes('*')) pin.href = next;
  });
  const first = c.steps[0]?.page ?? src.startPath;
  if (src.endPath && src.endPath !== first)
    c.goal.expect.push({ kind: 'url', path: src.endPath });
  const title = okText(src.title, MEMO_LIMITS.nameChars);
  c.names[lang] = title ?? DEFAULT_NAME[lang];
  const goal = okText(src.title, MEMO_LIMITS.goalTextChars);
  if (goal) c.goal.text[lang] = goal;
  // Тот же строгий разбор, что у черновика из TMA (маска подписей, ПД слотов).
  const parsed = parseMemoContent(JSON.parse(JSON.stringify(c)));
  return { content: parsed.content, unresolved, slotsOverflow };
}
