/**
 * ActorsService — пилот говорящего AI-аватара (doc/AVATAR-LIPSYNC-PIPELINE-SPEC.md
 * §7). Ключевые проверки, по образцу generation.service.spec.ts:
 *  - сбой синтеза Resemble не запускает Hedra (нет смысла тратить деньги
 *    на видео без аудио, §7 документа);
 *  - сбой Hedra ПОСЛЕ успешного синтеза не отменяет уже учтённый расход
 *    на синтез — тот же принцип «деньги потрачены в момент старта», что
 *    у Veo;
 *  - повторный запуск при идущей операции возвращает её же, не 409;
 *  - замок (`claimWork('avatar-generate')`) снимается в finally — успех
 *    и провал оба освобождают его;
 *  - субтитры (этап 72а) — явный чекбокс: выключен по умолчанию, не
 *    собираются и не прожигаются; включён — `.srt` собирается на шаге
 *    синтеза, прожигается вторым проходом ffmpeg ПОСЛЕ Hedra, а провал
 *    любого из этих шагов — деградация («ролик без субтитров»), не отказ
 *    всего рендера.
 */

// Песочница разработки не генерирует Prisma-клиент (doc/CI.md) —
// SessionService импортирует PrismaService транзитивно, а тест реально
// использует только мок SessionService ниже. Тот же приём, что в
// generation.service.spec.ts.
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

// Этап 73 (звуковой чек): ActorsService теперь тоже строит клиент Gemini
// в конструкторе (`createGeminiClient()`), тем же приёмом, что
// video-audit.service.spec.ts — явный ключ на время файла, мок всего
// модуля `@google/genai`, чтобы `generateContent` не пытался стучаться
// в сеть.
const keyBefore = process.env.GEMINI_API_KEY;
beforeAll(() => {
  process.env.GEMINI_API_KEY = 'test-key';
});
afterAll(() => {
  if (keyBefore === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = keyBefore;
});
const generateContent = jest.fn();
jest.mock('@google/genai', () => ({
  GoogleGenAI: jest
    .fn()
    .mockImplementation(() => ({ models: { generateContent } })),
}));
beforeEach(() => generateContent.mockReset());

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  ActorsService,
  avatarRenderExpired,
  avatarSubtitleExpired,
  AVATAR_SUBTITLE_DEADLINE_MS,
} from './actors.service';
import { GenerationStatus } from '../../common/types/generation.types';

const CHARACTER = {
  sourceCharacterId: 'char-1',
  label: 'Аня',
  photoUrl: 'https://blob.test/brand/anya.png',
  description: 'молодая девушка, естественная мимика',
};

const readySession = (overrides: Record<string, unknown> = {}) => ({
  sessionId: 's1',
  generationPrompt: { finalVoiceoverScript: 'Привет! Это отличный товар.' },
  brandManifestSnapshot: { characters: [CHARACTER] },
  ...overrides,
});

