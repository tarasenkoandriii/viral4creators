/* eslint-disable @typescript-eslint/no-explicit-any -- тестовые дублёры */
/**
 * Модерация черновиков обучалки по сайту заказчика (§5.2, §8.3 ТЗ,
 * этап 113).
 *
 * Здесь один по-настоящему дорогой инвариант: сборка ролика через
 * внешний ffmpeg-api запускается РОВНО ОДИН РАЗ и только после «да»
 * оператора. Два оператора, нажавшие «Одобрить» одновременно, не должны
 * оплатить сборку дважды, а `/finish` не должен запускать её вовсе —
 * ради этого шаги и разведены (§14 п.2).
 */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('@prisma/client', () => ({
  Prisma: { DbNull: Symbol.for('Prisma.DbNull') },
}));

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import {
  ClientSiteTutorialAdminService,
  FRAME_DOWNLOAD_TIMEOUT_MS,
  MAX_ASSEMBLY_ATTEMPTS,
} from './client-site-tutorial-admin.service';
import { createHash } from 'node:crypto';
import type { PrismaService } from '../../prisma/prisma.service';
import type { BlobService } from '../storage/blob.service';
import type { FfmpegApiService } from '../postprod/ffmpeg-api.service';
import * as assembly from '../tutorial-runner/tutorial-video-assembly';

function makeRow(over: Record<string, unknown> = {}) {
  return {
    id: 'draft1',
    projectId: 'proj1',
    baseUrl: 'https://shop.example.com',
    title: 'Как оформить заявку',
    status: 'PENDING_REVIEW',
    steps: [
      { kind: 'goto', route: 'https://shop.example.com' },
      { kind: 'click', selector: '#next' },
    ],
    stepsPerRound: [1, 1],
    previewFrameCount: 2,
    requiresLiveLoginReplay: false,
    rejectionReason: null,
    credentialsEnc: 'шифр',
    createdAt: new Date('2026-09-01T10:00:00Z'),
    updatedAt: new Date('2026-09-02T10:00:00Z'),
    ...over,
  };
}

function setup(
  opts: {
    row?: unknown;
    claimCount?: number;
    ffmpegConfigured?: boolean;
    submit?: jest.Mock;
    /** Что лежит в хранилище под префиксом кадров этого черновика. */
    storedFrames?: string[];
    /** Сколько провалов того же содержимого уже записано. */
    failedSame?: number;
    /** Строки `failed` сверх потолка — то, что найдёт уборка. */
    staleFailed?: Array<{ id: string; blobUrl: string | null }>;
  } = {},
) {
  const row = opts.row === undefined ? makeRow() : opts.row;
  const clientSiteTutorialDraft = {
    findUnique: jest.fn().mockResolvedValue(row),
    findMany: jest.fn().mockResolvedValue([makeRow()]),
    count: jest.fn().mockResolvedValue(1),
    updateMany: jest.fn().mockResolvedValue({ count: opts.claimCount ?? 1 }),
  };
  const tutorialVideoAsset = {
    create: jest.fn().mockResolvedValue({ id: 'asset1' }),
    update: jest.fn().mockResolvedValue({}),
    count: jest.fn().mockResolvedValue(opts.failedSame ?? 0),
    findMany: jest.fn().mockResolvedValue(opts.staleFailed ?? []),
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
  };
  const project = {
    findUnique: jest.fn().mockResolvedValue({ userId: 'owner-1' }),
  };
  const prisma = {
    clientSiteTutorialDraft,
    tutorialVideoAsset,
    project,
  } as unknown as PrismaService;

  /**
   * Кадры берутся ЛИСТИНГОМ хранилища, а не именем, собранным из
   * счётчика: расширение следует за содержимым (PNG у съёмочного, JPEG
   * у предпросмотрового). Поэтому мок отдаёт список файлов — включая
   * кадр раунда под тем же префиксом, который в ролик попасть не
   * должен.
   */
  const blob = {
    // Байты кадра = его путь: отпечаток меняется вместе с кадром и
    // считается в тесте той же формулой без доступа к хранилищу.
    downloadBuffer: jest
      .fn()
      .mockImplementation((p: string) => Promise.resolve(Buffer.from(p))),
    getPublicUrl: jest
      .fn()
      .mockImplementation((p: string) => Promise.resolve(`https://blob/${p}`)),
    listByPrefix: jest.fn().mockImplementation((prefix: string) =>
      Promise.resolve({
        blobs: (
          opts.storedFrames ?? [
            `${prefix}0.png`,
            `${prefix}1.jpg`,
            `${prefix}round-0.png`,
          ]
        ).map((pathname: string) => ({ pathname, uploadedAt: new Date() })),
        cursor: null,
      }),
    ),
  } as unknown as BlobService;

  const submit = opts.submit ?? jest.fn().mockResolvedValue({ jobId: 'job-1' });
  const ffmpeg = {
    configured: jest.fn(() => opts.ffmpegConfigured ?? true),
    submit,
  } as unknown as FfmpegApiService;

  const aiUsageRecord = jest.fn().mockResolvedValue(undefined);
  const aiUsage = {
    record: aiUsageRecord,
  } as unknown as AiUsageService;

  const service = new ClientSiteTutorialAdminService(
    prisma,
    blob,
    ffmpeg,
    aiUsage,
  );
  return {
    service,
    prisma,
    blob,
    ffmpeg,
    submit,
    clientSiteTutorialDraft,
    tutorialVideoAsset,
    project,
    aiUsageRecord,
  };
}

