jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('axios');

import axios from 'axios';
import { encryptToken } from '../../common/token-crypto';
import { YoutubeUnlockService } from './youtube-unlock.service';

// 32 байта — валидный CHANNEL_TOKEN_KEY, тем же способом, что в
// `token-crypto.spec.ts`: короткая сессия шифруется тем же ключом, что
// токены каналов публикации, и без него сервис честно отказывается
// работать.
const KEY = Buffer.from('0123456789abcdef0123456789abcdef')
  .subarray(0, 32)
  .toString('base64');

jest.mock('../../config/configuration', () => ({
  loadConfiguration: () => ({
    publishing: { channelTokenKey: KEY_HOLDER.value },
  }),
}));
const KEY_HOLDER = { value: '' };

const mockedAxios = axios as jest.Mocked<typeof axios>;

/**
 * Проверка подписки на наш YouTube-канал (этап 140).
 *
 * Здесь проверяются два решения, которые дороже всего ошибиться:
 * у кого уже есть подходящее право — второго экрана согласия не
 * показываем (это конверсия воронки, ради которой всё и делается), а
 * «спросить не удалось» никогда не превращается в «не подписан».
 */
beforeAll(() => {
  KEY_HOLDER.value = KEY;
});

function build(
  over: {
    channel?: { id: string; externalId: string } | null;
    freshToken?: unknown;
    session?: {
      accessTokenEnc: string;
      googleChannelId: string;
      expiresAt: Date;
    } | null;
  } = {},
) {
  const prisma = {
    publishingChannel: {
      findFirst: jest.fn().mockResolvedValue(over.channel ?? null),
      count: jest.fn().mockResolvedValue(over.channel ? 1 : 0),
    },
    youtubeUnlockSession: {
      findUnique: jest.fn().mockResolvedValue(over.session ?? null),
      upsert: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const google = {
    configured: jest.fn().mockReturnValue(true),
    buildUnlockAuthUrl: jest.fn().mockReturnValue('https://accounts.google/x'),
    exchangeUnlockCode: jest.fn().mockResolvedValue({ accessToken: 'at' }),
    fetchChannelInfo: jest.fn().mockResolvedValue({ externalId: 'UC1' }),
  };
  const channels = {
    ensureFreshToken:
      over.freshToken === undefined
        ? jest.fn().mockResolvedValue({ accessToken: 'connected-at' })
        : jest.fn().mockRejectedValue(over.freshToken),
  };
  const svc = new YoutubeUnlockService(
    prisma as never,
    google as never,
    channels as never,
  );
  return { svc, prisma, google, channels };
}

describe('YoutubeUnlockService.tokenFor', () => {
  it('у кого канал подключён — берём его право, без второго согласия', async () => {
    // `publishing-channel` просит `youtube.readonly` уже сейчас: у
    // такого человека нужный грант есть, и лишний экран согласия стоит
    // дороже, чем код, который его обходит.
    const { svc, prisma } = build({
      channel: { id: 'ch1', externalId: 'UC-owner' },
    });
    const source = await svc.tokenFor('u1');
    expect(source).toEqual({
      accessToken: 'connected-at',
      googleChannelId: 'UC-owner',
      fromConnectedChannel: true,
    });
    // До короткой сессии дело не доходит вовсе.
    expect(prisma.youtubeUnlockSession.findUnique).not.toHaveBeenCalled();
  });

  it('отозванный грант канала не отменяет обычный вход', async () => {
    const { svc } = build({
      channel: { id: 'ch1', externalId: 'UC-owner' },
      freshToken: new Error('revoked'),
      session: {
        accessTokenEnc: encryptToken('short-at', KEY),
        googleChannelId: 'UC2',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const source = await svc.tokenFor('u1');
    expect(source?.fromConnectedChannel).toBe(false);
    expect(source?.googleChannelId).toBe('UC2');
  });

  it('истёкшая короткая сессия стирается тут же, а не ждёт суточной уборки', async () => {
    // Приёмка этапа обещает: через десять минут запись входа исчезает
    // сама. Держать зашифрованный чужой токен лишние часы только
    // потому, что крон ходит раз в сутки, — не то, что мы обещали.
    const { svc, prisma } = build({
      session: {
        accessTokenEnc: 'enc',
        googleChannelId: 'UC2',
        expiresAt: new Date(Date.now() - 1),
      },
    });
    expect(await svc.tokenFor('u1')).toBeNull();
    expect(prisma.youtubeUnlockSession.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'u1' },
    });
  });

  it('истёкшая короткая сессия — как будто её нет', async () => {
    // Десять минут это обещание, а не украшение: просроченным токеном
    // ходить к Google мы не будем.
    const { svc } = build({
      session: {
        accessTokenEnc: 'enc',
        googleChannelId: 'UC2',
        expiresAt: new Date(Date.now() - 1),
      },
    });
    expect(await svc.tokenFor('u1')).toBeNull();
  });

  it('ни канала, ни сессии — null, входить надо', async () => {
    expect(await build().svc.tokenFor('u1')).toBeNull();
  });
});

describe('YoutubeUnlockService.check', () => {
  const withChannel = (fn: () => Promise<void>) => async () => {
    process.env.YOUTUBE_UNLOCK_CHANNEL_ID = 'UC-ours';
    try {
      await fn();
    } finally {
      delete process.env.YOUTUBE_UNLOCK_CHANNEL_ID;
      delete process.env.YOUTUBE_UNLOCK_VIDEO_ID;
    }
  };

  beforeEach(() => mockedAxios.get.mockReset());

  it(
    'подписка найдена — спрашиваем ровно про наш канал, одним вызовом',
    withChannel(async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: { items: [{ id: 's1' }] },
      });
      const { svc } = build();
      expect(await svc.check('at')).toBe('YOUTUBE_SUBSCRIPTION');
      // `forChannelId` — это и есть «одна единица квоты вместо выгрузки
      // всех подписок человека».
      expect(mockedAxios.get.mock.calls[0][1]).toMatchObject({
        params: { mine: 'true', forChannelId: 'UC-ours' },
      });
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    }),
  );

  it(
    'подписки нет, а лайк есть — засчитываем лайк',
    withChannel(async () => {
      process.env.YOUTUBE_UNLOCK_VIDEO_ID = 'vid1';
      mockedAxios.get
        .mockResolvedValueOnce({ data: { items: [] } })
        .mockResolvedValueOnce({ data: { items: [{ rating: 'like' }] } });
      const { svc } = build();
      expect(await svc.check('at')).toBe('YOUTUBE_VIDEO_LIKE');
    }),
  );

  it(
    'подписки нет и ролик не задан — второго вызова не делаем',
    withChannel(async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: { items: [] } });
      const { svc } = build();
      expect(await svc.check('at')).toBe(false);
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    }),
  );

  it(
    'Google не ответил — null, и это НЕ «не подписан»',
    withChannel(async () => {
      // Отказать подписчику из-за нашей же неполадки — худший исход, и
      // различать эти два случая обязан сам сервис.
      mockedAxios.get.mockRejectedValueOnce(new Error('503'));
      const { svc } = build();
      expect(await svc.check('at')).toBeNull();
    }),
  );

  it('канал не настроен — способ выключен, в сеть не ходим', async () => {
    const { svc } = build();
    expect(await svc.check('at')).toBe(false);
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });
});

