/**
 * Подтверждение подписки — «Условно бесплатный Lite» §6, этап 133.
 *
 * Здесь начисляются настоящие деньги продукта, поэтому проверки не про
 * «работает ли метод», а про три места, где ошибка стоит дорого: выдать
 * генерацию тому, чью подписку мы не подтвердили; отказать подписчику
 * из-за собственной неполадки; позволить одному аккаунту открыть доступ
 * многим.
 */

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  InviteService,
  SUBSCRIPTION_ACCOUNT_TAKEN,
  YOUTUBE_NOT_SUBSCRIBED,
  YOUTUBE_SIGN_IN_REQUIRED,
} from './invite.service';
import { LiteUnlockService } from './lite-unlock.service';

function build(
  over: {
    member?: boolean | null;
    existingCheck?: boolean;
    createThrows?: unknown;
    balance?: number;
    granted?: boolean;
    channel?: string | null;
    identifiedCount?: number;
    generatedCount?: number;
    invitees?: { status: string; revokedAt: Date | null; identifiedAt: Date }[];
    visitCount?: number;
    /** Этап 140: способ через YouTube. Не задан — способ выключен. */
    youtube?: {
      channelId?: string | null;
      videoId?: string | null;
      token?: {
        accessToken: string;
        googleChannelId: string;
        fromConnectedChannel: boolean;
      } | null;
      check?: 'YOUTUBE_SUBSCRIPTION' | 'YOUTUBE_VIDEO_LIKE' | false | null;
    };
  } = {},
) {
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue({
        telegramId: '777',
        liteUnlockedAt: null,
        liteRevokedAt: null,
        unlockCheck: over.existingCheck ? { id: 'c1' } : null,
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    referral: {
      // Воронка считается ЗАПРОСАМИ (аудит этапа 134): длина списка
      // ниже обрезана полусотней и воронкой быть не может.
      count: jest.fn(async ({ where }: { where: { status?: string } }) =>
        where.status === 'GENERATED'
          ? (over.generatedCount ?? 0)
          : (over.identifiedCount ?? 0),
      ),
      findMany: jest.fn().mockResolvedValue(over.invitees ?? []),
    },
    referralCode: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ visitCount: over.visitCount ?? 0 }),
    },
    youtubeUnlockSession: {
      findUnique: jest.fn().mockResolvedValue(null),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    unlockCheck: {
      findUnique: jest
        .fn()
        .mockResolvedValue(over.existingCheck ? { id: 'c1' } : null),
      create: over.createThrows
        ? jest.fn().mockRejectedValue(over.createThrows)
        : jest.fn().mockResolvedValue({ id: 'c1' }),
    },
  };
  const credits = {
    balanceOf: jest.fn().mockResolvedValue(over.balance ?? 0),
    grantFree: jest.fn().mockResolvedValue(over.granted ?? true),
  };
  const telegram = {
    channel: jest
      .fn()
      .mockReturnValue(over.channel === undefined ? '@v4c' : over.channel),
    configured: jest.fn().mockReturnValue(over.channel !== null),
    // `??` здесь нельзя: `null` — это осмысленное значение «спросить не
    // удалось», и `null ?? true` превратил бы его в «подписан», то есть
    // тест про 503 проверял бы счастливый путь.
    isMember: jest
      .fn()
      .mockResolvedValue('member' in over ? over.member : true),
  };
  const referrals = {
    codeOf: jest.fn().mockResolvedValue('ABCD2345'),
    settlePending: jest.fn().mockResolvedValue(undefined),
  };
  const liteUnlock = new LiteUnlockService(prisma as never);
  // Этап 140: способ через YouTube по умолчанию выключен — старые тесты
  // про Telegram не должны о нём знать вовсе.
  const youtube = {
    configured: jest.fn().mockReturnValue(over.youtube !== undefined),
    channelId: jest.fn().mockReturnValue(over.youtube?.channelId ?? null),
    videoId: jest.fn().mockReturnValue(over.youtube?.videoId ?? null),
    tokenFor: jest.fn().mockResolvedValue(over.youtube?.token ?? null),
    // Кабинет спрашивает именно это — дешёвую проверку без похода в
    // Google (аудит этапа 140).
    hasSource: jest.fn().mockResolvedValue({
      ready: !!over.youtube?.token,
      viaConnectedChannel: over.youtube?.token?.fromConnectedChannel ?? false,
    }),
    // `??` здесь нельзя ровно по той же причине, что у `isMember`
    // выше: `null` — это осмысленное «спросить не удалось», и
    // `null ?? false` превратил бы его в «не подписан», то есть тест
    // про 503 проверял бы отказ.
    check: jest
      .fn()
      .mockResolvedValue(
        over.youtube && 'check' in over.youtube ? over.youtube.check : false,
      ),
    forget: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new InviteService(
    prisma as never,
    credits as never,
    telegram as never,
    referrals as never,
    liteUnlock,
    youtube as never,
  );
  return { svc, prisma, credits, telegram, referrals, liteUnlock, youtube };
}

