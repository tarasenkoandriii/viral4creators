/**
 * Данные из ответа API для тонких сервисов (export-api, postprod-api).
 *
 * Терпит и старый двойной конверт `{ success, data: { success, data } }`:
 * до 01.10.2026 контроллеры экспорта и переозвучки сами заворачивали
 * ответ, а глобальный `ResponseInterceptor` — ещё раз, и «Перерендерить»
 * падал с «undefined is not an object (evaluating 'z.video.exportVariants')».
 * Бэкенд исправлен, но фронтенд и бэкенд деплоятся отдельно — порядок
 * деплоя не должен возвращать поломку.
 */
export function unwrapApiData<T>(res: { data?: unknown }, what: string): T {
  let data = res.data as unknown;
  if (
    data !== null &&
    typeof data === 'object' &&
    (data as { success?: unknown }).success === true &&
    'data' in (data as object)
  ) {
    data = (data as { data: unknown }).data;
  }
  if (data === undefined) throw new Error(`Пустой ответ: ${what}`);
  return data as T;
}
