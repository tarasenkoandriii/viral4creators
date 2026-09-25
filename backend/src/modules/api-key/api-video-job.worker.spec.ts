jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../../common/cron-job-lock', () => ({
  tryAcquireJobLock: jest.fn().mockResolvedValue(true),
  releaseJobLock: jest.fn().mockResolvedValue(undefined),
}));

import { ForbiddenException } from '@nestjs/common';
import { ApiVideoJobWorker } from './api-video-job.worker';
import { DailySpendLimitExceededException } from '../../common/spend-limits';
import { tryAcquireJobLock } from '../../common/cron-job-lock';

/**
 * Этап 145. Воркер заявок: тот же путь, что проходит человек в мастере,
 * и те же правила повтора, что у пакетной генерации.
 */
const queued = (over: Record<string, unknown> = {}) => ({
  id: 'job-1',
  userId: 'u1',
  apiKeyId: 'k1',
  projectId: 'p1',
  productItemId: 'item-1',
  libraryEntryId: 'lib-1',
  quality: 'fast',
  aspectRatio: null,
  locale: null,
  sessionId: null,
  attempts: 0,
  ...over,
});

function build(
  over: {
    queued?: Record<string, unknown>[];
    running?: Record<string, unknown>[];
    session?: Record<string, unknown> | null;
    status?: Record<string, unknown>;
    claimed?: boolean;
  } = {},
) {
  const updates: Record<string, unknown>[] = [];
  const prisma = {
    apiVideoJob: {
      findMany: jest.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          where.status === 'RUNNING'
            ? (over.running ?? [])
            : (over.queued ?? []),
      ),
      updateMany: jest
        .fn()
        .mockResolvedValue({ count: over.claimed === false ? 0 : 1 }),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return data;
      }),
    },
  };
  const sessions = {
    getSession: jest
      .fn()
      .mockResolvedValue('session' in over ? over.session : {}),
  };
  const projectSession = {
    createFromItem: jest.fn().mockResolvedValue({ sessionId: 's1' }),
  };
  const library = { applyToSession: jest.fn().mockResolvedValue({}) };
  const prompt = {
    generatePrompt: jest.fn().mockResolvedValue({}),
    approvePrompt: jest.fn().mockResolvedValue({}),
  };
  const generation = {
    generateVideo: jest.fn().mockResolvedValue({}),
    getVideoStatus: jest
      .fn()
      .mockResolvedValue(over.status ?? { status: 'processing' }),
  };
  // Доставка исходов (этап 146) — своим набором тестов; здесь важно
  // только, что заявка о себе сообщает.
  const webhooks = {
    enqueue: jest.fn().mockResolvedValue(true),
    deliverDue: jest
      .fn()
      .mockResolvedValue({ delivered: 0, retried: 0, gaveUp: 0 }),
  };
  return {
    worker: new ApiVideoJobWorker(
      prisma as never,
      sessions as never,
      projectSession as never,
      library as never,
      prompt as never,
      generation as never,
      webhooks as never,
    ),
    webhooks,
    prisma,
    sessions,
    projectSession,
    library,
    prompt,
    generation,
    updates,
  };
}

describe('ApiVideoJobWorker — запуск', () => {
  it('проходит путь мастера и зовёт единственную точку входа в генерацию', async () => {
    // Внутри `generateVideo` живут проверки прав, блокировка, потолок
    // расхода и резерв кредитов. Обойти её значит переписать всё это.
    const b = build({ queued: [queued()] });

    const result = await b.worker.runTick();

    expect(b.projectSession.createFromItem).toHaveBeenCalledWith(
      'u1',
      'p1',
      'item-1',
      undefined,
    );
    expect(b.library.applyToSession).toHaveBeenCalledWith('s1', 'lib-1');
    expect(b.prompt.approvePrompt).toHaveBeenCalledWith('s1');
    expect(b.generation.generateVideo).toHaveBeenCalledWith(
      's1',
      'fast',
      undefined,
    );
    expect(result.started).toBe(1);
  });

  it('строка захватывается ДО платного вызова', async () => {
    // Без захвата параллельный тик (или ручной запуск из админки)
    // оплатил бы ту же заявку второй раз.
    const b = build({ queued: [queued()], claimed: false });
    await b.worker.runTick();
    expect(b.generation.generateVideo).not.toHaveBeenCalled();
  });

  it('повторный заход не платит за уже сделанное', async () => {
    // Тик мог оборваться посередине: что готово — видно по сессии, а
    // не по статусу строки.
    const b = build({
      queued: [queued({ sessionId: 's1' })],
      session: {
        generationPrompt: { approvedAt: new Date() },
        generatedVideo: { generatedVideoId: 'v1' },
      },
    });

    await b.worker.runTick();

    expect(b.library.applyToSession).not.toHaveBeenCalled();
    expect(b.prompt.generatePrompt).not.toHaveBeenCalled();
    expect(b.generation.generateVideo).not.toHaveBeenCalled();
  });

  it('промпт утверждён, но рендер не начат — доделывает только рендер', async () => {
    const b = build({
      queued: [queued({ sessionId: 's1' })],
      session: { generationPrompt: { approvedAt: new Date() } },
    });
    await b.worker.runTick();
    expect(b.prompt.generatePrompt).not.toHaveBeenCalled();
    expect(b.generation.generateVideo).toHaveBeenCalled();
  });

  it('занятый замок джоба отменяет тик целиком', async () => {
    (tryAcquireJobLock as jest.Mock).mockResolvedValueOnce(false);
    const b = build({ queued: [queued()] });
    await expect(b.worker.runTick()).resolves.toEqual({
      started: 0,
      completed: 0,
      failed: 0,
      running: 0,
      delivered: 0,
      retried: 0,
      gaveUp: 0,
    });
    expect(b.prisma.apiVideoJob.findMany).not.toHaveBeenCalled();
  });
});