function build(session: unknown = readySession()) {
  // `getSession`/`updateSession` — единый изменяемый мок, а не два
  // независимых `mockResolvedValue`: `writeIfStillCurrent`
  // (этап 72а, аудит 2026-09-09, Д-1/Д-2) сам перечитывает сессию из
  // БД непосредственно перед записью, чтобы поймать гонку конкурентных
  // опросов — со статичным моком, всегда отдающим один и тот же
  // исходный объект, эта проверка ложно решала бы, что запись устарела,
  // хотя на самом деле никакой параллельной записи не было. Здесь
  // `updateSession` реально обновляет то, что вернёт следующий
  // `getSession` — та же семантика top-level-key-replace, что у
  // настоящего `SessionService.updateSession`.
  let stored: Record<string, unknown> = { ...(session as object) };
  const sessions = {
    getSession: jest.fn().mockImplementation(() => Promise.resolve(stored)),
    updateSession: jest
      .fn()
      .mockImplementation((_id: string, patch: Record<string, unknown>) => {
        stored = { ...stored, ...patch };
        return Promise.resolve(undefined);
      }),
    claimWork: jest.fn().mockResolvedValue(true),
    releaseWork: jest.fn().mockResolvedValue(undefined),
  };
  const blob = {
    // По умолчанию отражает имя пути в ссылку — тесты на несколько
    // блобов за один прогон (озвучка + `.srt` + сырое видео + прожжённое
    // видео) различают их по URL, не гадают по порядку вызовов.
    uploadBuffer: jest
      .fn()
      .mockImplementation((pathname: string) =>
        Promise.resolve({ url: `https://blob.test/${pathname}` }),
      ),
  };
  const aiUsage = {
    record: jest.fn().mockResolvedValue(undefined),
    recordGemini: jest.fn().mockResolvedValue(undefined),
  };
  const resemble = {
    providerKey: 'resemble',
    configured: jest.fn().mockReturnValue(true),
    synthesize: jest.fn().mockResolvedValue({
      ok: true,
      audio: Buffer.from('аудио'),
      mimeType: 'audio/mpeg',
      characters: 30,
      voiceId: 'v1',
      model: 'resemble',
      alignment: { characters: ['a'], starts: [0], ends: [2] },
    }),
  };
  const hedra = {
    configured: jest.fn().mockReturnValue(true),
    submit: jest.fn().mockResolvedValue({ jobId: 'job1' }),
    status: jest.fn(),
  };
  const ffmpeg = {
    configured: jest.fn().mockReturnValue(true),
    submit: jest.fn().mockResolvedValue({ jobId: 'burn1' }),
    status: jest.fn(),
  };
  const geminiFiles = {
    uploadAndWaitActive: jest.fn().mockResolvedValue({
      name: 'files/f1',
      uri: 'gemini://f1',
      mimeType: 'video/mp4',
    }),
    deleteFile: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new ActorsService(
    sessions as never,
    blob as never,
    aiUsage as never,
    resemble as never,
    hedra as never,
    ffmpeg as never,
    geminiFiles as never,
  );
  return { svc, sessions, blob, aiUsage, resemble, hedra, ffmpeg, geminiFiles };
}

describe('ActorsService.generateAvatarVideo', () => {
  it('сессия не найдена — 404, ничего не запускается', async () => {
    const { svc, sessions, hedra } = build();
    sessions.getSession.mockResolvedValue(undefined);
    await expect(svc.generateAvatarVideo('s1', 0)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(hedra.submit).not.toHaveBeenCalled();
  });

  it('персонажа с таким индексом нет в снимке — 400 без единого платного вызова', async () => {
    const { svc, resemble, hedra } = build();
    await expect(svc.generateAvatarVideo('s1', 5)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(resemble.synthesize).not.toHaveBeenCalled();
    expect(hedra.submit).not.toHaveBeenCalled();
  });

  it('у персонажа нет фото — 400, Hedra Character-3 требует start_image', async () => {
    const { svc, resemble } = build(
      readySession({
        brandManifestSnapshot: {
          characters: [{ ...CHARACTER, photoUrl: null }],
        },
      }),
    );
    await expect(svc.generateAvatarVideo('s1', 0)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(resemble.synthesize).not.toHaveBeenCalled();
  });

  it('в сессии нет текста реплик — 400 до всякого платного вызова', async () => {
    const { svc, resemble, hedra } = build(
      readySession({ generationPrompt: undefined }),
    );
    await expect(svc.generateAvatarVideo('s1', 0)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(resemble.synthesize).not.toHaveBeenCalled();
    expect(hedra.submit).not.toHaveBeenCalled();
  });

  it('HEDRA_API_KEY не настроен — 400, Resemble не трогаем деньгами зря', async () => {
    const { svc, hedra, resemble } = build();
    hedra.configured.mockReturnValue(false);
    await expect(svc.generateAvatarVideo('s1', 0)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(resemble.synthesize).not.toHaveBeenCalled();
  });

  it('повторный запуск при идущей операции возвращает её же, не 409', async () => {
    const inFlight = {
      status: GenerationStatus.PROCESSING,
      providerJobId: 'job-old',
    };
    const { svc, hedra, sessions } = build(
      readySession({ avatarVideo: inFlight }),
    );
    const result = await svc.generateAvatarVideo('s1', 0);
    expect(result).toBe(inFlight);
    expect(hedra.submit).not.toHaveBeenCalled();
    expect(sessions.claimWork).not.toHaveBeenCalled();
  });

  it('занятый замок — 409, а не тихий повторный запуск', async () => {
    const { svc, sessions, hedra } = build();
    sessions.claimWork.mockResolvedValue(false);
    await expect(svc.generateAvatarVideo('s1', 0)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(hedra.submit).not.toHaveBeenCalled();
  });

  it('сбой синтеза Resemble не запускает Hedra — нет аудио, нечем управлять губами', async () => {
    const { svc, resemble, hedra, aiUsage, sessions } = build();
    resemble.synthesize.mockResolvedValue({
      ok: false,
      skipped: false,
      reason: 'Resemble 500',
    });

    await expect(svc.generateAvatarVideo('s1', 0)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(hedra.submit).not.toHaveBeenCalled();
    expect(aiUsage.record).not.toHaveBeenCalled();
    // Замок обязан сняться даже при отказе — иначе следующая попытка
    // упрётся в ConflictException навсегда.
    expect(sessions.releaseWork).toHaveBeenCalledWith('s1', 'avatar-generate');
  });

  it('сбой Hedra ПОСЛЕ успешного синтеза не отменяет уже учтённый расход на синтез', async () => {
    const { svc, hedra, aiUsage, sessions } = build();
    hedra.submit.mockRejectedValue(new Error('Hedra 500'));

    await expect(svc.generateAvatarVideo('s1', 0)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    // Синтез уже оплачен и записан — тот же принцип, что у Veo: деньги
    // считаются потраченными в момент старта платного вызова, не по
    // его исходу.
    expect(aiUsage.record).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'voiceover' }),
    );
    expect(aiUsage.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'avatar-generation' }),
    );
    expect(sessions.releaseWork).toHaveBeenCalledWith('s1', 'avatar-generate');
    expect(sessions.updateSession).not.toHaveBeenCalled();
  });

  it('успешный запуск пишет расход и на синтез, и на рендер, и сохраняет avatarVideo PROCESSING', async () => {
    const { svc, sessions, aiUsage, hedra } = build();

    const result = await svc.generateAvatarVideo('s1', 0, 'своя сцена');

    expect(result.status).toBe(GenerationStatus.PROCESSING);
    expect(result.provider).toBe('hedra');
    expect(result.providerJobId).toBe('job1');
    expect(result.characterIndex).toBe(0);
    expect(result.characterLabel).toBe('Аня');
    expect(result.photoUrl).toBe(CHARACTER.photoUrl);
    expect(result.prompt).toBe('своя сцена');

    expect(aiUsage.record).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'voiceover',
        model: 'resemble-tts',
      }),
    );
    expect(aiUsage.record).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'avatar-generation',
        model: 'hedra-character-3',
      }),
    );
    expect(hedra.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'своя сцена',
        startImage: CHARACTER.photoUrl,
        aspectRatio: '9:16',
        resolution: '720p',
      }),
    );
    expect(sessions.updateSession).toHaveBeenCalledWith('s1', {
      avatarVideo: expect.objectContaining({
        status: GenerationStatus.PROCESSING,
      }),
    });
    expect(sessions.releaseWork).toHaveBeenCalledWith('s1', 'avatar-generate');
  });

  it('без явного prompt используется описание персонажа', async () => {
    const { svc, hedra } = build();
    await svc.generateAvatarVideo('s1', 0);
    expect(hedra.submit).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: CHARACTER.description }),
    );
  });

  it('чекбокс субтитров выключен по умолчанию — .srt не собирается, только озвучка уходит в Blob', async () => {
    const { svc, blob } = build();
    const result = await svc.generateAvatarVideo('s1', 0);
    expect(result.subtitleStatus).toBe('skipped');
    expect(result.subtitleUrl).toBeNull();
    expect(blob.uploadBuffer).toHaveBeenCalledTimes(1);
    expect(blob.uploadBuffer).not.toHaveBeenCalledWith(
      expect.stringContaining('subtitles'),
      expect.anything(),
      expect.anything(),
    );
  });

  it('чекбокс субтитров включён — .srt собирается из alignment и уходит в Blob, subtitleStatus pending', async () => {
    const { svc, blob } = build();
    const result = await svc.generateAvatarVideo(
      's1',
      0,
      undefined,
      undefined,
      undefined,
      true,
    );
    expect(result.subtitleStatus).toBe('pending');
    expect(result.subtitleUrl).toBe(
      'https://blob.test/sessions/s1/avatar-subtitles.srt',
    );
    expect(result.subtitleTheme).toBe('classic'); // нет темы в снимке бренда — умолчание
    expect(blob.uploadBuffer).toHaveBeenCalledWith(
      'sessions/s1/avatar-subtitles.srt',
      expect.anything(),
      'text/plain',
    );
  });

  it('тема субтитров берётся из снимка бренда, если задана', async () => {
    const { svc } = build(
      readySession({
        brandManifestSnapshot: {
          characters: [CHARACTER],
          subtitleTheme: 'bold',
        },
      }),
    );
    const result = await svc.generateAvatarVideo(
      's1',
      0,
      undefined,
      undefined,
      undefined,
      true,
    );
    expect(result.subtitleTheme).toBe('bold');
  });

  it('чекбокс включён, но Resemble не вернул alignment — субтитры failed, рендер Hedra всё равно уходит', async () => {
    const { svc, resemble, hedra } = build();
    resemble.synthesize.mockResolvedValue({
      ok: true,
      audio: Buffer.from('аудио'),
      mimeType: 'audio/mpeg',
      characters: 30,
      voiceId: 'v1',
      model: 'resemble',
      alignment: undefined, // защитный разбор Resemble не смог собрать тайминг
    });
    const result = await svc.generateAvatarVideo(
      's1',
      0,
      undefined,
      undefined,
      undefined,
      true,
    );
    expect(result.subtitleStatus).toBe('failed');
    expect(result.subtitleError).toMatch(/тайминг/);
    expect(hedra.submit).toHaveBeenCalled(); // деградация, не отказ рендера
  });
});

