// Ограничения на аудио объявлены в voice-transcription.service, а тот с
// этапа 31 тянет за собой учёт расходов и через него PrismaService —
// сгенерированного клиента в песочнице нет, поэтому подменяем, как и в
// остальных спеках.
jest.mock('../../../prisma/prisma.service', () => ({
  PrismaService: class {},
}));

import { ValidationPipe, BadRequestException } from '@nestjs/common';
import { VoiceUploadUrlRequestDto } from './voice-upload-url-request.dto';
import { TranscribeRequestDto } from './transcribe-request.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (metatype: any, value: unknown) =>
  pipe.transform(value, { type: 'body', metatype, data: '' });
const ok = (m: unknown, v: unknown) => expect(run(m, v)).resolves.toBeDefined();
const bad = (m: unknown, v: unknown) =>
  expect(run(m, v)).rejects.toBeInstanceOf(BadRequestException);

describe('voice DTOs under the real ValidationPipe settings', () => {
  it('upload-url accepts every browser recording MIME, WITH codec parameters', async () => {
    for (const mime of [
      'audio/webm',
      'audio/webm;codecs=opus',
      'audio/ogg; codecs=opus',
      'audio/mp4',
      'audio/x-m4a',
      'audio/wav',
      'AUDIO/MPEG',
    ]) {
      await ok(VoiceUploadUrlRequestDto, {
        fileName: 'v',
        fileSize: 1000,
        mimeType: mime,
      });
    }
  });
  it('upload-url rejects non-audio, >15MB, and unknown fields', async () => {
    await bad(VoiceUploadUrlRequestDto, {
      fileName: 'v',
      fileSize: 1000,
      mimeType: 'video/webm',
    });
    await bad(VoiceUploadUrlRequestDto, {
      fileName: 'v',
      fileSize: 1000,
      mimeType: 'image/png',
    });
    await bad(VoiceUploadUrlRequestDto, {
      fileName: 'v',
      fileSize: 16 * 1024 * 1024,
      mimeType: 'audio/webm',
    });
    await bad(VoiceUploadUrlRequestDto, {
      fileName: 'v',
      fileSize: 1000,
      mimeType: 'audio/webm',
      pathname: 'x',
    });
  });
  it('transcribe accepts an item voice key (+ optional apply) and rejects anything else', async () => {
    await ok(TranscribeRequestDto, {
      pathname: 'projects/p1/items/i1/voice-1700000000000.webm',
    });
    await ok(TranscribeRequestDto, {
      pathname: 'projects/p1/items/i1/voice-1.m4a',
      apply: false,
    });
    await bad(TranscribeRequestDto, {
      pathname: 'projects/p1/items/i1/photo.jpg',
    });
    await bad(TranscribeRequestDto, { pathname: 'sessions/s1/original.mp4' });
    await bad(TranscribeRequestDto, {
      pathname: 'projects/p1/items/i1/voice-1.webm',
      apply: 'yes',
    });
  });
});
