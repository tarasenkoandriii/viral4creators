/**
 * Чтение и валидация переменных окружения — doc/LIVE-LOGIN-RELAY-SPEC.md
 * §4. Fail-fast: `loadConfig()` бросает СРАЗУ при старте процесса, если
 * обязательная переменная пуста — тот же принцип, что
 * `configuration.ts`/`validateConfiguration` у backend'а (не даём
 * процессу подняться в заведомо нерабочем состоянии и упасть на первом
 * запросе вместо старта).
 */

export class ConfigError extends Error {}

export interface RelayConfig {
  port: number;
  puppeteerExecutablePath: string;
  relaySecret: string;
  maxConcurrentSessions: number;
  sessionWallTimeoutMs: number;
  sessionIdleTimeoutMs: number;
  resultCacheMs: number;
  wsAuthTimeoutMs: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const puppeteerExecutablePath = env.PUPPETEER_EXECUTABLE_PATH?.trim();
  if (!puppeteerExecutablePath) {
    throw new ConfigError(
      'PUPPETEER_EXECUTABLE_PATH не задан — см. doc/LIVE-LOGIN-RELAY-SPEC.md §11, путь должен быть выставлен ENV в образе',
    );
  }

  const relaySecret = env.LIVE_LOGIN_RELAY_SECRET?.trim();
  if (!relaySecret) {
    throw new ConfigError(
      'LIVE_LOGIN_RELAY_SECRET не задан — реле не может стартовать без общего секрета с backend (doc/LIVE-LOGIN-RELAY-SPEC.md §10.1, нет dev-исключения)',
    );
  }

  return {
    port: parsePositiveInt(env.PORT, 8088, 'PORT'),
    puppeteerExecutablePath,
    relaySecret,
    maxConcurrentSessions: parsePositiveInt(
      env.MAX_CONCURRENT_SESSIONS,
      10,
      'MAX_CONCURRENT_SESSIONS',
    ),
    sessionWallTimeoutMs: parsePositiveInt(
      env.SESSION_WALL_TIMEOUT_MS,
      180_000,
      'SESSION_WALL_TIMEOUT_MS',
    ),
    sessionIdleTimeoutMs: parsePositiveInt(
      env.SESSION_IDLE_TIMEOUT_MS,
      60_000,
      'SESSION_IDLE_TIMEOUT_MS',
    ),
    resultCacheMs: parsePositiveInt(
      env.RESULT_CACHE_MS,
      60_000,
      'RESULT_CACHE_MS',
    ),
    wsAuthTimeoutMs: parsePositiveInt(
      env.WS_AUTH_TIMEOUT_MS,
      5_000,
      'WS_AUTH_TIMEOUT_MS',
    ),
    logLevel: parseLogLevel(env.LOG_LEVEL),
  };
}

function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ConfigError(
      `${name} должен быть положительным числом, получено: ${JSON.stringify(raw)}`,
    );
  }
  return parsed;
}

function parseLogLevel(raw: string | undefined): RelayConfig['logLevel'] {
  const trimmed = raw?.trim().toLowerCase();
  if (
    trimmed === 'debug' ||
    trimmed === 'info' ||
    trimmed === 'warn' ||
    trimmed === 'error'
  ) {
    return trimmed;
  }
  return 'info';
}
