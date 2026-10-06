/**
 * Мемо «Админки» АМ-N — сухой прогон, «требует проверки» и статистика в
 * TMA (аудит 06.10.2026; ТЗ §5-бис.17 п.7, п.8, п.13, п.14). Строгий разбор
 * ответа кабинета: неизвестное → умолчание; значений слотов сервер не отдаёт.
 */

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0;
const numOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

export const MEMO_REVIEW_CODES = [
  'failures',
  'pin_mismatch',
  'goal_low',
] as const;
export type MemoReviewCode = (typeof MEMO_REVIEW_CODES)[number];

export interface MemoReviewReason {
  code: MemoReviewCode;
  /** Номер шага с 1 (сбои); null — по цели. */
  step: number | null;
  version: number | null;
  employees: number | null;
  runs: number | null;
  reached: number | null;
  at: string;
}

export interface MemoStats {
  days: number;
  runs: number;
  reached: number;
  notReached: number;
  unknown: number;
  failed: number;
  stopped: number;
  pinMismatch: number;
  employees: number;
  /** 0..1; null — запусков с итогом цели нет. */
  goalRate: number | null;
  lastRunAt: string | null;
  failures: Array<{ step: number; n: number; employees: number; pin: boolean }>;
}

export type MemoCheckResult = 'pass' | 'partial' | 'fail';

export interface MemoCheckView {
  result: MemoCheckResult;
  /** Шаги с проблемой (номер с 1) и код проблемы. */
  problems: Array<{ step: number; code: string }>;
  goal: string;
  phraseConflicts: number;
  pages: string[];
  at: string;
  /** Отчёт перенесён с опубликованной версии N (правка только имени/фраз). */
  inherited: number | null;
}

export function parseReviewReason(v: unknown): MemoReviewReason | null {
  const o = obj(v);
  if (!(MEMO_REVIEW_CODES as readonly unknown[]).includes(o.code)) return null;
  return {
    code: o.code as MemoReviewCode,
    step: numOrNull(o.step),
    version: numOrNull(o.version),
    employees: numOrNull(o.employees),
    runs: numOrNull(o.runs),
    reached: numOrNull(o.reached),
    at: str(o.at),
  };
}

export function parseMemoStats(v: unknown): MemoStats {
  const o = obj(v);
  const rate = numOrNull(o.goalRate);
  return {
    days: num(o.days),
    runs: num(o.runs),
    reached: num(o.reached),
    notReached: num(o.notReached),
    unknown: num(o.unknown),
    failed: num(o.failed),
    stopped: num(o.stopped),
    pinMismatch: num(o.pinMismatch),
    employees: num(o.employees),
    goalRate: rate !== null && rate >= 0 && rate <= 1 ? rate : null,
    lastRunAt: str(o.lastRunAt) || null,
    failures: arr(o.failures)
      .slice(0, 20)
      .map((x) => {
        const f = obj(x);
        return {
          step: num(f.step),
          n: num(f.n),
          employees: num(f.employees),
          pin: f.pin === true,
        };
      }),
  };
}

export function parseCheckReport(v: unknown): MemoCheckView | null {
  const o = obj(v);
  if (o.kind !== 'memo-check') return null;
  const result = (['pass', 'partial', 'fail'] as const).find(
    (x) => x === o.result
  );
  if (!result) return null;
  return {
    result,
    problems: arr(o.steps)
      .map(obj)
      .filter((s) => s.ok !== true)
      .slice(0, 20)
      .map((s) => ({ step: num(s.i) + 1, code: str(s.problem) || 'unknown' })),
    goal: str(o.goal),
    phraseConflicts: arr(o.phraseConflicts).length,
    pages: arr(o.pages).map(str).filter(Boolean).slice(0, 20),
    at: str(o.at),
    inherited: numOrNull(o.inherited),
  };
}

export interface MemoCheckToken {
  url: string;
  expiresAt: string;
  version: number;
}

export function parseCheckToken(v: unknown): MemoCheckToken {
  const o = obj(v);
  const url = str(o.url);
  return {
    // Ссылка — только https (её откроет владелец у себя в админке).
    url: /^https:\/\//.test(url) ? url : '',
    expiresAt: str(o.expiresAt),
    version: num(o.version),
  };
}
