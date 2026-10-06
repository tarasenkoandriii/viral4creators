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
 * действия («В кошик») — объявленной компенсацией (Э6-тер (и), ниже) или
 * «уберите сами».
 *
 * Э6-тер (и) «Компенсации» (§5-бис.15 п.6, п.8; Р-59, Р-64…Р-66):
 *  - пара компенсации — ТОЛЬКО объявленная: встроенная пара стандартной
 *    разметки (`STANDARD_UNDO_PAIRS`) или «Как отменить» голосовой карты;
 *    по тексту кнопки и из ответа модели — никогда (`compFor`);
 *  - обратная цель пары не из стоп-листа; исключение — «удаление» (п.6
 *    п.3: только своя разметка в строке того же товара — сверяет загрузчик)
 *    и «отписка» от БЕСПЛАТНОЙ подписки (`sub`); платное — никогда;
 *  - стек компенсаций — в шагах плана (`comp`, без значений), исполнение —
 *    по одному шагу в обратном порядке (`nextUndo`): `dispatched` ДО
 *    действия, сбой компенсации — стоп остальных (п.6 п.7), шаг
 *    `dispatched` без итога (перезагрузка) — `unknown`, не повтор.
 */
import {
  NEVER_KINDS,
  REVERSIBLE_ASSIST_IDS,
  actionKindsFor,
  paymentPath,
  type ActionKind,
} from './action-words';
import {
  CHAIN_DECISIONS,
  STANDARD_UNDO_PAGES,
  STANDARD_UNDO_PAIRS,
} from './decisions';
import { assistIdWords } from './normalize';
import { PATH_MASK_RE } from './rules';
import { ASSIST_ID_RE, cleanText } from './snapshot';
import type {
  ChainStatus,
  UiComp,
  UiPlanStep,
  UiStepKind,
  UiUndo,
  UiUndoState,
} from './types';

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
 * Э6-тер (и): кнопка с ОБЪЯВЛЕННОЙ парой компенсации (`declared` — «Как
 * отменить» карты, проверенная `compFor`) — `comp` (п.3 «с объявленной
 * компенсацией»); отправка формы — `irrev` всегда, пара её не «разрешает».
 */
export function undoClass(
  kind: UiStepKind,
  f: UndoFacts | null,
  nav: boolean,
  declared = false,
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
  if (declared) return 'comp';
  return 'irrev';
}

// ── Э6-тер (и): пары компенсаций (§5-бис.15 п.6 п.1–3) ──────────────────

/** Пределы компенсации: описание строки товара и путь страницы отмены. */
export const COMP_LIMITS = {
  rowChars: 80,
  /** Описание короче — строку не узнать (подпись «В кошик» не описание). */
  rowMinLetters: 3,
  atChars: 200,
} as const;

/**
 * Обратная цель пары безопасна (п.6 п.2–3, п.15): её разметка не из
 * стоп-листа «никогда». Исключения — только по разметке: «удаление»
 * (убрать СВОЮ строку того же товара, сверяет загрузчик) и «отписка» —
 * если прямое действие — бесплатная подписка (`sub`). Оплата, оформление,
 * отмена заказа, возврат, списание, платная подписка — никогда.
 */
export function compPairSafe(reverseId: string, sub = false): boolean {
  if (!ASSIST_ID_RE.test(reverseId)) return false;
  const words = assistIdWords(reverseId);
  if (paymentPath(`/${reverseId}`)) return false;
  return !actionKindsFor(words).some(
    (k) =>
      NEVER_KINDS.has(k) &&
      k !== 'удаление' &&
      !(sub && k === 'отмена подписки'),
  );
}

/** Путь страницы отмены: тот же хост (только путь), не оплата, без маски. */
export function compAtOk(at: string): boolean {
  return (
    at.length <= COMP_LIMITS.atChars &&
    PATH_MASK_RE.test(at) &&
    !at.startsWith('//') &&
    !at.includes('*') &&
    !paymentPath(at)
  );
}

/**
 * Описание строки товара — заголовок карточки цели. Обрезанный снимком
 * («…») — без последнего, возможно неполного слова: загрузчик сверяет
 * строку по целым словам.
 */
export function compRow(heading: string | null): string | null {
  const h = cleanText(heading ?? '', COMP_LIMITS.rowChars);
  if (!h) return null;
  const row = (
    h.endsWith('…') ? h.slice(0, -1).replace(/\s*\S*$/u, '') : h
  ).trim();
  return (row.match(/\p{L}/gu) ?? []).length >= COMP_LIMITS.rowMinLetters
    ? row
    : null;
}

/** Факты прямого действия, по которым ставится компенсация. */
export interface CompFacts {
  assistId: string | null;
  /** Заголовок карточки цели (снимок) — описание строки товара. */
  heading: string | null;
  /** Видимый текст цели: бесплатная подписка (`подписка` без цены рядом). */
  text: string;
}

/** Обратная цель — «удаление» (убрать строку): нужна сверка строки товара. */
export function compRemoves(reverseId: string): boolean {
  return actionKindsFor(assistIdWords(reverseId)).includes('удаление');
}

/**
 * Компенсация шага `comp` (п.6 п.1): объявленная пара карты («Как
 * отменить», `declared`) или встроенная пара стандартной разметки — иначе
 * null («уберите сами»). Страница отмены — объявленная владельцем или
 * адрес ссылки стандартной разметки этой страницы (`navPath`, `nav-cart`);
 * нет — эта же страница. Обратная цель-«удаление» без описания строки
 * товара — null: «удалить» без сверки строки не исполняется (п.6 п.3).
 */
