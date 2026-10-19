import { BadRequestException } from '@nestjs/common';
import { inflateSync } from 'node:zlib';
export const QA_ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;
export const QA_ARTIFACT_TTL_MS = 30 * 86400000;
export const QA_ARTIFACT_PENDING_MS = 15 * 60000;
const invalid = (): never => {
  throw new BadRequestException({
    code: 'QA_ARTIFACT_INVALID',
    message:
      'Нужен обезличенный 8-bit PNG RGB/RGBA или серый до 2 МБ, без анимации, с подтверждением проверки данных.',
  });
};
function crc(bytes: Buffer) {
  let n = 0xffffffff;
  for (const byte of bytes) {
    n ^= byte;
    for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
  }
  return (n ^ 0xffffffff) >>> 0;
}
/** Parse, validate and strip ancillary metadata; never trust filename or declared MIME. */
export function cleanEvidencePng(bytes: Buffer): Buffer {
  const signature = Buffer.from('89504e470d0a1a0a', 'hex');
  if (
    bytes.length > QA_ARTIFACT_MAX_BYTES ||
    !bytes.subarray(0, 8).equals(signature)
  )
    return invalid();
  const chunks: Buffer[] = [signature],
    data: Buffer[] = [];
  let pos = 8,
    width = 0,
    height = 0,
    channels = 0,
    ended = false,
    count = 0;
  while (pos < bytes.length) {
    if (++count > 10000 || pos + 12 > bytes.length) return invalid();
    const len = bytes.readUInt32BE(pos),
      end = pos + len + 12;
    if (end > bytes.length) return invalid();
    const type = bytes.toString('ascii', pos + 4, pos + 8),
      body = bytes.subarray(pos + 8, end - 4);
    if (
      !/^[A-Za-z]{4}$/.test(type) ||
      crc(bytes.subarray(pos + 4, end - 4)) !== bytes.readUInt32BE(end - 4)
    )
      return invalid();
    if (count === 1 && type !== 'IHDR') return invalid();
    if (type === 'IHDR') {
      if (count !== 1 || len !== 13) return invalid();
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[
        body[9]
      ];
      if (
        !width ||
        !height ||
        width > 4096 ||
        height > 4096 ||
        width * height > 8000000 ||
        body[8] !== 8 ||
        !channels ||
        body[10] ||
        body[11] ||
        body[12]
      )
        return invalid();
      chunks.push(bytes.subarray(pos, end));
    } else if (type === 'IDAT') {
      data.push(body);
      chunks.push(bytes.subarray(pos, end));
    } else if (type === 'IEND') {
      if (len || !data.length || end !== bytes.length) return invalid();
      chunks.push(bytes.subarray(pos, end));
      ended = true;
    } else if (type === 'acTL' || type[0] === type[0].toUpperCase())
      return invalid();
    pos = end;
  }
  if (!ended) return invalid();
  try {
    const stride = width * channels + 1,
      size = stride * height;
    const raw = inflateSync(Buffer.concat(data), { maxOutputLength: size });
    if (raw.length !== size) return invalid();
    for (let y = 0; y < height; y++) if (raw[y * stride] > 4) return invalid();
  } catch {
    return invalid();
  }
  return Buffer.concat(chunks);
}
export function parseArtifactUpload(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return invalid();
  const b = input as Record<string, unknown>;
  if (
    Object.keys(b).some(
      (k) =>
        !['requestId', 'contentType', 'contentBase64', 'redacted'].includes(k),
    ) ||
    b.redacted !== true ||
    b.contentType !== 'image/png' ||
    typeof b.requestId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      b.requestId,
    ) ||
    typeof b.contentBase64 !== 'string' ||
    b.contentBase64.length > Math.ceil(QA_ARTIFACT_MAX_BYTES / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      b.contentBase64,
    )
  )
    return invalid();
  const raw = Buffer.from(b.contentBase64, 'base64');
  if (raw.toString('base64') !== b.contentBase64) return invalid();
  return { requestId: b.requestId.toLowerCase(), bytes: cleanEvidencePng(raw) };
}
