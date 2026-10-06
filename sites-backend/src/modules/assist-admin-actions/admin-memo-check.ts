/**
 * Сухой прогон мемо «Админки» АМ-N — ЧИСТАЯ часть (аудит 06.10.2026, ТЗ
 * §5-бис.17 п.7 «закрытые страницы и «Админка» — всегда в браузере
 * владельца по одноразовой ссылке мастера», п.10). Механика страниц — ТА
 * ЖЕ, что у мемо «Сайта» (`memoCheckPage`/`memoCheckVerdict` нейтрального
 * ядра): мемо «Админки» переводится в форму «Сайта» (адаптер ниже), ядро
 * проверяет цели шагов по живому снимку (найдена, одна, отпечаток совпал,
 * риск по живому DOM не «никогда»), вердикт — тем же правилом.
 *
 * Отличия «Админки»:
 *  - у шагов `ui` нет маски страницы: страница — отрезок шагов до перехода
 *    (ссылка/вкладка-переход); страница образца относится к отрезку, если на
 *    ней найдена хоть одна цель отрезка;
 *  - шаги `ui` — только `none/nav/local` (ворота кода), на живой странице
 *    код дополнительно сверяет класс обратимости (`undoClass`, как план):
 *    `irrev` (кнопка, отправка, пункт меню без адреса) — провал;
 *  - шаги `api` в прогоне НЕ исполняются (ни чтение, ни write/danger):
 *    только наличие операции в каталоге, включённость, поддержка и права
 *    роли того, кто проверяет (§5-бис.17 п.10 — мемо не расширяет права);
 *  - цель «Админки» проверяется кодом в бою (все шаги `api` — `ok`), в
 *    прогоне — «последний отрезок на странице проверен».
 */
import {
  emptyMemoContent,
  memoCheckPage,
  memoCheckVerdict,
  type MemoCheckPage,
  type MemoContent,
  type MemoLang,
  type MemoSlot,
  type MemoStep,
  type MemoStepKind,
} from '../assist-ui-core/memo';
import { normText } from '../assist-ui-core/normalize';
import { undoClass } from '../assist-ui-core/chain';
import type {
  UiRole,
  UiStepKind,
  UiSnapshot,
  VoiceControlRules,
} from '../assist-ui-core/types';
import type { OperationKind } from '../assist-admin-mode/openapi-import';
import type { AdminMemoContent, MemoCatalogOp } from './admin-memo';

/** Ссылка мастера для прогона мемо «Админки» — 30 мин (как у «Сайта»). */
export const ADMIN_MEMO_CHECK = {
  /** Страниц образца на прогон (повторная проверка той же — заменяет). */
  maxPages: 20,
  /** Отчёт годен для публикации — пока версия та же (хеш содержимого). */
  reportVersion: 1,
} as const;

export type AdminMemoCheckResult = 'pass' | 'partial' | 'fail';

export type AdminMemoApiProblem =
  | 'operation_missing'
  | 'operation_unsupported'
  | 'operation_disabled'
  | 'forbidden';

export interface AdminMemoApiCheck {
  i: number;
  /** `<коннектор>.<operationId>` (для людей). */
  op: string;
  kind: OperationKind | null;
  ok: boolean;
  problem: AdminMemoApiProblem | null;
}

/** Итог проверки страницы образца (хранится в тесте мастера, не в браузере). */
export type AdminMemoCheckPage = MemoCheckPage;

export interface AdminMemoCheckReport {
  v: 1;
  kind: 'memo-check';
  /** Тест мастера (одноразовая ссылка), в котором прошёл прогон. */
  testId: string | null;
  version: number;
  contentHash: string;
  result: AdminMemoCheckResult;
  steps: Array<{
    i: number;
    page: string | null;
    ok: boolean;
    problem: string | null;
  }>;
  goal: 'ok' | 'missing' | 'unchecked';
  /** Фраза мемо уже занята другим опубликованным мемо сайта. */
  phraseConflicts: Array<{ lang: string; phrase: string }>;
  pages: string[];
  /** Кто прогнал (`jwt:<sub>` сотрудника-проверяющего). */
  by: string;
  at: string;
  /** Правка только имён/фраз/цели — отчёт перенесён с опубликованной версии. */
  inherited?: number;
}

