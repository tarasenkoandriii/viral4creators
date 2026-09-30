/* eslint-disable @typescript-eslint/no-explicit-any -- тестовые двойники */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { HintAudioService, VOICE_BUDGET_EXHAUSTED } from './hint-audio.service';
import {
  DEFAULT_ASSISTANT_VOICE,
  hintAudioKey,
  hintAudioPathname,
  hintKeyBelongsTo,
  hintKeyLocale,
  mayVoiceInRegister,
  parseAssistantVoice,
  VOICE_ASSISTANT_VOICE_KEY,
} from './hint-audio';

const KEY = 'GREETING_VIDEO|brief|ru|stamp.e0|digest';
const HINT = 'Начните с повода — от него зависит тон ролика.';

function build(
  over: {
    globalOn?: boolean;
    project?: Record<string, unknown> | null;
    hint?: string | null;
    brief?: Record<string, unknown> | null;
    audioCached?: { url: string } | null;
    budgetThrows?: unknown;
    canSpend?: boolean;
    spentToday?: number;
    synthOk?: boolean;
    uploadThrows?: boolean;
    settings?: Record<string, string>;
    /** Голос провайдера по умолчанию со стенда; `null` — его нет. */
    defaultVoice?: string | null;
  } = {},
) {
  const prisma = {
    project: {
      findFirst: jest.fn().mockResolvedValue(
        over.project === undefined
          ? {
              type: 'GREETING_VIDEO',
              aiGuideEnabled: true,
              aiGuideVoice: true,
            }
          : over.project,
      ),
    },
    wizardHintCache: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          over.hint === null ? null : { hint: over.hint ?? HINT },
        ),
    },
    greetingBrief: {
      findUnique: jest.fn().mockResolvedValue(over.brief ?? null),
    },
    wizardHintAudio: {
      findUnique: jest.fn().mockResolvedValue(over.audioCached ?? null),
      update: jest.fn().mockResolvedValue({}),
      upsert: jest.fn().mockResolvedValue({}),
    },
  };
  const settings = {
    get: jest.fn(async (key: string) => over.settings?.[key] ?? null),
  };
  const aiUsage = {
    record: jest.fn().mockResolvedValue(undefined),
    spentTodayForOperation: jest.fn().mockResolvedValue(over.spentToday ?? 0),
  };
  const guide = {
    available: jest.fn().mockResolvedValue(over.globalOn ?? true),
  };
  const plan = {
    assertCanSpendUser: jest.fn(async () => {
      if (over.canSpend === false) throw new Error('заблокирован');
    }),
  };
  const provider = {
    providerKey: 'soniox',
    defaultVoice: jest.fn(() =>
      over.defaultVoice === null ? undefined : (over.defaultVoice ?? 'Maya'),
    ),
    synthesize: jest.fn(async (_req: any) =>
      over.synthOk === false
        ? { ok: false, skipped: true, reason: 'нет ключа' }
        : {
            ok: true,
            audio: Buffer.from('mp3'),
            mimeType: 'audio/mpeg',
            characters: HINT.length,
            durationSeconds: 2,
            voiceId: 'Maya',
            model: 'tts-rt-v2',
          },
    ),
  };
  const tts = { resolveByKey: jest.fn(() => provider) };
  const blob = {
    uploadBuffer: jest.fn(async (pathname: string) => {
      if (over.uploadThrows) throw new Error('Blob лёг');
      return { url: `https://blob/${pathname}` };
    }),
  };
  const voiceBudget = {
    assertCanSpendVoice: jest.fn(async () => {
      if (over.budgetThrows) throw over.budgetThrows;
    }),
  };
  const svc = new HintAudioService(
    prisma as any,
    settings as any,
    aiUsage as any,
    guide as any,
    plan as any,
    tts as any,
    blob as any,
    voiceBudget as any,
  );
  return { svc, prisma, aiUsage, provider, tts, blob, voiceBudget, settings };
}

