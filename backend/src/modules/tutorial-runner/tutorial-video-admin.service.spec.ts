/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { ConflictException, NotFoundException } from '@nestjs/common';
import { TutorialVideoAdminService } from './tutorial-video-admin.service';

function build() {
  const prisma = {
    tutorialVideoAsset: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findUnique: jest.fn(),
      update: jest.fn(),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    cronRunLog: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  const service = new TutorialVideoAdminService(prisma as any);
  return { service, prisma };
}

describe('TutorialVideoAdminService.list (§4.9, этап 99)', () => {
  it('передаёт фильтры в findMany/count как есть и считает пагинацию', async () => {
    const { service, prisma } = build();
    await service.list({
      subjectKey: 'plan-upgrade',
      locale: 'ru',
      reviewed: true,
      page: 2,
      pageSize: 20,
    });
    const expectedWhere = {
      subjectKey: 'plan-upgrade',
      locale: 'ru',
      reviewed: true,
      // Ролики обучалки по сайту заказчика в эту таблицу не попадают
      // (сквозной аудит 29.09.2026) — у них своя витрина и своё
      // одобрение, а одна кнопка отсюда отдавала бы их посетителям
      // лендинга.
      clientSiteDraftId: null,
    };
    expect(prisma.tutorialVideoAsset.findMany).toHaveBeenCalledWith({
      where: expectedWhere,
      orderBy: { createdAt: 'desc' },
      // Служебный отпечаток сборки (до 24 КБ) админке не отдаётся.
      omit: { contentHash: true },
      skip: 20,
      take: 20,
    });
    expect(prisma.tutorialVideoAsset.count).toHaveBeenCalledWith({
      where: expectedWhere,
    });
  });

  it('без фильтров — subjectKey/locale/reviewed уходят undefined', async () => {
    const { service, prisma } = build();
    await service.list({ page: 1, pageSize: 10 });
    expect(prisma.tutorialVideoAsset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          clientSiteDraftId: null,
          subjectKey: undefined,
          locale: undefined,
          reviewed: undefined,
        },
      }),
    );
  });

  it('возвращает total/page/pageSize вместе со строками', async () => {
    const { service, prisma } = build();
    prisma.tutorialVideoAsset.findMany.mockResolvedValue([{ id: 'tva-1' }]);
    prisma.tutorialVideoAsset.count.mockResolvedValue(3);
    const result = await service.list({ page: 1, pageSize: 10 });
    expect(result).toEqual({
      rows: [{ id: 'tva-1' }],
      total: 3,
      page: 1,
      pageSize: 10,
      siteTutorialDemoAssetIds: [],
    });
  });
});

describe('TutorialVideoAdminService.setReviewed', () => {
  it('несуществующий id — NotFoundException', async () => {
    const { service, prisma } = build();
    prisma.tutorialVideoAsset.findUnique.mockResolvedValue(null);
    await expect(service.setReviewed('missing', true)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.tutorialVideoAsset.update).not.toHaveBeenCalled();
  });

  it('ставит reviewed:true', async () => {
    const { service, prisma } = build();
    prisma.tutorialVideoAsset.findUnique.mockResolvedValue({
      id: 'tva-1',
      blobUrl: 'https://blob.example/tva-1.mp4',
    });
    prisma.tutorialVideoAsset.update.mockResolvedValue({
      id: 'tva-1',
      reviewed: true,
    });
    const result = await service.setReviewed('tva-1', true);
    expect(prisma.tutorialVideoAsset.update).toHaveBeenCalledWith({
      where: { id: 'tva-1' },
      data: { reviewed: true },
    });
    expect(result).toEqual({ id: 'tva-1', reviewed: true });
  });

  it('позволяет снять reviewed обратно в false (не идемпотентно-необратимо, в отличие от approve сценариев)', async () => {
    const { service, prisma } = build();
    prisma.tutorialVideoAsset.findUnique.mockResolvedValue({
      id: 'tva-1',
      reviewed: true,
    });
    prisma.tutorialVideoAsset.update.mockResolvedValue({
      id: 'tva-1',
      reviewed: false,
    });
    const result = await service.setReviewed('tva-1', false);
    expect(prisma.tutorialVideoAsset.update).toHaveBeenCalledWith({
      where: { id: 'tva-1' },
      data: { reviewed: false },
    });
    expect(result.reviewed).toBe(false);
  });
});

