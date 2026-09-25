jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ApiVideoJobService, normalizeRequest } from './api-video-job.service';
import { requestFingerprint } from '../../common/api-video-job';

/**
 * Этап 145. Приём заявки: идемпотентность, права и потолок до списания.
 */
const NOW = new Date('2026-09-25T10:00:00Z');
const BODY = { productItemId: 'item-1', libraryEntryId: 'lib-1' };

const row = (over: Record<string, unknown> = {}) => ({
  id: 'job-1',
  userId: 'u1',
  status: 'QUEUED',
  videoUrl: null,
  error: null,
  fingerprint: requestFingerprint({
    productItemId: 'item-1',
    libraryEntryId: 'lib-1',
    quality: 'fast',
    aspectRatio: null,
    locale: null,
  }),
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

function build(
  over: {
    existing?: unknown;
    item?: unknown;
    entry?: unknown;
    remaining?: number;
  } = {},
) {
  const created: Record<string, unknown>[] = [];
  const prisma = {
    apiVideoJob: {
      findUnique: jest
        .fn()
        .mockResolvedValue('existing' in over ? over.existing : null),
      findFirst: jest.fn().mockResolvedValue(row()),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return row(data);
      }),
    },
    productItem: {
      findFirst: jest
        .fn()
        .mockResolvedValue('item' in over ? over.item : { projectId: 'p1' }),
    },
    analysisLibraryEntry: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          'entry' in over ? over.entry : { visibility: 'PUBLIC', userId: null },
        ),
    },
  };
  const plans = {
    budgetOf: jest.fn().mockResolvedValue({
      plan: 'PREMIUM',
      limitMicroUsd: 100_000_000,
      spentMicroUsd: 0,
      remainingMicroUsd: over.remaining ?? 100_000_000,
    }),
  };
  return {
    service: new ApiVideoJobService(prisma as never, plans as never),
    prisma,
    plans,
    created,
  };
}

describe('normalizeRequest', () => {
  it('без товара или референса заявку не принимают', () => {
    // Чужой код узнаёт об опечатке из ответа, а не из заявки, которая
    // упадёт через минуту.
    expect(() => normalizeRequest({ ...BODY, productItemId: ' ' })).toThrow(
      BadRequestException,
    );
    expect(() => normalizeRequest({ ...BODY, libraryEntryId: '' })).toThrow(
      BadRequestException,
    );
  });

  it('незнакомый язык — отказ, а не ролик не на том языке (аудит этапа 147)', () => {
    // Описание объявляет перечисление; первая редакция принимала любую
    // строку, и опечатка в локали узнавалась только по готовому ролику.
    expect(() => normalizeRequest({ ...BODY, locale: 'fr' })).toThrow(
      BadRequestException,
    );
    expect(normalizeRequest({ ...BODY, locale: 'de' }).locale).toBe('de');
    expect(normalizeRequest(BODY).locale).toBeNull();
  });

  it('незнакомое качество — отказ, а не тихий откат к дешёвому', () => {
    // Просил `standard`, получил бы `fast` и не узнал об этом.
    expect(() => normalizeRequest({ ...BODY, quality: 'ultra' })).toThrow(
      BadRequestException,
    );
    expect(normalizeRequest({ ...BODY, quality: 'standard' }).quality).toBe(
      'standard',
    );
    expect(normalizeRequest(BODY).quality).toBe('fast');
  });

  it('пустые необязательные поля становятся null, а не пустой строкой', () => {
    const r = normalizeRequest({ ...BODY, aspectRatio: '  ', locale: '' });
    expect(r.aspectRatio).toBeNull();
    expect(r.locale).toBeNull();
  });
});

