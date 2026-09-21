/**
 * Прокрутка в живой сессии (§8.3 спеки реле).
 *
 * Дефект, который эти проверки закрывают: на канвасе живой сессии не
 * было обработчика колеса вовсе — только `onPointerDown/Up/Move`. Реле
 * `mouseWheel` принимало и `deltaX/deltaY` в CDP пробрасывало, то есть
 * транспорт был готов, а отправлять было некому: прокрутить чужую
 * страницу (список стран в форме входа, длинное соглашение, любую
 * ленту) было нечем.
 */
import assert from 'node:assert/strict';
import { wheelToPixels } from '../src/features/projects/live-input';

let passed = 0;
function it(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log('  ✓', name);
}

console.log('live-input: колесо мыши');

it('пиксельный режим проходит как есть', () => {
  assert.deepEqual(
    wheelToPixels({ deltaX: 0, deltaY: 120, deltaMode: 0 }, 800),
    { deltaX: 0, deltaY: 120 }
  );
});

it('строчный режим пересчитывается в пиксели', () => {
  // Firefox и часть настроек Windows шлют deltaY=3 (три строки). Без
  // пересчёта страница сдвинулась бы на три пикселя за щелчок колеса —
  // снаружи это неотличимо от «прокрутка не работает».
  assert.deepEqual(wheelToPixels({ deltaX: 0, deltaY: 3, deltaMode: 1 }, 800), {
    deltaX: 0,
    deltaY: 120,
  });
});

it('постраничный режим считает страницей высоту канваса', () => {
  assert.deepEqual(wheelToPixels({ deltaX: 0, deltaY: 1, deltaMode: 2 }, 844), {
    deltaX: 0,
    deltaY: 844,
  });
});

it('нулевая высота не схлопывает страницу в ноль', () => {
  // Канвас может быть ещё не измерен (первый кадр не пришёл). Умножение
  // на ноль съело бы прокрутку молча.
  assert.deepEqual(wheelToPixels({ deltaX: 0, deltaY: 2, deltaMode: 2 }, 0), {
    deltaX: 0,
    deltaY: 2,
  });
});

it('горизонтальная дельта пересчитывается тем же множителем', () => {
  assert.deepEqual(
    wheelToPixels({ deltaX: 2, deltaY: -1, deltaMode: 1 }, 800),
    { deltaX: 80, deltaY: -40 }
  );
});

it('направление сохраняется — прокрутка вверх остаётся отрицательной', () => {
  assert.ok(
    wheelToPixels({ deltaX: 0, deltaY: -3, deltaMode: 1 }, 800).deltaY < 0
  );
});

console.log(`live-input: ${passed} проверок пройдено`);