/** Шаг `ui` уводит на другую страницу (дальше — следующий отрезок). */
function navigates(s: AdminMemoContent['steps'][number]): boolean {
  return (
    s.action === 'ui' &&
    (s.kind === 'navigate' || (s.kind === 'click' && s.target?.role === 'link'))
  );
}

/**
 * Отрезки шагов `ui` по страницам: переход (ссылка) закрывает отрезок —
 * следующие шаги `ui` на другой странице. Шаги `api`/`say` страниц не
 * имеют (между ними страница не меняется).
 */
export function adminMemoPages(c: AdminMemoContent): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  c.steps.forEach((s, i) => {
    if (s.action !== 'ui') return;
    cur.push(i);
    if (navigates(s)) {
      out.push(cur);
      cur = [];
    }
  });
  if (cur.length) out.push(cur);
  return out;
}

/** Есть ли в мемо шаги, которые проверяются на странице (с целью). */
export function adminMemoHasPageSteps(c: AdminMemoContent): boolean {
  return c.steps.some((s) => s.action === 'ui' && !!s.target);
}

/**
 * Мемо «Админки» → форма «Сайта» для ядра прогона. Шаг `ui` с целью —
 * шаг «Сайта» с отпечатком (роль, разметка, текст) на любой странице (`*`);
 * остальные — без цели (ядро их не проверяет). Цели `goal.expect` нет:
 * итог цели «Админки» считает адаптер (см. `adminMemoCheckPage`).
 */
export function adminMemoAsSite(c: AdminMemoContent): MemoContent {
  const base = emptyMemoContent();
  const steps: MemoStep[] = c.steps.map((s) => {
    const none: MemoStep = {
      page: '\u0000',
      action: 'wait',
      target: null,
      value: null,
      expect: null,
      say: null,
      risk: null,
    };
    if (s.action !== 'ui' || !s.target) return none;
    const action: MemoStepKind = s.kind === 'navigate' ? 'click' : s.kind;
    return {
      ...none,
      page: '*',
      action,
      value: s.value,
      target: {
        uiElementId: null,
        key: null,
        pin: {
          role: (s.target.role as UiRole | null) ?? null,
          assistId: s.target.assistId,
          text: s.target.text,
          tag: 'other',
          href: null,
          submit: false,
          inForm: false,
          pd: false,
          inputType: null,
          toggle: false,
          stability: null,
        },
      },
    };
  });
  return {
    ...base,
    names: c.names,
    triggers: c.triggers,
    goal: { text: c.goal.text, expect: [] },
    slots: c.slots as unknown as MemoSlot[],
    steps,
  };
}

/**
 * Проверка ОДНОЙ страницы образца (живой снимок, без событий): ядро
 * «Сайта» по всем целям шагов `ui`, затем — только отрезки, найденные на
 * этой странице (хоть одна цель отрезка есть), и сверки «Админки» по
 * живому элементу. Итог цели — «последний отрезок на этой странице».
 */
export function adminMemoCheckPage(
  c: AdminMemoContent,
  snapshot: UiSnapshot,
  ctx: { rules: VoiceControlRules; hosts: string[] },
): AdminMemoCheckPage {
  const site = adminMemoAsSite(c);
  const page = memoCheckPage(site, null, snapshot, ctx);
  const groups = adminMemoPages(c);
  const byI = new Map(page.steps.map((x) => [x.i, x]));
  const here = groups.filter((g) =>
    g.some((i) => {
      const r = byI.get(i);
      return !!r && r.problem !== 'missing';
    }),
  );
  const keep = new Set(here.flat());
  const steps = page.steps
    .filter((x) => keep.has(x.i))
    .map((x) => {
      if (!x.ok) return x;
      // Сверка «Админки» по живому элементу (Р-Э6б-10): шаг на странице —
      // только `none/nav/local`. Класс обратимости по живому DOM тем же
      // кодом, что у плана (`undoClass`): `irrev` (кнопка, отправка, пункт
      // меню без адреса) — «никогда», как отказ `bad_kind` в бою.
      const s = c.steps[x.i];
      if (s.action !== 'ui' || !s.target) return x;
      const t = s.target;
      const el = snapshot.elements.find((e) =>
        t.assistId
          ? e.assistId === t.assistId
          : normText(e.text) === normText(t.text) &&
            (!t.role || e.role === t.role),
      );
      const kind: UiStepKind = s.kind === 'navigate' ? 'click' : s.kind;
      const bad = !el || undoClass(kind, el, !!el.href) === 'irrev';
      return bad ? { i: x.i, ok: false, problem: 'never' as const } : x;
    });
  const last = groups[groups.length - 1];
  const goal: AdminMemoCheckPage['goal'] =
    last && here.includes(last) ? 'ok' : null;
  return { path: page.path, steps, goal };
}

