/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('@vercel/blob', () => ({ head: jest.fn() }));
jest.mock('@google/genai', () => ({
  GoogleGenAI: jest
    .fn()
    .mockImplementation(() => ({ models: { generateContent: mockGenerate } })),
}));
const mockGenerate = jest.fn();

import { head } from '@vercel/blob';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { VoiceService, audioExtension, voicePathname } from './voice.service';
import {
  VoiceTranscriptionService,
  baseMime,
  cleanTranscript,
} from './voice-transcription.service';

/** Учёт расходов (ТЗ §26) — в тестах он ничего не должен делать. */
/** Блокировка (ТЗ §25.3) — по умолчанию пользователь не заблокирован. */
const accessMock = () => ({
  // §26.4: дневной лимит по умолчанию не выбран.
  assertCanSpendUser: jest.fn(),
  assertCanSpendSession: jest.fn(),
  accessOf: jest.fn().mockResolvedValue({
    plan: 'PREMIUM',
    isBlocked: false,
    blockedReason: null,
  }),
  assertNotBlocked: jest.fn(),
  assertUserNotBlocked: jest.fn(),
  assertSessionNotBlocked: jest.fn(),
  assertUser: jest.fn(),
  assertSession: jest.fn(),
  planOfUser: jest.fn().mockResolvedValue('PREMIUM'),
  planOfSession: jest.fn().mockResolvedValue('PREMIUM'),
});

const usageMock = () => ({
  record: jest.fn(),
  recordGemini: jest.fn(),
  recordOpenAi: jest.fn(),
});

const mockedHead = head as jest.MockedFunction<typeof head>;
const USER = 'u1';
const AUDIO = Buffer.from('opus-bytes');

