/**
 * Условия цели мемо «счётчик ±N» и «значение поля = слот» (ТЗ помощника
 * §5-бис.17 п.3, п.5 п.7; Э6-тер (к), хвост (11)) — чистая часть без базы:
 * чтение счётчика из видимого текста, ключ подписи (без чисел), поиск цели
 * условия в снимке, сборка проверок для последнего шага ожидания плана и их
 * строгий разбор в `checkPlan`.
 *
 * Как проверяется (честное «Готово» для корзины и форм):
 *  - счётчик: исходное значение — из СНИМКА страницы, по которому строится
 *    план (сервер видит подпись элемента в момент команды), ожидаемое =
 *    исходное + N уходит в шаг ожидания цели; после перехода страниц
 *    исходное не теряется (оно уже в шаге плана). Нет элемента в снимке или
 *    число не читается однозначно — условие НЕ проверяемо: цель плана —
 *    `unknown` («проверьте…»), без слова «готово»;
 *  - поле: ожидаемое значение — слот этой команды (ПД-слоты ворота не
 *    пускают, как условие «текст = слот»);
 *  - на странице посетителя проверку делает ленивый чанк `undo.js` (act.js
 *    не растёт) по запросу iframe; итог — только «да/нет», без значений.
 * Порт чтения счётчика и ключа подписи — `widget/src/undo/goal.ts` (сверку
 * держит `widget/scripts/memo-goal.test.ts`).
 */
import { normText } from './normalize';
import { ASSIST_ID_RE } from './snapshot';
import type { UiExpect, UiSnapElement, UiSnapshot } from './types';

/** Цель условия: разметка `data-assist-id` или подпись (без чисел). */
export interface MemoGoalTarget {
  assistId: string | null;
  /** Ключ подписи — `goalLabelKey` (буквы, без чисел), ≤ 60. */
  text: string;
}

export const MEMO_GOAL_LIMITS = {
  /** |N| счётчика: 1…9 (больше за одну команду мемо не бывает). */
  maxDelta: 9,
  labelChars: 60,
  /** Ожидаемое значение поля в шаге — ≤ 200 (как значение слота). */
  fieldChars: 200,
  /** Счётчик — не больше 6 цифр (иначе это цена, а не количество). */
  maxCount: 999_999,
} as const;

/** Проверки последнего шага ожидания цели (поверх `UiExpect`). */
export interface MemoGoalCount {
  id: string | null;
  t: string;
  /** Ожидаемое значение счётчика после мемо. */
  eq: number;
}
export interface MemoGoalField {
  id: string | null;
  t: string;
  /** Ожидаемое значение поля (значение слота этой команды). */
  eq: string;
}
export type MemoGoalExpect = UiExpect & {
  count?: MemoGoalCount;
  field?: MemoGoalField;
};

// Число: тысячи через пробел (`1 200,50`) или с разделителем дробной части
// — ЦЕНА, не счётчик; целые без разделителей — кандидаты. Без lookbehind
// (Safari < 16.4 — порт в виджете).
const NUM_RE = /\d{1,3}(?:[ \u00a0]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)*/g;

/**
 * Значение счётчика в видимом тексте элемента: ровно одно целое число (цены
 * с дробной частью и тысячами не в счёт); чисел нет вовсе — 0 (пустой
 * значок корзины); иначе (два числа, только цена) — null: проверить нечем.
 */
export function goalCountIn(text: string): number | null {
  const toks = text.replace(/\s+/g, ' ').match(NUM_RE) ?? [];
  if (!toks.length) return 0;
  const ints = toks.filter((t) => /^\d+$/.test(t));
  if (ints.length !== 1 || ints[0].length > 6) return null;
  return Number(ints[0]);
}

/** Ключ подписи: регистр, ё/е, без чисел и знаков — «Кошик (2)» → «кошик». */
export function goalLabelKey(text: string): string {
  return normText(text)
    .replace(NUM_RE, ' ')
    .replace(/[^\p{L}]+/gu, ' ')
    .trim()
    .slice(0, MEMO_GOAL_LIMITS.labelChars);
}

/** Строгий разбор цели условия; null — мусор. */
export function parseGoalTarget(raw: unknown): MemoGoalTarget | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const assistId =
    typeof o.assistId === 'string' && ASSIST_ID_RE.test(o.assistId)
      ? o.assistId
      : null;
  const text = typeof o.text === 'string' ? goalLabelKey(o.text) : '';
  if (!assistId && !text) return null;
  return { assistId, text };
}

