/**
 * Разбор расписаний Vercel Cron (`backend/vercel.json`) и подсчёт того,
 * сколько раз джоб ДОЛЖЕН был запуститься за период — для сводки
 * «ожидалось по расписанию vs было» во вкладке «Кроны»
 * (`AdminCronService.getSummary()`).
 *
 * Сознательно без npm-пакета: в `vercel.json` живут только простые
 * 5-польные выражения (`*`, `*∕N`, число, список через запятую, диапазон
 * `a-b` и `a-b∕N`) — этого подмножества и хватает. Всё прочее (`L`, `W`,
 * `#`, `?`, имена месяцев/дней, 6-е поле секунд) — явная ошибка разбора,
 * а не молчаливый неверный счёт: если такое выражение когда-нибудь
 * появится в `vercel.json`, это поймает `cron-schedule.spec.ts`,
 * прогоняющий разбор по реальному файлу.
 *
 * Время — UTC: Vercel Cron исполняет расписания в UTC.
 */

// `import * as`, а не default-импорт: `esModuleInterop` в проекте
// выключен, и `.default` у JSON под commonjs был бы undefined.
// Путь от `src/modules/cron/` к `backend/vercel.json`; rootDir сборки —
// `backend/`, так что tsc кладёт копию в `dist/vercel.json`, и тот же
// относительный путь верен и из `dist/src/modules/cron/`.
import * as vercelConfig from '../../../vercel.json';

export interface ParsedCron {
  minutes: number[];
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  /** 0–6, воскресенье = 0 (7 в выражении приводится к 0). */
  daysOfWeek: Set<number>;
  /** Поле «день месяца» — `*` (не ограничено). */
  domAny: boolean;
  /** Поле «день недели» — `*` (не ограничено). */
  dowAny: boolean;
}

function parseField(
  field: string,
  min: number,
  max: number,
  name: string,
): number[] {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) {
      throw new Error(`cron: неподдерживаемое поле ${name}: "${field}"`);
    }
    let from: number;
    let to: number;
    if (m[1] === '*') {
      from = min;
      to = max;
    } else {
      from = Number(m[2]);
      // «5/15» (без диапазона) в классическом cron = «с 5 до конца шагом 15».
      to = m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? max : from;
    }
    const step = m[4] !== undefined ? Number(m[4]) : 1;
    if (from < min || to > max || from > to || step < 1) {
      throw new Error(`cron: поле ${name} вне диапазона: "${field}"`);
    }
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

export function parseCronExpression(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `cron: ожидалось 5 полей, получено ${fields.length}: "${expr}"`,
    );
  }
  const [min, hour, dom, month, dow] = fields;
  return {
    minutes: parseField(min, 0, 59, 'минута'),
    hours: new Set(parseField(hour, 0, 23, 'час')),
    daysOfMonth: new Set(parseField(dom, 1, 31, 'день месяца')),
    months: new Set(parseField(month, 1, 12, 'месяц')),
    daysOfWeek: new Set(
      parseField(dow, 0, 7, 'день недели').map((d) => (d === 7 ? 0 : d)),
    ),
    domAny: dom === '*',
    dowAny: dow === '*',
  };
}

/** Классическая семантика cron: если ограничены ОБА поля дня — OR, иначе AND. */
function dayMatches(cron: ParsedCron, d: Date): boolean {
  const domOk = cron.daysOfMonth.has(d.getUTCDate());
  const dowOk = cron.daysOfWeek.has(d.getUTCDay());
  if (!cron.domAny && !cron.dowAny) return domOk || dowOk;
  return domOk && dowOk;
}

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/**
 * Сколько срабатываний расписания попадает в полуинтервал
 * `[since, until)`. Идёт по часам (744 шага на месяц), внутри часа —
 * по списку минут выражения, так что цена не зависит от частоты крона.
 */
export function countExpectedRuns(
  expr: string | ParsedCron,
  since: Date,
  until: Date,
): number {
  const cron = typeof expr === 'string' ? parseCronExpression(expr) : expr;
  const fromMs = since.getTime();
  const toMs = until.getTime();
  if (!(toMs > fromMs)) return 0;
  let count = 0;
  for (
    let hourStart = Math.floor(fromMs / HOUR_MS) * HOUR_MS;
    hourStart < toMs;
    hourStart += HOUR_MS
  ) {
    const d = new Date(hourStart);
    if (!cron.hours.has(d.getUTCHours())) continue;
    if (!cron.months.has(d.getUTCMonth() + 1)) continue;
    if (!dayMatches(cron, d)) continue;
    for (const minute of cron.minutes) {
      const t = hourStart + minute * MINUTE_MS;
      if (t >= fromMs && t < toMs) count += 1;
    }
  }
  return count;
}

/** Округление вверх до целой минуты UTC (тики cron — на целых минутах). */
export function ceilToMinute(d: Date): Date {
  return new Date(Math.ceil(d.getTime() / MINUTE_MS) * MINUTE_MS);
}

export interface VercelCronEntry {
  path: string;
  schedule: string;
}

/** `{ jobKey → schedule }` из массива `crons` vercel.json. */
export function schedulesByJobKey(
  crons: VercelCronEntry[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of crons) {
    const key = c.path.replace(/^\/api\/cron\//, '');
    out[key] = c.schedule;
  }
  return out;
}

/**
 * `{ jobKey → schedule }` из конфига Vercel. Конфиг ВШИТ в сборку
 * импортом (см. комментарий у импорта): раньше файл читался с диска по
 * вычисляемому пути, а такой файл трассировщик Vercel (nft) может не
 * положить в бандл — в проекте уже был такой случай с hb.wasm
 * (`common/text-card-render.ts`). Неожиданная форма конфига — `null`:
 * сводка тогда отдаёт `schedulesLoaded: false` и `expected: null`, а не
 * выдуманный ноль.
 */
export function loadVercelSchedules(
  config: unknown = vercelConfig,
): Record<string, string> | null {
  const crons = (config as { crons?: unknown } | null)?.crons;
  if (!Array.isArray(crons)) return null;
  const valid = crons.filter(
    (c): c is VercelCronEntry =>
      typeof c === 'object' &&
      c !== null &&
      typeof (c as VercelCronEntry).path === 'string' &&
      typeof (c as VercelCronEntry).schedule === 'string',
  );
  return schedulesByJobKey(valid);
}
