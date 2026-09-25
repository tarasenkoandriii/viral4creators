jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { UserAudioTracksService } from './user-audio-tracks.service';
import { DailySpendLimitExceededException } from '../../common/spend-limits';

/**
 * Этап 148. Тот же механизм, что у оператора (этапы 138–141), но
 * заказывает его пользователь — и это меняет три проверки.
 */
const NOW = new Date('2026-09-25T10:00:00Z');
const row = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  sessionId: 's1',
  generatedVideoId: 'v1',
  locale: 'de',
  status: 'READY',
  speech: 'Steel mug',
  voiceUrl: 'https://blob/voice.mp3',
  trackUrl: 'https://blob/track.m4a',
  voiceSeconds: 6,
  overflowSeconds: -1,
  tempoRate: null,
  attempts: 1,
  note: null,
  mixError: null,
  mixJobId: null,
  subtitlesSrt: null,
  uploadedAt: null,
  uploadedById: null,
  updatedAt: NOW,
  ...over,
});

function build(
  over: {
    session?: Record<string, unknown> | null;
    rows?: Record<string, unknown>[];
    plan?: Error | null;
    budget?: Error | null;
  } = {},
) {
  const prisma = {
    videoAudioTrack: {
      findMany: jest.fn().mockResolvedValue(over.rows ?? [row()]),
      findUnique: jest.fn().mockResolvedValue(row()),
    },
  };
  const sessions = {
    getSession: jest.fn().mockResolvedValue(
      'session' in over
        ? over.session
        : {
            sessionId: 's1',
            userId: 'u1',
            projectId: 'p1',
            locale: 'ru',
            generatedVideo: { generatedVideoId: 'v1' },
          },
    ),
  };
  const plans = {
    assertUser: jest.fn(async () => {
      if (over.plan) throw over.plan;
    }),
    assertCanSpendUser: jest.fn(async () => {
      if (over.budget) throw over.budget;
    }),
  };
  const tracks = {
    build: jest.fn().mockResolvedValue({ locale: 'de', status: 'READY' }),
    pollMix: jest.fn().mockResolvedValue(undefined),
  };
  return {
    service: new UserAudioTracksService(
      prisma as never,
      sessions as never,
      plans as never,
      tracks as never,
    ),
    prisma,
    sessions,
    plans,
    tracks,
  };
}

