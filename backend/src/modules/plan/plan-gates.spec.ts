jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('@prisma/client', () => ({
  Prisma: { DbNull: Symbol.for('Prisma.DbNull') },
}));
jest.mock('@vercel/blob', () => ({
  head: jest.fn(),
  del: jest.fn(),
  list: jest.fn(),
}));
// Veo подменён, чтобы «вызова не было» можно было ДОКАЗАТЬ, а не вывести
// из отсутствия побочных эффектов.
const generateVideos = jest.fn().mockResolvedValue({ name: 'operations/1' });
jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    models: { generateVideos },
    operations: { getVideosOperation: jest.fn() },
  })),
  VideoGenerationReferenceType: { ASSET: 'ASSET' },
}));
// GenerationService отказывается собираться без ключа — а тесты про
// режимы к самому ключу отношения не имеют. Убираем за собой:
// process.env общий на весь воркер jest.
const keyBefore = process.env.GOOGLE_GEMINI_API_KEY;
beforeAll(() => {
  process.env.GOOGLE_GEMINI_API_KEY = 'test-key';
});
afterAll(() => {
  if (keyBefore === undefined) delete process.env.GOOGLE_GEMINI_API_KEY;
  else process.env.GOOGLE_GEMINI_API_KEY = keyBefore;
});

import { ForbiddenException } from '@nestjs/common';
import { LibraryService } from '../library/library.service';
import { RelevanceService } from '../relevance/relevance.service';
import { VideoAuditService } from '../video-audit/video-audit.service';
import { ReferenceAssetsService } from '../reference-assets/reference-assets.service';
import { PublicationService } from '../publication/publication.service';
import { BrandManifestService } from '../brand-manifest/brand-manifest.service';
import { CastingService } from '../casting/casting.service';
import { GenerationService } from '../generation/generation.service';
import { AnalysisStatus } from '../../common/types/analysis.types';
import { GenerationStatus } from '../../common/types/generation.types';

/** Учёт расходов (ТЗ §26) — в тестах он ничего не должен делать. */
const usageMock = () => ({
  record: jest.fn(),
  recordGemini: jest.fn(),
  recordOpenAi: jest.fn(),
});

/**
 * Проверяем не матрицу (она в common/plans.spec.ts), а то, что модули
 * действительно СПРАШИВАЮТ разрешение — самая вероятная ошибка при
 * добавлении пакета: возможность закрыта в таблице, но нигде не проверена.
 */
const denying = () => ({
  // §26.4: дневной лимит по умолчанию не выбран.
  assertCanSpendUser: jest.fn(),
  assertCanSpendSession: jest.fn(),
  assertUser: jest
    .fn()
    .mockRejectedValue(new ForbiddenException('нет доступа')),
  planOfUser: jest.fn().mockResolvedValue('LITE'),
  planOfSession: jest.fn().mockResolvedValue('LITE'),
  // Блокировка (§25.3) — отдельная ось: здесь пользователь НЕ заблокирован,
  // иначе тест доказывал бы не то, что проверяет.
  assertUserNotBlocked: jest.fn(),
  assertSessionNotBlocked: jest.fn(),
  assertNotBlocked: jest.fn(),
  accessOf: jest.fn().mockResolvedValue({
    plan: 'LITE',
    isBlocked: false,
    blockedReason: null,
  }),
});

