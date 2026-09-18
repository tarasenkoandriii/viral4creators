/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../plan/plan.service', () => ({ PlanService: class {} }));
jest.mock('../ai-usage/ai-usage.service', () => ({ AiUsageService: class {} }));
jest.mock('../storage/blob.service', () => ({ BlobService: class {} }));
jest.mock('../../common/session.service', () => ({ SessionService: class {} }));
jest.mock('./sketch-generator.service', () => ({
  SketchGeneratorService: class {},
}));
jest.mock('./sketch-targets', () => {
  const actual = jest.requireActual('./sketch-targets');
  return { ...actual, SketchTargetsService: class {} };
});

import {
  BadRequestException,
  ConflictException,
  HttpException,
} from '@nestjs/common';
import { ImageSketchService } from './image-sketch.service';
import { SKETCH_CONFLICT, SketchTarget } from '../../common/types/sketch.types';

const TARGET: SketchTarget = {
  type: 'session-character',
  id: 's1',
  subId: 'c1',
};

const SLOT = {
  target: TARGET,
  kind: 'character' as const,
  userId: 'u1',
  feature: 'characterReplacement' as const,
  originalPathname: 'sessions/s1/characters/c1/photo.jpg' as string | null,
  originalUrl: 'https://blob/sessions/s1/characters/c1/photo.jpg' as
    | string
    | null,
  ownsOriginalFile: true,
  sketch: null as null | Record<string, unknown>,
  originalDeleted: false,
  description: 'женщина 30 лет' as string | null,
  name: null as string | null,
};

const OK_OUTCOME = {
  status: 'ok' as const,
  bytes: Buffer.from('png'),
  mimeType: 'image/png',
  model: 'gemini-3.1-flash-image',
  raw: { usageMetadata: { candidatesTokenCount: 1120 } },
};

