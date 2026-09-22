/* eslint-disable @typescript-eslint/no-explicit-any -- тестовые дублёры */
// `SessionService` тянет за собой сгенерированный клиент Prisma,
// которого в песочнице/CI нет, — тот же приём, что в
// `client-site-tutorial.service.spec.ts` по соседству.
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('@prisma/client', () => ({
  Prisma: { DbNull: Symbol.for('Prisma.DbNull') },
}));

import { BadRequestException } from '@nestjs/common';
import { GreetingReferenceService } from './greeting-reference.service';
import type { SessionService } from '../../common/session.service';
import type { BlobService } from '../storage/blob.service';
import type { SketchGeneratorService } from '../image-sketch/sketch-generator.service';
import type { AiUsageService } from '../ai-usage/ai-usage.service';

/**
 * `generateFrame` (фича №6) — проверяется не «картинка нарисовалась», а
 * ПОРЯДОК: что именно происходит до платного вызова модели и чего не
 * происходит после отказа. Ровно здесь живут ошибки, которые стоят
 * денег и которые не видит ни один тип.
 */
function setup(
  opts: {
    brief?: unknown;
    images?: unknown[];
    outcome?: unknown;
  } = {},
) {
  const session = {
    sessionId: 's1',
    greetingBriefSnapshot:
      opts.brief === undefined
        ? {
            occasion: 'BIRTHDAY',
            customOccasionText: null,
            tone: 'WARM',
            resolvedPresenterProvider: 'grok',
          }
        : opts.brief,
    greetingReferenceImages: opts.images ?? [],
  };
  const sessions = {
    getSession: jest.fn().mockResolvedValue(session),
    updateSession: jest.fn().mockResolvedValue(undefined),
  } as unknown as SessionService;
  const blob = {
    uploadBuffer: jest
      .fn()
      .mockResolvedValue({ url: 'https://blob.example/frame.png' }),
  } as unknown as BlobService;
  const frames = {
    generate: jest.fn().mockResolvedValue(
      opts.outcome ?? {
        status: 'ok',
        bytes: Buffer.from('png'),
        mimeType: 'image/png',
        model: 'gemini-test',
        raw: {},
      },
    ),
  } as unknown as SketchGeneratorService;
  const aiUsage = {
    recordGemini: jest.fn().mockResolvedValue(undefined),
  } as unknown as AiUsageService;

  const service = new GreetingReferenceService(
    sessions,
    blob,
    frames,
    aiUsage,
  );
  return { service, sessions, blob, frames, aiUsage };
}

describe('generateFrame (№6)', () => {
  it('рисует кадр и кладёт его в тот же список, что и загруженные', async () => {
    const { service, sessions, blob } = setup({
      images: [{ id: 'gr_old', photoUrl: 'https://blob/old.jpg' }],
    });

    const list = await service.generateFrame('s1', 'u1');

    expect(blob.uploadBuffer).toHaveBeenCalled();
    expect(list).toHaveLength(2);
    expect((sessions.updateSession as jest.Mock).mock.calls[0][1]).toHaveProperty(
      'greetingReferenceImages',
    );
  });

  it('просьба про образ знаменитости отклоняется ДО платного вызова (№35)', async () => {
    // Главная проверка файла: отказ обязан случиться раньше денег.
    const { service, frames } = setup({
      brief: {
        occasion: 'OTHER',
        customOccasionText: 'юбилей в образе Пугачёвой',
        tone: 'WARM',
        resolvedPresenterProvider: 'grok',
      },
    });

    await expect(service.generateFrame('s1', 'u1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(frames.generate).not.toHaveBeenCalled();
  });

  it('сессия без брифа — понятный отказ, а не падение ниже', async () => {
    const { service, frames } = setup({ brief: null });
    await expect(service.generateFrame('s1', null)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(frames.generate).not.toHaveBeenCalled();
  });

  it('семь кадров — потолок Grok: восьмой не рисуется, а не «рисуется и теряется»', async () => {
    const { service, frames } = setup({
      images: Array.from({ length: 7 }, (_, i) => ({ id: `gr_${i}` })),
    });
    await expect(service.generateFrame('s1', 'u1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(frames.generate).not.toHaveBeenCalled();
  });

  it('модель не ответила — расход НЕ пишется: вызов не оплачен', async () => {
    const { service, aiUsage, sessions } = setup({
      outcome: { status: 'failed', reason: 'timeout', model: 'gemini-test' },
    });
    await expect(service.generateFrame('s1', 'u1')).rejects.toThrow();
    expect(aiUsage.recordGemini).not.toHaveBeenCalled();
    expect(sessions.updateSession).not.toHaveBeenCalled();
  });

  it('модель отказалась рисовать — расход ПИШЕТСЯ: вызов оплачен', async () => {
    // Разница с предыдущим тестом — это и есть причина, по которой
    // `SketchGeneratorService` различает три исхода, а не два.
    const { service, aiUsage, sessions } = setup({
      outcome: {
        status: 'refused',
        reason: 'safety',
        model: 'gemini-test',
        raw: {},
      },
    });
    await expect(service.generateFrame('s1', 'u1')).rejects.toThrow();
    expect(aiUsage.recordGemini).toHaveBeenCalled();
    expect(sessions.updateSession).not.toHaveBeenCalled();
  });

  it('анонимная сессия рисует кадр — тариф тут ни при чём', async () => {
    // GREETING_VIDEO доступен на каждом тарифе, и у этого контроллера
    // предъявитель — сам UUID сессии. `userId` нужен только для отчёта.
    const { service, aiUsage } = setup();
    await service.generateFrame('s1', null);
    expect(
      (aiUsage.recordGemini as jest.Mock).mock.calls[0][1],
    ).not.toHaveProperty('userId');
  });
});
