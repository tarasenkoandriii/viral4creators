/**
 * perceptual-hash.ts — dHash (difference hash), "несколько строк кода,
 * без тяжёлых зависимостей", как и предлагает §3.5 ТЗ
 * (doc/TMA-UI-SNAPSHOT-AND-TUTORIAL-VIDEO-SPEC.md), вместо честного
 * pixel-diff (`pixelmatch` и подобные — точнее, но дороже по CPU на
 * serverless-функции с ограниченным временем, см. тот же §3.5).
 *
 * Решение «экран изменился» ночного снимка принимает не сам dHash, а
 * сетка средних яркостей рядом с ним (`computeSnapshotHash`,
 * `hasChanged`): dHash не видел появления целого блока контента (A4
 * doc/TODO.md). dHash оставлен для сравнения со старыми отпечатками.
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

/**
 * Сетка составного отпечатка (`computeSnapshotHash`). 12×24 — под
 * пропорции кадра 390×844 (`CAPTURE_VIEWPORT`): ячейка ≈ 32×35 px, то
 * есть примерно строка текста на две трети ширины телефона — самый
 * мелкий блок, появление которого ещё хочется замечать. Замер при
 * подборе на той же модели экрана, что в perceptual-hash.spec.ts: при
 * 16×32 сдвиг раскладки на 2 px по вертикали уже задевает 8 ячеек
 * сверх порога, при 8×16 однострочная надпись даёт всего 16 уровней в
 * самой задетой ячейке — у самой границы шума.
 *
 * Размер записан В САМОМ отпечатке: поменяете числа — старые и новые
 * отпечатки окажутся несравнимыми по сетке и честно сравнятся по dHash,
 * а не ячейка 5 одной сетки с ячейкой 5 другой.
 */
export const GRID_COLS = 12;
export const GRID_ROWS = 24;

/**
 * Чувствительность «экран изменился» по сетке — выбор владельца, а не
 * константа кода: где провести черту между «мелочь» и «блок» — вопрос
 * того, сколько ложных тревог в Telegram готовы терпеть ради пойманных.
 * Переопределяется переменными окружения (см. `resolveChangeSensitivity`).
 */
export interface ChangeSensitivity {
  /** На сколько уровней яркости (0..255) должна разойтись средняя
   * яркость ячейки, чтобы ячейка считалась изменившейся. */
  cellDelta: number;
  /** Сколько изменившихся ячеек нужно, чтобы изменился экран. */
  minChangedCells: number;
}

/**
 * Умолчания — по замерам на синтетике (perceptual-hash.spec.ts):
 *
 * - `cellDelta = 12`: мигающий курсор даёт 4 уровня в своей ячейке,
 *   смена минут в часах — 5, поворот спиннера — 8, крупные часы — 11,
 *   сдвиг всей раскладки на 2 px — 11 (и при пороге 8 уже задевает 3 ячейки — отсюда не 8);
 *   самая слабая пойманная правка (одна строка из 20 знаков) даёт до
 *   20, и 5 её ячеек выше 12. Двенадцать — между.
 * - `minChangedCells = 3`: точечная правка (курсор, часы, мигающий
 *   индикатор) задевает одну ячейку, а легла на границу — две: индикатор
 *   16×16 на границе даёт 2 ячейки по 22 уровня, и при пороге в одну-две
 *   ячейки был бы тревогой. Три — первое число, которое точечная правка
 *   не набирает. Однострочная надпись набирает 5, блок из двух строк —
 *   11–15, кнопка — 9. Спиннер при повороте ячеек не набирает вовсе
 *   (до 8 уровней): его «чернил» в ячейке не становится больше.
 */
export const DEFAULT_CHANGE_SENSITIVITY: ChangeSensitivity = {
  cellDelta: 12,
  minChangedCells: 3,
};

/** Имена переменных окружения для `resolveChangeSensitivity`. */
export const SENSITIVITY_ENV = {
  cellDelta: 'UI_SNAPSHOT_CELL_DELTA',
  minChangedCells: 'UI_SNAPSHOT_MIN_CHANGED_CELLS',
} as const;

/**
 * Чувствительность из окружения. Неверное значение (не целое, вне
 * диапазона) не роняет ночной прогон и не превращается в 0 молча —
 * берётся умолчание, а имя переменной возвращается в `invalid`, чтобы
 * вызывающий громко записал это в лог. `cellDelta = 0` и
 * `minChangedCells = 0` запрещены: первое делает тревогой любой шум
 * округления, второе — любой снимок вообще.
 */