describe('HintAudioService — голос советника (Greeting 2.0 §4А.4, K1)', () => {
  it('первый запрос синтезирует, пишет расход и кладёт файл в кеш', async () => {
    const { svc, provider, aiUsage, blob, prisma } = build();
    const r = await svc.audioFor('u1', 'p1', KEY);
    expect(r).toEqual({ url: expect.stringContaining('wizard-hint-audio/') });
    // Голос — разрешённый: умолчание провайдера со стенда, а не пусто.
    expect(provider.synthesize).toHaveBeenCalledWith({
      text: HINT,
      voiceId: 'Maya',
      language: 'ru',
    });
    expect(aiUsage.record).toHaveBeenCalledWith({
      operation: 'voice-assistant-tts',
      model: 'soniox-tts',
      userId: 'u1',
      characters: HINT.length,
    });
    expect(blob.uploadBuffer).toHaveBeenCalledTimes(1);
    expect(prisma.wizardHintAudio.upsert.mock.calls[0][0].create).toMatchObject(
      { hintKey: KEY, provider: 'soniox', voiceId: 'Maya', lang: 'ru' },
    );
  });

  it('попадание в аудиокеш не синтезирует второй раз', async () => {
    const { svc, provider, aiUsage, voiceBudget, prisma } = build({
      audioCached: { url: 'https://blob/готово.mp3' },
    });
    expect(await svc.audioFor('u1', 'p1', KEY)).toEqual({
      url: 'https://blob/готово.mp3',
    });
    expect(provider.synthesize).not.toHaveBeenCalled();
    expect(aiUsage.record).not.toHaveBeenCalled();
    // Готовый файл бесплатен — потолок голоса его не касается.
    expect(voiceBudget.assertCanSpendVoice).not.toHaveBeenCalled();
    // Выдача продлевает жизнь озвучке: уборка смотрит на `lastUsedAt`.
    expect(prisma.wizardHintAudio.update.mock.calls[0][0].data).toMatchObject({
      lastUsedAt: expect.any(Date),
    });
  });

  it('аудиокеш ищется по ключу подсказки + голосу + языку + тексту', async () => {
    const { svc, prisma } = build({
      settings: {
        [VOICE_ASSISTANT_VOICE_KEY]: '{"provider":"elevenlabs","voiceId":"v1"}',
      },
    });
    await svc.audioFor('u1', 'p1', KEY);
    expect(prisma.wizardHintAudio.findUnique.mock.calls[0][0].where.key).toBe(
      hintAudioKey({
        hintKey: KEY,
        provider: 'soniox', // двойник резолвера отдаёт один провайдер
        voiceId: 'v1',
        lang: 'ru',
        text: HINT,
      }),
    );
  });

  it('пустой голос в настройке — в ключе голос по умолчанию СО СТЕНДА', async () => {
    // Сменили `SONIOX_TTS_VOICE` — прежняя озвучка перестаёт отдаваться.
    const maya = build({ defaultVoice: 'Maya' });
    await maya.svc.audioFor('u1', 'p1', KEY);
    const max = build({ defaultVoice: 'Max' });
    await max.svc.audioFor('u1', 'p1', KEY);
    const keyOf = (b: ReturnType<typeof build>) =>
      b.prisma.wizardHintAudio.findUnique.mock.calls[0][0].where.key;
    expect(keyOf(maya)).toBe(
      hintAudioKey({
        hintKey: KEY,
        provider: 'soniox',
        voiceId: 'Maya',
        lang: 'ru',
        text: HINT,
      }),
    );
    expect(keyOf(max)).not.toBe(keyOf(maya));
  });

  it('голоса нет ни в настройке, ни на стенде — молчание без синтеза', async () => {
    const { svc, provider } = build({ defaultVoice: null });
    expect(await svc.audioFor('u1', 'p1', KEY)).toBeNull();
    expect(provider.synthesize).not.toHaveBeenCalled();
  });

  it('язык озвучки — из ключа подсказки, на нём написан текст', async () => {
    const { svc, provider, prisma } = build();
    await svc.audioFor('u1', 'p1', 'GREETING_VIDEO|brief|uk|s|d');
    expect(provider.synthesize.mock.calls[0][0]).toMatchObject({
      language: 'uk',
    });
    expect(prisma.wizardHintAudio.upsert.mock.calls[0][0].create.lang).toBe(
      'uk',
    );
  });

  it('ключ с незнакомым языком — молчание', async () => {
    const { svc, provider } = build();
    expect(
      await svc.audioFor('u1', 'p1', 'GREETING_VIDEO|brief|fr|s|d'),
    ).toBeNull();
    expect(provider.synthesize).not.toHaveBeenCalled();
  });

  it('потолок голоса исчерпан — синтеза нет, причина наружу', async () => {
    const { svc, provider, aiUsage } = build({
      budgetThrows: new ForbiddenException('Голос на сегодня исчерпан'),
    });
    expect(await svc.audioFor('u1', 'p1', KEY)).toEqual({
      url: null,
      reason: VOICE_BUDGET_EXHAUSTED,
    });
    expect(provider.synthesize).not.toHaveBeenCalled();
    expect(aiUsage.record).not.toHaveBeenCalled();
  });

  it('потолок голоса проверяется ДО синтеза', async () => {
    const { svc, provider, voiceBudget } = build();
    await svc.audioFor('u1', 'p1', KEY);
    expect(voiceBudget.assertCanSpendVoice).toHaveBeenCalledWith('u1');
    expect(
      voiceBudget.assertCanSpendVoice.mock.invocationCallOrder[0],
    ).toBeLessThan(provider.synthesize.mock.invocationCallOrder[0]);
  });

  it('сбой проверки потолка (не отказ) — молчание, а не синтез', async () => {
    const { svc, provider } = build({ budgetThrows: new Error('база') });
    expect(await svc.audioFor('u1', 'p1', KEY)).toBeNull();
    expect(provider.synthesize).not.toHaveBeenCalled();
  });

  it('голос выключен — 204 без единого платного вызова', async () => {
    const { svc, provider, prisma } = build({
      project: {
        type: 'GREETING_VIDEO',
        aiGuideEnabled: true,
        aiGuideVoice: false,
      },
    });
    expect(await svc.audioFor('u1', 'p1', KEY)).toBeNull();
    expect(provider.synthesize).not.toHaveBeenCalled();
    expect(prisma.wizardHintCache.findUnique).not.toHaveBeenCalled();
  });

  it('советник выключен — голос молчит, даже если столбец остался', async () => {
    const { svc, provider } = build({
      project: {
        type: 'GREETING_VIDEO',
        aiGuideEnabled: false,
        aiGuideVoice: true,
      },
    });
    expect(await svc.audioFor('u1', 'p1', KEY)).toBeNull();
    expect(provider.synthesize).not.toHaveBeenCalled();
  });

  it('глобальный рубильник советника выключен — молчание', async () => {
    const { svc, prisma } = build({ globalOn: false });
    expect(await svc.audioFor('u1', 'p1', KEY)).toBeNull();
    expect(prisma.project.findFirst).not.toHaveBeenCalled();
  });

  it('чужой проект — 404', async () => {
    const { svc } = build({ project: null });
    await expect(svc.audioFor('u1', 'p1', KEY)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('подсказки с таким ключом нет — молчание', async () => {
    const { svc, provider } = build({ hint: null });
    expect(await svc.audioFor('u1', 'p1', KEY)).toBeNull();
    expect(provider.synthesize).not.toHaveBeenCalled();
  });

  it('ключ чужого сценария — молчание, кеш подсказок не читается', async () => {
    const { svc, prisma } = build();
    expect(await svc.audioFor('u1', 'p1', 'CLIENT_SITE|url|ru|s|d')).toBeNull();
    expect(prisma.wizardHintCache.findUnique).not.toHaveBeenCalled();
  });

  it('траурный повод: праздничная реплика не звучит (§3.7)', async () => {
    const { svc, provider } = build({
      hint: 'Ура! Отличный выбор 🎉',
      brief: { occasion: 'OTHER', occasionRegister: 'MOURNING' },
    });
    expect(await svc.audioFor('u1', 'p1', KEY)).toBeNull();
    expect(provider.synthesize).not.toHaveBeenCalled();
  });

  it('траурный повод: спокойная реплика звучит', async () => {
    const { svc, provider } = build({
      brief: { occasion: 'OTHER', occasionRegister: 'MOURNING' },
    });
    expect(await svc.audioFor('u1', 'p1', KEY)).toMatchObject({
      url: expect.any(String),
    });
    expect(provider.synthesize).toHaveBeenCalled();
  });

  it('праздничный повод: та же бодрая реплика звучит', async () => {
    const { svc, provider } = build({
      hint: 'Ура! Отличный выбор 🎉',
      brief: { occasion: 'BIRTHDAY', occasionRegister: null },
    });
    await svc.audioFor('u1', 'p1', KEY);
    expect(provider.synthesize).toHaveBeenCalled();
  });

  it('заблокированный аккаунт не тратит на голос', async () => {
    const { svc, provider } = build({ canSpend: false });
    expect(await svc.audioFor('u1', 'p1', KEY)).toBeNull();
    expect(provider.synthesize).not.toHaveBeenCalled();
  });

  it('дневной бюджет советника исчерпан — голос молчит', async () => {
    const { svc, provider } = build({ spentToday: 99_000_000 });
    expect(await svc.audioFor('u1', 'p1', KEY)).toBeNull();
    expect(provider.synthesize).not.toHaveBeenCalled();
  });

  it('синтез не состоялся — молчание, расход не пишется', async () => {
    const { svc, aiUsage, blob } = build({ synthOk: false });
    expect(await svc.audioFor('u1', 'p1', KEY)).toBeNull();
    expect(aiUsage.record).not.toHaveBeenCalled();
    expect(blob.uploadBuffer).not.toHaveBeenCalled();
  });

  it('заливка сорвалась — расход всё равно записан, в кеш не легло', async () => {
    // Деньги у провайдера уже потрачены: потолок обязан их видеть.
    const { svc, aiUsage, prisma } = build({ uploadThrows: true });
    expect(await svc.audioFor('u1', 'p1', KEY)).toBeNull();
    expect(aiUsage.record).toHaveBeenCalled();
    expect(prisma.wizardHintAudio.upsert).not.toHaveBeenCalled();
  });
});

describe('hint-audio — чистые правила', () => {
  it('голос по умолчанию — Soniox со своим голосом', () => {
    expect(parseAssistantVoice(null)).toEqual(DEFAULT_ASSISTANT_VOICE);
    expect(DEFAULT_ASSISTANT_VOICE).toEqual({
      provider: 'soniox',
      voiceId: null,
    });
  });

  it('кривая настройка и «veo» — умолчание, а не падение', () => {
    expect(parseAssistantVoice('{не json')).toEqual(DEFAULT_ASSISTANT_VOICE);
    expect(parseAssistantVoice('{"provider":"veo"}')).toEqual(
      DEFAULT_ASSISTANT_VOICE,
    );
    expect(parseAssistantVoice('"soniox"')).toEqual(DEFAULT_ASSISTANT_VOICE);
  });

  it('настройка читается: провайдер и голос', () => {
    expect(
      parseAssistantVoice('{"provider":"resemble","voiceId":" abc "}'),
    ).toEqual({ provider: 'resemble', voiceId: 'abc' });
    expect(parseAssistantVoice('{"provider":"soniox","voiceId":""}')).toEqual({
      provider: 'soniox',
      voiceId: null,
    });
  });

  it('ключ озвучки меняется от провайдера, голоса, языка и ТЕКСТА', () => {
    const base = {
      hintKey: KEY,
      provider: 'soniox',
      voiceId: 'Maya',
      lang: 'ru',
      text: HINT,
    };
    const k = hintAudioKey(base);
    expect(hintAudioKey({ ...base, lang: 'uk' })).not.toBe(k);
    expect(hintAudioKey({ ...base, voiceId: 'Max' })).not.toBe(k);
    expect(hintAudioKey({ ...base, provider: 'resemble' })).not.toBe(k);
    // Строка кеша подсказки переписывается по тому же ключу свежим
    // текстом — звук вчерашнего текста не должен под ней звучать.
    expect(hintAudioKey({ ...base, text: 'другой текст' })).not.toBe(k);
    expect(hintAudioKey({ ...base })).toBe(k);
  });

  it('язык подсказки — третья часть её ключа', () => {
    expect(hintKeyLocale('GREETING_VIDEO|brief|uk|s|d')).toBe('uk');
    expect(hintKeyLocale('GREETING_VIDEO|brief|fr|s|d')).toBeNull();
    expect(hintKeyLocale('мусор')).toBeNull();
  });

  it('путь файла — под общим префиксом, расширение по типу', () => {
    expect(hintAudioPathname('abc', 'audio/mpeg')).toBe(
      'wizard-hint-audio/abc.mp3',
    );
    expect(hintAudioPathname('abc', 'audio/wav')).toBe(
      'wizard-hint-audio/abc.wav',
    );
  });

  it('ключ подсказки сверяется со сценарием целиком, а не префиксом слова', () => {
    expect(hintKeyBelongsTo('GREETING_VIDEO|brief', 'GREETING_VIDEO')).toBe(
      true,
    );
    expect(hintKeyBelongsTo('GREETING_VIDEOX|brief', 'GREETING_VIDEO')).toBe(
      false,
    );
  });

  it('регистр неизвестен — без ограничений; строгий — фильтр §3.7', () => {
    expect(mayVoiceInRegister(null, 'Ура!')).toBe(true);
    expect(mayVoiceInRegister('SENSITIVE', 'Ура!')).toBe(false);
    expect(mayVoiceInRegister('SENSITIVE', 'Спокойно заполните бриф.')).toBe(
      true,
    );
  });
});
