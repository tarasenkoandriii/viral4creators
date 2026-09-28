/**
 * Каноническая сериализация JSON — для сравнения «изменилось ли»
 * между тем, что пришло из кода, и тем, что вернула база.
 *
 * `JSON.stringify` для этого не годится, и это не теория. Postgres
 * хранит `jsonb` в собственном порядке (короткие ключи раньше
 * длинных, дальше побайтово), а не в том, в каком объект собрали.
 * Шаг сценария `{kind, selector, value}` возвращается из базы как
 * `{kind, value, selector}` — проверено на живом Postgres 16, — и
 * прямое сравнение строк объявляет «изменилось» при побайтово
 * одинаковых данных.
 *
 * Тот же урок проект уже проходил в `common/api-video-job.ts`
 * («порядок ключей в объекте зависит от того, как его собрали»).
 *
 * Массивы упорядочены по смыслу — их порядок сохраняется; ключи
 * объектов упорядочены сортировкой.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    // `undefined` в значении `JSON.stringify` выбрасывает, и здесь
    // выбрасываем тоже — иначе `{a: undefined}` и `{}` сравнялись бы
    // как разные.
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    .join(',')}}`;
}