describe('очередь', () => {
  it('без фильтра берутся все статусы, с фильтром — только он', async () => {
    const { service, clientSiteTutorialDraft } = setup();
    await service.list({ page: 1, pageSize: 20 });
    expect(clientSiteTutorialDraft.findMany.mock.calls[0][0].where).toEqual({});

    await service.list({ status: 'PENDING_REVIEW', page: 1, pageSize: 20 });
    expect(clientSiteTutorialDraft.findMany.mock.calls[1][0].where).toEqual({
      status: 'PENDING_REVIEW',
    });
  });

  it('в список не уезжают ни куки, ни креды, ни кадры целиком', async () => {
    // Оператору для решения нужен объём работы, а не секреты заказчика.
    const { service } = setup();
    const { items } = await service.list({ page: 1, pageSize: 20 });
    const item = items[0] as unknown as Record<string, unknown>;
    expect(item.credentialsEnc).toBeUndefined();
    expect(item.cookiesEnc).toBeUndefined();
    expect(item.steps).toBeUndefined();
    expect(item).toMatchObject({ stepCount: 2, roundCount: 2 });
  });

  it('пагинация считается от страницы, а не от смещения', async () => {
    const { service, clientSiteTutorialDraft } = setup();
    await service.list({ page: 3, pageSize: 20 });
    expect(clientSiteTutorialDraft.findMany.mock.calls[0][0].skip).toBe(40);
  });
});

