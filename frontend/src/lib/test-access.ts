/**
 * Тестовый доступ на экране (TODO §III п.37).
 *
 * Сервер присылает КОДЫ сценариев, а не подписи: он их не переводит и
 * не должен — языков у него пять, и они живут здесь. Этот модуль
 * превращает коды в подписи и решает единственный содержательный
 * вопрос: что делать с кодом, которого интерфейс не знает.
 *
 * Ответ — молча пропустить. Сценарии добавляются на бэкенде, и версия
 * интерфейса у пользователя может отстать на один деплой. Показать
 * сырой `GREETING_VIDEO` в списке «бесплатно открыто» хуже, чем не
 * показать его вовсе: непереведённый код читается как ошибка, а не как
 * возможность. Заметить пропажу при этом есть чему — тест ниже сверяет
 * набор кодов со словарём.
 */

/** Порядок в списке фиксирован и не зависит от порядка в ответе. */
export const TEST_SCENARIO_ORDER = [
  'PRODUCT_VIDEO',
  'CLIENT_SITE',
  'GREETING_VIDEO',
] as const;

export function testScenarioLabels(
  freeScenarios: readonly string[],
  labels: Record<string, string>
): string[] {
  const given = new Set(freeScenarios);
  return TEST_SCENARIO_ORDER.filter((code) => given.has(code))
    .map((code) => labels[code])
    .filter((label): label is string => Boolean(label));
}

/**
 * Показывать ли плашку.
 *
 * Не «отмечен тестовым», а «отмечен И что-то открыто»: аккаунт с
 * флагом и пустым списком галочек работает как обычный, и благодарить
 * его за бесплатный проход, которого нет, — обман.
 */
export function showsTestAccess(
  testAccess: { isTestUser: boolean; freeScenarios: readonly string[] } | null,
  labels: Record<string, string>
): boolean {
  if (!testAccess?.isTestUser) return false;
  return testScenarioLabels(testAccess.freeScenarios, labels).length > 0;
}