describe('ActorsService.getAvatarVideoStatus', () => {
  const inFlightVideo = {
    status: GenerationStatus.PROCESSING,
    provider: 'hedra' as const,
    providerJobId: 'job1',
    characterIndex: 0,
    sourceCharacterId: 'char-1',
    characterLabel: 'Аня',
    photoUrl: CHARACTER.photoUrl,
    prompt: 'сцена',
    voiceoverPathname: 'sessions/s1/avatar-voiceover.mp3',
    renderedUrl: null as string | null,
    downloadUrl: null as string | null,
    initiatedAt: new Date(),
    completedAt: null,
    subtitleStatus: 'skipped' as 'skipped' | 'pending' | 'done' | 'failed',
    subtitleTheme: 'classic' as const,
    subtitlePathname: null as string | null,
    subtitleUrl: null as string | null,
    subtitleError: null as string | null,
    subtitleJobId: null as string | null,
    subtitleJobStartedAt: null as Date | null,
    costMicroUsd: null,
    error: null,
  };

  /** Тот же снимок, но с уже собранным `.srt` (чекбокс субтитров был включён при запуске). */
  const inFlightVideoWithSubtitles = {
    ...inFlightVideo,
    subtitleStatus: 'pending' as const,
    subtitleUrl: 'https://blob.test/sessions/s1/avatar-subtitles.srt',
    subtitlePathname: 'sessions/s1/avatar-subtitles.srt',
  };

  it('сессии нет — 404', async () => {
    const { svc, sessions } = build();
    sessions.getSession.mockResolvedValue(undefined);
    await expect(svc.getAvatarVideoStatus('s1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('avatarVideo не заведён — 404, а не пустой ответ', async () => {
    const { svc } = build(readySession({ avatarVideo: undefined }));
    await expect(svc.getAvatarVideoStatus('s1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('уже COMPLETE — отдаём как есть, Hedra не дёргаем повторно', async () => {
    const complete = { ...inFlightVideo, status: GenerationStatus.COMPLETE };
    const { svc, hedra } = build(readySession({ avatarVideo: complete }));
    const result = await svc.getAvatarVideoStatus('s1');
    expect(result).toBe(complete);
    expect(hedra.status).not.toHaveBeenCalled();
  });

  it('ещё IN_PROGRESS — статус не меняется, файл не скачивается', async () => {
    const { svc, hedra, sessions } = build(
      readySession({ avatarVideo: inFlightVideo }),
    );
    hedra.status.mockResolvedValue({ status: 'pending' });
    const result = await svc.getAvatarVideoStatus('s1');
    expect(result.status).toBe(GenerationStatus.PROCESSING);
    expect(sessions.updateSession).not.toHaveBeenCalled();
  });

  it('FAILED от Hedra — сохраняется как FAILED с причиной', async () => {
    const { svc, hedra, sessions } = build(
      readySession({ avatarVideo: inFlightVideo }),
    );
    hedra.status.mockResolvedValue({ status: 'failed', error: 'model error' });
    const result = await svc.getAvatarVideoStatus('s1');
    expect(result.status).toBe(GenerationStatus.FAILED);
    expect(result.error?.message).toBe('model error');
    expect(sessions.updateSession).toHaveBeenCalledWith('s1', {
      avatarVideo: expect.objectContaining({ status: GenerationStatus.FAILED }),
    });
  });

  it('сбой самого опроса статуса — видео остаётся как есть, следующий опрос повторит', async () => {
    const { svc, hedra, sessions } = build(
      readySession({ avatarVideo: inFlightVideo }),
    );
    hedra.status.mockRejectedValue(new Error('ECONNRESET'));
    const result = await svc.getAvatarVideoStatus('s1');
    expect(result.status).toBe(GenerationStatus.PROCESSING);
    expect(sessions.updateSession).not.toHaveBeenCalled();
  });

  it('COMPLETED — скачивает результат, перезаливает в свой Blob, сохраняет COMPLETE', async () => {
    const realFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Buffer.from('видео'),
    }) as unknown as typeof fetch;

    const { svc, hedra, blob, sessions } = build(
      readySession({ avatarVideo: inFlightVideo }),
    );
    hedra.status.mockResolvedValue({
      status: 'completed',
      outputs: [{ url: 'https://hedra.test/out.mp4' }],
      costMicroUsd: 400000,
    });
    blob.uploadBuffer.mockResolvedValue({
      url: 'https://blob.test/sessions/s1/avatar.mp4',
    });

    const result = await svc.getAvatarVideoStatus('s1');

    expect(result.status).toBe(GenerationStatus.COMPLETE);
    expect(result.downloadUrl).toBe('https://blob.test/sessions/s1/avatar.mp4');
    expect(result.costMicroUsd).toBe(400000);
    expect(sessions.updateSession).toHaveBeenCalledWith('s1', {
      avatarVideo: expect.objectContaining({
        status: GenerationStatus.COMPLETE,
      }),
    });

    global.fetch = realFetch;
  });

  it('COMPLETED без файла в outputs — провал, а не тихая пустышка', async () => {
    const { svc, hedra, sessions } = build(
      readySession({ avatarVideo: inFlightVideo }),
    );
    hedra.status.mockResolvedValue({ status: 'completed', outputs: undefined });
    const result = await svc.getAvatarVideoStatus('s1');
    expect(result.status).toBe(GenerationStatus.FAILED);
    expect(sessions.updateSession).toHaveBeenCalled();
  });

  it('дедлайн истёк — провал по таймауту, даже если Hedra ещё не ответила', async () => {
    const expired = {
      ...inFlightVideo,
      initiatedAt: new Date(Date.now() - 21 * 60 * 1000),
    };
    const { svc, hedra, sessions } = build(
      readySession({ avatarVideo: expired }),
    );
    const result = await svc.getAvatarVideoStatus('s1');
    expect(result.status).toBe(GenerationStatus.FAILED);
    expect(result.error?.code).toBe('AVATAR_GENERATION_TIMEOUT');
    expect(hedra.status).not.toHaveBeenCalled();
    expect(sessions.updateSession).toHaveBeenCalled();
  });

  // Этап 72а: субтитры прожигаются ВТОРЫМ проходом ffmpeg, ПОСЛЕ того как
  // Hedra уже отдала файл — отдельная фаза со своим состоянием
  // (`subtitleJobId`) и своим дедлайном.
  describe('прожиг субтитров (этап 72а)', () => {
    const withFetch = (fn: () => Promise<unknown>) => {
      const realFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => Buffer.from('видео'),
      }) as unknown as typeof fetch;
      return fn().finally(() => {
        global.fetch = realFetch;
      });
    };

    it('Hedra готова, субтитры заказаны — сырой файл сохраняется, отправляется задача ffmpeg, статус остаётся PROCESSING', async () =>
      withFetch(async () => {
        const { svc, hedra, ffmpeg, aiUsage, sessions } = build(
          readySession({ avatarVideo: inFlightVideoWithSubtitles }),
        );
        hedra.status.mockResolvedValue({
          status: 'completed',
          outputs: [{ url: 'https://hedra.test/out.mp4' }],
        });

        const result = await svc.getAvatarVideoStatus('s1');

        expect(result.status).toBe(GenerationStatus.PROCESSING);
        expect(result.renderedUrl).toBe(
          'https://blob.test/sessions/s1/avatar-raw.mp4',
        );
        expect(result.subtitleJobId).toBe('burn1');
        expect(ffmpeg.submit).toHaveBeenCalledWith({
          inputs: {
            source: 'https://blob.test/sessions/s1/avatar-raw.mp4',
            subs: inFlightVideoWithSubtitles.subtitleUrl,
          },
          outputs: expect.any(Array),
          commands: expect.any(Array),
        });
        expect(aiUsage.record).toHaveBeenCalledWith(
          expect.objectContaining({
            operation: 'reframe',
            model: 'ffmpeg-api',
          }),
        );
        expect(sessions.updateSession).toHaveBeenCalledWith('s1', {
          avatarVideo: expect.objectContaining({ subtitleJobId: 'burn1' }),
        });
        expect(sessions.claimWork).toHaveBeenCalledWith(
          's1',
          'avatar-subtitle-burn',
          expect.any(Number),
        );
        expect(sessions.releaseWork).toHaveBeenCalledWith(
          's1',
          'avatar-subtitle-burn',
        );
      }));

    it('замок отправки прожига уже занят другим опросом — ffmpeg не вызываем, деньги не тратим дважды', async () =>
      withFetch(async () => {
        const { svc, hedra, ffmpeg, sessions } = build(
          readySession({ avatarVideo: inFlightVideoWithSubtitles }),
        );
        hedra.status.mockResolvedValue({
          status: 'completed',
          outputs: [{ url: 'https://hedra.test/out.mp4' }],
        });
        sessions.claimWork.mockResolvedValue(false);

        const result = await svc.getAvatarVideoStatus('s1');

        expect(result.status).toBe(GenerationStatus.PROCESSING);
        expect(ffmpeg.submit).not.toHaveBeenCalled();
      }));

    it('Hedra готова, субтитры НЕ заказаны — финализируется сразу сырым файлом, ffmpeg не трогаем', async () =>
      withFetch(async () => {
        const { svc, ffmpeg, hedra } = build(
          readySession({ avatarVideo: inFlightVideo }),
        );
        hedra.status.mockResolvedValue({
          status: 'completed',
          outputs: [{ url: 'https://hedra.test/out.mp4' }],
        });

        const result = await svc.getAvatarVideoStatus('s1');

        expect(result.status).toBe(GenerationStatus.COMPLETE);
        expect(result.downloadUrl).toBe(
          'https://blob.test/sessions/s1/avatar-raw.mp4',
        );
        expect(ffmpeg.submit).not.toHaveBeenCalled();
      }));

    it('ffmpeg не настроен на стенде — финализируется сырым файлом, subtitleStatus failed', async () =>
      withFetch(async () => {
        const { svc, ffmpeg, hedra } = build(
          readySession({ avatarVideo: inFlightVideoWithSubtitles }),
        );
        ffmpeg.configured.mockReturnValue(false);
        hedra.status.mockResolvedValue({
          status: 'completed',
          outputs: [{ url: 'https://hedra.test/out.mp4' }],
        });

        const result = await svc.getAvatarVideoStatus('s1');

        expect(result.status).toBe(GenerationStatus.COMPLETE);
        expect(result.downloadUrl).toBe(
          'https://blob.test/sessions/s1/avatar-raw.mp4',
        );
        expect(result.subtitleStatus).toBe('failed');
        expect(ffmpeg.submit).not.toHaveBeenCalled();
      }));

    it('задача ffmpeg отправлена, ещё pending — видео не меняется, следующий опрос повторит', async () => {
      const inBurn = {
        ...inFlightVideoWithSubtitles,
        renderedUrl: 'https://blob.test/sessions/s1/avatar-raw.mp4',
        subtitleJobId: 'burn1',
        subtitleJobStartedAt: new Date(),
      };
      const { svc, ffmpeg, sessions } = build(
        readySession({ avatarVideo: inBurn }),
      );
      ffmpeg.status.mockResolvedValue({ status: 'pending' });

      const result = await svc.getAvatarVideoStatus('s1');

      expect(result.status).toBe(GenerationStatus.PROCESSING);
      expect(sessions.updateSession).not.toHaveBeenCalled();
    });

    it('задача ffmpeg готова — скачивает прожжённый файл, сохраняет COMPLETE с subtitleStatus done', async () =>
      withFetch(async () => {
        const inBurn = {
          ...inFlightVideoWithSubtitles,
          renderedUrl: 'https://blob.test/sessions/s1/avatar-raw.mp4',
          subtitleJobId: 'burn1',
          subtitleJobStartedAt: new Date(),
        };
        const { svc, ffmpeg, sessions } = build(
          readySession({ avatarVideo: inBurn }),
        );
        ffmpeg.status.mockResolvedValue({
          status: 'completed',
          outputs: { 'final.mp4': 'https://ffmpeg.test/burned.mp4' },
        });

        const result = await svc.getAvatarVideoStatus('s1');

        expect(result.status).toBe(GenerationStatus.COMPLETE);
        expect(result.subtitleStatus).toBe('done');
        expect(result.downloadUrl).toBe(
          'https://blob.test/sessions/s1/avatar.mp4',
        );
        expect(sessions.updateSession).toHaveBeenCalledWith('s1', {
          avatarVideo: expect.objectContaining({
            status: GenerationStatus.COMPLETE,
            subtitleStatus: 'done',
          }),
        });
      }));

    it('задача ffmpeg провалилась — финализируется сырым файлом, subtitleStatus failed', async () => {
      const inBurn = {
        ...inFlightVideoWithSubtitles,
        renderedUrl: 'https://blob.test/sessions/s1/avatar-raw.mp4',
        subtitleJobId: 'burn1',
        subtitleJobStartedAt: new Date(),
      };
      const { svc, ffmpeg } = build(readySession({ avatarVideo: inBurn }));
      ffmpeg.status.mockResolvedValue({
        status: 'failed',
        error: 'subtitles filter crashed',
      });

      const result = await svc.getAvatarVideoStatus('s1');

      expect(result.status).toBe(GenerationStatus.COMPLETE);
      expect(result.subtitleStatus).toBe('failed');
      expect(result.subtitleError).toBe('subtitles filter crashed');
      expect(result.downloadUrl).toBe(
        'https://blob.test/sessions/s1/avatar-raw.mp4',
      );
    });

    it('дедлайн прожига истёк — финализируется сырым файлом без опроса ffmpeg', async () => {
      const inBurn = {
        ...inFlightVideoWithSubtitles,
        renderedUrl: 'https://blob.test/sessions/s1/avatar-raw.mp4',
        subtitleJobId: 'burn1',
        subtitleJobStartedAt: new Date(
          Date.now() - AVATAR_SUBTITLE_DEADLINE_MS - 1000,
        ),
      };
      const { svc, ffmpeg } = build(readySession({ avatarVideo: inBurn }));

      const result = await svc.getAvatarVideoStatus('s1');

      expect(result.status).toBe(GenerationStatus.COMPLETE);
      expect(result.subtitleStatus).toBe('failed');
      expect(ffmpeg.status).not.toHaveBeenCalled();
    });

    it('ffmpeg.submit падает — финализируется сырым файлом, subtitleStatus failed', async () =>
      withFetch(async () => {
        const { svc, ffmpeg, hedra } = build(
          readySession({ avatarVideo: inFlightVideoWithSubtitles }),
        );
        ffmpeg.submit.mockRejectedValue(new Error('ffmpeg-api 500'));
        hedra.status.mockResolvedValue({
          status: 'completed',
          outputs: [{ url: 'https://hedra.test/out.mp4' }],
        });

        const result = await svc.getAvatarVideoStatus('s1');

        expect(result.status).toBe(GenerationStatus.COMPLETE);
        expect(result.subtitleStatus).toBe('failed');
        expect(result.subtitleError).toMatch(/ffmpeg-api 500/);
      }));
  });

  // Аудит 2026-09-09 (`doc/AVATAR-PIPELINE-AUDIT-2026-09-09.md`), Д-1 и
  // Д-2: гонки, которые сам факт «`current` читается один раз в начале
  // опроса, а затем идёт внешний вызов (Hedra/ffmpeg/скачивание)» делает
  // возможными. Оба теста имитируют «второй, конкурентный опрос успел
  // продвинуть состояние между двумя чтениями сессии» через
  // `mockImplementationOnce` на `sessions.getSession` — первое чтение
  // (начало `getAvatarVideoStatus`) отдаёт устаревший снимок, второе
  // (внутри `writeIfStillCurrent`/фазы отправки прожига, прямо перед
  // платной операцией или записью) отдаёт то, что «уже» записал другой,
  // более быстрый опрос.
  describe('гонки конкурентных опросов (Д-1 / Д-2)', () => {
    it('Д-2: устаревший снимок дедлайна не затирает уже готовый результат другого опроса', async () => {
      const staleCurrent = {
        ...inFlightVideo,
        // дольше AVATAR_RENDER_DEADLINE_MS (20 минут) — наш снимок
        // считает рендер зависшим...
        initiatedAt: new Date(Date.now() - 21 * 60 * 1000),
      };
      const alreadyCompleted = {
        ...staleCurrent,
        // ...а на самом деле другой опрос уже успел его завершить.
        status: GenerationStatus.COMPLETE,
        completedAt: new Date(),
        downloadUrl: 'https://blob.test/sessions/s1/avatar-raw.mp4',
      };
      const { svc, sessions } = build(
        readySession({ avatarVideo: staleCurrent }),
      );
      sessions.getSession
        .mockImplementationOnce(() =>
          Promise.resolve(readySession({ avatarVideo: staleCurrent })),
        )
        .mockImplementationOnce(() =>
          Promise.resolve(readySession({ avatarVideo: alreadyCompleted })),
        );

      const result = await svc.getAvatarVideoStatus('s1');

      // Без `writeIfStillCurrent` здесь была бы запись FAILED поверх
      // уже готового и оплаченного ролика — именно это находка Д-2 и
      // описывала как необратимую потерю результата.
      expect(result).toEqual(alreadyCompleted);
      expect(sessions.updateSession).not.toHaveBeenCalled();
    });

    it('Д-1: другой опрос уже отправил и снял замок прожига — вторую задачу ffmpeg не шлём и не платим дважды', async () => {
      const beforeSubmit = {
        ...inFlightVideoWithSubtitles,
        renderedUrl: 'https://blob.test/sessions/s1/avatar-raw.mp4',
        // subtitleJobId ещё пуст — таким его видел наш (медленный) опрос.
      };
      const alreadySubmittedByOther = {
        ...beforeSubmit,
        subtitleJobId: 'burn-from-other-poll',
        subtitleJobStartedAt: new Date(),
      };
      const { svc, sessions, ffmpeg, aiUsage } = build(
        readySession({ avatarVideo: beforeSubmit }),
      );
      // Замок ('avatar-subtitle-burn') нам всё равно достаётся
      // (`claimWork` замокан на `true` по умолчанию) — ровно та ситуация
      // из Д-1: чужой опрос уже успел отправить задачу и освободить
      // замок ДО того, как он снова стал свободен для нас.
      sessions.getSession
        .mockImplementationOnce(() =>
          Promise.resolve(readySession({ avatarVideo: beforeSubmit })),
        )
        .mockImplementationOnce(() =>
          Promise.resolve(
            readySession({ avatarVideo: alreadySubmittedByOther }),
          ),
        );

      const result = await svc.getAvatarVideoStatus('s1');

      expect(result).toEqual(alreadySubmittedByOther);
      expect(ffmpeg.submit).not.toHaveBeenCalled();
      expect(aiUsage.record).not.toHaveBeenCalled();
      expect(sessions.releaseWork).toHaveBeenCalledWith(
        's1',
        'avatar-subtitle-burn',
      );
    });
  });
});

