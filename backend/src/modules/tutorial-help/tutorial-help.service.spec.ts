/**
 * Справка по теме: что отдаётся и чего НЕ отдаётся.
 *
 * Два правила здесь важнее остальных, и оба — про то, что видит
 * пользователь: текст есть всегда, ролик — только вычитанный.
 */

import { NotFoundException } from '@nestjs/common';
import { TutorialHelpService } from './tutorial-help.service';

const ASSET = {
  blobUrl: 'https://blob/tutorial.mp4',
  externalUrl: 'https://ffmpeg-api/out.mp4',
  durationMs: 31000,
};

const META = {
  width: 1920,
  height: 1080,
  posterUrl: 'https://blob/tutorial-video-posters/a.png',
  theme: 'dark',
  capturedAt: new Date('2026-10-05T08:30:00.000Z'),
  captureBuild: 'abc1234',
};

function build(asset: unknown = null) {
  const findFirst = jest.fn().mockResolvedValue(asset);
  const prisma = { tutorialVideoAsset: { findFirst } };
  return {
    service: new TutorialHelpService(prisma as never),
    findFirst,
  };
}

describe('TutorialHelpService', () => {
  it('отдаёт заголовок и текст темы поздравления', async () => {
    const { service } = build();
    const view = await service.get('greeting-brief', 'ru');
    expect(view.title).toBe('Расскажите о поводе');
    expect(view.text).toContain('Повод');
    expect(view.subjectKey).toBe('greeting-brief');
  });

  it('шаги мастера товара — той же ручкой, по номеру', async () => {
    // Две семьи тем, одна справка: кнопка (i) появится и в мастере
    // товара, и заводить под неё второй маршрут незачем.
    const { service } = build();
    expect((await service.get('1', 'ru')).title).toBeTruthy();
  });

  /**
   * Главное правило. Реплики пишет модель, и невычитанный ролик — это
   * её текст, показанный пользователю от имени продукта.
   */
  it('невычитанный ролик не отдаётся — фильтр стоит в КАЖДОМ запросе', async () => {
    const { service, findFirst } = build(null);
    const view = await service.get('greeting-brief', 'ru');
    expect(view.videoUrl).toBeNull();
    expect(view.variants).toEqual({});
    // По запросу на тему (`variants`) и запасной — у всех одно правило.
    expect(findFirst).toHaveBeenCalledTimes(3);
    for (const [args] of findFirst.mock.calls) {
      expect(args.where.reviewed).toBe(true);
    }
  });

  it('текст есть и без ролика — человек просил помощи, а не отказа', async () => {
    const { service } = build(null);
    const view = await service.get('greeting-script', 'ru');
    expect(view.videoUrl).toBeNull();
    expect(view.text.length).toBeGreaterThan(10);
  });

  it('своя ссылка важнее внешней', async () => {
    // Внешняя живёт у подрядчика сборки и переживает нас не дольше
    // договора с ним.
    const { service } = build(ASSET);
    expect((await service.get('greeting-video', 'ru')).videoUrl).toBe(
      ASSET.blobUrl,
    );
  });

  it('без своей ссылки берётся внешняя, а не «ролика нет»', async () => {
    const { service } = build({ ...ASSET, blobUrl: null });
    expect((await service.get('greeting-video', 'ru')).videoUrl).toBe(
      ASSET.externalUrl,
    );
  });

  it('ролик без ссылок вовсе в выборку не попадает', async () => {
    const { service, findFirst } = build(null);
    await service.get('greeting-video', 'ru');
    expect(findFirst.mock.calls[0][0].where.OR).toEqual([
      { blobUrl: { not: null } },
      { externalUrl: { not: null } },
    ]);
  });

  it('берётся САМЫЙ СВЕЖИЙ вычитанный, а не первый попавшийся', async () => {
    const { service, findFirst } = build(ASSET);
    await service.get('greeting-brief', 'ru');
    expect(findFirst.mock.calls[0][0].orderBy).toEqual({ createdAt: 'desc' });
  });

  it('неизвестный язык — язык по умолчанию, а не пустая справка', async () => {
    const { service } = build();
    const view = await service.get('greeting-brief', 'klingon');
    expect(view.locale).toBe('ru');
    expect(view.title).toBeTruthy();
  });

  it('язык темы и язык запроса — один и тот же', async () => {
    const { service, findFirst } = build();
    const view = await service.get('greeting-brief', 'en');
    expect(view.locale).toBe('en');
    expect(view.title).toBe('Describe the occasion');
    // И ролик ищется на том же языке: английский текст с русской
    // озвучкой — хуже, чем отсутствие ролика.
    expect(findFirst.mock.calls[0][0].where.locale).toBe('en');
  });

  it('несуществующая тема — 404, а не пустая справка', async () => {
    // Пустой ответ клиент покажет как «справки нет», и опечатка в ключе
    // будет выглядеть как ненаписанная справка.
    const { service } = build();
    await expect(service.get('greeting-nonsense', 'ru')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  describe('метаданные ролика', () => {
    it('размер, постер, тема, время и версия съёмки — в ответе', async () => {
      const { service } = build({ ...ASSET, ...META });
      const view = await service.get('greeting-brief', 'ru');
      expect(view).toMatchObject({
        width: 1920,
        height: 1080,
        posterUrl: META.posterUrl,
        theme: 'dark',
        capturedAt: '2026-10-05T08:30:00.000Z',
        captureBuild: 'abc1234',
      });
    });

    it('наружу — ровно поля справки, ничего из строки сборки', async () => {
      // id строки, сценарий, задача ffmpeg, отпечаток кадров — служебное.
      const { service, findFirst } = build({
        ...ASSET,
        ...META,
        id: 'asset_1',
        scenarioId: 'scn_1',
        assemblyJobId: 'job_1',
        contentHash: 'deadbeef',
      });
      const view = await service.get('greeting-brief', 'ru');
      expect(Object.keys(view).sort()).toEqual(
        [
          'subjectKey',
          'locale',
          'title',
          'text',
          'videoUrl',
          'durationMs',
          'width',
          'height',
          'posterUrl',
          'theme',
          'capturedAt',
          'captureBuild',
          'variants',
        ].sort(),
      );
      expect(Object.keys(findFirst.mock.calls[0][0].select).sort()).toEqual(
        [
          'blobUrl',
          'externalUrl',
          'durationMs',
          'width',
          'height',
          'posterUrl',
          'theme',
          'capturedAt',
          'captureBuild',
        ].sort(),
      );
    });

    it('ролика нет — все метаданные null, а не undefined', async () => {
      const { service } = build(null);
      const view = await service.get('greeting-brief', 'ru');
      expect(view).toMatchObject({
        width: null,
        height: null,
        posterUrl: null,
        theme: null,
        capturedAt: null,
        captureBuild: null,
      });
    });

    it('старый ролик без метаданных — null, ролик всё равно отдаётся', async () => {
      const { service } = build(ASSET);
      const view = await service.get('greeting-brief', 'ru');
      expect(view.videoUrl).toBe(ASSET.blobUrl);
      expect(view.width).toBeNull();
      expect(view.capturedAt).toBeNull();
    });

    it('половина размера или негодный размер — оба null', async () => {
      // По одной стороне пропорцию не поставить, а ноль/дробь сломали
      // бы aspect-ratio лендинга.
      for (const bad of [
        { width: 720, height: null },
        { width: 0, height: 1560 },
        { width: 720.5, height: 1560 },
        { width: -720, height: 1560 },
      ]) {
        const { service } = build({ ...ASSET, ...META, ...bad });
        const view = await service.get('greeting-brief', 'ru');
        expect([view.width, view.height]).toEqual([null, null]);
      }
    });

    it('тема из базы вне light/dark — null', async () => {
      const { service } = build({ ...ASSET, ...META, theme: 'purple' });
      expect((await service.get('greeting-brief', 'ru')).theme).toBeNull();
    });
  });

  describe('пожелание темы', () => {
    /** База с одобренными роликами по темам: `findFirst` отдаёт ролик
     *  заказанной темы, а без темы — самый свежий из всех. */
    function byTheme(rows: Record<string, unknown>[]) {
      const built = build();
      built.findFirst.mockImplementation(
        async (args: { where: { theme?: string } }) =>
          (args.where.theme
            ? rows.find((r) => r.theme === args.where.theme)
            : rows[0]) ?? null,
      );
      return built;
    }

    it('без темы — запасной запрос без фильтра по теме', async () => {
      const { service, findFirst } = build(ASSET);
      await service.get('greeting-brief', 'ru');
      const unfiltered = findFirst.mock.calls.filter(
        ([a]: [{ where: object }]) => !('theme' in a.where),
      );
      expect(unfiltered).toHaveLength(1);
    });

    it('тема есть у одобренного — отдаётся ролик этой темы, без запасного запроса', async () => {
      const { service, findFirst } = byTheme([
        { ...ASSET, ...META, theme: 'light', blobUrl: 'https://blob/l.mp4' },
        { ...ASSET, ...META, theme: 'dark', blobUrl: 'https://blob/d.mp4' },
      ]);
      const view = await service.get('greeting-brief', 'ru', 'dark');
      expect(findFirst).toHaveBeenCalledTimes(2);
      expect(
        findFirst.mock.calls.map(
          ([a]: [{ where: { theme?: string } }]) => a.where.theme,
        ),
      ).toEqual(['light', 'dark']);
      expect(view.theme).toBe('dark');
      expect(view.videoUrl).toBe('https://blob/d.mp4');
    });

    it('ролика этой темы нет — самый свежий одобренный любой темы', async () => {
      const { service, findFirst } = byTheme([
        { ...ASSET, ...META, theme: 'light' },
      ]);
      const view = await service.get('greeting-brief', 'ru', 'dark');
      expect(findFirst).toHaveBeenCalledTimes(3);
      expect(findFirst.mock.calls[2][0].where).not.toHaveProperty('theme');
      // Запасной запрос — те же правила: только вычитанный.
      expect(findFirst.mock.calls[2][0].where.reviewed).toBe(true);
      expect(view.videoUrl).toBe(ASSET.blobUrl);
      expect(view.theme).toBe('light');
    });

    it('неизвестная тема — как без темы, а не 400', async () => {
      const { service, findFirst } = build(ASSET);
      await service.get('greeting-brief', 'ru', 'purple');
      expect(
        findFirst.mock.calls.some(
          ([a]: [{ where: { theme?: string } }]) => a.where.theme === 'purple',
        ),
      ).toBe(false);
      expect(findFirst.mock.calls[2][0].where).not.toHaveProperty('theme');
    });
  });

  describe('variants — обе темы одним запросом (заход 3)', () => {
    const LIGHT = {
      ...ASSET,
      ...META,
      theme: 'light',
      blobUrl: 'https://blob/l.mp4',
      posterUrl: 'https://blob/tutorial-video-posters/l.png',
      capturedAt: new Date('2026-10-04T08:00:00.000Z'),
      captureBuild: 'build-l',
      // Служебное строки — наружу не идёт.
      id: 'asset_l',
      contentHash: 'deadbeef',
    };
    const DARK = {
      ...ASSET,
      ...META,
      theme: 'dark',
      blobUrl: 'https://blob/d.mp4',
      posterUrl: 'https://blob/tutorial-video-posters/d.png',
      capturedAt: new Date('2026-10-05T08:00:00.000Z'),
      captureBuild: 'build-d',
      durationMs: 29000,
    };
    function db(rows: Record<string, unknown>[]) {
      const built = build();
      built.findFirst.mockImplementation(
        async (args: { where: { theme?: string } }) =>
          (args.where.theme
            ? rows.find((r) => r.theme === args.where.theme)
            : rows[rows.length - 1]) ?? null,
      );
      return built;
    }

    it('обе темы одобрены — обе в variants, ровно с полями ролика', async () => {
      const { service } = db([LIGHT, DARK]);
      const view = await service.get('greeting-brief', 'ru');
      expect(Object.keys(view.variants).sort()).toEqual(['dark', 'light']);
      for (const v of Object.values(view.variants)) {
        expect(Object.keys(v!).sort()).toEqual(
          [
            'videoUrl',
            'posterUrl',
            'width',
            'height',
            'durationMs',
            'capturedAt',
            'captureBuild',
          ].sort(),
        );
      }
      expect(view.variants.light).toEqual({
        videoUrl: 'https://blob/l.mp4',
        posterUrl: 'https://blob/tutorial-video-posters/l.png',
        width: 1920,
        height: 1080,
        durationMs: 31000,
        capturedAt: '2026-10-04T08:00:00.000Z',
        captureBuild: 'build-l',
      });
      expect(view.variants.dark).toEqual(
        expect.objectContaining({
          videoUrl: 'https://blob/d.mp4',
          durationMs: 29000,
          captureBuild: 'build-d',
        }),
      );
    });

    it('только одобренные: темы без одобренного ролика в variants нет вовсе', async () => {
      const { service, findFirst } = db([LIGHT]);
      const view = await service.get('greeting-brief', 'ru');
      expect(view.variants).toEqual({
        light: expect.objectContaining({ videoUrl: 'https://blob/l.mp4' }),
      });
      expect('dark' in view.variants).toBe(false);
      // Выборка вариантов — только вычитанные и только со ссылкой.
      for (const [a] of findFirst.mock.calls) {
        expect(a.where.reviewed).toBe(true);
        expect(a.where.OR).toEqual([
          { blobUrl: { not: null } },
          { externalUrl: { not: null } },
        ]);
      }
    });

    it('строка чужой темы (сбой выборки) в вариант не попадает', async () => {
      const { service } = build(LIGHT); // на любой запрос — светлая
      const view = await service.get('greeting-brief', 'ru');
      expect(Object.keys(view.variants)).toEqual(['light']);
    });

    it('верхние поля — по ?theme=, variants — обе', async () => {
      const { service } = db([LIGHT, DARK]);
      const view = await service.get('greeting-brief', 'ru', 'light');
      expect(view.videoUrl).toBe('https://blob/l.mp4');
      expect(view.theme).toBe('light');
      expect(Object.keys(view.variants).sort()).toEqual(['dark', 'light']);
    });

    it('ролик без размера — в варианте размер null парой', async () => {
      const { service } = db([{ ...LIGHT, width: 720, height: null }]);
      const view = await service.get('greeting-brief', 'ru');
      expect([view.variants.light!.width, view.variants.light!.height]).toEqual(
        [null, null],
      );
    });
  });
});
