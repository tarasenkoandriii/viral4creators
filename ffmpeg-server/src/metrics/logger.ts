/**
 * Структурный JSON-лог (ТЗ §12). В журнал не попадают: ключи, токены,
 * URL (включая query), команды, тексты субтитров/речи. Защита двойная:
 * вызывающий код не передаёт такие поля, а санитайзер вырезает поля с
 * опасными именами и строки, похожие на URL/токены.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

const FORBIDDEN_KEYS =
  /(token|secret|password|authorization|api[_-]?key|idempotency|cookie|url|command|argv|payload|stderr|subtitle|text)/i;
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"']+/gi;
const QUERY_RE = /\?[^\s"']*/g;

export function sanitizeValue(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') {
    return v.replace(URL_RE, '[url]').slice(0, 500);
  }
  if (v === null || typeof v !== 'object') return v;
  if (depth > 3) return '[…]';
  if (Array.isArray(v))
    return v.slice(0, 20).map((x) => sanitizeValue(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.test(k)) continue;
    out[k] = sanitizeValue(val, depth + 1);
  }
  return out;
}

/** Путь запроса для access log: без query и без значения by-key. */
export function safeLogPath(rawUrl: string): string {
  const p = rawUrl.replace(QUERY_RE, '').split('#')[0];
  if (p.startsWith('/api/jobs/by-key/')) return '/api/jobs/by-key/:key';
  if (p.startsWith('/api/files/')) {
    const parts = p.split('/');
    // /api/files/:jobId/:name — имя файла клиента в лог не пишем.
    return parts.length >= 5 ? `/api/files/${parts[3]}/:name` : '/api/files';
  }
  return p.slice(0, 200);
}

export interface Logger {
  log(level: LogLevel, event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  debug(event: string, fields?: LogFields): void;
}

export function createLogger(
  sink: (line: string) => void = (l) => process.stdout.write(l + '\n'),
  minLevel: LogLevel = 'info',
): Logger {
  const order: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };
  const log = (level: LogLevel, event: string, fields: LogFields = {}) => {
    if (order[level] < order[minLevel]) return;
    const clean = sanitizeValue(fields) as LogFields;
    sink(
      JSON.stringify({ ts: new Date().toISOString(), level, event, ...clean }),
    );
  };
  return {
    log,
    info: (e, f) => log('info', e, f),
    warn: (e, f) => log('warn', e, f),
    error: (e, f) => log('error', e, f),
    debug: (e, f) => log('debug', e, f),
  };
}

/** Безопасное описание ошибки: только класс и код, не сообщение. */
export function errorKind(e: unknown): string {
  if (e && typeof e === 'object') {
    const code = (e as { code?: unknown }).code;
    const name = (e as { name?: unknown }).name;
    return (
      [name, code].filter((x) => typeof x === 'string').join(':') || 'Error'
    );
  }
  return typeof e;
}
