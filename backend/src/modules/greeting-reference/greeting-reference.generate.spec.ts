/* eslint-disable @typescript-eslint/no-explicit-any -- тестовые дублёры */
// `SessionService` тянет за собой сгенерированный клиент Prisma,
// которого в песочнице/CI нет, — тот же приём, что в
// `client-site-tutorial.service.spec.ts` по соседству.
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('@prisma/client', () => ({
  Prisma: { DbNull: Symbol.for('Prisma.DbNull') },
}));

import { BadRequestException } from '@nestjs/common';
import { GreetingReferenceService } from './greeting-reference.service';
import type { SessionService } from '../../common/session.service';
import type { BlobService } from '../storage/blob.service';
import type { SketchGeneratorService } from '../image-sketch/sketch-generator.service';
import type { AiUsageService } from '../ai-usage/ai-usage.service';
import type { PlanService } from '../plan/plan.service';
import { fakeSnapshotDb } from '../../../test/fake-greeting-snapshot-db';
import {
  MAX_SCENE_SETTING_OPTIONS,
  rememberSceneSettingOptions,
} from './greeting-reference.service';
import { composeEditedPrompt } from '../greeting-session-edit/greeting-session-edit.service';
import {
  greetingScriptInputs,
  greetingScriptStale,
} from '../greeting-prompt/script-inputs';
import { ModerationStatus } from '../../common/types/prompt.types';
import { GEMINI_THINKING_HEADROOM } from '../../common/gemini-output';

/**
 * `generateFrame` (фича №6) — проверяется не «картинка нарисовалась», а
 * ПОРЯДОК: что именно происходит до платного вызова модели и чего не
 * происходит после отказа. Ровно здесь живут ошибки, которые стоят
 * денег и которые не видит ни один тип.
 */
function setup(
  opts: {
    brief?: unknown;
    images?: unknown[];
    outcome?: unknown;
    session?: Record<string, unknown>;
    beforeWrite?: (session: any) => void;
  } = {},
) {
  const session = {
    sessionId: 's1',
    greetingBriefSnapshot:
      opts.brief === undefined
        ? {
            occasion: 'BIRTHDAY',
            customOccasionText: null,
            tone: 'WARM',
            resolvedPresenterProvider: 'grok',
          }
        : opts.brief,
    greetingReferenceImages: opts.images ?? [],
    ...opts.session,
  };
  const sessions = {
    getSession: jest.fn(async () => session),
    updateSession: jest.fn(async (_id: string, patch: any) => {
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete (session as any)[k];
        else (session as any)[k] = v;
      }
      return session;
    }),
    // Выбор обстановки пишется под замком 'prompt' с перештамповкой.
    claimWork: jest.fn().mockResolvedValue(true),
    releaseWork: jest.fn().mockResolvedValue(undefined),
  } as unknown as SessionService;
  const blob = {
    uploadBuffer: jest
      .fn()
      .mockResolvedValue({ url: 'https://blob.example/frame.png' }),
    deleteBlob: jest.fn().mockResolvedValue(true),
  } as unknown as BlobService;
  const frames = {
    generate: jest.fn().mockResolvedValue(
      opts.outcome ?? {
        status: 'ok',
        bytes: Buffer.from('png'),
        mimeType: 'image/png',
        model: 'gemini-test',
        raw: {},
      },
    ),
  } as unknown as SketchGeneratorService;
  const aiUsage = {
    recordGemini: jest.fn().mockResolvedValue(undefined),
  } as unknown as AiUsageService;

  const plans = {
    assertCanSpendSession: jest.fn().mockResolvedValue(undefined),
  } as unknown as PlanService;

  const snapshotDb = fakeSnapshotDb(sessions as any, {
    beforeWrite: () => opts.beforeWrite?.(session),
  });
  const service = new GreetingReferenceService(
    sessions,
    blob,
    frames,
    aiUsage,
    plans,
    snapshotDb as any,
  );
  return { service, sessions, blob, frames, aiUsage, plans, session };
}