describe('UserAudioTracksService — владелец', () => {
  it('чужой ролик не находится — и не подтверждает, что существует', async () => {
    // У оператора доступ по должности; открыть его сервис пользователю
    // «как есть» значило бы дать собрать дорожки к чужому ролику, зная
    // один идентификатор.
    const { service } = build({
      session: {
        sessionId: 's1',
        userId: 'somebody-else',
        locale: 'ru',
        generatedVideo: {},
      },
    });
    await expect(service.list('u1', 's1')).rejects.toThrow(NotFoundException);
    await expect(service.build('u1', 's1', 'de')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('несуществующий ролик — тот же ответ', async () => {
    const { service } = build({ session: null });
    await expect(service.list('u1', 's1')).rejects.toThrow(NotFoundException);
  });
});

describe('UserAudioTracksService — деньги и тариф', () => {
  it('потолок расхода проверяется ДО платной работы', async () => {
    // `AudioTrackService` писался admin-only и потолок не проверяет —
    // он только записывает израсходованное. Без этой проверки один
    // человек за вечер выбрал бы бюджет, не встретив ни одного отказа.
    const { service, tracks } = build({
      budget: new DailySpendLimitExceededException('потолок'),
    });
    await expect(service.build('u1', 's1', 'de')).rejects.toThrow(
      DailySpendLimitExceededException,
    );
    expect(tracks.build).not.toHaveBeenCalled();
  });

  it('тариф проверяется тоже, и раньше денег', async () => {
    const { service, tracks, plans } = build({
      plan: new ForbiddenException('нужен Premium'),
    });
    await expect(service.build('u1', 's1', 'de')).rejects.toThrow(
      ForbiddenException,
    );
    expect(plans.assertCanSpendUser).not.toHaveBeenCalled();
    expect(tracks.build).not.toHaveBeenCalled();
  });

  it('потолок считается по проекту ролика, а не вообще', async () => {
    // От проекта зависит сценарий тестового доступа (TODO §III п.37).
    const { service, plans } = build();
    await service.build('u1', 's1', 'de');
    expect(plans.assertCanSpendUser).toHaveBeenCalledWith('u1', {
      projectId: 'p1',
    });
  });

  it('список читается и без Premium — платного в нём ничего нет', async () => {
    const { service, plans } = build({
      plan: new ForbiddenException('нужен Premium'),
    });
    await expect(service.list('u1', 's1')).resolves.toBeTruthy();
    expect(plans.assertUser).not.toHaveBeenCalled();
  });
});

describe('UserAudioTracksService — сборка', () => {
  it('язык оригинала отдельной дорожки не получает', async () => {
    // Она уже есть в самом ролике.
    const { service, tracks } = build();
    await expect(service.build('u1', 's1', 'ru')).rejects.toThrow(
      ForbiddenException,
    );
    expect(tracks.build).not.toHaveBeenCalled();
  });

  it('незнакомый язык — отказ, а не русская дорожка за деньги', async () => {
    // `normalizeLocale` возвращает русский на любой мусор: у ролика с
    // украинским оригиналом опечатка в адресе собрала бы и оплатила
    // дорожку, которую никто не просил (аудит этапа 148; ровно эту же
    // ошибку нашёл аудит 147 во внешнем API).
    const { service, tracks } = build({
      session: {
        sessionId: 's1',
        userId: 'u1',
        projectId: 'p1',
        locale: 'uk',
        generatedVideo: { generatedVideoId: 'v1' },
      },
    });
    await expect(service.build('u1', 's1', 'zzz')).rejects.toThrow(
      BadRequestException,
    );
    expect(tracks.build).not.toHaveBeenCalled();
  });

  it('готовые сборки дозабираются ПАРАЛЛЕЛЬНО', async () => {
    // Экран пользователя опрашивает список постоянно: четыре опроса
    // чужого ffmpeg подряд — это секунды ожидания на каждом тике.
    const { service, tracks } = build({
      rows: [
        row({ locale: 'de', mixJobId: 'j1', trackUrl: null }),
        row({ locale: 'en', mixJobId: 'j2', trackUrl: null }),
      ],
    });
    let open = () => undefined as void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let started = 0;
    tracks.pollMix.mockImplementation(async () => {
      if (++started === 2) open();
      await gate;
    });

    const late = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('опросы пошли по очереди')),
        2000,
      ).unref?.(),
    );
    await Promise.race([service.list('u1', 's1'), late]);

    expect(started).toBe(2);
  });

  it('готовые сборки дозабираются ДО ответа', async () => {
    // Иначе человек видит «собирается» у дорожки, готовой полчаса.
    const { service, tracks } = build({
      rows: [row({ mixJobId: 'job-1', trackUrl: null })],
    });
    await service.list('u1', 's1');
    expect(tracks.pollMix).toHaveBeenCalledWith('s1', 'de');
  });

  it('когда дозабирать нечего, второго запроса к базе нет', async () => {
    const { service, prisma } = build();
    await service.list('u1', 's1');
    expect(prisma.videoAudioTrack.findMany).toHaveBeenCalledTimes(1);
  });

  it('в списке есть язык оригинала и что имеет смысл собрать', async () => {
    const { service } = build({ rows: [] });
    const result = await service.list('u1', 's1');
    expect(result.sourceLocale).toBe('ru');
    expect(result.toBuild).not.toContain('ru');
    expect(result.toBuild.length).toBeGreaterThan(0);
  });
});
