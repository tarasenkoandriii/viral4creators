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
import { VOICE_RECORDING_UPLOAD_FAILED } from '../../common/user-facing-errors';
import {
  AUDIO_TOO_LONG_REASON,
  FALLBACK_REFUSED_REASON,
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

/** «Распознавание речи» в админке: по умолчанию ничего не выбрано → Gemini. */
const settingsMock = (stored: string | null = null) => ({
  get: jest.fn().mockResolvedValue(stored),
});
const sonioxMock = (over: Record<string, unknown> = {}) => ({
  configured: jest.fn().mockReturnValue(true),
  transcribe: jest.fn().mockResolvedValue({
    text: 'Сонікс',
    seconds: 3.2,
    language: 'uk',
    billable: true,
  }),
  ...over,
});

const mockedHead = head as jest.MockedFunction<typeof head>;
const USER = 'u1';
const AUDIO = Buffer.from('opus-bytes');

const voiceUploads = {
  remember: jest.fn().mockResolvedValue(undefined),
  forget: jest.fn().mockResolvedValue(undefined),
};

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
      settingsMock('gemini') as never,
      sonioxMock() as never,
    ).transcribe(AUDIO, 'audio/webm', { userId: 'u1' });
    expect(r).toEqual({ text: null, reason: 'GEMINI_API_KEY not set' });
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('sends inlineData with the BASE mime and a text prompt; returns cleaned text', async () => {
    mockGenerate.mockResolvedValue({ text: ' Кроссовки для бега, лёгкие. ' });
    const r = await new VoiceTranscriptionService(
      usageMock() as never,
      settingsMock('gemini') as never,
      sonioxMock() as never,
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
      settingsMock('gemini') as never,
      sonioxMock() as never,
    ).transcribe(AUDIO, 'audio/webm', { userId: 'u1' });
    expect(r).toEqual({ text: null, reason: 'no speech recognised' });
  });

  it('empty buffer short-circuits without a paid call', async () => {
    const r = await new VoiceTranscriptionService(
      usageMock() as never,
      settingsMock('gemini') as never,
      sonioxMock() as never,
    ).transcribe(Buffer.alloc(0), 'audio/webm', { userId: 'u1' });
    expect(r.reason).toBe('empty audio');
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('gemini failure → reason, never throws', async () => {
    mockGenerate.mockRejectedValue(new Error('503 overloaded'));
    const r = await new VoiceTranscriptionService(
      usageMock() as never,
      settingsMock('gemini') as never,
      sonioxMock() as never,
    ).transcribe(AUDIO, 'audio/webm', { userId: 'u1' });
    expect(r).toEqual({ text: null, reason: '503 overloaded' });
  });
});