describe('helpers', () => {
  it('baseMime strips codec parameters', () => {
    expect(baseMime('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(baseMime('Audio/MP4')).toBe('audio/mp4');
  });
  it('audioExtension maps browser MIME types (incl. parameterised) and falls back', () => {
    expect(audioExtension('audio/webm;codecs=opus')).toBe('webm');
    expect(audioExtension('audio/mp4')).toBe('m4a');
    expect(audioExtension('audio/ogg; codecs=opus')).toBe('ogg');
    expect(audioExtension('audio/x-unknown')).toBe('bin');
  });
  it('voicePathname is per-item and timestamped (a new take never overwrites the previous)', () => {
    const t = new Date(1_700_000_000_000);
    expect(voicePathname('p1', 'i1', 'audio/webm;codecs=opus', t)).toBe(
      'projects/p1/items/i1/voice-1700000000000.webm',
    );
  });
  it('cleanTranscript trims, unwraps quotes/fences, and returns null for nothing', () => {
    expect(cleanTranscript('  Красные кроссовки, 42 размер.  ')).toBe(
      'Красные кроссовки, 42 размер.',
    );
    expect(cleanTranscript('«Тёплая куртка»')).toBe('Тёплая куртка');
    expect(cleanTranscript('```\ntext\n```')).toBe('text');
    expect(cleanTranscript('')).toBeNull();
    expect(cleanTranscript(undefined)).toBeNull();
    expect(cleanTranscript('""')).toBeNull();
  });
});

describe('VoiceTranscriptionService', () => {
  beforeEach(() => {
    mockGenerate.mockReset();
    process.env.GEMINI_API_KEY = 'k';
  });

  it('no key → reason, no call', async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_GEMINI_API_KEY;
    const r = await new VoiceTranscriptionService(
      usageMock() as never,
    ).transcribe(AUDIO, 'audio/webm', { userId: 'u1' });
    expect(r).toEqual({ text: null, reason: 'GEMINI_API_KEY not set' });
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('sends inlineData with the BASE mime and a text prompt; returns cleaned text', async () => {
    mockGenerate.mockResolvedValue({ text: ' Кроссовки для бега, лёгкие. ' });
    const r = await new VoiceTranscriptionService(
      usageMock() as never,
    ).transcribe(AUDIO, 'audio/webm;codecs=opus');
    const arg = mockGenerate.mock.calls[0][0];
    expect(arg.contents[0]).toEqual({
      inlineData: { mimeType: 'audio/webm', data: AUDIO.toString('base64') },
    });
    expect(arg.contents[1].text).toMatch(/Расшифруй/);
    expect(r).toEqual({ text: 'Кроссовки для бега, лёгкие.' });
  });

  it('empty model reply → "no speech recognised"', async () => {
    mockGenerate.mockResolvedValue({ text: '' });
    const r = await new VoiceTranscriptionService(
      usageMock() as never,
    ).transcribe(AUDIO, 'audio/webm', { userId: 'u1' });
    expect(r).toEqual({ text: null, reason: 'no speech recognised' });
  });

  it('empty buffer short-circuits without a paid call', async () => {
    const r = await new VoiceTranscriptionService(
      usageMock() as never,
    ).transcribe(Buffer.alloc(0), 'audio/webm', { userId: 'u1' });
    expect(r.reason).toBe('empty audio');
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('gemini failure → reason, never throws', async () => {
    mockGenerate.mockRejectedValue(new Error('503 overloaded'));
    const r = await new VoiceTranscriptionService(
      usageMock() as never,
    ).transcribe(AUDIO, 'audio/webm', { userId: 'u1' });
    expect(r).toEqual({ text: null, reason: '503 overloaded' });
  });
});

describe('VoiceService', () => {
  function build(transcribeResult: unknown = { text: 'Описание' }) {
    const prisma = {
      productItem: {
        findFirst: jest.fn().mockResolvedValue({ id: 'i1' }),
        update: jest.fn(),
      },
      project: { update: jest.fn() },
    };
    const blob = {
      createUploadUrl: jest
        .fn()
        .mockResolvedValue({ uploadUrl: 'https://put' }),
      downloadBuffer: jest.fn().mockResolvedValue(AUDIO),
      deleteBlob: jest.fn().mockResolvedValue(undefined),
    };
    const transcription = {
      transcribe: jest.fn().mockResolvedValue(transcribeResult),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new VoiceService(
      prisma as any,
      blob as any,
      transcription as any,
      accessMock() as any,
    );
    return { svc, prisma, blob, transcription };
  }
  const dto = { pathname: 'projects/p1/items/i1/voice-1700000000000.webm' };

  beforeEach(() => {
    mockedHead.mockReset();
    mockedHead.mockResolvedValue({
      url: 'https://blob/v.webm',
      contentType: 'audio/webm',
    } as never);
  });

  it('upload-url: 404 for a foreign item; presigned PUT under the item key with the parameterised MIME', async () => {
    const { svc, prisma, blob } = build();
    prisma.productItem.findFirst.mockResolvedValueOnce(null);
    await expect(
      svc.createUploadUrl(USER, 'p1', 'i1', {
        fileName: 'v.webm',
        fileSize: 10,
        mimeType: 'audio/webm;codecs=opus',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    const r = await svc.createUploadUrl(USER, 'p1', 'i1', {
      fileName: 'v.webm',
      fileSize: 10,
      mimeType: 'audio/webm;codecs=opus',
    });
    expect(r.pathname).toMatch(/^projects\/p1\/items\/i1\/voice-\d+\.webm$/);
    expect(blob.createUploadUrl).toHaveBeenCalledWith(
      r.pathname,
      'audio/webm;codecs=opus',
      15 * 1024 * 1024,
    );
  });

  it('transcribe: refuses another item’s pathname', async () => {
    const { svc } = build();
    await expect(
      svc.transcribe(USER, 'p1', 'i1', {
        pathname: 'projects/p1/items/OTHER/voice-1.webm',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('transcribe: 400 when nothing was uploaded', async () => {
    const { svc } = build();
    mockedHead.mockRejectedValue(new Error('does not exist'));
    await expect(svc.transcribe(USER, 'p1', 'i1', dto)).rejects.toThrow(
      /upload it first/,
    );
  });

  it('transcribe (default apply): writes description, bumps project, deletes the transit blob', async () => {
    const { svc, prisma, blob, transcription } = build();
    const r = await svc.transcribe(USER, 'p1', 'i1', dto);
    // Владелец расхода уходит вместе с аудио (ТЗ §26).
    expect(transcription.transcribe).toHaveBeenCalledWith(AUDIO, 'audio/webm', {
      userId: USER,
    });
    expect(prisma.productItem.update).toHaveBeenCalledWith({
      where: { id: 'i1' },
      data: { description: 'Описание' },
    });
    expect(prisma.project.update).toHaveBeenCalled();
    expect(blob.deleteBlob).toHaveBeenCalledWith(dto.pathname);
    expect(r).toEqual({ text: 'Описание', applied: true });
  });

  it('transcribe (apply: false): returns text only, item untouched', async () => {
    const { svc, prisma } = build();
    const r = await svc.transcribe(USER, 'p1', 'i1', { ...dto, apply: false });
    expect(prisma.productItem.update).not.toHaveBeenCalled();
    expect(r).toEqual({ text: 'Описание', applied: false });
  });

  it('transcribe: failure never wipes the existing description and surfaces the reason', async () => {
    const { svc, prisma, blob } = build({
      text: null,
      reason: 'no speech recognised',
    });
    const r = await svc.transcribe(USER, 'p1', 'i1', dto);
    expect(prisma.productItem.update).not.toHaveBeenCalled();
    expect(blob.deleteBlob).toHaveBeenCalled(); // transit copy still cleaned up
    expect(r).toEqual({
      text: null,
      applied: false,
      reason: 'no speech recognised',
    });
  });
});
