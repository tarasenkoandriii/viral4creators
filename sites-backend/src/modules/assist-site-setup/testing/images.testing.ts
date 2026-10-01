/**
 * Синтетические картинки для тестов W4: настоящие сигнатуры и заголовки
 * с размерами (тело не нужно — сервер читает только заголовок).
 */

export function pngBytes(w: number, h: number, tail = ''): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b[24] = 8;
  b[25] = 6;
  return Buffer.concat([b, Buffer.from(tail, 'latin1')]);
}

export function jpegBytes(w: number, h: number): Buffer {
  return Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x10,
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00,
    0x01,
    0x01,
    0x00,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    h >> 8,
    h & 255,
    w >> 8,
    w & 255,
    0x03,
    0x01,
    0x22,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01,
    0xff,
    0xd9,
  ]);
}

export function webpBytes(w: number, h: number): Buffer {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(22, 4);
  b.write('WEBP', 8, 'latin1');
  b.write('VP8X', 12, 'latin1');
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(w - 1, 24, 3);
  b.writeUIntLE(h - 1, 27, 3);
  return b;
}

/** SVG с исполняемым кодом — приёмка 5а. */
export const SVG_SCRIPT =
  '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>';
