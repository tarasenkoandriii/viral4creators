/**
 * Что именно поменял человек в брифе — этап C ТЗ
 * docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md §3.6.
 *
 * После старта сессии бриф уходит в `PATCH /sessions/:id/greeting-brief`
 * ТОЛЬКО изменёнными полями. Раньше форма отправляла всё целиком, и это
 * давало две ошибки (найдены ревью этапа C):
 *
 * - провайдер и качество шли в каждом запросе, и тарифная проверка
 *   запускалась даже на исправление опечатки: у того, чей тариф понизился
 *   после выбора аватара, правка текста падала с 403;
 * - язык, не выбранный в брифе, форма подставляла из интерфейса, и
 *   сессия, начатая на другом языке интерфейса, теряла собранный
 *   сценарий от любого сохранения.
 *
 * Чистая функция — ради теста без браузера (`scripts/greeting-brief-diff.test.ts`).
 */

export type BriefFields = Record<string, string | null>;

export function changedBriefFields<T extends BriefFields>(
  baseline: T,
  current: T
): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(current) as Array<keyof T>) {
    if ((baseline[key] ?? null) !== (current[key] ?? null)) {
      out[key] = current[key];
    }
  }
  return out;
}
