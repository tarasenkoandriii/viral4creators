/**
 * Общие типы протокола — doc/LIVE-LOGIN-RELAY-SPEC.md §7.1, §8.2, §8.3.
 */

export type SessionState = 'created' | 'streaming' | 'finalizing' | 'closed';

/** Ровно то, что отдаёт CDP `Network.getAllCookies` (§7.1). */
export interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  expires: number;
}

export interface SessionResult {
  cookies: CdpCookie[];
  finalUrl: string;
}

export type CloseReason =
  | 'wall-timeout'
  | 'idle-timeout'
  | 'finalized'
  | 'cancelled'
  | 'server-shutdown'
  | 'superseded';

export interface FrameMetadata {
  offsetTop: number;
  pageScaleFactor: number;
  deviceWidth: number;
  deviceHeight: number;
  scrollOffsetX: number;
  scrollOffsetY: number;
}

/** §8.2 — сервер → клиент. */
export type ServerMessage =
  | {
      type: 'frame';
      data: string; // base64 JPEG
      metadata: FrameMetadata;
      frameAckId: number;
    }
  | { type: 'navigated'; url: string }
  | { type: 'error'; message: string }
  /**
   * Предупреждение ЗА какое-то время до автозакрытия (этап 109).
   * Заведено находкой аудита бизнес-процесса: фича существует, в
   * частности, ради ввода одноразового кода из SMS (§7.4.0 основного
   * ТЗ — «код существует секунды-минуты»), а ожидание этой SMS — это по
   * определению пауза БЕЗ единого движения мыши, то есть ровно то, что
   * идл-таймаут считает «вкладку забыли». Человек не должен узнавать о
   * закрытии постфактум — фронтенду нужен шанс показать «сессия
   * закроется через N секунд» и дать нажать что угодно, чтобы продлить.
   */
  | {
      type: 'expiring';
      reason: 'idle-timeout' | 'wall-timeout';
      msRemaining: number;
    }
  | { type: 'closed'; reason: CloseReason };

export type MouseEventType =
  'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel';
export type MouseButton = 'left' | 'right' | 'middle';
export type KeyEventType = 'keyDown' | 'keyUp' | 'char';

/** §8.3 — клиент → сервер. */
export type ClientMessage =
  | { type: 'auth'; token: string }
  | {
      type: 'mouse';
      event: MouseEventType;
      x: number;
      y: number;
      button?: MouseButton;
      deltaX?: number;
      deltaY?: number;
    }
  | {
      type: 'key';
      event: KeyEventType;
      key: string;
      code: string;
      text?: string;
      /** Устаревший `KeyboardEvent.keyCode`, как его видел браузер
       * человека. Chromium выводит его из `windowsVirtualKeyCode`, и
       * без этого поля страница получает `event.keyCode === 0`. Старые
       * скрипты (в частности виджет входа Telegram) читают именно его,
       * а не `key`/`code`, — для них клавиатура просто не работала. */
      keyCode?: number;
    }
  | { type: 'resize'; width: number; height: number }
  | { type: 'ping' };
