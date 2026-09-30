/* eslint-disable @typescript-eslint/no-explicit-any -- тестовые двойники */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { DailySpendLimitExceededException } from '../../common/spend-limits';
import { ProactiveSpeechService } from './proactive-speech.service';
import type { SpeakRequest } from './proactive-speech';
import { SOMBER_SPEECH_MAX } from './hint-audio';

function build(
  over: {
    scenario?: string | null;
    register?: string | null;
    session?: Record<string, unknown> | null;
    brief?: Record<string, unknown> | null;
    planThrows?: unknown;
    balance?: number;
    user?: Record<string, unknown> | null;
    wall?: boolean;
  } = {},
) {
  process.env.FREE_TIER_WALL_ENABLED = over.wall ? 'true' : 'false';
  const prisma = {
    session: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          over.session === null
            ? null
            : { data: over.session ?? {}, liveData: {} },
        ),
    },
    greetingBrief: {
      findUnique: jest.fn().mockResolvedValue(over.brief ?? null),
    },
    user: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          over.user === undefined
            ? { liteUnlockedAt: null, liteRevokedAt: null, subscription: null }
            : over.user,
        ),
    },
  };
  const audio = {
    voicedScenario: jest
      .fn()
      .mockResolvedValue(
        over.scenario === undefined ? 'GREETING_VIDEO' : over.scenario,
      ),
    registerOf: jest.fn().mockResolvedValue(over.register ?? null),
    synthesizeCached: jest.fn(async (_u: string, _p: string, spec: any) => ({
      url: `https://blob/${spec.cacheKey}`,
    })),
    synthesizeEphemeral: jest.fn(async () => ({
      url: 'https://blob/projects/p1/assistant-speech-rnd.mp3',
    })),
  };
  const plan = {
    assertCanSpendUser: jest.fn(async () => {
      if (over.planThrows) throw over.planThrows;
    }),
  };
  const credits = { balanceOf: jest.fn().mockResolvedValue(over.balance ?? 0) };
  const svc = new ProactiveSpeechService(
    prisma as any,
    audio as any,
    plan as any,
    credits as any,
  );
  // Все реплики в порядке синтеза: и через общий кеш, и личные.
  const spoken = () => [
    ...audio.synthesizeCached.mock.calls.map((c: any[]) => ({
      ...c[2],
      opts: c[3],
      at: 0,
    })),
    ...audio.synthesizeEphemeral.mock.calls.map((c: any[]) => ({
      ...c[2],
      ephemeral: true,
    })),
  ];
  return { svc, prisma, audio, plan, spoken };
}

const READY_SESSION = {
  greetingBriefSnapshot: {
    occasion: 'BIRTHDAY',
    recipientName: 'Мама',
    requestedResolution: '1080p',
    requestedPresenterProvider: 'grok',
  },
  generationPrompt: { moderationStatus: 'approved' },
};

const speak = (b: ReturnType<typeof build>, req: SpeakRequest) =>
  b.svc.speak('u1', 'p1', req);