function build(
  over: {
    slot?: Partial<typeof SLOT>;
    plan?: string;
    dayUsed?: number;
    monthUsed?: number;
    outcome?: unknown;
    /** Чужие живые брони, созданные РАНЬШЕ нашей (аудит A-10). */
    pendingAhead?: number;
  } = {},
) {
  const slot = { ...SLOT, ...over.slot };
  const rows: Record<string, any> = {};
  let seq = 0;
  const ahead = Array.from({ length: over.pendingAhead ?? 0 }, (_, i) => ({
    id: `other${i}`,
  }));
  const prisma = {
    imageSketch: {
      create: jest.fn().mockImplementation(async ({ data }: any) => {
        seq += 1;
        const row = {
          id: `sk${seq}`,
          createdAt: new Date('2026-09-17T10:00:00.000Z'),
          appliedAt: null,
          auto: false,
          url: null,
          pathname: null,
          mimeType: null,
          sourceHash: null,
          ...data,
        };
        rows[row.id] = row;
        return row;
      }),
      update: jest.fn().mockImplementation(async ({ where, data }: any) => {
        rows[where.id] = { ...rows[where.id], ...data };
        return rows[where.id];
      }),
      updateMany: jest.fn().mockImplementation(async ({ where, data }: any) => {
        const row = where.id && !where.id.in ? rows[where.id] : null;
        if (row && typeof data.status === 'string') row.status = data.status;
        return { count: 1 };
      }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn().mockImplementation(async ({ where }: any) => {
        const row = rows[where.id];
        return row && row.userId === where.userId ? row : null;
      }),
      findUnique: jest
        .fn()
        .mockImplementation(async ({ where }: any) => rows[where.id] ?? null),
      // Единственный `findMany` в горячем пути — список живых броней.
      findMany: jest.fn().mockImplementation(async ({ where }: any) =>
        where?.status === 'pending'
          ? [
              ...ahead,
              ...Object.values(rows)
                .filter((r: any) => r.status === 'pending')
                .map((r: any) => ({ id: r.id })),
            ]
          : [],
      ),
    },
    productItem: { count: jest.fn().mockResolvedValue(0) },
    brandCharacter: { count: jest.fn().mockResolvedValue(0) },
    brandScene: { count: jest.fn().mockResolvedValue(0) },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const targets = {
    load: jest.fn().mockImplementation(async () => ({ ...slot })),
    assertSlotAccess: jest.fn(),
    readOriginal: jest.fn().mockResolvedValue(Buffer.from('original')),
    writeActive: jest
      .fn()
      .mockImplementation(async (s: any, sketch: any, opts: any = {}) => ({
        ...s,
        sketch,
        originalDeleted: opts.originalDeleted ?? s.originalDeleted,
      })),
    propagateSketch: jest.fn().mockResolvedValue(3),
    deleteOriginalBlob: jest.fn().mockResolvedValue(true),
  };
  const generator = {
    generate: jest.fn().mockResolvedValue(over.outcome ?? OK_OUTCOME),
  };
  const plans = {
    planOfUser: jest.fn().mockResolvedValue(over.plan ?? 'STANDARD'),
    assertUser: jest.fn(),
    assertCanSpendUser: jest.fn(),
  };
  const aiUsage = {
    countToday: jest.fn().mockResolvedValue(over.dayUsed ?? 0),
    countSince: jest.fn().mockResolvedValue(over.monthUsed ?? 0),
    recordGemini: jest.fn(),
  };
  const blob = {
    uploadBuffer: jest
      .fn()
      .mockResolvedValue({ url: 'https://blob/sketches/u1/sk1.png' }),
    deleteBlob: jest.fn(),
  };
  const sessions = {
    getSession: jest.fn().mockResolvedValue({ generationPrompt: null }),
    updateSession: jest.fn(),
    claimWork: jest.fn().mockResolvedValue(true),
    releaseWork: jest.fn().mockResolvedValue(undefined),
  };
  const service = new ImageSketchService(
    prisma as any,
    targets as any,
    generator as any,
    plans as any,
    aiUsage as any,
    blob as any,
    sessions as any,
  );
  return {
    service,
    prisma,
    targets,
    generator,
    plans,
    aiUsage,
    blob,
    sessions,
    rows,
  };
}

/** Статус, с которым запись в итоге осталась (бронь → результат). */
function statusOf(rows: Record<string, any>, id: string): string {
  return rows[id]?.status;
}

describe('ImageSketchService.generate', () => {
  it('рисует, пишет расход с userId и отдаёт кандидата с файлом', async () => {
    const { service, aiUsage, blob, prisma, rows } = build({ dayUsed: 2 });
    const r = await service.generate(
      { target: TARGET, mode: 'from-image', style: 'pencil', options: {} },
      'u1',
    );
    expect(aiUsage.recordGemini).toHaveBeenCalledWith(
      OK_OUTCOME.raw,
      expect.objectContaining({
        operation: 'ai-sketch',
        userId: 'u1',
        sessionId: 's1',
      }),
    );
    expect(blob.uploadBuffer.mock.calls[0][0]).toMatch(
      /^sketches\/u1\/sk1\.png$/,
    );
    expect(r.sketch.status).toBe('candidate');
    // Бронь квоты создаётся ДО вызова модели и только потом становится
    // кандидатом (аудит A-10).
    expect(prisma.imageSketch.create.mock.calls[0][0].data.status).toBe(
      'pending',
    );
    expect(statusOf(rows, r.sketch.id)).toBe('candidate');
    expect(prisma.imageSketch.create).toHaveBeenCalledTimes(1);
  });

  it('слот сессии берётся под замок и освобождается после', async () => {
    const { service, sessions } = build();
    await service.generate(
      { target: TARGET, mode: 'from-text', style: 'flat', options: {} },
      'u1',
    );
    expect(sessions.claimWork).toHaveBeenCalledWith(
      's1',
      'sketch',
      expect.any(Number),
    );
    expect(sessions.releaseWork).toHaveBeenCalledWith('s1', 'sketch');
  });

  it('замок занят — 409 без обращения к модели', async () => {
    const ctx = build();
    ctx.sessions.claimWork.mockResolvedValue(false);
    await expect(
      ctx.service.generate(
        { target: TARGET, mode: 'from-text', style: 'flat', options: {} },
        'u1',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(ctx.generator.generate).not.toHaveBeenCalled();
  });

  it('людям с фото обезличивание ставит сервер, что бы ни прислал клиент', async () => {
    const { service, prisma, generator } = build();
    await service.generate(
      {
        target: TARGET,
        mode: 'from-image',
        style: 'pencil',
        options: { anonymizeFace: false },
      },
      'u1',
    );
    expect(
      prisma.imageSketch.create.mock.calls[0][0].data.options,
    ).toMatchObject({ anonymizeFace: true });
    expect(generator.generate.mock.calls[0][0].prompt).toContain(
      'NOT recognisable',
    );
  });

  it('суточная и месячная квоты отвечают 429 и не зовут модель', async () => {
    const day = build({ dayUsed: 15 });
    const dayErr = await day.service
      .generate(
        { target: TARGET, mode: 'from-text', style: 'flat', options: {} },
        'u1',
      )
      .catch((e: unknown) => e);
    expect(dayErr).toMatchObject({ status: 429 });
    expect(day.generator.generate).not.toHaveBeenCalled();
    // Ответ 429 несёт квоту и апсейл — иначе экран не знает, какой
    // именно лимит кончился (аудит A-2).
    expect((dayErr as HttpException).getResponse()).toMatchObject({
      quota: expect.objectContaining({ dayLimit: 15 }),
      upgrade: 'PREMIUM',
    });
    // Бронь не пригодилась — снята, лимит не «съеден» на пять минут.
    expect(day.prisma.imageSketch.deleteMany).toHaveBeenCalled();

    const month = build({ plan: 'PREMIUM', dayUsed: 1, monthUsed: 600 });
    const err = await month.service
      .generate(
        { target: TARGET, mode: 'from-text', style: 'flat', options: {} },
        'u1',
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getResponse()).toMatchObject({
      upgrade: null,
    });
  });

  it('параллельные запросы видят чужие брони и не пробивают лимит', async () => {
    // Лимит STANDARD — 15 в сутки; расход 14, но впереди уже две живые
    // брони: наша оказывается шестнадцатой по счёту (аудит A-10).
    const ctx = build({ dayUsed: 14, pendingAhead: 2 });
    await expect(
      ctx.service.generate(
        { target: TARGET, mode: 'from-text', style: 'flat', options: {} },
        'u1',
      ),
    ).rejects.toMatchObject({ status: 429 });
    expect(ctx.generator.generate).not.toHaveBeenCalled();
  });

  it('сбой без ответа модели: 502, расход не пишется, запись — failed', async () => {
    const { service, aiUsage, rows } = build({
      outcome: { status: 'failed', reason: 'ETIMEDOUT', model: 'm' },
    });
    await expect(
      service.generate(
        { target: TARGET, mode: 'from-image', style: 'pencil', options: {} },
        'u1',
      ),
    ).rejects.toMatchObject({ status: 502 });
    expect(aiUsage.recordGemini).not.toHaveBeenCalled();
    expect(statusOf(rows, 'sk1')).toBe('failed');
  });

  it('отказ модели: 422, расход пишется — вызов оплачен', async () => {
    const { service, aiUsage, rows } = build({
      outcome: { status: 'refused', reason: 'SAFETY', model: 'm', raw: {} },
    });
    await expect(
      service.generate(
        { target: TARGET, mode: 'from-image', style: 'pencil', options: {} },
        'u1',
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect(aiUsage.recordGemini).toHaveBeenCalled();
    expect(statusOf(rows, 'sk1')).toBe('refused');
  });

  it('по описанию без текста и по фото без файла — 400 до модели и до брони', async () => {
    const noText = build({ slot: { description: null } });
    await expect(
      noText.service.generate(
        { target: TARGET, mode: 'from-text', style: 'flat', options: {} },
        'u1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(noText.prisma.imageSketch.create).not.toHaveBeenCalled();

    const noFile = build({ slot: { originalPathname: null } });
    await expect(
      noFile.service.generate(
        { target: TARGET, mode: 'from-image', style: 'flat', options: {} },
        'u1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(noFile.generator.generate).not.toHaveBeenCalled();
  });
});

describe('ImageSketchService.apply / revert / deleteOriginal', () => {
  async function withCandidate(over: Parameters<typeof build>[0] = {}) {
    const ctx = build(over);
    const r = await ctx.service.generate(
      { target: TARGET, mode: 'from-text', style: 'pencil', options: {} },
      'u1',
    );
    return { ...ctx, sketchId: r.sketch.id };
  }

  it('применение пишет скетч в слот и вытесняет прежний', async () => {
    const ctx = await withCandidate();
    const slot = await ctx.service.apply(ctx.sketchId, 'u1');
    expect(slot).toMatchObject({ variant: 'sketch', sketchId: ctx.sketchId });
    const statuses = ctx.prisma.imageSketch.updateMany.mock.calls.map(
      (c: any) => c[0].data.status,
    );
    expect(statuses).toContain('applied');
    expect(statuses).toContain('superseded');
  });

  it('применение доводит подмену до опубликованных страниц (A-3)', async () => {
    const ctx = await withCandidate();
    await ctx.service.apply(ctx.sketchId, 'u1');
    expect(ctx.targets.propagateSketch).toHaveBeenCalled();
  });

  it('сбой пропагации не отменяет применение', async () => {
    const ctx = await withCandidate();
    ctx.targets.propagateSketch.mockRejectedValueOnce(new Error('blob down'));
    const slot = await ctx.service.apply(ctx.sketchId, 'u1');
    expect(slot.variant).toBe('sketch');
  });

  it('прежний скетч можно применить повторно из истории (A-13)', async () => {
    const ctx = await withCandidate();
    ctx.rows[ctx.sketchId].status = 'superseded';
    const slot = await ctx.service.apply(ctx.sketchId, 'u1');
    expect(slot).toMatchObject({ variant: 'sketch', sketchId: ctx.sketchId });
  });

  it('второй параллельный apply получает 409 с причиной', async () => {
    const ctx = await withCandidate();
    ctx.rows[ctx.sketchId].status = 'applied';
    ctx.prisma.imageSketch.updateMany.mockResolvedValueOnce({ count: 0 });
    const err = await ctx.service
      .apply(ctx.sketchId, 'u1')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      reason: SKETCH_CONFLICT.alreadyApplied,
    });
    expect(ctx.targets.writeActive).not.toHaveBeenCalled();
  });

  it('оригинал сменился после генерации — 409 по sourceHash', async () => {
    const ctx = await withCandidate();
    // Кандидат «по описанию» хеша не имеет — подставим его вручную и
    // сделаем так, чтобы текущий файл отличался.
    ctx.rows[ctx.sketchId].sourceHash = 'deadbeef';
    const err = await ctx.service
      .apply(ctx.sketchId, 'u1')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      reason: SKETCH_CONFLICT.stale,
    });
  });

  it('удалённый оригинал не сверяется по хешу — применение проходит (A-13)', async () => {
    const ctx = await withCandidate({
      slot: { originalDeleted: true },
    });
    ctx.rows[ctx.sketchId].sourceHash = 'deadbeef';
    const slot = await ctx.service.apply(ctx.sketchId, 'u1');
    expect(slot.variant).toBe('sketch');
  });

  it('сбой записи слота возвращает записи прежний статус', async () => {
    const ctx = await withCandidate();
    ctx.targets.writeActive.mockRejectedValueOnce(new Error('db down'));
    await expect(ctx.service.apply(ctx.sketchId, 'u1')).rejects.toThrow(
      'db down',
    );
    const rollback = ctx.prisma.imageSketch.updateMany.mock.calls.find(
      (c: any) => c[0].data.status === 'candidate',
    );
    expect(rollback).toBeDefined();
  });

  it('откат возвращает оригинал, удалённый оригинал вернуть нельзя', async () => {
    const ctx = build({ slot: { sketch: { sketchId: 'sk-old' } as never } });
    const slot = await ctx.service.revert(TARGET, 'u1');
    expect(ctx.targets.writeActive).toHaveBeenCalledWith(
      expect.anything(),
      null,
    );
    expect(slot.variant).toBe('original');

    const deleted = build({
      slot: { sketch: { sketchId: 'sk-old' } as never, originalDeleted: true },
    });
    await expect(deleted.service.revert(TARGET, 'u1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('удаление оригинала: сначала ссылки, потом файл', async () => {
    const ctx = build({
      slot: {
        sketch: {
          sketchId: 'sk-old',
          url: 'u',
          pathname: 'sketches/u1/sk-old.png',
          mimeType: 'image/png',
          style: 'pencil',
          sketchRendering: 'realistic',
          appliedAt: '',
        } as never,
      },
    });
    const r = await ctx.service.deleteOriginal(TARGET, 'u1');
    expect(ctx.targets.propagateSketch).toHaveBeenCalled();
    // Пропагация обязана нести признак удалённого оригинала (A-12),
    // иначе в дочерних сессиях остаётся «Вернуть оригинал» в никуда.
    expect(ctx.targets.propagateSketch.mock.calls[0][2]).toMatchObject({
      originalDeleted: true,
    });
    expect(ctx.targets.deleteOriginalBlob).toHaveBeenCalled();
    const order = [
      ctx.targets.propagateSketch.mock.invocationCallOrder[0],
      ctx.targets.deleteOriginalBlob.mock.invocationCallOrder[0],
    ];
    expect(order[0]).toBeLessThan(order[1]);
    expect(r.updatedRefs).toBe(3);
    expect(r.fileDeleted).toBe(true);
    expect(r.slot.originalDeleted).toBe(true);
  });

  it('общий файл: ссылка снята, файл не удалён (A-4)', async () => {
    const ctx = build({
      slot: {
        sketch: { sketchId: 'sk-old' } as never,
      },
    });
    ctx.targets.deleteOriginalBlob.mockResolvedValue(false);
    const r = await ctx.service.deleteOriginal(TARGET, 'u1');
    expect(r.fileDeleted).toBe(false);
    expect(r.slot.originalDeleted).toBe(true);
  });

  it('без применённого скетча удалять оригинал нельзя', async () => {
    const ctx = build();
    await expect(
      ctx.service.deleteOriginal(TARGET, 'u1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(ctx.targets.deleteOriginalBlob).not.toHaveBeenCalled();
  });

  it('применение НЕ снимает одобрение промпта (A-7)', async () => {
    // Кнопки скетча стоят на шаге ПОСЛЕ одобрения; снятое одобрение
    // превращало «Сгенерировать» в вечный 400.
    const ctx = await withCandidate();
    ctx.sessions.getSession.mockResolvedValue({
      generationPrompt: { finalText: 'x', approvedAt: '2026-09-17T09:00:00Z' },
    });
    await ctx.service.apply(ctx.sketchId, 'u1');
    const touchedPrompt = ctx.sessions.updateSession.mock.calls.some(
      (c: any) => c[1] && 'generationPrompt' in c[1],
    );
    expect(touchedPrompt).toBe(false);
  });
});

describe('ImageSketchService.runCleanupTick', () => {
  it('файл, на который ещё ссылается сессия, не удаляется (A-5)', async () => {
    const ctx = build();
    const superseded = {
      id: 'old',
      pathname: 'sketches/u1/old.png',
    };
    ctx.prisma.imageSketch.findMany.mockImplementation(
      async ({ where }: any) =>
        where?.status === 'superseded' ? [superseded] : [],
    );
    ctx.prisma.$queryRaw.mockResolvedValue([{ one: 1 }]); // ссылка есть
    const r = await ctx.service.runCleanupTick();
    expect(r.purged).toBe(0);
    expect(ctx.blob.deleteBlob).not.toHaveBeenCalled();
  });

  it('ничьи файлы убираются', async () => {
    const ctx = build();
    ctx.prisma.imageSketch.findMany.mockImplementation(
      async ({ where }: any) =>
        where?.status === 'superseded'
          ? [{ id: 'old', pathname: 'sketches/u1/old.png' }]
          : [],
    );
    const r = await ctx.service.runCleanupTick();
    expect(r.purged).toBe(1);
    expect(ctx.blob.deleteBlob).toHaveBeenCalledWith('sketches/u1/old.png');
  });

  it('кандидат помечается expired только пока он ещё кандидат (A-5)', async () => {
    const ctx = build();
    ctx.prisma.imageSketch.findMany.mockImplementation(
      async ({ where }: any) =>
        where?.status === 'candidate'
          ? [{ id: 'cand', pathname: 'sketches/u1/cand.png' }]
          : [],
    );
    await ctx.service.runCleanupTick();
    const expiring = ctx.prisma.imageSketch.updateMany.mock.calls.find(
      (c: any) => c[0].data.status === 'expired',
    );
    expect(expiring[0].where).toMatchObject({ status: 'candidate' });
  });
});
