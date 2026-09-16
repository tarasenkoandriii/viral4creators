/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
// PrismaService/@prisma/client тянут сгенерированный клиент, которого в
// песочнице нет (doc/CI.md) — тот же приём, что в session.service.spec.ts:
// `BlogPostStatus.DRAFT` здесь используется как значение, не только тип.
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('@prisma/client', () => ({
  BlogPostStatus: { DRAFT: 'DRAFT', PUBLISHED: 'PUBLISHED' },
}));
// Тот же приём защиты, что в tutorial-scenario-generator.service.spec.ts:
// `AiUsageService` тянет `SessionService`, рантайм-импортирующий
// `WorkflowKind` из `@prisma/client` — мокаются напрямую все конструкторные
// зависимости, чтобы не тянуть их реальные цепочки импортов вовсе (этот
// файл их сам не тестирует).
jest.mock('../ai-usage/ai-usage.service', () => ({ AiUsageService: class {} }));
jest.mock('../youtube-search/youtube-search.service', () => ({
  YoutubeSearchService: class {},
}));
jest.mock('./blog-youtube-budget.service', () => ({
  BlogYoutubeBudgetService: class {},
}));
jest.mock('../storage/blob.service', () => ({ BlobService: class {} }));

const generateContent = jest.fn();
jest.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent };
  },
}));

// Этап 95: `downloadAndUploadBlogCoverImage`/`fetchOgImage` уже
// протестированы отдельно (blog-cover-image.spec.ts,
// og-image-fetcher.spec.ts) — здесь мокаются целиком, тестируется только
// то, КАК BlogGenerationService их вызывает (какой URL передаёт при
// наличии/отсутствии thumbnailUrl).
const downloadAndUploadBlogCoverImage = jest.fn();
jest.mock('./blog-cover-image', () => ({
  downloadAndUploadBlogCoverImage: (...args: unknown[]) =>
    downloadAndUploadBlogCoverImage(...args),
}));
const fetchOgImage = jest.fn();
jest.mock('../../common/og-image-fetcher', () => ({
  fetchOgImage: (...args: unknown[]) => fetchOgImage(...args),
}));

const keyBefore = process.env.GEMINI_API_KEY;
const categoriesBefore = process.env.BLOG_CATEGORIES;
beforeAll(() => {
  process.env.GEMINI_API_KEY = 'test-key';
  process.env.BLOG_CATEGORIES = 'обзоры';
});
afterAll(() => {
  if (keyBefore === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = keyBefore;
  if (categoriesBefore === undefined) delete process.env.BLOG_CATEGORIES;
  else process.env.BLOG_CATEGORIES = categoriesBefore;
});

import {
  BlogGenerationService,
  COVER_BACKFILL_LIMIT,
} from './blog-generation.service';

function build() {
  const prisma = {
    blogPost: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'post-1' }),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const youtubeSearch = { searchTrending: jest.fn().mockResolvedValue([]) };
  const budget = { reserve: jest.fn().mockResolvedValue(true) };
  const aiUsage = { record: jest.fn().mockResolvedValue(undefined) };
  const blob = {};
  const service = new BlogGenerationService(
    prisma as any,
    youtubeSearch as any,
    budget as any,
    aiUsage as any,
    blob as any,
  );
  return { service, prisma, youtubeSearch, budget, aiUsage, blob };
}

const CANDIDATE_WITH_THUMB = {
  videoId: 'vid-1',
  url: 'https://www.youtube.com/watch?v=vid-1',
  title: 'Как снять крутой UGC-ролик',
  channelTitle: 'Channel A',
  channelId: 'c1',
  publishedAt: new Date().toISOString(),
  thumbnailUrl: 'https://i.ytimg.com/vi/vid-1/hqdefault.jpg',
  durationSeconds: 60,
  durationLabel: '1:00',
  viewCount: 100000,
};

const CANDIDATE_WITHOUT_THUMB = {
  ...CANDIDATE_WITH_THUMB,
  videoId: 'vid-2',
  thumbnailUrl: null,
};

const ANALYSIS_RESPONSE = JSON.stringify({
  score: 80,
  scoreReasoning: 'хороший крючок',
  title: 'Разбор ролика',
  bodyHtml: '<p>Текст</p>',
});

beforeEach(() => {
  jest.clearAllMocks();
  generateContent.mockResolvedValue({
    text: ANALYSIS_RESPONSE,
    usageMetadata: {},
  });
  downloadAndUploadBlogCoverImage.mockResolvedValue({
    thumbnailUrl: 'https://blob.vercel-storage.com/blog/some-post.jpg',
    sourceImageUrl: 'https://i.ytimg.com/vi/vid-1/hqdefault.jpg',
  });
});