// Этап 73: по прямому запросу владельца продукта — отдельная от общего
// артефакт-аудита Gemini-проверка «звучит ли голос как человек, а не как
// TTS». У пилота аватара не было вообще никакого аудита до этого этапа.
describe('ActorsService.runSoundCheck', () => {
  const withFetch = (fn: () => Promise<unknown>) => {
    const realFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Buffer.from('видео'),
    }) as unknown as typeof fetch;
    return fn().finally(() => {
      global.fetch = realFetch;
    });
  };
  const doneAvatar = {
    status: GenerationStatus.COMPLETE,
    provider: 'hedra' as const,
    providerJobId: 'job1',
    characterIndex: 0,
    sourceCharacterId: 'char-1',
    characterLabel: 'Аня',
    photoUrl: CHARACTER.photoUrl,
    prompt: 'сцена',
    voiceoverPathname: 'sessions/s1/avatar-voiceover.mp3',
    renderedUrl: 'https://blob.test/sessions/s1/avatar-raw.mp4',
    downloadUrl: 'https://blob.test/sessions/s1/avatar.mp4',
    initiatedAt: new Date(),
    completedAt: new Date(),
    subtitleStatus: 'skipped' as const,
    subtitleTheme: 'classic' as const,
    subtitlePathname: null,
    subtitleUrl: null,
    subtitleError: null,
    subtitleJobId: null,
    subtitleJobStartedAt: null,
    costMicroUsd: 100,
    error: null,
  };

  it('нет готового ролика — 400, Gemini не вызывается', async () => {
    const { svc } = build(readySession({ avatarVideo: undefined }));
    await expect(svc.runSoundCheck('s1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(generateContent).not.toHaveBeenCalled();
  });

  it('ролик ещё рендерится (PROCESSING) — 400', async () => {
    const { svc } = build(
      readySession({
        avatarVideo: { ...doneAvatar, status: GenerationStatus.PROCESSING },
      }),
    );
    await expect(svc.runSoundCheck('s1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('успех — скачивает ролик, загружает в Gemini Files, разбирает вердикт, сохраняет в session.soundCheck', async () =>
    withFetch(async () => {
      const { svc, sessions, geminiFiles, aiUsage } = build(
        readySession({ avatarVideo: doneAvatar }),
      );
      generateContent.mockResolvedValue({
        text: JSON.stringify({
          verdict: 'human',
          summary: 'Звучит естественно',
          notes: ['небольшие паузы между фразами уместны'],
        }),
      });

      const result = await svc.runSoundCheck('s1');

      expect(geminiFiles.uploadAndWaitActive).toHaveBeenCalledWith(
        expect.any(Buffer),
        'video/mp4',
      );
      expect(geminiFiles.deleteFile).toHaveBeenCalledWith('files/f1');
      expect(aiUsage.recordGemini).toHaveBeenCalled();
      expect(result.history).toHaveLength(1);
      expect(result.history[0]).toMatchObject({
        subject: 'avatar',
        status: 'complete',
        verdict: 'human',
        summary: 'Звучит естественно',
        notes: ['небольшие паузы между фразами уместны'],
      });
      expect(sessions.updateSession).toHaveBeenCalledWith('s1', {
        soundCheck: {
          history: [expect.objectContaining({ verdict: 'human' })],
        },
      });
    }));

  it('Gemini вернула нераспарсиваемый ответ — verdict "unknown", не бросает', async () =>
    withFetch(async () => {
      const { svc } = build(readySession({ avatarVideo: doneAvatar }));
      generateContent.mockResolvedValue({ text: 'не JSON вовсе' });

      const result = await svc.runSoundCheck('s1');

      expect(result.history[0].verdict).toBe('unknown');
      expect(result.history[0].status).toBe('complete');
    }));

  it('скачивание ролика не удалось — status failed, история всё равно пишется', async () => {
    const realFetch = global.fetch;
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch;
    try {
      const { svc, sessions } = build(
        readySession({ avatarVideo: doneAvatar }),
      );
      const result = await svc.runSoundCheck('s1');
      expect(result.history[0].status).toBe('failed');
      expect(result.history[0].error).toBeTruthy();
      expect(sessions.updateSession).toHaveBeenCalled();
    } finally {
      global.fetch = realFetch;
    }
  });

  it('накапливает историю новыми записями впереди (newest first)', async () =>
    withFetch(async () => {
      const { svc } = build(readySession({ avatarVideo: doneAvatar }));
      generateContent
        .mockResolvedValueOnce({
          text: JSON.stringify({ verdict: 'synthetic', summary: 'первая' }),
        })
        .mockResolvedValueOnce({
          text: JSON.stringify({ verdict: 'human', summary: 'вторая' }),
        });

      await svc.runSoundCheck('s1');
      const result = await svc.runSoundCheck('s1');

      expect(result.history).toHaveLength(2);
      expect(result.history[0].summary).toBe('вторая');
      expect(result.history[1].summary).toBe('первая');
    }));

  // Е-3.1 шестого аудита: раньше не было НИКАКОГО замка — двойной клик
  // «Проверить звук» платил за Gemini дважды, и более ранний ответ мог
  // молча затереть более поздний в `session.soundCheck`.
  describe('замок avatar-sound-check (Е-3.1 шестого аудита)', () => {
    it('замок уже занят другим опросом — 409, Gemini не вызывается вовсе', async () => {
      const { svc, sessions } = build(
        readySession({ avatarVideo: doneAvatar }),
      );
      sessions.claimWork.mockResolvedValue(false);

      await expect(svc.runSoundCheck('s1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(generateContent).not.toHaveBeenCalled();
      expect(sessions.releaseWork).not.toHaveBeenCalled();
    });

    it('замок берётся и снимается после успеха', async () =>
      withFetch(async () => {
        const { svc, sessions } = build(
          readySession({ avatarVideo: doneAvatar }),
        );
        generateContent.mockResolvedValue({
          text: JSON.stringify({ verdict: 'human', summary: 'ок' }),
        });

        await svc.runSoundCheck('s1');

        expect(sessions.claimWork).toHaveBeenCalledWith(
          's1',
          'avatar-sound-check',
          expect.any(Number),
        );
        expect(sessions.releaseWork).toHaveBeenCalledWith(
          's1',
          'avatar-sound-check',
        );
      }));

    it('замок снимается даже при провале скачивания/Gemini', async () => {
      const realFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
      }) as unknown as typeof fetch;
      try {
        const { svc, sessions } = build(
          readySession({ avatarVideo: doneAvatar }),
        );
        await svc.runSoundCheck('s1');
        expect(sessions.releaseWork).toHaveBeenCalledWith(
          's1',
          'avatar-sound-check',
        );
      } finally {
        global.fetch = realFetch;
      }
    });

    it('пишет поверх самого свежего soundCheck из БД, а не поверх снимка на момент старта', async () =>
      withFetch(async () => {
        // Между чтением сессии в начале метода и финальной записью другой
        // запрос (в реальности — конкурентный вызов под тем же замком,
        // здесь просто эмулируем внешнее изменение БД) успел дописать
        // свою запись — `getSession` должен быть вызван ЕЩЁ РАЗ перед
        // финальной записью и построить историю поверх неё, а не поверх
        // изначального пустого состояния.
        const { svc, sessions } = build(
          readySession({ avatarVideo: doneAvatar }),
        );
        generateContent.mockResolvedValue({
          text: JSON.stringify({ verdict: 'human', summary: 'новая' }),
        });
        const externalEntry = {
          checkId: 'external-1',
          subject: 'avatar' as const,
          requestedAt: new Date(),
          completedAt: new Date(),
          status: 'complete' as const,
          verdict: 'unknown' as const,
          summary: 'внешняя запись',
          notes: [],
        };
        const originalGetSession = sessions.getSession.getMockImplementation();
        let call = 0;
        sessions.getSession.mockImplementation(() => {
          call += 1;
          if (call === 2) {
            // Второй вызов — свежее чтение перед записью: подсовываем
            // состояние с уже одной записью, которой не было при первом
            // чтении в начале метода.
            return Promise.resolve({
              ...readySession({ avatarVideo: doneAvatar }),
              soundCheck: { history: [externalEntry] },
            });
          }
          return originalGetSession!();
        });

        const result = await svc.runSoundCheck('s1');

        expect(result.history).toHaveLength(2);
        expect(result.history[0].summary).toBe('новая');
        expect(result.history[1].checkId).toBe('external-1');
      }));
  });
});

describe('avatarRenderExpired / avatarSubtitleExpired', () => {
  it('avatarRenderExpired: в пределах дедлайна — false', () => {
    expect(
      avatarRenderExpired(
        {
          initiatedAt: new Date(Date.now() - 5 * 60 * 1000),
          renderedUrl: null,
        },
        Date.now(),
      ),
    ).toBe(false);
  });

  it('avatarRenderExpired: за пределами дедлайна — true', () => {
    expect(
      avatarRenderExpired(
        {
          initiatedAt: new Date(Date.now() - 21 * 60 * 1000),
          renderedUrl: null,
        },
        Date.now(),
      ),
    ).toBe(true);
  });

  it('avatarRenderExpired: renderedUrl уже задан — всегда false, даже за пределами старого дедлайна', () => {
    expect(
      avatarRenderExpired(
        {
          initiatedAt: new Date(Date.now() - 60 * 60 * 1000),
          renderedUrl: 'https://blob.test/raw.mp4',
        },
        Date.now(),
      ),
    ).toBe(false);
  });

  it('avatarSubtitleExpired: задача не отправлена (subtitleJobStartedAt null) — false', () => {
    expect(
      avatarSubtitleExpired({ subtitleJobStartedAt: null }, Date.now()),
    ).toBe(false);
  });

  it('avatarSubtitleExpired: в пределах дедлайна — false', () => {
    expect(
      avatarSubtitleExpired(
        { subtitleJobStartedAt: new Date(Date.now() - 2 * 60 * 1000) },
        Date.now(),
      ),
    ).toBe(false);
  });

  it('avatarSubtitleExpired: за пределами дедлайна — true', () => {
    expect(
      avatarSubtitleExpired(
        {
          subtitleJobStartedAt: new Date(
            Date.now() - AVATAR_SUBTITLE_DEADLINE_MS - 1000,
          ),
        },
        Date.now(),
      ),
    ).toBe(true);
  });
});