describe('generateFrame (№6)', () => {
  it('рисует кадр и кладёт его в тот же список, что и загруженные', async () => {
    const { service, sessions, blob } = setup({
      images: [{ id: 'gr_old', photoUrl: 'https://blob/old.jpg' }],
    });

    const list = await service.generateFrame('s1', 'u1');

    expect(blob.uploadBuffer).toHaveBeenCalled();
    expect(list).toHaveLength(2);
    expect(
      (sessions.updateSession as jest.Mock).mock.calls[0][1],
    ).toHaveProperty('greetingReferenceImages');
  });

  it('просьба про образ знаменитости отклоняется ДО платного вызова (№35)', async () => {
    // Главная проверка файла: отказ обязан случиться раньше денег.
    const { service, frames } = setup({
      brief: {
        occasion: 'OTHER',
        customOccasionText: 'юбилей в образе Пугачёвой',
        tone: 'WARM',
        resolvedPresenterProvider: 'grok',
      },
    });

    await expect(service.generateFrame('s1', 'u1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(frames.generate).not.toHaveBeenCalled();
  });

  it('сессия без брифа — понятный отказ, а не падение ниже', async () => {
    const { service, frames } = setup({ brief: null });
    await expect(service.generateFrame('s1', null)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(frames.generate).not.toHaveBeenCalled();
  });

  it('семь кадров — потолок Grok: восьмой не рисуется, а не «рисуется и теряется»', async () => {
    const { service, frames } = setup({
      images: Array.from({ length: 7 }, (_, i) => ({ id: `gr_${i}` })),
    });
    await expect(service.generateFrame('s1', 'u1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(frames.generate).not.toHaveBeenCalled();
  });

  it('модель не ответила — расход НЕ пишется: вызов не оплачен', async () => {
    const { service, aiUsage, sessions } = setup({
      outcome: { status: 'failed', reason: 'timeout', model: 'gemini-test' },
    });
    await expect(service.generateFrame('s1', 'u1')).rejects.toThrow();
    expect(aiUsage.recordGemini).not.toHaveBeenCalled();
    expect(sessions.updateSession).not.toHaveBeenCalled();
  });

  it('модель отказалась рисовать — расход ПИШЕТСЯ: вызов оплачен', async () => {
    // Разница с предыдущим тестом — это и есть причина, по которой
    // `SketchGeneratorService` различает три исхода, а не два.
    const { service, aiUsage, sessions } = setup({
      outcome: {
        status: 'refused',
        reason: 'safety',
        model: 'gemini-test',
        raw: {},
      },
    });
    await expect(service.generateFrame('s1', 'u1')).rejects.toThrow();
    expect(aiUsage.recordGemini).toHaveBeenCalled();
    expect(sessions.updateSession).not.toHaveBeenCalled();
  });

  it('анонимная сессия рисует кадр — тариф тут ни при чём', async () => {
    // GREETING_VIDEO доступен на каждом тарифе, и у этого контроллера
    // предъявитель — сам UUID сессии. `userId` нужен только для отчёта.
    const { service, aiUsage } = setup();
    await service.generateFrame('s1', null);
    expect(
      (aiUsage.recordGemini as jest.Mock).mock.calls[0][1],
    ).not.toHaveProperty('userId');
  });
});

describe('generateFrame — лицо вымышленное (CONTRACT5 п.4)', () => {
  it('кадр нашей модели помечен «лица нет» и не требует согласия', async () => {
    const OLD = process.env.PERSONA_ENABLED;
    process.env.PERSONA_ENABLED = 'true';
    try {
      const { service, sessions } = setup();
      const list = await service.generateFrame('s1', 'u1');
      const saved = (sessions.updateSession as jest.Mock).mock.calls[0][1]
        .greetingReferenceImages;
      expect(saved[0].hasFace).toBe(false);
      expect(list[0].needsFaceConsent).toBe(false);
    } finally {
      process.env.PERSONA_ENABLED = OLD;
    }
  });
});

describe('§3.9 — выбранная обстановка ролика (sceneSetting)', () => {
  const SNOW = 'snowy wooden balcony at dusk, warm string lights';
  const BALLOONS = 'bright room full of balloons and confetti';
  const CALM = 'quiet garden with white flowers';
  const NOW = Date.parse('2026-10-07T12:00:00.000Z');
  const issued = (text: string, at = NOW) => ({
    text,
    issuedAt: new Date(at).toISOString(),
  });
  const birthday = (over: Record<string, unknown> = {}) => ({
    occasion: 'BIRTHDAY',
    customOccasionText: null,
    tone: 'WARM',
    resolvedPresenterProvider: 'grok',
    recipientName: 'Марина',
    sceneSettingOptions: [issued(SNOW), issued(BALLOONS), issued(CALM)],
    ...over,
  });
  const mourning = (over: Record<string, unknown> = {}) =>
    birthday({ occasion: 'CONDOLENCE', tone: 'RESPECTFUL', ...over });
  const promptOf = (frames: SketchGeneratorService) =>
    (frames.generate as jest.Mock).mock.calls[0][0].prompt as string;
  const at = (svc: GreetingReferenceService, now = NOW) => {
    jest.spyOn(svc, 'now').mockReturnValue(now);
    return svc;
  };

  it('кадр по выданной обстановке: она в промпте кадра, в подписи кадра и в снимке', async () => {
    const { service, frames, session } = setup({ brief: birthday() });
    const list = await at(service).generateFrame('s1', 'u1', `  ${SNOW}  `);
    expect(promptOf(frames)).toContain(`Scene: ${SNOW}.`);
    expect(list[0].description).toBe(SNOW);
    expect((session.greetingBriefSnapshot as any).sceneSetting).toBe(SNOW);
    expect(session.greetingReferenceImages).toHaveLength(1);
  });

  it('белый список: невыданная обстановка — 400 с кодом до платного вызова, ничего не пишется', async () => {
    const { service, frames, sessions } = setup({ brief: birthday() });
    for (const call of [
      () => at(service).generateFrame('s1', 'u1', 'my own free text room'),
      () => at(service).setSceneSetting('s1', 'my own free text room'),
    ]) {
      const err = await call().catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse().code).toBe('GREETING_SCENE_SETTING_NOT_OFFERED');
    }
    expect(frames.generate).not.toHaveBeenCalled();
    expect(sessions.updateSession).not.toHaveBeenCalled();
  });

  it('белый список: выданный вариант истекает через сутки', async () => {
    const { service } = setup({ brief: birthday() });
    const day = 24 * 60 * 60 * 1000;
    await expect(
      at(service, NOW + day - 1).setSceneSetting('s1', SNOW),
    ).resolves.toEqual({ sceneSetting: SNOW });
    const { service: late } = setup({ brief: birthday() });
    const err = await at(late, NOW + day)
      .setSceneSetting('s1', SNOW)
      .catch((e) => e);
    expect(err.getResponse().code).toBe('GREETING_SCENE_SETTING_NOT_OFFERED');
  });

  it('гомоглиф и невидимые символы не делают невыданный текст выданным — и не ломают выданный', async () => {
    const { service } = setup({ brief: birthday() });
    // Тот же вариант с zero-width и полноширинными пробелами — совпадает.
    await expect(
      at(service).setSceneSetting(
        's1',
        `snowy\u200B wooden balcony at dusk,\u3000warm string lights`,
      ),
    ).resolves.toEqual({ sceneSetting: SNOW });
    // Кириллическая «о» — другой текст, не выдавался.
    const err = await at(service)
      .setSceneSetting('s1', 'snоwy wooden balcony at dusk, warm string lights')
      .catch((e) => e);
    expect(err.getResponse().code).toBe('GREETING_SCENE_SETTING_NOT_OFFERED');
  });

  it('без явной обстановки кадр рисуется по уже выбранной, снимок не переписывается', async () => {
    const { service, frames, sessions } = setup({
      brief: birthday({ sceneSetting: SNOW, sceneSettingOptions: [] }),
    });
    await at(service).generateFrame('s1', 'u1');
    expect(promptOf(frames)).toContain(`Scene: ${SNOW}.`);
    const patch = (sessions.updateSession as jest.Mock).mock.calls[0][1];
    expect(patch).not.toHaveProperty('greetingBriefSnapshot');
  });

  it('траур + праздничная обстановка (даже выданная до смены повода) — 400 до платного вызова', async () => {
    const { service, frames, sessions } = setup({ brief: mourning() });
    await expect(
      at(service).generateFrame('s1', 'u1', BALLOONS),
    ).rejects.toThrow(/праздничной атрибутикой/);
    await expect(at(service).setSceneSetting('s1', BALLOONS)).rejects.toThrow(
      /праздничной атрибутикой/,
    );
    expect(frames.generate).not.toHaveBeenCalled();
    expect(sessions.updateSession).not.toHaveBeenCalled();
  });

  it('выбор без кадра — бесплатно, под замком prompt; null возвращает сцену повода', async () => {
    const { service, frames, session, sessions } = setup({ brief: birthday() });
    await expect(at(service).setSceneSetting('s1', SNOW)).resolves.toEqual({
      sceneSetting: SNOW,
    });
    expect((session.greetingBriefSnapshot as any).sceneSetting).toBe(SNOW);
    expect(sessions.claimWork).toHaveBeenCalledWith(
      's1',
      'prompt',
      expect.any(Number),
    );
    expect(sessions.releaseWork).toHaveBeenCalledWith('s1', 'prompt');
    await expect(service.getSceneSetting('s1')).resolves.toEqual({
      sceneSetting: SNOW,
    });
    await expect(at(service).setSceneSetting('s1', '   ')).resolves.toEqual({
      sceneSetting: null,
    });
    expect((session.greetingBriefSnapshot as any).sceneSetting).toBeNull();
    expect(frames.generate).not.toHaveBeenCalled();
  });

  it('смена обстановки после сборки сценария перештамповывает его — правка текста человека остаётся', async () => {
    const brief = birthday();
    const base: any = {
      sessionId: 's1',
      greetingBriefSnapshot: brief,
      greetingReferenceImages: [],
    };
    const prompt = composeEditedPrompt(
      null,
      brief as any,
      'Марина, ты лучшая!',
      [],
      'voiceover',
      () => ({ status: ModerationStatus.APPROVED, flags: [] }),
      null,
    );
    const stamped = {
      ...prompt,
      greetingScriptInputs: greetingScriptInputs(base),
    };
    const { service, session } = setup({
      brief,
      session: { generationPrompt: stamped },
    });
    await at(service).setSceneSetting('s1', SNOW);
    const after = (session as any).generationPrompt;
    expect(after.finalText).toContain(`Setting: ${SNOW}`);
    expect(after.finalVoiceoverScript).toBe('Марина, ты лучшая!');
    expect(greetingScriptStale(after, session as any)).toBe(false);
  });

  it('варианты модели: праздничные в трауре отбрасываются, остальные выдаются и запоминаются', async () => {
    const { service, session } = setup({
      brief: mourning({ sceneSettingOptions: undefined }),
    });
    (service as any).geminiClient = {
      models: {
        generateContent: jest.fn().mockResolvedValue({
          text: `Bright party hall with balloons and confetti\n${CALM}\nCalm, non-festive living room with soft daylight`,
        }),
      },
    };
    const offered = await at(service).suggestSettings('s1', 'u1');
    expect(offered).toEqual([
      CALM,
      'Calm, non-festive living room with soft daylight',
    ]);
    const stored = (session.greetingBriefSnapshot as any).sceneSettingOptions;
    expect(stored.map((o: any) => o.text)).toEqual(offered);
    await expect(at(service).setSceneSetting('s1', CALM)).resolves.toEqual({
      sceneSetting: CALM,
    });
  });

  it('варианты: потолок уходит провайдеру с запасом на размышления (300 + 1024)', async () => {
    const { service } = setup({
      brief: birthday({ sceneSettingOptions: undefined }),
    });
    const generateContent = jest.fn().mockResolvedValue({ text: SNOW });
    (service as any).geminiClient = { models: { generateContent } };
    await at(service).suggestSettings('s1', 'u1');
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(generateContent.mock.calls[0][0].config.maxOutputTokens).toBe(
      300 + GEMINI_THINKING_HEADROOM,
    );
  });

  it('варианты оборваны по MAX_TOKENS — пустой список, в снимок ничего не пишется, расход учтён', async () => {
    const { service, session, sessions, aiUsage } = setup({
      brief: birthday({ sceneSettingOptions: undefined }),
    });
    // Два целых варианта и обрезанный третий: без проверки обрыва все три
    // ушли бы человеку и в белый список.
    (service as any).geminiClient = {
      models: {
        generateContent: jest.fn().mockResolvedValue({
          text: `${SNOW}\n${CALM}\nbright room full of ball`,
          candidates: [{ finishReason: 'MAX_TOKENS' }],
          usageMetadata: { thoughtsTokenCount: 900 },
        }),
      },
    };
    await expect(at(service).suggestSettings('s1', 'u1')).resolves.toEqual([]);
    expect(sessions.updateSession).not.toHaveBeenCalled();
    expect(
      (session.greetingBriefSnapshot as any).sceneSettingOptions,
    ).toBeUndefined();
    // Вызов оплачен — расход пишется и при обрыве.
    expect(aiUsage.recordGemini).toHaveBeenCalledTimes(1);
  });

  it('запомненных вариантов не больше 12, истёкшие выпадают', () => {
    const old = [issued('old one setting text', NOW - 25 * 3600 * 1000)];
    const many = Array.from({ length: 15 }, (_, i) => `setting number ${i}`);
    const out = rememberSceneSettingOptions(
      old,
      many,
      new Date(NOW).toISOString(),
      NOW,
    );
    expect(out).toHaveLength(MAX_SCENE_SETTING_OPTIONS);
    expect(out.map((o) => o.text)).not.toContain('old one setting text');
  });

  it('пока ролик считается — 409, обстановка не меняется', async () => {
    const { service, sessions } = setup({
      brief: birthday(),
      session: { generatedVideo: { status: 'processing' } },
    });
    await expect(at(service).setSceneSetting('s1', SNOW)).rejects.toMatchObject(
      { status: 409 },
    );
    expect(sessions.updateSession).not.toHaveBeenCalled();
  });

  it('кадр оплачен, а запись не легла — загруженный файл удаляется, отказ доходит', async () => {
    let i = 0;
    const { service, blob } = setup({
      brief: birthday(),
      // Повод меняют перед каждой попыткой записи — 3 промаха, 409.
      beforeWrite: (s) => {
        s.greetingBriefSnapshot = {
          ...s.greetingBriefSnapshot,
          tone: ++i % 2 ? 'FUNNY' : 'WARM',
        };
      },
    });
    const err = await at(service)
      .generateFrame('s1', 'u1', SNOW)
      .catch((e) => e);
    expect(err.getResponse().code).toBe('GREETING_EDIT_IN_PROGRESS');
    expect(blob.deleteBlob).toHaveBeenCalledWith(
      (blob.uploadBuffer as jest.Mock).mock.calls[0][0],
    );
  });
});

describe('аудит захода 8 — подписи фото уходят в видео-промпт', () => {
  const mourningBrief = {
    occasion: 'CONDOLENCE',
    customOccasionText: null,
    tone: 'RESPECTFUL',
    resolvedPresenterProvider: 'grok',
  };
  const photo = {
    id: 'gr_1',
    label: 'Фото',
    description: null,
    photoUrl: 'https://blob/p.jpg',
    photoPathname: 'sessions/s1/greeting-refs/gr_1/p.jpg',
    hasFace: false,
  };

  it.each([
    ['праздничная подпись в трауре', { description: 'стол с тортом и шарами' }],
    ['стоп-слова', { label: 'порнография' }],
    ['чужой образ', { description: 'в образе Пугачёвой' }],
  ])('PATCH: %s — 400, ничего не пишется', async (_n, dto) => {
    const { service, sessions } = setup({
      brief: mourningBrief,
      images: [photo],
    });
    await expect(
      service.update('s1', 'gr_1', dto as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(sessions.updateSession).not.toHaveBeenCalled();
  });

  it('PATCH: спокойная подпись в трауре проходит', async () => {
    const { service, session } = setup({
      brief: mourningBrief,
      images: [photo],
    });
    await service.update('s1', 'gr_1', { description: 'папа у окна' } as any);
    expect((session.greetingReferenceImages as any)[0].description).toBe(
      'папа у окна',
    );
  });

  it('confirm: праздничная подпись в трауре — 400 до скачивания и проверки лица', async () => {
    const { service, blob } = setup({ brief: mourningBrief });
    (blob as any).downloadBuffer = jest.fn();
    await expect(
      service.confirm('s1', {
        pathname: 'sessions/s1/greeting-refs/gr_9/p.jpg',
        label: 'праздник с хлопушками',
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect((blob as any).downloadBuffer).not.toHaveBeenCalled();
  });
});
