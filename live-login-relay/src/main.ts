/**
 * Точка входа — doc/LIVE-LOGIN-RELAY-SPEC.md §13. Поднимает один
 * HTTP-сервер с WS-апгрейдом на нём же (не два отдельных порта).
 */

import { createServer } from 'node:http';
import { loadConfig, ConfigError } from './config';
import { createLogger } from './logger';
import { SessionManager } from './session-manager';
import { handleHttpRequest } from './http-routes';
import { createWsUpgradeHandler } from './ws-handler';
import { launchRelayBrowser } from './launch-browser';

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      // eslint-disable-next-line no-console
      console.error(`[live-login-relay] отказ стартовать: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const logger = createLogger(config.logLevel);

  const sessionManager = new SessionManager({
    maxConcurrentSessions: config.maxConcurrentSessions,
    wallTimeoutMs: config.sessionWallTimeoutMs,
    idleTimeoutMs: config.sessionIdleTimeoutMs,
    resultCacheMs: config.resultCacheMs,
    logger,
    launchBrowser: () => launchRelayBrowser(config.puppeteerExecutablePath),
  });

  let shuttingDown = false;

  const server = createServer((req, res) => {
    handleHttpRequest(req, res, {
      relaySecret: config.relaySecret,
      sessionManager,
      logger,
      wsPathFor: (sessionId) => `/sessions/${sessionId}/stream`,
      isShuttingDown: () => shuttingDown,
    }).catch((err) => {
      logger.error('unhandled request error', { error: String(err) });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: 'internal error' }));
    });
  });

  server.on(
    'upgrade',
    createWsUpgradeHandler({
      sessionManager,
      wsAuthTimeoutMs: config.wsAuthTimeoutMs,
      logger,
    }),
  );

  server.listen(config.port, () => {
    logger.info('live-login-relay listening', { port: config.port });
  });

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    server.close();
    await sessionManager.shutdown();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main();
