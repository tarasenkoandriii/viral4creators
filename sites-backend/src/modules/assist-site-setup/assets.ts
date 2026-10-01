/**
 * Картинки бренда (§3-бис.1; решение координатора Э2 №13) — ЧИСТЫЙ модуль.
 *
 * Тип — ТОЛЬКО по сигнатуре байтов: PNG, JPEG, WebP. Заголовок клиента
 * (`mime`) не решает ничего: SVG с `<script>`/`onload`, HTML, GIF, «PNG» с
 * телом SVG — отказ `ASSET_TYPE` (приёмка Э2 п.5а). SVG в Э2 не
 * растеризуется (в sites-backend нет растеризатора — вопрос О-5).
 * Размеры — из заголовка самой картинки; картинка без читаемых размеров —
 * не картинка.
 */

export const ASSET_MAX_BYTES = 200 * 1024;
export const ASSET_MAX_SIDE = 8192;
export const AVATAR_MIN_SIDE = 128;
export const ASSET_KINDS = ['logo', 'avatar'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];
export const ASSET_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type AssetMime = (typeof ASSET_MIMES)[number];

export interface SniffedImage {
  mime: AssetMime;
  width: number;
  height: number;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function png(b: Buffer): SniffedImage | null {
  if (b.length < 24 || !b.subarray(0, 8).equals(PNG_SIG)) return null;
  if (b.toString('latin1', 12, 16) !== 'IHDR') return null;
  return {
    mime: 'image/png',
    width: b.readUInt32BE(16),
    height: b.readUInt32BE(20),
  };
}

function jpeg(b: Buffer): SniffedImage | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) {
    return null;
  }
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) {
      i += 1; // заполнитель
      continue;
    }
    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      i += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return null; // данные до SOF
    const len = b.readUInt16BE(i + 2);
    if (len < 2) return null;
    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isSof) {
      if (i + 9 > b.length) return null;
      return {
        mime: 'image/jpeg',
        height: b.readUInt16BE(i + 5),
        width: b.readUInt16BE(i + 7),
      };
    }
    i += 2 + len;
  }
  return null;
}

function webp(b: Buffer): SniffedImage | null {
  if (
    b.length < 30 ||
    b.toString('latin1', 0, 4) !== 'RIFF' ||
    b.toString('latin1', 8, 12) !== 'WEBP'
  ) {
    return null;
  }
  const chunk = b.toString('latin1', 12, 16);
  if (chunk === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return {
      mime: 'image/webp',
      width: b.readUInt16LE(26) & 0x3fff,
      height: b.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    return {
      mime: 'image/webp',
      width: 1 + (((b[22] & 0x3f) << 8) | b[21]),
      height:
        1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)),
    };
  }
  if (chunk === 'VP8X') {
    return {
      mime: 'image/webp',
      width: 1 + b.readUIntLE(24, 3),
      height: 1 + b.readUIntLE(27, 3),
    };
  }
  return null;
}

/** PNG/JPEG/WebP с разумными размерами — или null (всё прочее). */
export function sniffImage(b: Buffer): SniffedImage | null {
  const img = png(b) ?? jpeg(b) ?? webp(b);
  if (!img) return null;
  if (
    img.width < 1 ||
    img.height < 1 ||
    img.width > ASSET_MAX_SIDE ||
    img.height > ASSET_MAX_SIDE
  ) {
    return null;
  }
  return img;
}

const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Строгий base64 (без data:-префикса и пробелов) или null. */
export function decodeBase64Strict(
  s: unknown,
  maxBytes: number,
): Buffer | 'too_large' | null {
  if (typeof s !== 'string' || s.length === 0) return null;
  // Длину проверяем ДО декодирования: 3 байта на 4 символа.
  if (Math.floor((s.length * 3) / 4) - 2 > maxBytes) return 'too_large';
  if (!BASE64.test(s)) return null;
  const buf = Buffer.from(s, 'base64');
  return buf.length > maxBytes ? 'too_large' : buf;
}
