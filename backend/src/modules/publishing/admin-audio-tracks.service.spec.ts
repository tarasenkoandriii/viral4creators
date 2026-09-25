jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { NotFoundException } from '@nestjs/common';
import {
  AdminAudioTracksService,
  localesToBuild,
  toView,
} from './admin-audio-tracks.service';

/**
 * Экран передачи дорожек оператору (этап 139).
 *
 * Здесь три решения, и каждое проверяется: список сам дозабирает
 * готовые сборки (иначе оператор видел бы «собирается» у дорожки,
 * готовой полчаса назад); пересборка не трогает уже залитые дорожки
 * (подменять файл под отметкой нельзя); отметка — это отметка, и снятие
 * стирает след целиком.
 */
const NOW = new Date('2026-09-24T10:00:00Z');

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
  uploadedAt: null,
  uploadedById: null,
  updatedAt: NOW,
  ...over,
});

function build(rows: Record<string, unknown>[] = [row()]) {
  let current = rows;
  const prisma = {
    videoAudioTrack: {
      findMany: jest.fn(async () => current),
      findUnique: jest.fn(async () => current[0] ?? null),
      update: jest.fn(async (args: { data: Record<string, unknown> }) => ({
        ...current[0],
        ...args.data,
      })),
    },
  };
  const tracks = {
    // Дозабор: после него строка становится готовой — двойник обязан
    // это отражать, иначе тест не увидит разницы между «дозабрали» и
    // «просто позвали».
    pollMix: jest.fn(async () => {
      current = current.map((r) =>
        r.mixJobId
          ? { ...r, mixJobId: null, trackUrl: 'https://blob/fresh.m4a' }
          : r,
      );
    }),
    build: jest.fn(async () => ({ locale: 'de', status: 'READY' })),
  };
  const sessions = {
    getSession: jest.fn().mockResolvedValue({
      sessionId: 's1',
      locale: 'uk',
      generatedVideo: { generatedVideoId: 'v1' },
    }),
  };
  const svc = new AdminAudioTracksService(
    prisma as never,
    tracks as never,
    sessions as never,
  );
  return { svc, prisma, tracks, sessions };
}

describe('toView', () => {
  it('«задача есть, файла нет» показывается как «собирается»', () => {
    // Отдельного статуса для этого в базе нет намеренно (миграция 94).
    expect(
      toView(row({ mixJobId: 'job', trackUrl: null }) as never).mixing,
    ).toBe(true);
    expect(toView(row({ mixJobId: 'job' }) as never).mixing).toBe(false);
    expect(toView(row() as never).mixing).toBe(false);
  });

  it('субтитры доезжают до экрана — их оператор заливает тем же заходом', () => {
    // Без них человек ушёл бы за субтитрами в другое место или не ушёл
    // бы вовсе (этап 141).
    const srt = '1\n00:00:01,000 --> 00:00:04,000\nSteel mug keeps the heat\n';
    expect(toView(row({ subtitlesSrt: srt }) as never).subtitlesSrt).toBe(srt);
    expect(toView(row() as never).subtitlesSrt).toBeNull();
  });

  it('дата отметки уезжает строкой, а не объектом', () => {
    expect(toView(row({ uploadedAt: NOW }) as never).uploadedAt).toBe(
      NOW.toISOString(),
    );
    expect(toView(row() as never).uploadedAt).toBeNull();
  });
});

describe('AdminAudioTracksService.list', () => {
  it('дозабирает готовые сборки ДО ответа', async () => {
    const { svc, tracks } = build([row({ mixJobId: 'job-1', trackUrl: null })]);
    const result = await svc.list('s1');
    expect(tracks.pollMix).toHaveBeenCalledWith('s1', 'de');
    expect(result.tracks[0].trackUrl).toBe('https://blob/fresh.m4a');
    expect(result.tracks[0].mixing).toBe(false);
  });

  it('когда забирать нечего, второго запроса к базе нет', async () => {
    // Экран открывают часто, а дорожек единицы: лишний запрос на каждом
    // открытии — плата ни за что.
    const { svc, prisma, tracks } = build();
    await svc.list('s1');
    expect(tracks.pollMix).not.toHaveBeenCalled();
    expect(prisma.videoAudioTrack.findMany).toHaveBeenCalledTimes(1);
  });

  it('язык оригинала отдаётся отдельно — экрану надо знать, чего не хватает', async () => {
    const { svc } = build();
    expect((await svc.list('s1')).sourceLocale).toBe('uk');
  });

  it('несуществующая сессия — 404, а не «дорожек нет, оригинал русский»', async () => {
    // Пустой список с выдуманным языком оригинала — враньё оператору,
    // который ошибся ссылкой.
    const { svc, sessions } = build();
    sessions.getSession.mockResolvedValue(null);
    // Именно 404, а не любая ошибка: без проверки список падал бы
    // дальше по коду с TypeError, и это выглядело бы как поломка
    // сервера вместо честного «такой сессии нет».
    await expect(svc.list('нет')).rejects.toThrow(NotFoundException);
  });

  it('дорожка от прежней версии ролика помечена устаревшей', async () => {
    const { svc } = build([row({ generatedVideoId: 'v0' })]);
    const result = await svc.list('s1');
    expect(result.tracks[0].stale).toBe(true);
    // И она же попадает в список «собрать»: готова она для другого ролика.
    expect(result.toBuild).toContain('de');
  });
});