describe('карточка заявки', () => {
  it('отдаёт ссылки на ВСЕ залитые кадры — иначе оператор одобряет вслепую', async () => {
    // Расширения РАЗНЫЕ намеренно: кадр из съёмочного — PNG, из
    // предпросмотра — JPEG, и у одного черновика бывают оба. Кадр
    // раунда (`round-0.png`) лежит под тем же префиксом и в ролик не
    // входит — иначе оператор увидел бы кадров больше, чем в ролике.
    const { service } = setup();
    const details = await service.details('draft1');
    expect(details.frameUrls).toEqual([
      'https://blob/tutorial-video-frames/draft1/0.png',
      'https://blob/tutorial-video-frames/draft1/1.jpg',
    ]);
  });

  it('кадры берутся из хранилища, а не из счётчика в строке', async () => {
    // Счётчик говорит «два» (`previewFrameCount: 2`), в хранилище три
    // кадра. Оборвавшийся повторный `/finish` оставляет ровно такое
    // расхождение, и правда — у хранилища.
    const { service } = setup({
      storedFrames: [
        'tutorial-video-frames/draft1/0.png',
        'tutorial-video-frames/draft1/1.png',
        'tutorial-video-frames/draft1/2.png',
      ],
    });
    expect((await service.details('draft1')).frameUrls).toHaveLength(3);
  });

  it('оператор видит раскладку «кадр ↔ шаги» и предупреждения по раундам', async () => {
    const { service } = setup({
      row: makeRow({ roundDangerWarnings: ['похоже на оплату'] }),
    });
    const details = await service.details('draft1');
    expect(details.stepsPerRound).toEqual([1, 1]);
    // Выравнивание по левому краю — как пишет сервис визарда.
    expect(details.roundDangerWarnings).toEqual([null, 'похоже на оплату']);
  });

  it('шаги видны целиком — по ним и принимается решение', async () => {
    const { service } = setup();
    expect((await service.details('draft1')).steps).toHaveLength(2);
  });

  it('о кредах сообщается фактом, а не значением', async () => {
    const { service } = setup();
    const details = (await service.details('draft1')) as unknown as Record<
      string,
      unknown
    >;
    expect(details.hasCredentials).toBe(true);
    expect(details.credentialsEnc).toBeUndefined();
  });

  it('несуществующая заявка — 404', async () => {
    const { service } = setup({ row: null });
    await expect(service.details('нет')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('одобрение запускает сборку — и только оно', () => {
  it('статус меняется и задача уходит в ffmpeg', async () => {
    const { service, clientSiteTutorialDraft, submit } = setup();
    await service.approve('draft1', 'operator1');
    expect(
      clientSiteTutorialDraft.updateMany.mock.calls[0][0].data.status,
    ).toBe('APPROVED');
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('ролик собирается из УЖЕ залитых кадров, а не из нового обхода сайта', async () => {
    const { service, submit } = setup();
    await service.approve('draft1', 'operator1');
    const inputs = submit.mock.calls[0][0].inputs as Record<string, string>;
    expect(Object.values(inputs)).toEqual([
      'https://blob/tutorial-video-frames/draft1/0.png',
      'https://blob/tutorial-video-frames/draft1/1.jpg',
    ]);
  });

  it('заводится строка ролика с мягкой ссылкой на черновик (§6.2)', async () => {
    const { service, tutorialVideoAsset } = setup();
    await service.approve('draft1', 'operator1');
    const data = tutorialVideoAsset.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      clientSiteDraftId: 'draft1',
      frameCount: 2,
      // `preparing`, а не `pending`: опрос сборок ходит каждые две
      // минуты и, попав в окно до записи `assemblyJobId`, пометил бы
      // уже оплаченную задачу провалившейся — оператор одобрил бы
      // повторно и заплатил второй раз (находка сквозного аудита).
      assemblyStatus: 'preparing',
      durationMs: 2 * assembly.SECONDS_PER_FRAME * 1000,
    });
    // Поле штатной обучалки НЕ переиспользуется под чужой смысл.
    expect(data.scenarioId).toBeUndefined();
  });

  it('немой ролик пишет язык черновика, а не жёсткий ru (Э6-локаль)', async () => {
    const { service, tutorialVideoAsset } = setup({
      row: makeRow({ locale: 'uk-UA' }),
    });
    await service.approve('draft1', 'operator1');
    expect(tutorialVideoAsset.create.mock.calls[0][0].data.locale).toBe('uk');
  });

  it('немой ролик без языка у черновика — ru, как раньше', async () => {
    const { service, tutorialVideoAsset } = setup({
      row: makeRow({ locale: null }),
    });
    await service.approve('draft1', 'operator1');
    expect(tutorialVideoAsset.create.mock.calls[0][0].data.locale).toBe('ru');
  });

  it('длительность берётся из плана, а не пересчитывается писателем', async () => {
    // Подменяем плану длительность на число, которого из двух кадров
    // по 2 с не получить. Ожидание вида `кадры × SECONDS_PER_FRAME`
    // ничего бы не доказало: это та же формула, что и у мутации, от
    // которой тест якобы защищает, — проходили бы обе. С этапа B
    // кадры разной длины, и вторая формула разошлась бы молча, а
    // число читает человек («Длительность — около N с»).
    const { service, tutorialVideoAsset } = setup();
    const real = assembly.planSlideshow;
    jest.spyOn(assembly, 'planSlideshow').mockImplementation((frames, opts) => {
      const plan = real(frames, opts);
      return plan && { ...plan, durationMs: 987_654 };
    });

    await service.approve('draft1', 'operator1');

    expect(tutorialVideoAsset.create.mock.calls[0][0].data.durationMs).toBe(
      987_654,
    );
    jest.restoreAllMocks();
  });

  it('строка заводится ДО отправки задачи, jobId дописывается после', async () => {
    // Обратный порядок терял деньги: задача оплачена, `assemblyJobId`
    // не сохранён — результат не подберёт никто (аудит этапа 116).
    const { service, tutorialVideoAsset, submit } = setup();
    await service.approve('draft1', 'operator1');
    expect(tutorialVideoAsset.create.mock.invocationCallOrder[0]).toBeLessThan(
      submit.mock.invocationCallOrder[0],
    );
    expect(tutorialVideoAsset.update.mock.calls[0][0].data).toEqual({
      assemblyStatus: 'pending',
      assemblyJobId: 'job-1',
      assemblyStartedAt: expect.any(Date),
    });
  });

  it('расход за сборку записан — и на хозяина проекта, не в анонимные', async () => {
    // До сквозного аудита A+B+C одобрение черновика стоило денег
    // МОЛЧА: в отчёте расходов не было ни строки. А строка без
    // владельца считается анонимной (`anonymous: userId === null`)
    // и выбирает общий суточный потолок анонимных посетителей.
    const { service, aiUsageRecord, project } = setup();

    await service.approve('draft1', 'operator1');

    expect(project.findUnique).toHaveBeenCalledWith({
      where: { id: 'proj1' },
      select: { userId: true },
    });
    expect(aiUsageRecord).toHaveBeenCalledWith({
      operation: 'tutorial-video-assembly',
      model: 'ffmpeg-api',
      userId: 'owner-1',
    });
  });

  it('владелец расхода ищется ДО отправки задачи, а не после', async () => {
    // Между `submit` и записью `assemblyJobId` нельзя класть ничего,
    // что может бросить: задача уже оплачена, а без `jobId` её
    // результат не подберёт никто — через десять минут черновик
    // вернётся на одобрение, оператор одобрит снова, и мы заплатим
    // второй раз. Первая редакция правки «расход за сборку» ставила
    // запрос владельца ровно в это окно (находка повторного
    // сквозного аудита A+B+C).
    const { service, project, submit } = setup();

    await service.approve('draft1', 'operator1');

    expect(project.findUnique.mock.invocationCallOrder[0]).toBeLessThan(
      submit.mock.invocationCallOrder[0],
    );
  });

  it('проекта нет — отказ ДО отправки, а не анонимный расход', async () => {
    // `owner?.userId` при отсутствии проекта дал бы `undefined`, то
    // есть АНОНИМНУЮ строку расхода — ровно тот общий потолок $5, от
    // которого уводит вся правка.
    const { service, submit, aiUsageRecord, project } = setup();
    project.findUnique.mockResolvedValue(null);

    await expect(service.approve('draft1', 'op')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(submit).not.toHaveBeenCalled();
    expect(aiUsageRecord).not.toHaveBeenCalled();
  });

  it('сборка не отправлена — расход не записан', async () => {
    // Запись после `submit`, а не до: иначе отказ ffmpeg оставлял бы
    // в отчёте расход, которого не было.
    const { service, aiUsageRecord } = setup({
      submit: jest.fn().mockRejectedValue(new Error('ffmpeg-api лёг')),
    });

    await expect(service.approve('draft1', 'op')).rejects.toThrow();

    expect(aiUsageRecord).not.toHaveBeenCalled();
  });

  it('второй оператор не оплачивает сборку повторно', async () => {
    const { service, submit } = setup({ claimCount: 0 });
    await expect(service.approve('draft1', 'operator2')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(submit).not.toHaveBeenCalled();
  });

  it('черновик не на проверке не одобряется', async () => {
    const { service, submit } = setup({ row: makeRow({ status: 'DRAFTING' }) });
    await expect(service.approve('draft1', 'op')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(submit).not.toHaveBeenCalled();
  });

  it('без залитых кадров собирать нечего', async () => {
    const { service } = setup({ row: makeRow({ previewFrameCount: null }) });
    await expect(service.approve('draft1', 'op')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('неудача отправки ОТКАТЫВАЕТ одобрение — иначе черновик в тупике', async () => {
    // APPROVED — состояние без выхода: approve/reject требуют
    // PENDING_REVIEW, resume требует REJECTED, редактировать нельзя.
    // Оператор получал «готово», ролика не было, и оставалось только
    // удалить черновик и переписать сценарий (аудит этапа 116).
    const { service, clientSiteTutorialDraft } = setup({
      submit: jest.fn().mockRejectedValue(new Error('ffmpeg-api лёг')),
    });
    await expect(service.approve('draft1', 'op')).rejects.toThrow(
      'ffmpeg-api лёг',
    );
    const last = clientSiteTutorialDraft.updateMany.mock.calls.at(-1)[0];
    expect(last).toEqual({
      where: { id: 'draft1', status: 'APPROVED' },
      data: { status: 'PENDING_REVIEW' },
    });
  });

  it('не настроенный ffmpeg — отказ с причиной, а не «одобрено» без ролика', async () => {
    const { service, submit, clientSiteTutorialDraft, blob } = setup({
      ffmpegConfigured: false,
    });
    await expect(service.approve('draft1', 'op')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(submit).not.toHaveBeenCalled();
    // Отказ — до захвата статуса и до скачивания кадров (аудит
    // 01.10.2026): откатывать нечего, тянуть кадры незачем.
    expect(clientSiteTutorialDraft.updateMany).not.toHaveBeenCalled();
    expect(blob.downloadBuffer).not.toHaveBeenCalled();
  });

  it('кадров в хранилище меньше, чем записал /finish, — отказ, а не короткий ролик', async () => {
    const { service, submit, clientSiteTutorialDraft } = setup({
      storedFrames: ['tutorial-video-frames/draft1/0.png'],
    });
    await expect(service.approve('draft1', 'op')).rejects.toThrow(
      /в хранилище 1 кадр\(ов\), а при завершении записи было 2/,
    );
    expect(submit).not.toHaveBeenCalled();
    expect(clientSiteTutorialDraft.updateMany).not.toHaveBeenCalled();
  });

  it('зависшее скачивание кадра — отказ по потолку ожидания, с именем кадра', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      const { service, blob, submit } = setup();
      (blob.downloadBuffer as jest.Mock).mockReturnValueOnce(
        new Promise(() => undefined),
      );
      const pending = service.approve('draft1', 'op');
      // Отказ ловится сразу, чтобы промис не считался необработанным,
      // пока таймеры двигаются вручную.
      const caught = pending.catch((e: unknown) => e);
      await jest.advanceTimersByTimeAsync(FRAME_DOWNLOAD_TIMEOUT_MS);
      expect(((await caught) as Error).message).toMatch(/0\.png/);
      expect(submit).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('строка ролика несёт точный отпечаток байтов кадров', async () => {
    const { service, tutorialVideoAsset } = setup();
    await service.approve('draft1', 'op');
    const sha = (b: string | Buffer) =>
      createHash('sha256').update(b).digest('hex');
    const expected = sha(
      [
        'tutorial-video-frames/draft1/0.png',
        'tutorial-video-frames/draft1/1.jpg',
      ]
        .map((p) => `${sha(p)},`)
        .join(''),
    );
    expect(tutorialVideoAsset.create.mock.calls[0][0].data.contentHash).toBe(
      expected,
    );
  });

  it('провалы считаются по ЭТОМУ черновику и ЭТОМУ содержимому', async () => {
    const { service, tutorialVideoAsset } = setup();
    await service.approve('draft1', 'op');
    const where = tutorialVideoAsset.count.mock.calls[0][0].where;
    expect(where).toEqual({
      clientSiteDraftId: 'draft1',
      assemblyStatus: 'failed',
      contentHash: tutorialVideoAsset.create.mock.calls[0][0].data.contentHash,
    });
  });

  it('третий провал тех же кадров — отказ по-русски, статус не тронут, задача не ушла', async () => {
    const { service, submit, clientSiteTutorialDraft } = setup({
      failedSame: MAX_ASSEMBLY_ATTEMPTS,
    });
    await expect(service.approve('draft1', 'op')).rejects.toThrow(
      /уже проваливалась 3 раз/,
    );
    expect(submit).not.toHaveBeenCalled();
    expect(clientSiteTutorialDraft.updateMany).not.toHaveBeenCalled();
  });

  it('до потолка — сборка уходит', async () => {
    const { service, submit } = setup({
      failedSame: MAX_ASSEMBLY_ATTEMPTS - 1,
    });
    await service.approve('draft1', 'op');
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('нечитаемый кадр — отказ с именем кадра ДО одобрения', async () => {
    const { service, blob, submit, clientSiteTutorialDraft } = setup();
    (blob.downloadBuffer as jest.Mock).mockRejectedValueOnce(new Error('404'));
    await expect(service.approve('draft1', 'op')).rejects.toThrow(/0\.png/);
    expect(submit).not.toHaveBeenCalled();
    expect(clientSiteTutorialDraft.updateMany).not.toHaveBeenCalled();
  });

  it('строки failed черновика сверх потолка убираются, с файлом — остаются', async () => {
    const { service, tutorialVideoAsset } = setup({
      staleFailed: [
        { id: 'old-1', blobUrl: null },
        { id: 'old-2', blobUrl: 'https://blob/tutorial-videos/частичный.mp4' },
      ],
    });
    await service.approve('draft1', 'op');
    expect(tutorialVideoAsset.findMany.mock.calls[0][0]).toMatchObject({
      where: { clientSiteDraftId: 'draft1', assemblyStatus: 'failed' },
      orderBy: { createdAt: 'desc' },
      skip: MAX_ASSEMBLY_ATTEMPTS,
    });
    expect(tutorialVideoAsset.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['old-1'] }, assemblyStatus: 'failed' },
    });
  });

  it('сбой уборки провалов не роняет состоявшееся одобрение', async () => {
    const { service, tutorialVideoAsset } = setup();
    tutorialVideoAsset.findMany.mockRejectedValueOnce(new Error('БД икнула'));
    await expect(service.approve('draft1', 'op')).resolves.toMatchObject({
      id: 'draft1',
    });
  });

  it('пропавший кадр не роняет карточку заявки целиком', async () => {
    // Счётчик в строке мог разойтись с хранилищем; оператору важнее
    // увидеть шаги и решить, чем получить 500 на всю заявку.
    const { service, blob } = setup();
    (blob.getPublicUrl as jest.Mock).mockRejectedValueOnce(new Error('нет'));
    const details = await service.details('draft1');
    expect(details.frameUrls).toHaveLength(1);
    expect(details.steps).toHaveLength(2);
  });
});

describe('отклонение', () => {
  it('пишет причину — пользователю нужно знать, что чинить', async () => {
    const { service, clientSiteTutorialDraft } = setup();
    await service.reject('draft1', '  шаг оформляет настоящий заказ  ');
    const data = clientSiteTutorialDraft.updateMany.mock.calls[0][0].data;
    expect(data).toEqual({
      status: 'REJECTED',
      rejectionReason: 'шаг оформляет настоящий заказ',
    });
  });

  it('кадры НЕ стираются — черновик можно вернуть в работу', async () => {
    const { service, blob } = setup();
    await service.reject('draft1', 'причина');
    expect(blob.getPublicUrl).not.toHaveBeenCalled();
  });

  it('сборка при отклонении не запускается', async () => {
    const { service, submit } = setup();
    await service.reject('draft1', 'причина');
    expect(submit).not.toHaveBeenCalled();
  });

  it('черновик не на проверке не отклоняется', async () => {
    const { service } = setup({ row: makeRow({ status: 'APPROVED' }) });
    await expect(service.reject('draft1', 'причина')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe('озвучка обучалки по кадрам (решение владельца 06.10.2026)', () => {
  function voiced(rowOver: Record<string, unknown> = {}, synth?: jest.Mock) {
    const base = setup({
      row: makeRow({ voiceEnabled: true, locale: 'uk', ...rowOver }),
    });
    (base.blob as any).uploadBuffer = jest.fn(async (p: string) => ({
      url: `https://blob/${p}`,
    }));
    (base.tutorialVideoAsset as any).updateMany = jest
      .fn()
      .mockResolvedValue({ count: 1 });
    const versions = {
      synthesizeClientVoices:
        synth ??
        jest.fn(async ({ texts, assetId }: any) => ({
          speech: texts.map((t: string | null, i: number) =>
            t
              ? {
                  url: `https://blob/tutorial-video-sources/${assetId}/voice/${i}.mp3`,
                  pathname: `tutorial-video-sources/${assetId}/voice/${i}.mp3`,
                  seconds: 2.5,
                  text: t,
                  provenance: {
                    provider: 'resemble',
                    voiceId: 'v',
                    locale: 'uk',
                    textSha: `s${i}`,
                  },
                }
              : null,
          ),
          skipped: null,
        })),
      wipeSources: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ClientSiteTutorialAdminService(
      base.prisma,
      base.blob,
      base.ffmpeg,
      { record: base.aiUsageRecord } as any,
      versions as any,
    );
    return { ...base, service, versions };
  }

  it('реплика на кадр на языке черновика, подписи и переходы, manifest с дорожками', async () => {
    const { service, versions, submit, tutorialVideoAsset } = voiced();
    await service.approve('draft1', 'operator1');

    const call = versions.synthesizeClientVoices.mock.calls[0][0];
    expect(call).toMatchObject({
      assetId: 'asset1',
      draftId: 'draft1',
      ownerUserId: 'owner-1',
      projectId: 'proj1',
      locale: 'uk',
      stepIndexes: [0, 1],
    });
    expect(call.texts).toEqual([
      'Как оформить заявку. Відкрийте сайт shop.example.com. Натисніть «next».',
      'Готово.',
    ]);

    const job = submit.mock.calls[0][0];
    expect(Object.keys(job.inputs)).toEqual(
      expect.arrayContaining([
        'frame0',
        'frame1',
        'voice0',
        'voice1',
        'captions',
      ]),
    );
    expect(job.commands[0]).toContain('xfade=transition=fade');
    expect(job.commands[0]).toContain('subtitles={{captions}}');

    const pending = tutorialVideoAsset.update.mock.calls[0][0].data;
    expect(pending).toMatchObject({
      assemblyStatus: 'pending',
      assemblyJobId: 'job-1',
      durationMs: expect.any(Number),
    });
    expect(pending.tempoManifest).toMatchObject({
      sourceAssetId: 'asset1',
      owner: { kind: 'client-site', draftId: 'draft1', userId: 'owner-1' },
      narration: 'per-frame',
      storage: 'draft-frames',
      motion: 'fade',
      captions: true,
      locale: 'uk',
    });
    expect(pending.tempoManifest.frames[0].image.pathname).toBe(
      'tutorial-video-frames/draft1/0.png',
    );
    // Строка ролика — с языком черновика, а не жёстко 'ru'.
    expect(tutorialVideoAsset.create.mock.calls[0][0].data.locale).toBe('uk');
  });

  it('ПД из названия не уходит в синтез', async () => {
    const { service, versions } = voiced({
      title: 'Заявка для boss@corp.example, тел. +7 (999) 123-45-67',
    });
    await service.approve('draft1', 'operator1');
    const texts: string[] =
      versions.synthesizeClientVoices.mock.calls[0][0].texts;
    expect(texts.join(' ')).not.toMatch(/boss@corp|999|123-45/);
  });

  it('галочка снята — прежняя немая сборка символ в символ, manifest отдельной записью', async () => {
    const { service, versions, submit, tutorialVideoAsset } = voiced({
      voiceEnabled: false,
    });
    await service.approve('draft1', 'operator1');
    expect(versions.synthesizeClientVoices).not.toHaveBeenCalled();
    expect(Object.keys(submit.mock.calls[0][0].inputs)).toEqual([
      'frame0',
      'frame1',
    ]);
    expect(submit.mock.calls[0][0].commands[0]).not.toContain('xfade');
    expect(tutorialVideoAsset.update.mock.calls[0][0].data).toEqual({
      assemblyStatus: 'pending',
      assemblyJobId: 'job-1',
      assemblyStartedAt: expect.any(Date),
    });
    expect(
      tutorialVideoAsset.update.mock.calls[1][0].data.tempoManifest,
    ).toMatchObject({
      narration: 'none',
      motion: 'none',
      storage: 'draft-frames',
      sourceAssetId: 'asset1',
    });
  });

  it('синтез не удался (лимит) — ролик собирается с подписями, немой, причина в manifest', async () => {
    const synth = jest.fn(async ({ texts }: any) => ({
      speech: texts.map(() => null),
      skipped: 'daily-limit',
    }));
    const { service, submit, tutorialVideoAsset } = voiced({}, synth);
    await service.approve('draft1', 'operator1');
    const job = submit.mock.calls[0][0];
    expect(Object.keys(job.inputs).some((k) => k.startsWith('voice'))).toBe(
      false,
    );
    expect(job.inputs.captions).toBeDefined();
    expect(
      tutorialVideoAsset.update.mock.calls[0][0].data.tempoManifest,
    ).toMatchObject({
      narration: 'none',
      voiceSkipped: 'daily-limit',
      captions: true,
    });
  });

  it('отправка не удалась — строка failed (infra, без отпечатка), дорожки стёрты, одобрение откатано', async () => {
    const {
      service,
      versions,
      submit,
      tutorialVideoAsset,
      clientSiteTutorialDraft,
    } = voiced();
    submit.mockRejectedValue(new Error('ffmpeg-api 503'));
    await expect(service.approve('draft1', 'operator1')).rejects.toThrow('503');
    expect((tutorialVideoAsset as any).updateMany).toHaveBeenCalledWith({
      where: { id: 'asset1', assemblyStatus: 'preparing' },
      data: {
        assemblyStatus: 'failed',
        assemblyError: 'infra: ffmpeg-api 503',
        contentHash: null,
      },
    });
    expect(versions.wipeSources).toHaveBeenCalledWith('asset1');
    expect(clientSiteTutorialDraft.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'draft1', status: 'APPROVED' },
      data: { status: 'PENDING_REVIEW' },
    });
  });
});
