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
  const youtubeSearch = {
    searchTrending: jest.fn().mockResolvedValue([]),
    // Без ключа `searchTrending` молча отдаёт пустой список, поэтому
    // генератор спрашивает о ключе ЯВНО (см. `notConfigured`).
    configured: jest.fn().mockReturnValue(true),
  };
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

describe('BlogGenerationService.runDailyGeneration — почему ничего не сделал', () => {
  // Найдено живым прогоном на проде: экран крона показывал
  // `categoriesTried=0, candidatesConsidered=0, draftsCreated=0`, и это
  // читалось как «поискали и ничего не нашли». На деле `BLOG_CATEGORIES`
  // не был задан вовсе, а строка об этом ушла в лог бессерверной
  // функции, куда оператор не смотрит.
  const withEnv = async (
    patch: Record<string, string | undefined>,
    fn: () => Promise<void>,
  ) => {
    const before: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(patch)) {
      before[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      await fn();
    } finally {
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  it('без категорий называет переменную и не ходит в YouTube', async () => {
    await withEnv({ BLOG_CATEGORIES: '' }, async () => {
      const { service, youtubeSearch } = build();
      const summary = await service.runDailyGeneration();
      expect(summary.notConfigured).toBe('BLOG_CATEGORIES');
      expect(youtubeSearch.searchTrending).not.toHaveBeenCalled();
    });
  });

  it('без ключа YouTube — тоже причина, а не пустой поиск', async () => {
    const { service, youtubeSearch, budget } = build();
    youtubeSearch.configured.mockReturnValue(false);
    const summary = await service.runDailyGeneration();
    expect(summary.notConfigured).toBe('YOUTUBE_API_KEY');
    // Не просто «сказали причину», но и не потратили ничего: без ключа
    // поиск заведомо пуст, а резерв суточного бюджета поисков сгорел бы
    // ни за что.
    expect(youtubeSearch.searchTrending).not.toHaveBeenCalled();
    expect(budget.reserve).not.toHaveBeenCalled();
  });

  it('называет ВСЁ недостающее сразу, а не по одному за прогон', async () => {
    // Иначе оператор, задав категории, получил бы те же нули и пошёл на
    // второй круг гадания.
    await withEnv(
      { BLOG_CATEGORIES: '', GEMINI_API_KEY: '', GOOGLE_GEMINI_API_KEY: '' },
      async () => {
        const { service, youtubeSearch } = build();
        youtubeSearch.configured.mockReturnValue(false);
        const summary = await service.runDailyGeneration();
        expect(summary.notConfigured).toBe(
          'BLOG_CATEGORIES, YOUTUBE_API_KEY, GEMINI_API_KEY',
        );
      },
    );
  });

  it('всё настроено — причины нет, и это не пустая строка', async () => {
    // `notConfigured: ''` сводка приняла бы за «настроено», но читалось
    // бы оно как «не задано: ничего». Только `null`.
    const { service } = build();
    const summary = await service.runDailyGeneration();
    expect(summary.notConfigured).toBeNull();
    expect(summary.categoriesTried).toBe(1);
  });
});