describe('ApiVideoJobWorker — доведение', () => {
  it('готовый ролик закрывает заявку ссылкой', async () => {
    const b = build({
      running: [queued({ sessionId: 's1' })],
      status: {
        status: 'complete',
        postStatus: 'complete',
        downloadUrl: 'https://blob.test/v.mp4',
      },
    });

    const result = await b.worker.runTick();

    expect(result.completed).toBe(1);
    expect(b.updates[0]).toMatchObject({
      status: 'DONE',
      videoUrl: 'https://blob.test/v.mp4',
    });
  });

  it('незаконченная постобработка заявку НЕ закрывает', async () => {
    // Ролик ещё меняется: кадр режется, звук кладётся. Отдать ссылку
    // сейчас — отдать не то, что человек получит.
    const b = build({
      running: [queued({ sessionId: 's1' })],
      status: { status: 'complete', postStatus: 'pending' },
    });
    const result = await b.worker.runTick();
    expect(result.completed).toBe(0);
    expect(result.running).toBe(1);
  });

  it('отказ провайдера уходит в заявку текстом, а не объектом', async () => {
    const b = build({
      running: [queued({ sessionId: 's1' })],
      status: {
        status: 'failed',
        error: { code: 'x', message: 'Veo отказал' },
      },
    });
    await b.worker.runTick();
    expect(b.updates[0]).toMatchObject({
      status: 'FAILED',
      error: 'Veo отказал',
    });
  });
});

describe('ApiVideoJobWorker — повторы', () => {
  it('обычный отказ откладывается с удваивающейся паузой', async () => {
    const b = build({ queued: [queued({ attempts: 1 })] });
    b.generation.generateVideo.mockRejectedValue(new Error('сеть'));

    await b.worker.runTick();

    const data = b.updates[b.updates.length - 1];
    expect(data.status).toBe('FAILED');
    expect(data.attempts).toBe(2);
    expect(data.nextAttemptAt).toBeInstanceOf(Date);
  });

  it('отказ, который повтором не лечится, закрывает заявку сразу', async () => {
    // Чужой id или отозванное право не изменятся от повтора — это
    // плата за один и тот же ответ.
    const b = build({ queued: [queued()] });
    b.generation.generateVideo.mockRejectedValue(
      new ForbiddenException('нет права'),
    );

    await b.worker.runTick();

    expect(b.updates[b.updates.length - 1].nextAttemptAt).toBeNull();
  });

  it('суточный потолок не тратит попытку и ждёт полуночи', async () => {
    // Иначе три ночные заявки сгорели бы, не начавшись.
    const b = build({ queued: [queued({ attempts: 2 })] });
    b.generation.generateVideo.mockRejectedValue(
      new DailySpendLimitExceededException('потолок'),
    );

    await b.worker.runTick();

    const data = b.updates[b.updates.length - 1];
    expect(data.attempts).toBe(2);
    const at = data.nextAttemptAt as Date;
    expect(at.getTime()).toBeGreaterThan(Date.now());
    expect(at.getUTCHours()).toBe(0);
  });

  it('о неудаче сообщают, только когда заявка КОНЧИЛАСЬ', async () => {
    // «Не вышло, попробуем через четыре минуты» — наша кухня. Слать её
    // чужому приёмнику значит приучить его игнорировать наши
    // сообщения.
    const retry = build({ queued: [queued({ attempts: 0 })] });
    retry.generation.generateVideo.mockRejectedValue(new Error('сеть'));
    await retry.worker.runTick();
    expect(retry.webhooks.enqueue).not.toHaveBeenCalled();

    const last = build({ queued: [queued({ attempts: 2 })] });
    last.generation.generateVideo.mockRejectedValue(new Error('сеть'));
    await last.worker.runTick();
    expect(last.webhooks.enqueue).toHaveBeenCalledWith('u1', 'job-1', 'k1');
  });

  it('готовая заявка тоже сообщает о себе', async () => {
    const b = build({
      running: [queued({ sessionId: 's1' })],
      status: {
        status: 'complete',
        postStatus: 'complete',
        downloadUrl: 'https://blob.test/v.mp4',
      },
    });
    await b.worker.runTick();
    expect(b.webhooks.enqueue).toHaveBeenCalledWith('u1', 'job-1', 'k1');
  });

  it('исчерпанные попытки больше не выбираются никогда', async () => {
    const b = build({ queued: [queued({ attempts: 2 })] });
    b.generation.generateVideo.mockRejectedValue(new Error('сеть'));
    await b.worker.runTick();
    expect(b.updates[b.updates.length - 1].nextAttemptAt).toBeNull();
  });
});
