/**
 * Очередь перевода блога — аудит 24.09.2026.
 *
 * Все проверки здесь про одно семейство ошибок: состояние, из которого
 * перевод не выходит НИКОГДА, притом что деньги за него уже списаны.
 * Три такие ловушки нашлись сразу, и они смыкались в кольцо — правка
 * статьи роняла перевод в состояние, которое не подбирал ни один запрос.
 */

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('@prisma/client', () => ({
  BlogPostStatus: {
    DRAFT: 'DRAFT',
    APPROVED: 'APPROVED',
    PUBLISHED: 'PUBLISHED',
  },
  BlogTranslationStatus: {
    PENDING: 'PENDING',
    QUEUED: 'QUEUED',
    READY: 'READY',
    FAILED: 'FAILED',
  },
  GrokBatchJobStatus: {
    SUBMITTED: 'SUBMITTED',
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED',
  },
}));
jest.mock('../ai-usage/ai-usage.service', () => ({ AiUsageService: class {} }));
jest.mock('../grok/grok-batch.service', () => ({ GrokBatchService: class {} }));

import {
  BlogTranslationService,
  MAX_TRANSLATION_ATTEMPTS,
  STUCK_BATCH_TTL_MS,
} from './blog-translation.service';

type Job = {
  id: string;
  xaiBatchId: string | null;
  submittedAt: Date;
  status: string;
};

function build(
  over: {
    jobs?: Job[];
    submitResult?: { xaiBatchId?: string; error?: string };
    batchStatus?: { pendingCount: number | null } | null;
  } = {},
) {
  const jobs = over.jobs ?? [];
  const translationUpdates: {
    where: unknown;
    data: Record<string, unknown>;
  }[] = [];
  const jobUpdates: { id: string; data: Record<string, unknown> }[] = [];

  const prisma = {
    blogPost: { findMany: jest.fn().mockResolvedValue([]) },
    blogPostTranslation: {
      findMany: jest.fn().mockResolvedValue([]),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      updateMany: jest.fn(
        async (args: { where: unknown; data: Record<string, unknown> }) => {
          translationUpdates.push(args);
          return { count: 1 };
        },
      ),
      update: jest.fn().mockResolvedValue({}),
    },
    grokBatchJob: {
      findMany: jest.fn(async () =>
        jobs.filter((j) => j.status === 'SUBMITTED'),
      ),
      create: jest.fn(async () => ({ id: 'job-new' })),
      update: jest.fn(
        async (args: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          jobUpdates.push({ id: args.where.id, data: args.data });
          return {};
        },
      ),
    },
  };
  const grokBatch = {
    isConfigured: jest.fn().mockReturnValue(true),
    submitBatch: jest
      .fn()
      .mockResolvedValue(over.submitResult ?? { xaiBatchId: 'xai-1' }),
    getBatchStatus: jest
      .fn()
      .mockResolvedValue(
        over.batchStatus === undefined ? { pendingCount: 0 } : over.batchStatus,
      ),
    getBatchResultsDetailed: jest
      .fn()
      .mockResolvedValue({ complete: true, resultsByRequestId: {} }),
  };
  const aiUsage = { record: jest.fn().mockResolvedValue(undefined) };
  const svc = new BlogTranslationService(
    prisma as never,
    grokBatch as never,
    aiUsage as never,
  );
  return { svc, prisma, grokBatch, aiUsage, translationUpdates, jobUpdates };
}

const pendingRow = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  locale: 'en',
  post: { title: 'Заголовок', bodyHtml: '<p>текст</p>' },
  ...over,
});

describe('submitPendingBatch — кого вообще берём в работу', () => {
  it('провалившийся перевод возвращается в очередь, а не лежит мёртвым', async () => {
    // Главная находка: `FAILED` не подбирал НИКТО. Деньги за элемент
    // пачки списаны, статья навсегда без языка, а единственным выходом
    // была правка текста — про которую никто не догадается.
    const { svc, prisma } = build();
    prisma.blogPostTranslation.findMany.mockResolvedValue([pendingRow()]);
    await svc.submitPendingBatch();
    const where = prisma.blogPostTranslation.findMany.mock.calls[0][0].where;
    expect(JSON.stringify(where)).toContain('FAILED');
  });

  it('повтор не бесконечен — иначе битая статья платит каждые сутки', async () => {
    const { svc, prisma } = build();
    prisma.blogPostTranslation.findMany.mockResolvedValue([pendingRow()]);
    await svc.submitPendingBatch();
    const where = prisma.blogPostTranslation.findMany.mock.calls[0][0].where;
    expect(JSON.stringify(where)).toContain(String(MAX_TRANSLATION_ATTEMPTS));
  });

  it('переводить нечего — это НЕ «пропущено», а отдельная причина', async () => {
    // Одно слово `skipped` раньше означало три разные вещи, и по логу
    // нельзя было отличить «всё переведено» от «очередь встала».
    const { svc } = build();
    await expect(svc.submitPendingBatch()).resolves.toBe(
      'nothing-to-translate',
    );
  });
});

