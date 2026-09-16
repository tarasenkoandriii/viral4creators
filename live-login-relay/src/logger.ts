/**
 * Минимальное структурированное логирование в stdout — doc/
 * LIVE-LOGIN-RELAY-SPEC.md §13: Dokploy читает логи контейнера
 * напрямую, отдельная система сбора логов для одного маленького
 * сервиса — оверинжиниринг для объёма этой фичи.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
}

export function createLogger(level: LogLevel): Logger {
  const threshold = LEVEL_ORDER[level];
  const log = (
    lvl: LogLevel,
    msg: string,
    extra?: Record<string, unknown>,
  ): void => {
    if (LEVEL_ORDER[lvl] < threshold) return;
    const entry = { ts: new Date().toISOString(), level: lvl, msg, ...extra };
    process.stdout.write(JSON.stringify(entry) + '\n');
  };
  return {
    debug: (msg, extra) => log('debug', msg, extra),
    info: (msg, extra) => log('info', msg, extra),
    warn: (msg, extra) => log('warn', msg, extra),
    error: (msg, extra) => log('error', msg, extra),
  };
}
