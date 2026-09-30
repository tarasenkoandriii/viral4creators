/* eslint-disable @typescript-eslint/no-explicit-any -- тестовые дублёры */
/**
 * Карточки сессии поздравления — волна CONTRACT6 (G-B2):
 *  - п.2: голос, музыка, наклейка, сцены и карточки не меняются, пока
 *    ролик считается (409 GREETING_CHANGE_DURING_RENDER, ничего не пишется);
 *  - п.3: голос персоны отправителем на Hedra без образа-ведущего — отказ
 *    с кодом; на Grok — оставлено.
 */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('@vercel/blob', () => ({ head: jest.fn() }));
jest.mock('axios');
jest.mock('../../config/configuration', () => ({
  loadConfiguration: jest.fn(() => ({ pixabay: { apiKey: 'test-key' } })),
}));

import { HttpException } from '@nestjs/common';
import { GreetingVoiceService } from './greeting-voice.service';
import { GreetingMusicService } from '../greeting-music/greeting-music.service';
import { GreetingStickerService } from '../greeting-sticker/greeting-sticker.service';
import { GreetingScenesService } from '../greeting-scenes/greeting-scenes.service';
import { GreetingCardsService } from '../greeting-cards/greeting-cards.service';
import { PERSONA_VOICE_NEEDS_PRESENTER_MESSAGE } from '../../common/greeting-persona';

const OLD_FLAG = process.env.PERSONA_ENABLED;
beforeEach(() => {
  process.env.PERSONA_ENABLED = 'true';
});
afterEach(() => {
  process.env.PERSONA_ENABLED = OLD_FLAG;
});

function sessionsWith(extra: Record<string, unknown>, brief = {}) {
  return {
    getSession: jest.fn().mockResolvedValue({
      sessionId: 's1',
      userId: 'u1',
      greetingBriefSnapshot: {
        occasion: 'BIRTHDAY',
        tone: 'WARM',
        recipientName: 'Аня',
        senderVoice: null,
        resolvedPresenterProvider: 'grok',
        presenter: null,
        ...brief,
      },
      ...extra,
    }),
    updateSession: jest.fn().mockResolvedValue(undefined),
    // Смена голоса пишется под замком 'prompt' (перештамповка сценария).
    claimWork: jest.fn().mockResolvedValue(true),
    releaseWork: jest.fn().mockResolvedValue(undefined),
  };
}

async function bodyOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    const ex = e as HttpException;
    return {
      status: ex.getStatus(),
      body: ex.getResponse() as { code?: string; message?: string },
    };
  }
  throw new Error('ожидался отказ');
}

const RENDERING = { generatedVideo: { status: 'processing' } };

describe('правка карточек во время рендера — 409 с кодом (CONTRACT6 п.2)', () => {
  const cases: Array<
    [string, (sessions: any, prisma: any) => Promise<unknown>]
  > = [
    [
      'голос: свой клон',
      (s, p) =>
        new GreetingVoiceService(p, s, {} as any, {} as any).select(
          's1',
          'clone-42',
        ),
    ],
    [
      'голос: пресет',
      (s, p) =>
        new GreetingVoiceService(p, s, {} as any, {} as any).selectPreset(
          's1',
          'eve',
        ),
    ],
    [
      'музыка: тема',
      (s) =>
        new GreetingMusicService(
          { get: jest.fn() } as any,
          s,
          {} as any,
          {} as any,
        ).select('s1', null),
    ],
    [
      'музыка: ссылка',
      (s) =>
        new GreetingMusicService(
          { get: jest.fn() } as any,
          s,
          {} as any,
          {} as any,
        ).selectLink('s1', {
          url: 'https://x/a.mp3',
          title: 't',
          rightsConfirmed: true,
        } as any),
    ],
    [
      'наклейка: снять',
      (s) => new GreetingStickerService(s, {} as any).clear('s1'),
    ],
    [
      'наклейка: сдвинуть',
      (s) =>
        new GreetingStickerService(s, {} as any).move('s1', 'top-left' as any),
    ],
    ['сцены', (s) => new GreetingScenesService(s).setCount('s1', 2)],
    ['карточки', (s) => new GreetingCardsService(s).update('s1', {} as any)],
  ];

  it.each(cases)('%s', async (_name, call) => {
    const sessions = sessionsWith(RENDERING);
    const prisma = { userVoice: { findFirst: jest.fn() } };
    const { status, body } = await bodyOf(call(sessions, prisma));
    expect(status).toBe(409);
    expect(body.code).toBe('GREETING_CHANGE_DURING_RENDER');
    expect(sessions.updateSession).not.toHaveBeenCalled();
    expect(prisma.userVoice.findFirst).not.toHaveBeenCalled();
  });

  it('готовый ролик правку не держит', async () => {
    const sessions = sessionsWith({ generatedVideo: { status: 'complete' } });
    await new GreetingScenesService(sessions as any).setCount('s1', 1);
    expect(sessions.updateSession).toHaveBeenCalled();
  });
});

describe('голос персоны на Hedra без образа (CONTRACT6 п.3)', () => {
  const PERSONA_ROW = {
    id: 'uv-p',
    label: 'Я',
    status: 'READY',
    resembleVoiceId: 'rv-p',
    personaId: 'p1',
  };

  it('Hedra без образа — 400 с кодом, ничего не пишется', async () => {
    const sessions = sessionsWith({}, { resolvedPresenterProvider: 'hedra' });
    const prisma = {
      userVoice: { findFirst: jest.fn().mockResolvedValue(PERSONA_ROW) },
    };
    const svc = new GreetingVoiceService(
      prisma as any,
      sessions as any,
      {} as any,
      {} as any,
    );
    const { status, body } = await bodyOf(svc.select('s1', 'rv-p'));
    expect(status).toBe(400);
    expect(body).toEqual({
      code: 'GREETING_PERSONA_VOICE_NEEDS_PRESENTER',
      message: PERSONA_VOICE_NEEDS_PRESENTER_MESSAGE,
    });
    expect(sessions.updateSession).not.toHaveBeenCalled();
  });

  it('Hedra с образом и Grok без образа — выбор проходит', async () => {
    for (const brief of [
      {
        resolvedPresenterProvider: 'hedra',
        presenter: { lookId: 'l1', url: 'u', variant: 'photo' },
      },
      { resolvedPresenterProvider: 'grok' },
    ]) {
      const sessions = sessionsWith({}, brief);
      const prisma = {
        userVoice: { findFirst: jest.fn().mockResolvedValue(PERSONA_ROW) },
      };
      const view = await new GreetingVoiceService(
        prisma as any,
        sessions as any,
        {} as any,
        {} as any,
      ).select('s1', 'rv-p');
      expect(view.senderVoice).toMatchObject({ personaVoice: true });
    }
  });

  it('обычный клон на Hedra без образа — можно (это не голос автора)', async () => {
    const sessions = sessionsWith({}, { resolvedPresenterProvider: 'hedra' });
    const prisma = {
      userVoice: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ ...PERSONA_ROW, personaId: null }),
      },
    };
    await new GreetingVoiceService(
      prisma as any,
      sessions as any,
      {} as any,
      {} as any,
    ).select('s1', 'rv-p');
    expect(sessions.updateSession).toHaveBeenCalled();
  });
});
