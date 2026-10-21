/**
 * Точка входа контейнера `api`: конфигурация из env (отказ старта при
 * ошибке без вывода секретов), реальные модули EXEC, HTTP, диспетчер,
 * очистка. SIGTERM — мягкая остановка: HTTP закрывается, активная задача
 * остаётся у executor и подхватывается recover при следующем старте.
 */
import { readFileSync } from 'node:fs';
import { createApp } from './app';
import { ConfigError, describeConfig, loadConfig } from './config';
import { createLogger } from './metrics/logger';
import { realPorts } from './queue/adapters';

async function main(): Promise<void> {
  // Каталоги и файлы workspace — group-rw для executor (общая группа
  // ffwork, setgid на корне): API и executor под разными uid.
  process.umask(0o007);
  const log = createLogger();
  let cfg;
  try {
    cfg = loadConfig(process.env);
  } catch (e) {
    if (e instanceof ConfigError) {
      log.error('config.invalid', { reason: e.message });
      process.exit(78); // EX_CONFIG
    }
    throw e;
  }
  log.info('config.loaded', describeConfig(cfg));
  const caFile = process.env.FFMPEG_SERVER_DOWNLOAD_CA_FILE?.trim();
  const app = await createApp({
    cfg,
    ports: realPorts(cfg),
    log,
    downloadExtra: caFile ? { ca: readFileSync(caFile) } : {},
  });
  const port = await app.listen();
  log.info('http.listening', { port });
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('app.stopping', { signal });
    const force = setTimeout(() => process.exit(1), 20_000);
    force.unref();
    app
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

void main().catch((e: unknown) => {
  createLogger().error('app.crashed', { error: (e as Error)?.name ?? 'Error' });
  process.exit(1);
});
