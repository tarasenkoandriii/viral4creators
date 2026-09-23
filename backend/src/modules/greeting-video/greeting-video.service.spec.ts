/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { GreetingVideoService } from './greeting-video.service';
import { GenerationStatus } from '../../common/types/generation.types';

const BRIEF = {
  sourceGreetingBriefId: 'gb1',
  occasion: 'BIRTHDAY',
  customOccasionText: null,
  recipientName: 'Марина',
  senderName: 'Андрей',
  tone: 'WARM',
  personalMessage: null,
  requestedPresenterProvider: 'grok',
  resolvedPresenterProvider: 'grok',
  requestedResolution: '720p',
  resolvedResolution: '720p',
  brandManifestId: null,
  occasionDate: null,
  addedAt: '2026-09-22T10:00:00.000Z',
};

function build(sessionOver: Record<string, unknown> = {}) {
  let n = 0;
  const startGeneration = jest
    .fn()
    .mockImplementation(() => Promise.resolve({ requestId: `r${++n}` }));
  const getStatus = jest.fn().mockResolvedValue({ done: false });
  const uploadBuffer = jest
    .fn()
    .mockImplementation((pathname: string) =>
      Promise.resolve({ url: `https://blob.test/${pathname}` }),
    );
  const postprodStart = jest
    .fn()
    .mockImplementation((_id: string, v: unknown) => Promise.resolve(v));
  const updateSession = jest
    .fn()
    .mockImplementation((_id: string, patch: Record<string, unknown>) =>
      Promise.resolve(patch),
    );
  const sessions = {
    getSession: jest.fn().mockResolvedValue({
      sessionId: 's1',
      userId: 'u1',
      greetingBriefSnapshot: BRIEF,
      generationPrompt: {
        finalText: 'сцена',
        moderationStatus: 'APPROVED',
      },
      greetingReferenceImages: [],
      ...sessionOver,
    }),
    updateSession,
    claimWork: jest.fn().mockResolvedValue(true),
    releaseWork: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new GreetingVideoService(
    sessions as any,
    { assertCanSpendSession: jest.fn().mockResolvedValue(undefined) } as any,
    { record: jest.fn().mockResolvedValue(undefined) } as any,
    { start: postprodStart } as any,
    {
      isConfigured: () => true,
      modelName: 'grok-imagine-video-1.5',
      startGeneration,
      getStatus,
    } as any,
    { uploadBuffer } as any,
  );
  return {
    svc,
    startGeneration,
    updateSession,
    getStatus,
    uploadBuffer,
    postprodStart,
  };
}

describe('GreetingVideoService — пресетный голос xAI', () => {
  const presetBrief = { ...BRIEF, presetVoiceId: 'eve' };

  it('голос уходит в reference_audios, и ролик заказывается СО звуком', async () => {
    // Реплику произносит модель — немой ролик здесь означал бы
    // поздравление без поздравления.
    const { svc, startGeneration } = build({
      greetingBriefSnapshot: presetBrief,
    });
    const video = await svc.startVideo('s1');
    expect(startGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        generateAudio: true,
        referenceAudioVoiceIds: ['eve'],
      }),
    );
    expect(video.silentSource).toBeUndefined();
  });

  it('голос один, а не три — в поздравлении говорящий один', async () => {
    const { svc, startGeneration } = build({
      greetingBriefSnapshot: presetBrief,
    });
    await svc.startVideo('s1');
    const args = startGeneration.mock.calls[0][0] as {
      referenceAudioVoiceIds: string[];
    };
    expect(args.referenceAudioVoiceIds).toHaveLength(1);
  });

  it('пресета нет — поля нет, поведение прежнее', async () => {
    const { svc, startGeneration } = build();
    await svc.startVideo('s1');
    const args = startGeneration.mock.calls[0][0] as Record<string, unknown>;
    expect(args).not.toHaveProperty('referenceAudioVoiceIds');
  });
});

