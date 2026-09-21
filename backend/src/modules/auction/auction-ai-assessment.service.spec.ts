/**
 * AuctionAiAssessmentService — фоновая ИИ-оценка видео и брендбука
 * заявки на аукцион. Крон, один тик — одна заявка, платный вызов Gemini.
 *
 * Что здесь стоит проверки:
 *
 *  1. **Чей расход записывается.** Учёт идёт по `User.id`, а берётся он
 *     из `CreatorProfile.userId` — рядом лежит `CreatorProfile.id`, оба
 *     строки, оба выглядят как идентификатор. Перепутать их — значит
 *     писать платный вызов на несуществующего пользователя и считать
 *     чужую квоту. Автор кода поймал это при написании и оставил
 *     комментарий; тестом это до сих пор закреплено не было.
 *  2. **Потолок размера видео.** Ссылка на ролик — произвольная внешняя,
 *     исполнитель хостит сам. Без потолка заявка с гигабайтным файлом
 *     утянет его в память функции и загрузит в Gemini Files API.
 *     Проверяется и заявленный `content-length`, и фактический размер:
 *     заголовку верить нельзя.
 *  3. **Файл в Gemini удаляется всегда.** Загруженный ролик живёт в
 *     хранилище Gemini и тарифицируется; `finally` вокруг удаления —
 *     единственное, что мешает им копиться при каждой неудачной оценке.
 *  4. **Оценка никогда не роняет тик.** Любой сбой превращается в
 *     текст для оператора, а не в исключение: иначе один битый ролик
 *     останавливал бы разбор очереди заявок.
 */

const generateContent = jest.fn();

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../../common/gemini-client', () => ({
  createGeminiClient: () => ({ models: { generateContent } }),
}));

import { AuctionAiAssessmentService } from './auction-ai-assessment.service';

const listingRow = (over: Record<string, unknown> = {}) => ({
  id: 'l1',
  status: 'PENDING_MODERATION',
  includeBrandManifest: false,
  aiAssessment: null,
  portfolioItem: { videoUrl: 'https://cdn.test/clip.mp4' },
  // Две РАЗНЫЕ строки: расход должен записаться на userId, не на id профиля.
  creatorProfile: { id: 'профиль-cp1', userId: 'пользователь-u1' },
  brandManifest: null,
  ...over,
});

const manifest = (over: Record<string, unknown> = {}) => ({
  title: 'Кружка Steel',
  styleNotes: 'минимализм, холодные тона',
  voiceNotes: 'спокойный женский голос',
  characters: [{ label: 'Бариста', description: 'улыбчивая' }],
  scenes: [{ label: 'Кофейня', description: null }],
  ...over,
});

const videoResponse = (
  over: {
    ok?: boolean;
    status?: number;
    contentLength?: string;
    contentType?: string;
    bytes?: number;
  } = {},
) => ({
  ok: over.ok ?? true,
  status: over.status ?? 200,
  headers: {
    get: (name: string) =>
      name === 'content-length'
        ? (over.contentLength ?? '1024')
        : name === 'content-type'
          ? (over.contentType ?? 'video/mp4')
          : null,
  },
  arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(over.bytes ?? 1024)),
});

let fetchMock: jest.Mock;

