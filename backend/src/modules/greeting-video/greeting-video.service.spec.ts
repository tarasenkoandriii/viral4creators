/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { BadRequestException, ConflictException } from '@nestjs/common';
import { GreetingVideoService } from './greeting-video.service';
import { RenderAccessService } from '../render-access/render-access.service';
import { GenerationStatus } from '../../common/types/generation.types';
import { ModerationStatus } from '../../common/types/prompt.types';
import { GREETING_PROMPT_LOCK_TTL_MS } from '../greeting-prompt/script-inputs';

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
  // Кредиты у поздравления появились этапом 132 — до него оно их не
  // касалось вовсе. По умолчанию кредита нет: деньги идут прежним путём
  // через суточный потолок, как и было.
  const credits = {
    reserveForGeneration: jest.fn().mockResolvedValue(false),
    refundIfReserved: jest.fn().mockResolvedValue(undefined),
    grantWelcomeIfFirst: jest.fn().mockResolvedValue(false),
  };
  const plans = {
    assertCanSpendSession: jest.fn().mockResolvedValue(undefined),
    // Этап 132: право на рендер спрашивает потолок у ПОЛЬЗОВАТЕЛЯ —
    // раньше поздравление знало только `assertCanSpendSession`.
    assertCanSpendUser: jest.fn().mockResolvedValue(undefined),
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
  const prisma = {
    persona: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'p1',
        livenessCheckedAt: new Date(),
        revokedAt: null,
        verifyResult: { status: 'ok' },
      }),
    },
    personaLook: { findFirst: jest.fn().mockResolvedValue({ id: 'l1' }) },
    userVoice: { findFirst: jest.fn().mockResolvedValue(null) },
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
    // Этап 132: настоящий сервис права с теми же двойниками — см. тот
    // же приём в `generation.service.spec.ts`. Рубильник выключен по
    // умолчанию, поэтому прежние проверки видят прежний порядок.
    new RenderAccessService(
      { user: { findUnique: jest.fn().mockResolvedValue(null) } } as any,
      plans as any,
      credits as any,
    ),
    // Этап 134: двойник момента «ролик готов» — этот файл про рендер,
    // а не про счётчики.
    { onRenderCompleted: jest.fn().mockResolvedValue(undefined) } as any,
    credits as any,
    // CONTRACT5 п.14: повторная проверка персоны у денег — по умолчанию
    // персона проверена, образ и голос на месте.
    prisma as any,
  );
  return {
    svc,
    prisma,
    credits,
    sessions,
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

/**
 * Приёмка этапа 12: список готовности и условия `startVideo` — одно и
 * то же (§14, «Тонкая красная линия»).
 *
 * Мутация в обе стороны. Убрать `if (!done('scriptClean'))` — краснеет
 * отказ по модерации: выше стоит только `!session.generationPrompt`, а
 * сценарий с флагом — это существующий промпт, он проходит насквозь и
 * уезжает в рендер, ровно как до находки №2. Убрать пункт
 * `scriptClean` из `greetingReadiness` — краснеет счастливый путь:
 * сервис ищет пункт по ключу и не находит своего.
 *
 * Про `script` тест написать нельзя, и это честнее сказать: пункт
 * считается как `hasPrompt`, а рядом стоит `!session.generationPrompt`
 * ради сужения типа для компилятора. Это одно условие в одной точке.
 */
describe('GreetingVideoService.startVideo — условия читаются готовностью', () => {
  it('сценарий без промпта — отказ по-русски с кодом, до Grok', async () => {
    const { svc, startGeneration } = build({ generationPrompt: null });
    const err = await svc.startVideo('s1').catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toEqual(
      expect.objectContaining({ code: 'GREETING_SCRIPT_MISSING' }),
    );
    expect(err.message).toMatch(/Сценария ещё нет/);
    expect(err.message).not.toMatch(/POST|greeting-prompt/);
    expect(startGeneration).not.toHaveBeenCalled();
  });

  it('сценарий помечен модерацией — отказ прежним текстом, до Grok', async () => {
    const { svc, startGeneration } = build({
      generationPrompt: {
        finalText: 'сцена',
        // Через enum, а не строкой: значения там строчные
        // (`flagged`), и тест, написанный на глаз заглавными, прошёл
        // бы мимо барьера и остался бы зелёным при любой мутации.
        moderationStatus: ModerationStatus.FLAGGED,
        moderationFlags: ['threat'],
      },
    });
    await expect(svc.startVideo('s1')).rejects.toThrow(
      'Текст сценария не прошёл автоматическую проверку контента',
    );
    expect(startGeneration).not.toHaveBeenCalled();
  });

  it('готовая сессия проходит барьер', async () => {
    const { svc, startGeneration } = build();
    await svc.startVideo('s1');
    expect(startGeneration).toHaveBeenCalled();
  });
});

/**
 * Стена бесплатного в поздравлении — этап 132.
 *
 * До этого этапа поздравление было единственным стартом рендера,
 * который не касался кредитов вовсе: упёршись в стену на товарке,
 * человек уходил сюда и рендерил сколько угодно. Эти три проверки — про
 * то, что дверь рядом со стеной закрыта.
 */
describe('GreetingVideoService.startVideo — стена (этап 132)', () => {
  const KEY = 'FREE_TIER_WALL_ENABLED';
  const before = process.env[KEY];
  beforeEach(() => {
    process.env[KEY] = 'true';
  });
  afterEach(() => {
    if (before === undefined) delete process.env[KEY];
    else process.env[KEY] = before;
  });

  it('нет права и нет кредитов — 403 и ни одного вызова Grok', async () => {
    const { svc, startGeneration } = build();
    await expect(svc.startVideo('s1')).rejects.toMatchObject({ status: 403 });
    expect(startGeneration).not.toHaveBeenCalled();
  });

  it('есть кредит — рендер идёт', async () => {
    const { svc, credits, startGeneration } = build();
    credits.reserveForGeneration.mockResolvedValue(true);
    await svc.startVideo('s1');
    expect(startGeneration).toHaveBeenCalled();
  });

  it('кредит списывается тем же ключом, которым помечен ролик', async () => {
    // Иначе возврат при неудаче не найдёт, что возвращать: ключ
    // идемпотентности — один и тот же для кредита и для попытки рендера.
    const { svc, credits } = build();
    credits.reserveForGeneration.mockResolvedValue(true);
    const video = await svc.startVideo('s1');
    expect(credits.reserveForGeneration).toHaveBeenCalledWith(
      'u1',
      video.generatedVideoId,
    );
  });
});

/**
 * Кредит не теряется между списанием и стартом — находка аудита
 * этапа 132.
 *
 * До этой правки списание стояло ПЕРЕД замком `claimWork` и перед
 * всеми проверками двух веток старта. Значит терялся кредит в двух
 * случаях сразу: когда старт бросал (тарифный гейт, отсутствие ключа,
 * отказ провайдера) и когда два быстрых клика резервировали по кредиту,
 * а замок доставался одному.
 */
describe('GreetingVideoService.startVideo — кредит при сбое старта', () => {
  const KEY = 'FREE_TIER_WALL_ENABLED';
  const before = process.env[KEY];
  afterEach(() => {
    if (before === undefined) delete process.env[KEY];
    else process.env[KEY] = before;
  });

  it('провайдер отказал — кредит возвращён тем же ключом', async () => {
    const { svc, credits, startGeneration } = build();
    credits.reserveForGeneration.mockResolvedValue(true);
    startGeneration.mockRejectedValue(new Error('xAI недоступен'));
    await expect(svc.startVideo('s1')).rejects.toThrow('xAI недоступен');
    const attemptId = credits.reserveForGeneration.mock.calls[0][1];
    expect(credits.refundIfReserved).toHaveBeenCalledWith(attemptId);
  });

  it('замок занят (второй клик) — кредит возвращён, а не сгорел', async () => {
    // Замок стоит ВНУТРИ старта, то есть уже после списания: без
    // возврата второй клик стоил бы человеку генерации за 409.
    const { svc, credits, sessions } = build();
    credits.reserveForGeneration.mockResolvedValue(true);
    // Занят именно замок рендера: замок правки ('prompt') свободен.
    sessions.claimWork.mockImplementation((_id: string, kind: string) =>
      Promise.resolve(kind !== 'generate'),
    );
    const err = await svc.startVideo('s1').catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toEqual(
      expect.objectContaining({ code: 'GREETING_RENDER_IN_PROGRESS' }),
    );
    expect(credits.refundIfReserved).toHaveBeenCalled();
  });

  it('успешный старт кредит не возвращает', async () => {
    const { svc, credits } = build();
    credits.reserveForGeneration.mockResolvedValue(true);
    await svc.startVideo('s1');
    expect(credits.refundIfReserved).not.toHaveBeenCalled();
  });
});

/**
 * Этап B (§3.1 ТЗ docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md):
 * набор правил проверяется ещё раз перед рендером — «у денег». Снимок
 * мог быть собран до того, как правило вступило в силу.
 */
describe('проверка правил перед рендером (этап B)', () => {
  it('траурный «особый повод» с шутливым тоном — отказ, провайдера не зовут', async () => {
    const { svc, startGeneration } = build({
      greetingBriefSnapshot: {
        ...BRIEF,
        occasion: 'OTHER',
        customOccasionText: 'похороны бабушки',
        occasionRegister: 'MOURNING',
        tone: 'FUNNY',
      },
    });
    await expect(svc.startVideo('s1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(startGeneration).not.toHaveBeenCalled();
  });

  it('наклейка на соболезновании, записанная до этапа B, тоже не пройдёт', async () => {
    const { svc, startGeneration } = build({
      greetingBriefSnapshot: {
        ...BRIEF,
        occasion: 'CONDOLENCE',
        tone: 'RESPECTFUL',
        sticker: {
          id: 'st',
          url: 'u',
          pathname: 'p',
          sourceUrl: 's',
          source: 'pixabay',
          placement: 'top',
        },
      },
    });
    await expect(svc.startVideo('s1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(startGeneration).not.toHaveBeenCalled();
  });

  it('праздничный бриф проходит, как и раньше', async () => {
    const { svc, startGeneration } = build();
    await svc.startVideo('s1');
    expect(startGeneration).toHaveBeenCalled();
  });
});

describe('этап G — ведущий-образ и лица в референсах (§4.8, Г-7, Г-8)', () => {
  const PRESENTER = {
    lookId: 'l1',
    label: 'Деловой',
    url: 'https://blob.test/look.png',
    pathname: 'users/u1/personas/p1/looks/l1.png',
    variant: 'photo',
  };
  const ref = (over: Record<string, unknown> = {}) => ({
    id: 'r1',
    label: 'дача',
    description: null,
    photoUrl: 'https://blob.test/dacha.jpg',
    photoPathname: 'sessions/s1/greeting-refs/r1/photo.jpg',
    createdAt: '2026-09-30T00:00:00.000Z',
    // Проверено, лица нет — иначе fail-closed (CONTRACT5 п.4) блокирует.
    hasFace: false,
    ...over,
  });
  const OLD_FLAG = process.env.PERSONA_ENABLED;
  beforeEach(() => {
    process.env.PERSONA_ENABLED = 'true';
  });
  afterAll(() => {
    process.env.PERSONA_ENABLED = OLD_FLAG;
  });

  it('Grok: образ — первый референс, затем свои фото, затем сцены бренда', async () => {
    const { svc, startGeneration } = build({
      greetingBriefSnapshot: { ...BRIEF, presenter: PRESENTER },
      greetingReferenceImages: [ref()],
      brandManifestSnapshot: {
        voiceMode: 'voiceover',
        scenes: [
          {
            sourceSceneId: 's1',
            label: 'Офис',
            photoUrl:
              'https://blob.test/brand-manifests/m/scenes/s1/checked-ab12.jpg',
            description: null,
          },
        ],
      },
    });
    await svc.startVideo('s1');
    expect(startGeneration.mock.calls[0][0].referenceImageUrls).toEqual([
      'https://blob.test/look.png',
      'https://blob.test/dacha.jpg',
      'https://blob.test/brand-manifests/m/scenes/s1/checked-ab12.jpg',
    ]);
  });

  it('Grok: фото с лицом без согласия — отказ до денег, Grok не зовётся', async () => {
    const { svc, startGeneration, credits } = build({
      greetingReferenceImages: [ref({ label: 'соседка', hasFace: true })],
    });
    await expect(svc.startVideo('s1')).rejects.toThrow(/«соседка»/);
    expect(startGeneration).not.toHaveBeenCalled();
    expect(credits.reserveForGeneration).not.toHaveBeenCalled();
  });

  it('Grok: с согласием или скетчем фото уходит в модель', async () => {
    const { svc, startGeneration } = build({
      greetingReferenceImages: [
        ref({ hasFace: true, faceConsentAt: '2026-09-30T00:00:00.000Z' }),
      ],
    });
    await svc.startVideo('s1');
    expect(startGeneration.mock.calls[0][0].referenceImageUrls).toEqual([
      'https://blob.test/dacha.jpg',
    ]);
  });

  it('ведущий-образ при выключенном режиме — отказ до денег', async () => {
    process.env.PERSONA_ENABLED = 'false';
    const { svc, startGeneration } = build({
      greetingBriefSnapshot: { ...BRIEF, presenter: PRESENTER },
    });
    await expect(svc.startVideo('s1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(startGeneration).not.toHaveBeenCalled();
  });

  it('Hedra: портрет — выбранный образ, а не первое фото (Г-7)', async () => {
    const { svc, hedra } = build(
      withPortrait({
        greetingBriefSnapshot: {
          ...BRIEF,
          requestedPresenterProvider: 'hedra',
          resolvedPresenterProvider: 'hedra',
          presenter: PRESENTER,
        },
      }),
    );
    await svc.startVideo('s1');
    expect(hedra.submit).toHaveBeenCalledWith(
      expect.objectContaining({ startImage: 'https://blob.test/look.png' }),
    );
  });

  it('Hedra: скетч-ведущий — отказ, Hedra не зовётся', async () => {
    const { svc, hedra } = build(
      withPortrait({
        greetingBriefSnapshot: {
          ...BRIEF,
          requestedPresenterProvider: 'hedra',
          resolvedPresenterProvider: 'hedra',
          presenter: { ...PRESENTER, variant: 'sketch' },
        },
      }),
    );
    await expect(svc.startVideo('s1')).rejects.toThrow(/Hedra/);
    expect(hedra.submit).not.toHaveBeenCalled();
  });

  it('Hedra без образа: чужое лицо без согласия портретом не станет', async () => {
    const { svc, hedra } = build(
      withPortrait({
        greetingReferenceImages: [
          ref({ photoUrl: 'https://blob.test/face.jpg', hasFace: true }),
        ],
      }),
    );
    await expect(svc.startVideo('s1')).rejects.toThrow(/лицо|фото/i);
    expect(hedra.submit).not.toHaveBeenCalled();
  });
});

describe('CONTRACT5 п.14 — персона проверяется заново у денег', () => {
  const OLD_FLAG = process.env.PERSONA_ENABLED;
  beforeEach(() => {
    process.env.PERSONA_ENABLED = 'true';
  });
  afterAll(() => {
    process.env.PERSONA_ENABLED = OLD_FLAG;
  });
  it('образ удалён после выбора — отказ до кредита, Grok не зовётся', async () => {
    const { svc, prisma, startGeneration, credits } = build({
      greetingBriefSnapshot: {
        ...BRIEF,
        presenter: {
          lookId: 'l1',
          label: 'Я',
          url: 'https://blob.test/look.png',
          pathname: 'x',
          variant: 'photo',
        },
      },
    });
    prisma.personaLook.findFirst.mockResolvedValue(null);
    await expect(svc.startVideo('s1')).rejects.toThrow(/Образ ведущего/);
    expect(startGeneration).not.toHaveBeenCalled();
    expect(credits.reserveForGeneration).not.toHaveBeenCalled();
  });
});

/**
 * CONTRACT6 (сквозной аудит Greeting, G-B1): гонки старта, устаревший
 * сценарий, потолок тарифа, повтор без затирания, коды отказов.
 */
describe('CONTRACT6 — старт рендера поздравления', () => {
  const HEDRA_BRIEF = {
    ...BRIEF,
    requestedPresenterProvider: 'hedra',
    resolvedPresenterProvider: 'hedra',
  };
  const PHOTO = {
    id: 'img1',
    label: 'Мама',
    description: null,
    photoUrl: 'https://blob.test/sessions/s1/ref-1.jpg',
    photoPathname: 'sessions/s1/ref-1.jpg',
    hasFace: false,
  };
  const codeOf = (e: any) => e?.getResponse?.()?.code;

  it('замок правки занят — 409 с кодом, до права на рендер и провайдера', async () => {
    const { svc, sessions, credits, startGeneration } = build();
    sessions.claimWork.mockImplementation((_id: string, kind: string) =>
      Promise.resolve(kind !== 'prompt'),
    );
    const err = await svc.startVideo('s1').catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(codeOf(err)).toBe('GREETING_EDIT_IN_PROGRESS');
    expect(credits.reserveForGeneration).not.toHaveBeenCalled();
    expect(startGeneration).not.toHaveBeenCalled();
  });

  it('старт держит замок правки и снимает его в конце, решения — по перечитанной сессии', async () => {
    const { svc, sessions, startGeneration } = build();
    // Первое чтение — до замка, второе — под ним: сценарий успели стереть.
    sessions.getSession
      .mockResolvedValueOnce({
        sessionId: 's1',
        userId: 'u1',
        greetingBriefSnapshot: BRIEF,
        generationPrompt: { finalText: 'сцена', moderationStatus: 'APPROVED' },
        greetingReferenceImages: [],
      })
      .mockResolvedValueOnce({
        sessionId: 's1',
        userId: 'u1',
        greetingBriefSnapshot: BRIEF,
        generationPrompt: null,
        greetingReferenceImages: [],
      });
    const err = await svc.startVideo('s1').catch((e) => e);
    expect(codeOf(err)).toBe('GREETING_SCRIPT_MISSING');
    expect(startGeneration).not.toHaveBeenCalled();
    expect(sessions.claimWork).toHaveBeenCalledWith(
      's1',
      'prompt',
      expect.any(Number),
    );
    expect(sessions.releaseWork).toHaveBeenCalledWith('s1', 'prompt');
  });

  it('успешный старт тоже снимает замок правки', async () => {
    const { svc, sessions } = build();
    await svc.startVideo('s1');
    expect(sessions.releaseWork).toHaveBeenCalledWith('s1', 'prompt');
  });

  it('идущий рендер возвращается без замков и без права на рендер', async () => {
    const running = {
      generatedVideoId: 'v0',
      status: GenerationStatus.PROCESSING,
    };
    const { svc, sessions, credits } = build({ generatedVideo: running });
    await expect(svc.startVideo('s1')).resolves.toBe(running);
    expect(sessions.claimWork).not.toHaveBeenCalled();
    expect(credits.reserveForGeneration).not.toHaveBeenCalled();
  });

  for (const provider of ['grok', 'hedra'] as const) {
    it(`${provider}: ролик появился между чтением и замком рендера — 409, замок снят, кредит возвращён`, async () => {
      const brief = provider === 'hedra' ? HEDRA_BRIEF : BRIEF;
      const base = {
        sessionId: 's1',
        userId: 'u1',
        greetingBriefSnapshot: brief,
        generationPrompt: {
          finalText: 'сцена "Привет"',
          moderationStatus: 'APPROVED',
        },
        greetingReferenceImages: [PHOTO],
      };
      const { svc, sessions, credits, startGeneration, hedra } = build();
      credits.reserveForGeneration.mockResolvedValue(true);
      sessions.getSession
        .mockResolvedValueOnce(base)
        .mockResolvedValueOnce(base)
        .mockResolvedValueOnce({
          ...base,
          generatedVideo: {
            generatedVideoId: 'v9',
            status: GenerationStatus.PENDING,
          },
        });
      const err = await svc.startVideo('s1').catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(codeOf(err)).toBe('GREETING_RENDER_IN_PROGRESS');
      expect(sessions.releaseWork).toHaveBeenCalledWith('s1', 'generate');
      expect(credits.refundIfReserved).toHaveBeenCalled();
      expect(startGeneration).not.toHaveBeenCalled();
      expect(hedra.submit).not.toHaveBeenCalled();
    });
  }

  it('hedra: замок рендера снимается и после успешной записи PROCESSING', async () => {
    const { svc, sessions, updateSession } = build({
      greetingBriefSnapshot: HEDRA_BRIEF,
      generationPrompt: {
        finalText: 'сцена "Привет"',
        moderationStatus: 'APPROVED',
      },
      greetingReferenceImages: [PHOTO],
    });
    const v = await svc.startVideo('s1');
    expect(v.status).toBe(GenerationStatus.PROCESSING);
    const writeOrder = updateSession.mock.invocationCallOrder[0];
    const release = sessions.releaseWork.mock.calls.findIndex(
      (c: unknown[]) => c[1] === 'generate',
    );
    expect(release).toBeGreaterThanOrEqual(0);
    expect(
      sessions.releaseWork.mock.invocationCallOrder[release],
    ).toBeGreaterThan(writeOrder);
  });

  it('BYPASSED (обход через общий approve) — отказ как у флага', async () => {
    const { svc, startGeneration } = build({
      generationPrompt: {
        finalText: 'сцена',
        moderationStatus: ModerationStatus.BYPASSED,
      },
    });
    const err = await svc.startVideo('s1').catch((e) => e);
    expect(codeOf(err)).toBe('GREETING_SCRIPT_FLAGGED');
    expect(startGeneration).not.toHaveBeenCalled();
  });

  it('готовый ролик не перерендеривается на месте — 409 с кодом, до денег', async () => {
    const { svc, credits, startGeneration } = build({
      generatedVideo: {
        generatedVideoId: 'v0',
        status: GenerationStatus.COMPLETE,
      },
    });
    const err = await svc.startVideo('s1').catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(codeOf(err)).toBe('GREETING_VIDEO_ALREADY_READY');
    expect(credits.reserveForGeneration).not.toHaveBeenCalled();
    expect(startGeneration).not.toHaveBeenCalled();
  });

  it('повтор после сбоя: свой файл попытки, упавшая попытка — в истории', async () => {
    const failed = {
      generatedVideoId: 'old',
      pathname: 'sessions/s1/generated-old.mp4',
      status: GenerationStatus.FAILED,
    };
    const { svc, updateSession } = build({ generatedVideo: failed });
    const v = await svc.startVideo('s1');
    expect(v.pathname).toBe(`sessions/s1/generated-${v.generatedVideoId}.mp4`);
    expect(v.pathname).not.toBe(failed.pathname);
    const patch = updateSession.mock.calls[0][1];
    expect(patch.videoHistory).toEqual([failed]);
  });

  it('hedra: озвучка аватара тоже в файле попытки', async () => {
    const { svc, uploadBuffer } = build({
      greetingBriefSnapshot: HEDRA_BRIEF,
      generationPrompt: {
        finalText: 'сцена "Привет"',
        moderationStatus: 'APPROVED',
      },
      greetingReferenceImages: [PHOTO],
    });
    const v = await svc.startVideo('s1');
    expect(uploadBuffer).toHaveBeenCalledWith(
      `sessions/s1/avatar-speech-${v.generatedVideoId}.mp3`,
      expect.anything(),
      expect.anything(),
    );
    expect(v.voiceoverPathname).toBe(
      `sessions/s1/avatar-speech-${v.generatedVideoId}.mp3`,
    );
  });

  it.each([
    ['STANDARD', '1080p', '720p'],
    ['LITE', '1080p', '480p'],
    ['LITE', '720p', '480p'],
    ['PREMIUM', '1080p', '1080p'],
    ['STANDARD', '480p', '480p'],
  ])(
    'потолок тарифа у денег: %s, бриф %s → %s',
    async (plan, briefRes, expected) => {
      const { svc, plans, startGeneration } = build({
        greetingBriefSnapshot: { ...BRIEF, resolvedResolution: briefRes },
      });
      plans.planOfSession.mockResolvedValue(plan);
      const v = await svc.startVideo('s1');
      expect(startGeneration).toHaveBeenCalledWith(
        expect.objectContaining({ resolution: expected }),
      );
      expect(v.resolution).toBe(expected);
    },
  );

  it('нет брифа — код и русский текст', async () => {
    const { svc } = build({ greetingBriefSnapshot: null });
    const err = await svc.startVideo('s1').catch((e) => e);
    expect(codeOf(err)).toBe('GREETING_NOT_GREETING_SESSION');
    expect(err.message).toMatch(/поздравлен/);
  });
});

describe('CONTRACT6 п.4 — устаревший сценарий', () => {
  it('фото сменились после сборки — 409 с кодом до права на рендер', async () => {
    const { greetingScriptInputs } = jest.requireActual(
      '../greeting-prompt/script-inputs',
    );
    const stampedFor = greetingScriptInputs({
      greetingBriefSnapshot: BRIEF,
      greetingReferenceImages: [],
    });
    const { svc, credits, startGeneration } = build({
      generationPrompt: {
        finalText: 'сцена',
        moderationStatus: 'APPROVED',
        greetingScriptInputs: stampedFor,
      },
      greetingReferenceImages: [
        {
          id: 'new',
          label: 'торт',
          description: null,
          photoUrl: 'https://blob.test/sessions/s1/new.jpg',
          photoPathname: 'sessions/s1/new.jpg',
          hasFace: false,
        },
      ],
    });
    const err = await svc.startVideo('s1').catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse().code).toBe('GREETING_SCRIPT_STALE');
    expect(credits.reserveForGeneration).not.toHaveBeenCalled();
    expect(startGeneration).not.toHaveBeenCalled();
  });

  it('входы те же — рендер идёт', async () => {
    const { greetingScriptInputs } = jest.requireActual(
      '../greeting-prompt/script-inputs',
    );
    const { svc, startGeneration } = build({
      generationPrompt: {
        finalText: 'сцена',
        moderationStatus: 'APPROVED',
        greetingScriptInputs: greetingScriptInputs({
          greetingBriefSnapshot: BRIEF,
          greetingReferenceImages: [],
        }),
      },
    });
    await svc.startVideo('s1');
    expect(startGeneration).toHaveBeenCalled();
  });
});

describe('CONTRACT6 — аудит: замки старта', () => {
  it('hedra: сбой перечитывания под замком рендера снимает замок', async () => {
    const base = {
      sessionId: 's1',
      userId: 'u1',
      greetingBriefSnapshot: {
        ...BRIEF,
        requestedPresenterProvider: 'hedra',
        resolvedPresenterProvider: 'hedra',
      },
      generationPrompt: {
        finalText: 'сцена "Привет"',
        moderationStatus: 'APPROVED',
      },
      greetingReferenceImages: [
        {
          id: 'img1',
          label: 'Мама',
          description: null,
          photoUrl: 'https://blob.test/sessions/s1/ref-1.jpg',
          photoPathname: 'sessions/s1/ref-1.jpg',
          hasFace: false,
        },
      ],
    };
    const { svc, sessions } = build();
    sessions.getSession
      .mockResolvedValueOnce(base)
      .mockResolvedValueOnce(base)
      .mockRejectedValueOnce(new Error('база недоступна'));
    await expect(svc.startVideo('s1')).rejects.toThrow('база недоступна');
    expect(sessions.releaseWork).toHaveBeenCalledWith('s1', 'generate');
  });

  it('замок правки старт берёт с общим сроком', async () => {
    const { svc, sessions } = build();
    await svc.startVideo('s1');
    const call = sessions.claimWork.mock.calls.find(
      (c: unknown[]) => c[1] === 'prompt',
    );
    expect(call?.[2]).toBe(GREETING_PROMPT_LOCK_TTL_MS);
  });
});
