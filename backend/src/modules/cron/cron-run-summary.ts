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

/**
 * Сколько ПРИЧИН отказа дописывать к сводке. Не все: `summary` читают
 * глазами в таблице, и пятьдесят строк там не помещаются. Три — тот же
 * порядок, что у `ALERT_DETAIL_LIMIT` в исполнителе сценариев, и по той
 * же причине: назвать поимённо первые, чтобы человек понял КЛАСС
 * поломки, а не листал.
 */
const SUMMARY_REASON_LIMIT = 3;

/**
 * Числовые поля результата — для короткой сводки без debug.
 *
 * Плюс первые причины отказа текстом (сквозной аудит 29.09.2026).
 *
 * До правки функция брала ТОЛЬКО числа, и `failures[]` генератора
 * сценариев — массив, который он старательно собирает поимённо
 * («реплика шага 3 отброшена: длиннее 220 символов», «шаг 5: селектор
 * не из каталога», текст отказа модели) — отбрасывался целиком. В
 * журнале оставалось `pairs=50, generated=0, failed=50`, и по этой
 * строке нельзя было отличить сломанный ключ Gemini от сменившегося
 * формата ответа. `debugLog` при этом пуст: настоящий Vercel Cron
 * зовёт `runAndLog` с `debugMode: false` всегда, то есть поимённые
 * причины не доезжали до оператора НИКОГДА — при том, что три
 * отдельных аудита требовали называть их поимённо.
 */
export function summarizeCounters(result: Record<string, unknown>): string {
  const parts = Object.entries(result)
    .filter(([, v]) => typeof v === 'number')
    .map(([k, v]) => `${k}=${v as number}`);
  const reasons = extractReasons(result);
  if (reasons.length > 0) {
    const shown = reasons.slice(0, SUMMARY_REASON_LIMIT);
    const tail =
      reasons.length > shown.length
        ? ` и ещё ${reasons.length - shown.length}`
        : '';
    parts.push(`причины: ${shown.join('; ')}${tail}`);
  }
  return parts.length > 0 ? parts.join(', ') : JSON.stringify(result);
}

/**
 * Достаёт человекочитаемые причины отказа из результата джоба.
 *
 * Два known-поля, а не «любой массив»: `failures[]` у генератора
 * сценариев и `outcomes[]` у их исполнителя. Обобщать до «всё, что
 * похоже на список» нельзя — в результатах есть и массивы данных
 * (`locales[]`), которые в сводке только мешают.
 */
function extractReasons(result: Record<string, unknown>): string[] {
  const out: string[] = [];
  const failures = result.failures;
  if (Array.isArray(failures)) {
    for (const f of failures) {
      if (!f || typeof f !== 'object') continue;
      const row = f as {
        subjectKey?: unknown;
        locale?: unknown;
        reason?: unknown;
      };
      if (typeof row.reason !== 'string') continue;
      out.push(
        `${String(row.subjectKey)}/${String(row.locale)}: ${row.reason}`,
      );
    }
  }
  const outcomes = result.outcomes;
  if (Array.isArray(outcomes)) {
    for (const o of outcomes) {
      if (!o || typeof o !== 'object') continue;
      const row = o as {
        ok?: unknown;
        subjectKey?: unknown;
        locale?: unknown;
        error?: unknown;
      };
      if (row.ok !== false || typeof row.error !== 'string') continue;
      out.push(`${String(row.subjectKey)}/${String(row.locale)}: ${row.error}`);
    }
  }
  return out;
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
  // Генерация сценариев — та же ветка, добавлена сквозным аудитом
  // 29.09.2026. Довод «без неё пропущенный запуск выглядел бы как всё
  // по нулям» выписан в этом файле четыре раза для четырёх других
  // джобов, а для генератора применён не был: пропуск по замку или по
  // денежному потолку давал `pairs=0, generated=0, failed=0` — ровно
  // ту же строку, что полный прогон, которому нечего было делать.
  if (
    jobKey === 'tutorial-scenario-generate' &&
    result &&
    typeof result === 'object' &&
    typeof (result as { skipped?: string }).skipped === 'string'
  ) {
    return `пропущен — ${(result as { skipped: string }).skipped}`;
  }
  // Тот же приём, что у tutorial-scenario-run выше (аудит 27.09.2026):
  // замок опроса общий с суточным прогоном, и «занят» здесь частый
  // штатный исход, а не редкость. Без ветки он читался бы как
  // «сборок не было».
  if (
    jobKey === 'tutorial-assembly-poll' &&
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
      // Текст приходит готовым: у «выключен намеренно» и «не задано
      // такое-то» разный смысл, и дописывать сюда общую приставку
      // значило бы превратить первое во второе.
      return `генерация пропущена — ${notConfigured}`;
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