describe('модули спрашивают разрешение режима (§23)', () => {
  it('библиотека: рекомендации и «взять разбор» — под замком в Lite', async () => {
    const plans = denying();
    const prisma = {
      analysisLibraryEntry: { findMany: jest.fn(), findUnique: jest.fn() },
    };
    const sessions = {
      getSession: jest
        .fn()
        .mockResolvedValue({ sessionId: 's1', userId: 'u1' }),
      updateSession: jest.fn(),
      claimWork: jest.fn().mockResolvedValue(true),
      releaseWork: jest.fn().mockResolvedValue(undefined),
    };
    const svc = new LibraryService(
      prisma as never,
      sessions as never,
      {} as never,
      plans as never,
    );
    await expect(svc.recommend('s1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(svc.applyToSession('s1', 'l1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(plans.assertUser).toHaveBeenCalledWith('u1', 'library');
    // до базы дело не дошло — отказ раньше любой работы
    expect(prisma.analysisLibraryEntry.findMany).not.toHaveBeenCalled();
  });

  it('релевантность: проверка не запускается и вызов Gemini не делается', async () => {
    const plans = denying();
    const sessions = {
      getSession: jest.fn().mockResolvedValue({
        sessionId: 's1',
        userId: 'u1',
        videoAnalysis: { status: AnalysisStatus.COMPLETE, sceneBreakdown: 'x' },
        productInformation: { productName: 'x', productDescription: 'y' },
      }),
      updateSession: jest.fn(),
      claimWork: jest.fn().mockResolvedValue(true),
      releaseWork: jest.fn().mockResolvedValue(undefined),
    };
    const svc = new RelevanceService(
      sessions as never,
      plans as never,
      usageMock() as never,
    );
    await expect(svc.run('s1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(plans.assertUser).toHaveBeenCalledWith('u1', 'relevance');
    expect(sessions.updateSession).not.toHaveBeenCalled();
  });

  it('аудит: платный вызов Gemini не делается и отчёт не появляется', async () => {
    const plans = denying();
    const sessions = {
      getSession: jest.fn().mockResolvedValue({
        sessionId: 's1',
        userId: 'u1',
        generationPrompt: { finalText: 'p', approvedAt: new Date() },
        generatedVideo: {
          generatedVideoId: 'v1',
          pathname: 'sessions/s1/generated.mp4',
          status: GenerationStatus.COMPLETE,
        },
      }),
      updateSession: jest.fn(),
      claimWork: jest.fn().mockResolvedValue(true),
      releaseWork: jest.fn().mockResolvedValue(undefined),
    };
    const geminiFiles = { uploadAndWait: jest.fn() };
    const svc = new VideoAuditService(
      plans as never,
      sessions as never,
      {} as never,
      geminiFiles as never,
      usageMock() as never,
    );
    await expect(svc.run('s1', {} as never)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(plans.assertUser).toHaveBeenCalledWith('u1', 'audit');
    // Ролик не заливался в Gemini, отчёт в сессию не записан: отказ по
    // режиму обязан случиться ДО траты, иначе пакет ничего не ограничивает.
    expect(geminiFiles.uploadAndWait).not.toHaveBeenCalled();
    expect(sessions.updateSession).not.toHaveBeenCalled();
  });

  it('свои сцены и слоты референс-изображений: ссылка на загрузку не выдаётся', async () => {
    const plans = denying();
    const sessions = {
      getSession: jest
        .fn()
        .mockResolvedValue({ sessionId: 's1', userId: 'u1', scenes: [] }),
      updateSession: jest.fn(),
      claimWork: jest.fn().mockResolvedValue(true),
      releaseWork: jest.fn().mockResolvedValue(undefined),
    };
    const blob = { createUploadUrl: jest.fn() };
    const svc = new ReferenceAssetsService(
      plans as never,
      sessions as never,
      blob as never,
    );
    await expect(
      svc.createUploadUrl('s1', { mimeType: 'image/jpeg' } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // Presigned PUT — это уже право писать в хранилище: выдав его и
    // отказав потом, мы бы пустили чужой файл в свой Blob.
    expect(blob.createUploadUrl).not.toHaveBeenCalled();

    await expect(
      svc.putSlots('s1', { slots: [] } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(sessions.updateSession).not.toHaveBeenCalled();
    expect(plans.assertUser).toHaveBeenCalledWith('u1', 'referenceAssets');
  });

  it('публикация: заявка в очередь оператора не заводится', async () => {
    const plans = denying();
    const prisma = {
      publicationRequest: { create: jest.fn(), findFirst: jest.fn() },
      session: { findUnique: jest.fn() },
      $transaction: jest.fn(),
    };
    const sessions = { getSession: jest.fn(), updateSession: jest.fn() };
    const svc = new PublicationService(
      prisma as never,
      sessions as never,
      plans as never,
      {} as never,
    );
    await expect(
      svc.create('u1', 's1', { platform: 'YOUTUBE' } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(plans.assertUser).toHaveBeenCalledWith('u1', 'publication');
    // Проверка идёт первой строкой, до чтения сессии: отказ по режиму не
    // должен зависеть от того, нашлась сессия или нет.
    expect(sessions.getSession).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('манифест бренда: новый манифест не создаётся', async () => {
    const plans = denying();
    const prisma = { brandManifest: { create: jest.fn() } };
    const svc = new BrandManifestService(
      prisma as never,
      {} as never,
      plans as never,
      {} as never,
    );
    await expect(
      svc.create('u1', { title: 'Мой бренд' } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(plans.assertUser).toHaveBeenCalledWith('u1', 'brandManifest');
    expect(prisma.brandManifest.create).not.toHaveBeenCalled();
  });

  it('замена персонажа своим фото: ссылка на загрузку скина не выдаётся', async () => {
    const plans = denying();
    const sessions = {
      getSession: jest.fn().mockResolvedValue({
        sessionId: 's1',
        userId: 'u1',
        videoAnalysis: { characters: [{ id: 'c1', label: 'Ведущая' }] },
      }),
      updateSession: jest.fn(),
      claimWork: jest.fn().mockResolvedValue(true),
      releaseWork: jest.fn().mockResolvedValue(undefined),
    };
    const blob = { createUploadUrl: jest.fn() };
    const svc = new CastingService(
      sessions as never,
      blob as never,
      plans as never,
    );
    await expect(
      svc.createPhotoUploadUrl('s1', 'c1', { mimeType: 'image/jpeg' } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(plans.assertUser).toHaveBeenCalledWith('u1', 'characterReplacement');
    expect(blob.createUploadUrl).not.toHaveBeenCalled();
  });

  it('формат кадра сверх родного для Veo: генерация не запускается', async () => {
    // Проверка `customAspectRatio` стоит ровно перед самым дорогим
    // вызовом сервиса — и живёт не в `assertUser`, а в паре `accessOf`
    // + `resolveTargetAspectRatio` (вторая такая же — в `modules/export`
    // для автоэкспорта под площадки). Если она
    // перестанет срабатывать, Lite получит платный рендер в формате,
    // которого его пакет не даёт, и узнаем мы об этом по счёту.
    const plans = denying();
    const sessions = {
      getSession: jest.fn().mockResolvedValue({
        sessionId: 's1',
        userId: 'u1',
        generationPrompt: { finalText: 'p', approvedAt: new Date() },
        productInformation: {
          productImagePathname: 'sessions/s1/product-image.jpg',
        },
      }),
      updateSession: jest.fn(),
      claimWork: jest.fn().mockResolvedValue(true),
      releaseWork: jest.fn().mockResolvedValue(undefined),
    };
    const blob = { downloadBuffer: jest.fn() };
    const notify = { alert: jest.fn(), stat: jest.fn(), report: jest.fn() };
    const creditLedger = {
      reserveForGeneration: jest.fn().mockResolvedValue(false),
      refundIfReserved: jest.fn().mockResolvedValue(undefined),
    };
    const svc = new GenerationService(
      sessions as never,
      blob as never,
      plans as never,
      usageMock() as never,
      {} as never,
      notify as never,
      {} as never,
      creditLedger as never,
      {} as never,
      {} as never,
      {} as never,
      { get: jest.fn().mockResolvedValue(null) } as never,
    );
    await expect(svc.generateVideo('s1', 'fast', '1:1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(generateVideos).not.toHaveBeenCalled();
    // Ни файла в Veo, ни записи расхода, ни отметки «идёт генерация».
    expect(blob.downloadBuffer).not.toHaveBeenCalled();
    expect(sessions.updateSession).not.toHaveBeenCalled();
  });

  it('родные для Veo форматы Lite не запрещены', async () => {
    // Обратная половина того же правила: Lite — это «минимальная
    // генерация», а не «генерации нет». Тест без неё разрешал бы закрыть
    // 16:9 и 9:16 совсем, оставшись зелёным.
    for (const ratio of ['16:9', '9:16']) {
      const plans = denying();
      const sessions = {
        getSession: jest.fn().mockResolvedValue({
          sessionId: 's1',
          userId: 'u1',
          generationPrompt: { finalText: 'p', approvedAt: new Date() },
          productInformation: {
            productImagePathname: 'sessions/s1/product-image.jpg',
          },
        }),
        updateSession: jest.fn(),
        claimWork: jest.fn().mockResolvedValue(true),
        releaseWork: jest.fn().mockResolvedValue(undefined),
      };
      const blob = {
        downloadBuffer: jest.fn().mockResolvedValue(Buffer.from('img')),
      };
      const notify = { alert: jest.fn(), stat: jest.fn(), report: jest.fn() };
      const creditLedger = {
        reserveForGeneration: jest.fn().mockResolvedValue(false),
        refundIfReserved: jest.fn().mockResolvedValue(undefined),
      };
      const svc = new GenerationService(
        sessions as never,
        blob as never,
        plans as never,
        usageMock() as never,
        {} as never,
        notify as never,
        {} as never,
        creditLedger as never,
        {} as never,
        {} as never,
        {} as never,
        { get: jest.fn().mockResolvedValue(null) } as never,
      );
      await expect(svc.generateVideo('s1', 'fast', ratio)).resolves.toEqual(
        expect.objectContaining({ aspectRatio: ratio }),
      );
    }
  });

  it('формат референса, закрытый режимом, приводится к нативному, а не рендерится как есть (Б-2.4)', async () => {
    // Дыра, ради которой этот тест написан: проверка смотрела на
    // ПРИСЛАННЫЙ параметр, а рендерился `выбор ?? формат референса ??
    // 9:16`. Пустое тело запроса («сгенерируй») проверку минувало
    // целиком: Lite с референсом 1080×1350 получал ролик 4:5 — формат,
    // закрытый для его режима, — и оплаченный проход ffmpeg на обрезку.
    //
    // Отказывать тут не за что (человек ничего не выбирал, он просто
    // загрузил своё видео), поэтому не 403, а приведение к ближайшему
    // нативному формату, доступному в любом режиме.
    generateVideos.mockClear();
    const plans = denying();
    const sessions = {
      getSession: jest.fn().mockResolvedValue({
        sessionId: 's1',
        userId: 'u1',
        generationPrompt: { finalText: 'p', approvedAt: new Date() },
        productInformation: {
          productImagePathname: 'sessions/s1/product-image.jpg',
        },
        originalVideo: { frame: { aspectRatio: '4:5' } },
      }),
      updateSession: jest.fn(),
      claimWork: jest.fn().mockResolvedValue(true),
      releaseWork: jest.fn().mockResolvedValue(undefined),
    };
    const blob = {
      downloadBuffer: jest.fn().mockResolvedValue(Buffer.from('img')),
    };
    const notify = { alert: jest.fn(), stat: jest.fn(), report: jest.fn() };
    const creditLedger = {
      reserveForGeneration: jest.fn().mockResolvedValue(false),
      refundIfReserved: jest.fn().mockResolvedValue(undefined),
    };
    const svc = new GenerationService(
      sessions as never,
      blob as never,
      plans as never,
      usageMock() as never,
      {} as never,
      notify as never,
      {} as never,
      creditLedger as never,
      {} as never,
      {} as never,
      {} as never,
      { get: jest.fn().mockResolvedValue(null) } as never,
    );

    const video = await svc.generateVideo('s1', 'fast');

    // Целевой формат ролика — родной, а не 4:5 из референса.
    expect(video.aspectRatio).toBe('9:16');
    // И обрезка больше не полагается: платить за неё было не за что.
    expect(video.renderedAspectRatio ?? video.aspectRatio).toBe('9:16');
    expect(generateVideos).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ aspectRatio: '9:16' }),
      }),
    );
  });
});
