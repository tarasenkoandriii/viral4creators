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
import { ClientSiteTutorialAdminService } from './client-site-tutorial-admin.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { BlobService } from '../storage/blob.service';
import type { FfmpegApiService } from '../postprod/ffmpeg-api.service';

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
  };
  const prisma = {
    clientSiteTutorialDraft,
    tutorialVideoAsset,
  } as unknown as PrismaService;

  const blob = {
    getPublicUrl: jest
      .fn()
      .mockImplementation((p: string) => Promise.resolve(`https://blob/${p}`)),
  } as unknown as BlobService;

  const submit = opts.submit ?? jest.fn().mockResolvedValue({ jobId: 'job-1' });
  const ffmpeg = {
    configured: jest.fn(() => opts.ffmpegConfigured ?? true),
    submit,
  } as unknown as FfmpegApiService;

  const service = new ClientSiteTutorialAdminService(prisma, blob, ffmpeg);
  return {
    service,
    prisma,
    blob,
    ffmpeg,
    submit,
    clientSiteTutorialDraft,
    tutorialVideoAsset,
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
    const { service } = setup();
    const details = await service.details('draft1');
    expect(details.frameUrls).toEqual([
      'https://blob/tutorial-video-frames/draft1/0.jpg',
      'https://blob/tutorial-video-frames/draft1/1.jpg',
    ]);
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
      'https://blob/tutorial-video-frames/draft1/0.jpg',
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
      assemblyStatus: 'pending',
    });
    // Поле штатной обучалки НЕ переиспользуется под чужой смысл.
    expect(data.scenarioId).toBeUndefined();
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
      assemblyJobId: 'job-1',
    });
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
    const { service, submit, clientSiteTutorialDraft } = setup({
      ffmpegConfigured: false,
    });
    await expect(service.approve('draft1', 'op')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(submit).not.toHaveBeenCalled();
    // И статус вернулся на проверку — кнопка «Одобрить» осталась рабочей.
    expect(
      clientSiteTutorialDraft.updateMany.mock.calls.at(-1)[0].data,
    ).toEqual({ status: 'PENDING_REVIEW' });
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