function build(listing: ReturnType<typeof listingRow> | null = listingRow()) {
  const prisma = {
    auctionListing: {
      findFirst: jest.fn().mockResolvedValue(listing),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const geminiFiles = {
    uploadAndWaitActive: jest.fn().mockResolvedValue({
      uri: 'files/abc',
      mimeType: 'video/mp4',
      name: 'files/abc',
    }),
    deleteFile: jest.fn().mockResolvedValue(undefined),
  };
  const aiUsage = { recordGemini: jest.fn().mockResolvedValue(undefined) };
  const service = new AuctionAiAssessmentService(
    prisma as never,
    geminiFiles as never,
    aiUsage as never,
  );
  return { service, prisma, geminiFiles, aiUsage };
}

/** Отложенное удаление файла (void ...) — даём микрозадачам отработать. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  generateContent.mockReset();
  generateContent.mockResolvedValue({
    text: '  Ролик обычный, нарушений нет.  ',
  });
  fetchMock = jest.fn().mockResolvedValue(videoResponse());
  global.fetch = fetchMock as never;
});

describe('runTick — выбор заявки', () => {
  it('нет заявок на оценку — тик пустой, ничего не пишется', async () => {
    const { service, prisma } = build(null);

    expect(await service.runTick()).toEqual({ assessed: false });
    expect(prisma.auctionListing.update).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(generateContent).not.toHaveBeenCalled();
  });

  it('берётся самая старая неоценённая заявка на модерации', async () => {
    const { service, prisma } = build();
    await service.runTick();

    const [args] = prisma.auctionListing.findFirst.mock.calls[0] as [
      { where: Record<string, unknown>; orderBy: Record<string, unknown> },
    ];
    expect(args.where).toEqual({
      status: 'PENDING_MODERATION',
      aiAssessment: null,
    });
    expect(args.orderBy).toEqual({ createdAt: 'asc' });
  });

  it('обе оценки записываются одной правкой заявки', async () => {
    const { service, prisma } = build();
    expect(await service.runTick()).toEqual({ assessed: true });

    expect(prisma.auctionListing.update).toHaveBeenCalledWith({
      where: { id: 'l1' },
      data: {
        aiAssessment: 'Ролик обычный, нарушений нет.',
        brandManifestAiAudit: null,
      },
    });
  });
});

describe('учёт расхода', () => {
  it('расход пишется на пользователя, а НЕ на профиль исполнителя', async () => {
    const { service, aiUsage } = build();
    await service.runTick();

    expect(aiUsage.recordGemini).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        operation: 'auction-assessment',
        userId: 'пользователь-u1',
      }),
    );
    const [, meta] = aiUsage.recordGemini.mock.calls[0] as [
      unknown,
      { userId: string },
    ];
    expect(meta.userId).not.toBe('профиль-cp1');
  });

  it('оценка брендбука считается отдельным расходом на того же пользователя', async () => {
    const { service, aiUsage } = build(
      listingRow({ includeBrandManifest: true, brandManifest: manifest() }),
    );
    await service.runTick();

    expect(aiUsage.recordGemini).toHaveBeenCalledTimes(2);
    for (const [, meta] of aiUsage.recordGemini.mock.calls as [
      unknown,
      { userId: string },
    ][]) {
      expect(meta.userId).toBe('пользователь-u1');
    }
  });

  it('несостоявшийся вызов Gemini расходом не считается', async () => {
    const { service, aiUsage } = build();
    generateContent.mockRejectedValueOnce(new Error('503 upstream'));
    await service.runTick();

    expect(aiUsage.recordGemini).not.toHaveBeenCalled();
  });
});

describe('оценка видео', () => {
  it('недоступное видео — текст для оператора, без обращения к Gemini', async () => {
    const { service, prisma, geminiFiles } = build();
    fetchMock.mockResolvedValueOnce(videoResponse({ ok: false, status: 404 }));
    await service.runTick();

    expect(geminiFiles.uploadAndWaitActive).not.toHaveBeenCalled();
    expect(generateContent).not.toHaveBeenCalled();
    expect(
      prisma.auctionListing.update.mock.calls[0][0].data.aiAssessment,
    ).toBe('Не удалось скачать видео для оценки (HTTP 404).');
  });

  it('заявленный размер сверх потолка останавливает загрузку в Gemini', async () => {
    const { service, prisma, geminiFiles } = build();
    fetchMock.mockResolvedValueOnce(
      videoResponse({ contentLength: String(300 * 1024 * 1024) }),
    );
    await service.runTick();

    expect(geminiFiles.uploadAndWaitActive).not.toHaveBeenCalled();
    expect(
      prisma.auctionListing.update.mock.calls[0][0].data.aiAssessment,
    ).toMatch(/слишком большое/);
  });

  it('заголовку про размер не верят — фактические байты тоже проверяются', async () => {
    // Внешний хост может соврать в content-length или не прислать его.
    const { service, prisma, geminiFiles } = build();
    // Флаг вместо expect(mock).not.toHaveBeenCalled(): если проверка
    // размера сломается, jest попытается показать в диффе аргументы
    // вызова — а там буфер на 300 МБ, и прогон падает по памяти вместо
    // внятного сообщения.
    let uploadAttempted = false;
    geminiFiles.uploadAndWaitActive.mockImplementation(() => {
      uploadAttempted = true;
      throw new Error('загрузка не должна была случиться');
    });
    fetchMock.mockResolvedValueOnce(
      videoResponse({ contentLength: '10', bytes: 300 * 1024 * 1024 }),
    );
    await service.runTick();

    expect(uploadAttempted).toBe(false);
    expect(
      prisma.auctionListing.update.mock.calls[0][0].data.aiAssessment,
    ).toMatch(/слишком большое/);
  });

  it('тип содержимого берётся из ответа, а не считается mp4 вслепую', async () => {
    const { service, geminiFiles } = build();
    fetchMock.mockResolvedValueOnce(
      videoResponse({ contentType: 'video/webm' }),
    );
    await service.runTick();

    expect(geminiFiles.uploadAndWaitActive).toHaveBeenCalledWith(
      expect.any(Buffer),
      'video/webm',
    );
  });

  it('не-видео тип откатывается на безопасный дефолт', async () => {
    const { service, geminiFiles } = build();
    fetchMock.mockResolvedValueOnce(
      videoResponse({ contentType: 'application/octet-stream' }),
    );
    await service.runTick();

    expect(geminiFiles.uploadAndWaitActive).toHaveBeenCalledWith(
      expect.any(Buffer),
      'video/mp4',
    );
  });

  it('скачивание идёт с таймаутом — зависший хост не держит тик крона', async () => {
    const { service } = build();
    await service.runTick();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://cdn.test/clip.mp4');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('ролик уходит в Gemini ссылкой на загруженный файл вместе с промптом', async () => {
    const { service } = build();
    await service.runTick();

    const [args] = generateContent.mock.calls[0] as [
      { contents: Array<Record<string, unknown>> },
    ];
    expect(args.contents[0]).toEqual({
      fileData: { fileUri: 'files/abc', mimeType: 'video/mp4' },
    });
    expect(args.contents[1].text).toContain('модератор маркетплейса');
  });

  it('загруженный файл удаляется из Gemini после успешной оценки', async () => {
    const { service, geminiFiles } = build();
    await service.runTick();
    await flush();

    expect(geminiFiles.deleteFile).toHaveBeenCalledWith('files/abc');
  });

  it('файл удаляется и когда сама оценка провалилась', async () => {
    // Иначе неудачные оценки копили бы платные файлы в хранилище Gemini.
    const { service, geminiFiles } = build();
    generateContent.mockRejectedValueOnce(new Error('500 from Gemini'));
    await service.runTick();
    await flush();

    expect(geminiFiles.deleteFile).toHaveBeenCalledWith('files/abc');
  });

  it('пустой ответ модели не записывается как оценка', async () => {
    const { service, prisma } = build();
    generateContent.mockResolvedValueOnce({ text: '   ' });
    await service.runTick();

    expect(
      prisma.auctionListing.update.mock.calls[0][0].data.aiAssessment,
    ).toBe('ИИ не вернул текстовую оценку.');
  });

  it('любой сбой превращается в текст для оператора, а не в исключение', async () => {
    const { service, prisma } = build();
    fetchMock.mockRejectedValueOnce(new Error('ENOTFOUND cdn.test'));

    await expect(service.runTick()).resolves.toEqual({ assessed: true });
    expect(
      prisma.auctionListing.update.mock.calls[0][0].data.aiAssessment,
    ).toBe('Автоматическая оценка не удалась — нужна ручная проверка.');
  });
});

describe('оценка брендбука', () => {
  it('обычный лот брендбук не оценивает — лишнего платного вызова нет', async () => {
    const { service, prisma } = build();
    await service.runTick();

    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(
      prisma.auctionListing.update.mock.calls[0][0].data.brandManifestAiAudit,
    ).toBeNull();
  });

  it('флаг эксклюзива без самого брендбука тоже не даёт вызова', async () => {
    const { service } = build(
      listingRow({ includeBrandManifest: true, brandManifest: null }),
    );
    await service.runTick();

    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it('содержимое брендбука попадает в промпт целиком', async () => {
    const { service } = build(
      listingRow({ includeBrandManifest: true, brandManifest: manifest() }),
    );
    await service.runTick();

    const prompt = generateContent.mock.calls
      .map(([a]) => (a.contents[0] as { text?: string }).text ?? '')
      .find((t) => t.includes('брендбук')) as string;

    expect(prompt).toContain('Название: Кружка Steel');
    expect(prompt).toContain('Стиль: минимализм, холодные тона');
    expect(prompt).toContain('Голос/тон: спокойный женский голос');
    expect(prompt).toContain('Бариста — улыбчивая');
    expect(prompt).toContain('Кофейня'); // сцена без описания — только метка
    expect(prompt).toContain('безвозвратно'); // суть: продажа эксклюзивная
  });

  it('пустые разделы названы явно, а не пропущены молча', async () => {
    const { service } = build(
      listingRow({
        includeBrandManifest: true,
        brandManifest: manifest({
          styleNotes: null,
          voiceNotes: null,
          characters: [],
          scenes: [],
        }),
      }),
    );
    await service.runTick();

    const prompt = generateContent.mock.calls
      .map(([a]) => (a.contents[0] as { text?: string }).text ?? '')
      .find((t) => t.includes('брендбук')) as string;

    expect(prompt).toContain('Персонажи: не заданы');
    expect(prompt).toContain('Сцены: не заданы');
    expect(prompt).not.toContain('Стиль:');
    expect(prompt).not.toContain('Голос/тон:');
  });

  it('сбой аудита брендбука не отменяет уже полученную оценку видео', async () => {
    const { service, prisma } = build(
      listingRow({ includeBrandManifest: true, brandManifest: manifest() }),
    );
    // Обе оценки идут параллельно (Promise.all), и брендбук успевает к
    // Gemini раньше: оценке видео сначала нужно скачать и загрузить файл.
    // Поэтому мок разводится по содержимому промпта, а не по порядку.
    generateContent.mockImplementation(
      (args: { contents: Array<{ text?: string }> }) => {
        const isManifest = args.contents.some((c) =>
          c.text?.includes('брендбук'),
        );
        return isManifest
          ? Promise.reject(new Error('500 from Gemini'))
          : Promise.resolve({ text: 'Видео в порядке.' });
      },
    );
    await service.runTick();

    expect(prisma.auctionListing.update.mock.calls[0][0].data).toEqual({
      aiAssessment: 'Видео в порядке.',
      brandManifestAiAudit:
        'Автоматический аудит не удался — нужна ручная проверка.',
    });
  });
});