describe('TutorialVideoAdminService.dataStatus', () => {
  it('собирает знания/шаги/покрытие видео/последние прогоны в одну сводку', async () => {
    const { service, prisma } = build();
    prisma.tutorialVideoAsset.groupBy.mockResolvedValue([
      { subjectKey: 'plan-upgrade', locale: 'ru', _count: { _all: 2 } },
    ]);
    prisma.cronRunLog.findFirst.mockResolvedValue({
      jobKey: 'tutorial-scenario-run',
      status: 'SUCCESS',
      startedAt: new Date('2026-09-01'),
      finishedAt: new Date('2026-09-01'),
      summary: 'ok',
      errorMessage: null,
    });

    const result = await service.dataStatus();

    expect(result.knowledge).toEqual(
      expect.objectContaining({
        builtAt: expect.any(String),
        commit: expect.any(String),
      }),
    );
    expect(result.stepCounts.ru).toBeGreaterThan(0);
    expect(result.videoCoverage).toEqual([
      { subjectKey: 'plan-upgrade', locale: 'ru', reviewedCount: 2 },
    ]);
    // Четыре, а не три: с 27.09.2026 в сводке есть и
    // `tutorial-assembly-poll` — именно он теперь решает судьбу
    // сборок, и молчать о нём значило бы прятать тот крон, от которого
    // зависит, появится ли у человека ссылка на ролик.
    expect(result.lastRuns).toHaveLength(4);
    expect(result.lastRuns.map((r) => r.jobKey)).toContain(
      'tutorial-assembly-poll',
    );
    expect(prisma.tutorialVideoAsset.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['subjectKey', 'locale'],
        where: { reviewed: true },
      }),
    );
  });

  it('без прогонов в истории — lastRuns со статусом null, не падает', async () => {
    const { service } = build();
    const result = await service.dataStatus();
    expect(result.lastRuns.every((r) => r.status === null)).toBe(true);
  });
});

describe('ролики обучалки по сайту заказчика (сквозной аудит 29.09.2026)', () => {
  it('одобрить через API нельзя — барьер не только в витрине', async () => {
    // Прямой вызов мимо экрана отдал бы посетителям ролик по чужому
    // сайту так же, как ошибочное нажатие.
    const { service, prisma } = build();
    prisma.tutorialVideoAsset.findUnique.mockResolvedValue({
      id: 'tva-1',
      clientSiteDraftId: 'draft-7',
    });

    await expect(service.setReviewed('tva-1', true)).rejects.toThrow(
      /сайту заказчика/,
    );
    expect(prisma.tutorialVideoAsset.update).not.toHaveBeenCalled();
  });

  it('штатный ролик одобряется по-прежнему', async () => {
    const { service, prisma } = build();
    prisma.tutorialVideoAsset.findUnique.mockResolvedValue({
      id: 'tva-2',
      clientSiteDraftId: null,
      blobUrl: 'https://blob.example/tva-2.mp4',
    });

    await service.setReviewed('tva-2', true);
    expect(prisma.tutorialVideoAsset.update).toHaveBeenCalled();
  });
});