describe('ApiVideoJobService.submit', () => {
  it('новая заявка создаётся и это НЕ повтор', async () => {
    const { service, created } = build();
    const result = await service.submit('u1', 'k1', BODY, 'idem-1');
    expect(result.repeated).toBe(false);
    expect(created[0]).toMatchObject({
      userId: 'u1',
      apiKeyId: 'k1',
      idempotencyKey: 'idem-1',
      projectId: 'p1',
      productItemId: 'item-1',
      quality: 'fast',
    });
  });

  it('повтор с тем же ключом и телом отдаёт ТУ ЖЕ заявку, не создавая вторую', async () => {
    // Чужой клиент не знает, дошёл ли первый запрос после таймаута, и
    // шлёт второй. Вторая генерация за те же деньги — не его ошибка.
    const { service, prisma } = build({ existing: row() });
    const result = await service.submit('u1', 'k1', BODY, 'idem-1');
    expect(result.repeated).toBe(true);
    expect(result.job.jobId).toBe('job-1');
    expect(prisma.apiVideoJob.create).not.toHaveBeenCalled();
  });

  it('тот же ключ с ДРУГИМ телом — отказ, а не чужая заявка в ответ', async () => {
    // Это не повтор, а переиспользованный ключ. Молча отдать чужой
    // ролик значит спрятать ошибку до момента, когда она будет стоить
    // дорого.
    const { service } = build({ existing: row() });
    await expect(
      service.submit(
        'u1',
        'k1',
        { ...BODY, libraryEntryId: 'lib-DIFFERENT' },
        'idem-1',
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('без ключа повтора заявки не ищут вовсе', async () => {
    // Иначе `findUnique` по `null` совпал бы с первой попавшейся
    // заявкой без ключа.
    const { service, prisma } = build();
    await service.submit('u1', 'k1', BODY, null);
    expect(prisma.apiVideoJob.findUnique).not.toHaveBeenCalled();
  });

  it('чужой товар — 404, и проверяется он ДО создания заявки', async () => {
    const { service, prisma } = build({ item: null });
    await expect(service.submit('u1', 'k1', BODY, null)).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.apiVideoJob.create).not.toHaveBeenCalled();
    // Владелец и мягкое удаление — часть условия, а не забота вызывающего.
    expect(prisma.productItem.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'item-1',
        deletedAt: null,
        project: { userId: 'u1', deletedAt: null },
      },
      select: { projectId: true },
    });
  });

  it('чужой разбор референса — 404 на подаче, а не падение через минуту', async () => {
    // Тот же довод, по которому проверяется товар; про второй
    // идентификатор про него просто забыли (аудит этапа 147).
    const { service, prisma } = build({ entry: null });
    await expect(service.submit('u1', 'k1', BODY, null)).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.apiVideoJob.create).not.toHaveBeenCalled();
  });

  it('приватный чужой разбор не подтверждает даже своё существование', async () => {
    // Правило видимости то же, что при просмотре: не «чужое», а «нет».
    const { service } = build({
      entry: { visibility: 'PRIVATE', userId: 'somebody-else' },
    });
    await expect(service.submit('u1', 'k1', BODY, null)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('свой приватный разбор берётся', async () => {
    const { service } = build({
      entry: { visibility: 'PRIVATE', userId: 'u1' },
    });
    await expect(service.submit('u1', 'k1', BODY, null)).resolves.toMatchObject(
      { repeated: false },
    );
  });

  it('выбранный потолок — отказ на подаче, с числами', async () => {
    // Иначе интегратор узнает о потолке не из ответа на свой запрос, а
    // из заявки, упавшей через минуту, — если вообще пойдёт за ней.
    const { service, prisma } = build({ remaining: 0 });
    const failure = await service
      .submit('u1', 'k1', BODY, null)
      .catch((e: Error) => e);
    expect(failure).toBeInstanceOf(ForbiddenException);
    expect((failure as Error).message).toContain('$100.00');
    expect(prisma.apiVideoJob.create).not.toHaveBeenCalled();
  });

  it('повтор отдаётся даже при выбранном потолке', async () => {
    // Заявка уже принята и оплачена решением; отказать на повторе
    // значило бы заставить клиента думать, что её нет.
    const { service } = build({ existing: row(), remaining: 0 });
    await expect(
      service.submit('u1', 'k1', BODY, 'idem-1'),
    ).resolves.toMatchObject({ repeated: true });
  });
});

describe('ApiVideoJobService.get', () => {
  it('чужая заявка по номеру не отдаётся', async () => {
    const { service, prisma } = build();
    await service.get('u1', 'job-1');
    expect(prisma.apiVideoJob.findFirst).toHaveBeenCalledWith({
      where: { id: 'job-1', userId: 'u1' },
    });
  });

  it('несуществующая — 404', async () => {
    const { service, prisma } = build();
    prisma.apiVideoJob.findFirst.mockResolvedValue(null);
    await expect(service.get('u1', 'job-1')).rejects.toThrow(NotFoundException);
  });
});
