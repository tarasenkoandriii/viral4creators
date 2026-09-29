/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('@vercel/blob', () => ({ head: jest.fn() }));

import { head } from '@vercel/blob';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  GreetingVoiceService,
  greetingVoicePathname,
  settleGreetingVoice,
} from './greeting-voice.service';
import { GREETING_VOICE_MAX_BYTES } from '../../common/greeting-voice';

const mockedHead = head as jest.MockedFunction<typeof head>;
const SID = 'sess-1';
const PATH = `sessions/${SID}/voice-1700000000000.webm`;

function greetingSession(over: Record<string, unknown> = {}) {
  return {
    id: SID,
    locale: 'ru',
    greetingBriefSnapshot: {
      scriptLanguage: 'uk',
      recipientName: 'Марина',
      senderName: 'Андрей',
    },
    ...over,
  };
}

function build(
  opts: {
    session?: unknown;
    replies?: Array<{ text: string | null; reason?: string }>;
    audio?: Buffer;
    spendRefused?: boolean;
  } = {},
) {
  const sessions = {
    getSession: jest
      .fn()
      .mockResolvedValue(
        opts.session === undefined ? greetingSession() : opts.session,
      ),
  };
  const blob = {
    createUploadUrl: jest.fn().mockResolvedValue({ uploadUrl: 'https://put' }),
    downloadBuffer: jest
      .fn()
      .mockResolvedValue(opts.audio ?? Buffer.from('opus')),
    deleteBlob: jest.fn().mockResolvedValue(undefined),
  };
  const replies = [...(opts.replies ?? [{ text: 'серьёзнее' }])];
  const transcription = {
    recognize: jest
      .fn()
      .mockImplementation(async () => replies.shift() ?? { text: null }),
  };
  const plans = {
    assertCanSpendSession: opts.spendRefused
      ? jest.fn().mockRejectedValue(new Error('потолок'))
      : jest.fn().mockResolvedValue(undefined),
  };
  mockedHead.mockResolvedValue({ contentType: 'audio/webm' } as any);
  const service = new GreetingVoiceService(
    sessions as any,
    blob as any,
    transcription as any,
    plans as any,
  );
  return { service, sessions, blob, transcription, plans };
}

describe('settleGreetingVoice — ветвление итога без сети', () => {
  const hints = ['uk', 'ru'] as any;

  it('без повтора: текст — ok, пусто — not-heard', () => {
    expect(settleGreetingVoice('так', undefined, hints)).toMatchObject({
      status: 'ok',
      text: 'так',
      scriptMismatch: false,
    });
    expect(settleGreetingVoice(null, undefined, hints)).toMatchObject({
      status: 'not-heard',
      text: null,
    });
  });

  it('повтор дал кириллицу — берётся повтор', () => {
    expect(settleGreetingVoice('Marina', 'Марина', hints)).toMatchObject({
      status: 'ok',
      text: 'Марина',
      scriptMismatch: false,
    });
  });

  it('повтор снова латиницей — текст как есть и флаг: переспросить, не применять', () => {
    expect(
      settleGreetingVoice('Marina', 'Marina Andreevna', hints),
    ).toMatchObject({
      status: 'ok',
      text: 'Marina Andreevna',
      scriptMismatch: true,
    });
  });

  it('повтор вернул пусто — остаётся первый ответ, тоже с флагом', () => {
    expect(settleGreetingVoice('Marina', null, hints)).toMatchObject({
      status: 'ok',
      text: 'Marina',
      scriptMismatch: true,
    });
  });
});