describe('InviteService.confirmTelegram', () => {
  it('подписчик — строка записана и генерация начислена', async () => {
    const { svc, prisma, credits } = build();
    await svc.confirmTelegram('u1');
    expect(prisma.unlockCheck.create).toHaveBeenCalledWith({
      data: {
        userId: 'u1',
        kind: 'TELEGRAM_CHANNEL',
        externalAccountId: 'tg:777',
      },
    });
    expect(credits.grantFree).toHaveBeenCalledWith('u1', 'SUBSCRIPTION');
  });

  it('не подписан — отказ, и ни строки, ни начисления', async () => {
    const { svc, prisma, credits } = build({ member: false });
    await expect(svc.confirmTelegram('u1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.unlockCheck.create).not.toHaveBeenCalled();
    expect(credits.grantFree).not.toHaveBeenCalled();
  });

  it('Telegram не ответил — 503, а не отказ подписчику', async () => {
    // «Спросить не удалось» и «не подписан» — разные вещи, и цена
    // ошибки разная: отказать подписчику из-за нашей неполадки хуже,
    // чем попросить повторить.
    const { svc, credits } = build({ member: null });
    await expect(svc.confirmTelegram('u1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(credits.grantFree).not.toHaveBeenCalled();
  });

  it('повторное подтверждение — 409, второй генерации нет', async () => {
    const { svc, credits } = build({ existingCheck: true });
    await expect(svc.confirmTelegram('u1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(credits.grantFree).not.toHaveBeenCalled();
  });

  it('тем же аккаунтом уже подтверждали другому — 409', async () => {
    // Иначе один Telegram-аккаунт открывает доступ любому числу
    // пользователей, и подтверждение перестаёт что-либо значить.
    const { svc, credits } = build({ createThrows: { code: 'P2002' } });
    await expect(svc.confirmTelegram('u1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(credits.grantFree).not.toHaveBeenCalled();
  });

  it('сначала спрашиваем Telegram, потом пишем и начисляем', async () => {
    // Обратный порядок означал бы начисление тому, чью подписку мы не
    // подтвердили, — а откатить кредит нечем: человек успеет потратить.
    const order: string[] = [];
    const { svc, prisma, credits, telegram } = build();
    telegram.isMember.mockImplementation(async () => {
      order.push('ask');
      return true;
    });
    prisma.unlockCheck.create.mockImplementation(async () => {
      order.push('write');
      return { id: 'c1' };
    });
    credits.grantFree.mockImplementation(async () => {
      order.push('grant');
      return true;
    });
    await svc.confirmTelegram('u1');
    expect(order).toEqual(['ask', 'write', 'grant']);
  });

  it('способ не настроен на стенде — внятный отказ, а не падение', async () => {
    const { svc } = build({ channel: null });
    await expect(svc.confirmTelegram('u1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('предохранитель не дал начислить — подтверждение всё равно засчитано', async () => {
    // Строка о подписке уже есть; отказывать человеку за наш же
    // суточный потолок не за что, начисление догонит его назавтра.
    const { svc } = build({ granted: false });
    await expect(svc.confirmTelegram('u1')).resolves.toBeDefined();
  });
});

describe('InviteService.stateOf', () => {
  it('отдаёт баланс, подписку и канал одним запросом экрана', async () => {
    const { svc } = build({ balance: 2 });
    const state = await svc.stateOf('u1');
    expect(state.generationsAvailable).toBe(2);
    expect(state.subscription.telegramChannel).toBe('@v4c');
    expect(state.subscription.confirmed).toBe(false);
  });

  it('отрицательный баланс на экран не уходит', async () => {
    // Баланс — сумма дельт, и уйти в минус он теоретически может
    // (возврат после ручной правки оператором). «−1 генерация» на
    // экране — это вопрос в поддержку, а не информация.
    const { svc } = build({ balance: -1 });
    await expect(svc.stateOf('u1')).resolves.toMatchObject({
      generationsAvailable: 0,
    });
  });
});

/**
 * Находки аудита этапа 133.
 */
describe('InviteService — находки аудита', () => {
  it('платящему экран не врёт, что лимит не снят', async () => {
    // Стена подписчика не касается вовсе, а `unlocked` читался без
    // подписки — и кабинет сообщал ему, что лимит на месте.
    const { svc, prisma } = build();
    prisma.user.findUnique.mockResolvedValue({
      telegramId: '777',
      liteUnlockedAt: null,
      liteRevokedAt: null,
      unlockCheck: null,
      subscription: {
        status: 'ACTIVE',
        currentPeriodEnd: new Date(Date.now() + 86_400_000),
      },
    });
    await expect(svc.stateOf('u1')).resolves.toMatchObject({ unlocked: true });
  });

  it('два быстрых нажатия — «уже подтверждено», а не «аккаунт занят»', async () => {
    // Оба сообщения приходят из одного P2002, но означают разное:
    // своё повторное нажатие и чужой аккаунт. Сказать не то — отправить
    // человека разбираться не туда.
    const { svc, prisma } = build({ createThrows: { code: 'P2002' } });
    prisma.unlockCheck.findUnique
      .mockResolvedValueOnce(null) // проверка перед запросом в Telegram
      .mockResolvedValueOnce({ id: 'c1' }); // разбор P2002: строка своя
    await expect(svc.confirmTelegram('u1')).rejects.toThrow(
      /уже подтверждена/i,
    );
  });

  it('чужой аккаунт — «этим аккаунтом уже подтверждали»', async () => {
    const { svc, prisma } = build({ createThrows: { code: 'P2002' } });
    prisma.unlockCheck.findUnique.mockResolvedValue(null);
    await expect(svc.confirmTelegram('u1')).rejects.toThrow(/этим аккаунтом/i);
  });
});

describe('InviteService.stateOf — способ через YouTube (этап 140)', () => {
  it('открытие кабинета НЕ ходит за токеном в Google', async () => {
    // Аудит этапа: `tokenFor` у человека с подключённым каналом зовёт
    // `ensureFreshToken`, а тот при протухшем токене идёт обновлять его
    // в Google. Экран, который просто показывает кнопку, не должен
    // ради этого ходить в чужой сервис.
    const { svc, youtube } = build({
      youtube: {
        channelId: 'UC-ours',
        token: {
          accessToken: 'at',
          googleChannelId: 'UC1',
          fromConnectedChannel: true,
        },
      },
    });

    const state = await svc.stateOf('u1');

    expect(youtube.hasSource).toHaveBeenCalledWith('u1');
    expect(youtube.tokenFor).not.toHaveBeenCalled();
    expect(state.subscription.youtube).toMatchObject({
      available: true,
      ready: true,
      viaConnectedChannel: true,
    });
  });

  it('способ выключен — кабинет о нём даже не спрашивает', async () => {
    const { svc, youtube } = build();
    const state = await svc.stateOf('u1');
    expect(youtube.hasSource).not.toHaveBeenCalled();
    expect(state.subscription.youtube.available).toBe(false);
    expect(state.subscription.youtube.ready).toBe(false);
  });

  it('своя же неполадка не закрывает кабинет', async () => {
    const { svc, youtube } = build({ youtube: { channelId: 'UC-ours' } });
    youtube.hasSource.mockRejectedValue(new Error('база молчит'));
    await expect(svc.stateOf('u1')).resolves.toMatchObject({
      subscription: { youtube: { ready: false } },
    });
  });
});

describe('InviteService.stateOf — кабинет (правки аудита этапа 134)', () => {
  it('воронка считается счётчиками, а не обрезанным списком', async () => {
    // Список приглашённых обрезан полусотней. Первая редакция считала
    // воронку по нему же — и человеку с шестьюдесятью приглашёнными на
    // экране навсегда стояло «50 вошли».
    const invitees = Array.from({ length: 50 }, () => ({
      status: 'GENERATED',
      revokedAt: null,
      identifiedAt: new Date(),
    }));
    const { svc } = build({
      identifiedCount: 60,
      generatedCount: 21,
      visitCount: 130,
      invitees,
    });
    const state = await svc.stateOf('u1');
    expect(state.referrals.funnel).toEqual({
      visited: 130,
      identified: 60,
      generated: 21,
    });
    expect(state.referrals.invitees).toHaveLength(50);
  });

  it('открытие кабинета догоняет отложенные начисления', async () => {
    // §12.3 и §5.4 обещают «начисление придёт назавтра». До аудита
    // обещание не выполнял никто: строка о подтверждении уже есть,
    // значит повторная попытка отказывает раньше начисления.
    const { svc, credits, referrals } = build({ existingCheck: true });
    await svc.stateOf('u1');
    expect(credits.grantFree).toHaveBeenCalledWith('u1', 'SUBSCRIPTION');
    expect(referrals.settlePending).toHaveBeenCalledWith('u1');
  });

  it('без подтверждённой подписки догон её не начисляет', async () => {
    const { svc, credits } = build({ existingCheck: false });
    await svc.stateOf('u1');
    expect(credits.grantFree).not.toHaveBeenCalled();
  });

  it('упавший догон не закрывает человеку кабинет', async () => {
    // Догон — это уборка за нашими же потолками. Не дать из-за неё
    // открыть экран значило бы наказать человека дважды.
    const { svc, referrals } = build();
    referrals.settlePending.mockRejectedValue(new Error('база молчит'));
    await expect(svc.stateOf('u1')).resolves.toMatchObject({
      referrals: { code: 'ABCD2345' },
    });
  });

  it('счётчик переходов читается тем же обращением, что и код', async () => {
    // До аудита за ним ходили вторым запросом, уже после Promise.all, —
    // лишний круг к базе на каждое открытие кабинета.
    const { svc, prisma } = build({ visitCount: 7 });
    const state = await svc.stateOf('u1');
    expect(state.referrals.funnel.visited).toBe(7);
    expect(prisma.referralCode.findUnique).toHaveBeenCalledTimes(1);
  });
});

/**
 * Подтверждение через YouTube (этап 140). Порядок ходов тот же, что у
 * Telegram-способа, и проверяется здесь по той же причине: между
 * «спросили Google» и «начислили генерацию» нельзя переставить ни шага
 * — откатывать кредит нечем, человек успеет его потратить.
 */
describe('InviteService.confirmYoutube', () => {
  const token = {
    accessToken: 'at',
    googleChannelId: 'UC123',
    fromConnectedChannel: false,
  };

  it('подписка подтверждена: строка с каналом Google и начисленная генерация', async () => {
    const { svc, prisma, credits, youtube } = build({
      youtube: { token, check: 'YOUTUBE_SUBSCRIPTION' },
    });

    await svc.confirmYoutube('u1');

    expect(prisma.unlockCheck.create).toHaveBeenCalledWith({
      data: {
        userId: 'u1',
        kind: 'YOUTUBE_SUBSCRIPTION',
        // Префикс отличает канал Google от Telegram-идентификатора:
        // без него два разных мира могли бы совпасть числом.
        externalAccountId: 'yt:UC123',
      },
    });
    expect(credits.grantFree).toHaveBeenCalledWith('u1', 'SUBSCRIPTION');
    // Токен после проверки не хранится — мы и не обещали.
    expect(youtube.forget).toHaveBeenCalledWith('u1');
  });

  it('лайк засчитывается своим видом, а не подписки', async () => {
    const { svc, prisma } = build({
      youtube: { token, check: 'YOUTUBE_VIDEO_LIKE' },
    });
    await svc.confirmYoutube('u1');
    expect(prisma.unlockCheck.create.mock.calls[0][0].data.kind).toBe(
      'YOUTUBE_VIDEO_LIKE',
    );
  });

  it('право взято у подключённого канала — его вход не трогаем', async () => {
    // Он живёт своей жизнью: человек подключал канал не для этого.
    const { svc, youtube } = build({
      youtube: {
        token: { ...token, fromConnectedChannel: true },
        check: 'YOUTUBE_SUBSCRIPTION',
      },
    });
    await svc.confirmYoutube('u1');
    expect(youtube.forget).not.toHaveBeenCalled();
  });

  it('без входа — понятный отказ, а не поход в Google', async () => {
    const { svc, youtube, credits } = build({ youtube: { token: null } });
    await expect(svc.confirmYoutube('u1')).rejects.toThrow(
      YOUTUBE_SIGN_IN_REQUIRED,
    );
    expect(youtube.check).not.toHaveBeenCalled();
    expect(credits.grantFree).not.toHaveBeenCalled();
  });

  it('«спросить не удалось» — 503, а не отказ подписчику', async () => {
    // То же правило, что у Telegram-проверки: отказать из-за нашей же
    // неполадки — худший исход.
    const { svc, prisma } = build({ youtube: { token, check: null } });
    const err = await svc.confirmYoutube('u1').catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(prisma.unlockCheck.create).not.toHaveBeenCalled();
  });

  it('не подписан — отказ без начисления', async () => {
    const { svc, prisma, credits } = build({
      youtube: { token, check: false },
    });
    await expect(svc.confirmYoutube('u1')).rejects.toThrow(
      YOUTUBE_NOT_SUBSCRIBED,
    );
    expect(prisma.unlockCheck.create).not.toHaveBeenCalled();
    expect(credits.grantFree).not.toHaveBeenCalled();
  });

  it('способ выключен на стенде — отказ до всякой работы', async () => {
    const { svc, youtube } = build();
    await expect(svc.confirmYoutube('u1')).rejects.toThrow(BadRequestException);
    expect(youtube.tokenFor).not.toHaveBeenCalled();
  });

  it('уже подтверждено — 409 и ни одного вызова к Google', async () => {
    const { svc, youtube } = build({
      existingCheck: true,
      youtube: { token, check: 'YOUTUBE_SUBSCRIPTION' },
    });
    await expect(svc.confirmYoutube('u1')).rejects.toThrow(ConflictException);
    expect(youtube.check).not.toHaveBeenCalled();
  });

  it('тот же Google-аккаунт у второго пользователя — отказ про аккаунт', async () => {
    // Приёмка этапа требует этого прямо: иначе один аккаунт открывал бы
    // доступ любому числу людей, и проверка не значила бы ничего.
    const { svc } = build({
      createThrows: Object.assign(new Error('unique'), { code: 'P2002' }),
      youtube: { token, check: 'YOUTUBE_SUBSCRIPTION' },
    });
    await expect(svc.confirmYoutube('u1')).rejects.toThrow(
      SUBSCRIPTION_ACCOUNT_TAKEN,
    );
  });
});
