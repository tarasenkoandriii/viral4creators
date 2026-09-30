/**
 * `POST /voices/upload-url` под НАСТОЯЩИМИ настройками глобальной
 * валидации (`VALIDATION_PIPE_OPTIONS`, те же, что в main.ts).
 *
 * Прод-дефект 30.09.2026: Telegram Android записывал
 * `audio/webm;codecs=opus`, `@IsIn` сверял строку целиком, и человек
 * видел английское «mimeType must be one of the following values: …».
 */
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { VALIDATION_PIPE_OPTIONS } from '../../../common/validation-pipe';
import {
  normalizeVoiceSampleMime,
  sampleExtFor,
  VOICE_SAMPLE_FORMAT_UNSUPPORTED,
  VoiceSampleUploadUrlRequestDto,
} from './user-voices.dto';

const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
const run = (value: unknown) =>
  pipe.transform(value, {
    type: 'body',
    metatype: VoiceSampleUploadUrlRequestDto,
    data: '',
  }) as Promise<VoiceSampleUploadUrlRequestDto>;

async function messagesOf(value: unknown): Promise<string[]> {
  try {
    await run(value);
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    const body = (e as BadRequestException).getResponse() as {
      message: string[];
    };
    return body.message;
  }
  throw new Error('ожидался отказ валидации');
}

describe('VoiceSampleUploadUrlRequestDto', () => {
  it('тип записи с параметром кодека принимается и приходит в сервис голым', async () => {
    const cases: Array<[string, string]> = [
      ['audio/webm;codecs=opus', 'audio/webm'],
      ['audio/webm; codecs="opus"', 'audio/webm'],
      ['AUDIO/MP4;codecs=mp4a.40.2', 'audio/mp4'],
      ['audio/wav', 'audio/wav'],
      ['audio/x-m4a', 'audio/mp4'],
      ['audio/mp3', 'audio/mpeg'],
      ['audio/wave', 'audio/wav'],
    ];
    for (const [raw, expected] of cases) {
      const dto = await run({ fileName: 's', fileSize: 1000, mimeType: raw });
      expect(dto.mimeType).toBe(expected);
    }
  });

  it('неподдерживаемый тип — отказ по-русски, без английского class-validator', async () => {
    for (const mimeType of [
      'audio/ogg;codecs=opus',
      'video/webm',
      'audio/aac',
      '',
    ]) {
      const msgs = await messagesOf({
        fileName: 's',
        fileSize: 1000,
        mimeType,
      });
      expect(msgs).toContain(VOICE_SAMPLE_FORMAT_UNSUPPORTED);
      expect(msgs.join(' ')).not.toMatch(/must be|mimeType/);
    }
    const nonString = await messagesOf({
      fileName: 's',
      fileSize: 1000,
      mimeType: 42,
    });
    expect(nonString).toContain(VOICE_SAMPLE_FORMAT_UNSUPPORTED);
  });

  it('больше 15 МБ — отказ по-русски', async () => {
    const msgs = await messagesOf({
      fileName: 's',
      fileSize: 15 * 1024 * 1024 + 1,
      mimeType: 'audio/wav',
    });
    expect(msgs.join(' ')).toMatch(/15 МБ/);
    expect(msgs.join(' ')).not.toMatch(/must not be/);
  });

  it('лишние поля по-прежнему запрещены', async () => {
    await expect(
      run({ fileName: 's', fileSize: 1, mimeType: 'audio/wav', pathname: 'x' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('normalizeVoiceSampleMime / sampleExtFor', () => {
  it('нормализует и сопоставляет расширение', () => {
    expect(normalizeVoiceSampleMime(' Audio/WebM ; codecs=opus')).toBe(
      'audio/webm',
    );
    expect(normalizeVoiceSampleMime(undefined)).toBeUndefined();
    expect(sampleExtFor('audio/webm;codecs=opus')).toBe('webm');
    expect(sampleExtFor('audio/wav')).toBe('wav');
    expect(sampleExtFor('audio/x-m4a')).toBe('m4a');
    expect(sampleExtFor('audio/mpeg')).toBe('mp3');
    expect(sampleExtFor('audio/ogg')).toBe('bin');
  });
});