describe('localesToBuild', () => {
  it('язык оригинала и залитое не собираются', () => {
    expect(localesToBuild([], 'uk', 'v1').sort()).toEqual([
      'de',
      'en',
      'es',
      'ru',
    ]);
    expect(
      localesToBuild(
        [row({ locale: 'de', uploadedAt: NOW }) as never],
        'uk',
        'v1',
      ),
    ).not.toContain('de');
  });

  it('залитая дорожка не пересобирается, даже если ролик с тех пор переснят', () => {
    // Отметка сильнее устаревания: опубликованный на YouTube ролик от
    // перегенерации в продукте не меняется, а вот наш файл под отметкой
    // подменился бы на дорожку от ДРУГОГО ролика.
    expect(
      localesToBuild(
        [
          row({
            locale: 'de',
            uploadedAt: NOW,
            generatedVideoId: 'v0',
            trackUrl: null,
          }) as never,
        ],
        'uk',
        'v1',
      ),
    ).not.toContain('de');
  });

  it('готовую дорожку не пересобирает — это была плата за уже готовое', () => {
    // Кнопка называлась «собрать недостающие», а прежняя редакция
    // пересобирала ВСЁ незалитое, то есть платила заново за готовое.
    expect(
      localesToBuild([row({ locale: 'de' }) as never], 'uk', 'v1'),
    ).not.toContain('de');
  });

  it('отданное человеку скопом не повторяется', () => {
    // Там нужно решение человека, а не ещё одна попытка за те же
    // деньги: для неё есть отдельная кнопка в строке.
    expect(
      localesToBuild(
        [row({ locale: 'de', status: 'HANDOVER', trackUrl: null }) as never],
        'uk',
        'v1',
      ),
    ).not.toContain('de');
  });

  it('дорожку от ПРЕЖНЕЙ версии ролика собирает заново, даже готовую', () => {
    // Перегенерация меняет картинку, а иногда и реплики: «готова» такая
    // дорожка для другого ролика.
    expect(
      localesToBuild(
        [row({ locale: 'de', generatedVideoId: 'v0' }) as never],
        'uk',
        'v1',
      ),
    ).toContain('de');
  });

  it('не собравшуюся — собирает', () => {
    expect(
      localesToBuild(
        [row({ locale: 'de', status: 'FAILED', trackUrl: null }) as never],
        'uk',
        'v1',
      ),
    ).toContain('de');
  });
});

describe('AdminAudioTracksService.buildOne', () => {
  it('собирает ровно одну локаль и отдаёт её карточку', async () => {
    // По одной за запрос: четыре подряд не укладывались в таймаут
    // функции, а уйти в фон у serverless нельзя.
    const { svc, tracks } = build();
    const view = await svc.buildOne('s1', 'de');
    expect(tracks.build).toHaveBeenCalledTimes(1);
    expect(tracks.build).toHaveBeenCalledWith('s1', 'de');
    expect(view.locale).toBe('de');
  });

  it('язык оригинала — отказ, а не пустая работа за деньги', async () => {
    const { svc, tracks } = build();
    await expect(svc.buildOne('s1', 'uk')).rejects.toThrow();
    expect(tracks.build).not.toHaveBeenCalled();
  });

  it('чужая сессия — 404 до всякой работы', async () => {
    const { svc, sessions, tracks } = build();
    sessions.getSession.mockResolvedValue(null);
    await expect(svc.buildOne('нет', 'de')).rejects.toThrow();
    expect(tracks.build).not.toHaveBeenCalled();
  });
});

describe('AdminAudioTracksService.setUploaded', () => {
  it('отметка ставит дату и того, кто отметил', async () => {
    const { svc, prisma } = build();
    const view = await svc.setUploaded('t1', true, 'op-1');
    const data = prisma.videoAudioTrack.update.mock.calls[0][0].data;
    expect(data.uploadedAt).toBeInstanceOf(Date);
    expect(data.uploadedById).toBe('op-1');
    expect(view.uploadedById).toBe('op-1');
  });

  it('снятие стирает след целиком', async () => {
    // «Залил Иван, но не залил» — это не история, а мусор.
    const { svc, prisma } = build();
    await svc.setUploaded('t1', false, 'op-1');
    expect(prisma.videoAudioTrack.update.mock.calls[0][0].data).toEqual({
      uploadedAt: null,
      uploadedById: null,
    });
  });

  it('чужой id — 404, а не тихое создание строки', async () => {
    const { svc } = build([]);
    await expect(svc.setUploaded('нет', true, 'op-1')).rejects.toThrow();
  });
});
