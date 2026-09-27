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

function registryKeys(): string[] {
  const src = readFileSync(
    join(BACKEND_ROOT, 'src', 'modules', 'cron', 'admin-cron.service.ts'),
    'utf8',
  );
  return [...src.matchAll(/jobKey: '([^']+)'/g)].map((m) => m[1]).sort();
}

describe('швы крон-подсистемы: маршрут ↔ расписание ↔ реестр', () => {
  it('у каждого маршрута /api/cron/* есть расписание в vercel.json', () => {
    const routes = controllerRoutes();
    expect(routes.length).toBeGreaterThan(0);
    expect(vercelCronPaths()).toEqual(routes);
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
});
