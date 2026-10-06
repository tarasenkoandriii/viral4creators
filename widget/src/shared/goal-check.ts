/**
 * Проверки цели мемо «счётчик ±N» и «значение поля = слот» в шаге ожидания
 * плана (Э6-тер (к), ТЗ §5-бис.17 п.3) — форма и строгий разбор на стороне
 * iframe. Сервер кладёт их в `expect.count`/`expect.field` последнего шага
 * цели (`assist-ui-core/memo-goal.ts`); исполнитель act.js их не видит
 * (`parseStep` их отбрасывает — act.js не растёт): после `done` этого шага
 * iframe просит чанк undo.js проверить страницу (`ui-undo` + `goal`) и
 * только потом сообщает серверу итог шага.
 */
const ASSIST_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

export interface UiGoalLoc {
  id: string | null;
  /** Ключ подписи (буквы без чисел), ≤ 60. */
  t: string;
}

export interface UiGoalCheck {
  /** Номер шага цели в плане. */
  i: number;
  count?: UiGoalLoc & { eq: number };
  field?: UiGoalLoc & { eq: string };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

function loc(v: Record<string, unknown>): UiGoalLoc | null {
  const id = typeof v.id === 'string' && ASSIST_ID.test(v.id) ? v.id : null;
  const t =
    typeof v.t === 'string' && v.t.length <= 60 && !/[<>`]/.test(v.t)
      ? v.t
      : '';
  return id || t ? { id, t } : null;
}

/** Проверки цели из сырого шага плана (только `wait`); нет — null. */
export function goalCheckOf(raw: unknown, i: number): UiGoalCheck | null {
  if (!isObj(raw) || raw.kind !== 'wait' || !isObj(raw.expect)) return null;
  const e = raw.expect;
  const out: UiGoalCheck = { i };
  if (isObj(e.count)) {
    const l = loc(e.count);
    const eq = e.count.eq;
    if (
      l &&
      typeof eq === 'number' &&
      Number.isInteger(eq) &&
      eq >= 0 &&
      eq <= 999_999
    )
      out.count = { ...l, eq };
  }
  if (isObj(e.field)) {
    const l = loc(e.field);
    const eq = e.field.eq;
    if (l && typeof eq === 'string' && eq && eq.length <= 200)
      out.field = { ...l, eq };
  }
  return out.count || out.field ? out : null;
}
