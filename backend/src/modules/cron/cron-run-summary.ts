/**
 * cron-run-summary.ts — сводка одного прогона крона для поля
 * `CronRunLog.summary`, общая для ДВУХ вызывающих путей: ручного
 * запуска оператором (`AdminCronService.run()`, этап 69) и настоящего
 * Vercel Cron (`CronJobsService.runAndLog()`, пятый аудит, Д-4.3).
 *
 * Вынесено в отдельный файл как чистые функции, а не общий метод в
 * одном из сервисов: `AdminCronService.run()` уже покрыт 11 тестами и
 * НЕ должен переписываться под общий контракт (see `cron-jobs.service.ts`
 * доккомментарий про то, чем `runAndLog` отличается от `run` —
 * перебрасывает ошибку, а не глотает её в FAILED-строку). Дублировать
 * саму логику сводки в обоих местах означало бы держать её синхронной
 * руками; общий чистый модуль этого не требует.
 */

/** Числовые поля результата — для короткой сводки без debug. */
export function summarizeCounters(result: Record<string, unknown>): string {
  const parts = Object.entries(result)
    .filter(([, v]) => typeof v === 'number')
    .map(([k, v]) => `${k}=${v as number}`);
  return parts.length > 0 ? parts.join(', ') : JSON.stringify(result);
}

/**
 * Короткая сводка для поля `summary` (видна всегда, без debug).
 * `report` — сам текст отчёта (ради него кнопку и жмут); остальные —
 * обобщённо по числовым полям результата (все девять оставшихся
 * результатов сегодня плоские объекты счётчиков).
 */
export function buildRunSummary(jobKey: string, result: unknown): string {
  if (jobKey === 'report' && result && typeof result === 'object') {
    const r = result as { text?: string };
    if (typeof r.text === 'string') return r.text;
  }
  // Найдено доп. аудитом (MEDIUM, вместе с добавлением джоб-замка у
  // `runCleanupSessions`): без этой ветки пропущенный (заблокированный
  // другим прогоном) запуск выглядел бы в журнале как «всё по нулям» —
  // неотличимо от «прогнал и правда нечего было чистить».
  if (
    jobKey === 'cleanup-sessions' &&
    result &&
    typeof result === 'object' &&
    (result as { skipped?: boolean }).skipped
  ) {
    return 'пропущен — предыдущий прогон ещё держал замок';
  }
  // Тот же приём, что у cleanup-sessions выше: без этой ветки прогон,
  // пропущенный из-за ненастроенной фикстуры (§3.3 ТЗ,
  // `TutorialScenarioRunnerService.run()`) или джоб-замка, выглядел бы
  // в журнале как «0 сценариев» — неотличимо от «сценариев и правда
  // ещё нет ни одного». Причина пропуска — то единственное, что
  // оператору тут интересно увидеть без раскрытия debug.
  if (
    jobKey === 'tutorial-scenario-run' &&
    result &&
    typeof result === 'object' &&
    typeof (result as { skipped?: string }).skipped === 'string'
  ) {
    return `пропущен — ${(result as { skipped: string }).skipped}`;
  }
  // Тот же приём, что у tutorial-scenario-run выше (этап 100,
  // UiSnapshotRunnerService.run()).
  if (
    jobKey === 'ui-snapshot-run' &&
    result &&
    typeof result === 'object' &&
    typeof (result as { skipped?: string }).skipped === 'string'
  ) {
    return `пропущен — ${(result as { skipped: string }).skipped}`;
  }
  if (jobKey === 'blog' && result && typeof result === 'object') {
    const r = result as {
      generation?: { notConfigured?: string | null };
      translation?: object;
    };
    // Та же причина, что у двух веток выше, и найдена она на живом
    // проде: без неё ненастроенный генератор показывал
    // `categoriesTried=0, candidatesConsidered=0, draftsCreated=0` —
    // неотличимо от «поискали и правда ничего не нашли». Причина стоит
    // ПЕРВОЙ в строке: это единственное, что тут надо прочитать.
    const notConfigured = r.generation?.notConfigured;
    if (notConfigured) {
      return `генерация пропущена — не задано: ${notConfigured}`;
    }
    const gen = r.generation
      ? summarizeCounters(r.generation as Record<string, unknown>)
      : '';
    const tr = r.translation
      ? summarizeCounters(r.translation as Record<string, unknown>)
      : '';
    return `генерация: ${gen}; перевод: ${tr}`;
  }
  if (result && typeof result === 'object') {
    return summarizeCounters(result as Record<string, unknown>);
  }
  return String(result);
}
