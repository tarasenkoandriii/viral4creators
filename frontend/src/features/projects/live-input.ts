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