/**
 * Шаги `api` в прогоне НЕ исполняются: операция есть в каталоге сайта,
 * поддерживается, включена (коннектор активен) и доступна роли того, кто
 * проверяет (`*` — все; null — без инструментов).
 */
export function adminMemoApiChecks(
  c: AdminMemoContent,
  catalog: ReadonlyMap<string, MemoCatalogOp>,
  role: string | null,
): AdminMemoApiCheck[] {
  const out: AdminMemoApiCheck[] = [];
  c.steps.forEach((s, i) => {
    if (s.action !== 'api') return;
    const op = catalog.get(s.op);
    const problem: AdminMemoApiProblem | null = !op
      ? 'operation_missing'
      : op.unsupported
        ? 'operation_unsupported'
        : !op.enabled
          ? 'operation_disabled'
          : role === null || (role !== '*' && !op.roles.includes(role))
            ? 'forbidden'
            : null;
    out.push({
      i,
      op: op?.key ?? s.opKey,
      kind: op?.kind ?? null,
      ok: problem === null,
      problem,
    });
  });
  return out;
}

/**
 * Итог прогона: правило ядра (`memoCheckVerdict`) по страницам — шаг на
 * странице не найден/не тот/опаснее или не проверен ни на одной — `fail`;
 * цель не проверена или фраза занята — `partial`. Плюс шаги `api`: любая
 * проблема — `fail`. Мемо без шагов на странице — цель «проверять нечего».
 */
export function adminMemoCheckVerdict(
  c: AdminMemoContent,
  pages: readonly AdminMemoCheckPage[],
  api: readonly AdminMemoApiCheck[],
  phraseConflicts: number,
): Pick<AdminMemoCheckReport, 'result' | 'steps' | 'goal'> {
  const v = memoCheckVerdict(adminMemoAsSite(c), pages, phraseConflicts);
  const byI = new Map(api.map((a) => [a.i, a]));
  const steps = v.steps.map((s) => {
    const a = byI.get(s.i);
    return a ? { i: s.i, page: null, ok: a.ok, problem: a.problem } : s;
  });
  const goal = adminMemoHasPageSteps(c) ? v.goal : 'ok';
  const result: AdminMemoCheckResult = steps.some((s) => !s.ok)
    ? 'fail'
    : goal !== 'ok' || phraseConflicts > 0
      ? 'partial'
      : 'pass';
  return { result, steps, goal };
}

/** Отчёт годен для публикации ЭТОЙ версии: тот же хеш, pass/partial. */
export function adminMemoCheckUsable(
  report: unknown,
  contentHash: string,
): report is AdminMemoCheckReport {
  if (!report || typeof report !== 'object' || Array.isArray(report))
    return false;
  const r = report as Partial<AdminMemoCheckReport>;
  return (
    r.kind === 'memo-check' &&
    r.contentHash === contentHash &&
    (r.result === 'pass' || r.result === 'partial')
  );
}

/**
 * Шаги и слоты те же (менялись только имена/фразы/описание цели) — отчёт
 * опубликованной версии переносится (§5-бис.17 п.7: «правка только
 * имени/фраз/описания цели — без прогона»).
 */
export function adminMemoSameSteps(
  a: Pick<AdminMemoContent, 'steps' | 'slots'>,
  b: Pick<AdminMemoContent, 'steps' | 'slots'>,
): boolean {
  return (
    JSON.stringify([a.steps, a.slots]) === JSON.stringify([b.steps, b.slots])
  );
}

/** Строки шагов для карточки прогона (без значений слотов). */
export function adminMemoStepLines(
  c: AdminMemoContent,
  lang: MemoLang,
): Array<{ i: number; kind: string; text: string }> {
  return c.steps.map((s, i) =>
    s.action === 'ui'
      ? { i, kind: s.kind, text: s.target?.text ?? '' }
      : s.action === 'api'
        ? { i, kind: 'api', text: s.opKey }
        : {
            i,
            kind: 'say',
            text: s.say[lang] ?? s.say.uk ?? s.say.ru ?? s.say.en ?? '',
          },
  );
}