describe('BlogGenerationService.runDailyGeneration — обложка (этап 95)', () => {
  it('candidate.thumbnailUrl есть — перезаливает именно его, og:image не трогается', async () => {
    const { service, youtubeSearch, prisma } = build();
    youtubeSearch.searchTrending.mockResolvedValue([CANDIDATE_WITH_THUMB]);

    const summary = await service.runDailyGeneration();

    expect(summary.draftsCreated).toBe(1);
    expect(fetchOgImage).not.toHaveBeenCalled();
    expect(downloadAndUploadBlogCoverImage).toHaveBeenCalledWith(
      'https://i.ytimg.com/vi/vid-1/hqdefault.jpg',
      expect.any(String),
      {},
    );
    expect(prisma.blogPost.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          thumbnailUrl: 'https://blob.vercel-storage.com/blog/some-post.jpg',
          sourceImageUrl: 'https://i.ytimg.com/vi/vid-1/hqdefault.jpg',
        }),
      }),
    );
  });

  it('candidate.thumbnailUrl отсутствует, og:image нашёлся — перезаливает найденную og-картинку', async () => {
    const { service, youtubeSearch, prisma } = build();
    youtubeSearch.searchTrending.mockResolvedValue([CANDIDATE_WITHOUT_THUMB]);
    fetchOgImage.mockResolvedValue({
      imageUrl: 'https://www.youtube.com/og-cover.jpg',
      diagnostic: 'OK',
    });
    downloadAndUploadBlogCoverImage.mockResolvedValue({
      thumbnailUrl: 'https://blob.vercel-storage.com/blog/vid-2.jpg',
      sourceImageUrl: 'https://www.youtube.com/og-cover.jpg',
    });

    const summary = await service.runDailyGeneration();

    expect(summary.draftsCreated).toBe(1);
    expect(fetchOgImage).toHaveBeenCalledWith(
      'https://www.youtube.com/watch?v=vid-2',
    );
    expect(downloadAndUploadBlogCoverImage).toHaveBeenCalledWith(
      'https://www.youtube.com/og-cover.jpg',
      expect.any(String),
      {},
    );
    expect(prisma.blogPost.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          thumbnailUrl: 'https://blob.vercel-storage.com/blog/vid-2.jpg',
        }),
      }),
    );
  });

  it('candidate.thumbnailUrl отсутствует, og:image тоже не дал картинки — черновик всё равно заводится, без обложки', async () => {
    const { service, youtubeSearch, prisma } = build();
    youtubeSearch.searchTrending.mockResolvedValue([CANDIDATE_WITHOUT_THUMB]);
    fetchOgImage.mockResolvedValue({
      imageUrl: null,
      diagnostic: 'ничего не найдено',
    });

    const summary = await service.runDailyGeneration();

    expect(summary.draftsCreated).toBe(1);
    expect(downloadAndUploadBlogCoverImage).not.toHaveBeenCalled();
    expect(prisma.blogPost.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          thumbnailUrl: null,
          sourceImageUrl: null,
        }),
      }),
    );
  });
});

describe('BlogGenerationService.runCoverImageBackfill', () => {
  it('нет строк с sourceImageUrl — ничего не делает', async () => {
    const { service, prisma } = build();
    prisma.blogPost.findMany.mockResolvedValue([]);

    const result = await service.runCoverImageBackfill();

    expect(result).toEqual({ candidates: 0, uploaded: 0, stillFallback: 0 });
    expect(downloadAndUploadBlogCoverImage).not.toHaveBeenCalled();
    expect(prisma.blogPost.update).not.toHaveBeenCalled();
  });

  it('строки, где thumbnailUrl уже отличается от sourceImageUrl (перезалито раньше), пропускаются', async () => {
    const { service, prisma } = build();
    prisma.blogPost.findMany.mockResolvedValue([
      {
        id: 'a',
        slug: 'a',
        thumbnailUrl: 'https://blob.vercel-storage.com/blog/a.jpg',
        sourceImageUrl: 'https://i.ytimg.com/a.jpg',
      },
    ]);

    const result = await service.runCoverImageBackfill();

    expect(result).toEqual({ candidates: 0, uploaded: 0, stillFallback: 0 });
    expect(downloadAndUploadBlogCoverImage).not.toHaveBeenCalled();
  });

  it('строка всё ещё на хотлинке — пробует перезалить; успех обновляет thumbnailUrl в БД', async () => {
    const { service, prisma } = build();
    prisma.blogPost.findMany.mockResolvedValue([
      {
        id: 'a',
        slug: 'a',
        thumbnailUrl: 'https://i.ytimg.com/a.jpg',
        sourceImageUrl: 'https://i.ytimg.com/a.jpg',
      },
    ]);
    downloadAndUploadBlogCoverImage.mockResolvedValue({
      thumbnailUrl: 'https://blob.vercel-storage.com/blog/a.jpg',
      sourceImageUrl: 'https://i.ytimg.com/a.jpg',
    });

    const result = await service.runCoverImageBackfill();

    expect(result).toEqual({ candidates: 1, uploaded: 1, stillFallback: 0 });
    expect(prisma.blogPost.update).toHaveBeenCalledWith({
      where: { id: 'a' },
      data: { thumbnailUrl: 'https://blob.vercel-storage.com/blog/a.jpg' },
    });
  });

  it('повторная попытка снова упала (откат) — не пишет в БД, считает как stillFallback', async () => {
    const { service, prisma } = build();
    prisma.blogPost.findMany.mockResolvedValue([
      {
        id: 'a',
        slug: 'a',
        thumbnailUrl: 'https://i.ytimg.com/a.jpg',
        sourceImageUrl: 'https://i.ytimg.com/a.jpg',
      },
    ]);
    downloadAndUploadBlogCoverImage.mockResolvedValue({
      thumbnailUrl: 'https://i.ytimg.com/a.jpg', // тот же URL — мягкий откат сработал опять
      sourceImageUrl: 'https://i.ytimg.com/a.jpg',
    });

    const result = await service.runCoverImageBackfill();

    expect(result).toEqual({ candidates: 1, uploaded: 0, stillFallback: 1 });
    expect(prisma.blogPost.update).not.toHaveBeenCalled();
  });

  it('запрашивает с запасом (limit × 4) и режет до лимита после фильтрации', async () => {
    const { service, prisma } = build();
    prisma.blogPost.findMany.mockResolvedValue([]);

    await service.runCoverImageBackfill(5);

    expect(prisma.blogPost.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 20 }),
    );
  });

  it('дефолтный лимит — COVER_BACKFILL_LIMIT', async () => {
    const { service, prisma } = build();
    prisma.blogPost.findMany.mockResolvedValue([]);

    await service.runCoverImageBackfill();

    expect(prisma.blogPost.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: COVER_BACKFILL_LIMIT * 4 }),
    );
  });
});
