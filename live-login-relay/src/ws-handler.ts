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
import { parseClientMessage } from './client-message';
import type { ServerMessage } from './types';
import type { Logger } from './logger';

export interface WsHandlerDeps {
  sessionManager: SessionManager;
  wsAuthTimeoutMs: number;
  logger: Logger;
}

const STREAM_PATH = /^\/sessions\/([^/]+)\/stream$/;

/** Потолок входящего WS-кадра (найдено вторым проходом аудита этапа
 * 108). У `ws` по умолчанию `maxPayload` — 100 МБ: клиент, знающий
 * только sessionId, мог заставить процесс принять и распарсить
 * стомегабайтный «кадр» — на каждое сообщение, в общем для всех
 * пользователей процессе. Легитимные сообщения протокола §8.3 — сотни
 * байт (самое большое — `key` с текстом), 64 КБ здесь с многократным
 * запасом. */
const MAX_WS_PAYLOAD_BYTES = 64 * 1024;

/** Порог невыбранной очереди отправки, после которого кадры скринкаста
 * ПРОПУСКАЮТСЯ (найдено там же). Кадры генерирует Chromium, а не
 * клиент: если человек на медленной мобильной сети, `ws.send` не
 * успевает выгребать, и JPEG'и копятся в памяти процесса — общей на
 * всех. Видео по своей природе допускает потерю кадров (следующий и так
 * перерисует экран целиком), поэтому правильное поведение — уронить
 * кадр, а не память. Сообщения СОСТОЯНИЯ (`closed`/`error`/`navigated`)
 * этому порогу не подчиняются: их терять нельзя. */
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

export type UpgradeHandler = (
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
) => void;

export function createWsUpgradeHandler(deps: WsHandlerDeps): UpgradeHandler {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WS_PAYLOAD_BYTES,
  });

  /** §8.1 п.1 спеки требует закрыть соединение именно кодом `4004`
   * «unknown or closed session» («ещё до полноценного апгрейда, если
   * возможно, иначе сразу после»). Найдено аудитом этапа 108: раньше
   * здесь во всех трёх случаях был голый `socket.destroy()` — клиент
   * видел обрыв TCP и не мог отличить «такой сессии нет/она уже
   * закрыта» от «интернет отвалился», хотя протокол специально завёл
   * под это отдельный код. Апгрейд доводится до конца и соединение
   * закрывается штатным WS-кодом — это как раз ветка «иначе сразу
   * после» из спеки. */
  const rejectWithCode = (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.close(4004, 'unknown or closed session');
      // `ws.close()` — вежливое закрытие: библиотека ждёт ответный
      // close-кадр до 30 секунд. Для ЗАВЕДОМО чужого соединения (сессии
      // с таким id нет) держать столько живой объект и таймер — плата за
      // вежливость перед тем, кто перебирает идентификаторы. Даём
      // короткое окно на штатное закрытие и рвём (найдено вторым
      // проходом аудита этапа 108).
      const terminateTimer = setTimeout(() => ws.terminate(), 1000);
      ws.on('close', () => clearTimeout(terminateTimer));
    });
  };

  return function handleUpgrade(req, socket, head): void {
    const url = new URL(req.url ?? '/', 'http://internal');
    const match = url.pathname.match(STREAM_PATH);
    if (!match) {
      // Чужой путь — это вообще не наш протокол, никакого WS-кода тут
      // не ждут: рвём соединение, как и раньше.
      socket.destroy();
      return;
    }

    let session: Session;
    try {
      session = deps.sessionManager.getSession(match[1]);
    } catch (err) {
      if (err instanceof SessionNotFoundError) {
        rejectWithCode(req, socket, head);
        return;
      }
      throw err;
    }

    if (session.state !== 'created' && session.state !== 'streaming') {
      // §8.1 — сессия уже завершена/завершается: апгрейд бессмыслен.
      rejectWithCode(req, socket, head);
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
      if (ws.readyState !== WebSocket.OPEN) return;
      // Противодавление (см. MAX_BUFFERED_BYTES): кадр — расходный
      // материал, состояние — нет.
      if (message.type === 'frame' && ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        return;
      }
      ws.send(JSON.stringify(message));
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

  /** Отклонение CDP-вызова НЕ должно ронять процесс (найдено аудитом
   * этапа 108). Раньше все три вызова шли через `void session.…()` без
   * `.catch` — а отклоняются они в совершенно штатной ситуации: браузер
   * закрылся по wall/idle-таймауту ровно в тот момент, когда человек
   * ещё двигал мышью, и `cdp.send` отвечает «Session closed». Node ≥15
   * по умолчанию завершает процесс на необработанном отклонении, то
   * есть один такой клик убивал ВСЕ параллельные сессии всех
   * пользователей разом. Здесь это ровно то, что нужно проглотить с
   * логом: сессия и так уже закрывается. */
  const dispatch = (what: string, run: () => Promise<void>): void => {
    run().catch((err) => {
      deps.logger.warn('CDP dispatch failed', {
        sessionId: session.id,
        what,
        error: String(err),
      });
    });
  };

  ws.on('message', (raw: RawData) => {
    // Строгая валидация ДО любого использования полей (§8.3, см.
    // доккомментарий client-message.ts): приведение типа в TypeScript
    // ничего не проверяет в рантайме, и до этапа 108 сюда попадало
    // буквально всё, что прислал клиент.
    const message = parseClientMessage(raw.toString());
    if (!message) {
      // Молча игнорируем один плохой кадр — не роняем соединение
      // живому человеку из-за одного мусорного сообщения. ЕДИНСТВЕННОЕ
      // исключение — стадия до аутентификации: там любое сообщение не
      // по протоколу означает, что это не наш клиент, и ждать нечего.
      if (!authenticated) ws.close(4001, 'unauthorized');
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
        dispatch('mouse', () => session.dispatchMouse(message));
        break;
      case 'key':
        session.markActivity();
        dispatch('key', () => session.dispatchKey(message));
        break;
      case 'resize':
        // Не считается активностью (§8.3) — сам по себе не доказывает,
        // что человек продолжает вводить капчу/код.
        dispatch('resize', () => session.resize(message.width, message.height));
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
