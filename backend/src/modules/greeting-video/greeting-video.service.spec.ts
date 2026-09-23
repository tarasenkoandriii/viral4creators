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
  const plans = {
    assertCanSpendSession: jest.fn().mockResolvedValue(undefined),
    assertSession: jest.fn().mockResolvedValue(undefined),
    planOfSession: jest.fn().mockResolvedValue('PREMIUM'),
  };
  const aiUsage = {
    record: jest.fn().mockResolvedValue(undefined),
    countToday: jest.fn().mockResolvedValue(0),
  };
  const hedra = {
    configured: () => true,
    submit: jest.fn().mockResolvedValue({ jobId: 'hj1' }),
    status: jest.fn().mockResolvedValue({ status: 'pending' }),
  };
  const ttsResolver = {
    resolve: jest.fn().mockResolvedValue({
      providerKey: 'resemble',
      synthesize: jest.fn().mockResolvedValue({
        ok: true,
        audio: Buffer.from('mp3'),
        mimeType: 'audio/mpeg',
        characters: 42,
      }),
    }),
  };
  const svc = new GreetingVideoService(
    sessions as any,
    plans as any,
    aiUsage as any,
    { start: postprodStart } as any,
    {
      isConfigured: () => true,
      modelName: 'grok-imagine-video-1.5',
      startGeneration,
      getStatus,
    } as any,
    { uploadBuffer } as any,
    hedra as any,
    ttsResolver as any,
  );
  return {
    svc,
    plans,
    aiUsage,
    hedra,
    ttsResolver,
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

/**
 * Говорящий аватар (Hedra) — ветка PREMIUM.
 *
 * До решения владельца продукта её не существовало: метод отказывал
 * раньше, чем доходил до аргументов, и заканчивался `throw new
 * BadRequestException('Not implemented')`. Поэтому здесь проверяется не
 * «поведение не изменилось», а устройство целиком — и прежде всего
 * порядок: у Grok озвучка это последствие, у Hedra — вход.
 */
const HEDRA_BRIEF = {
  ...BRIEF,
  requestedPresenterProvider: 'hedra',
  resolvedPresenterProvider: 'hedra',
  senderVoice: {
    userVoiceId: 'uv1',
    resembleVoiceId: 'rv1',
    label: 'Мой голос',
  },
};

const withPortrait = (over: Record<string, unknown> = {}) => ({
  greetingBriefSnapshot: HEDRA_BRIEF,
  greetingReferenceImages: [
    { photoUrl: 'https://blob.test/face.jpg', photoPathname: 'a.jpg' },
    { photoUrl: 'https://blob.test/second.jpg', photoPathname: 'b.jpg' },
  ],
  generationPrompt: {
    finalText: 'Сцена. Ведущий говорит: «С днём рождения, Марина!»',
    moderationStatus: 'APPROVED',
  },
  ...over,
});

describe('GreetingVideoService — говорящий аватар', () => {
  it('портретом становится ПЕРВЫЙ референс-кадр, а не какой придётся', async () => {
    const { svc, hedra } = build(withPortrait());
    await svc.startVideo('s1');
    expect(hedra.submit).toHaveBeenCalledWith(
      expect.objectContaining({ startImage: 'https://blob.test/face.jpg' }),
    );
  });

  it('фото нет — отказ до денег, и Hedra не зовётся вовсе', async () => {
    // Аватару нужно лицо. Узнать об этом человек должен здесь, а не
    // после списания за генерацию.
    const { svc, hedra } = build(withPortrait({ greetingReferenceImages: [] }));
    await expect(svc.startVideo('s1')).rejects.toThrow(/лицо|фото/i);
    expect(hedra.submit).not.toHaveBeenCalled();
  });

  it('озвучка синтезируется ДО платного вызова Hedra', async () => {
    // Hedra речь не синтезирует — ей нужен готовый файл. Если голос не
    // выйдет, платить за аватар, которому нечего сказать, незачем.
    const { svc, hedra, ttsResolver } = build(withPortrait());
    const provider = await ttsResolver.resolve();
    provider.synthesize.mockResolvedValue({ ok: false, reason: 'нет ключа' });
    await expect(svc.startVideo('s1')).rejects.toThrow(/Озвучка/);
    expect(hedra.submit).not.toHaveBeenCalled();
  });

  it('говорит голосом отправителя, если клон выбран', async () => {
    const { svc, ttsResolver } = build(withPortrait());
    const provider = await ttsResolver.resolve();
    await svc.startVideo('s1');
    expect(provider.synthesize).toHaveBeenCalledWith(
      expect.objectContaining({ voiceId: 'rv1' }),
    );
  });

  it('ролик помечен «речь уже внутри» — иначе постобработка положит её второй раз', async () => {
    const { svc, updateSession } = build(withPortrait());
    await svc.startVideo('s1');
    const patch = updateSession.mock.calls[0][1] as any;
    expect(patch.generatedVideo.speechBakedIn).toBe(true);
    expect(patch.generatedVideo.provider).toBe('hedra');
    expect(patch.generatedVideo.hedraJobId).toBe('hj1');
  });

  it('тариф проверяется у ДЕНЕГ, а не только при выборе в брифе', async () => {
    // Бриф мог быть сохранён на PREMIUM давно, а тариф с тех пор
    // понизиться.
    const { svc, plans, hedra } = build(withPortrait());
    plans.assertSession.mockRejectedValue(new Error('нет тарифа'));
    await expect(svc.startVideo('s1')).rejects.toThrow('нет тарифа');
    expect(plans.assertSession).toHaveBeenCalledWith('s1', 'avatarLipsync');
    expect(hedra.submit).not.toHaveBeenCalled();
  });

  it('суточная квота исчерпана — отказ с числами, Hedra не зовётся', async () => {
    const { svc, aiUsage, hedra } = build(withPortrait());
    aiUsage.countToday.mockResolvedValue(5);
    await expect(svc.startVideo('s1')).rejects.toThrow(/5 из 5/);
    expect(hedra.submit).not.toHaveBeenCalled();
  });

  it('опрос идёт в Hedra, а не в Grok', async () => {
    // До этой ветки опрос звался безусловно грокский: у аватар-ролика
    // нет `grokRequestId`, и он висел бы «в работе» вечно.
    const { svc, hedra, getStatus } = build(
      withPortrait({
        generatedVideo: {
          generatedVideoId: 'gv1',
          pathname: 'sessions/s1/generated.mp4',
          status: GenerationStatus.PROCESSING,
          provider: 'hedra',
          hedraJobId: 'hj1',
          initiatedAt: new Date(),
        },
      }),
    );
    await svc.pollVideo('s1');
    expect(hedra.status).toHaveBeenCalledWith('hj1');
    expect(getStatus).not.toHaveBeenCalled();
  });

  it('готовая задача: фактическая цена Hedra записывается вместо оценки', async () => {
    // Оценка по длине озвучки нужна, чтобы квота и суточный потолок
    // сработали сразу. Факт приходит позже — и в отчёте о расходах
    // должен стоять он.
    const { svc, hedra, aiUsage } = build(
      withPortrait({
        generatedVideo: {
          generatedVideoId: 'gv1',
          pathname: 'sessions/s1/generated.mp4',
          status: GenerationStatus.PROCESSING,
          provider: 'hedra',
          hedraJobId: 'hj1',
          initiatedAt: new Date(),
        },
      }),
    );
    hedra.status.mockResolvedValue({
      status: 'completed',
      outputs: [{ url: 'https://hedra.test/out.mp4' }],
      costMicroUsd: 123456,
    });
    (globalThis as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(16),
    });
    await svc.pollVideo('s1');
    expect(aiUsage.record).toHaveBeenCalledWith(
      expect.objectContaining({ costMicroUsd: 123456, calls: 0 }),
    );
  });
});