describe('ProactiveSpeechService — повод проверяет сервер', () => {
  afterAll(() => {
    delete process.env.FREE_TIER_WALL_ENABLED;
  });

  it('голос выключен (или не поздравление) — молчание без чтения состояния', async () => {
    for (const scenario of [null, 'CLIENT_SITE']) {
      const b = build({ scenario });
      expect(await speak(b, { kind: 'video-ready', locale: 'ru' })).toBeNull();
      expect(b.prisma.session.findFirst).not.toHaveBeenCalled();
      expect(b.audio.synthesizeCached).not.toHaveBeenCalled();
    }
  });

  it('«ролик готов» — только если ролик правда готов', async () => {
    const pending = build({
      session: { ...READY_SESSION, generatedVideo: { status: 'processing' } },
    });
    expect(await speak(pending, { kind: 'video-ready', locale: 'ru' })).toBe(
      null,
    );
    const done = build({
      session: { ...READY_SESSION, generatedVideo: { status: 'complete' } },
    });
    expect(await speak(done, { kind: 'video-ready', locale: 'ru' })).toEqual({
      url: 'https://blob/speak|video-ready||ru',
    });
    expect(done.spoken()[0]).toMatchObject({
      text: 'Ролик готов. Его можно посмотреть и отправить.',
      lang: 'ru',
    });
  });

  it('ответ на вопрос — из фактов последней сессии', async () => {
    const b = build({
      session: { ...READY_SESSION, generatedVideo: { status: 'pending' } },
    });
    await speak(b, { kind: 'answer', topic: 'how-long', locale: 'ru' });
    expect(b.spoken()[0].text).toMatch(/генерируется — обычно/);
    expect(b.spoken()[0].cacheKey).toBe('speak|answer|how-long|ru');
  });

  it('проверка содержания — только если сценарий помечен', async () => {
    const clean = build({ session: READY_SESSION });
    expect(
      await speak(clean, {
        kind: 'refusal',
        refusal: 'moderation',
        locale: 'ru',
      }),
    ).toBeNull();
    const flagged = build({
      session: {
        ...READY_SESSION,
        generationPrompt: { moderationStatus: 'flagged' },
      },
    });
    await speak(flagged, {
      kind: 'refusal',
      refusal: 'moderation',
      locale: 'ru',
    });
    expect(flagged.spoken()[0].text).toMatch(/помечен/);
  });

  it('лимит — только если общий лимит отказывает именно суточным', async () => {
    const ok = build();
    expect(
      await speak(ok, { kind: 'refusal', refusal: 'quota', locale: 'ru' }),
    ).toBeNull();
    const other = build({ planThrows: new Error('заблокирован') });
    expect(
      await speak(other, { kind: 'refusal', refusal: 'quota', locale: 'ru' }),
    ).toBeNull();
    const daily = build({
      planThrows: new DailySpendLimitExceededException('лимит'),
    });
    await speak(daily, { kind: 'refusal', refusal: 'quota', locale: 'ru' });
    expect(daily.spoken()[0].text).toMatch(/Суточный лимит/);
  });

  it('стена — только если цена правда «закрыто»', async () => {
    const open = build({ wall: false });
    expect(
      await speak(open, { kind: 'refusal', refusal: 'locked', locale: 'ru' }),
    ).toBeNull();
    const walled = build({ wall: true, balance: 0 });
    await speak(walled, { kind: 'refusal', refusal: 'locked', locale: 'ru' });
    expect(walled.spoken()[0].text).toMatch(/нужен доступ/);
  });

  it('тон — доступные тоны повода из брифа', async () => {
    const b = build({
      brief: { occasion: 'CONDOLENCE', occasionRegister: null },
    });
    await speak(b, { kind: 'refusal', refusal: 'tone', locale: 'ru' });
    expect(b.spoken()[0].text).toMatch(/Подойдут: «/);
    expect(b.spoken()[0].text).not.toMatch(/С юмором/);
  });

  it('сводка: со сценарием, без ролика в работе и с ценой', async () => {
    const noScript = build({
      session: { ...READY_SESSION, generationPrompt: null },
    });
    expect(
      await speak(noScript, { kind: 'consent-summary', locale: 'ru' }),
    ).toBeNull();
    const running = build({
      session: { ...READY_SESSION, generatedVideo: { status: 'processing' } },
    });
    expect(
      await speak(running, { kind: 'consent-summary', locale: 'ru' }),
    ).toBeNull();
    const walledNoCredit = build({
      wall: true,
      balance: 0,
      session: READY_SESSION,
    });
    expect(
      await speak(walledNoCredit, { kind: 'consent-summary', locale: 'ru' }),
    ).toBeNull();

    const b = build({ session: READY_SESSION, balance: 2 });
    await speak(b, { kind: 'consent-summary', locale: 'ru' });
    const { text, ephemeral } = b.spoken()[0];
    expect(text).toMatch(/^Проверьте: Мама, День рождения, 1080p/);
    expect(text).toMatch(/одна генерация из 2 доступных/);
    // Имя получателя — только в личной реплике, мимо общего кеша.
    expect(ephemeral).toBe(true);
    expect(b.audio.synthesizeCached).not.toHaveBeenCalled();
  });

  it('упавший повтор после неудачи — сводка после FAILED возможна', async () => {
    const b = build({
      session: { ...READY_SESSION, generatedVideo: { status: 'failed' } },
    });
    expect(await speak(b, { kind: 'consent-summary', locale: 'ru' })).not.toBe(
      null,
    );
  });
});

