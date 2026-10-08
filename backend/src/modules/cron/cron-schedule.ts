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

/** Допуск опоздания старта прогона после тика (Vercel стартует функцию
 *  не ровно в минуту расписания) — тот же порядок, что запас сводки. */
export const RUN_START_SLACK_MS = 3 * MINUTE_MS;

/** Прогон, стартовавший в `startedAt`, — тик этого расписания (с допуском
 *  опоздания старта `RUN_START_SLACK_MS`). */
export function runFitsSchedule(cron: ParsedCron, startedAt: Date): boolean {
  const tick = Math.floor(startedAt.getTime() / MINUTE_MS) * MINUTE_MS;
  return (
    countExpectedRuns(
      cron,
      new Date(tick - RUN_START_SLACK_MS),
      new Date(tick + MINUTE_MS),
    ) > 0
  );
}

/**
 * Нормальная форма cron-выражения — для сравнения «то же расписание или
 * другое» по ТЕКСТУ, а не по тому, укладываются ли прогоны в расписание.
 *
 * Пробелы схлопываются, а разобранное выражение собирается заново в
 * каноническом виде: значения поля — отсортированным списком без
 * повторов, полный диапазон минут/часов/месяцев — `*`, день недели 7 —
 * 0. Так одно и то же расписание, записанное иначе (`0,30` и `30,0`,
 * `*∕1` и `*`, `* * * * 7` и `* * * * 0`, лишние пробелы), сменой не
 * считается. Поля дня месяца и дня недели — по смыслу `dayMatches`, а
 * не по букве: если `*` хоть одно из них (AND), полное поле (`1-31`,
 * `*∕1`, `0-6`) ничего не отсекает и пишется `*`; если ограничены оба
 * (OR) и одно из них полное — подходит любой день, и `*` пишутся оба;
 * оба ограничены и не полные — оба остаются списками (OR). Выражение,
 * которое не разбирается, сравнивается по тексту со схлопнутыми
 * пробелами.
 */
export function normalizeCronExpression(expr: string): string {
  const text = expr.trim().split(/\s+/).join(' ');
  let cron: ParsedCron;
  try {
    cron = parseCronExpression(text);
  } catch {
    return text;
  }
  const list = (values: Iterable<number>, full: number): string => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted.length === full ? '*' : sorted.join(',');
  };
  // Дни — по смыслу `dayMatches`, а не по букве. Ограничены оба поля
  // (OR) и одно из них полное — подходит любой день: оба `*`. Иначе (AND)
  // полное поле ничего не отсекает — `*`, второе остаётся как есть.
  const domFull = cron.domAny || cron.daysOfMonth.size === 31;
  const dowFull = cron.dowAny || cron.daysOfWeek.size === 7;
  const orDays = !cron.domAny && !cron.dowAny;
  const everyDay = orDays ? domFull || dowFull : domFull && dowFull;
  return [
    list(cron.minutes, 60),
    list(cron.hours, 24),
    everyDay || domFull ? '*' : list(cron.daysOfMonth, 31),
    list(cron.months, 12),
    everyDay || dowFull ? '*' : list(cron.daysOfWeek, 7),
  ].join(' ');
}

/** Другое ли расписание — по нормальной форме выражения. */
export function cronScheduleChanged(
  previous: string,
  current: string,
): boolean {
  return normalizeCronExpression(previous) !== normalizeCronExpression(current);
}

/** Прогон из журнала: старт и расписание, по которому он шёл
 *  (`CronRunLog.schedule`; у строк до появления колонки — null). */
export interface LoggedScheduledRun {
  startedAt: Date;
  schedule: string | null;
}

/** Подряд идущих «чужих» прогонов, с которых признаётся смена расписания:
 *  одиночный — это опоздание старта, а не новое расписание. */
export const SCHEDULE_CHANGE_MIN_STREAK = 2;

