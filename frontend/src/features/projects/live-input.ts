/**
 * Ввод в живой сессии — чистые преобразования, без React (§8.3 спеки
 * реле). Отдельный файл по тому же поводу, что `client-site-elements.ts`
 * рядом: в проекте нет рендер-раннера, и единственный способ покрыть
 * эту логику тестом — вынести её из компонента.
 */

/** Столько пикселей считаем за одну «строку» прокрутки. То же число,
 * что у Chromium по умолчанию для `deltaMode === DOM_DELTA_LINE`. */
const PIXELS_PER_LINE = 40;

export interface WheelLike {
  deltaX: number;
  deltaY: number;
  /** 0 — пиксели, 1 — строки, 2 — страницы (`WheelEvent.deltaMode`). */
  deltaMode: number;
}

/**
 * Привести дельты колеса к пикселям — CDP `Input.dispatchMouseEvent`
 * понимает только их.
 *
 * Нужно не «на всякий случай»: Firefox и часть настроек Windows шлют
 * `deltaMode === 1` (строки), где `deltaY` равен 3, а не 100. Без
 * пересчёта страница сдвигалась бы на три пикселя за щелчок колеса —
 * снаружи это выглядит как «прокрутка не работает», ровно тот же
 * симптом, что и полное её отсутствие.
 */
export function wheelToPixels(
  event: WheelLike,
  viewportHeight: number
): {
  deltaX: number;
  deltaY: number;
} {
  const factor =
    event.deltaMode === 1
      ? PIXELS_PER_LINE
      : event.deltaMode === 2
        ? // Страница — это экран целиком; меньше 1 не бывает, иначе
          // «страница» схлопнулась бы в ноль на нулевой высоте канваса.
          Math.max(viewportHeight, 1)
        : 1;
  return { deltaX: event.deltaX * factor, deltaY: event.deltaY * factor };
}

/** Ровно то, что нужно от события клавиатуры, без React и DOM. */
export interface KeyLike {
  key: string;
  code: string;
  keyCode: number;
}

export interface KeyMessage {
  type: 'key';
  event: 'keyDown' | 'keyUp';
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

/**
 * Текст, который CDP вставит в страницу по этому нажатию.
 *
 * Обычный символ — он сам. `Enter` отдельно: `key` у него длиной
 * пять, под правило «одиночный символ» не попадает, а без `text`
 * страница не получает перевод строки — то есть форму входа нельзя
 * отправить с клавиатуры. puppeteer шлёт ровно `\r` (`cdp/Input.js`).
 */
function textOf(key: string): string | undefined {
  if (key.length === 1) return key;
  if (key === 'Enter') return '\r';
  return undefined;
}

/**
 * Пара сообщений на одно нажатие: `keyDown` и `keyUp`.
 *
 * Общая для канваса и для поля под ним — раньше эта сборка жила прямо
 * в обработчике `<input>`, и второй вход (с канваса) неизбежно
 * разъехался бы с первым.
 */
export function keyMessages(event: KeyLike): KeyMessage[] {
  const base = {
    type: 'key' as const,
    key: event.key,
    code: event.code,
    keyCode: event.keyCode,
  };
  const text = textOf(event.key);
  return [
    text === undefined
      ? { ...base, event: 'keyDown' }
      : { ...base, event: 'keyDown', text },
    { ...base, event: 'keyUp' },
  ];
}

/**
 * Перехватывать ли нажатие, когда фокус на канвасе.
 *
 * Перехватывается всё, кроме двух клавиш выхода. Без них человек
 * оказался бы заперт в кадре: `Tab` — единственный способ уйти с
 * канваса с клавиатуры, `Escape` возвращает управление экрану визарда.
 * Цена — эти две клавиши не доедут до чужой страницы; там они нужны
 * несопоставимо реже, чем возможность выбраться.
 */
export function shouldCaptureKey(key: string): boolean {
  return key !== 'Tab' && key !== 'Escape';
}
