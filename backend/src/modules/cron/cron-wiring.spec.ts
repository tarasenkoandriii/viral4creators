/**
 * Шов «маршрут ↔ расписание ↔ реестр админки» — заведён сквозным
 * аудитом (27.09.2026) вместе с находкой Д-2.
 *
 * Сама находка Д-2 была не в коде, а в РАССОГЛАСОВАНИИ трёх файлов:
 * сборку слайд-шоу подбирал только суточный `tutorial-scenario-run`,
 * потому что отдельного слота под опрос никто не завёл. Ни один тест
 * этого увидеть не мог: `cron.controller.spec.ts` проверяет маршруты,
 * `admin-cron.service.spec.ts` — реестр, а `vercel.json` не проверял
 * никто. Три списка держались синхронными руками.
 *
 * Здесь они сверяются друг с другом по факту, как швы в
 * `scripts/check-docs.mjs`: забытая запись в любом из трёх файлов —
 * красный тест, а не тихо не запускающийся крон.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { JOB_LOCK_MS } from '../../common/cron-job-lock';
import { countExpectedRuns, parseCronExpression } from './cron-schedule';

const BACKEND_ROOT = join(__dirname, '..', '..', '..');

function controllerRoutes(): string[] {
  const src = readFileSync(
    join(BACKEND_ROOT, 'src', 'modules', 'cron', 'cron.controller.ts'),
    'utf8',
  );
  return [...src.matchAll(/@Get\('([^']+)'\)/g)].map((m) => m[1]).sort();
}

function vercelCronPaths(): string[] {
  const json = JSON.parse(
    readFileSync(join(BACKEND_ROOT, 'vercel.json'), 'utf8'),
  ) as { crons?: Array<{ path: string; schedule: string }> };
  return (json.crons ?? []).map((c) => c.path.replace('/api/cron/', '')).sort();
}

function vercelCrons(): Array<{ path: string; schedule: string }> {
  const json = JSON.parse(
    readFileSync(join(BACKEND_ROOT, 'vercel.json'), 'utf8'),
  ) as { crons?: Array<{ path: string; schedule: string }> };
  return json.crons ?? [];
}

/** Минуты суток (от полуночи UTC), в которые стартует расписание. */
function dayTicks(schedule: string): number[] {
  const cron = parseCronExpression(schedule);
  const day = Date.UTC(2026, 9, 6);
  const out: number[] = [];
  for (let minute = 0; minute < 24 * 60; minute += 1) {
    const at = day + minute * 60_000;
    if (countExpectedRuns(cron, new Date(at), new Date(at + 60_000)) > 0) {
      out.push(minute);
    }
  }
  return out;
}

function registryKeys(): string[] {
  const src = readFileSync(
    join(BACKEND_ROOT, 'src', 'modules', 'cron', 'admin-cron.service.ts'),
    'utf8',
  );
  return [...src.matchAll(/jobKey: '([^']+)'/g)].map((m) => m[1]).sort();
}

/**
 * Маршрут → ключ журнала: `@Get('x')` и первый `runAndLog('y'` в его
 * обработчике. Ключ журнала — то, по чему прогон берёт своё выражение из
 * `vercel.json` (`CronRunLog.schedule`): опечатка в нём молча даёт
 * `schedule = null`, и сводка теряет смену расписания по тексту.
 */
function routeLogKeys(): Array<{ route: string; logKey: string | null }> {
  const src = readFileSync(
    join(BACKEND_ROOT, 'src', 'modules', 'cron', 'cron.controller.ts'),
    'utf8',
  );
  return src
    .split(/@Get\(/)
    .slice(1)
    .map((chunk) => ({
      route: /^'([^']+)'\)/.exec(chunk)?.[1] ?? '',
      logKey: /runAndLog\(\s*'([^']+)'/.exec(chunk)?.[1] ?? null,
    }));
}

