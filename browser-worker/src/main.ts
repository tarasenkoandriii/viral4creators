/**
 * Браузерный воркер Э-С Ш3 — точка входа (doc/DEPLOYMENT.md §6.25).
 * Отдельный пакет монорепо, деплой — Docker на изолированном VPS; живой
 * вход (`live-login-relay`) этот пакет не трогает.
 */
import { createApiClient } from './api-client';
import { BrowserPool } from './browser/pool';
import { ConfigError, loadConfig } from './config';
import { writeHealth } from './health';
import { createLogger } from './logger';
import { Runner } from './runner';

async function main(): Promise<void> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    const msg = e instanceof ConfigError ? e.message : 'ошибка конфигурации';
    process.stderr.write(`${JSON.stringify({ level: 'error', msg })}\n`);
    process.exit(1);
  }
  const logger = createLogger(cfg.logLevel);
  const api = createApiClient({
    baseUrl: cfg.sitesUrl,
    secret: cfg.secret,
    workerId: cfg.workerId,
  });
  const pool = new BrowserPool({
    executablePath: cfg.chromiumPath,
    sandbox: cfg.sandbox,
    rotateJobs: cfg.rotateJobs,
    rotateMs: cfg.rotateMs,
    drainMaxMs: cfg.drainMaxMs,
    logger,
  });
  const testDns = cfg.testDns;
  const runner = new Runner({
    api,
    pool,
    logger,
    kinds: cfg.kinds,
    concurrency: cfg.concurrency,
    pollMs: cfg.pollMs,
    idlePollMaxMs: cfg.idlePollMaxMs,
    shutdownGraceMs: cfg.shutdownGraceMs,
    sealPrivateKey: cfg.sealPrivateKey,
    sealPreviousPrivateKey: cfg.sealPreviousPrivateKey,
    egress: {
      denyCidrs: cfg.egressDeny,
      allowedPorts: cfg.egressPorts,
      upstream: cfg.upstream,
      lookup: testDns
        ? (h: string) => Promise.resolve(testDns.get(h.toLowerCase()) ?? [])
        : undefined,
      ignoreHttpsErrors: cfg.testIgnoreTls,
      traffic: cfg.traffic,
    },
  });
  const health = () =>
    writeHealth(cfg.healthFile, {
      t: Date.now(),
      running: runner.active,
      browser: pool.isUp,
      draining: pool.draining,
      rotations: pool.rotations,
      lastClaimAt: runner.lastClaimAt,
      lastError: runner.lastError,
      completed: runner.completed,
      failed: runner.failed,
    });
  health();
  const hTimer = setInterval(health, 10_000);
  logger.info('воркер запущен', {
    workerId: cfg.workerId,
    kinds: cfg.kinds.join(','),
    sandbox: cfg.sandbox,
    count: cfg.concurrency,
  });
  // Браузер — сразу: песочница, которую ядро/seccomp не пустили, должна
  // ронять контейнер на старте (видно в `docker compose ps` и журнале), а не
  // каждое задание кодом `browser_crashed`.
  try {
    pool.release(await pool.acquire());
  } catch (e) {
    logger.error(
      'Chromium не запустился (песочница: seccomp-профиль и user namespaces — DEPLOYMENT §6.25)',
      {
        sandbox: cfg.sandbox,
        reason: e instanceof Error ? e.name : 'error',
      },
    );
    process.exit(1);
  }
  runner.start();
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info('остановка', { reason: signal });
    void runner
      .shutdown()
      .then(() => pool.close())
      .finally(() => {
        clearInterval(hTimer);
        process.exit(0);
      });
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

void main();