export function resolveChangeSensitivity(
  env: Record<string, string | undefined>,
): { sensitivity: ChangeSensitivity; invalid: string[] } {
  const invalid: string[] = [];
  const read = (name: string, fallback: number, max: number): number => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > max) {
      invalid.push(name);
      return fallback;
    }
    return n;
  };
  return {
    sensitivity: {
      cellDelta: read(
        SENSITIVITY_ENV.cellDelta,
        DEFAULT_CHANGE_SENSITIVITY.cellDelta,
        255,
      ),
      minChangedCells: read(
        SENSITIVITY_ENV.minChangedCells,
        DEFAULT_CHANGE_SENSITIVITY.minChangedCells,
        GRID_COLS * GRID_ROWS,
      ),
    },
    invalid,
  };
}

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
  return dHashOf(PNG.sync.read(buffer));
}

/** Средняя яркость каждой ячейки сетки `cols×rows`, построчно. Одна
 * функция на dHash и на сетку составного отпечатка — чтобы оба считали
 * ячейки одинаково и не расходились в округлении границ. */
function lumaGrid(png: PNG, cols: number, rows: number): number[][] {
  const { width, height, data } = png;
  const grid: number[][] = [];
  for (let gy = 0; gy < rows; gy++) {
    const row: number[] = [];
    const y0 = Math.floor((gy * height) / rows);
    const y1 = Math.floor(((gy + 1) * height) / rows);
    for (let gx = 0; gx < cols; gx++) {
      const x0 = Math.floor((gx * width) / cols);
      const x1 = Math.floor(((gx + 1) * width) / cols);
      row.push(averageLuma(data, width, height, x0, y0, x1, y1));
    }
    grid.push(row);
  }
  return grid;
}

function dHashOf(png: PNG): string {
  // Даунсемплинг до HASH_WIDTH×HASH_HEIGHT усреднением блоков — грубее,
  // чем билинейный ресайз, но для устойчивости dHash к шуму сжатия
  // (см. доккомментарий модуля) этого достаточно, тот же порядок
  // точности, что и у `jimp.resize()` для этой конкретной задачи.
  const grid = lumaGrid(png, HASH_WIDTH, HASH_HEIGHT);

  let bits = '';
  for (let y = 0; y < HASH_HEIGHT; y++) {
    for (let x = 0; x < HASH_WIDTH - 1; x++) {
      bits += grid[y][x] > grid[y][x + 1] ? '1' : '0';
    }
  }
  return bitsToHex(bits);
}

/**
 * Составной отпечаток снимка: `<dHash 16 hex>:g<cols>x<rows>:<сетка>`,
 * где сетка — средняя яркость каждой ячейки, по два hex-символа
 * (0..255) на ячейку, построчно.
 *
 * Зачем сетка поверх dHash. dHash 8×8 сравнивает СОСЕДНИЕ ячейки
 * размером в восьмую часть экрана: появившийся абзац равномерно
 * затемняет целую строку ячеек, направления «левая темнее правой»
 * почти не меняются — отсюда 4 бита на живом полигоне (§11-седециес
 * ТЗ) и 2–6 на синтетике. И обратное: на белом фоне соседние ячейки
 * РАВНЫ, и любой шум в один уровень перекидывает бит.
 *
 * Сетка сравнивает ячейку с ТОЙ ЖЕ ячейкой прошлого снимка по
 * абсолютной яркости — это и есть вопрос «здесь стало что-то другое?».
 * Шум отсекается дважды: усреднением по ячейке (пиксельный шум
 * гасится в ноль) и требованием нескольких ячеек (курсор, цифра часов
 * задевают одну-две). Почему не dHash по тайлам, как предлагалось в
 * задаче: замер при подборе (тайлы 2×4, та же модель экрана)
 * показал, что тайловый dHash наследует обе болезни целого — новая
 * кнопка на пустом месте дала 2 бита из 64 в своём тайле, пиксельный
 * шум — 36, сдвиг на 1 px — 8.
 *
 * dHash остаётся в отпечатке, а не выбрасывается: по нему сравнивается
 * новый снимок со старым, у которого сетки нет (см. `hasChanged`).
 */
export function computeSnapshotHash(buffer: Buffer): string {
  const png = PNG.sync.read(buffer);
  const cells = lumaGrid(png, GRID_COLS, GRID_ROWS)
    .flat()
    .map((v) => Math.round(v).toString(16).padStart(2, '0'))
    .join('');
  return `${dHashOf(png)}:g${GRID_COLS}x${GRID_ROWS}:${cells}`;
}

interface ParsedSnapshotHash {
  dHash: string;
  grid: { cols: number; rows: number; cells: number[] } | null;
}

/** Разбирает и старый формат (голые hex — только dHash), и составной.
 * Неразборчивая строка остаётся «dHash» как есть: `hammingDistance`
 * вернёт для неё Infinity по длине, то есть «несравнимо → изменилось»,
 * как и было до составного формата. */
