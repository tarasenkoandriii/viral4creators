/**
 * Чтение и валидация переменных окружения — doc/LIVE-LOGIN-RELAY-SPEC.md
 * §4. Fail-fast: `loadConfig()` бросает СРАЗУ при старте процесса, если
 * обязательная переменная пуста — тот же принцип, что
 * `configuration.ts`/`validateConfiguration` у backend'а (не даём
 * процессу подняться в заведомо нерабочем состоянии и упасть на первом
 * запросе вместо старта).
 */

export class ConfigError extends Error {}

/**
 * Прокси для ПОДКОНТРОЛЬНОГО БРАУЗЕРА — не для самого реле.
 *
 * Chromium ходит через него флагом `--proxy-server`, а HTTP-сервер
 * реле, healthcheck и Traefik остаются на прямом подключении. Поэтому
 * не VPN контейнера: WireGuard потребовал бы `NET_ADMIN` и tun, а в
 * Swarm ещё и конфликтует с `dokploy-network` — сервис перестал бы
 * быть доступен по домену.
 *
 * `username`/`password` отдельными полями НЕ для красоты: Chromium
 * игнорирует учётные данные внутри `--proxy-server`, их приходится
 * отдавать страницей через `page.authenticate()` (см. `Session.create`).
 */
export interface BrowserProxy {
  /** `схема://host:port` — без учётных данных, их Chromium тут не примет. */
  server: string;
  username?: string;
  password?: string;
}

export interface RelayConfig {
  port: number;
  puppeteerExecutablePath: string;
  relaySecret: string;
  maxConcurrentSessions: number;
  sessionWallTimeoutMs: number;
  sessionIdleTimeoutMs: number;
  resultCacheMs: number;
  navTimeoutMs: number;
  wsAuthTimeoutMs: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** `null` — ходим напрямую. По умолчанию именно так. */
  browserProxy: BrowserProxy | null;
}

/** Схемы, которые понимает `--proxy-server` Chromium. */
const PROXY_SCHEMES = ['http:', 'https:', 'socks5:', 'socks4:'];

/**
 * Разбор `LIVE_LOGIN_BROWSER_PROXY_URL`.
 *
 * Fail-fast, как и всё в этом файле: кривое значение роняет старт, а не
 * тихо пускает трафик напрямую. Тихий откат здесь — худший вариант:
 * прокси ставят, когда прямой выход НЕ подходит, и «молча пошли
 * напрямую» означает, что человек узнает об этом от чужого антифрода,
 * а не от логов.
 */
export function parseBrowserProxy(
  raw: string | undefined,
): BrowserProxy | null {
  const value = raw?.trim();
  if (!value) return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(
      'LIVE_LOGIN_BROWSER_PROXY_URL не разбирается как URL — ожидается http://user:pass@host:port',
    );
  }
  if (!PROXY_SCHEMES.includes(url.protocol)) {
    throw new ConfigError(
      `LIVE_LOGIN_BROWSER_PROXY_URL: схема ${url.protocol} не поддерживается Chromium — допустимы ${PROXY_SCHEMES.join(', ')}`,
    );
  }
  if (!url.hostname) {
    throw new ConfigError('LIVE_LOGIN_BROWSER_PROXY_URL: не указан хост');
  }

  // Порт восстанавливается явно: `URL.host` выбрасывает порт, если он
  // совпадает с дефолтным для схемы, и `http://p.example.com:80`
  // превратился бы в `http://p.example.com`. Chromium такой адрес
  // примет, но в логе и в `ps` он выглядел бы иначе, чем задано в
  // переменной, — а это ровно то место, где потом сверяют глазами.
  const port =
    url.port ||
    (url.protocol === 'http:' ? '80' : url.protocol === 'https:' ? '443' : '');
  if (!port) {
    throw new ConfigError(
      `LIVE_LOGIN_BROWSER_PROXY_URL: для схемы ${url.protocol} порт нужно указать явно`,
    );
  }
  const server = `${url.protocol}//${url.hostname}:${port}`;
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (username && !password) {
    throw new ConfigError(
      'LIVE_LOGIN_BROWSER_PROXY_URL: задано имя пользователя без пароля',
    );
  }
  return username ? { server, username, password } : { server };
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
    // 120с, не 60 (этап 109, находка аудита бизнес-процесса): одна из
    // трёх причин, ради которых фича существует, — ввод одноразового
    // кода из SMS (§7.4.0 основного ТЗ, «код существует
    // секунды-минуты»), а ожидание этой SMS по определению проходит без
    // единого события мыши/клавиатуры. На 60 секундах реле закрывало
    // сессию ровно тем людям, ради которых её и заводили. Плюс к
    // потолку клиент теперь получает предупреждение `expiring` за 30с
    // (§8.2) — и может продлить паузу любым действием.
    sessionIdleTimeoutMs: parsePositiveInt(
      env.SESSION_IDLE_TIMEOUT_MS,
      120_000,
      'SESSION_IDLE_TIMEOUT_MS',
    ),
    resultCacheMs: parsePositiveInt(
      env.RESULT_CACHE_MS,
      60_000,
      'RESULT_CACHE_MS',
    ),
    navTimeoutMs: parsePositiveInt(
      env.SESSION_NAV_TIMEOUT_MS,
      20_000,
      'SESSION_NAV_TIMEOUT_MS',
    ),
    wsAuthTimeoutMs: parsePositiveInt(
      env.WS_AUTH_TIMEOUT_MS,
      5_000,
      'WS_AUTH_TIMEOUT_MS',
    ),
    logLevel: parseLogLevel(env.LOG_LEVEL),
    browserProxy: parseBrowserProxy(env.LIVE_LOGIN_BROWSER_PROXY_URL),
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
