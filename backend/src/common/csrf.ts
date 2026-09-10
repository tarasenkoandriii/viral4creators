/**
 * Проверка `Origin` для запросов, авторизованных cookie (Б-3.1, Б-3.2).
 *
 * ## Почему одного CORS мало
 *
 * Обе cookie сервиса — админская `admin_session` и пользовательская
 * `user_session` — в проде ставятся с `SameSite=None`, потому что API и
 * приложения живут на разных доменах Vercel. Значит браузер приложит их
 * к кросс-сайтовому `form`-POST, а форма отправляется БЕЗ preflight:
 * CORS запрещает только ЧИТАТЬ ответ, а не отправлять запрос. То есть
 * страница злоумышленника может от имени вошедшего человека проставить
 * согласие с офертой, завести проект или потратить деньги владельца на
 * пробу голоса — и он об этом не узнает.
 *
 * Единственное, что реально останавливает такой запрос, — проверка
 * `Origin`: браузер выставляет его почти на каждый не-safe запрос и
 * подделать его со страницы нельзя.
 *
 * ## Fail-политика (и что в ней изменилось)
 *
 *   - safe-метод (GET/HEAD/OPTIONS) → пропустить;
 *   - `Origin` есть и в списке → пропустить;
 *   - `Origin` есть и не в списке → 403, это и есть CSRF;
 *   - `Origin` отсутствует → пропустить: это не-браузерный клиент (curl,
 *     скрипт), а браузер на не-safe запросе заголовок ставит всегда;
 *   - **список пуст** → раньше проверка молча выключалась целиком. Это и
 *     была находка Б-3.2: `CORS_ORIGIN` в проде забыли — CORS при этом
 *     выглядит настроенным (у него есть умолчание `localhost:5173`,
 *     см. `configuration.ts`), а барьер CSRF снят, и о снятом барьере
 *     не говорит ничто. Теперь в проде пустой список — это отказ, а не
 *     пропуск; на dev-стенде (NODE_ENV !== 'production') поведение
 *     прежнее, иначе локальная работа без переменной стала бы
 *     невозможной.
 *
 * Список читается из той же конфигурации, что и CORS
 * (`config.cors.origins`), а не из сырого `process.env`: два разных
 * источника для одного и того же списка и привели к расхождению.
 *
 * Точное сравнение, без подстановок вида `*.vercel.app`: preview-домены
 * CORS принимает (`main.ts`) осознанно, но давать им право менять данные
 * по cookie — совсем другое решение, и принимать его молча нельзя.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Разобранный список разрешённых источников, без хвостовых слэшей. */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

export interface OriginCheckOptions {
  /** `NODE_ENV`; в проде пустой список означает отказ, а не пропуск. */
  nodeEnv?: string;
}

export function isOriginAllowed(
  method: string,
  originHeader: string | undefined,
  corsOriginEnv: string | undefined,
  options: OriginCheckOptions = {},
): boolean {
  if (SAFE_METHODS.has((method || 'GET').toUpperCase())) return true;

  const allowed = parseAllowedOrigins(corsOriginEnv);
  if (allowed.length === 0) {
    // Прод без списка — отказ: см. «Fail-политика» выше.
    return (options.nodeEnv ?? process.env.NODE_ENV) !== 'production';
  }

  if (!originHeader) return true;
  return allowed.includes(originHeader.replace(/\/+$/, ''));
}

/** Текст отказа один на оба барьера — чтобы его было видно в логах. */
export const CSRF_REJECTED_MESSAGE =
  'Cross-origin request rejected (CSRF protection)';
