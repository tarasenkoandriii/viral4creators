/**
 * perceptual-hash.ts — dHash (difference hash), "несколько строк кода,
 * без тяжёлых зависимостей", как и предлагает §3.5 ТЗ
 * (doc/TMA-UI-SNAPSHOT-AND-TUTORIAL-VIDEO-SPEC.md), вместо честного
 * pixel-diff (`pixelmatch` и подобные — точнее, но дороже по CPU на
 * serverless-функции с ограниченным временем, см. тот же §3.5).
 *
 * Чистые функции без Nest/Prisma/сети — тестируются напрямую готовыми
 * PNG-буферами, тот же приём, что у `route-templates.ts`/`scenario-
 * runner.ts` в этом же модуле-соседе (`tutorial-runner/`).
 *
 * ## Почему `pngjs`, а не `sharp`/`jimp`
 *
 * `sharp` — нативные бинарные привязки (libvips), второй риск размера
 * serverless-бандла ПОВЕРХ уже принятого в §3.2 ТЗ риска Chromium-бинарника
 * (`common/headless-chromium.ts`, `@sparticuz/chromium-min`) — отклонено
 * сразу по этой причине.
 *
 * Изначальный выбор пал на `jimp` (чистый JS, декодирует что угодно), но
 * практический прогон тестов ($ npx jest, этап 100) обнаружил, что
 * `Jimp.read()`/`fromBuffer()` внутри делает НАСТОЯЩИЙ ESM `await
 * import("file-type")` (см. `@jimp/core/dist/commonjs/index.js`,
 * `detectFileTypeFromBuffer`) — под Jest (в отличие от обычного
 * `node -e`, где такой динамический импорт из CJS работает штатно) это
 * падает с `TypeError: A dynamic import callback was invoked without
 * --experimental-vm-modules`, потому что Jest перехватывает глобальный
 * `import()` и без этого флага не умеет разрешать его на настоящий ESM-
 * модуль. Включать `--experimental-vm-modules` ради одного нового модуля
 * означало бы менять общий раннер тестов всего проекта — несоразмерный
 * побочный эффект.
 *
 * Скриншоты сюда попадают ТОЛЬКО от `page.screenshot({type: 'png'})`
 * (`ui-snapshot-runner.service.ts`) — формат заранее известен, поэтому
 * автоопределение MIME вообще не нужно. `pngjs` — прямой, чисто
 * синхронный PNG-кодек без единого встроенного динамического импорта
 * (сам используется декодером PNG внутри `jimp` же, `@jimp/js-png`, то
 * есть настолько же проверенная в бою зависимость) — читает буфер
 * `PNG.sync.read(buffer)` в обычный RGBA-массив пикселей без какой-либо
 * автоопределения формата и асинхронности. Даунсемплинг/градации серого
 * ниже реализованы вручную (усреднение блоков пикселей, не билинейный
 * ресайз) — то немногое, что раньше делал `jimp.resize()/greyscale()`,
 * укладывается в десяток строк и не требует отдельной библиотеки.
 */

import { PNG } from 'pngjs';

/** 9 столбцов → 8 горизонтальных сравнений на строку. */
const HASH_WIDTH = 9;
const HASH_HEIGHT = 8;
/** Итоговая длина хэша в битах — 8 сравнений × 8 строк. */
export const HASH_BITS = (HASH_WIDTH - 1) * HASH_HEIGHT;

/**
 * Порог расстояния Хэмминга (в битах из 64), начиная с которого пара
 * снимков считается "изменившейся" — общепринятая для dHash 8×8
 * эвристика (Neal Krawetz, "Kind of Like That"): ≤10 бит — вариации
 * шума/сжатия у практически одинаковых изображений, >10 — заметное
 * визуальное отличие. Маскирование переменных зон (`data-qa-mask`, см.
 * `ui-snapshot-runner.service.ts`) уже убирает известный источник шума
 * ДО хэширования — порог здесь не пытается компенсировать то, что
 * маскирование не смогло.
 */
export const CHANGE_THRESHOLD_BITS = 10;