describe('одобрять можно только СОБРАННЫЙ ролик (сквозной аудит 29.09.2026)', () => {
  it('строка без blobUrl не одобряется через API', () => {
    // Барьер стоял только в разметке (`disabled={!row.blobUrl}`).
    // Прямой вызов одобрял строку в `preparing`: консультант её потом
    // отсеет, но в сводке «Состояние данных» она числилась бы
    // покрытием, которого нет.
    const { service, prisma } = build();
    prisma.tutorialVideoAsset.findUnique.mockResolvedValue({
      id: 'tva-3',
      clientSiteDraftId: null,
      blobUrl: null,
    });

    return expect(service.setReviewed('tva-3', true)).rejects.toThrow(
      /не собран/,
    );
  });

  it('СНЯТЬ одобрение у несобранной строки можно', () => {
    // Запрет только на выдачу наружу; убрать флаг — всегда безопасно.
    const { service, prisma } = build();
    prisma.tutorialVideoAsset.findUnique.mockResolvedValue({
      id: 'tva-4',
      clientSiteDraftId: null,
      blobUrl: null,
    });

    return expect(service.setReviewed('tva-4', false)).resolves.not.toThrow();
  });
});

describe('Э-С Ш5: одобрение → набор роликов сайта тенанта лендинга', () => {
  it('после одобрения и снятия — полный набор уходит (без ожидания сети); ролик по сайту заказчика — нет', async () => {
    const prisma = {
      tutorialVideoAsset: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({ id: 'tva-9' }),
      },
    };
    const landing = { sync: jest.fn().mockResolvedValue(true) };
    const service = new TutorialVideoAdminService(
      prisma as any,
      landing as any,
    );
    prisma.tutorialVideoAsset.findUnique.mockResolvedValue({
      id: 'tva-9',
      clientSiteDraftId: null,
      blobUrl: 'https://blob.example/tva-9.mp4',
    });
    await expect(service.setReviewed('tva-9', true)).resolves.toEqual({
      id: 'tva-9',
    });
    await service.setReviewed('tva-9', false);
    expect(landing.sync).toHaveBeenCalledTimes(2);

    prisma.tutorialVideoAsset.findUnique.mockResolvedValue({
      id: 'tva-10',
      clientSiteDraftId: 'draft-1',
      blobUrl: 'https://blob.example/tva-10.mp4',
    });
    await expect(service.setReviewed('tva-10', true)).rejects.toThrow(
      /сайту заказчика/,
    );
    expect(landing.sync).toHaveBeenCalledTimes(2);
  });

  it('сбой синхронизации не ломает одобрение', async () => {
    const prisma = {
      tutorialVideoAsset: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'tva-11',
          clientSiteDraftId: null,
          blobUrl: 'https://blob.example/tva-11.mp4',
        }),
        update: jest.fn().mockResolvedValue({ id: 'tva-11' }),
      },
    };
    const landing = { sync: jest.fn().mockRejectedValue(new Error('down')) };
    const service = new TutorialVideoAdminService(
      prisma as any,
      landing as any,
    );
    await expect(service.setReviewed('tva-11', true)).resolves.toEqual({
      id: 'tva-11',
    });
  });
});

describe('TutorialVideoAdminService.setReviewed — отметка одобрения (аудит кронов 06.10.2026)', () => {
  function withSettings(raw: string | null = null) {
    const prisma = {
      tutorialVideoAsset: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'tva-1',
          clientSiteDraftId: null,
          blobUrl: 'https://blob.example.com/tutorial-videos/1/tva-1.mp4',
        }),
        update: jest.fn().mockResolvedValue({ id: 'tva-1', reviewed: true }),
      },
    };
    const settings = {
      get: jest.fn().mockResolvedValue(raw),
      set: jest.fn().mockResolvedValue(undefined),
    };
    const service = new TutorialVideoAdminService(
      prisma as any,
      undefined,
      settings as any,
    );
    return { service, prisma, settings };
  }

  it('одобрение пишет время в карту — по нему подметальщик держит прежний ролик сутки', async () => {
    const { service, settings } = withSettings();
    const before = Date.now();
    await service.setReviewed('tva-1', true);
    expect(settings.set).toHaveBeenCalledWith(
      'tutorial.videoApprovedAt',
      expect.any(String),
    );
    const map = JSON.parse(settings.set.mock.calls[0][1]);
    expect(Date.parse(map['tva-1'])).toBeGreaterThanOrEqual(before - 1000);
  });

  it('снятие одобрения карту не трогает', async () => {
    const { service, settings } = withSettings();
    await service.setReviewed('tva-1', false);
    expect(settings.set).not.toHaveBeenCalled();
  });

  it('сбой записи карты одобрение не роняет', async () => {
    const { service, settings } = withSettings();
    settings.set.mockRejectedValue(new Error('база'));
    await expect(service.setReviewed('tva-1', true)).resolves.toBeDefined();
  });
});

