/**
 * perceptual-hash.spec.ts — чистые функции, без Nest/Prisma/сети (см.
 * доккомментарий модуля): тестовые PNG собираются напрямую через
 * `pngjs` (та же библиотека, что и сам модуль использует для декодирования
 * — см. доккомментарий `perceptual-hash.ts` про то, почему не `jimp`),
 * реальный headless-браузер здесь не нужен, тот же приём, что у
 * `headless-chromium.spec.ts` для остальной части этого прохода.
 */

import { PNG } from 'pngjs';
import {
  computeDHash,
  computeSnapshotHash,
  CHANGE_THRESHOLD_BITS,
  DEFAULT_CHANGE_SENSITIVITY,
  diffScore,
  GRID_COLS,
  GRID_ROWS,
  hammingDistance,
  hasChanged,
  HASH_BITS,
  resolveChangeSensitivity,
  SENSITIVITY_ENV,
} from './perceptual-hash';

function solidPng(r: number, g: number, b: number): Buffer {
  const png = new PNG({ width: 64, height: 64 });
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      const idx = (64 * y + x) << 2;
      png.data[idx] = r;
      png.data[idx + 1] = g;
      png.data[idx + 2] = b;
      png.data[idx + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

/** Вертикальные чередующиеся чёрно-белые полосы — структура, которую
 * dHash (сравнение СОСЕДНИХ пикселей) реально улавливает, в отличие от
 * гладкого монотонного градиента: у линейного градиента КАЖДАЯ пара
 * соседних сэмплов "левый темнее правого" — то же самое булево
 * направление, что и у однотонного (плоского) изображения, поэтому оба
 * дают тривиальный хэш из одних нулей и неразличимы между собой; полосы
 * дают чередование направления и потому нетривиальный хэш. */
function stripesPng(stripeCount: number): Buffer {
  const size = 64;
  const png = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const stripe = Math.floor((x / size) * stripeCount);
      const shade = stripe % 2 === 0 ? 0 : 255;
      const idx = (size * y + x) << 2;
      png.data[idx] = shade;
      png.data[idx + 1] = shade;
      png.data[idx + 2] = shade;
      png.data[idx + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

describe('computeDHash', () => {
  it('одинаковое изображение — хэш стабилен между вызовами', () => {
    const buf = stripesPng(9);
    const a = computeDHash(buf);
    const b = computeDHash(buf);
    expect(a).toBe(b);
    expect(a).toHaveLength(HASH_BITS / 4); // 16 hex-символов на 64 бита
  });

  it('два независимых захвата ОДНОГО и того же контента дают расстояние 0', () => {
    const bufA = stripesPng(9);
    const bufB = stripesPng(9);
    const hashA = computeDHash(bufA);
    const hashB = computeDHash(bufB);
    expect(hammingDistance(hashA, hashB)).toBe(0);
    expect(hasChanged(hashA, hashB)).toBe(false);
  });

  it('однотонное vs полосатое изображение — заметно расходятся', () => {
    const solid = solidPng(128, 128, 128);
    const stripes = stripesPng(9);
    const hashSolid = computeDHash(solid);
    const hashStripes = computeDHash(stripes);
    expect(hammingDistance(hashSolid, hashStripes)).toBeGreaterThan(
      CHANGE_THRESHOLD_BITS,
    );
    expect(hasChanged(hashSolid, hashStripes)).toBe(true);
  });

  it('два разных однотонных цвета — хэш одинаков (dHash сравнивает СОСЕДНИЕ пиксели, не абсолютную яркость)', () => {
    const black = solidPng(0, 0, 0);
    const white = solidPng(255, 255, 255);
    const hashBlack = computeDHash(black);
    const hashWhite = computeDHash(white);
    // Ожидаемое (не баг) свойство dHash: у однотонного изображения все
    // соседние пиксели равны в обоих случаях → одинаковый хэш. Именно
    // поэтому фикстуры должны быть детерминированы (§3.5 ТЗ) — dHash не
    // отличает "весь экран чёрный" от "весь экран белый", только
    // структуру границ внутри кадра.
    expect(hammingDistance(hashBlack, hashWhite)).toBe(0);
  });
});

describe('hammingDistance/diffScore', () => {
  it('хэши разной длины — Infinity/несравнимы, не число из воздуха', () => {
    expect(hammingDistance('ab', 'abcd')).toBe(Number.POSITIVE_INFINITY);
    expect(diffScore('ab', 'abcd')).toBe(1);
  });

  it('идентичные хэши — расстояние 0, diffScore 0', () => {
    expect(hammingDistance('0f0f0f0f0f0f0f0f', '0f0f0f0f0f0f0f0f')).toBe(0);
    expect(diffScore('0f0f0f0f0f0f0f0f', '0f0f0f0f0f0f0f0f')).toBe(0);
  });

  it('diffScore нормализован в [0..1] относительно HASH_BITS', () => {
    // 'f' vs '0' на одну hex-позицию — все 4 бита разные.
    const distance = hammingDistance('f000000000000000', '0000000000000000');
    expect(distance).toBe(4);
    expect(diffScore('f000000000000000', '0000000000000000')).toBeCloseTo(
      4 / HASH_BITS,
    );
  });
});

describe('hasChanged — порог CHANGE_THRESHOLD_BITS', () => {
  it('расстояние ровно на пороге (10 бит) — ещё не "изменилось" (строгое >)', () => {
    const hashA = '0000000000000000';
    // 'f' (1111) даёт 4 бита, 'c' (1100) даёт 2 бита: 4+4+2 = 10.
    const hashB = 'ffc0000000000000';
    expect(hammingDistance(hashA, hashB)).toBe(10);
    expect(hasChanged(hashA, hashB)).toBe(false);
  });

  it('расстояние больше порога — уже "изменилось"', () => {
    const hashA = '0000000000000000';
    // Три полных hex-символа 'f' — 4+4+4 = 12 бит, больше порога в 10.
    const hashB = 'fff0000000000000';
    expect(hammingDistance(hashA, hashB)).toBe(12);
    expect(hasChanged(hashA, hashB)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A4 doc/TODO.md: появление блока контента против шума.
//
// Синтетический экран размера `CAPTURE_VIEWPORT` (390×844) в оттенках
// серого: шапка, строки «текста», поля формы, кнопка. «Текст» — не
// шрифт (рисовать шрифты pngjs не умеет), а детерминированные штрихи
// 2 px в знакоместах 9×14 — та же плотность «чернил» (~15–20 % площади
// строки), что у настоящего кириллического текста 14–16 px. Генератор
// детерминирован (свой ЛКГ), чтобы замеры в тестах не плавали.
// ---------------------------------------------------------------------------

const SCREEN_W = 390;
const SCREEN_H = 844;

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

type Screen = Uint8ClampedArray;

function blankScreen(shade = 255): Screen {
  return new Uint8ClampedArray(SCREEN_W * SCREEN_H).fill(shade);
}

function fillRect(
  d: Screen,
  x0: number,
  y0: number,
  w: number,
  h: number,
  v: number,
): void {
  for (let y = Math.max(0, y0); y < Math.min(SCREEN_H, y0 + h); y++) {
    for (let x = Math.max(0, x0); x < Math.min(SCREEN_W, x0 + w); x++) {
      d[y * SCREEN_W + x] = v;
    }
  }
}

/** Строка «текста» из `chars` знакомест с 9-px шагом. */
function textLine(
  d: Screen,
  x0: number,
  y0: number,
  chars: number,
  seed: number,
  ink = 30,
): void {
  const r = lcg(seed);
  for (let c = 0; c < chars; c++) {
    const gx = x0 + c * 9;
    if (r() < 0.15) continue; // пробел
    for (let k = 0; k < 4; k++) {
      const vertical = r() < 0.5;
      const sx = gx + Math.floor(r() * 6);
      const sy = y0 + Math.floor(r() * 11);
      if (vertical) fillRect(d, sx, sy, 2, 3 + Math.floor(r() * 8), ink);
      else fillRect(d, sx, sy, 3 + Math.floor(r() * 5), 2, ink);
    }
  }
}

/** Часы в шапке: 5 знаков, `seed` — «время». */
function clock(d: Screen, seed: number, big = false): void {
  fillRect(d, 300, 8, 80, 34, 240);
  if (!big) {
    textLine(d, 330, 17, 5, seed);
    return;
  }
  // Крупные часы: знаки ~2× (18×28), как «12:35» на виджете.
  const r = lcg(seed);
  for (let c = 0; c < 4; c++) {
    for (let k = 0; k < 5; k++) {
      const sx = 300 + c * 19 + Math.floor(r() * 12);
      const sy = 10 + Math.floor(r() * 20);
      if (r() < 0.5) fillRect(d, sx, sy, 3, 6 + Math.floor(r() * 12), 30);
      else fillRect(d, sx, sy, 6 + Math.floor(r() * 8), 3, 30);
    }
  }
}

/** Спиннер: дуга 270° толщиной 3 px, `rot` — фаза поворота в градусах. */
function spinner(d: Screen, cx: number, cy: number, rot: number): void {
  for (let y = -12; y <= 12; y++) {
    for (let x = -12; x <= 12; x++) {
      const r = Math.hypot(x, y);
      if (r < 8 || r > 11) continue;
      const a =
        ((((Math.atan2(y, x) * 180) / Math.PI - rot) % 360) + 360) % 360;
      if (a < 270) d[(cy + y) * SCREEN_W + cx + x] = 60;
    }
  }
}

/** «Пустой» экран мастера: шапка с часами, абзац, два поля, кнопка. */
function baseScreen(clockSeed = 99, bigClock = false): Screen {
  const d = blankScreen();
  fillRect(d, 0, 0, SCREEN_W, 48, 240);
  textLine(d, 16, 17, 20, 1);
  clock(d, clockSeed, bigClock);
  textLine(d, 16, 80, 38, 2);
  textLine(d, 16, 100, 38, 3);
  textLine(d, 16, 120, 20, 4);
  fillRect(d, 16, 160, 358, 40, 225);
  fillRect(d, 18, 162, 354, 36, 255);
  textLine(d, 24, 175, 12, 5);
  fillRect(d, 16, 220, 358, 40, 225);
  fillRect(d, 18, 222, 354, 36, 255);
  fillRect(d, 16, 280, 120, 40, 60);
  textLine(d, 40, 293, 8, 6, 250);
  return d;
}

function toPng(d: Screen): Buffer {
  const png = new PNG({ width: SCREEN_W, height: SCREEN_H });
  for (let i = 0; i < d.length; i++) {
    png.data[i * 4] = d[i];
    png.data[i * 4 + 1] = d[i];
    png.data[i * 4 + 2] = d[i];
    png.data[i * 4 + 3] = 255;
  }
  // `filterType: 0` — без адаптивного подбора фильтра строк: под Jest он
  // стоит ~1.5 с на кадр 390×844 против ~10 мс, а на пиксели после
  // декодирования не влияет никак.
  return PNG.sync.write(png, { filterType: 0 });
}

function shifted(src: Screen, dx: number, dy: number): Screen {
  const d = blankScreen();
  for (let y = 0; y < SCREEN_H; y++) {
    for (let x = 0; x < SCREEN_W; x++) {
      const sx = Math.min(SCREEN_W - 1, Math.max(0, x - dx));
      const sy = Math.min(SCREEN_H - 1, Math.max(0, y - dy));
      d[y * SCREEN_W + x] = src[sy * SCREEN_W + sx];
    }
  }
  return d;
}

const CELLS = GRID_COLS * GRID_ROWS;

/** Замер пары экранов: сколько бит dHash и сколько ячеек сетки. */
function measure(a: Screen, b: Screen) {
  const ha = computeSnapshotHash(toPng(a));
  const hb = computeSnapshotHash(toPng(b));
  return {
    dHashBits: hammingDistance(ha.slice(0, 16), hb.slice(0, 16)),
    cells: Math.round(diffScore(ha, hb) * CELLS),
    changed: hasChanged(ha, hb),
  };
}

/** Правки, которые ОБЯЗАНЫ считаться изменением экрана. */
const CONTENT_CHANGES: Record<string, () => Screen> = {
  'блок из двух строк посреди экрана': () => {
    const d = baseScreen();
    textLine(d, 16, 340, 38, 7);
    textLine(d, 16, 360, 20, 8);
    return d;
  },
  'однострочная надпись из 20 знаков': () => {
    const d = baseScreen();
    textLine(d, 16, 340, 20, 7);
    return d;
  },
  'блок из двух строк внизу экрана': () => {
    const d = baseScreen();
    textLine(d, 16, 600, 38, 7);
    textLine(d, 16, 620, 38, 8);
    return d;
  },
  'новая кнопка 120×40': () => {
    const d = baseScreen();
    fillRect(d, 16, 340, 120, 40, 60);
    return d;
  },
  'тёмная тема вместо светлой': () => {
    const d = baseScreen();
    for (let i = 0; i < d.length; i++) d[i] = 255 - d[i];
    return d;
  },
};

/** Шум, который НЕ должен порождать пересборку/тревогу. */
const NOISE: Record<string, () => Screen> = {
  'сменились минуты в часах': () => baseScreen(123),
  'сменились минуты в крупных часах': () => baseScreen(123, true),
  'мигающий курсор в поле': () => {
    const d = baseScreen();
    fillRect(d, 26, 172, 2, 18, 20);
    return d;
  },
  'пиксельный шум ±2 уровня по всему кадру': () => {
    const d = baseScreen();
    const r = lcg(5);
    for (let i = 0; i < d.length; i++) {
      d[i] = d[i] + Math.round((r() - 0.5) * 4);
    }
    return d;
  },
  // Анимация: мигающий индикатор 16×16 поверх вертикальной границы
  // ячеек — задевает ДВЕ ячейки выше порога. Именно он держит
  // `minChangedCells` на трёх: при одной-двух он был бы тревогой.
  'мигнул индикатор 16×16 на границе ячеек': () => {
    const d = baseScreen();
    fillRect(d, 57, 362, 16, 16, 60);
    return d;
  },
  'повернулся спиннер загрузки': () => {
    const a = baseScreen();
    spinner(a, 81, 387, 0);
    return a;
  },
  'вся раскладка сдвинута на 1 px вправо': () => shifted(baseScreen(), 1, 0),
  'вся раскладка сдвинута на 2 px вниз': () => shifted(baseScreen(), 0, 2),
};

/** Исходный кадр для шума: у крупных часов и спиннера он свой. */
function noiseBase(name: string): Screen {
  if (name.includes('крупных')) return baseScreen(99, true);
  const d = baseScreen();
  if (name.includes('спиннер')) spinner(d, 81, 387, 90);
  return d;
}

describe('A4: сетка видит появившийся блок, но не шум', () => {
  const base = baseScreen();

  it.each(Object.keys(CONTENT_CHANGES))('изменение «%s» — changed', (name) => {
    const m = measure(base, CONTENT_CHANGES[name]());
    expect(m.cells).toBeGreaterThanOrEqual(
      DEFAULT_CHANGE_SENSITIVITY.minChangedCells,
    );
    expect(m.changed).toBe(true);
  });

  it.each(Object.keys(NOISE))('шум «%s» — не changed', (name) => {
    const m = measure(noiseBase(name), NOISE[name]());
    expect(m.cells).toBeLessThan(DEFAULT_CHANGE_SENSITIVITY.minChangedCells);
    expect(m.changed).toBe(false);
  });

  it('воспроизведение находки: dHash блока не видит, а шум принимает за изменение', () => {
    // То, ради чего правка: оба блока — не выше порога dHash, а
    // пиксельный шум — выше. Если этот тест начнёт падать, значит
    // поменялся генератор, и замеры из доккомментариев надо обновить.
    const block = measure(
      base,
      CONTENT_CHANGES['блок из двух строк посреди экрана'](),
    );
    const low = measure(
      base,
      CONTENT_CHANGES['блок из двух строк внизу экрана'](),
    );
    const noise = measure(
      base,
      NOISE['пиксельный шум ±2 уровня по всему кадру'](),
    );
    expect(block.dHashBits).toBeLessThanOrEqual(CHANGE_THRESHOLD_BITS);
    expect(low.dHashBits).toBeLessThanOrEqual(CHANGE_THRESHOLD_BITS);
    expect(noise.dHashBits).toBeGreaterThan(CHANGE_THRESHOLD_BITS);
  });

  it('тот же экран — 0 ячеек и 0 бит', () => {
    const m = measure(base, baseScreen());
    expect(m).toEqual({ dHashBits: 0, cells: 0, changed: false });
  });
});

describe('составной отпечаток и совместимость со старыми', () => {
  const png = toPng(baseScreen());

  it('формат: dHash прежним алгоритмом + размер сетки + два hex на ячейку', () => {
    const hash = computeSnapshotHash(png);
    const [dHash, size, cells] = hash.split(':');
    // Первая часть — ровно то, что раньше писалось в `diffHash`: иначе
    // сравнение со старым снимком в переходную ночь было бы бессмысленным.
    expect(dHash).toBe(computeDHash(png));
    expect(size).toBe(`g${GRID_COLS}x${GRID_ROWS}`);
    expect(cells).toMatch(/^[0-9a-f]+$/);
    expect(cells).toHaveLength(CELLS * 2);
  });

  it('старый отпечаток (голый dHash) против нового — решает dHash и прежний порог', () => {
    const fresh = computeSnapshotHash(png);
    const legacy = fresh.slice(0, 16);
    expect(hasChanged(legacy, fresh)).toBe(false);
    expect(hasChanged(fresh, legacy)).toBe(false);
    expect(diffScore(legacy, fresh)).toBe(0);
    // Разошлись на 12 бит (> 10) — изменилось, как и до правки, даже
    // если бы сетка была одинаковой.
    const flipped =
      (parseInt(legacy.slice(0, 3), 16) ^ 0xfff).toString(16).padStart(3, '0') +
      legacy.slice(3);
    expect(hasChanged(flipped, fresh)).toBe(true);
    expect(diffScore(flipped, fresh)).toBeCloseTo(12 / HASH_BITS);
  });

  /** dHash, отличающийся от данного на 12 бит (> порога в 10). */
  function flipDHash(dHash: string): string {
    const head = (parseInt(dHash.slice(0, 3), 16) ^ 0xfff)
      .toString(16)
      .padStart(3, '0');
    return head + dHash.slice(3);
  }

  it('сетки разного размера — не сравниваются ячейка с ячейкой, решает dHash', () => {
    const fresh = computeSnapshotHash(png);
    const [dHash, , cells] = fresh.split(':');
    const strict = { cellDelta: 1, minChangedCells: 1 };
    // dHash тот же, сетка 1×1 с другой яркостью: «по ячейкам» было бы
    // changed, по dHash — нет.
    expect(hasChanged(fresh, `${dHash}:g1x1:00`, strict)).toBe(false);
    // dHash разошёлся, а первая ячейка совпадает: «по ячейкам» (одна
    // общая ячейка) было бы «не изменилось», по dHash — изменилось.
    const other = `${flipDHash(dHash)}:g1x1:${cells.slice(0, 2)}`;
    expect(hasChanged(fresh, other)).toBe(true);
  });

  it('сетка с неверной длиной не принимается за сетку', () => {
    const fresh = computeSnapshotHash(png);
    const [dHash, size, cells] = fresh.split(':');
    const strict = { cellDelta: 1, minChangedCells: 1 };
    expect(hasChanged(fresh, `${dHash}:${size}:00`, strict)).toBe(false);
    // Обрезанная сетка при разошедшемся dHash: решает dHash.
    const truncated = `${flipDHash(dHash)}:${size}:${cells.slice(0, 2)}`;
    expect(hasChanged(fresh, truncated)).toBe(true);
  });

  it('границы порогов: ячейка — строго больше cellDelta, экран — не меньше minChangedCells', () => {
    const d = '0000000000000000';
    const before = `${d}:g2x2:00000000`;
    // Ячейки разошлись на 13, 13, 12 и 0 уровней.
    const after = `${d}:g2x2:0d0d0c00`;
    const s = (minChangedCells: number) => ({ cellDelta: 12, minChangedCells });
    expect(hasChanged(before, after, s(2))).toBe(true);
    expect(hasChanged(before, after, s(3))).toBe(false);
    expect(
      hasChanged(before, after, { cellDelta: 11, minChangedCells: 3 }),
    ).toBe(true);
    // Доля — от размера сетки самого отпечатка (4 ячейки), а не 12×24.
    expect(diffScore(before, after, s(2))).toBe(2 / 4);
  });

  it('чувствительность передаётся: строже порог ячеек — однострочную надпись уже не видно', () => {
    const a = computeSnapshotHash(png);
    const b = computeSnapshotHash(
      toPng(CONTENT_CHANGES['однострочная надпись из 20 знаков']()),
    );
    expect(hasChanged(a, b)).toBe(true);
    expect(hasChanged(a, b, { cellDelta: 12, minChangedCells: 50 })).toBe(
      false,
    );
    expect(hasChanged(a, b, { cellDelta: 200, minChangedCells: 3 })).toBe(
      false,
    );
  });
});

describe('resolveChangeSensitivity', () => {
  it('без переменных — умолчания, без жалоб', () => {
    expect(resolveChangeSensitivity({})).toEqual({
      sensitivity: DEFAULT_CHANGE_SENSITIVITY,
      invalid: [],
    });
  });

  it('корректные значения переопределяют умолчания', () => {
    expect(
      resolveChangeSensitivity({
        [SENSITIVITY_ENV.cellDelta]: ' 20 ',
        [SENSITIVITY_ENV.minChangedCells]: '6',
      }),
    ).toEqual({
      sensitivity: { cellDelta: 20, minChangedCells: 6 },
      invalid: [],
    });
  });

  it.each(['0', '-3', '1.5', 'abc', '256'])(
    'неверное «%s» — умолчание и имя переменной в invalid',
    (raw) => {
      const r = resolveChangeSensitivity({
        [SENSITIVITY_ENV.cellDelta]: raw,
      });
      expect(r.sensitivity.cellDelta).toBe(
        DEFAULT_CHANGE_SENSITIVITY.cellDelta,
      );
      expect(r.invalid).toEqual([SENSITIVITY_ENV.cellDelta]);
    },
  );

  it('порог ячеек не больше числа ячеек сетки', () => {
    const r = resolveChangeSensitivity({
      [SENSITIVITY_ENV.minChangedCells]: String(CELLS + 1),
    });
    expect(r.invalid).toEqual([SENSITIVITY_ENV.minChangedCells]);
  });
});
