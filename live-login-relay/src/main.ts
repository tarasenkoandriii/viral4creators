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

/** §13 спеки: «ждёт завершения всех закрытий не дольше 10с, затем
 * выходит». Не переменная окружения — это не настройка развёртывания, а
 * граница, парная к grace period самого Docker (по умолчанию те же 10с
 * до SIGKILL): смысл именно в том, чтобы успеть выйти самим ДО того,
 * как процесс убьют снаружи. */
const SHUTDOWN_GRACE_MS = 10_000;

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
    navTimeoutMs: config.navTimeoutMs,
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
    // Потолок §13 спеки («ждёт завершения всех закрытий не дольше 10с,
    // затем выходит») — найдено аудитом этапа 108: раньше здесь был
    // голый `await sessionManager.shutdown()` без ограничения по
    // времени. Зависший `browser.close()` (совершенно обычная авария
    // Chromium) держал бы процесс до SIGKILL от Docker — то есть ровно
    // до той жёсткой смерти, которой грейсфул-шатдаун и пытается
    // избежать.
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      sessionManager.shutdown().then(() => false),
      new Promise<true>((resolve) => {
        timer = setTimeout(() => resolve(true), SHUTDOWN_GRACE_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (timedOut) {
      logger.warn('закрытие сессий не уложилось в отведённое время, выходим', {
        graceMs: SHUTDOWN_GRACE_MS,
      });
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Сетка безопасности для долгоживущего процесса (найдено аудитом
  // этапа 108). Конкретные пути, которые роняли реле, закрыты в
  // client-message.ts/ws-handler.ts, но цена ЛЮБОГО пропущенного
  // отклонения здесь непропорциональна: процесс держит браузеры
  // нескольких человек сразу, у каждого — минуты живого времени и уже
  // пройденная капча.
  //
  // Дальше эти два случая ведут себя ПО-РАЗНОМУ, и это осознанно:
  //  - `unhandledRejection` — просто отклонённый промис, состояние
  //    процесса от него не портится: логируем и работаем дальше (иначе
  //    один отвалившийся CDP-вызов уносил бы чужие сессии);
  //  - `uncaughtException` — процесс в неопределённом состоянии, и
  //    рекомендация Node про «не продолжать» здесь уместна. Но тихо
  //    умереть тоже нельзя: пользователи получат обрыв TCP без единого
  //    объяснения. Поэтому — тот же грейсфул-путь, что по SIGTERM:
  //    каждой живой сессии уходит `{type:'closed'}`, браузеры гасятся,
  //    и только потом выход (контейнер под `restart: unless-stopped`
  //    поднимется сам).
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection (процесс продолжает работу)', {
      error: String(reason),
    });
  });
  process.on('uncaughtException', (err) => {
    logger.error('uncaught exception — гасим сессии и выходим', {
      error: String(err),
      stack: err.stack,
    });
    void shutdown('uncaughtException');
  });
}

main();
