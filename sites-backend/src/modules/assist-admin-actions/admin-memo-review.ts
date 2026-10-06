/**
 * Мемо «Админки» АМ-N: «требует проверки» и статистика запусков — ЧИСТАЯ
 * часть (аудит 06.10.2026; ТЗ §5-бис.17 п.8 п.4–5, п.13). Пороги — те же,
 * что у мемо «Сайта» (`MEMO_REVIEW` нейтрального ядра), но «разные
 * посетители и хеши IP» здесь — разные СОТРУДНИКИ (`actor` запуска: сессия
 * по employee-JWT заказчика или участник TMA): один сотрудник не переведёт
 * мемо в «требует проверки», подделав свой DOM или нажимая «Нет».
 *
 * Сбой запуска — статус `failed` на шаге `step` (чтение не удалось,
 * предложение отклонено системой, исход неизвестен, отрезок на странице не
 * исполнился; `pin_mismatch` — цель шага на странице не сошлась с
 * сохранённой). Не сбой мемо: «Нет» сотрудника (`stopped`), истечение,
 * запуск из TMA/чата без страницы при шагах `ui` (`needs_page`).
 */
import { MEMO_REVIEW } from '../assist-ui-core/memo';

export interface AdminMemoRunFact {
  actor: string;
  status: string;
  step: number;
  goalStatus: string | null;
  progress: unknown;
  createdAt: Date;
}

export interface AdminMemoStats {
  /** Окно статистики, дней. */
  days: number;
  runs: number;
  reached: number;
  notReached: number;
  unknown: number;
  failed: number;
  /** «Нет» сотрудника на карточке шага (отказы на подтверждении). */
  stopped: number;
  pinMismatch: number;
  /** Разных сотрудников, запускавших мемо. */
  employees: number;
  /** Доля `reached` среди запусков с итогом цели; null — запусков нет. */
  goalRate: number | null;
  lastRunAt: string | null;
  /** Сбои по шагам (номер шага с 1): сколько и у скольких сотрудников. */
  failures: Array<{ step: number; n: number; employees: number; pin: boolean }>;
}

export type AdminMemoReviewCode = 'pin_mismatch' | 'failures' | 'goal_low';

export interface AdminMemoReviewReason {
  code: AdminMemoReviewCode;
  /** Номер шага с 1 (сбои); null — по цели. */
  step: number | null;
  /** Версия, на запусках которой найдено. */
  version: number;
  employees?: number;
  runs?: number;
  reached?: number;
  at: string;
}

type Progress = Array<{ i?: unknown; outcome?: unknown }>;

function progressOf(v: unknown): Progress {
  return Array.isArray(v)
    ? (v.filter((x) => !!x && typeof x === 'object') as Progress)
    : [];
}

/** Исход шага `i` в прогрессе запуска (последняя запись). */
function outcomeAt(r: AdminMemoRunFact, i: number): string | null {
  const p = progressOf(r.progress)
    .filter((x) => x.i === i)
    .pop();
  return p && typeof p.outcome === 'string' ? p.outcome : null;
}

/** Запуск — сбой мемо (а не решение сотрудника или канал без страницы). */
export function runFailure(
  r: AdminMemoRunFact,
): { step: number; pin: boolean } | null {
  if (r.status !== 'failed') return null;
  const o = outcomeAt(r, r.step);
  if (o === 'needs_page') return null;
  return { step: r.step, pin: o === 'pin_mismatch' };
}

/** Запуск входит в долю цели (итог цели есть; без «нужна страница»). */
function withGoal(r: AdminMemoRunFact): boolean {
  if (r.goalStatus === null) return false;
  return !(r.status === 'failed' && outcomeAt(r, r.step) === 'needs_page');
}

export function adminMemoStats(
  runs: readonly AdminMemoRunFact[],
  days: number,
): AdminMemoStats {
  const goal = runs.filter(withGoal);
  const reached = goal.filter((r) => r.goalStatus === 'reached').length;
  const fails = new Map<
    number,
    { n: number; employees: Set<string>; pin: boolean }
  >();
  let pinMismatch = 0;
  for (const r of runs) {
    const f = runFailure(r);
    if (!f) continue;
    if (f.pin) pinMismatch++;
    const x = fails.get(f.step) ?? { n: 0, employees: new Set(), pin: false };
    x.n++;
    x.employees.add(r.actor);
    x.pin = x.pin || f.pin;
    fails.set(f.step, x);
  }
  const last = runs.reduce<Date | null>(
    (a, r) => (!a || r.createdAt > a ? r.createdAt : a),
    null,
  );
  return {
    days,
    runs: runs.length,
    reached,
    notReached: goal.filter((r) => r.goalStatus === 'not_reached').length,
    unknown: goal.filter((r) => r.goalStatus === 'unknown').length,
    failed: runs.filter((r) => runFailure(r) !== null).length,
    stopped: runs.filter((r) => r.status === 'stopped').length,
    pinMismatch,
    employees: new Set(runs.map((r) => r.actor)).size,
    goalRate: goal.length ? reached / goal.length : null,
    lastRunAt: last ? last.toISOString() : null,
    failures: [...fails.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([i, x]) => ({
        step: i + 1,
        n: x.n,
        employees: x.employees.size,
        pin: x.pin,
      })),
  };
}

/**
 * `needs_review` (§5-бис.17 п.8 п.4–5) по запускам ОПУБЛИКОВАННОЙ версии за
 * 7 дней: сбой/`pinMismatch` на одном шаге у ≥ 3 разных сотрудников; успех
 * цели < 60% на ≥ 10 запусках. Само-лечения нет: выход — новая версия с
 * прогоном и подтверждением владельца.
 */
export function decideAdminMemoReview(
  runs: readonly AdminMemoRunFact[],
  version: number,
  now: Date,
  t: {
    minVisitors: number;
    goalMinRuns: number;
    goalBelow: number;
  } = MEMO_REVIEW,
): AdminMemoReviewReason | null {
  const s = adminMemoStats(runs, 7);
  const at = now.toISOString();
  for (const f of s.failures)
    if (f.employees >= t.minVisitors)
      return {
        code: f.pin ? 'pin_mismatch' : 'failures',
        step: f.step,
        version,
        employees: f.employees,
        at,
      };
  const goalRuns = s.reached + s.notReached + s.unknown;
  if (goalRuns >= t.goalMinRuns && s.reached / goalRuns < t.goalBelow)
    return {
      code: 'goal_low',
      step: null,
      version,
      runs: goalRuns,
      reached: s.reached,
      at,
    };
  return null;
}
