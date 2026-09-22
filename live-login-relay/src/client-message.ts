/**
 * Разбор и ВАЛИДАЦИЯ входящих WS-сообщений (§8.3 спеки) — чистая
 * функция, без ws/CDP, ровно затем, чтобы её можно было покрыть тестами
 * (тот же приём, что `auth.ts`/`stream-token.ts` этого же пакета).
 *
 * ## Почему это отдельный файл, а не `JSON.parse` прямо в ws-handler
 *
 * Найдено аудитом этапа 108. До него `ws-handler.ts` делал
 * `JSON.parse(raw)` и ПРИВОДИЛ результат к типу `ClientMessage` —
 * приведение типа в TypeScript не проверяет ничего в рантайме, так что
 * в CDP уходило буквально то, что прислал клиент. Два независимых
 * последствия, оба подтверждены на живом Node:
 *
 * 1. `{"type":"auth"}` без поля `token` → `verifyToken(undefined)` →
 *    `createHash().update(undefined)` бросает `ERR_INVALID_ARG_TYPE`
 *    СИНХРОННО внутри обработчика `ws.on('message')` → uncaught
 *    exception → ПРОЦЕСС РЕЛЕ ПАДАЕТ целиком, вместе со всеми живыми
 *    сессиями всех остальных пользователей. Апгрейд WS не требует
 *    токена (§8.1: `sessionId` в пути — «сам по себе не секрет»), то
 *    есть это был неаутентифицированный DoS одним сообщением.
 * 2. `{"type":"mouse","event":"что угодно","x":"abc"}` уходило в
 *    `Input.dispatchMouseEvent` как есть — CDP отвечает ошибкой,
 *    промис отклоняется, а вызывался он через `void` без `.catch` →
 *    unhandled rejection → снова падение процесса (Node ≥15 по
 *    умолчанию завершает процесс на необработанном отклонении).
 *
 * Поэтому: сначала строгая проверка формы сообщения ЗДЕСЬ, и только
 * потом что-либо делается с его полями. Незнакомое/битое сообщение —
 * `null`, вызывающий его молча игнорирует (один мусорный кадр не повод
 * рвать соединение живому человеку, который в этот момент вводит капчу).
 */

import type { ClientMessage, KeyEventType, MouseEventType } from './types';

const MOUSE_EVENTS: readonly MouseEventType[] = [
  'mousePressed',
  'mouseReleased',
  'mouseMoved',
  'mouseWheel',
];
const KEY_EVENTS: readonly KeyEventType[] = ['keyDown', 'keyUp', 'char'];
/**
 * `'none'` здесь не для полноты, а по факту протокола: у `mouseWheel`
 * зажатой кнопки нет, и клиент честно шлёт `'none'`. Без него валидатор
 * отбрасывал КАЖДОЕ событие прокрутки — сообщение не проходило
 * проверку, ws-handler молча его игнорировал (один мусорный кадр не
 * повод рвать соединение), и до `dispatchMouse` оно не доходило вовсе.
 * Снаружи это выглядело как «прокрутка не работает», а в счётчиках
 * сессии стоял ровный `wheel=0` при живой мыши и клавиатуре — то есть
 * данные указывали на клиент, хотя виноват был приёмник.
 *
 * Тот же словарь, что у `buttonFromMask()` в `session.ts`: она сама
 * возвращает `'none'`, когда не зажато ничего. Расхождение между тем,
 * что реле ПРОИЗВОДИТ, и тем, что оно ПРИНИМАЕТ, и было дефектом.
 */
const MOUSE_BUTTONS = ['left', 'right', 'middle', 'none'] as const;

/** Потолок размеров вьюпорта для `resize` — CDP примет и абсурдные
 * значения, а потом Chromium будет пытаться отрисовать кадр такого
 * размера (в контейнере, общем для всех пользователей: 10000×10000 —
 * это сто миллионов пикселей на одну сессию). 4096 с запасом
 * перекрывает любой реальный экран, с которого сюда придут, — фича
 * рассчитана на телефон внутри Telegram. Тот же принцип «дешёвая
 * защита от мусора, не рабочий сценарий», что и `MAX_BODY_BYTES`
 * (§10.3 спеки). */
const MAX_VIEWPORT_PX = 4096;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Необязательное числовое поле: отсутствует — ок, присутствует —
 * обязано быть конечным числом (а не строкой/NaN/Infinity). */
function optionalFiniteNumber(v: unknown): v is number | undefined {
  return v === undefined || isFiniteNumber(v);
}

function isViewportSide(v: unknown): v is number {
  return isFiniteNumber(v) && v > 0 && v <= MAX_VIEWPORT_PX;
}

/**
 * Разбирает сырой текст WS-кадра в валидное сообщение протокола §8.3.
 * `null` — «сообщение не по протоколу», вызывающий его игнорирует.
 */
export function parseClientMessage(raw: string): ClientMessage | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(json)) return null;

  switch (json.type) {
    case 'auth':
      // Именно здесь и падал процесс до этапа 108: токен обязан быть
      // непустой СТРОКОЙ, прежде чем попасть в sha256.
      return typeof json.token === 'string' && json.token.length > 0
        ? { type: 'auth', token: json.token }
        : null;

    case 'mouse': {
      if (!MOUSE_EVENTS.includes(json.event as MouseEventType)) return null;
      if (!isFiniteNumber(json.x) || !isFiniteNumber(json.y)) return null;
      if (
        json.button !== undefined &&
        !MOUSE_BUTTONS.includes(json.button as (typeof MOUSE_BUTTONS)[number])
      ) {
        return null;
      }
      if (!optionalFiniteNumber(json.deltaX)) return null;
      if (!optionalFiniteNumber(json.deltaY)) return null;
      return {
        type: 'mouse',
        event: json.event as MouseEventType,
        x: json.x,
        y: json.y,
        button: json.button as (typeof MOUSE_BUTTONS)[number] | undefined,
        deltaX: json.deltaX as number | undefined,
        deltaY: json.deltaY as number | undefined,
      };
    }

    case 'key': {
      if (!KEY_EVENTS.includes(json.event as KeyEventType)) return null;
      if (typeof json.key !== 'string' || typeof json.code !== 'string') {
        return null;
      }
      if (json.text !== undefined && typeof json.text !== 'string') return null;
      if (!optionalFiniteNumber(json.keyCode)) return null;
      return {
        type: 'key',
        event: json.event as KeyEventType,
        key: json.key,
        code: json.code,
        text: json.text,
        keyCode: json.keyCode as number | undefined,
      };
    }

    case 'resize':
      return isViewportSide(json.width) && isViewportSide(json.height)
        ? { type: 'resize', width: json.width, height: json.height }
        : null;

    case 'ping':
      return { type: 'ping' };

    default:
      return null;
  }
}
