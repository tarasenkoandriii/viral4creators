/**
 * Журнал воркера без ПД (Э-С Ш3): JSON-строки в stdout, только поля из
 * белого списка (id задания, вид, попытка, код, длительность, счётчики,
 * хост сайта — имя бизнеса, не человека). Адресов с путём и query нет
 * никогда (в них бывают e-mail, номера заказов, токены). Строковые
 * значения проходят через редактор секретов: всё, что сейчас лежит в
 * `SecretBox`, заменяется на `[secret]` — даже если код по ошибке передал
 * секрет в поле журнала.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export const LOG_FIELDS = [
  'jobId',
  'kind',
  'attempt',
  'code',
  'ms',
  'count',
  'host',
  'workerId',
  'status',
  'retry',
  'jobs',
  'kinds',
  'blocked',
  'pages',
  'refused',
  'reason',
  'sandbox',
  'version',
  'running',
  'forced',
  'bytes',
  'cut',
  'writes',
] as const;
export type LogField = (typeof LOG_FIELDS)[number];
export type LogFields = Partial<Record<LogField, string | number | boolean>>;

const live = new Set<string>();

/** Секрет на время жизни (SecretBox) — вырезается из любой строки журнала. */
export function registerSecret(s: string): void {
  if (s.length >= 4) live.add(s);
}

export function unregisterSecret(s: string): void {
  live.delete(s);
}

/** Сколько секретов сейчас живо (тесты: после задания — 0). */
export function liveSecretCount(): number {
  return live.size;
}

export function redact(text: string): string {
  let out = text;
  for (const s of live)
    if (out.includes(s)) out = out.split(s).join('[secret]');
  return out;
}

export interface Logger {
  debug(msg: string, f?: LogFields): void;
  info(msg: string, f?: LogFields): void;
  warn(msg: string, f?: LogFields): void;
  error(msg: string, f?: LogFields): void;
}

export function createLogger(
  level: Level = 'info',
  sink: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
): Logger {
  const write = (lvl: Level, msg: string, f: LogFields = {}) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const rec: Record<string, unknown> = {
      t: new Date().toISOString(),
      level: lvl,
      msg: redact(msg).slice(0, 300),
    };
    for (const k of LOG_FIELDS) {
      const v = f[k];
      if (v === undefined) continue;
      rec[k] = typeof v === 'string' ? redact(v).slice(0, 200) : v;
    }
    sink(JSON.stringify(rec));
  };
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
  };
}