export function compFor(p: {
  facts: CompFacts;
  declared: { assistId: string; at: string | null } | null;
  navPath: (navAssistId: string) => string | null;
}): UiComp | null {
  const std = p.facts.assistId
    ? (STANDARD_UNDO_PAIRS[p.facts.assistId] ?? null)
    : null;
  const reverse = p.declared?.assistId ?? std;
  if (!reverse) return null;
  const kinds: ActionKind[] = actionKindsFor(
    `${p.facts.text} ${assistIdWords(p.facts.assistId)}`,
    p.facts.heading,
  );
  const sub = kinds.includes('подписка') && !kinds.includes('платная подписка');
  if (!compPairSafe(reverse, sub)) return null;
  const row = compRow(p.facts.heading);
  if (!row && compRemoves(reverse)) return null;
  let at = p.declared ? p.declared.at : null;
  const nav = STANDARD_UNDO_PAGES[reverse];
  if (!at && nav) at = p.navPath(nav);
  if (at !== null && !compAtOk(at)) return null;
  return {
    assistId: reverse,
    at,
    row,
    src: p.declared ? 'map' : 'standard',
    ...(sub ? { sub: true as const } : {}),
  };
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
  /** (Э6-тер (и)) Объявленная компенсация шага (стек на сервере). */
  comp?: UiComp | null;
  /** (Э6-тер (и)) Состояние возврата шага после «Вернуть». */
  undone?: UiUndoState | null;
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
  /** Серверные обратимые действия без объявленной пары — «уберите сами». */
  manual: number[];
  /** (Э6-тер (и)) Серверные действия с объявленной компенсацией (`comp`). */
  comp: number[];
  /** (Э6-тер (и)) Поля и компенсации — в обратном порядке исполнения. */
  order: number[];
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
    return {
      fields: [],
      manual: [],
      comp: [],
      order: [],
      refused: 'after_pnr',
    };
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
      comp: [],
      order: [],
      refused: t.length ? 'unknown' : 'nothing',
    };
  const field = (i: number) => FIELD_KINDS.has(steps[i].kind);
  // Компенсация — только клик с объявленной парой (поле вне формы — своё
  // прежнее значение из памяти загрузчика, это `fields`).
  const comp = (i: number) => !field(i) && !!steps[i].comp;
  return {
    fields: pick.filter(field),
    manual: pick.filter((i) => !field(i) && !comp(i)),
    comp: pick.filter(comp),
    order: pick.filter((i) => field(i) || comp(i)),
    refused: null,
  };
}

/** Итог возврата поля у загрузчика (`undo.js`) и компенсации (`comp.js`). */
export type UndoResult = 'done' | 'failed' | 'unknown' | 'gone';

/**
 * Следующий шаг возврата (Э6-тер (и), п.6 п.4–7) по состоянию в плане:
 *  - `fields` — подряд идущие поля (обратный порядок) — загрузчику разом;
 *  - `comp` — одна компенсация: сначала `dispatched` (один раз), потом
 *    действие и итог;
 *  - `stale` — компенсация отдана, итога нет (перезагрузка/закрытие): НЕ
 *    повторяется — `unknown`, «проверьте корзину» (п.6 п.5, п.8);
 *  - `end` — всё сделано или сбой компенсации остановил остальные (п.6 п.7).
 */
export type UndoNext =
  | { kind: 'fields'; idx: number[] }
  | { kind: 'comp'; i: number }
  | { kind: 'stale'; i: number }
  | { kind: 'end' };

export function nextUndo(steps: readonly ChainStep[]): UndoNext {
  const c = undoCandidates(steps);
  if (c.refused) return { kind: 'end' };
  const isComp = new Set(c.comp);
  for (let k = 0; k < c.order.length; k++) {
    const i = c.order[k];
    const st = steps[i].undone ?? null;
    if (st === 'dispatched') return { kind: 'stale', i };
    if (st) {
      // Сбой компенсации — стоп всей компенсации (оставшиеся не исполняются).
      if (isComp.has(i) && st !== 'done') return { kind: 'end' };
      continue;
    }
    if (isComp.has(i)) return { kind: 'comp', i };
    const idx: number[] = [];
    for (let j = k; j < c.order.length; j++) {
      const x = c.order[j];
      if (isComp.has(x) || steps[x].undone) break;
      idx.push(x);
    }
    return { kind: 'fields', idx };
  }
  return { kind: 'end' };
}

/** Итоги возврата из состояния шагов (`dispatched` без итога — `unknown`). */
export function undoResults(
  steps: readonly ChainStep[],
): Array<{ i: number; result: UndoResult }> {
  const out: Array<{ i: number; result: UndoResult }> = [];
  steps.forEach((s, i) => {
    if (!s.undone) return;
    out.push({
      i,
      result: s.undone === 'dispatched' ? 'unknown' : s.undone,
    });
  });
  return out;
}

/**
 * Статус цепочки после возврата (п.6 п.6–7, п.11): все следы вернулись и
 * проверены — `compensated`; хоть один не проверить (React откатил,
 * страница сменилась, компенсация отдана без итога) — `unknown`; остальное —
 * `partially_compensated` (сбой компенсации, «уберите сами» без пары).
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
