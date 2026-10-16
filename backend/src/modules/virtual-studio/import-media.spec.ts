import { importedImageType, importedWavSeconds } from './import-media';

function wav(seconds = 1) {
  const b = Buffer.alloc(44 + 48000 * 2 * seconds);
  b.write('RIFF');
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(48000, 24);
  b.writeUInt32LE(96000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(b.length - 44, 40);
  return b;
}
describe('approved studio imports', () => {
  it('measures actual PCM data and preserves six-second approved source', () => {
    expect(importedWavSeconds(wav(6))).toBe(6);
  });
  it('rejects truncated media', () => {
    expect(() => importedWavSeconds(wav().subarray(0, 100))).toThrow();
  });
  it('rejects compressed or float WAV', () => {
    const b = wav();
    b.writeUInt16LE(3, 20);
    expect(() => importedWavSeconds(b)).toThrow();
  });
  it('rejects lying sample rate', () => {
    const b = wav();
    b.writeUInt32LE(1, 28);
    expect(() => importedWavSeconds(b)).toThrow();
  });
  it('rejects clips longer than thirty seconds', () => {
    expect(() => importedWavSeconds(wav(31))).toThrow();
  });
  it('rejects non-image bytes despite image extension', () => {
    expect(() => importedImageType(Buffer.from('not an image'))).toThrow();
  });
});
