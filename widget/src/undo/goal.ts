/**
 * Проверка цели мемо «счётчик ±N» и «значение поля = слот» (Э6-тер (к), ТЗ
 * §5-бис.17 п.3, п.5 п.7) — в ленивом чанке `undo.js`: act.js и загрузчик
 * не растут. Протокол минимальный: iframe шлёт ту же команду `ui-undo` с
 * полем `goal` (номер шага цели и проверки из шага плана — их собрал
 * сервер: ожидаемое значение счётчика = исходное из снимка команды + N,
 * поле — значение слота), чанк отвечает `ui-goal { planId, i, ok }` —
 * только «да/нет», без значений со страницы.
 *
 * Счётчики корзины обновляются не сразу (AJAX-фрагменты): проверка
 * повторяется каждые 250 мс до 4 с. Цель — по `data-assist-id`, иначе по
 * ключу подписи (буквы без чисел): ссылки/кнопки для счётчика, поля ввода
 * для значения. Пароль, скрытое поле, файл, `cc-*`, одноразовый код — не
 * читаются никогда (ok = false).
 *
 * Порт чтения счётчика и ключа подписи — `sites-backend/src/modules/
 * assist-ui-core/memo-goal.ts` (`goalCountIn`, `goalLabelKey`), сверка —
 * `scripts/memo-goal.test.ts`. Без lookbehind в регулярках (Safari < 16.4).
 */
import type { ActHost } from '../act/index';

const PLAN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ASSIST_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const NUM = /\d{1,3}(?:[ \u00a0]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)*/g;
const TRIES = 16;
const EVERY_MS = 250;

/** Значение счётчика: ровно одно целое; чисел нет — 0; иначе null. */
export function countIn(text: string): number | null {
  const toks = text.replace(/\s+/g, ' ').match(NUM) || [];
  if (!toks.length) return 0;
  const ints = toks.filter((t) => /^\d+$/.test(t));
  return ints.length == 1 && ints[0].length <= 6 ? Number(ints[0]) : null;
}

const norm = (v: string) =>
  v
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();

/** Ключ подписи: регистр, ё/е, без чисел и знаков. */
export function labelKey(text: string): string {
  return norm(text)
    .replace(NUM, ' ')
    .replace(/[^\p{L}]+/gu, ' ')
    .trim()
    .slice(0, 60);
}

interface Loc {
  id: string | null;
  t: string;
}

function loc(v: unknown): Loc | null {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o != 'object') return null;
  const id = typeof o.id == 'string' && ASSIST_ID.test(o.id) ? o.id : null;
  const t = typeof o.t == 'string' ? labelKey(o.t) : '';
  return id || t ? { id, t } : null;
}

const isField = (el: Element) => /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName);

/** Поле, которое не читаем никогда (§5-бис.5). */
function secret(el: Element): boolean {
  const f = el as HTMLInputElement;
  const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
  return (
    /^(password|hidden|file)$/.test(f.type || '') ||
    /(^|\s)(cc-|one-time-code|current-password|new-password)/.test(ac)
  );
}

function label(el: Element): string {
  if (!isField(el)) return (el as HTMLElement).innerText || '';
  const f = el as HTMLInputElement;
  const lab = f.labels && f.labels[0];
  return (
    (lab && (lab as HTMLElement).innerText) ||
    f.placeholder ||
    el.getAttribute('aria-label') ||
    ''
  );
}

function targets(l: Loc, field: boolean): Element[] {
  const all = Array.from(
    document.querySelectorAll(
      l.id
        ? `[data-assist-id="${l.id}"]`
        : field
          ? 'input,select,textarea'
          : 'a,button,[role]'
    )
  );
  return all.filter(
    (el) =>
      (!field || (isField(el) && !secret(el))) &&
      (l.id ? true : labelKey(label(el)) === l.t)
  );
}

function fieldHas(el: Element, want: string): boolean {
  if (el instanceof HTMLSelectElement) {
    const o = el.selectedOptions && el.selectedOptions[0];
    return !!o && (norm(o.text) == want || norm(o.value) == want);
  }
  return norm((el as HTMLInputElement).value || '') == want;
}

/** Разобрать запрос iframe, проверить (с повторами) и ответить `ui-goal`. */
export function goal(raw: Record<string, unknown>, host: ActHost): void {
  const g = raw.goal as Record<string, unknown> | null;
  const i = g && g.i;
  if (
    typeof raw.planId != 'string' ||
    !PLAN_ID.test(raw.planId) ||
    !g ||
    typeof i != 'number' ||
    !Number.isInteger(i) ||
    i < 0 ||
    i > 20
  )
    return;
  const planId = raw.planId;
  const c = g.count as Record<string, unknown> | null;
  const f = g.field as Record<string, unknown> | null;
  const cl = c ? loc(c) : null;
  const fl = f ? loc(f) : null;
  const ceq =
    c && typeof c.eq == 'number' && Number.isInteger(c.eq) && c.eq >= 0
      ? c.eq
      : null;
  const feq = f && typeof f.eq == 'string' ? norm(f.eq).slice(0, 200) : '';
  // Пустой или битый запрос — «нет», а не «готово».
  const bad =
    (!c && !f) || (c && (!cl || ceq === null)) || (f && (!fl || !feq));
  const check = () =>
    !bad &&
    // Любая копия значка (шапка, меню телефона) с ожидаемым числом.
    (!cl || targets(cl, false).some((el) => countIn(label(el)) === ceq)) &&
    (!fl || targets(fl, true).some((el) => fieldHas(el, feq)));
  let n = 0;
  const tick = () => {
    const ok = check();
    if (ok || bad || ++n >= TRIES)
      return host.post({ type: 'ui-goal', planId, i, ok: !!ok });
    host.N.later(tick, EVERY_MS);
  };
  tick();
}