/**
 * Дешёвая проверка «есть ли чем проверять» (аудит этапа 140).
 *
 * Кабинет открывают часто, и `tokenFor` в нём был плохим выбором: у
 * человека с подключённым каналом он идёт обновлять токен в Google — на
 * каждом открытии страницы. Здесь проверяется, что этого больше не
 * происходит.
 */
describe('YoutubeUnlockService.hasSource', () => {
  it('подключённый канал — готовы, и в Google за этим не ходим', async () => {
    const { svc, channels, prisma } = build({
      channel: { id: 'ch1', externalId: 'UC-owner' },
    });
    expect(await svc.hasSource('u1')).toEqual({
      ready: true,
      viaConnectedChannel: true,
    });
    expect(channels.ensureFreshToken).not.toHaveBeenCalled();
    // И до короткой сессии дело не доходит: канал уже ответил на вопрос.
    expect(prisma.youtubeUnlockSession.findUnique).not.toHaveBeenCalled();
  });

  it('живая короткая сессия — готовы, но не через канал', async () => {
    const { svc } = build({
      session: {
        accessTokenEnc: 'enc',
        googleChannelId: 'UC2',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    expect(await svc.hasSource('u1')).toEqual({
      ready: true,
      viaConnectedChannel: false,
    });
  });

  it('истёкшая сессия — не готовы', async () => {
    const { svc } = build({
      session: {
        accessTokenEnc: 'enc',
        googleChannelId: 'UC2',
        expiresAt: new Date(Date.now() - 1),
      },
    });
    expect((await svc.hasSource('u1')).ready).toBe(false);
  });

  it('ни того, ни другого — не готовы', async () => {
    expect((await build().svc.hasSource('u1')).ready).toBe(false);
  });
});
