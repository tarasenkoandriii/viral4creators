/**
 * Цепочки действий и откат (Э6-бис (д), ТЗ помощника §5-бис.15–16; решения
 * владельца Р-63…Р-67) — ЧИСТЫЕ правила без базы:
 *  - класс обратимости шага `undo` (п.3) — по фактам о цели, не по модели;
 *  - точка невозврата (ТН, п.4): первый `irrev`; не больше одной на
 *    команду; после неё — только `none`/`nav`;
 *  - нужно ли второе «Да» прямо перед ТН (Р-60, В-65);
 *  - статус цепочки после плана (п.11) и что можно вернуть («отмени
 *    последнее», «Вернуть / Оставить» — п.6 п.4, п.7, В-66, В-67).
 * Слово «откат» посетителю не говорим (п.10): возвращаем ПОЛЯ этой
 * страницы (прежние значения — только в памяти `act.js`), серверные
 * действия («В кошик») — «уберите сами» до компенсаций Э6-тер (и).
 */
import { REVERSIBLE_ASSIST_IDS } from './action-words';
import { CHAIN_DECISIONS } from './decisions';
import type { ChainStatus, UiPlanStep, UiStepKind, UiUndo } from './types';

/** Факты о цели, которых достаточно для класса обратимости. */
export interface UndoFacts {
  role: string | null;
  tag: string;
  href: string | null;
  assistId: string | null;
  submit: boolean;
  inForm: boolean;
  toggle: boolean;
}

const NO_EFFECT: ReadonlySet<UiStepKind> = new Set([
  'scroll',
  'highlight',
  'wait',
  'say',
]);

/**
 * Класс обратимости (§5-бис.15 п.3). Умолчание для шага с эффектом —
 * `irrev`; `comp`/`local` — только по признакам: обратимые действия
 * посетителя (`REVERSIBLE_ASSIST_IDS`) — всегда `comp` и не ТН (п.3 п.1);
 * поле вне `<form>` — `comp` (сохраняется сразу, п.3 п.2); поле в форме и
 * раскрытие меню/вкладки — `local`; переход по ссылке — `nav`.
 */
export function undoClass(
  kind: UiStepKind,
  f: UndoFacts | null,
  nav: boolean,
): UiUndo {
  if (NO_EFFECT.has(kind)) return 'none';
  if (!f) return 'irrev';
  if (kind === 'fill' || kind === 'select' || kind === 'check')
    return f.inForm ? 'local' : 'comp';
  if (kind !== 'click' && kind !== 'navigate') return 'irrev';
  if (f.assistId && REVERSIBLE_ASSIST_IDS.has(f.assistId)) return 'comp';
  if (f.submit) return 'irrev';
  if (nav && f.href && (f.role === 'link' || f.tag === 'a')) return 'nav';
  if (f.toggle) return 'local';
  return 'irrev';
}

/**
 * Предварительный класс шага «после перехода» (цели ещё нет — только
 * описание): ссылка — `nav`, вкладка — `local`, обратимая разметка —
 * `comp`, поле — `local`; остальное — `irrev`. Окончательно — по новому
 * снимку (`resolveAfterSteps`), только в сторону ухудшения.
 */
export function provisionalUndo(
  kind: UiStepKind,
  d: { role: string | null; assistId: string | null },
): UiUndo {
  if (NO_EFFECT.has(kind)) return 'none';
  if (kind === 'fill' || kind === 'select' || kind === 'check') return 'local';
  if (d.assistId && REVERSIBLE_ASSIST_IDS.has(d.assistId)) return 'comp';
  if (d.role === 'link') return 'nav';
  if (d.role === 'tab') return 'local';
  return 'irrev';
}

const UNDO_RANK: Record<UiUndo, number> = {
  none: 0,
  nav: 1,
  local: 2,
  comp: 3,
  irrev: 4,
};

/** Хуже из двух (код может только ухудшить класс к `irrev`). */
export function worseUndo(a: UiUndo, b: UiUndo): UiUndo {
  return UNDO_RANK[a] >= UNDO_RANK[b] ? a : b;
}

/** Точка невозврата — первый `irrev` (п.4); null — ТН нет. */
export function pointOfNoReturn(
  steps: ReadonlyArray<Pick<UiPlanStep, 'undo' | 'risk'>>,
): number | null {
  const i = steps.findIndex(
    (s) => s.undo === 'irrev' && (s.risk === 'auto' || s.risk === 'confirm'),
  );
  return i < 0 ? null : i;
}

/** После ТН допускаются только шаги без эффекта и переходы (п.4 п.1). */
export function allowedAfterPnr(u: UiUndo): boolean {
  return u === 'none' || u === 'nav';
}

/**
 * Нужно ли второе «Да» прямо перед ТН (Р-60, В-65): одна карточка
 * подтверждает ТН, только если ТН на той же странице, где показана
 * карточка, и окно подтверждения (60 с с показа) не истекло. Иначе —
 * отдельная карточка «после этого отменить нельзя».
 */