describe('швы крон-подсистемы: маршрут ↔ расписание ↔ реестр', () => {
  it('у каждого маршрута /api/cron/* есть расписание в vercel.json', () => {
    const routes = controllerRoutes();
    expect(routes.length).toBeGreaterThan(0);
    expect(vercelCronPaths()).toEqual(routes);
  });

  it('каждый маршрут пишет журнал под своим ключом (runAndLog с тем же именем)', () => {
    const pairs = routeLogKeys();
    expect(pairs.map((p) => p.route).sort()).toEqual(controllerRoutes());
    for (const p of pairs) {
      expect({ route: p.route, logKey: p.logKey }).toEqual({
        route: p.route,
        logKey: p.route,
      });
    }
  });

  it('каждый маршрут есть в реестре ручного запуска админки', () => {
    expect(registryKeys()).toEqual(controllerRoutes());
  });

  it('все пути расписания начинаются с /api/cron/ и имеют пятиполевой cron', () => {
    for (const { path, schedule } of vercelCrons()) {
      expect(path.startsWith('/api/cron/')).toBe(true);
      expect(schedule.trim().split(/\s+/)).toHaveLength(5);
    }
  });

  it('опрос сборок обучалки идёт минутами, а не раз в сутки (находка Д-2)', () => {
    // Смысл находки: результат сборки должен подбираться в пределах
    // тех десяти минут, что ждёт экран мастера
    // (`VIDEO_POLL_INTERVAL_MS × VIDEO_POLL_MAX_ATTEMPTS`), а не в
    // следующий суточный прогон сценариев. Суточное расписание здесь —
    // возврат ровно к той поломке, ради которой слот заведён.
    const poll = vercelCrons().find(
      (c) => c.path === '/api/cron/tutorial-assembly-poll',
    );
    expect(poll).toBeDefined();
    expect(poll?.schedule).toMatch(/^\*\/\d+ \* \* \* \*$/);
    const everyMinutes = Number(/^\*\/(\d+)/.exec(poll!.schedule)![1]);
    expect(everyMinutes).toBeLessThanOrEqual(5);
  });

  /**
   * Второй тик прогона сценариев (29.09.2026).
   *
   * Девять сценариев требуют ≈405–420 с (два замера подряд), а потолок
   * функции Vercel — 300 с и на Hobby не поднимается. Значит одним
   * тиком полный обход не помещается НИКОГДА, и три сценария каждую
   * ночь откладываются на следующие сутки. Закрыто это не константой
   * `RUN_DEADLINE_MS`, а вторым тиком в расписании — то есть решение
   * живёт в `vercel.json`, где его ничего не держало.
   *
   * Два условия, и второе не очевидно: тики должны отстоять друг от
   * друга дальше, чем живёт замок `JOB_LOCK_MS`, иначе второй тик
   * увидит незакрытый замок первого и молча не сделает ничего —
   * расписание будет выглядеть исправленным, а поведение останется
   * прежним.
   */
  /*
   * Тиков не меньше 15 (решение владельца 30.09.2026: тики, а не длинная
   * функция). С аудита кронов 06.10.2026 тик берёт ≈4 сценария (бюджет
   * `RUN_DEADLINE_MS` уменьшен на резерв выхода из тика), то есть ≈60
   * стартов в сутки: одной локали (15 тем) с избытком, пяти (75 пар) —
   * круг за сутки с четвертью; прошедший сценарий с теми же шагами и
   * не нужен чаще раза в 20 ч (`OK_RERUN_INTERVAL_MS`).
   */
  it('прогон сценариев обучалки идёт не меньше чем 15 тиками в сутки, разнесёнными дальше замка', () => {
    const run = vercelCrons().find(
      (c) => c.path === '/api/cron/tutorial-scenario-run',
    );
    expect(run).toBeDefined();
    // Разбор тем же парсером, что считает «ожидалось» во вкладке
    // «Кроны» (`cron-schedule.ts`): прежняя редакция теста разбирала
    // только списки через запятую, и диапазон `9-23` читался бы как NaN.
    const ticks = dayTicks(run!.schedule);
    expect(ticks.length).toBeGreaterThanOrEqual(15);
    const gaps = ticks.slice(1).map((t, i) => (t - ticks[i]) * 60 * 1000);
    expect(Math.min(...gaps)).toBeGreaterThan(JOB_LOCK_MS);
  });

  /**
   * Разведение тяжёлых кронов по минутам (аудит кронов 06.10.2026).
   *
   * В :00 стартовали одновременно прогон сценариев (Chromium), обход
   * интерфейса (второй Chromium), опрос сборок и шесть двухминутных
   * воркеров. Прогон сценариев — в :05 (нечётная минута, ни один
   * двухминутный тик на неё не попадает), обход — в :10/:25/:40/:55.
   */
  it('прогон сценариев и обход интерфейса не стартуют в одну минуту ни друг с другом, ни в :00', () => {
    const find = (path: string) => {
      const c = vercelCrons().find((x) => x.path === path);
      expect(c).toBeDefined();
      return c!;
    };
    const run = parseCronExpression(
      find('/api/cron/tutorial-scenario-run').schedule,
    );
    const snap = parseCronExpression(
      find('/api/cron/ui-snapshot-run').schedule,
    );
    expect(run.minutes).not.toContain(0);
    expect(snap.minutes).not.toContain(0);
    expect(run.minutes.filter((m) => snap.minutes.includes(m))).toEqual([]);
    // Двухминутные тики стартуют в чётные минуты — прогон сценариев
    // ни с одним из них не совпадает.
    const everyTwo = vercelCrons().filter((c) =>
      /^\*\/2 /.test(c.schedule.trim()),
    );
    expect(everyTwo.length).toBeGreaterThan(0);
    for (const c of everyTwo) {
      const m = parseCronExpression(c.schedule).minutes;
      expect(run.minutes.filter((x) => m.includes(x))).toEqual([]);
    }
  });
});
