/**
 * WebSocket-протокол — doc/LIVE-LOGIN-RELAY-SPEC.md §8. Токен НЕ в
 * query-строке (§8, обоснование там же) — первое сообщение клиента
 * обязано быть `{type:"auth", token}`.
 */

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { SessionNotFoundError, type SessionManager } from './session-manager';
import type { Session, WsChannel } from './session';
import type { ClientMessage, ServerMessage } from './types';
import type { Logger } from './logger';

export interface WsHandlerDeps {
  sessionManager: SessionManager;
  wsAuthTimeoutMs: number;
  logger: Logger;
}

const STREAM_PATH = /^\/sessions\/([^/]+)\/stream$/;

export type UpgradeHandler = (
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
) => void;

export function createWsUpgradeHandler(deps: WsHandlerDeps): UpgradeHandler {
  const wss = new WebSocketServer({ noServer: true });

  return function handleUpgrade(req, socket, head): void {
    const url = new URL(req.url ?? '/', 'http://internal');
    const match = url.pathname.match(STREAM_PATH);
    if (!match) {
      socket.destroy();
      return;
    }

    let session: Session;
    try {
      session = deps.sessionManager.getSession(match[1]);
    } catch (err) {
      if (err instanceof SessionNotFoundError) {
        socket.destroy();
        return;
      }
      throw err;
    }

    if (session.state !== 'created' && session.state !== 'streaming') {
      // §8.1 — сессия уже завершена/завершается: апгрейд бессмыслен.
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      bindConnection(ws, session, deps);
    });
  };
}

function bindConnection(
  ws: WebSocket,
  session: Session,
  deps: WsHandlerDeps,
): void {
  let authenticated = false;

  // Реальный close(), не просто отправка сообщения — нужен для вытеснения
  // старого соединения в attachWs() (§8.1 п.3, найдено аудитом).
  const channel: WsChannel = {
    send(message: ServerMessage) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    },
    close(code: number, reason: string) {
      if (
        ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING
      ) {
        ws.close(code, reason);
      }
    },
  };

  const authTimer = setTimeout(() => {
    if (!authenticated) ws.close(4001, 'unauthorized');
  }, deps.wsAuthTimeoutMs);

  ws.on('message', (raw: RawData) => {
    let message: ClientMessage;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      // Молча игнорируем один плохой кадр — не роняем соединение из-за
      // одного мусорного сообщения.
      return;
    }

    if (!authenticated) {
      if (message.type !== 'auth' || !session.verifyToken(message.token)) {
        ws.close(4001, 'unauthorized');
        return;
      }
      authenticated = true;
      clearTimeout(authTimer);
      session.attachWs(channel).catch((err) => {
        deps.logger.error('attachWs failed', {
          sessionId: session.id,
          error: String(err),
        });
        ws.close(1011, 'internal error');
      });
      return;
    }

    switch (message.type) {
      case 'mouse':
        session.markActivity();
        void session.dispatchMouse(message);
        break;
      case 'key':
        session.markActivity();
        void session.dispatchKey(message);
        break;
      case 'resize':
        // Не считается активностью (§8.3) — сам по себе не доказывает,
        // что человек продолжает вводить капчу/код.
        void session.resize(message.width, message.height);
        break;
      case 'ping':
        // Транспортный keepalive — тоже НЕ активность (§8.3).
        break;
      default:
        break;
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    session.detachWs(channel);
  });

  ws.on('error', (err) => {
    deps.logger.warn('ws connection error', {
      sessionId: session.id,
      error: String(err),
    });
  });
}
