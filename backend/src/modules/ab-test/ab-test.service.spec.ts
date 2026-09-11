import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AbTestService } from './ab-test.service';
import { SessionStatus } from '../../common/types/session.types';
import { GenerationStatus } from '../../common/types/generation.types';

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

function sourceSession(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'src-session',
    userId: 'user1',
    projectId: 'proj1',
    productItemId: 'pi-source',
    status: SessionStatus.VIDEO_COMPLETE,
    librarySourceKey: 'lib-key-1',
    locale: 'ru',
    generationPrompt: {
      finalText: 'исходный одобренный промпт',
      finalVoiceoverScript: 'исходная озвучка',
    },
    generatedVideo: {
      generatedVideoId: 'gv1',
      pathname: 'sessions/src-session/generated.mp4',
      fileName: 'generated.mp4',
      mimeType: 'video/mp4',
      status: GenerationStatus.COMPLETE,
      initiatedAt: new Date(),
      quality: 'fast',
      aspectRatio: '9:16',
    },
    ...overrides,
  };
}

function draft(i: number, overrides: Record<string, unknown> = {}) {
  return {
    hookLabel: `Хук ${i}`,
    ctaLabel: `CTA ${i}`,
    prompt: `alt prompt ${i}`,
    voiceoverScript: `alt voiceover ${i}`,
    ...overrides,
  };
}

function setup(
  opts: {
    source?: unknown;
    libraryEntry?: unknown;
    drafts?: unknown[];
    /** Е-2.5 шестого аудита: что находит `assertNotBusy` (и снаружи
     * транзакции, и внутри неё, по умолчанию — одно и то же значение,
     * если явно не задано другое через `stillBusy`, симулируя
     * конкурентную вставку между двумя проверками). */
    busy?: unknown;
    stillBusy?: unknown;
    serializationFailuresBeforeSuccess?: number;
  } = {},
) {
  const sessions = {
    getSession: jest
      .fn()
      .mockResolvedValue(
        opts.source === undefined ? sourceSession() : opts.source,
      ),
  };
  // Отдельная переменная, а не self-reference внутри объекта `prisma` —
  // TS не может вывести тип `prisma` из инициализатора, ссылающегося на
  // саму себя (TS7022/TS7024, тот же приём, что у catalog-batch.service.spec.ts).
  const abTestRun = {
    create: jest.fn().mockResolvedValue({ id: 'run1' }),
    findUnique: jest.fn(),
  };
  const txAbTestVariant = {
    findFirst: jest
      .fn()
      .mockResolvedValue(
        opts.stillBusy === undefined ? (opts.busy ?? null) : opts.stillBusy,
      ),
    createMany: jest.fn().mockResolvedValue(undefined),
    // Этап 78 — `createMany` не возвращает id, пост-createMany подбор id
    // созданных строк для события воронки эхом отражает последний вызов
    // `createMany` (тот же приём, что у catalog-batch.service.spec.ts).
    findMany: jest.fn(() => {
      const lastCreateMany = (
        txAbTestVariant.createMany as jest.Mock
      ).mock.calls.slice(-1)[0]?.[0]?.data as unknown[] | undefined;
      return Promise.resolve(
        (lastCreateMany ?? []).map((_, i) => ({ id: `created-variant-${i}` })),
      );
    }),
  };
  let remainingFailures = opts.serializationFailuresBeforeSuccess ?? 0;
  const workflowStageEvent = { create: jest.fn().mockResolvedValue({}) };
  const prisma = {
    workflowStageEvent,
    analysisLibraryEntry: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          opts.libraryEntry === undefined
            ? { id: 'entry1' }
            : opts.libraryEntry,
        ),
    },
    abTestVariant: {
      update: jest.fn().mockResolvedValue(undefined),
      findFirst: jest.fn().mockResolvedValue(opts.busy ?? null),
    },
    abTestRun,
    $transaction: jest.fn(
      async (
        fn: (tx: unknown) => unknown,
        options?: { isolationLevel?: string },
      ) => {
        if (remainingFailures > 0) {
          remainingFailures -= 1;
          const err = new Error('could not serialize access');
          (err as { code?: string }).code = 'P2034';
          throw err;
        }
        expect(options).toEqual({ isolationLevel: 'Serializable' });
        return fn({
          abTestRun,
          abTestVariant: txAbTestVariant,
          workflowStageEvent,
        });
      },
    ),
  };
  const prompts = {
    generateAbVariants: jest
      .fn()
      .mockResolvedValue(
        opts.drafts === undefined
          ? [draft(1), draft(2), draft(3)]
          : opts.drafts,
      ),
  };
  const plans = {
    assertUser: jest.fn().mockResolvedValue(undefined),
  };
  const service = new AbTestService(
    prisma as never,
    sessions as never,
    prompts as never,
    plans as never,
  );
  return { service, prisma, sessions, prompts, plans, txAbTestVariant };
}

