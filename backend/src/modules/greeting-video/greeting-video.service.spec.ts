/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
// Цепочка импортов сервиса задевает `@prisma/client` рантаймом (через
// `SessionService`) — в песочнице клиент не сгенерирован, и модуль упал
// бы при ЗАГРУЗКЕ. Тот же приём, что в соседних наборах.
jest.mock('@prisma/client', () => ({
  Prisma: { DbNull: Symbol.for('Prisma.DbNull') },
  WorkflowKind: { SINGLE: 'SINGLE', LINE: 'LINE' },
}));

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
  const startGeneration = jest.fn().mockResolvedValue({ requestId: 'r1' });
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
    {} as any,
    {
      isConfigured: () => true,
      modelName: 'grok-imagine-video-1.5',
      startGeneration,
    } as any,
    {} as any,
  );
  return { svc, startGeneration, updateSession };
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
