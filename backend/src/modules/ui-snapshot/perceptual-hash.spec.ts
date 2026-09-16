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
  CHANGE_THRESHOLD_BITS,
  diffScore,
  hammingDistance,
  hasChanged,
  HASH_BITS,
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
