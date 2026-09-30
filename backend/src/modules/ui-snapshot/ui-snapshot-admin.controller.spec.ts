/**
 * Проверка разбора тела запроса у POST /admin/ui-snapshot/run.
 *
 * Контроллер появился в этапе H и до сих пор жил без теста: его
 * проверку видели только на проде (`{"theme":"purple"}` → 400). Этап I
 * добавил ему ещё две ветки отказа, и дальше на глаз нельзя: ветка
 * «плотность 2 без unmasked» защищает базу сравнения крона, а такую
 * защиту надо уметь уронить нарочно.
 */
import { BadRequestException } from '@nestjs/common';
import { UiSnapshotAdminController } from './ui-snapshot-admin.controller';
import {
  UiSnapshotQueryService,
  parseSnapshotSummarySince,
} from './ui-snapshot-query.service';

function build() {
  const adminPanel = { assertOperator: jest.fn().mockResolvedValue(undefined) };
  const runner = { run: jest.fn().mockResolvedValue({ total: 0 }) };
  const frames = { capture: jest.fn().mockResolvedValue({ locales: [] }) };
  const greetingFrames = {
    capture: jest.fn().mockResolvedValue({ locales: [] }),
    fixtureVideo: jest.fn().mockResolvedValue({ stage: 'complete' }),
  };
  const prisma = {
    uiSnapshot: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      groupBy: jest.fn().mockResolvedValue([]),
    },
  };
  const controller = new UiSnapshotAdminController(
    adminPanel as never,
    runner as never,
    frames as never,
    greetingFrames as never,
    new UiSnapshotQueryService(prisma as never),
  );
  const req = { userId: 'usr_admin' } as never;
  return {
    controller,
    runner,
    frames,
    greetingFrames,
    adminPanel,
    prisma,
    req,
  };
}