describe('VoiceTranscriptionService.recognize — провайдер из админки', () => {
  beforeEach(() => {
    mockGenerate.mockReset();
    process.env.GEMINI_API_KEY = 'k';
  });

  const opts = {
    geminiPrompt: 'инструкция',
    languageHints: ['uk', 'ru'],
    terms: ['Марина'],
    strictLanguage: true,
    operation: 'voice-assistant-stt' as const,
    sessionId: 's1',
  };

  it('выбран Gemini — Gemini, Soniox не трогается', async () => {
    mockGenerate.mockResolvedValue({ text: 'так' });
    const soniox = sonioxMock();
    const r = await new VoiceTranscriptionService(
      usageMock() as never,
      settingsMock('gemini') as never,
      soniox as never,
    ).recognize(AUDIO, 'audio/webm', opts);
    expect(r).toEqual({ text: 'так' });
    expect(soniox.transcribe).not.toHaveBeenCalled();
    expect(mockGenerate.mock.calls[0][0].contents[1].text).toBe('инструкция');
  });

  it('ничего не выбрано — умолчание Soniox (Р-З8-14), Gemini не зовётся', async () => {
    const soniox = sonioxMock();
    const r = await new VoiceTranscriptionService(
      usageMock() as never,
      settingsMock(null) as never,
      soniox as never,
    ).recognize(AUDIO, 'audio/webm', opts);
    expect(r.text).toBe('Сонікс');
    expect(soniox.transcribe).toHaveBeenCalledTimes(1);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('ничего не выбрано и ключа Soniox нет — расшифровывает Gemini', async () => {
    mockGenerate.mockResolvedValue({ text: 'так' });
    const soniox = sonioxMock({ configured: jest.fn().mockReturnValue(false) });
    const r = await new VoiceTranscriptionService(
      usageMock() as never,
      settingsMock(null) as never,
      soniox as never,
    ).recognize(AUDIO, 'audio/webm', opts);
    expect(r).toEqual({ text: 'так' });
    expect(soniox.transcribe).not.toHaveBeenCalled();
  });

  it('выбран Soniox — ему уходят подсказки, имена и строгость; расход по секундам', async () => {
    const soniox = sonioxMock();
    const usage = usageMock();
    const r = await new VoiceTranscriptionService(
      usage as never,
      settingsMock('soniox') as never,
      soniox as never,
    ).recognize(AUDIO, 'audio/webm;codecs=opus', opts);
    // Язык речи — от Soniox, определён по звуку.
    expect(r).toEqual({ text: 'Сонікс', language: 'uk' });
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(soniox.transcribe).toHaveBeenCalledWith({
      audio: AUDIO,
      mimeType: 'audio/webm',
      languageHints: ['uk', 'ru'],
      strictLanguage: true,
      terms: ['Марина'],
    });
    expect(usage.record).toHaveBeenCalledWith({
      operation: 'voice-assistant-stt',
      model: 'soniox-stt-async',
      seconds: 3.2,
      userId: null,
      sessionId: 's1',
    });
  });

  it('выбран Soniox, но ключа нет — расшифровывает Gemini, микрофон не ломается', async () => {
    mockGenerate.mockResolvedValue({ text: 'так' });
    const soniox = sonioxMock({ configured: jest.fn().mockReturnValue(false) });
    const r = await new VoiceTranscriptionService(
      usageMock() as never,
      settingsMock('soniox') as never,
      soniox as never,
    ).recognize(AUDIO, 'audio/webm', opts);
    expect(r).toEqual({ text: 'так' });
    expect(soniox.transcribe).not.toHaveBeenCalled();
  });

  it('Soniox ничего не услышал — причина наружу, расход не пишется, если звука не было', async () => {
    const usage = usageMock();
    const soniox = sonioxMock({
      transcribe: jest
        .fn()
        .mockResolvedValue({ text: null, reason: 'empty audio', seconds: 0 }),
    });
    const r = await new VoiceTranscriptionService(
      usage as never,
      settingsMock('soniox') as never,
      soniox as never,
    ).recognize(AUDIO, 'audio/webm', opts);
    expect(r).toEqual({ text: null, reason: 'empty audio' });
    expect(usage.record).not.toHaveBeenCalled();
  });

  it('диктовка товара через Soniox — без подсказок языка: язык продавца неизвестен', async () => {
    const soniox = sonioxMock();
    await new VoiceTranscriptionService(
      usageMock() as never,
      settingsMock('soniox') as never,
      soniox as never,
    ).transcribe(AUDIO, 'audio/webm', { userId: 'u1' });
    expect(soniox.transcribe.mock.calls[0][0].languageHints).toEqual([]);
  });

  it('настройка не прочиталась — умолчание, а не исключение: ввод «никогда не бросает»', async () => {
    const settings = { get: jest.fn().mockRejectedValue(new Error('db down')) };
    const r = await new VoiceTranscriptionService(
      usageMock() as never,
      settings as never,
      sonioxMock() as never,
    ).recognize(AUDIO, 'audio/webm', opts);
    expect(r.text).toBe('Сонікс');
  });

  it('Soniox сломался — расшифровывает Gemini; оплаченная попытка Soniox всё равно в расходе', async () => {
    mockGenerate.mockResolvedValue({ text: 'так' });
    const usage = usageMock();
    const soniox = sonioxMock({
      transcribe: jest.fn().mockResolvedValue({
        text: null,
        reason: 'Soniox: распознавание не уложилось во время',
        seconds: 2,
        billable: true,
      }),
    });
    const r = await new VoiceTranscriptionService(
      usage as never,
      settingsMock('soniox') as never,
      soniox as never,
    ).recognize(AUDIO, 'audio/webm', opts);
    expect(r).toEqual({ text: 'так' });
    expect(usage.record).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'soniox-stt-async', seconds: 2 }),
    );
  });

  it('Soniox не услышал речи — Gemini НЕ зовётся: тишину он тоже не расслышит, а платить второй раз незачем', async () => {
    const soniox = sonioxMock({
      transcribe: jest.fn().mockResolvedValue({
        text: null,
        reason: 'no speech recognised',
        seconds: 4,
        billable: true,
      }),
    });
    const usage = usageMock();
    const r = await new VoiceTranscriptionService(
      usage as never,
      settingsMock('soniox') as never,
      soniox as never,
    ).recognize(AUDIO, 'audio/webm', opts);
    expect(r).toEqual({ text: null, reason: 'no speech recognised' });
    expect(mockGenerate).not.toHaveBeenCalled();
    // Тишина у Soniox оплачена — расход пишется.
    expect(usage.record).toHaveBeenCalledTimes(1);
  });

  it('неизвестное значение настройки — умолчание Soniox', async () => {
    const soniox = sonioxMock();
    await new VoiceTranscriptionService(
      usageMock() as never,
      settingsMock('whisper') as never,
      soniox as never,
    ).recognize(AUDIO, 'audio/webm', opts);
    expect(soniox.transcribe).toHaveBeenCalledTimes(1);
    expect(mockGenerate).not.toHaveBeenCalled();
  });
  // Финальный аудит ветки K: потолок длины и вход перед запасным путём.
  const svc = (soniox: ReturnType<typeof sonioxMock>) =>
    new VoiceTranscriptionService(
      usageMock() as never,
      settingsMock('soniox') as never,
      soniox as never,
    );

  it('Soniox сообщил длительность больше потолка — «слишком длинно» без текста; ровно на потолке — текст', async () => {
    const long = sonioxMock({
      transcribe: jest.fn().mockResolvedValue({
        text: 'длинная речь',
        seconds: 61,
        audioMs: 60_001,
        billable: true,
      }),
    });
    const r = await svc(long).recognize(AUDIO, 'audio/webm', {
      ...opts,
      maxDurationMs: 60_000,
    });
    expect(r).toEqual({
      text: null,
      reason: AUDIO_TOO_LONG_REASON,
      durationMs: 60_001,
    });
    expect(mockGenerate).not.toHaveBeenCalled();

    const edge = sonioxMock({
      transcribe: jest.fn().mockResolvedValue({
        text: 'ровно минута',
        seconds: 60,
        audioMs: 60_000,
        billable: true,
      }),
    });
    const ok = await svc(edge).recognize(AUDIO, 'audio/webm', {
      ...opts,
      maxDurationMs: 60_000,
    });
    expect(ok).toMatchObject({ text: 'ровно минута', durationMs: 60_000 });
  });

  it('Soniox упал, а вход закрыт — Gemini не зовётся; вход открыт — зовётся', async () => {
    const failing = () =>
      sonioxMock({
        transcribe: jest.fn().mockResolvedValue({
          text: null,
          reason: 'Soniox: 500',
          seconds: 0,
          billable: true,
        }),
      });
    const refused = jest.fn().mockResolvedValue(false);
    const r = await svc(failing()).recognize(AUDIO, 'audio/webm', {
      ...opts,
      canFallback: refused,
    });
    expect(r).toEqual({ text: null, reason: FALLBACK_REFUSED_REASON });
    expect(refused).toHaveBeenCalledTimes(1);
    expect(mockGenerate).not.toHaveBeenCalled();

    mockGenerate.mockResolvedValue({ text: 'так' });
    const allowed = jest.fn().mockResolvedValue(true);
    const r2 = await svc(failing()).recognize(AUDIO, 'audio/webm', {
      ...opts,
      canFallback: allowed,
    });
    expect(r2).toEqual({ text: 'так' });
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  it('вход не спрашивается, когда Soniox ответил или не услышал речи', async () => {
    const canFallback = jest.fn().mockResolvedValue(false);
    await svc(sonioxMock()).recognize(AUDIO, 'audio/webm', {
      ...opts,
      canFallback,
    });
    expect(canFallback).not.toHaveBeenCalled();
  });
});

describe('VoiceService — запись не остаётся у Сервиса (сквозной аудит голоса)', () => {
  function build2(over: { spend?: jest.Mock; transcribe?: jest.Mock } = {}) {
    const prisma = {
      productItem: {
        findFirst: jest.fn().mockResolvedValue({ id: 'i1' }),
        update: jest.fn(),
      },
      project: { update: jest.fn() },
    };
    const blob = {
      createUploadUrl: jest.fn(),
      downloadBuffer: jest.fn().mockResolvedValue(AUDIO),
      deleteBlob: jest.fn().mockResolvedValue(true),
    };
    const access = accessMock();
    if (over.spend) access.assertCanSpendUser = over.spend;
    const transcription = {
      transcribe:
        over.transcribe ?? jest.fn().mockResolvedValue({ text: 'Описание' }),
    };
    const svc = new VoiceService(
      prisma as any,
      blob as any,
      transcription as any,
      access as any,
      voiceUploads as any,
    );
    return { svc, prisma, blob, access };
  }
  const PATH = 'projects/p1/items/i1/voice-1.webm';
  beforeEach(() => {
    mockedHead.mockResolvedValue({ contentType: 'audio/webm' } as any);
  });

  it('отказ по дневному лимиту — уже загруженная запись удаляется', async () => {
    const { svc, blob } = build2({
      spend: jest.fn().mockRejectedValue(new Error('лимит')),
    });
    await expect(
      svc.transcribe(USER, 'p1', 'i1', { pathname: PATH }),
    ).rejects.toThrow('лимит');
    expect(blob.deleteBlob).toHaveBeenCalledWith(PATH);
  });

  it('исключение при расшифровке — запись всё равно удаляется', async () => {
    const { svc, blob } = build2({
      transcribe: jest.fn().mockRejectedValue(new Error('db down')),
    });
    await expect(
      svc.transcribe(USER, 'p1', 'i1', { pathname: PATH }),
    ).rejects.toThrow('db down');
    expect(blob.deleteBlob).toHaveBeenCalledWith(PATH);
  });

  it('строка учёта снимается только после настоящего удаления записи', async () => {
    voiceUploads.forget.mockClear();
    const ok = build2();
    await ok.svc.transcribe(USER, 'p1', 'i1', { pathname: PATH });
    expect(voiceUploads.forget).toHaveBeenCalledWith(PATH);

    voiceUploads.forget.mockClear();
    const failed = build2();
    failed.blob.deleteBlob.mockResolvedValue(false);
    await failed.svc.transcribe(USER, 'p1', 'i1', { pathname: PATH });
    // Не удалилось — строка остаётся, крон voice-uploads-sweep повторит.
    expect(voiceUploads.forget).not.toHaveBeenCalled();
  });

  it('проверка лимита знает проект — по нему выбирается сценарий тестового доступа', async () => {
    const { svc, access } = build2();
    await svc.transcribe(USER, 'p1', 'i1', { pathname: PATH });
    expect(access.assertCanSpendUser).toHaveBeenCalledWith(USER, {
      projectId: 'p1',
    });
  });

  it('надиктованное длиннее потолка поля — в базу уходит не больше 2000 символов', async () => {
    const { svc, prisma } = build2({
      transcribe: jest.fn().mockResolvedValue({ text: 'а'.repeat(2500) }),
    });
    await svc.transcribe(USER, 'p1', 'i1', { pathname: PATH, apply: true });
    expect(
      prisma.productItem.update.mock.calls[0][0].data.description,
    ).toHaveLength(2000);
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
      deleteBlob: jest.fn().mockResolvedValue(true),
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
      voiceUploads as any,
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
    const err = await svc
      .transcribe(USER, 'p1', 'i1', dto)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    // Путь и текст хранилища — в лог, человеку — одно действие.
    expect((err as Error).message).toBe(VOICE_RECORDING_UPLOAD_FAILED);
    expect((err as Error).message).not.toContain('does not exist');
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