/**
 * Смена расписания по журналу (заход 7, 07.10.2026; TODO «Сводка
 * кронов»): с какой минуты джоб живёт по ТЕКУЩЕМУ расписанию.
 *
 * Сводка знает только нынешний `vercel.json`, и при смене расписания
 * ожидала новые тики и в часы, когда действовало старое, — рисовала ложные
 * «пропуски» (`tutorial-scenario-run` 30.09: 7 штук до 16:00 — тики шли по
 * старому `0 9,10`). Доказательство смены — НЕ МЕНЬШЕ
 * `SCHEDULE_CHANGE_MIN_STREAK` прогонов подряд, не укладывающихся в
 * текущее расписание (аудит захода 7: один опоздавший старт обнулял бы
 * пропуски за всё окно). Отсчёт — с первого прогона ПОСЛЕ последней такой
 * серии (момент деплоя журнал не знает; так же сводка уже считает новый
 * крон — с первого его прогона). Своих после неё ещё нет — со следующей
 * минуты после серии: замолчавший после смены крон виден пропусками.
 *
 * `runs` — прогоны по расписанию, по возрастанию старта. `null` — смены
 * журнал не показывает.
 *
 * Прогон, у которого в журнале записано расписание (`schedule`, TODO
 * «сводка кронов: смену расписания на надмножество старого журнал не
 * видит»), судится по ТЕКСТУ: другое выражение (`cronScheduleChanged`
 * против `current`) — чужой прогон, даже если его тик укладывается в
 * нынешнее расписание. Без этого смена на надмножество (было `0 3 * * *`,
 * стало `0 *∕6 * * *`) не была видна: старые тики — тоже тики нового
 * расписания, и сводка ждала по новому за всё окно. Одного такого
 * прогона достаточно — текст не опаздывает, как старт. Свой текст —
 * свой прогон, даже опоздавший больше допуска.
 *
 * Догадка по тикам (серия не укладывающихся прогонов) осталась только
 * для строк без записанного расписания — журнала до появления колонки;
 * для них предел прежний: смена на надмножество не видна.
 */
export function scheduleEffectiveSince(
  cron: ParsedCron,
  runs: readonly (Date | LoggedScheduledRun)[],
  current?: string | null,
): Date | null {
  const end = lastForeignRunIndex(cron, runs, current);
  if (end < 0) return null;
  const startOf = (r: Date | LoggedScheduledRun): Date =>
    r instanceof Date ? r : r.startedAt;
  const next = runs[end + 1];
  return effectiveSinceAfter(startOf(runs[end]), next ? startOf(next) : null);
}

/**
 * Старт последнего «чужого» прогона (см. `scheduleEffectiveSince`) или
 * null. Сводка зовёт это по строкам без записанного выражения — догадка
 * по тикам; записанные выражения она сверяет запросом к базе, без
 * потолка выборки.
 */
export function lastForeignRun(
  cron: ParsedCron,
  runs: readonly (Date | LoggedScheduledRun)[],
  current?: string | null,
): Date | null {
  const end = lastForeignRunIndex(cron, runs, current);
  if (end < 0) return null;
  const run = runs[end];
  return run instanceof Date ? run : run.startedAt;
}

/** Начало нынешнего расписания после последнего чужого прогона: минута
 *  следующего прогона, а если его нет — минута после чужого. */
export function effectiveSinceAfter(
  lastForeign: Date,
  nextRun: Date | null,
): Date {
  return nextRun
    ? floorToMinute(nextRun)
    : new Date(floorToMinute(lastForeign).getTime() + MINUTE_MS);
}

function lastForeignRunIndex(
  cron: ParsedCron,
  runs: readonly (Date | LoggedScheduledRun)[],
  current?: string | null,
): number {
  const currentKey = current ? normalizeCronExpression(current) : null;
  const startOf = (r: Date | LoggedScheduledRun): Date =>
    r instanceof Date ? r : r.startedAt;
  let foreignEnd = -1;
  let streak = 0;
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    const logged = run instanceof Date ? null : run.schedule;
    if (logged != null && currentKey != null) {
      streak = 0;
      if (normalizeCronExpression(logged) !== currentKey) foreignEnd = i;
      continue;
    }
    if (runFitsSchedule(cron, startOf(run))) {
      streak = 0;
      continue;
    }
    streak++;
    if (streak >= SCHEDULE_CHANGE_MIN_STREAK) foreignEnd = i;
  }
  return foreignEnd;
}

/** Округление вверх до целой минуты UTC (тики cron — на целых минутах). */
export function ceilToMinute(d: Date): Date {
  return new Date(Math.ceil(d.getTime() / MINUTE_MS) * MINUTE_MS);
}

/** Округление вниз до целой минуты UTC — минута тика, от которого
 * стартовала строка журнала (старт отстаёт от тика на секунды). */
export function floorToMinute(d: Date): Date {
  return new Date(Math.floor(d.getTime() / MINUTE_MS) * MINUTE_MS);
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