function parseSnapshotHash(hash: string): ParsedSnapshotHash {
  const m = /^([0-9a-f]+):g(\d+)x(\d+):([0-9a-f]*)$/.exec(hash);
  if (!m) return { dHash: hash, grid: null };
  const cols = Number(m[2]);
  const rows = Number(m[3]);
  const hex = m[4];
  if (hex.length !== cols * rows * 2) return { dHash: m[1], grid: null };
  const cells: number[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    cells.push(parseInt(hex.slice(i, i + 2), 16));
  }
  return { dHash: m[1], grid: { cols, rows, cells } };
}

/** Число ячеек, чья яркость разошлась больше `cellDelta`; `null`, если
 * сетки сравнить нельзя (у одного из снимков её нет или размеры
 * разные) — тогда решает dHash. */
function changedCellCount(
  a: ParsedSnapshotHash,
  b: ParsedSnapshotHash,
  cellDelta: number,
): number | null {
  if (!a.grid || !b.grid) return null;
  if (a.grid.cols !== b.grid.cols || a.grid.rows !== b.grid.rows) return null;
  let changed = 0;
  for (let i = 0; i < a.grid.cells.length; i++) {
    if (Math.abs(a.grid.cells[i] - b.grid.cells[i]) > cellDelta) changed++;
  }
  return changed;
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

/**
 * Нормализованное [0..1] расстояние — то, что пишется в
 * `UiSnapshot.diffScore` (§3.4 ТЗ), чтобы поле не зависело от того,
 * сколько бит в текущей версии хэша.
 *
 * Для пары составных отпечатков (см. `computeSnapshotHash`) — ДОЛЯ
 * изменившихся ячеек сетки, то есть «какая часть экрана поменялась».
 * Иначе число в колонке говорило бы про dHash, а решение `changed`
 * принималось бы по сетке, и оператор видел бы «0.03, но изменилось»
 * без способа понять, откуда это. Со старым (голым 16-hex) отпечатком
 * сравнивать сетку не с чем — считается по dHash, как раньше.
 */
export function diffScore(
  hashA: string,
  hashB: string,
  sensitivity: ChangeSensitivity = DEFAULT_CHANGE_SENSITIVITY,
): number {
  const a = parseSnapshotHash(hashA);
  const b = parseSnapshotHash(hashB);
  const cells = changedCellCount(a, b, sensitivity.cellDelta);
  // Делитель — размер сетки ИЗ отпечатка, а не текущие GRID_COLS/ROWS:
  // сравнимы только сетки одного размера, и доля должна быть его долей.
  if (cells !== null && a.grid) return cells / a.grid.cells.length;
  const distance = hammingDistance(a.dHash, b.dHash);
  if (!Number.isFinite(distance)) return 1;
  return distance / HASH_BITS;
}

/**
 * "Изменилось" (§3.1 ТЗ: "отпечатки разошлись больше порога").
 *
 * Когда у ОБОИХ отпечатков есть сетка одного размера — решает сетка:
 * изменились хотя бы `minChangedCells` ячеек, каждая больше чем на
 * `cellDelta` уровней яркости. dHash в этом случае в решении не
 * участвует вовсе: замер (perceptual-hash.spec.ts) показал, что он
 * одновременно слеп (появившийся блок — 2–6 бит при пороге 10) и
 * пуглив (шум ±2 уровня на пиксель — 20+ бит), то есть добавление его
 * через «ИЛИ» вернуло бы ровно те ложные тревоги, от которых сетка
 * избавляет.
 *
 * Со старым отпечатком (голые 16 hex, записанные до появления сетки)
 * или при несовпадении размеров сетки — прежнее правило по dHash и
 * `CHANGE_THRESHOLD_BITS`: колонка `diffHash` — строка без миграции, и
 * первая ночь после выкладки сравнивает новый снимок со старым. Строгое
 * «не сравнимо → изменилось» дало бы на каждом маршруте ложную тревогу
 * в первую же ночь, «не сравнимо → не изменилось» — слепую ночь. dHash
 * у нового отпечатка считается ТЕМ ЖЕ алгоритмом, что и старый, —
 * поэтому переходная ночь работает не хуже, чем работала до правки.
 */
export function hasChanged(
  hashA: string,
  hashB: string,
  sensitivity: ChangeSensitivity = DEFAULT_CHANGE_SENSITIVITY,
): boolean {
  const a = parseSnapshotHash(hashA);
  const b = parseSnapshotHash(hashB);
  const cells = changedCellCount(a, b, sensitivity.cellDelta);
  if (cells !== null) return cells >= sensitivity.minChangedCells;
  return hammingDistance(a.dHash, b.dHash) > CHANGE_THRESHOLD_BITS;
}

function bitsToHex(bits: string): string {
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}
