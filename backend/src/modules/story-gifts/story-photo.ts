import { BadRequestException } from '@nestjs/common';
import { PNG } from 'pngjs';
/** Normalize to a new PNG, discarding text/EXIF/ancillary metadata. */
export function normalizeStoryPhoto(base64: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64))
    throw new BadRequestException('Нужна фотография PNG');
  const bytes = Buffer.from(base64, 'base64');
  if (
    bytes.length > 1024 * 1024 ||
    bytes.length < 24 ||
    bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
    bytes.subarray(12, 16).toString() !== 'IHDR'
  )
    throw new BadRequestException('PNG до 1 МБ');
  const w = bytes.readUInt32BE(16),
    h = bytes.readUInt32BE(20);
  if (!w || !h || w > 1024 || h > 1024)
    throw new BadRequestException('Изображение до 1024×1024');
  try {
    const png = PNG.sync.read(bytes, { checkCRC: true });
    const clean = PNG.sync.write(png);
    if (clean.length > 1024 * 1024) throw new Error('size');
    return clean;
  } catch {
    throw new BadRequestException('Не удалось прочитать фотографию');
  }
}
