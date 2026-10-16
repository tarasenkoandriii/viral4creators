import { BadRequestException } from '@nestjs/common';

/** Accept only bounded PCM WAV, measuring the actual data chunk rather than caller metadata. */
export function importedWavSeconds(bytes: Buffer): number {
  const invalid = () =>
    new BadRequestException(
      'Нужен PCM WAV (16 bit, mono/stereo), 0,5–30 секунд',
    );
  if (
    bytes.length < 44 ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WAVE' ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  )
    throw invalid();
  let rate = 0;
  let dataSize = 0;
  for (let at = 12; at + 8 <= bytes.length; ) {
    const size = bytes.readUInt32LE(at + 4);
    const end = at + 8 + size;
    if (end > bytes.length) throw invalid();
    const kind = bytes.toString('ascii', at, at + 4);
    if (kind === 'fmt ') {
      if (size < 16 || bytes.readUInt16LE(at + 8) !== 1) throw invalid();
      const channels = bytes.readUInt16LE(at + 10);
      const hz = bytes.readUInt32LE(at + 12);
      if (
        ![1, 2].includes(channels) ||
        ![16000, 22050, 24000, 44100, 48000].includes(hz) ||
        bytes.readUInt16LE(at + 22) !== 16 ||
        bytes.readUInt16LE(at + 20) !== channels * 2
      )
        throw invalid();
      rate = hz * channels * 2;
      if (bytes.readUInt32LE(at + 16) !== rate) throw invalid();
    }
    if (kind === 'data') {
      if (dataSize) throw invalid();
      dataSize = size;
    }
    at = end + (size % 2);
  }
  const seconds = rate ? dataSize / rate : 0;
  if (seconds < 0.5 || seconds > 30) throw invalid();
  return seconds;
}

export function importedImageType(bytes: Buffer): 'image/jpeg' | 'image/png' {
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return 'image/png';
  if (
    bytes.length >= 4 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255 &&
    bytes.at(-2) === 255 &&
    bytes.at(-1) === 217
  )
    return 'image/jpeg';
  throw new BadRequestException('Нужен PNG или JPEG');
}