describe('submitPendingBatch — деньги', () => {
  it('строка в базе заводится ДО подачи: падение посередине не платит дважды', async () => {
    const { svc, prisma, grokBatch } = build();
    prisma.blogPostTranslation.findMany.mockResolvedValue([pendingRow()]);
    await svc.submitPendingBatch();
    const createOrder = prisma.grokBatchJob.create.mock.invocationCallOrder[0];
    const submitOrder = grokBatch.submitBatch.mock.invocationCallOrder[0];
    expect(createOrder).toBeLessThan(submitOrder);
  });

  it('xAI отказал — переводы отпущены обратно, пачка закрыта FAILED', async () => {
    // До правки значение `GrokBatchJobStatus.FAILED` не присваивалось
    // нигде вообще, хотя схема описывает его именно так: история
    // неудачных подач не сохранялась.
    const { svc, prisma, translationUpdates, jobUpdates } = build({
      submitResult: { error: 'xAI: 503' },
    });
    prisma.blogPostTranslation.findMany.mockResolvedValue([pendingRow()]);
    await expect(svc.submitPendingBatch()).resolves.toBe('submit-failed');
    const released = translationUpdates.find(
      (u) => u.data.status === 'PENDING' && u.data.batchJobId === null,
    );
    expect(released).toBeDefined();
    expect(jobUpdates.some((u) => u.data.status === 'FAILED')).toBe(true);
  });
});

describe('pollSubmittedBatches — пачка не бывает вечной', () => {
  const job = (over: Partial<Job> = {}): Job => ({
    id: 'job-1',
    xaiBatchId: 'xai-1',
    submittedAt: new Date(),
    status: 'SUBMITTED',
    ...over,
  });

  it('отсутствующий num_pending не считается готовностью', async () => {
    // Иначе пустой список результатов превратил бы всю оплаченную
    // пачку в мёртвые FAILED с записью расхода на каждый элемент.
    const { svc, grokBatch } = build({
      jobs: [job()],
      batchStatus: { pendingCount: null },
    });
    await svc.runTranslationCron();
    expect(grokBatch.getBatchResultsDetailed).not.toHaveBeenCalled();
  });

  it('готовая пачка (ноль в ожидании) разбирается как раньше', async () => {
    const { svc, prisma, grokBatch } = build({
      jobs: [job()],
      batchStatus: { pendingCount: 0 },
    });
    // Под пачкой должен быть хоть один QUEUED-перевод: без них разбирать
    // нечего и job закрывается сразу, не читая результатов.
    prisma.blogPostTranslation.findMany.mockResolvedValue([pendingRow()]);
    await svc.runTranslationCron();
    expect(grokBatch.getBatchResultsDetailed).toHaveBeenCalled();
  });

  it('зависшая пачка снимается, а её переводы возвращаются в очередь', async () => {
    // Без этого `SUBMITTED` жил вечно, держал переводы в QUEUED (а
    // QUEUED в новую пачку не попадает) и съедал бюджет времени первым
    // — несколько таких останавливали перевод блога целиком.
    const { svc, translationUpdates, jobUpdates } = build({
      jobs: [
        job({ submittedAt: new Date(Date.now() - STUCK_BATCH_TTL_MS - 1000) }),
      ],
      batchStatus: { pendingCount: 7 },
    });
    await svc.runTranslationCron();
    expect(
      translationUpdates.some(
        (u) => u.data.status === 'PENDING' && u.data.batchJobId === null,
      ),
    ).toBe(true);
    expect(jobUpdates.some((u) => u.data.status === 'FAILED')).toBe(true);
  });

  it('свежая незавершённая пачка не трогается', async () => {
    const { svc, jobUpdates } = build({
      jobs: [job()],
      batchStatus: { pendingCount: 7 },
    });
    await svc.runTranslationCron();
    expect(jobUpdates).toHaveLength(0);
  });

  it('пачка без идентификатора отпускает свои переводы, а не держит их', async () => {
    // Окно между созданием строки и ответом xAI появилось вместе с
    // правкой порядка — и молча пропускать такую строку нельзя.
    const { svc, translationUpdates } = build({
      jobs: [job({ xaiBatchId: null })],
    });
    await svc.runTranslationCron();
    expect(translationUpdates.some((u) => u.data.batchJobId === null)).toBe(
      true,
    );
  });
});