describe('GreetingVideoService — звук ролика заказывается по режиму озвучки', () => {
  it('реплику озвучиваем мы — у Grok просим немой ролик и помечаем его таким', async () => {
    // Иначе модель отдаёт дорожку, где ведущий проговаривает то же
    // поздравление, а постобработка кладёт нашу речь поверх: слышны обе.
    const { svc, startGeneration } = build();
    const video = await svc.startVideo('s1');
    expect(startGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ generateAudio: false }),
    );
    expect(video.silentSource).toBe(true);
  });

  it('снимка бренда нет вовсе — читается как voiceover, ролик всё равно немой', async () => {
    const { svc, startGeneration } = build({
      brandManifestSnapshot: undefined,
    });
    await svc.startVideo('s1');
    expect(startGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ generateAudio: false }),
    );
  });

  it('дубляж — тоже немой: звук всё равно наш', async () => {
    const { svc, startGeneration } = build({
      brandManifestSnapshot: { voiceMode: 'dub' },
    });
    await svc.startVideo('s1');
    expect(startGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ generateAudio: false }),
    );
  });

  it('говорит модель (режим veo) — звук просим, пометки немого нет', async () => {
    // Единственный режим, где дорожка модели и есть озвучка ролика.
    const { svc, startGeneration } = build({
      brandManifestSnapshot: { voiceMode: 'veo' },
    });
    const video = await svc.startVideo('s1');
    expect(startGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ generateAudio: true }),
    );
    expect(video.silentSource).toBeUndefined();
    expect(video.status).toBe(GenerationStatus.PROCESSING);
  });
});

describe('GreetingVideoService — мультисценовый ролик (фича №7)', () => {
  const multi = { ...BRIEF, sceneCount: 3 };

  it('сцены уходят раскадровкой в ОДНОМ вызове, а не несколькими', async () => {
    // Ровно так уже работает товарная ветка: один промпт описывает
    // сцены по порядку, модель рендерит их одним клипом. Склейка в
    // конвейере не нужна вовсе.
    const { svc, startGeneration } = build({ greetingBriefSnapshot: multi });
    await svc.startVideo('s1');
    expect(startGeneration).toHaveBeenCalledTimes(1);
    const prompt = (startGeneration.mock.calls[0][0] as { prompt: string })
      .prompt;
    expect(prompt).toContain('сцена');
    expect(prompt).toContain('3 consecutive shots');
    expect(prompt).toContain('Shot 3');
  });

  it('длина ролика не меняется — сцены делят те же пятнадцать секунд', async () => {
    const { svc, startGeneration } = build({ greetingBriefSnapshot: multi });
    await svc.startVideo('s1');
    const args = startGeneration.mock.calls[0][0] as {
      durationSeconds: number;
    };
    expect(args.durationSeconds).toBe(15);
  });

  it('одна сцена — промпт ровно тот же, что и до фичи', async () => {
    // Молча изменить промпт всех существующих роликов фича не вправе.
    const { svc, startGeneration } = build({
      greetingBriefSnapshot: { ...BRIEF, sceneCount: 1 },
    });
    await svc.startVideo('s1');
    const prompt = (startGeneration.mock.calls[0][0] as { prompt: string })
      .prompt;
    expect(prompt).toBe('сцена');
  });

  it('пресетный голос мультисцене не мешает — он звучит один раз на ролик', async () => {
    const { svc, startGeneration } = build({
      greetingBriefSnapshot: { ...multi, presetVoiceId: 'eve' },
    });
    await svc.startVideo('s1');
    const args = startGeneration.mock.calls[0][0] as {
      prompt: string;
      referenceAudioVoiceIds: string[];
      generateAudio: boolean;
    };
    expect(args.referenceAudioVoiceIds).toEqual(['eve']);
    expect(args.generateAudio).toBe(true);
    expect(args.prompt).toContain('Shot 2');
  });
});