describe('UiSnapshotAdminController — разбор тела', () => {
  it('без параметров — прогон с умолчаниями и всегда без тревог', async () => {
    const { controller, runner, req } = build();

    await controller.run(req, {});

    expect(runner.run).toHaveBeenCalledWith({
      locale: undefined,
      theme: undefined,
      routeKeys: undefined,
      unmasked: false,
      deviceScaleFactor: undefined,
      steps: undefined,
      scrollTo: undefined,
      alerts: false,
    });
  });

  it('локаль не из списка продукта — 400, прогон не запускается', async () => {
    const { controller, runner, req } = build();

    await expect(controller.run(req, { locale: 'rи' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('тема не light/dark — 400', async () => {
    const { controller, runner, req } = build();

    await expect(
      controller.run(req, { theme: 'purple' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('пустой routeKeys — 400', async () => {
    const { controller, runner, req } = build();

    await expect(controller.run(req, { routeKeys: [] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('плотность 2 вместе с unmasked — доезжает до сервиса', async () => {
    const { controller, runner, req } = build();

    await controller.run(req, {
      routeKeys: ['site-tutorial'],
      locale: 'de',
      theme: 'dark',
      unmasked: true,
      deviceScaleFactor: 2,
    });

    expect(runner.run).toHaveBeenCalledWith(
      expect.objectContaining({ deviceScaleFactor: 2, unmasked: true }),
    );
  });

  it('плотность 2 без unmasked — 400 с объяснением, а не 500 из сервиса', async () => {
    const { controller, runner, req } = build();

    await expect(controller.run(req, { deviceScaleFactor: 2 })).rejects.toThrow(
      /unmasked/,
    );
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('плотность 3 — 400: промежуточные и большие значения не нужны никому', async () => {
    const { controller, runner, req } = build();

    await expect(
      controller.run(req, { deviceScaleFactor: 3, unmasked: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(runner.run).not.toHaveBeenCalled();
  });

  // Шаги — этап I, второй заход (27.09.2026): две карточки лендинга из
  // четырёх это мгновенные состояния браузера, и снять их можно только
  // действием на уже открытом экране, а не открытием маршрута.
  describe('steps', () => {
    const OK_STEPS = [
      {
        kind: 'fill',
        selector: '#site-url',
        value: 'https://viral4creators.app',
      },
      { kind: 'click', selector: '[data-qa="client-site-explore"]' },
    ];

    it('шаги с unmasked и одним маршрутом — доезжают до сервиса', async () => {
      const { controller, runner, req } = build();

      await controller.run(req, {
        routeKeys: ['site-tutorial'],
        unmasked: true,
        deviceScaleFactor: 2,
        steps: OK_STEPS,
      });

      expect(runner.run).toHaveBeenCalledWith(
        expect.objectContaining({ steps: OK_STEPS }),
      );
    });

    it('шаги без unmasked — 400: сравниваемый прогон обязан быть наблюдателем', async () => {
      // Запрет строже, чем у плотности: шаги МЕНЯЮТ состояние продукта
      // — создают черновик, отправляют формы. Прогон, который пишет
      // отпечаток в базу, действовать не вправе.
      const { controller, runner, req } = build();

      await expect(
        controller.run(req, { routeKeys: ['site-tutorial'], steps: OK_STEPS }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(runner.run).not.toHaveBeenCalled();
    });

    it('шаги без ровно одного маршрута — 400', async () => {
      // Шаги написаны под конкретный экран: на чужом селекторы либо не
      // найдутся, либо найдутся не те.
      const { controller, runner, req } = build();

      await expect(
        controller.run(req, { unmasked: true, steps: OK_STEPS }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        controller.run(req, {
          unmasked: true,
          routeKeys: ['site-tutorial', 'generate'],
          steps: OK_STEPS,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(runner.run).not.toHaveBeenCalled();
    });

    it('goto среди шагов — 400: маршрут задаётся routeKeys', async () => {
      const { controller, runner, req } = build();

      await expect(
        controller.run(req, {
          routeKeys: ['site-tutorial'],
          unmasked: true,
          // Селектор тут есть намеренно: без него шаг отвергла бы
          // соседняя проверка, и тест проходил бы, не проверяя
          // словарь. Эту ловушку поймала мутация.
          steps: [{ kind: 'goto', route: 'generate', selector: '#site-url' }],
        }),
      ).rejects.toThrow(/kind должен быть одним из/);
      expect(runner.run).not.toHaveBeenCalled();
    });

    it('triggerPaidOperation среди шагов — 400: здесь он не значит ничего', async () => {
      // В сценарии обучалки это декларативный маркер для оценки
      // стоимости. Пропустить его сюда значит дать оператору шаг,
      // который молча ничего не делает.
      const { controller, runner, req } = build();

      await expect(
        controller.run(req, {
          routeKeys: ['site-tutorial'],
          unmasked: true,
          steps: [
            {
              kind: 'triggerPaidOperation',
              operation: 'video',
              model: 'veo',
              expectedUnits: {},
              note: 'x',
              selector: '#site-url',
            },
          ],
        }),
      ).rejects.toThrow(/kind должен быть одним из/);
      expect(runner.run).not.toHaveBeenCalled();
    });

    it('шаг без селектора — 400 с номером шага', async () => {
      const { controller, req } = build();

      await expect(
        controller.run(req, {
          routeKeys: ['site-tutorial'],
          unmasked: true,
          steps: [{ kind: 'fill', value: 'x' }],
        }),
      ).rejects.toThrow(/шаг 1/);
    });

    it('пустой массив шагов — 400, а не «шагов нет»', async () => {
      // Пустой массив прислали намеренно, значит имели в виду шаги;
      // молча превратить это в обычный прогон — скрыть опечатку.
      const { controller, req } = build();

      await expect(
        controller.run(req, {
          routeKeys: ['site-tutorial'],
          unmasked: true,
          steps: [],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  it('не оператор — до разбора тела дело не доходит', async () => {
    const { controller, runner, adminPanel, req } = build();
    adminPanel.assertOperator.mockRejectedValue(new Error('не оператор'));

    await expect(controller.run(req, { theme: 'purple' })).rejects.toThrow(
      'не оператор',
    );
    expect(runner.run).not.toHaveBeenCalled();
  });
});

/**
 * Этап I ТЗ Greeting 2.0 (§5.3): прокрутка к секции у ручного прогона и
 * две кнопки кадров поздравлений. Прокрутка меняет отпечаток кадра,
 * значит у неё те же запреты, что у шагов, — и их надо уметь уронить.
 */
describe('UiSnapshotAdminController — кадры поздравлений', () => {
  it('scrollTo с unmasked и одним маршрутом — доезжает до сервиса', async () => {
    const { controller, runner, req } = build();

    await controller.run(req, {
      routeKeys: ['greeting-video-ready'],
      unmasked: true,
      scrollTo: ' [data-qa="greeting-script-card"] ',
    });

    expect(runner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        scrollTo: '[data-qa="greeting-script-card"]',
        unmasked: true,
      }),
    );
  });

  it('scrollTo без unmasked — 400: прокрученный кадр подменил бы отпечаток крона', async () => {
    const { controller, runner, req } = build();

    await expect(
      controller.run(req, {
        routeKeys: ['greeting-video-ready'],
        scrollTo: '[data-qa="greeting-script-card"]',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('scrollTo без ровно одного маршрута — 400', async () => {
    const { controller, runner, req } = build();

    await expect(
      controller.run(req, {
        routeKeys: ['greeting-video', 'greeting-video-ready'],
        unmasked: true,
        scrollTo: '[data-qa="greeting-script-card"]',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.run(req, { unmasked: true, scrollTo: '   ' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('greeting-frames: локали и тема разбираются тем же разбором, что у обучалки', async () => {
    const { controller, greetingFrames, req } = build();

    await controller.greetingFramesCapture(req, {
      locales: ['ru', 'de'],
      theme: 'dark',
    });
    expect(greetingFrames.capture).toHaveBeenCalledWith({
      locales: ['ru', 'de'],
      theme: 'dark',
    });

    await controller.greetingFramesCapture(req, {});
    expect(greetingFrames.capture).toHaveBeenLastCalledWith({
      locales: ['ru'],
      theme: undefined,
    });

    await expect(
      controller.greetingFramesCapture(req, { locales: ['xx'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.greetingFramesCapture(req, { theme: 'purple' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(greetingFrames.capture).toHaveBeenCalledTimes(2);
  });

  it('fixture-video: переснять готовый ролик — только строгим true', async () => {
    const { controller, greetingFrames, req } = build();

    await controller.greetingFixtureVideo(req, {});
    await controller.greetingFixtureVideo(req, { rerender: 'yes' });
    await controller.greetingFixtureVideo(req, { rerender: true });

    expect(greetingFrames.fixtureVideo.mock.calls).toEqual([
      [{ rerender: false }],
      [{ rerender: false }],
      [{ rerender: true }],
    ]);
  });

  it('обе кнопки — только оператору: платный рендер не запускается без проверки', async () => {
    const { controller, greetingFrames, adminPanel, req } = build();
    adminPanel.assertOperator.mockRejectedValue(new Error('не оператор'));

    await expect(controller.greetingFixtureVideo(req, {})).rejects.toThrow(
      'не оператор',
    );
    await expect(controller.greetingFramesCapture(req, {})).rejects.toThrow(
      'не оператор',
    );
    expect(greetingFrames.fixtureVideo).not.toHaveBeenCalled();
    expect(greetingFrames.capture).not.toHaveBeenCalled();
  });
});

/**
 * Просмотр снимков в админке («Система → Снимки интерфейса»). Главное,
 * что здесь нельзя тихо сломать: что лента отдаёт к изменившемуся
 * снимку ЕГО предыдущий (иначе сравнивать бок о бок не с чем), что
 * «только изменившиеся» фильтруются в базе, а не на странице, и что
 * чтение закрыто проверкой оператора, как и соседние POST.
 */
describe('UiSnapshotAdminController — просмотр снимков', () => {
  const t = (iso: string) => new Date(iso);

  function row(over: Record<string, unknown>) {
    return {
      id: 'snap',
      routeKey: 'projects',
      locale: 'ru',
      theme: 'light',
      createdAt: t('2026-09-30T10:00:00Z'),
      changed: false,
      diffScore: 0,
      blobUrl: 'https://blob/qa-snapshots/projects/ru/light/2.png',
      comparedToUrl: 'https://blob/qa-snapshots/projects/ru/light/1.png',
      diffHash: 'abcd1234:g8x12:ffee',
      error: null,
      ...over,
    };
  }

  it('без оператора — 403 от проверки, в базу не ходит', async () => {
    const { controller, adminPanel, prisma, req } = build();
    adminPanel.assertOperator.mockRejectedValueOnce(new Error('forbidden'));

    await expect(controller.listSnapshots(req)).rejects.toThrow('forbidden');
    adminPanel.assertOperator.mockRejectedValueOnce(new Error('forbidden'));
    await expect(controller.snapshotSummary(req)).rejects.toThrow('forbidden');
    expect(prisma.uiSnapshot.findMany).not.toHaveBeenCalled();
    expect(prisma.uiSnapshot.groupBy).not.toHaveBeenCalled();
  });

  it('фильтры и курсор уходят в запрос, «только изменившиеся» — в where', async () => {
    const { controller, prisma, req } = build();

    await controller.listSnapshots(
      req,
      'projects',
      '2026-09-29',
      '500',
      'ckcursor1',
      'true',
    );

    expect(prisma.uiSnapshot.findMany).toHaveBeenCalledWith({
      where: {
        routeKey: 'projects',
        createdAt: { gte: t('2026-09-29T00:00:00Z') },
        changed: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 101,
      cursor: { id: 'ckcursor1' },
      skip: 1,
    });
  });

  it('изменившийся снимок получает предыдущий той же комбинации, остальные — нет', async () => {
    const { controller, prisma, req } = build();
    prisma.uiSnapshot.findMany.mockResolvedValueOnce([
      row({ id: 's3', changed: true, diffScore: 0.2 }),
      row({ id: 's2', createdAt: t('2026-09-30T09:58:00Z') }),
      // Лишняя строка сверх limit — признак «дальше есть», в ответ не идёт.
      row({ id: 's1', createdAt: t('2026-09-30T09:56:00Z') }),
    ]);
    prisma.uiSnapshot.findFirst.mockResolvedValueOnce({
      id: 's2',
      createdAt: t('2026-09-30T09:58:00Z'),
      blobUrl: 'https://blob/qa-snapshots/projects/ru/light/1.png',
    });

    const res = await controller.listSnapshots(req, undefined, undefined, '2');

    expect(prisma.uiSnapshot.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.uiSnapshot.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          routeKey: 'projects',
          locale: 'ru',
          theme: 'light',
          error: null,
          createdAt: { lt: t('2026-09-30T10:00:00Z') },
        },
      }),
    );
    expect(res.items[0].previous).toEqual({
      id: 's2',
      createdAt: t('2026-09-30T09:58:00Z'),
      blobUrl: 'https://blob/qa-snapshots/projects/ru/light/1.png',
    });
    expect(res.items[1].previous).toBeNull();
    // Отпечаток — только dHash и коротко, сетка яркостей не уезжает.
    expect(res.items[0].diffHash).toBe('abcd1234');
    // Дальше строки есть — курсор на последнюю отданную.
    expect(res.items.map((i) => i.id)).toEqual(['s3', 's2']);
    expect(res.nextBefore).toBe('s2');
  });

  it('неполная страница — курсора нет', async () => {
    const { controller, prisma, req } = build();
    prisma.uiSnapshot.findMany.mockResolvedValueOnce([row({ id: 's1' })]);

    const res = await controller.listSnapshots(req);

    expect(res.nextBefore).toBeNull();
    expect(prisma.uiSnapshot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 31, where: {} }),
    );
  });

  it('последняя страница ровно в limit строк — курсора нет', async () => {
    const { controller, prisma, req } = build();
    prisma.uiSnapshot.findMany.mockResolvedValueOnce([
      row({ id: 's2' }),
      row({ id: 's1' }),
    ]);

    const res = await controller.listSnapshots(req, undefined, undefined, '2');

    expect(res.items).toHaveLength(2);
    expect(res.nextBefore).toBeNull();
  });

  it.each([
    ['limit', [undefined, undefined, '0']],
    ['route', ['../x']],
    ['since без зоны', [undefined, '2026-09-29T10:00']],
    ['changed', [undefined, undefined, undefined, undefined, 'yes']],
  ])('кривой %s — 400, в базу не ходит', async (_name, args) => {
    const { controller, prisma, req } = build();
    await expect(
      (controller.listSnapshots as (...a: unknown[]) => Promise<unknown>).call(
        controller,
        req,
        ...args,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.uiSnapshot.findMany).not.toHaveBeenCalled();
  });

  it('сводка: счётчики сведены по маршруту, изменчивые — сверху', async () => {
    const { controller, prisma, req } = build();
    prisma.uiSnapshot.groupBy
      .mockResolvedValueOnce([
        {
          routeKey: 'a-stable',
          _count: { _all: 720 },
          _max: { createdAt: t('2026-09-30T10:00:00Z') },
        },
        {
          routeKey: 'z-blinking',
          _count: { _all: 700 },
          _max: { createdAt: t('2026-09-30T10:00:00Z') },
        },
      ])
      .mockResolvedValueOnce([{ routeKey: 'z-blinking', _count: { _all: 40 } }])
      .mockResolvedValueOnce([{ routeKey: 'a-stable', _count: { _all: 3 } }]);
    prisma.uiSnapshot.findMany.mockResolvedValueOnce([
      { createdAt: t('2026-09-30T09:58:00Z') },
    ]);

    const res = await controller.snapshotSummary(req, '2026-09-29T10:00:00Z');

    expect(res.routes.map((r) => r.routeKey)).toEqual([
      'z-blinking',
      'a-stable',
    ]);
    expect(res.routes[0]).toMatchObject({
      total: 700,
      changed: 40,
      errors: 0,
      recentChangedAt: [t('2026-09-30T09:58:00Z')],
    });
    expect(res.routes[1]).toMatchObject({
      total: 720,
      changed: 0,
      errors: 3,
      recentChangedAt: [],
    });
    // Времена перемен запрашиваются только там, где перемены были.
    expect(prisma.uiSnapshot.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.uiSnapshot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          routeKey: 'z-blinking',
          changed: true,
        }),
      }),
    );
  });

  it('сводка «30 дней» по часам клиента проходит, хотя сервер позже', () => {
    const now = t('2026-09-30T12:00:00Z');
    // Клиент посчитал since минутой раньше, чем пришёл запрос.
    const clientSince = new Date(now.getTime() - 30 * 86_400_000 - 60_000);
    expect(parseSnapshotSummarySince(clientSince.toISOString(), now)).toEqual(
      clientSince,
    );
    // Но допуск — минуты, а не лазейка: на 10 минут шире — 400.
    const tooWide = new Date(now.getTime() - 30 * 86_400_000 - 10 * 60_000);
    expect(() => parseSnapshotSummarySince(tooWide.toISOString(), now)).toThrow(
      BadRequestException,
    );
  });

  it('сводка отдаёт срок хранения обычных снимков', async () => {
    const { controller, req } = build();
    const res = await controller.snapshotSummary(req);
    expect(res.plainRetentionDays).toBe(3);
  });

  it('сводка шире 30 дней — 400', async () => {
    const { controller, prisma, req } = build();
    await expect(
      controller.snapshotSummary(req, '2020-01-01'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.uiSnapshot.groupBy).not.toHaveBeenCalled();
  });
});
