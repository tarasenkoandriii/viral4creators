/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('@vercel/blob', () => ({ head: jest.fn() }));

import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  GreetingVoiceUnderstandService,
  planChoices,
  projectGreetingVoicePathname,
} from './greeting-voice-understand.service';
import {
  VoiceBudgetExhaustedException,
  VoiceLoginRequiredException,
} from '../voice-budget/voice-budget.service';
import { DailySpendLimitExceededException } from '../../common/spend-limits';
import { REPLIES } from '../../common/greeting-voice-intent';
import { greetingVoiceMaxBytesFor } from '../../common/greeting-voice';

const PID = 'proj-1';
const SID = 'sess-1';
const PPATH = `projects/${PID}/greeting-voice-1700000000000.webm`;
const SPATH = `sessions/${SID}/voice-1700000000000.webm`;

const BRIEF_ROW = {
  occasion: 'BIRTHDAY',
  customOccasionText: null,
  occasionRegister: null,
  registerSource: null,
  userOccasionRegister: null,
  scriptLanguage: 'uk',
  recipientName: 'Марина',
  senderName: 'Андрей',
  tone: 'WARM',
  personalMessage: null,
  presenterProvider: 'grok',
  resolution: '720p',
  occasionDate: null,
};

function snapshot(over: Record<string, unknown> = {}) {
  return {
    ...BRIEF_ROW,
    requestedPresenterProvider: 'grok',
    resolvedPresenterProvider: 'grok',
    requestedResolution: '720p',
    resolvedResolution: '720p',
    ...over,
  };
}

const SCREEN = { step: 'brief' as const };

function build(
  opts: {
    brief?: unknown;
    session?: unknown;
    recognized?: Record<string, unknown>;
    recognizeThrows?: Error;
    model?: unknown;
    modelThrows?: boolean;
    voiceRefusals?: Array<Error | null>;
    planRefusal?: Error;
    plan?: string;
    /** K5: представления карточек сессии; `Error` — сбой чтения. */
    views?: {
      voice?: unknown;
      presets?: unknown;
      /** S2: каталог Soniox раздела карточки голоса. */
      soniox?: unknown;
      music?: unknown;
      cards?: unknown;
      sticker?: unknown;
      scenes?: unknown;
    };
    clones?: unknown[];
    /** Выключатель советника у оператора. */
    guideOff?: boolean;
  } = {},
) {
  const v = opts.views ?? {};
  const view = (x: unknown, dflt: unknown) =>
    x instanceof Error
      ? jest.fn().mockRejectedValue(x)
      : jest.fn().mockResolvedValue(x === undefined ? dflt : x);
  const senderVoice = {
    get: view(v.voice, { senderVoice: null, presetVoiceId: null }),
    listPresetVoicesQuick: view(v.presets, [
      { voiceId: 'ara', name: 'Ara', language: 'multilingual' },
      { voiceId: 'rex', name: 'Rex', language: 'multilingual' },
    ]),
    listSonioxVoicesQuick: view(v.soniox, [
      {
        voiceId: 'Maya',
        name: 'Maya (female)',
        previewUrl: null,
        accent: null,
      },
      { voiceId: 'Adrian', name: 'Adrian', previewUrl: null, accent: null },
    ]),
  };
  const music = {
    get: view(v.music, {
      themes: [
        { id: 'waltz', title: 'Вальс', url: 'https://m', occasions: null },
      ],
      selected: null,
      libraryEnabled: false,
    }),
  };
  const cards = {
    get: view(v.cards, {
      cards: { title: null, closing: null },
      suggested: { title: 'Мама', closing: null },
    }),
  };
  const stickers = {
    view: view(v.sticker, {
      results: [],
      selected: null,
      configured: true,
      allowed: true,
    }),
  };
  const scenes = {
    get: view(v.scenes, { sceneCount: 1, maxScenes: 4, durations: [15] }),
  };
  const prisma = {
    userVoice: {
      findMany: jest.fn().mockResolvedValue(opts.clones ?? []),
    },
    greetingBrief: {
      findFirst: jest
        .fn()
        .mockResolvedValue(opts.brief === undefined ? BRIEF_ROW : opts.brief),
    },
  };
  const sessions = {
    getSession: jest.fn().mockResolvedValue(
      opts.session === undefined
        ? {
            id: SID,
            userId: 'u-1',
            locale: 'ru',
            greetingBriefSnapshot: snapshot(),
            generationPrompt: null,
          }
        : opts.session,
    ),
  };
  const blob = {
    createUploadUrl: jest.fn().mockResolvedValue({ uploadUrl: 'https://put' }),
    deleteBlob: jest.fn().mockResolvedValue(true),
  };
  const greetingVoice = {
    recognizeRecording: opts.recognizeThrows
      ? jest.fn().mockRejectedValue(opts.recognizeThrows)
      : jest.fn().mockResolvedValue({
          status: 'ok',
          text: 'кому мама',
          scriptMismatch: false,
          hints: ['uk', 'ru'],
          language: null,
          ...opts.recognized,
        }),
  };
  const plans = {
    assertCanSpendUser: opts.planRefusal
      ? jest.fn().mockRejectedValue(opts.planRefusal)
      : jest.fn().mockResolvedValue(undefined),
    assertCanSpendSession: opts.planRefusal
      ? jest.fn().mockRejectedValue(opts.planRefusal)
      : jest.fn().mockResolvedValue(undefined),
    planOfUser: jest.fn().mockResolvedValue(opts.plan ?? 'LITE'),
  };
  const refusals = [...(opts.voiceRefusals ?? [])];
  const voiceBudget = {
    assertCanSpendVoice: jest.fn().mockImplementation(async () => {
      const next = refusals.shift();
      if (next) throw next;
    }),
  };
  const aiUsage = { recordGemini: jest.fn().mockResolvedValue(undefined) };
  const guide = {
    available: jest.fn().mockResolvedValue(opts.guideOff ? false : true),
  };
  const voiceUploads = {
    remember: jest.fn().mockResolvedValue(undefined),
    forget: jest.fn().mockResolvedValue(undefined),
  };
  const service = new GreetingVoiceUnderstandService(
    prisma as any,
    sessions as any,
    blob as any,
    greetingVoice as any,
    plans as any,
    voiceBudget as any,
    aiUsage as any,
    senderVoice as any,
    music as any,
    cards as any,
    stickers as any,
    scenes as any,
    guide as any,
    voiceUploads as any,
  );
  const generateContent = opts.modelThrows
    ? jest.fn().mockRejectedValue(new Error('gemini down'))
    : jest.fn().mockResolvedValue({
        text:
          typeof opts.model === 'string'
            ? opts.model
            : JSON.stringify(
                opts.model ?? {
                  kind: 'fill',
                  confidence: 0.9,
                  fields: [{ target: 'recipient', value: 'Мама' }],
                },
              ),
      });
  (service as any).genai = { models: { generateContent } };
  return {
    service,
    prisma,
    sessions,
    blob,
    greetingVoice,
    plans,
    voiceBudget,
    aiUsage,
    generateContent,
    senderVoice,
    music,
    cards,
    stickers,
    scenes,
    guide,
    voiceUploads,
  };
}