describe('AbTestService.create', () => {
  it('план проверяется первым делом — тем же признаком, что и пакетная генерация по каталогу', async () => {
    const { service, plans } = setup();
    await service.create('user1', 'proj1', { sourceSessionId: 'src-session' });
    expect(plans.assertUser).toHaveBeenCalledWith('user1', 'library');
  });

  it('исходная сессия не найдена — 404', async () => {
    const { service, sessions } = setup();
    sessions.getSession.mockResolvedValue(undefined);
    await expect(
      service.create('user1', 'proj1', { sourceSessionId: 'missing' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('исходная сессия принадлежит другому пользователю — 404, а не 403 (не подтверждаем существование)', async () => {
    const { service, sessions } = setup();
    sessions.getSession.mockResolvedValue(
      sourceSession({ userId: 'someone-else' }),
    );
    await expect(
      service.create('user1', 'proj1', { sourceSessionId: 'src-session' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('исходный ролик ещё не готов — 400', async () => {
    const { service, sessions } = setup();
    sessions.getSession.mockResolvedValue(
      sourceSession({
        status: SessionStatus.PROMPT_GENERATED,
        generatedVideo: undefined,
      }),
    );
    await expect(
      service.create('user1', 'proj1', { sourceSessionId: 'src-session' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('у исходной сессии нет одобренного промпта — 400', async () => {
    const { service, sessions } = setup();
    sessions.getSession.mockResolvedValue(
      sourceSession({ generationPrompt: undefined }),
    );
    await expect(
      service.create('user1', 'proj1', { sourceSessionId: 'src-session' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('у исходной сессии нет разбора в библиотеке — 400 (не должно случаться в обычном потоке)', async () => {
    const { service, sessions } = setup();
    sessions.getSession.mockResolvedValue(
      sourceSession({ librarySourceKey: null }),
    );
    await expect(
      service.create('user1', 'proj1', { sourceSessionId: 'src-session' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('у исходной сессии нет привязанного товара — 400', async () => {
    const { service, sessions } = setup();
    sessions.getSession.mockResolvedValue(
      sourceSession({ productItemId: null }),
    );
    await expect(
      service.create('user1', 'proj1', { sourceSessionId: 'src-session' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('запись библиотеки не найдена — 404', async () => {
    const { service } = setup({ libraryEntry: null });
    await expect(
      service.create('user1', 'proj1', { sourceSessionId: 'src-session' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('модель не вернула ни одного варианта — 400, запуск не создаётся', async () => {
    const { service, prisma } = setup({ drafts: [] });
    await expect(
      service.create('user1', 'proj1', { sourceSessionId: 'src-session' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.abTestRun.create).not.toHaveBeenCalled();
  });

  it('единственный вызов GPT-5 — generateAbVariants на исходной сессии, с фиксированным числом 3', async () => {
    const { service, prompts } = setup();
    await service.create('user1', 'proj1', { sourceSessionId: 'src-session' });
    expect(prompts.generateAbVariants).toHaveBeenCalledWith('src-session', 3);
  });

  it('успешное создание — запуск и строки записаны из уже готовых вариантов, без нового обращения к сессии из воркера', async () => {
    const { service, prisma } = setup();
    const result = await service.create('user1', 'proj1', {
      sourceSessionId: 'src-session',
    });
    expect(result).toEqual({ runId: 'run1', variantCount: 3 });
    expect(prisma.abTestRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          projectId: 'proj1',
          userId: 'user1',
          sourceSessionId: 'src-session',
          productItemId: 'pi-source',
          libraryEntryId: 'entry1',
          quality: 'fast',
          aspectRatio: '9:16',
          locale: 'ru',
        }),
      }),
    );
  });

  it('модель вернула меньше вариантов, чем запрошено — создаёт запуск с тем, что получила, не проваливает весь запрос', async () => {
    const { service } = setup({ drafts: [draft(1), draft(2)] });
    const result = await service.create('user1', 'proj1', {
      sourceSessionId: 'src-session',
    });
    expect(result.variantCount).toBe(2);
  });

  describe('Е-2.5 шестого аудита: защита от конкурентного создания запуска', () => {
    it('уже есть не-FAILED вариант для этого sourceSessionId — 400 ДО вызова GPT-5', async () => {
      const { service, prompts } = setup({ busy: { id: 'existing-variant' } });
      await expect(
        service.create('user1', 'proj1', { sourceSessionId: 'src-session' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prompts.generateAbVariants).not.toHaveBeenCalled();
    });

    it('предварительная проверка ищет НЕ-FAILED вариант именно этого sourceSessionId', async () => {
      const { service, prisma } = setup();
      await service.create('user1', 'proj1', {
        sourceSessionId: 'src-session',
      });
      expect(prisma.abTestVariant.findFirst).toHaveBeenCalledWith({
        where: {
          status: { not: 'FAILED' },
          run: { sourceSessionId: 'src-session' },
        },
        select: { id: true },
      });
    });

    it('все варианты предыдущего запуска FAILED — не считается занятым, GPT-5 вызывается, новый запуск создаётся', async () => {
      const { service, prompts, prisma } = setup({ busy: null });
      const result = await service.create('user1', 'proj1', {
        sourceSessionId: 'src-session',
      });
      expect(prompts.generateAbVariants).toHaveBeenCalled();
      expect(prisma.abTestRun.create).toHaveBeenCalled();
      expect(result.runId).toBe('run1');
    });

    it('конкурентный запуск успел занять sourceSessionId МЕЖДУ предварительной проверкой и транзакцией — итог по tx-проверке, GPT-5 уже оплачен, но строка не создаётся', async () => {
      const { service, prompts, prisma, txAbTestVariant } = setup({
        busy: null,
        stillBusy: { id: 'raced-in-variant' },
      });
      await expect(
        service.create('user1', 'proj1', { sourceSessionId: 'src-session' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      // GPT-5 уже был вызван (предварительная проверка это разрешила) —
      // это цена гонки, а не что-то новое: тот же trade-off, что у
      // CatalogBatchService.create() (проверка вне транзакции дешёвая, но
      // не абсолютная защита — Serializable внутри транзакции гарантирует
      // отсутствие ДУБЛЯ строки, не отсутствие потраченного GPT-5-вызова).
      expect(prompts.generateAbVariants).toHaveBeenCalled();
      expect(prisma.abTestRun.create).not.toHaveBeenCalled();
      expect(txAbTestVariant.findFirst).toHaveBeenCalled();
    });

    it('ошибка сериализации (P2034) — транзакция перезапускается автоматически и в итоге проходит', async () => {
      const { service, prisma } = setup({
        serializationFailuresBeforeSuccess: 2,
      });
      const result = await service.create('user1', 'proj1', {
        sourceSessionId: 'src-session',
      });
      expect(result).toEqual({ runId: 'run1', variantCount: 3 });
      expect(prisma.$transaction).toHaveBeenCalledTimes(3);
    });

    it('ошибка сериализации повторяется больше лимита ретраев — пробрасывается наружу', async () => {
      const { service } = setup({ serializationFailuresBeforeSuccess: 10 });
      await expect(
        service.create('user1', 'proj1', { sourceSessionId: 'src-session' }),
      ).rejects.toMatchObject({ code: 'P2034' });
    });
  });

  describe('событие воронки (этап 78, doc/WORKFLOW-FUNNEL-SPEC.md §3.2)', () => {
    it('на каждый созданный вариант пишется первое событие, fromStage: null', async () => {
      const { service, prisma } = setup({ drafts: [draft(1), draft(2)] });
      await service.create('user1', 'proj1', {
        sourceSessionId: 'src-session',
      });
      expect(prisma.workflowStageEvent.create).toHaveBeenCalledTimes(2);
      expect(prisma.workflowStageEvent.create).toHaveBeenCalledWith({
        data: {
          workflow: 'AB_TEST_VARIANT',
          entityId: 'created-variant-0',
          fromStage: null,
          stage: 'PENDING',
        },
      });
      expect(prisma.workflowStageEvent.create).toHaveBeenCalledWith({
        data: {
          workflow: 'AB_TEST_VARIANT',
          entityId: 'created-variant-1',
          fromStage: null,
          stage: 'PENDING',
        },
      });
    });
  });
});

describe('AbTestService.getStatus', () => {
  function setupStatus(
    opts: {
      run?: unknown;
      session?: unknown;
    } = {},
  ) {
    const sessions = {
      getSession: jest.fn().mockResolvedValue(opts.session),
    };
    const prisma = {
      abTestRun: {
        findUnique: jest.fn().mockResolvedValue(opts.run),
      },
      abTestVariant: {
        update: jest.fn().mockReturnValue({
          catch: jest.fn().mockResolvedValue(undefined),
        }),
      },
      // Этап 78 — событие воронки при оппортунистической синхронизации.
      workflowStageEvent: { create: jest.fn().mockResolvedValue({}) },
    };
    const service = new AbTestService(
      prisma as never,
      sessions as never,
      { generateAbVariants: jest.fn() } as never,
      { assertUser: jest.fn() } as never,
    );
    return { service, prisma, sessions };
  }

  it('запуск не найден/не свой — 404', async () => {
    const { service } = setupStatus({ run: null });
    await expect(
      service.getStatus('user1', 'proj1', 'run1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('GENERATING со свежезавершённым рендером — статус в ответе становится DONE, живьём из сессии', async () => {
    const { service, prisma } = setupStatus({
      run: {
        id: 'run1',
        userId: 'user1',
        projectId: 'proj1',
        variants: [
          {
            id: 'variant1',
            variantIndex: 0,
            hookLabel: 'Хук 1',
            ctaLabel: 'CTA 1',
            sessionId: 'sess1',
            status: 'GENERATING',
            error: null,
          },
        ],
      },
      session: {
        generatedVideo: { status: GenerationStatus.COMPLETE },
      },
    });
    const result = await service.getStatus('user1', 'proj1', 'run1');
    expect(result.variants[0].status).toBe('DONE');
    expect(result.summary).toEqual({
      pending: 0,
      generating: 0,
      done: 1,
      failed: 0,
    });
    expect(prisma.abTestVariant.update).toHaveBeenCalledWith({
      where: { id: 'variant1' },
      data: { status: 'DONE' },
    });
    expect(prisma.workflowStageEvent.create).toHaveBeenCalledWith({
      data: {
        workflow: 'AB_TEST_VARIANT',
        entityId: 'variant1',
        fromStage: 'GENERATING',
        stage: 'DONE',
      },
    });
  });

  it('GENERATING с провалившимся рендером — статус FAILED и текст ошибки из сессии', async () => {
    const { service, prisma } = setupStatus({
      run: {
        id: 'run1',
        userId: 'user1',
        projectId: 'proj1',
        variants: [
          {
            id: 'variant1',
            variantIndex: 0,
            hookLabel: 'Хук 1',
            ctaLabel: 'CTA 1',
            sessionId: 'sess1',
            status: 'GENERATING',
            error: null,
          },
        ],
      },
      session: {
        generatedVideo: {
          status: GenerationStatus.FAILED,
          error: { message: 'Veo отказал' },
        },
      },
    });
    const result = await service.getStatus('user1', 'proj1', 'run1');
    expect(result.variants[0].status).toBe('FAILED');
    expect(result.variants[0].error).toBe('Veo отказал');
    expect(prisma.workflowStageEvent.create).toHaveBeenCalledWith({
      data: {
        workflow: 'AB_TEST_VARIANT',
        entityId: 'variant1',
        fromStage: 'GENERATING',
        stage: 'FAILED',
      },
    });
  });

  it('PENDING без sessionId — не трогает сессии вовсе', async () => {
    const { service, sessions } = setupStatus({
      run: {
        id: 'run1',
        userId: 'user1',
        projectId: 'proj1',
        variants: [
          {
            id: 'variant1',
            variantIndex: 0,
            hookLabel: 'Хук 1',
            ctaLabel: 'CTA 1',
            sessionId: null,
            status: 'PENDING',
            error: null,
          },
        ],
      },
    });
    const result = await service.getStatus('user1', 'proj1', 'run1');
    expect(result.variants[0].status).toBe('PENDING');
    expect(sessions.getSession).not.toHaveBeenCalled();
  });
});
