/**
 * Сценарии бесплатного использования у тестовых пользователей
 * (TODO §III п.37) — зеркало `backend/src/common/test-user-scenarios.ts`.
 *
 * Список продублирован сознательно, как и остальные общие перечисления
 * админки (режимы, статусы подписки): общего пакета между `backend` и
 * `admin` в монорепозитории нет, а заводить его ради трёх строк дороже,
 * чем держать их синхронными. Бэкенд проверяет значения сам и отвечает
 * отказом на незнакомое — расхождение здесь станет видно сразу, а не
 * молча откроет лишнее.
 */

export type FreeScenario = 'PRODUCT_VIDEO' | 'CLIENT_SITE' | 'GREETING_VIDEO';

export const FREE_SCENARIOS: readonly FreeScenario[] = [
  'PRODUCT_VIDEO',
  'CLIENT_SITE',
  'GREETING_VIDEO',
];

export const FREE_SCENARIO_LABELS: Record<FreeScenario, string> = {
  PRODUCT_VIDEO: 'Видеореклама товара',
  CLIENT_SITE: 'Обучалка по сайту',
  GREETING_VIDEO: 'Поздравление',
};

/** Подсказка под галочкой: что именно она покрывает. */
export const FREE_SCENARIO_HINTS: Record<FreeScenario, string> = {
  PRODUCT_VIDEO: 'Обычный проект и линейка — первый и второй типы проекта',
  CLIENT_SITE: 'Проект-обучалка по сайту заказчика',
  GREETING_VIDEO: 'Персонализированный ролик-поздравление',
};