const exhausted = () =>
  new VoiceBudgetExhaustedException('потолок голоса исчерпан');

const project = (
  b: ReturnType<typeof build>,
  over: Record<string, unknown> = {},
  locale: any = 'ru',
) =>
  b.service.understandForProject(
    'u-1',
    PID,
    { pathname: PPATH, screen: SCREEN, ...over } as any,
    locale,
  );

describe('маршрут брифа до сессии — владелец и путь', () => {
  it('ключ записи — в префиксе проекта, с отметкой времени', () => {
    expect(
      projectGreetingVoicePathname(
        PID,
        'audio/webm;codecs=opus',
        new Date(1_700_000_000_000),
      ),
    ).toBe(PPATH);
  });

  it('upload-url: чужой проект — 404 и никакой ссылки', async () => {
    const b = build({ brief: null });
    await expect(
      b.service.createProjectUploadUrl('u-2', PID, {
        fileName: 'a',
        fileSize: 1,
        mimeType: 'audio/webm',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(b.blob.createUploadUrl).not.toHaveBeenCalled();
  });

  it('upload-url: владелец — ссылка с потолком реплики; владение проверяется запросом', async () => {
    const b = build();
    const r = await b.service.createProjectUploadUrl('u-1', PID, {
      fileName: 'a',
      fileSize: 1,
      mimeType: 'audio/webm',
    });
    expect(r.pathname.startsWith(`projects/${PID}/greeting-voice-`)).toBe(true);
    expect(b.blob.createUploadUrl).toHaveBeenCalledWith(
      r.pathname,
      'audio/webm',
      greetingVoiceMaxBytesFor('audio/webm'),
    );
    // Путь учтён ДО выдачи ссылки — крон удалит необработанную запись.
    expect(b.voiceUploads.remember).toHaveBeenCalledWith(r.pathname);
    expect(b.voiceUploads.remember.mock.invocationCallOrder[0]).toBeLessThan(
      b.blob.createUploadUrl.mock.invocationCallOrder[0],
    );
    expect(b.prisma.greetingBrief.findFirst).toHaveBeenCalledWith({
      where: { projectId: PID, project: { userId: 'u-1', deletedAt: null } },
    });
  });

  it('understand: чужой проект — 404; чужую запись не читаем и не удаляем', async () => {
    const b = build({ brief: null });
    await expect(project(b)).rejects.toBeInstanceOf(NotFoundException);
    expect(b.greetingVoice.recognizeRecording).not.toHaveBeenCalled();
    expect(b.blob.deleteBlob).not.toHaveBeenCalled();
  });

  it('understand: путь не из этого проекта — 400 до всякого платного вызова', async () => {
    const b = build();
    await expect(
      project(b, { pathname: 'projects/other/greeting-voice-1.webm' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(b.plans.assertCanSpendUser).not.toHaveBeenCalled();
    expect(b.blob.deleteBlob).not.toHaveBeenCalled();
  });
});

describe('разбор реплики — путь целиком', () => {
  it('реплика → карточка: распознавание K2, разбор своей строкой расхода, запись удалена', async () => {
    const b = build();
    const r = await project(b);
    expect(r).toEqual({
      status: 'ok',
      transcript: 'кому мама',
      language: null,
      intent: {
        kind: 'fill',
        fields: [
          { target: 'greeting-field-recipient', value: 'Мама', label: 'Кому' },
        ],
      },
      confidence: 0.9,
      reply: REPLIES.ru.confirmQuestion,
      scriptMismatch: false,
    });
    const rec = b.greetingVoice.recognizeRecording.mock.calls[0][0];
    expect(rec.pathname).toBe(PPATH);
    // Подсказки — язык поздравления брифа, затем интерфейса; имена — из брифа.
    expect(rec.hints).toEqual(['uk', 'ru']);
    expect(rec.names).toEqual(['Марина', 'Андрей']);
    expect(rec.owner).toEqual({ userId: 'u-1' });
    expect(b.plans.assertCanSpendUser).toHaveBeenCalledWith('u-1', {
      projectId: PID,
    });
    expect(b.aiUsage.recordGemini).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        operation: 'voice-assistant-understand',
        userId: 'u-1',
      }),
    );
    const config = b.generateContent.mock.calls[0][0].config;
    expect(config.responseMimeType).toBe('application/json');
    expect(b.blob.deleteBlob).toHaveBeenCalledWith(PPATH);
  });

  it('потолок голоса исчерпан — budget-exhausted ДО платных вызовов, запись удалена', async () => {
    const b = build({ voiceRefusals: [exhausted()] });
    const r = await project(b);
    expect(r).toMatchObject({
      status: 'budget-exhausted',
      intent: null,
      reply: REPLIES.ru.budgetExhausted,
      // У потолка голоса свой статус — причины нет.
      reason: null,
    });
    expect(b.greetingVoice.recognizeRecording).not.toHaveBeenCalled();
    expect(b.generateContent).not.toHaveBeenCalled();
    expect(b.blob.deleteBlob).toHaveBeenCalledWith(PPATH);
  });

  it('суточный лимит АККАУНТА исчерпан — unavailable с причиной «лимит аккаунта», не «голос кончился»', async () => {
    const b = build({
      planRefusal: new DailySpendLimitExceededException('лимит'),
    });
    expect(await project(b)).toMatchObject({
      status: 'unavailable',
      intent: null,
      reply: REPLIES.ru.accountLimit,
      reason: 'account-limit',
    });
    expect(b.voiceBudget.assertCanSpendVoice).not.toHaveBeenCalled();
    expect(b.greetingVoice.recognizeRecording).not.toHaveBeenCalled();
    expect(b.blob.deleteBlob).toHaveBeenCalled();
  });

  it('блокировка оператором — 403 наружу, запись всё равно удалена', async () => {
    const b = build({ planRefusal: new ForbiddenException('приостановлено') });
    await expect(project(b)).rejects.toBeInstanceOf(ForbiddenException);
    expect(b.greetingVoice.recognizeRecording).not.toHaveBeenCalled();
    expect(b.blob.deleteBlob).toHaveBeenCalledWith(PPATH);
  });

  it('потолок кончился между распознаванием и разбором — разбора нет, услышанное отдаётся', async () => {
    const b = build({ voiceRefusals: [null, exhausted()] });
    const r = await project(b);
    expect(r).toMatchObject({
      status: 'budget-exhausted',
      transcript: 'кому мама',
      intent: null,
    });
    expect(b.generateContent).not.toHaveBeenCalled();
    expect(b.blob.deleteBlob).toHaveBeenCalled();
  });

  it('повтор распознавания спрашивает те же потолки', async () => {
    const b = build({ voiceRefusals: [null, exhausted()] });
    await project(b);
    const { canSpendAgain } =
      b.greetingVoice.recognizeRecording.mock.calls[0][0];
    // Второй вызов потолка в этом тесте отказывает.
    b.voiceBudget.assertCanSpendVoice.mockRejectedValueOnce(exhausted());
    expect(await canSpendAgain()).toBe(false);
    expect(await canSpendAgain()).toBe(true);
  });

  it('распознавание бросило (записи нет) — исключение наружу, запись удалена', async () => {
    const b = build({ recognizeThrows: new BadRequestException('нет записи') });
    await expect(project(b)).rejects.toBeInstanceOf(BadRequestException);
    expect(b.blob.deleteBlob).toHaveBeenCalledWith(PPATH);
  });

  it('модель разбора упала — unavailable, услышанное показывается, запись удалена', async () => {
    const b = build({ modelThrows: true });
    const r = await project(b);
    expect(r).toMatchObject({
      status: 'unavailable',
      transcript: 'кому мама',
      intent: null,
      reply: REPLIES.ru.unavailable,
    });
    expect(b.blob.deleteBlob).toHaveBeenCalled();
  });

  it('нет ключа Gemini — unavailable без вызова', async () => {
    const b = build();
    (b.service as any).genai = null;
    expect((await project(b)).status).toBe('unavailable');
  });

  it('модель вернула мусор вместо JSON — unknown с «не понял», не исключение', async () => {
    const b = build({ model: 'конечно! вот JSON: {kind' });
    const r = await project(b);
    expect(r).toMatchObject({
      status: 'ok',
      intent: { kind: 'unknown' },
      confidence: 0,
      reply: REPLIES.ru.notUnderstood,
    });
  });

  it('не расслышал — без разбора, переспрос', async () => {
    const b = build({ recognized: { status: 'not-heard', text: null } });
    const r = await project(b);
    expect(r).toMatchObject({
      status: 'not-heard',
      transcript: null,
      reply: REPLIES.ru.notHeard,
    });
    expect(b.generateContent).not.toHaveBeenCalled();
  });

  it('распознавание недоступно — unavailable без разбора', async () => {
    const b = build({ recognized: { status: 'unavailable', text: null } });
    expect(await project(b)).toMatchObject({
      status: 'unavailable',
      reply: REPLIES.ru.unavailable,
    });
    expect(b.generateContent).not.toHaveBeenCalled();
  });

  it('низкая STT-уверенность блокирует быстрое «да»', async () => {
    const b = build({ recognized: { text: 'да', speechConfidence: 0.3 } });
    const result = await project(b, {
      pending: {
        kind: 'fill',
        fields: [{ target: 'greeting-field-recipient', value: 'Марина' }],
      },
    });
    expect(b.generateContent).not.toHaveBeenCalled();
    expect(result.intent).toEqual({ kind: 'unknown' });
    expect(result.confidence).toBe(0.3);
  });

  it('уверенность Soniox ограничивает согласие даже при уверенной модели', async () => {
    const b = build({
      recognized: { text: 'генерируй', speechConfidence: 0.7 },
      model: { kind: 'consent', confidence: 0.99 },
      session: {
        id: SID,
        userId: 'u-1',
        locale: 'ru',
        greetingBriefSnapshot: snapshot(),
        generationPrompt: { finalText: 'x' },
      },
    });
    const result = await b.service.understandForSession(
      SID,
      { pathname: SPATH, screen: SCREEN } as any,
      'ru',
    );
    expect(result.intent).toEqual({ kind: 'unknown' });
    expect(result.reply).toMatch(/расслышал/);
  });

  it('дважды латиницей (K2 scriptMismatch) — текст показан, но не разобран', async () => {
    const b = build({
      recognized: { text: 'Marina', scriptMismatch: true },
    });
    const r = await project(b);
    expect(r).toMatchObject({
      status: 'ok',
      transcript: 'Marina',
      intent: { kind: 'unknown' },
      scriptMismatch: true,
      reply: REPLIES.ru.scriptMismatch,
    });
    expect(b.generateContent).not.toHaveBeenCalled();
  });

  it('«да» на карточку — без модели; без карточки «да» идёт в разбор', async () => {
    const pending = {
      kind: 'fill',
      fields: [{ target: 'greeting-field-recipient', value: 'Мама' }],
    };
    const withCard = build({ recognized: { text: 'Да.' } });
    expect((await project(withCard, { pending })).intent).toEqual({
      kind: 'confirm',
    });
    expect(withCard.generateContent).not.toHaveBeenCalled();
    expect(withCard.blob.deleteBlob).toHaveBeenCalled();

    const noCard = build({
      recognized: { text: 'Да.' },
      model: { kind: 'confirm', confidence: 0.9 },
    });
    expect((await project(noCard)).intent).toEqual({ kind: 'unknown' });
    expect(noCard.generateContent).toHaveBeenCalled();
  });

  it('K6: «к сценарию» и «что здесь?» — без модели; при карточке — в разбор', async () => {
    const nav = build({ recognized: { text: 'К сценарию!' } });
    expect((await project(nav)).intent).toEqual({
      kind: 'navigate',
      to: 'script',
    });
    expect(nav.generateContent).not.toHaveBeenCalled();
    expect(nav.blob.deleteBlob).toHaveBeenCalled();

    const help = build({ recognized: { text: 'Что здесь?' } });
    expect((await project(help)).intent).toEqual({ kind: 'help' });
    expect(help.generateContent).not.toHaveBeenCalled();

    // С карточкой «я понял так» короткое «назад» может значить «нет» —
    // это решает модель, видящая карточку.
    const pending = {
      kind: 'fill',
      fields: [{ target: 'greeting-field-recipient', value: 'Мама' }],
    };
    const withCard = build({
      recognized: { text: 'Назад' },
      model: { kind: 'cancel', confidence: 0.9 },
    });
    expect((await project(withCard, { pending })).intent).toEqual({
      kind: 'cancel',
    });
    expect(withCard.generateContent).toHaveBeenCalled();
  });

  it('недоступный тон — поля нет, причина — как на экране', async () => {
    const b = build({
      brief: { ...BRIEF_ROW, occasion: 'CONDOLENCE', tone: 'RESPECTFUL' },
      model: {
        kind: 'fill',
        confidence: 0.9,
        fields: [{ target: 'tone', value: 'FUNNY' }],
      },
    });
    expect(await project(b)).toMatchObject({
      intent: { kind: 'unknown' },
      reply: '«С юмором» — недоступен для этого повода.',
    });
  });

  it('тариф — тем же гейтом, что правка брифа: Lite не получает Hedra', async () => {
    expect(planChoices('LITE')).toEqual({
      presenters: ['grok'],
      maxResolution: '480p',
    });
    expect(planChoices('PREMIUM')).toEqual({
      presenters: ['grok', 'hedra'],
      maxResolution: '1080p',
    });
    const b = build({
      model: {
        kind: 'fill',
        confidence: 0.9,
        fields: [{ target: 'presenter', value: 'hedra' }],
      },
    });
    expect((await project(b)).intent).toEqual({ kind: 'unknown' });
    expect(b.plans.planOfUser).toHaveBeenCalledWith('u-1');
  });

  it('язык речи есть — реплика на нём; подписи — на языке интерфейса', async () => {
    const b = build({
      recognized: { language: 'uk' },
      model: {
        kind: 'fill',
        confidence: 0.9,
        fields: [
          { target: 'recipient', value: 'Мама' },
          { target: 'sender', value: 'Андрій', confidence: 0.2 },
        ],
      },
    });
    const r = await project(b, {}, 'en');
    expect(r.language).toBe('uk');
    expect(r.intent).toMatchObject({ fields: [{ label: 'Recipient' }] });
    expect(r.reply).toContain('Не розчув: Від кого');
  });
});

describe('аудит волны K', () => {
  it('реплика длиннее текста поздравления с запасом — «продиктуйте короче», без разбора, запись удалена', async () => {
    const b = build({ recognized: { text: 'я'.repeat(2201) } });
    const r = await project(b);
    expect(r).toMatchObject({
      status: 'ok',
      intent: { kind: 'unknown' },
      reply: REPLIES.ru.transcriptTooLong,
    });
    expect(b.generateContent).not.toHaveBeenCalled();
    expect(b.blob.deleteBlob).toHaveBeenCalled();
  });

  it('«согласен» при карточке на экране — подтверждение карточки без модели, не согласие', async () => {
    const b = build({ recognized: { text: 'Согласен!' } });
    const r = await project(b, {
      pending: { kind: 'fill', fields: [] },
    });
    expect(r.intent).toEqual({ kind: 'confirm' });
    expect(b.generateContent).not.toHaveBeenCalled();
  });
});

describe('маршрут сессии', () => {
  it('сессия без владельца, голос для гостей выключен — unavailable «после входа», запись удалена', async () => {
    const b = build({
      session: {
        id: SID,
        userId: null,
        locale: 'ru',
        greetingBriefSnapshot: snapshot(),
        generationPrompt: null,
      },
      voiceRefusals: [new VoiceLoginRequiredException('войдите')],
    });
    const r = await b.service.understandForSession(
      SID,
      { pathname: SPATH, screen: SCREEN } as any,
      'ru',
    );
    expect(r).toMatchObject({
      status: 'unavailable',
      reply: REPLIES.ru.loginRequired,
      reason: 'login-required',
    });
    expect(b.voiceBudget.assertCanSpendVoice).toHaveBeenCalledWith(null);
    expect(b.greetingVoice.recognizeRecording).not.toHaveBeenCalled();
    expect(b.blob.deleteBlob).toHaveBeenCalledWith(SPATH);
  });

  const session = (
    b: ReturnType<typeof build>,
    over: Record<string, unknown> = {},
  ) =>
    b.service.understandForSession(
      SID,
      { pathname: SPATH, screen: SCREEN, ...over } as any,
      'ru',
    );

  it('не поздравительная сессия — 404, запись не трогаем', async () => {
    const b = build({
      session: { id: SID, userId: 'u-1', greetingBriefSnapshot: null },
    });
    await expect(session(b)).rejects.toBeInstanceOf(NotFoundException);
    expect(b.blob.deleteBlob).not.toHaveBeenCalled();
  });

  it('чужой путь — 400', async () => {
    const b = build();
    await expect(
      session(b, { pathname: 'sessions/other/voice-1.webm' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(b.blob.deleteBlob).not.toHaveBeenCalled();
  });

  it('расход — под сессией; потолки — владельца сессии; запись удалена', async () => {
    const b = build();
    await session(b);
    expect(b.plans.assertCanSpendSession).toHaveBeenCalledWith(SID);
    expect(b.plans.assertCanSpendUser).not.toHaveBeenCalled();
    expect(b.voiceBudget.assertCanSpendVoice).toHaveBeenCalledWith('u-1');
    expect(b.greetingVoice.recognizeRecording.mock.calls[0][0].owner).toEqual({
      sessionId: SID,
    });
    expect(b.aiUsage.recordGemini).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sessionId: SID, userId: 'u-1' }),
    );
    expect(b.blob.deleteBlob).toHaveBeenCalledWith(SPATH);
  });

  it('сценарий собран — команды сессии доступны; до сборки — нет', async () => {
    const shorter = {
      kind: 'command',
      command: 'other-music',
      confidence: 0.9,
    };
    const before = build({ model: shorter });
    expect(await session(before)).toMatchObject({
      intent: { kind: 'unknown' },
      reply: REPLIES.ru.needScript,
    });
    const after = build({
      model: shorter,
      session: {
        id: SID,
        userId: 'u-1',
        locale: 'ru',
        greetingBriefSnapshot: snapshot(),
        generationPrompt: { finalText: 'x' },
      },
    });
    // «Другую музыку» — карточка со следующей темой каталога (аудит B1).
    expect((await session(after)).intent).toEqual({
      kind: 'fill',
      fields: [
        { target: 'greeting-music-theme', value: 'waltz', label: 'Музыка' },
      ],
    });
  });

  it('та же команда на брифе до сессии — «сначала начните сборку»', async () => {
    const b = build({
      model: { kind: 'command', command: 'shorter', confidence: 0.9 },
    });
    expect((await project(b)).reply).toBe(REPLIES.ru.needSession);
  });
});

describe('элементы сессии (K5)', () => {
  const withScript = {
    id: SID,
    sessionId: SID,
    userId: 'u-1',
    locale: 'ru',
    greetingBriefSnapshot: snapshot(),
    generationPrompt: { finalText: 'x' },
  };
  const run = (
    b: ReturnType<typeof build>,
    over: Record<string, unknown> = {},
  ) =>
    b.service.understandForSession(
      SID,
      { pathname: SPATH, screen: SCREEN, ...over } as any,
      'ru',
    );
  const promptOf = (b: ReturnType<typeof build>): string =>
    b.generateContent.mock.calls[0][0].contents[0].text;

  it('со сценарием — состояние из представлений карточек, в инструкции и в проверке', async () => {
    const b = build({
      session: withScript,
      model: {
        kind: 'fill',
        confidence: 0.9,
        fields: [{ target: 'greeting-scenes-count', value: '3' }],
      },
      views: { scenes: { sceneCount: 1, maxScenes: 2, durations: [15] } },
    });
    const r = await run(b);
    expect(b.scenes.get).toHaveBeenCalledWith(SID);
    expect(b.music.get).toHaveBeenCalledWith(SID);
    expect(b.cards.get).toHaveBeenCalledWith(SID);
    expect(b.stickers.view).toHaveBeenCalledWith(SID, '');
    expect(b.senderVoice.get).toHaveBeenCalledWith(SID);
    // Потолок сцен — из представления (по регистру), не из общего максимума.
    expect(r.intent).toEqual({ kind: 'unknown' });
    expect(r.reply).toBe(REPLIES.ru.scenesMax('Сколько сцен', 2));
    expect(promptOf(b)).toContain('- scenesCount [list]');
    expect(promptOf(b)).toContain('waltz ("Вальс")');
  });

  it('доступное значение — поле карточки с хуком', async () => {
    const b = build({
      session: withScript,
      model: {
        kind: 'fill',
        confidence: 0.9,
        fields: [{ target: 'musicTheme', value: 'Вальс' }],
      },
    });
    expect((await run(b)).intent).toEqual({
      kind: 'fill',
      fields: [
        { target: 'greeting-music-theme', value: 'waltz', label: 'Музыка' },
      ],
    });
  });

  it('без сценария представления не читаются вовсе', async () => {
    const b = build();
    await run(b);
    expect(b.scenes.get).not.toHaveBeenCalled();
    expect(b.senderVoice.listPresetVoicesQuick).not.toHaveBeenCalled();
    expect(b.prisma.userVoice.findMany).not.toHaveBeenCalled();
  });

  it('быстрый ответ на карточку не тратит чтений', async () => {
    const b = build({
      session: withScript,
      recognized: { text: 'да' },
    });
    const r = await run(b, { pending: { kind: 'fill', fields: [] } });
    expect(r.intent).toEqual({ kind: 'confirm' });
    expect(b.music.get).not.toHaveBeenCalled();
  });

  it('сбой представления — карточки нет для голоса, разбор не падает', async () => {
    const b = build({
      session: withScript,
      model: {
        kind: 'fill',
        confidence: 0.9,
        fields: [{ target: 'musicEnabled', value: false }],
      },
      views: { music: new Error('db down'), presets: new Error('xai down') },
    });
    const r = await run(b);
    expect(r.status).toBe('ok');
    expect(r.reply).toBe(REPLIES.ru.notOnScreen('Музыка'));
    expect(promptOf(b)).not.toContain('- musicTheme');
    // Роестр пресетов упал — карточка голоса есть, пресетов нет.
    expect(promptOf(b)).toContain('- voiceClone');
    expect(promptOf(b)).toContain(
      'голос ведущего в кадре, value — id из: нет вариантов',
    );
    expect(b.blob.deleteBlob).toHaveBeenCalledWith(SPATH);
  });

  it('клоны — свои и готовые, тем же отбором, что у выбора клона', async () => {
    const b = build({
      session: withScript,
      plan: 'STANDARD',
      clones: [{ label: 'Мой', resembleVoiceId: 'rv-1' }],
      model: {
        kind: 'fill',
        confidence: 0.9,
        fields: [{ target: 'voiceClone', value: 'мой' }],
      },
    });
    const r = await run(b);
    expect(b.prisma.userVoice.findMany).toHaveBeenCalledWith({
      where: { userId: 'u-1', status: 'READY', resembleVoiceId: { not: null } },
      select: { label: true, resembleVoiceId: true },
    });
    expect(r.intent).toEqual({
      kind: 'fill',
      fields: [
        {
          target: 'greeting-voice-clone',
          value: 'rv-1',
          label: 'Голос отправителя',
        },
      ],
    });
  });

  it('выбор своей музыки — «с музыкой», но ни одна тема не подсвечена', async () => {
    const b = build({
      session: withScript,
      views: {
        music: {
          themes: [{ id: 'waltz', title: 'Вальс', url: 'u', occasions: null }],
          selected: {
            id: 'waltz',
            title: 'мой трек',
            url: 'u',
            source: 'upload',
          },
          libraryEnabled: false,
        },
      },
      model: {
        kind: 'fill',
        confidence: 0.9,
        fields: [{ target: 'musicTheme', value: 'waltz' }],
      },
    });
    // Тема с тем же id, что у загруженного трека, выбирается — на экране
    // она не подсвечена, значит и «уже выбрано» было бы неправдой.
    expect((await run(b)).intent).toMatchObject({ kind: 'fill' });
    expect(promptOf(b)).toContain('сейчас с музыкой');
  });

  it('клоны — только при возможности тарифа, как у экрана', async () => {
    const b = build({
      session: withScript,
      plan: 'LITE',
      clones: [{ label: 'Мой', resembleVoiceId: 'rv-1' }],
      model: {
        kind: 'fill',
        confidence: 0.9,
        fields: [{ target: 'voiceClone', value: 'rv-1' }],
      },
    });
    const r = await run(b);
    expect(b.prisma.userVoice.findMany).not.toHaveBeenCalled();
    expect(r.intent).toEqual({ kind: 'unknown' });
    expect(r.reply).toBe(REPLIES.ru.noSuchOption('Голос отправителя'));
    expect(promptOf(b)).not.toContain('rv-1');
  });

  it('роестр пресетов — через короткий путь с кешем', async () => {
    const b = build({ session: withScript });
    await run(b);
    expect(b.senderVoice.listPresetVoicesQuick).toHaveBeenCalledTimes(1);
  });

  it('S2: голос Soniox — из каталога на языке поздравления, значение — id голоса', async () => {
    const b = build({
      session: {
        ...withScript,
        greetingBriefSnapshot: {
          ...withScript.greetingBriefSnapshot,
          scriptLanguage: 'uk',
        },
      },
      model: {
        kind: 'fill',
        confidence: 0.9,
        fields: [{ target: 'voiceSoniox', value: 'adrian' }],
      },
    });
    const r = await run(b);
    expect(b.senderVoice.listSonioxVoicesQuick).toHaveBeenCalledWith('uk');
    expect(r.intent).toEqual({
      kind: 'fill',
      fields: [
        {
          target: 'greeting-voice-soniox',
          value: 'Adrian',
          label: 'Голос отправителя',
        },
      ],
    });
    expect(promptOf(b)).toContain('Adrian ("Adrian")');
  });

  it('S2: уже выбранный голос Soniox — «уже», голоса нет в каталоге — «нет такого»', async () => {
    const already = build({
      session: withScript,
      views: {
        voice: {
          senderVoice: null,
          presetVoiceId: null,
          sonioxVoice: { voiceId: 'Maya', label: 'Maya (female)' },
        },
      },
      model: {
        kind: 'fill',
        confidence: 0.9,
        fields: [{ target: 'voiceSoniox', value: 'Maya (female)' }],
      },
    });
    const r1 = await run(already);
    expect(r1.intent).toEqual({ kind: 'unknown' });
    expect(r1.reply).toBe(
      REPLIES.ru.alreadySelected('Голос отправителя', 'Maya (female)'),
    );

    const missing = build({
      session: withScript,
      views: { soniox: new Error('soniox down') },
      model: {
        kind: 'fill',
        confidence: 0.9,
        fields: [{ target: 'voiceSoniox', value: 'Maya' }],
      },
    });
    const r2 = await run(missing);
    expect(r2.reply).toBe(REPLIES.ru.noSuchOption('Голос отправителя'));
  });

  it('S2: «верни обычный голос» при выбранном Soniox (по умолчанию) — снимается', async () => {
    const b = build({
      session: withScript,
      views: {
        voice: {
          senderVoice: null,
          presetVoiceId: null,
          sonioxVoice: { voiceId: null, label: null },
        },
      },
      model: {
        kind: 'fill',
        confidence: 0.9,
        fields: [{ target: 'voiceCustom', value: false }],
      },
    });
    expect((await run(b)).intent).toMatchObject({
      kind: 'fill',
      fields: [{ target: 'greeting-voice-custom', value: false }],
    });
    expect(promptOf(b)).toContain('сейчас Soniox по умолчанию');
  });
});

describe('выключатель советника у оператора (аудит волны K, B2)', () => {
  it('выключен — «недоступно» до любого платного вызова, запись удалена', async () => {
    const b = build({ guideOff: true });
    const r = await b.service.understandForSession(
      SID,
      { pathname: SPATH, screen: SCREEN } as any,
      'ru',
    );
    expect(r).toMatchObject({
      status: 'unavailable',
      intent: null,
      reply: REPLIES.ru.unavailable,
      reason: 'operator-off',
    });
    expect(b.greetingVoice.recognizeRecording).not.toHaveBeenCalled();
    expect(b.generateContent).not.toHaveBeenCalled();
    expect(b.voiceBudget.assertCanSpendVoice).not.toHaveBeenCalled();
    expect(b.blob.deleteBlob).toHaveBeenCalledWith(SPATH);
  });

  it('и на брифе до сессии', async () => {
    const b = build({ guideOff: true });
    expect((await project(b)).status).toBe('unavailable');
    expect(b.greetingVoice.recognizeRecording).not.toHaveBeenCalled();
  });

  it('выключили между распознаванием и разбором — разбора нет', async () => {
    const b = build();
    b.guide.available.mockResolvedValueOnce(true).mockResolvedValue(false);
    const r = await b.service.understandForSession(
      SID,
      { pathname: SPATH, screen: SCREEN } as any,
      'ru',
    );
    expect(b.greetingVoice.recognizeRecording).toHaveBeenCalled();
    expect(b.generateContent).not.toHaveBeenCalled();
    expect(r.status).toBe('unavailable');
    expect(r.reason).toBe('operator-off');
  });
});

describe('финальный аудит ветки K (30.09.2026)', () => {
  it('значения на экране: сохранён день рождения, на экране «Особый повод» — настроение принимается, в инструкции — экран', async () => {
    const b = build({
      model: {
        kind: 'fill',
        confidence: 0.9,
        fields: [{ target: 'greeting-field-mood', value: 'SOLEMN' }],
      },
    });
    const r = await project(b, {
      current: {
        occasion: 'OTHER',
        customOccasionText: 'Выпускной',
        tone: 'NOT-A-TONE',
      },
    });
    expect(r.intent).toMatchObject({
      kind: 'fill',
      fields: [{ target: 'greeting-field-mood', value: 'SOLEMN' }],
    });
    const prompt = b.generateContent.mock.calls[0][0].contents[0].text;
    expect(prompt).toContain('occasion=OTHER');
    expect(prompt).toContain('Выпускной');
    // Неверное значение не попало никуда — тон сохранённый.
    expect(prompt).toContain('tone=WARM');
    // Ничего не сохраняется.
    expect(b.prisma.greetingBrief.findFirst).toHaveBeenCalledTimes(1);
    expect((b.prisma.greetingBrief as any).update).toBeUndefined();
  });

  it('значения на экране — и на маршруте сессии; без current — сохранённый бриф', async () => {
    const b = build({
      model: {
        kind: 'fill',
        confidence: 0.9,
        fields: [{ target: 'greeting-field-mood', value: 'SOLEMN' }],
      },
    });
    const withCurrent = await b.service.understandForSession(
      SID,
      {
        pathname: SPATH,
        screen: SCREEN,
        current: { occasion: 'OTHER', customOccasionText: 'Юбилей' },
      } as any,
      'ru',
    );
    expect(withCurrent.intent?.kind).toBe('fill');
    const without = await b.service.understandForSession(
      SID,
      { pathname: SPATH, screen: SCREEN } as any,
      'ru',
    );
    expect(without.intent?.kind).not.toBe('fill');
  });

  it('запись длиннее минуты — unavailable/too-long без разбора, запись и строка учёта удалены', async () => {
    const b = build({
      recognized: {
        status: 'unavailable',
        text: null,
        reason: 'too-long',
      },
    });
    const r = await project(b);
    expect(r).toMatchObject({
      status: 'unavailable',
      transcript: null,
      intent: null,
      reason: 'too-long',
      reply: REPLIES.ru.transcriptTooLong,
    });
    expect(b.generateContent).not.toHaveBeenCalled();
    expect(b.blob.deleteBlob).toHaveBeenCalledWith(PPATH);
    expect(b.voiceUploads.forget).toHaveBeenCalledWith(PPATH);
  });

  it('распознавание недоступно, а потолок к этому времени исчерпан — ответ причиной потолка', async () => {
    const b = build({
      recognized: { status: 'unavailable', text: null },
      voiceRefusals: [null, exhausted()],
    });
    const r = await project(b);
    expect(r).toMatchObject({ status: 'budget-exhausted', reason: null });
  });

  it('распознавание недоступно при открытом входе — просто «недоступно»', async () => {
    const b = build({ recognized: { status: 'unavailable', text: null } });
    const r = await project(b);
    expect(r).toMatchObject({
      status: 'unavailable',
      reply: REPLIES.ru.unavailable,
    });
    expect(r.reason ?? null).toBeNull();
  });

  describe('K2 transcribe — за тем же входом', () => {
    const withTranscribe = (b: ReturnType<typeof build>) => {
      (b.greetingVoice as any).transcribe = jest.fn().mockResolvedValue({
        status: 'ok',
        text: 'серьёзнее',
        scriptMismatch: false,
        hints: ['ru'],
        language: null,
      });
      return (b.greetingVoice as any).transcribe as jest.Mock;
    };

    it('выключатель оператора — unavailable/operator-off без распознавания, запись удалена', async () => {
      const b = build({ guideOff: true });
      const transcribe = withTranscribe(b);
      const r = await b.service.transcribeForSession(SID, { pathname: SPATH });
      expect(r).toMatchObject({
        status: 'unavailable',
        text: null,
        reason: 'operator-off',
      });
      expect(transcribe).not.toHaveBeenCalled();
      expect(b.plans.assertCanSpendSession).not.toHaveBeenCalled();
      expect(b.blob.deleteBlob).toHaveBeenCalledWith(SPATH);
      expect(b.voiceUploads.forget).toHaveBeenCalledWith(SPATH);
    });

    it('потолок голоса — budget-exhausted, лимит аккаунта — account-limit', async () => {
      const cap = build({ voiceRefusals: [exhausted()] });
      withTranscribe(cap);
      expect(
        await cap.service.transcribeForSession(SID, { pathname: SPATH }),
      ).toMatchObject({ status: 'budget-exhausted' });
      const acc = build({
        planRefusal: new DailySpendLimitExceededException('лимит'),
      });
      withTranscribe(acc);
      expect(
        await acc.service.transcribeForSession(SID, { pathname: SPATH }),
      ).toMatchObject({ status: 'unavailable', reason: 'account-limit' });
    });

    it('вход открыт — распознавание, повтор и запасной путь спрашивают тот же вход', async () => {
      const b = build();
      const transcribe = withTranscribe(b);
      const r = await b.service.transcribeForSession(SID, { pathname: SPATH });
      expect(r).toMatchObject({ status: 'ok', text: 'серьёзнее' });
      const canSpendAgain = transcribe.mock
        .calls[0][2] as () => Promise<boolean>;
      await expect(canSpendAgain()).resolves.toBe(true);
      b.guide.available.mockResolvedValue(false);
      await expect(canSpendAgain()).resolves.toBe(false);
      expect(b.blob.deleteBlob).toHaveBeenCalledWith(SPATH);
    });

    it('потолок кончился между входом и расшифровкой (403 изнутри K2) — тот же 200 budget-exhausted, подсказки языка настоящие', async () => {
      const b = build();
      const transcribe = withTranscribe(b);
      transcribe.mockRejectedValue(exhausted());
      const r = await b.service.transcribeForSession(SID, { pathname: SPATH });
      expect(r).toEqual({
        status: 'budget-exhausted',
        text: null,
        scriptMismatch: false,
        hints: ['uk', 'ru'],
        language: null,
        reason: null,
      });
      const other = build();
      withTranscribe(other).mockRejectedValue(
        new ForbiddenException('приостановлено'),
      );
      await expect(
        other.service.transcribeForSession(SID, { pathname: SPATH }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('отказ входа — подсказки языка сессии, не пустой список', async () => {
      const b = build({ guideOff: true });
      withTranscribe(b);
      const r = await b.service.transcribeForSession(SID, { pathname: SPATH });
      expect(r.hints).toEqual(['uk', 'ru']);
    });

    it('удаление не удалось — строка учёта остаётся (оба finally)', async () => {
      const b = build({ guideOff: true });
      withTranscribe(b);
      b.blob.deleteBlob.mockResolvedValue(false);
      await b.service.transcribeForSession(SID, { pathname: SPATH });
      expect(b.blob.deleteBlob).toHaveBeenCalledWith(SPATH);
      expect(b.voiceUploads.forget).not.toHaveBeenCalled();

      const u = build();
      u.blob.deleteBlob.mockResolvedValue(false);
      await project(u);
      expect(u.blob.deleteBlob).toHaveBeenCalledWith(PPATH);
      expect(u.voiceUploads.forget).not.toHaveBeenCalled();
    });

    it('чужой путь — 400 до входа, запись не трогаем', async () => {
      const b = build();
      withTranscribe(b);
      await expect(
        b.service.transcribeForSession(SID, {
          pathname: 'sessions/other/voice-1.webm',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(b.guide.available).not.toHaveBeenCalled();
      expect(b.blob.deleteBlob).not.toHaveBeenCalled();
    });
  });

  it('upload-url брифа: запись длиннее минуты по размеру типа — 400, ссылки нет', async () => {
    const b = build();
    await expect(
      b.service.createProjectUploadUrl('u-1', PID, {
        fileName: 'a',
        fileSize: 5 * 1024 * 1024,
        mimeType: 'audio/mp4',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(b.blob.createUploadUrl).not.toHaveBeenCalled();
    expect(b.voiceUploads.remember).not.toHaveBeenCalled();
  });
});

describe('K4: вопрос о шаге и отказ по тону', () => {
  const inSession = (b: ReturnType<typeof build>) =>
    b.service.understandForSession(
      SID,
      { pathname: SPATH, screen: { step: 'video' } } as any,
      'ru',
    );

  it('вопрос в сессии — ответ из фактов ЕЁ состояния, не от модели', async () => {
    const b = build({
      recognized: { text: 'сколько ждать?' },
      model: {
        kind: 'question',
        topic: 'how-long',
        confidence: 0.9,
        // Модель «ответила» сама — это не должно дойти до человека.
        reply: 'Секунд десять, не больше!',
      },
      session: {
        id: SID,
        userId: 'u-1',
        locale: 'ru',
        greetingBriefSnapshot: snapshot(),
        generationPrompt: { moderationStatus: 'approved' },
        generatedVideo: { status: 'processing' },
      },
    });
    const r = await inSession(b);
    expect(r.intent).toEqual({
      kind: 'question',
      topic: 'how-long',
      answered: true,
    });
    expect(r.reply).toBe(
      'Ролик генерируется — обычно это занимает несколько минут.',
    );
    expect('refusal' in r).toBe(false);
  });

  it('вопрос до сессии — ответ по ЖИВОМУ брифу (CONTRACT5)', async () => {
    const b = build({
      recognized: { text: 'что дальше?' },
      model: { kind: 'question', topic: 'what-next', confidence: 0.9 },
    });
    const r = await project(b);
    expect(r.intent).toMatchObject({ kind: 'question', answered: true });
    // Бриф заполнен — дальше сессия, а не «заполните бриф».
    expect(r.reply).toMatch(/начните сессию/);

    const empty = build({
      brief: { ...BRIEF_ROW, recipientName: '' },
      recognized: { text: 'что дальше?' },
      model: { kind: 'question', topic: 'what-next', confidence: 0.9 },
    });
    expect((await project(empty)).reply).toBe('Назовите получателя.');
  });

  it('вопрос вне закрытого списка — «не знаю», answered: false', async () => {
    const b = build({
      recognized: { text: 'а сколько это стоит?' },
      model: { kind: 'question', topic: 'price', confidence: 0.9 },
    });
    const r = await project(b);
    expect(r.intent).toEqual({
      kind: 'question',
      topic: null,
      answered: false,
    });
    expect(r.reply).toBe(REPLIES.ru.questionUnknown);
  });

  it('отказ по тону — refusal: tone в ответе', async () => {
    const b = build({
      brief: { ...BRIEF_ROW, occasion: 'CONDOLENCE', tone: 'RESPECTFUL' },
      recognized: { text: 'сделай веселее' },
      model: { kind: 'command', command: 'tone-lighter', confidence: 0.9 },
    });
    const r = await project(b);
    expect(r).toMatchObject({
      status: 'ok',
      intent: { kind: 'unknown' },
      refusal: 'tone',
    });
  });
});