describe('GreetingVoiceService', () => {
  it('ключ записи — внутри сессии и с отметкой времени', () => {
    expect(
      greetingVoicePathname(
        SID,
        'audio/webm;codecs=opus',
        new Date(1_700_000_000_000),
      ),
    ).toBe(PATH);
  });

  it('не поздравительная сессия — 404, и загрузки не выдаётся', async () => {
    const { service, blob } = build({
      session: greetingSession({ greetingBriefSnapshot: null }),
    });
    await expect(
      service.createUploadUrl(SID, {
        fileName: 'a',
        fileSize: 10,
        mimeType: 'audio/webm',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(blob.createUploadUrl).not.toHaveBeenCalled();
  });

  it('ссылка на загрузку ограничена потолком реплики', async () => {
    const { service, blob } = build();
    const r = await service.createUploadUrl(SID, {
      fileName: 'a',
      fileSize: 10,
      mimeType: 'audio/webm',
    });
    expect(r.pathname.startsWith(`sessions/${SID}/voice-`)).toBe(true);
    expect(blob.createUploadUrl).toHaveBeenCalledWith(
      r.pathname,
      'audio/webm',
      GREETING_VOICE_MAX_BYTES,
    );
  });

  it('чужой pathname — отказ до всякого платного вызова', async () => {
    const { service, transcription, plans } = build();
    await expect(
      service.transcribe(SID, { pathname: 'sessions/other/voice-1.webm' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(plans.assertCanSpendSession).not.toHaveBeenCalled();
    expect(transcription.recognize).not.toHaveBeenCalled();
  });

  it('обычная реплика: одна попытка, своя строка расхода, запись удалена', async () => {
    const { service, transcription, blob } = build({
      replies: [{ text: 'серьёзнее' }],
    });
    const r = await service.transcribe(SID, { pathname: PATH });
    expect(r).toEqual({
      status: 'ok',
      text: 'серьёзнее',
      scriptMismatch: false,
      hints: ['uk', 'ru'],
      language: null,
    });
    expect(transcription.recognize).toHaveBeenCalledTimes(1);
    const opts = transcription.recognize.mock.calls[0][2];
    expect(opts.operation).toBe('voice-assistant-stt');
    // Правила §4А.3 — и параметрами для Soniox, не только строкой для Gemini.
    expect(opts.languageHints).toEqual(['uk', 'ru']);
    expect(opts.terms).toEqual(['Марина', 'Андрей']);
    expect(opts.strictLanguage).toBe(false);
    expect(opts.sessionId).toBe(SID);
    expect(blob.deleteBlob).toHaveBeenCalledWith(PATH);
  });

  it('подсказки — из языка поздравления и языка интерфейса, имена — из брифа', async () => {
    const { service, transcription } = build({
      session: greetingSession({
        locale: 'uk',
        greetingBriefSnapshot: {
          scriptLanguage: 'de',
          recipientName: 'Oma Galja',
          senderName: null,
        },
      }),
    });
    const r = await service.transcribe(SID, { pathname: PATH });
    expect(r.hints).toEqual(['de', 'uk', 'ru']);
    const prompt: string =
      transcription.recognize.mock.calls[0][2].geminiPrompt;
    expect(prompt).toContain('«Oma Galja»');
    expect(prompt.indexOf('German')).toBeLessThan(prompt.indexOf('Ukrainian'));
  });

  it('латиница на кириллическом поздравлении — ровно один повтор, со строгой инструкцией', async () => {
    const { service, transcription } = build({
      replies: [{ text: 'Marina, seryoznee' }, { text: 'Марина, серьёзнее' }],
    });
    const r = await service.transcribe(SID, { pathname: PATH });
    expect(transcription.recognize).toHaveBeenCalledTimes(2);
    expect(transcription.recognize.mock.calls[0][2].geminiPrompt).not.toContain(
      'ВНИМАНИЕ',
    );
    expect(transcription.recognize.mock.calls[1][2].strictLanguage).toBe(true);
    expect(transcription.recognize.mock.calls[1][2].geminiPrompt).toContain(
      'ВНИМАНИЕ',
    );
    expect(r).toMatchObject({
      status: 'ok',
      text: 'Марина, серьёзнее',
      scriptMismatch: false,
    });
  });

  it('звуки вместо речи — «не расслышал», а не текст', async () => {
    const { service } = build({ replies: [{ text: '[смех] [музыка]' }] });
    const r = await service.transcribe(SID, { pathname: PATH });
    expect(r).toMatchObject({ status: 'not-heard', text: null });
  });

  it('речи не найдено — not-heard; распознавание упало — unavailable', async () => {
    const quiet = build({
      replies: [{ text: null, reason: 'no speech recognised' }],
    });
    expect(
      (await quiet.service.transcribe(SID, { pathname: PATH })).status,
    ).toBe('not-heard');
    const down = build({
      replies: [{ text: null, reason: 'GEMINI_API_KEY not set' }],
    });
    expect(
      (await down.service.transcribe(SID, { pathname: PATH })).status,
    ).toBe('unavailable');
  });

  it('потолок расхода отказал — запись всё равно удаляется (Условия, 3.4)', async () => {
    const { service, blob, transcription } = build({ spendRefused: true });
    await expect(service.transcribe(SID, { pathname: PATH })).rejects.toThrow(
      'потолок',
    );
    expect(transcription.recognize).not.toHaveBeenCalled();
    expect(blob.deleteBlob).toHaveBeenCalledWith(PATH);
  });

  it('запись длиннее реплики — отказ без вызова модели, запись удалена', async () => {
    const { service, blob, transcription } = build({
      audio: Buffer.alloc(GREETING_VOICE_MAX_BYTES + 1),
    });
    await expect(
      service.transcribe(SID, { pathname: PATH }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(transcription.recognize).not.toHaveBeenCalled();
    expect(blob.deleteBlob).toHaveBeenCalledWith(PATH);
  });

  it('язык речи от провайдера доезжает до ответа — из ПЕРВОЙ попытки', async () => {
    const { service } = build({
      replies: [
        { text: 'Marina', language: 'uk' } as any,
        { text: 'Марина', language: 'en' } as any,
      ],
    });
    const r = await service.transcribe(SID, { pathname: PATH });
    // Повтор идёт со строгими подсказками и тянет определение к ним —
    // язык берётся из свободной первой попытки.
    expect(r).toMatchObject({ status: 'ok', text: 'Марина', language: 'uk' });
  });

  it('говорят по-русски на английском поздравлении — латиница ведёт к повтору по языку РЕЧИ', async () => {
    const { service, transcription } = build({
      session: greetingSession({
        greetingBriefSnapshot: {
          scriptLanguage: 'en',
          recipientName: 'Anna',
          senderName: null,
        },
      }),
      replies: [
        { text: 'seryoznee', language: 'ru' } as any,
        { text: 'серьёзнее', language: 'ru' } as any,
      ],
    });
    const r = await service.transcribe(SID, { pathname: PATH });
    expect(transcription.recognize).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({
      text: 'серьёзнее',
      scriptMismatch: false,
      language: 'ru',
    });
  });

  it('английская фраза на украинском поздравлении — латиница законна, повтора нет', async () => {
    const { service, transcription } = build({
      replies: [{ text: 'happy birthday', language: 'en' } as any],
    });
    const r = await service.transcribe(SID, { pathname: PATH });
    expect(transcription.recognize).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({
      text: 'happy birthday',
      scriptMismatch: false,
      language: 'en',
    });
  });

  it('лимит кончился между попытками — повтора нет, первый ответ с флагом «переспросить»', async () => {
    const { service, transcription, plans } = build({
      replies: [{ text: 'Marina' }, { text: 'Марина' }],
    });
    plans.assertCanSpendSession
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('лимит'));
    const r = await service.transcribe(SID, { pathname: PATH });
    expect(transcription.recognize).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({
      status: 'ok',
      text: 'Marina',
      scriptMismatch: true,
    });
  });
});