describe('TutorialVideoAdminService.setSiteTutorialDemo — отметка «в демо обучающего лендинга»', () => {
  const KEY = 'tutorial.siteTutorialDemoAssets';

  function withSettings(initial: string | null = null) {
    const store = new Map<string, string>();
    if (initial !== null) store.set(KEY, initial);
    const settings = {
      get: jest.fn(async (k: string) => store.get(k) ?? null),
      set: jest.fn(async (k: string, v: string) => {
        store.set(k, v);
      }),
    };
    const prisma = {
      tutorialVideoAsset: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const service = new TutorialVideoAdminService(
      prisma as any,
      undefined,
      settings as any,
    );
    return { service, prisma, settings, store };
  }

  const GOOD = {
    id: 'tva-demo-1',
    subjectKey: 'site-tutorial-demo-1',
    clientSiteDraftId: null,
    reviewed: true,
    blobUrl: 'https://blob.example/demo.mp4',
  };

  it('годная строка — id дописывается в отметку, повтор ничего не меняет', async () => {
    const { service, prisma, settings, store } = withSettings('["old-1"]');
    prisma.tutorialVideoAsset.findUnique.mockResolvedValue(GOOD);

    const res = await service.setSiteTutorialDemo(GOOD.id, true, 'op-1');

    expect(res.siteTutorialDemoAssetIds).toEqual(['old-1', GOOD.id]);
    expect(JSON.parse(store.get(KEY) as string)).toEqual(['old-1', GOOD.id]);
    expect(settings.set).toHaveBeenCalledWith(
      KEY,
      JSON.stringify(['old-1', GOOD.id]),
      'op-1',
    );
    settings.set.mockClear();
    await service.setSiteTutorialDemo(GOOD.id, true, 'op-1');
    expect(settings.set).not.toHaveBeenCalled();
  });

  it.each([
    [
      'ролик сайта заказчика',
      { clientSiteDraftId: 'draft-1' },
      /сайту заказчика/,
    ],
    ['тема не из семейства', { subjectKey: '3' }, /не из демо/],
    [
      'ключ похож, но не слот',
      { subjectKey: 'site-tutorial-demo-99' },
      /не из демо/,
    ],
    ['не одобрен', { reviewed: false }, /одобрите/],
    ['не собран', { blobUrl: null }, /не собран/],
  ])('%s — отказ, отметка не пишется', async (_label, patch, message) => {
    const { service, prisma, settings } = withSettings('[]');
    prisma.tutorialVideoAsset.findUnique.mockResolvedValue({
      ...GOOD,
      ...patch,
    });
    await expect(
      service.setSiteTutorialDemo(GOOD.id, true, 'op-1'),
    ).rejects.toThrow(message);
    expect(settings.set).not.toHaveBeenCalled();
  });

  it('снять отметку можно у любой строки (снятие ничего не публикует)', async () => {
    const { service, prisma, store } = withSettings(
      JSON.stringify(['a-1', GOOD.id]),
    );
    prisma.tutorialVideoAsset.findUnique.mockResolvedValue({
      ...GOOD,
      reviewed: false,
    });
    const res = await service.setSiteTutorialDemo(GOOD.id, false, 'op-1');
    expect(res.siteTutorialDemoAssetIds).toEqual(['a-1']);
    expect(JSON.parse(store.get(KEY) as string)).toEqual(['a-1']);
  });

  it('негодное значение настройки не затирается молча', async () => {
    const { service, prisma, settings } = withSettings('{"broken":true}');
    prisma.tutorialVideoAsset.findUnique.mockResolvedValue(GOOD);
    await expect(
      service.setSiteTutorialDemo(GOOD.id, true, 'op-1'),
    ).rejects.toThrow(/не разбирается/);
    expect(settings.set).not.toHaveBeenCalled();
  });

  it('несуществующий id — NotFoundException', async () => {
    const { service, prisma } = withSettings();
    prisma.tutorialVideoAsset.findUnique.mockResolvedValue(null);
    await expect(
      service.setSiteTutorialDemo('nope', true),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('список отдаёт отмеченные id для галочки', async () => {
    const { service } = withSettings(JSON.stringify([GOOD.id]));
    const res = await service.list({ page: 1, pageSize: 10 });
    expect(res.siteTutorialDemoAssetIds).toEqual([GOOD.id]);
  });
});

// Заход 7: блокировка публикации по ИИ-проверке качества. Само правило
// (флаг, итоговый fail, переопределение) — `demo-quality.service.spec.ts`;
// здесь — что барьер стоит на одобрении и отметке «в демо», а снятие
// одобрения/отметки им не перекрыто.
describe('заход 7: блокировка публикации проверкой качества', () => {
  function withQuality(blocked: boolean, raw = '[]') {
    const store = new Map<string, string>([
      ['tutorial.siteTutorialDemoAssets', raw],
    ]);
    const settings = {
      get: jest.fn(async (k: string) => store.get(k) ?? null),
      set: jest.fn(async (k: string, v: string) => {
        store.set(k, v);
      }),
    };
    const prisma = {
      tutorialVideoAsset: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'tva-q',
          subjectKey: 'site-tutorial-demo-1',
          clientSiteDraftId: null,
          reviewed: true,
          blobUrl: 'https://blob.example/q.mp4',
        }),
        update: jest.fn().mockResolvedValue({ id: 'tva-q' }),
      },
    };
    const quality = {
      assertPublishable: jest.fn(async () => {
        if (blocked) throw new ConflictException('ИИ-проверка: fail');
      }),
    };
    const service = new TutorialVideoAdminService(
      prisma as any,
      undefined,
      settings as any,
      quality as any,
    );
    return { service, prisma, settings, quality };
  }

  it('fail без переопределения — одобрить нельзя, снять одобрение можно', async () => {
    const { service, prisma, quality } = withQuality(true);
    await expect(service.setReviewed('tva-q', true)).rejects.toThrow(
      ConflictException,
    );
    expect(prisma.tutorialVideoAsset.update).not.toHaveBeenCalled();
    expect(quality.assertPublishable).toHaveBeenCalledWith('tva-q');
    await service.setReviewed('tva-q', false);
    expect(prisma.tutorialVideoAsset.update).toHaveBeenCalledWith({
      where: { id: 'tva-q' },
      data: { reviewed: false },
    });
  });

  it('fail без переопределения — в демо не отметить, снять отметку можно', async () => {
    const { service, settings } = withQuality(true, '["tva-q"]');
    await expect(
      service.setSiteTutorialDemo('tva-q', true, 'op'),
    ).rejects.toThrow(ConflictException);
    const res = await service.setSiteTutorialDemo('tva-q', false, 'op');
    expect(res.siteTutorialDemoAssetIds).toEqual([]);
    expect(settings.set).toHaveBeenCalledTimes(1);
  });

  it('блока нет (флаг выключен или переопределено) — как прежде', async () => {
    const { service, prisma } = withQuality(false);
    await service.setReviewed('tva-q', true);
    expect(prisma.tutorialVideoAsset.update).toHaveBeenCalled();
    const res = await service.setSiteTutorialDemo('tva-q', true, 'op');
    expect(res.siteTutorialDemoAssetIds).toEqual(['tva-q']);
  });
});