/** RGBA-пиксель, усреднённый по прямоугольному блоку исходного
 * изображения (усреднение по площади — тот же принцип, что и area-
 * ресайз у полноценных графических библиотек, только специально под
 * grayscale-яркость, без промежуточного RGB-изображения). */
function averageLuma(
  data: Buffer,
  srcWidth: number,
  srcHeight: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  let sum = 0;
  let count = 0;
  const xEnd = Math.min(x1, srcWidth);
  const yEnd = Math.min(y1, srcHeight);
  for (let y = y0; y < yEnd; y++) {
    for (let x = x0; x < xEnd; x++) {
      const idx = (y * srcWidth + x) * 4;
      // Стандартные веса яркости (ITU-R BT.601) — то же приближение,
      // что и greyscale() большинства графических библиотек.
      sum += 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

/**
 * Считает dHash PNG-буфера — hex-строка длиной 16 символов (64 бита).
 * Бросает, если `pngjs` не смог декодировать буфер (повреждённый
 * скриншот) — вызывающий код (`ui-snapshot-runner.service.ts`) уже
 * оборачивает захват каждого маршрута в try/catch и пишет `error`
 * (§10, пункт 6 аудита), а не роняет весь батч.
 */
export function computeDHash(buffer: Buffer): string {
  const png = PNG.sync.read(buffer);
  const { width, height, data } = png;

  // Даунсемплинг до HASH_WIDTH×HASH_HEIGHT усреднением блоков — грубее,
  // чем билинейный ресайз, но для устойчивости dHash к шуму сжатия
  // (см. доккомментарий модуля) этого достаточно, тот же порядок
  // точности, что и у `jimp.resize()` для этой конкретной задачи.
  const grid: number[][] = [];
  for (let gy = 0; gy < HASH_HEIGHT; gy++) {
    const row: number[] = [];
    const y0 = Math.floor((gy * height) / HASH_HEIGHT);
    const y1 = Math.floor(((gy + 1) * height) / HASH_HEIGHT);
    for (let gx = 0; gx < HASH_WIDTH; gx++) {
      const x0 = Math.floor((gx * width) / HASH_WIDTH);
      const x1 = Math.floor(((gx + 1) * width) / HASH_WIDTH);
      row.push(averageLuma(data, width, height, x0, y0, x1, y1));
    }
    grid.push(row);
  }

  let bits = '';
  for (let y = 0; y < HASH_HEIGHT; y++) {
    for (let x = 0; x < HASH_WIDTH - 1; x++) {
      bits += grid[y][x] > grid[y][x + 1] ? '1' : '0';
    }
  }
  return bitsToHex(bits);
}

/** Расстояние Хэмминга между двумя hex-хэшами одинаковой длины — число
 * несовпадающих бит. `Infinity`, если длины не совпадают (хэши разных
 * версий алгоритма — считать их несравнимыми честнее, чем притворяться
 * числом). */
export function hammingDistance(hashA: string, hashB: string): number {
  if (hashA.length !== hashB.length) return Number.POSITIVE_INFINITY;
  let distance = 0;
  for (let i = 0; i < hashA.length; i++) {
    let x = parseInt(hashA[i], 16) ^ parseInt(hashB[i], 16);
    while (x) {
      distance += x & 1;
      x >>= 1;
    }
  }
  return distance;
}

/** Нормализованное [0..1] расстояние — то, что пишется в
 * `UiSnapshot.diffScore` (§3.4 ТЗ), чтобы поле не зависело от того,
 * сколько бит в текущей версии хэша. */
export function diffScore(hashA: string, hashB: string): number {
  const distance = hammingDistance(hashA, hashB);
  if (!Number.isFinite(distance)) return 1;
  return distance / HASH_BITS;
}

/** "Изменилось" по порогу (§3.1 ТЗ: "отпечатки разошлись больше
 * порога") — использует `CHANGE_THRESHOLD_BITS`, не нормализованный
 * `diffScore`, чтобы порог оставался целым числом бит, а не долей от
 * длины хэша, которая теоретически может измениться в будущем. */
export function hasChanged(hashA: string, hashB: string): boolean {
  return hammingDistance(hashA, hashB) > CHANGE_THRESHOLD_BITS;
}

function bitsToHex(bits: string): string {
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}
