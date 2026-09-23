/**
 * Тестовые пользователи: бесплатное использование по сценариям
 * (TODO §III п.37).
 *
 * ## Зачем
 *
 * Проверять продукт целиком должен живой человек живым аккаунтом — с
 * настоящим входом через Telegram, настоящими проектами и настоящими
 * вызовами провайдеров. Сегодня такому человеку мешает ровно одно:
 * суточный потолок расхода (`common/spend-limits.ts`). Один прогон
 * сценария поздравления с генерацией и аватаром съедает дневной лимит
 * Lite целиком, и дальше тестировать нечем до завтра.
 *
 * Обходить это переводом тестировщика в Premium неправильно: тариф
 * меняет ещё и НАБОР ФУНКЦИЙ, то есть проверяться будет не тот продукт,
 * который увидит пользователь. Нужен признак, который снимает потолок и
 * НЕ трогает ничего другого.
 *
 * ## Почему по сценариям, а не одним флагом
 *
 * Тестировщиков у продукта может быть несколько, и каждый ведёт свой
 * участок. Общий флаг «этому всё бесплатно» означает, что любой из них
 * может случайно сжечь бюджет на чужом сценарии — а узнаем мы об этом
 * из отчёта расходов через сутки. Чекбокс на сценарий ограничивает
 * ущерб тем участком, ради которого доступ и выдавался.
 *
 * ## Почему типы проектов 1 и 2 — один чекбокс
 *
 * Решение владельца продукта: `SINGLE` (один товар) и `LINE` (линейка)
 * — это один продуктовый сценарий, видеореклама товара. Разделять их в
 * интерфейсе значит спрашивать оператора о различии, которого для этой
 * задачи нет: тестируют их вместе и одним и тем же путём.
 */

/** Сценарий, на который выдаётся бесплатное использование. */
export type FreeScenario =
  /** Видеореклама товара: обычный проект и линейка (`SINGLE`, `LINE`). */
  | 'PRODUCT_VIDEO'
  /** Обучалка по сайту заказчика (`CLIENT_SITE`). */
  | 'CLIENT_SITE'
  /** Ролик-поздравление (`GREETING_VIDEO`). */
  | 'GREETING_VIDEO';

export const FREE_SCENARIOS: readonly FreeScenario[] = [
  'PRODUCT_VIDEO',
  'CLIENT_SITE',
  'GREETING_VIDEO',
];

/** Подписи для админки — там чекбоксы, а не коды. */
export const FREE_SCENARIO_LABELS: Record<FreeScenario, string> = {
  PRODUCT_VIDEO: 'Видеореклама товара (обычный проект и линейка)',
  CLIENT_SITE: 'Обучалка по сайту заказчика',
  GREETING_VIDEO: 'Ролик-поздравление',
};

/**
 * Тип проекта → сценарий.
 *
 * `null` означает «тип неизвестен», а не «сценария нет»: так отвечают
 * значения enum, появившиеся в схеме позже этого файла. Ответ `null`
 * ведёт к строгому правилу ниже, то есть новый тип проекта по умолчанию
 * НЕ становится бесплатным — забыть добавить его сюда безопасно.
 */
export function scenarioOfProjectType(
  type: string | null | undefined,
): FreeScenario | null {
  switch (type) {
    case 'SINGLE':
    case 'LINE':
      return 'PRODUCT_VIDEO';
    case 'CLIENT_SITE':
      return 'CLIENT_SITE';
    case 'GREETING_VIDEO':
      return 'GREETING_VIDEO';
    default:
      return null;
  }
}

/** Отбрасывает мусор и повторы; порядок — как в `FREE_SCENARIOS`. */
export function normalizeFreeScenarios(value: unknown): FreeScenario[] {
  if (!Array.isArray(value)) return [];
  const set = new Set(value.map((v) => String(v)));
  return FREE_SCENARIOS.filter((s) => set.has(s));
}

/** Есть ли в списке значения, которых мы не знаем (для отказа формы). */
export function unknownScenarios(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const known = new Set<string>(FREE_SCENARIOS);
  return [...new Set(value.map((v) => String(v)))].filter((v) => !known.has(v));
}

export interface TestAccess {
  isTestUser: boolean;
  freeScenarios: readonly string[];
}

/**
 * Снимается ли суточный потолок для этой операции.
 *
 * Три правила, и каждое — про то, чтобы ошибиться в сторону «платно»:
 *
 *  1. **Только тестовым.** Галочки сценариев без флага тестового
 *     пользователя не действуют. Иначе снятый флаг оставлял бы позади
 *     себя невидимое разрешение, которое однажды сработает на живом
 *     аккаунте.
 *  2. **Сценарий известен** — работает его галочка.
 *  3. **Сценарий неизвестен** (операция не привязана к проекту: клон
 *     голоса, озвучка, скетч, поиск на YouTube) — бесплатно только
 *     если отмечены ВСЕ сценарии. Такую операцию нельзя отнести к
 *     участку, поэтому её нельзя и списать на чей-то участок; «хотя бы
 *     один» здесь означал бы, что галочка на поздравления открывает
 *     бесплатный поиск референсов для товарки.
 */
export function isSpendFree(
  access: TestAccess,
  scenario: FreeScenario | null,
): boolean {
  if (!access.isTestUser) return false;
  const free = normalizeFreeScenarios(access.freeScenarios as unknown[]);
  if (!free.length) return false;
  if (scenario) return free.includes(scenario);
  return FREE_SCENARIOS.every((s) => free.includes(s));
}