/** Элементы снимка — цель условия (разметка, иначе ключ подписи). */
export function goalTargetsIn(
  snapshot: Pick<UiSnapshot, 'elements'>,
  target: MemoGoalTarget,
  fieldsOnly = false,
): UiSnapElement[] {
  return snapshot.elements.filter((e) => {
    if (
      fieldsOnly &&
      !(e.tag === 'input' || e.tag === 'select' || e.tag === 'textarea')
    )
      return false;
    return target.assistId
      ? e.assistId === target.assistId
      : goalLabelKey(e.text) === target.text;
  });
}

/** Счётчик в снимке: все найденные элементы дают одно и то же число. */
export function goalCountInSnapshot(
  snapshot: Pick<UiSnapshot, 'elements'>,
  target: MemoGoalTarget,
): number | null {
  const found = goalTargetsIn(snapshot, target);
  if (!found.length) return null;
  const counts = new Set(found.map((e) => goalCountIn(e.text)));
  if (counts.size !== 1) return null;
  const [n] = [...counts];
  return n;
}

/** Условие цели «счётчик/поле» в форме мемо (тип повторяет `MemoGoalCond`). */
export type MemoGoalExtraCond =
  | { kind: 'counter'; target: MemoGoalTarget; delta: number }
  | { kind: 'field'; target: MemoGoalTarget; slot: string };

/**
 * Проверки для шага ожидания цели по снимку команды: счётчик — исходное из
 * снимка + N; поле — значение слота. `unchecked` — хоть одно условие
 * проверить нечем (элемента нет в снимке, число неоднозначно, слот пуст):
 * тогда цель плана — `unknown`, а не «готово».
 */
export function goalExtras(
  conds: ReadonlyArray<{ kind: string }>,
  values: Readonly<Record<string, string>>,
  snapshot: Pick<UiSnapshot, 'elements'>,
): { count?: MemoGoalCount; field?: MemoGoalField; unchecked: boolean } {
  const out: {
    count?: MemoGoalCount;
    field?: MemoGoalField;
    unchecked: boolean;
  } = { unchecked: false };
  for (const raw of conds) {
    const g = raw as MemoGoalExtraCond;
    if (g.kind === 'counter') {
      const base = goalCountInSnapshot(snapshot, g.target);
      const eq = base === null ? null : base + g.delta;
      if (eq === null || eq < 0 || eq > MEMO_GOAL_LIMITS.maxCount)
        out.unchecked = true;
      else out.count = { id: g.target.assistId, t: g.target.text, eq };
    } else if (g.kind === 'field') {
      const v = values[g.slot];
      if (typeof v !== 'string' || !v.trim()) out.unchecked = true;
      else
        out.field = {
          id: g.target.assistId,
          t: g.target.text,
          eq: v.trim().slice(0, MEMO_GOAL_LIMITS.fieldChars),
        };
    }
  }
  return out;
}

/**
 * Разбор проверок цели в шаге ожидания (`checkPlan`, только план мемо):
 * строго, лишнее — отброшено. Шаги модели этих полей не получают.
 */
export function cleanGoalExtras(raw: unknown): {
  count?: MemoGoalCount;
  field?: MemoGoalField;
} {
  const out: { count?: MemoGoalCount; field?: MemoGoalField } = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const o = raw as Record<string, unknown>;
  const loc = (v: Record<string, unknown>) => {
    const id =
      typeof v.id === 'string' && ASSIST_ID_RE.test(v.id) ? v.id : null;
    const t = typeof v.t === 'string' ? goalLabelKey(v.t) : '';
    return id || t ? { id, t } : null;
  };
  const c = o.count;
  if (c && typeof c === 'object' && !Array.isArray(c)) {
    const v = c as Record<string, unknown>;
    const l = loc(v);
    if (
      l &&
      typeof v.eq === 'number' &&
      Number.isInteger(v.eq) &&
      v.eq >= 0 &&
      v.eq <= MEMO_GOAL_LIMITS.maxCount
    )
      out.count = { ...l, eq: v.eq };
  }
  const f = o.field;
  if (f && typeof f === 'object' && !Array.isArray(f)) {
    const v = f as Record<string, unknown>;
    const l = loc(v);
    const eq =
      typeof v.eq === 'string'
        ? v.eq.replace(/\s+/g, ' ').trim().slice(0, MEMO_GOAL_LIMITS.fieldChars)
        : '';
    if (l && eq && !/[<>`]/.test(eq)) out.field = { ...l, eq };
  }
  return out;
}

/** Шаг ожидания с проверками цели (поверх уже очищенного `UiExpect`). */
export function withGoalExtras(
  base: UiExpect | null,
  raw: unknown,
): MemoGoalExpect | null {
  const x = cleanGoalExtras(raw);
  if (!x.count && !x.field) return base;
  return { ...(base ?? {}), ...x };
}