describe('ProactiveSpeechService — регистр повода', () => {
  it('траурный: длинный отказ — коротко, первыми фразами', async () => {
    const b = build({
      register: 'MOURNING',
      session: {
        ...READY_SESSION,
        generationPrompt: { moderationStatus: 'flagged' },
      },
    });
    // Немецкая фраза целиком длиннее траурного предела.
    await speak(b, { kind: 'refusal', refusal: 'moderation', locale: 'de' });
    const text: string = b.spoken()[0].text;
    expect(text.length).toBeLessThanOrEqual(160);
    expect(text).toMatch(/markiert/);
    expect(text).not.toMatch(/hilft nicht/);
    const festive = build({
      session: {
        ...READY_SESSION,
        generationPrompt: { moderationStatus: 'flagged' },
      },
    });
    await speak(festive, {
      kind: 'refusal',
      refusal: 'moderation',
      locale: 'de',
    });
    expect(festive.spoken()[0].text).toMatch(/hilft nicht/);
  });

  it('траурный: сводка перед согласием не режется — цена остаётся', async () => {
    const b = build({
      register: 'MOURNING',
      session: {
        ...READY_SESSION,
        greetingBriefSnapshot: {
          ...READY_SESSION.greetingBriefSnapshot,
          occasion: 'CONDOLENCE',
          recipientName: 'Валентина Петровна и вся семья',
          requestedPresenterProvider: 'hedra',
        },
      },
      balance: 1,
    });
    // Немецкая сводка длиннее траурного предела — и всё равно целиком.
    await speak(b, { kind: 'consent-summary', locale: 'de' });
    const text: string = b.spoken()[0].text;
    expect(text.length).toBeGreaterThan(SOMBER_SPEECH_MAX);
    expect(text).toMatch(/Verbrauch: eine Generierung/);
    expect(text).toMatch(/„generieren“\.$/);
  });
});

describe('ProactiveSpeechService — CONTRACT5', () => {
  afterAll(() => {
    delete process.env.FREE_TIER_WALL_ENABLED;
  });

  it('лимит озвучивается мимо общего лимита; прочие отказы — с ним', async () => {
    const daily = build({
      planThrows: new DailySpendLimitExceededException('лимит'),
    });
    await speak(daily, { kind: 'refusal', refusal: 'quota', locale: 'ru' });
    expect(daily.spoken()[0].opts).toEqual({ skipUserSpend: true });

    const b = build({
      brief: { occasion: 'CONDOLENCE', occasionRegister: null },
    });
    await speak(b, { kind: 'refusal', refusal: 'tone', locale: 'ru' });
    expect(b.spoken()[0].opts).toEqual({ skipUserSpend: false });
  });

  it('вопрос без темы — «не знаю, посмотрите справку» вслух', async () => {
    const b = build();
    await speak(b, { kind: 'answer', topic: null, locale: 'uk' });
    expect(b.spoken()[0]).toMatchObject({
      text: 'Цього я не знаю. Перегляньте довідку.',
      cacheKey: 'speak|answer|unknown|uk',
    });
  });

  it('вопрос до сессии — по живому брифу проекта', async () => {
    const b = build({
      session: null,
      brief: {
        occasion: 'BIRTHDAY',
        customOccasionText: null,
        recipientName: 'Мама',
        senderName: null,
        presenterProvider: 'grok',
        presenterLookId: null,
      },
    });
    await speak(b, { kind: 'answer', topic: 'what-next', locale: 'ru' });
    expect(b.spoken()[0].text).toMatch(/начните сессию/);
  });

  it('сводка: ведущий-персона — «вы в кадре»; длинное имя — не длиннее 60 знаков', async () => {
    const longName = 'Дорогая '.repeat(20).trim();
    const b = build({
      session: {
        ...READY_SESSION,
        greetingBriefSnapshot: {
          ...READY_SESSION.greetingBriefSnapshot,
          recipientName: longName,
          requestedPresenterProvider: 'hedra',
          presenter: { lookId: 'look-1', label: 'Я' },
        },
      },
      balance: 1,
    });
    await speak(b, { kind: 'consent-summary', locale: 'ru' });
    const text: string = b.spoken()[0].text;
    expect(text).toMatch(/вы в кадре/);
    expect(text).not.toMatch(/Hedra/);
    const said = text.slice('Проверьте: '.length, text.indexOf(', День'));
    expect(said.length).toBeLessThanOrEqual(60);
    expect(said.endsWith('…')).toBe(true);
    expect(text).not.toContain(longName);
  });
});