export function needsSecondYes(p: {
  steps: ReadonlyArray<Pick<UiPlanStep, 'nav'>>;
  pnr: number;
  /** Номер шага, с которого показана последняя подтверждённая карточка. */
  cardFrom: number;
  /** Конец окна подтверждения последней карточки (показ + 60 с). */
  confirmBefore: Date;
  now: Date;
  pnrConfirmed: boolean;
}): boolean {
  if (p.pnrConfirmed) return false;
  if (!CHAIN_DECISIONS.oneCardPerChain) return true;
  if (p.now.getTime() > p.confirmBefore.getTime()) return true;
  if (!CHAIN_DECISIONS.secondYesAfterNavigation) return false;
  for (let k = Math.max(0, p.cardFrom); k < p.pnr; k++)
    if (p.steps[k]?.nav) return true;
  return false;
}

/** Шаг плана с состоянием (форма `UiPlanStepView` публичного кода). */
export interface ChainStep {
  kind: UiStepKind;
  undo?: UiUndo;
  risk: string;
  state: string;
  /** Шаг дошёл до `dispatched` — действие могло произойти. */
  fx?: boolean;
  target: { text: string } | null;
}

const undoOf = (s: ChainStep): UiUndo => s.undo ?? 'irrev';

/** Следы на сайте: шаги с эффектом, до которых дошло исполнение. */
function traces(steps: readonly ChainStep[]): ChainStep[] {
  return steps.filter(
    (s) => s.fx === true && ['local', 'comp', 'irrev'].includes(undoOf(s)),
  );
}

/**
 * Статус цепочки при завершении плана (п.11). `done` — `committed`; сбой
 * и стоп — `clean` без следов, `unknown` при шаге без результата
 * (`dispatched`, прерван перезагрузкой, провал после действия), иначе
 * `kept` (до ответа на «Вернуть / Оставить» и при «оставить»).
 */
export function chainStatusOf(
  steps: readonly ChainStep[],
  planStatus: string,
): ChainStatus {
  if (planStatus === 'done') {
    const t = traces(steps);
    return t.some((s) => s.state !== 'done') ? 'unknown' : 'committed';
  }
  const t = traces(steps);
  if (!t.length) return 'clean';
  if (t.some((s) => s.state !== 'done')) return 'unknown';
  // ТН сделана — цепочка зафиксирована (возвратов после ТН нет, п.4 п.4).
  if (t.some((s) => undoOf(s) === 'irrev')) return 'committed';
  return 'kept';
}

/** Что можно вернуть по «Вернуть»/«отмени последнее» (п.6 п.4–8, п.7). */
export interface UndoCandidates {
  /** Поля (fill/select/check) — прежние значения в памяти `act.js`. */
  fields: number[];
  /** Серверные обратимые действия — «уберите сами» до Э6-тер (и). */
  manual: number[];
  /** Почему возвращать нечего/нельзя. */
  refused: 'after_pnr' | 'nothing' | 'unknown' | null;
}

const FIELD_KINDS: ReadonlySet<UiStepKind> = new Set([
  'fill',
  'select',
  'check',
]);

/**
 * Кандидаты возврата в ОБРАТНОМ порядке (последний сделанный — первым),
 * не больше `maxUndoSteps`. Только шаги с результатом `done` (шаг
 * `dispatched` без результата не возвращается — «мог не выполниться», п.6
 * п.5). После выполненной ТН — ничего (п.4 п.4: отправленная форма —
 * часть результата; поля этой формы не возвращаются, п.7).
 */
export function undoCandidates(steps: readonly ChainStep[]): UndoCandidates {
  const t = traces(steps);
  if (t.some((s) => undoOf(s) === 'irrev'))
    return { fields: [], manual: [], refused: 'after_pnr' };
  const done: number[] = [];
  steps.forEach((s, i) => {
    if (
      s.fx === true &&
      s.state === 'done' &&
      (undoOf(s) === 'local' || undoOf(s) === 'comp')
    )
      done.push(i);
  });
  const pick = done.reverse().slice(0, CHAIN_DECISIONS.maxUndoSteps);
  if (!pick.length)
    return {
      fields: [],
      manual: [],
      refused: t.length ? 'unknown' : 'nothing',
    };
  return {
    fields: pick.filter((i) => FIELD_KINDS.has(steps[i].kind)),
    manual: pick.filter((i) => !FIELD_KINDS.has(steps[i].kind)),
    refused: null,
  };
}

/** Итог возврата поля у загрузчика (`undo.js`). */
export type UndoResult = 'done' | 'failed' | 'unknown' | 'gone';

/**
 * Статус цепочки после возврата (п.6 п.6–7, п.11): все следы вернулись и
 * проверены — `compensated`; хоть один не проверить (React откатил,
 * страница сменилась) — `unknown`; остальное — `partially_compensated`
 * (в т.ч. «уберите сами» для корзины — пока Э6-тер (и)).
 */
export function chainAfterUndo(
  steps: readonly ChainStep[],
  results: ReadonlyArray<{ i: number; result: UndoResult }>,
): ChainStatus {
  const t = traces(steps).length;
  const done = results.filter((r) => r.result === 'done').length;
  if (results.some((r) => r.result === 'unknown')) return 'unknown';
  if (t > 0 && done === t) return 'compensated';
  return 'partially_compensated';
}
