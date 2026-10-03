/**
 * «Вернуть как было» для ПОЛЕЙ (Э6-бис (д), ТЗ §5-бис.15 п.7, Р-64, Р-65) —
 * ленивый чанк `undo.js`; его берёт `act.js` по команде своего iframe
 * `ui-undo` (после «Вернуть» или «отмени последнее»), рядом с собой — тот
 * же выпуск. act.js и загрузчик не растут (бюджеты — size-budget.mjs).
 *
 * Прежние значения — только в памяти `act.js` этой страницы (`mem`): не в
 * sessionStorage, не на сервере, не в журнале — ПД из автозаполнения не
 * покидают браузер. Наружу уходит только итог по номерам шагов
 * (`done | failed | unknown | gone`), без значений.
 *
 * Возврат — тем же нативным сеттером прототипа + `input`/`change` (флажок —
 * нативным кликом); через 300 мс проверка: значение равно прежнему —
 * `done`; контролируемое поле его откатило — `unknown` («проверьте поле»);
 * элемента уже нет (переход SPA, перерисовка) — `gone` («вернуть не могу»).
 * Серверные действия («В кошик») здесь не возвращаются никогда.
 */
import type { Prior } from '../act/exec';
import type { ActHost } from '../act/index';

const PLAN_ID = /^[A-Za-z0-9_-]{1,64}$/;

type Result = 'done' | 'failed' | 'unknown' | 'gone';

function setValue(el: Element, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  const d = Object.getOwnPropertyDescriptor(proto, 'value');
  if (d && d.set) d.set.call(el, value);
  else (el as HTMLInputElement).value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

const isFlag = (el: Element) =>
  el instanceof HTMLInputElement &&
  (el.type === 'checkbox' || el.type === 'radio');

const same = (p: Prior) => {
  const el = p[2] as HTMLInputElement;
  return isFlag(el) ? el.checked === p[4] : el.value === p[3];
};

export function undo(raw: unknown, mem: Prior[], host: ActHost): void {
  const r = raw as Record<string, unknown> | null;
  if (
    !r ||
    typeof r.planId !== 'string' ||
    !PLAN_ID.test(r.planId) ||
    !Array.isArray(r.idx) ||
    r.idx.length > 3
  )
    return;
  const planId = r.planId;
  const todo: Array<{ i: number; p: Prior | null; res: Result }> = [];
  for (const i of r.idx) {
    if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i > 20)
      continue;
    let p: Prior | null = null;
    for (const x of mem) if (x[0] === planId && x[1] === i) p = x;
    if (!p || !p[2].isConnected) {
      todo.push({ i, p: null, res: 'gone' });
      continue;
    }
    const el = p[2];
    try {
      if (isFlag(el)) {
        if (!same(p)) {
          const c = host.N.click;
          if (c && el instanceof HTMLElement) c.call(el);
          else (el as HTMLElement).click();
        }
      } else setValue(el, p[3]);
      todo.push({ i, p, res: 'done' });
    } catch {
      todo.push({ i, p, res: 'failed' });
    }
  }
  // Контролируемое поле (React/Vue) может откатить значение — проверяем
  // после оседания; не сошлось — `unknown`, без слова «вернул».
  host.N.later(() => {
    host.post({
      type: 'ui-undone',
      planId,
      results: todo.map((t) => ({
        i: t.i,
        result:
          t.res !== 'done' || !t.p
            ? t.res
            : !t.p[2].isConnected
              ? 'gone'
              : same(t.p)
                ? 'done'
                : 'unknown',
      })),
    });
  }, 300);
}
