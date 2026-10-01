/**
 * Флаг dev-заглушки Gemini (`SITES_DEV_FAKE_GEMINI=true`) — одно место
 * чтения; сама заглушка — modules/site-ai/dev-fake-gemini.ts. Правило двух
 * условий, как у dev-входа (shared/dev-login.ts): действует только вне
 * production, а флаг в production — ошибка конфигурации (старт падает).
 */

export const DEV_FAKE_GEMINI_ENV = 'SITES_DEV_FAKE_GEMINI';

/** Флаг запрошен (значение `true`), без учёта окружения. */
export function devFakeGeminiRequested(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[DEV_FAKE_GEMINI_ENV]?.trim().toLowerCase() === 'true';
}

/** Заглушка действует: флаг И не production. */
export function devFakeGeminiEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return devFakeGeminiRequested(env) && env.NODE_ENV !== 'production';
}

/** Ошибка конфигурации: флаг заглушки в production. */
export function devFakeGeminiProblem(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return devFakeGeminiRequested(env) && env.NODE_ENV === 'production'
    ? `${DEV_FAKE_GEMINI_ENV} задана в production — заглушка Gemini только для локального запуска`
    : null;
}
